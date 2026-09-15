// N32 副板升级会话：GLPX 代理(NORMAL) → 0x31/0x38 进Boot → 0x33 擦除 → 0x34 顺序ACK写 → 0x35 CRC32校验 → 0x37 进APP。
// 协议依据 docs/OTA_FLOW_INTERACTIONS.md §5（源码提取）：NB=MCU_Slave_Boot_N32/src/main.c，PX=upgrade_proxy.c。
// 关键约束：N32 帧经代理必须单次 GATT 整帧写（RT 分发要求完整帧）；0x34 addr 必须等于 APP_BASE+written；
// 数据长度 4 字节对齐（末包 0xFF 填充）；擦除只覆盖 APP 区 0x08002000+，N32 Boot 永不擦除。
import { N32_CMD, PROXY_MODE, PROXY_STATUS, buildOtaFrame, buildProxyFrame, crc32, parseN32Info } from "./ota-protocol.js?v=status-first-1";
import { DeviceProbe } from "./device-probe.js?v=status-first-1";
import { checkAbort, delay } from "./ota-channel.js?v=fast-path-1";

const N32_APP_BASE = 0x08002000;
const N32_APP_END = 0x0800F7FF;          // NB:23-24
const N32_PAGE = 2048;                    // NB 页大小
const N32_MAGIC_BOOT = [0x4E, 0x33, 0x32, 0x42]; // "N32B"
const N32_MAGIC_APP = [0x4E, 0x33, 0x32, 0x41];  // "N32A"
const CHUNK = 180;                        // 帧 192B < 244 GATT 单帧上限；对齐 unified-tool 224B 上限留余量
const DEFAULT_TUNING = Object.freeze({ chunk: CHUNK, window: 16, gapMs: 25 });

export const N32_LAYOUT = Object.freeze({ appBase: N32_APP_BASE, appEnd: N32_APP_END, page: N32_PAGE });

export function n32Gate(snapshot) {
  if (!snapshot) return "请先检测双板状态";
  if (snapshot.main.mode !== "APP") return "副板升级要求主控在 APP（Boot 无代理）";
  if (!snapshot.routeClear) return "代理通道未确认释放；禁止升级";
  if (!["APP", "BOOT"].includes(snapshot.slave.mode)) return "副板模式未确认（无响应不等于没程序）";
  return null;
}
export class N32OtaSession {
  constructor(adapter, hooks = {}) {
    this.adapter = adapter; this.hooks = hooks; this.controller = new AbortController();
    this.pause = hooks.delay || delay; this.now = hooks.now || (() => Date.now());
    this.sessionId = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) || 1);
    this.mutatingStarted = false; this.proxyActive = false; this.rawActive = false;
  }
  abort() { this.controller.abort(); }
  log(type, text) { this.hooks.onLog?.(type, text); }
  stage(id, label) { this.hooks.onStage?.(id, label); }
  // N32 帧经代理转发：必须整帧单次 GATT 写（chunkSize=frame.length），代理转发要求完整帧
  async send(cmd, payload = [], timeoutMs = 4000) {
    checkAbort(this.controller.signal);
    const frame = buildOtaFrame(cmd, payload);
    return this.adapter.requestWire(frame, { protocol: "n32", cmd: cmd | 0x80, timeoutMs, signal: this.controller.signal, chunkSize: frame.length });
  }
  // 流式发送：flag=0 时 Boot 静默写入不回帧；只发不等（noWait 跳过回包匹配）
  async sendOnly(cmd, payload = []) {
    checkAbort(this.controller.signal);
    const frame = buildOtaFrame(cmd, payload);
    return this.adapter.requestWire(frame, { protocol: "n32", cmd: null, timeoutMs: 10, signal: this.controller.signal, chunkSize: frame.length, noWait: true });
  }
  // 0x39 状态：status@0, written be32@1, last_write_addr be32@5
  async status() {
    const f = await this.send(N32_CMD.STATUS, [], 3000);
    if (f.payload.length < 5) throw new Error("N32 状态回包过短");
    const dv = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength);
    return { status: f.payload[0], written: dv.getUint32(1, false), lastAddr: dv.getUint32(5, false) };
  }
  async ack(cmd, payload, timeoutMs) {
    const f = await this.send(cmd, payload, timeoutMs);
    if (f.payload.length < 1 || f.payload[0] !== 0) throw new Error(`N32 0x${cmd.toString(16)} 应答异常：${Array.from(f.payload.slice(0, 4)).join(",")}`);
    return f;
  }
  async proxy(mode, timeoutMs = 1800, opts = {}) {
    checkAbort(this.controller.signal);
    const frame = buildProxyFrame(mode, { session: this.sessionId, baud: 115200, idleMs: opts.idleMs ?? 5000, totalMs: opts.totalMs ?? 0, flags: opts.flags ?? 0 });
    const f = await this.adapter.requestWire(frame, { protocol: "proxy", cmd: null, timeoutMs, signal: this.controller.signal, chunkSize: frame.length });
    return f.payload[4];
  }
  async handshake() {
    const f = await this.send(N32_CMD.HANDSHAKE, N32_MAGIC_BOOT);
    return parseN32Info(f.payload);
  }
  async waitSlaveMode(expected, tries = 8) {
    for (let i = 0; i < tries; i++) {
      checkAbort(this.controller.signal);
      try { const s = await this.handshake(); if (s.mode === expected) return s; }
      catch (error) { checkAbort(this.controller.signal); this.log("WARN", `等待副板 ${expected} ${i + 1}/${tries}：${error.message}`); }
      await this.pause(500, this.controller.signal);
    }
    throw new Error(`副板未确认进入 ${expected}；停止，不盲目擦写`);
  }
  // RAW 流式写入：从 startFrom 续写（Boot 顺序计数器为权威），窗口 0x39 核对 + 丢包断点 ACK 补写
  async streamWrite(image, size, t, startFrom) {
    this.stage("write", `0x34 RAW 流式写入（${t.chunk}B/包${startFrom ? `，从 ${startFrom}B 续写` : ""}）`);
    // 主控 APP_BLE_RX_DISPATCH_IN_MAIN=1：BLE 字节先进 768B buffer 由主循环转发 UART1（帧×87µs），
    // 溢出即静默丢；包间隔须 ≥ 主循环排空时间，否则丢流式包。
    const started = this.now(), total = Math.ceil(size / t.chunk);
    let index = Math.floor(startFrom / t.chunk);
    for (let offset = startFrom; offset < size; offset += t.chunk, index++) {
      checkAbort(this.controller.signal);
      const part = image.bytes.slice(offset, Math.min(size, offset + t.chunk));
      const pad = (4 - (part.length % 4)) % 4;
      const data = pad ? Uint8Array.from([...part, ...new Array(pad).fill(0xFF)]) : part;
      // 流式包：flag=0 静默写入（无前导 0x01），整帧单次 GATT 写
      await this.sendOnly(N32_CMD.WRITE, [...u32be(N32_APP_BASE + offset), ...data]);
      const written = offset + part.length;
      const atWindowEnd = (index + 1) % t.window === 0 || written === size;
      if (atWindowEnd) {
        // 窗口核对：0x39 立即回包（Boot 只读计数器，不等 flash），确认流式包已顺序落盘
        const st = await this.status();
        if (st.written !== written) {
          this.log("WARN", `窗口计数不一致（流式丢包）：Boot ${st.written}B / 已发 ${written}B，断点 ACK 补写`);
          if (st.status !== 0 || st.written % 4 !== 0 || st.written > written) throw new Error(`无法断点恢复: 状态${st.status} written=${st.written}`);
          for (let ro = st.written; ro <= offset; ro += t.chunk) {
            checkAbort(this.controller.signal);
            const rpart = image.bytes.slice(ro, Math.min(size, ro + t.chunk));
            const rpad = (4 - (rpart.length % 4)) % 4;
            const rdata = rpad ? Uint8Array.from([...rpart, ...new Array(rpad).fill(0xFF)]) : rpart;
            const f = await this.send(N32_CMD.WRITE, [0x01, ...u32be(N32_APP_BASE + ro), ...rdata], 5000);
            if (f.payload[0] !== 0) throw new Error(`断点补写 ACK 异常: ${f.payload[0]} @0x${(N32_APP_BASE + ro).toString(16)}`);
          }
          this.log("SYS", `断点补写完成，继续流式`);
        }
      }
      this.hooks.onProgress?.({ percent: written / size * 100, written, size, packets: index + 1, totalPackets: total, speed: written / Math.max(0.001, (this.now() - started) / 1000), mode: `RAW流式${t.chunk}B / 0x39核对×${t.window}` });
      await this.pause(t.gapMs, this.controller.signal);
    }
  }
  // 链路中断恢复：等 RAW 空闲自恢复 → 必要时 BLE 重连 → NORMAL 代理查 0x39 真实进度 → 重开 RAW
  async recoverForResume() {
    this.rawActive = false; this.proxyActive = false;
    this.stage("write", "链路中断，断点恢复中…");
    this.log("SYS", "等待主控 RAW 空闲自动恢复（约 2.4s）…");
    await this.pause(2400, this.controller.signal);
    if (!this.adapter.isGattConnected()) {
      this.log("SYS", "BLE 已断开，尝试重连…");
      await this.adapter.reconnect();
    }
    this.sessionId = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) + 7);
    const st = await this.proxy(PROXY_MODE.START);
    if (st !== PROXY_STATUS.OK) throw new Error(`恢复阶段重开代理失败: ${st}`);
    this.proxyActive = true;
    await this.waitSlaveMode("BOOT"); // BKP10R="N32B"：N32 永久停留 Boot，链路断开不影响
    const prog = await this.status(); // 0x39：Boot 真实写入进度（RAM 计数器，断链不丢）
    const stopSt = await this.proxy(PROXY_MODE.STOP);
    this.proxyActive = false;
    this.sessionId = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) + 8);
    const rawSt = await this.proxy(PROXY_MODE.START, 1800, { flags: 2, idleMs: 2000, totalMs: 300000 });
    if (rawSt !== PROXY_STATUS.OK) throw new Error(`恢复阶段重开 RAW 失败: ${rawSt}`);
    this.rawActive = true;
    this.log("SYS", `RAW 已重开（NORMAL STOP=${stopSt}），Boot 进度 ${prog.written}B`);
    return prog;
  }
  async run(image, { confirmed = false, expectedDeviceId, tuning } = {}) {
    if (!confirmed) throw new Error("需要明确确认后才允许升级副板");
    if (image.target !== "n32-app" || image.base !== N32_APP_BASE) throw new Error("镜像不是 N32 APP（基址须 0x08002000）");
    const t = { ...DEFAULT_TUNING, ...(tuning || {}) };
    if (!(t.chunk >= 40 && t.chunk <= 224 && t.chunk % 4 === 0)) throw new Error(`N32 数据块须为 40-224 且 4 对齐（当前 ${t.chunk}）`);
    if (!(t.window >= 1 && t.window <= 64)) throw new Error(`N32 窗口须为 1-64（当前 ${t.window}）`);
    if (!(t.gapMs >= 0 && t.gapMs <= 200)) throw new Error(`N32 包间隔须为 0-200ms（当前 ${t.gapMs}）`);
    const size = image.bytes.length, eraseSize = Math.ceil(size / N32_PAGE) * N32_PAGE;
    if (eraseSize > N32_APP_END - N32_APP_BASE + 1) throw new Error("固件或擦除区超过 N32 APP 窗口");
    const crc = crc32(image.bytes);
    const release = this.adapter.beginExclusive("n32-upgrade");
    try {
      this.stage("probe", "重新检测双板状态");
      const snapshot = await new DeviceProbe(this.adapter, { signal: this.controller.signal, onLog: (t, m) => this.log(t, m) }).run({ alreadyExclusive: true });
      this.hooks.onSnapshot?.(snapshot);
      const gate = n32Gate(snapshot);
      if (gate) throw new Error(gate);
      if (expectedDeviceId && snapshot.deviceId !== expectedDeviceId) throw new Error("设备已更换，请重新检测并确认");
      // NORMAL 代理仅用于探测/进 Boot（小帧）；擦写走 RAW 透传（对齐 unified-tool：NORMAL 逐帧解析扛不住大包流式）
      this.stage("proxy", "启动 GLPX 代理（NORMAL·探测）");
      const st = await this.proxy(PROXY_MODE.START);
      if (st !== PROXY_STATUS.OK) throw new Error(`代理启动被拒绝: ${st}`);
      this.proxyActive = true;
      let slave = await this.waitSlaveMode(snapshot.slave.mode === "BOOT" ? "BOOT" : "APP");
      if (slave.mode === "APP") {
        this.stage("enterboot", "0x38 命令副板进入 Boot");
        this.mutatingStarted = true;
        const f = await this.send(N32_CMD.ENTER_BOOT, N32_MAGIC_APP, 3000);
        if (f.payload[0] !== 0) throw new Error(`0x38 应答异常: ${f.payload[0]}`);
        // 副板回显后复位进 Boot；BKP10R="N32B" 永久停留（NB:468-472），无需抢 5 秒窗口
        slave = await this.waitSlaveMode("BOOT");
      }
      if (slave.appValid) this.log("SYS", `副板 Boot 上报 APP 有效（升级将覆盖）`);
      // 切 RAW 透传：STOP NORMAL → START flags=02（idle=2000 对齐 PC；写包间隔须<2s）
      const stopSt = await this.proxy(PROXY_MODE.STOP);
      this.proxyActive = false;
      this.stage("proxy", `启动 GLPX RAW 透传（NORMAL STOP=${stopSt}）`);
      this.sessionId = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) + 1);
      const rawSt = await this.proxy(PROXY_MODE.START, 1800, { flags: 2, idleMs: 2000, totalMs: 300000 });
      if (rawSt !== PROXY_STATUS.OK) throw new Error(`RAW 代理启动被拒绝: ${rawSt}`);
      this.rawActive = true;
      this.mutatingStarted = true;
      // —— 擦写主流程（可断点恢复）：链路闪断/丢包时重连续传，最多 3 次（对齐 PC _recover_raw_proxy_for_fallback）——
      let resumeWritten = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          if (resumeWritten === 0) {
            this.stage("erase", `0x33 擦除 APP ${eraseSize}B（页${N32_PAGE}）`);
            await this.ack(N32_CMD.ERASE, [...N32_MAGIC_BOOT, ...u32be(N32_APP_BASE), ...u32be(eraseSize), 0x08, 0x00], 30000);
          } else this.log("SYS", `从 ${resumeWritten}B 断点续写（已擦除，跳过擦除）`);
          await this.streamWrite(image, size, t, resumeWritten);
          // 校验
          this.stage("verify", "0x35 CRC32 校验");
          let vf = await this.send(N32_CMD.VERIFY, [...N32_MAGIC_BOOT, ...u32be(N32_APP_BASE), ...u32be(size), ...u32be(crc)], 8000);
          if (vf.payload[0] !== 0) {
            // 流式丢包兜底：查 Boot 真实进度，ACK 补写剩余后重校验（对齐 unified-tool :5866-5890）
            this.log("WARN", `校验失败(状态${vf.payload[0]})，查询 Boot 进度尝试断点补写`);
            const st = await this.status();
            if (st.status === 0 && st.written % 4 === 0 && st.written < size) {
              this.log("SYS", `Boot 已写 ${st.written}/${size}B，从 0x${(N32_APP_BASE + st.written).toString(16)} ACK 补写剩余部分`);
              for (let offset = st.written; offset < size; offset += t.chunk) {
                checkAbort(this.controller.signal);
                const part = image.bytes.slice(offset, Math.min(size, offset + t.chunk));
                const pad = (4 - (part.length % 4)) % 4;
                const data = pad ? Uint8Array.from([...part, ...new Array(pad).fill(0xFF)]) : part;
                const f = await this.send(N32_CMD.WRITE, [0x01, ...u32be(N32_APP_BASE + offset), ...data], 5000);
                if (f.payload[0] !== 0) throw new Error(`补写 ACK 异常: ${f.payload[0]} @0x${(N32_APP_BASE + offset).toString(16)}`);
              }
              vf = await this.send(N32_CMD.VERIFY, [...N32_MAGIC_BOOT, ...u32be(N32_APP_BASE), ...u32be(size), ...u32be(crc)], 30000);
              if (vf.payload[0] === 0) this.log("SYS", "断点补写后校验通过");
            }
            if (vf.payload[0] !== 0) throw new Error(`副板校验失败: 状态${vf.payload[0]}（06=CRC不符）`);
          }
          const dv = new DataView(vf.payload.buffer, vf.payload.byteOffset, vf.payload.byteLength);
          if (vf.payload.length >= 17) {
            const vAddr = dv.getUint32(1, false), vSize = dv.getUint32(5, false), expected = dv.getUint32(9, false), actual = dv.getUint32(13, false);
            if (vAddr !== N32_APP_BASE || vSize !== size || expected !== crc || actual !== crc) throw new Error(`校验诊断不一致：addr=${hex(vAddr)} size=${vSize} 期望=${hex(expected)} 实算=${hex(actual)}；不进APP`);
          } else this.log("WARN", "0x35 应答短于17B，仅确认状态码");
          break; // 擦写+校验全部成功
        } catch (error) {
          checkAbort(this.controller.signal);
          if (attempt >= 3) throw error;
          this.log("WARN", `第${attempt}次中断：${error.message}；开始断点恢复（重连/重开代理/查进度）`);
          const prog = await this.recoverForResume();
          if (prog.status !== 0 || prog.written % 4 !== 0 || prog.written > size) throw new Error(`恢复失败：Boot 状态${prog.status} written=${prog.written}`);
          resumeWritten = prog.written;
          this.log("SYS", `断点恢复就绪，从 ${resumeWritten}/${size}B 续写`);
        }
      }
      this.stage("enterapp", "0x37 命令副板进入 APP");
      await this.ack(N32_CMD.ENTER_APP, [], 3000);
      // RAW 已无后续流量：等 idle 自动恢复 → 重开 NORMAL 代理确认副板 APP（对齐 PC 升级后流程）
      this.rawActive = false;
      this.log("SYS", "等待主控 RAW 空闲自动恢复（约 2.4s）…");
      await this.pause(2400, this.controller.signal);
      this.sessionId = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) + 3);
      const reSt = await this.proxy(PROXY_MODE.START);
      if (reSt !== PROXY_STATUS.OK) throw new Error(`确认阶段重开代理失败: ${reSt}`);
      this.proxyActive = true;
      await this.waitSlaveMode("APP");
      this.stage("done", "副板 APP 已确认");
      return { success: true, slaveConfirmed: true, verify: { size, crc } };
    } catch (error) {
      this.log("WARN", this.mutatingStarted ? "操作已停止；N32 Boot 不受影响，可重新检测后再试完整升级。" : "前置检查未通过，未擦写副板。");
      throw error;
    } finally {
      if (this.rawActive) {
        // RAW 透传下 GLPX STOP 会被透传给 N32 成垃圾帧：不发，靠 idle(2s) 自动恢复正常协议
        this.rawActive = false;
        this.log("SYS", "RAW 代理已交还：主控将在约 2 秒空闲后自动恢复正常协议；期间请勿操作");
      } else if (this.proxyActive && this.adapter.isGattConnected()) {
        try {
          const stop = await this.proxy(PROXY_MODE.STOP);
          const after = await this.proxy(PROXY_MODE.STATUS);
          this.log("SYS", `代理清理：STOP=${stop}，STATUS=${after}（05=已释放）`);
        } catch (error) { this.log("WARN", `代理释放未确认：${error.message}；超时后固件会自行退出`); }
      }
      release();
    }
  }
}
function u32be(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function hex(v) { return "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0"); }
