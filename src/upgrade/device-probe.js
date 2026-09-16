import { buildF7Query, buildOtaFrame, buildN32UnifiedInfoQuery, buildProxyFrame, OTA_CMD, N32_CMD, PROXY_MODE, PROXY_STATUS, parseBootInfo, parseW515Mode, parseN32Info, parseN32UnifiedResponse, validateW515Window } from "./ota-protocol.js?v=n32info-1";
import { checkAbort } from "./ota-channel.js?v=resync-1";

export function snapshotIsFresh(snapshot, adapter, now = Date.now()) {
  return !!snapshot && snapshot.deviceId === adapter.device?.id && snapshot.generation === adapter.generation &&
    adapter.isGattConnected() && now >= snapshot.checkedAt && now - snapshot.checkedAt < 60000;
}
export function w515Gate(snapshot) {
  if (!snapshot || !["APP", "BOOT"].includes(snapshot.main.mode)) return "主控运行模式未确认";
  if (!snapshot.routeClear) return "代理通道未确认释放；禁止升级";
  try { validateW515Window(snapshot.main.info); } catch (e) { return e.message; }
  return null;
}
// Status probing never sends 0x03, 0x38, erase, write, verify or reset.
// NORMAL_PROTOCOL temporarily owns UART1. Queries can hold an already-running
// N32 Boot in Boot (main.c:1498-1502); they do not command APP -> Boot or alter Flash.
export class DeviceProbe {
  constructor(adapter, { signal, onLog = () => {}, now = () => Date.now(), sessionId } = {}) {
    this.adapter = adapter; this.signal = signal; this.log = onLog; this.now = now;
    this.sessionId = sessionId || (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] || ((Date.now() >>> 0) || 1));
  }
  async query(frame, protocol, cmd, signal = this.signal) {
    checkAbort(signal);
    // Inactive APP dispatch requires a complete 27B GLPX request in one UART burst.
    // Do NOT split it into 20+7 and assume the firmware will reassemble it.
    // A successful GATT write still needs a firmware ACK; no ACK => UNKNOWN.
    return this.adapter.requestWire(frame, { protocol, cmd, timeoutMs: 1800, signal, chunkSize: protocol === "proxy" ? frame.length : 20 });
  }
  async proxy(mode, session = this.sessionId, signal = this.signal) {
    const f = await this.query(buildProxyFrame(mode, { session, baud: 115200, idleMs: 5000, totalMs: 12000, flags: 0 }), "proxy", null, signal);
    return f.payload[4]; // GLPX + status, NO request mode echo.
  }
  async run({ alreadyExclusive = false, scope = "both" } = {}) {
    const release = alreadyExclusive ? () => {} : this.adapter.beginExclusive("probe");
    const result = { deviceId: this.adapter.device?.id, generation: this.adapter.generation, checkedAt: 0,
      main: { mode: "UNKNOWN", info: null }, slave: { mode: "UNKNOWN", reason: "尚未探测" },
      proxy: { state: "UNKNOWN" }, routeClear: false };
    let started = false;
    if (scope === "slave") {
      // 仅副板：单条 F7 目标=1（主控代理转发 N32 0x3A），不占用代理通道
      try {
        const f = await this.query(buildF7Query(1), "f7");
        const info = parseBootInfo(f.payload);
        if (info && /N32/i.test(info.model)) { result.slave = { mode: "INFO_ONLY", info }; result.proxy.state = "SKIPPED"; result.routeClear = false; }
        else result.slave.reason = "副板信息应答型号不符";
      } catch (error) { checkAbort(this.signal); result.slave.reason = `副板信息查询失败（需主控固件支持 F7 目标=1）：${error.message}`; }
      result.checkedAt = this.now(); result.generation = this.adapter.generation;
      this.log("SYS", `副板信息查询结束: ${result.slave.info ? `v${result.slave.info.sw_ver >>> 8}.${result.slave.info.sw_ver & 255} ${result.slave.info.app_size}B` : result.slave.reason}`);
      release(); return result;
    }
    try {
      this.log("SYS", "先查双板，不进 Boot、不擦写；查询可能延长已在运行的 Boot 停留时间");
      try {
        const f = await this.query(buildF7Query(), "f7");
        result.main.info = parseBootInfo(f.payload); result.main.infoSource = "F7";
      } catch (error) { checkAbort(this.signal); result.main.infoError = error.message; }
      try {
        const f = await this.query(buildOtaFrame(OTA_CMD.HANDSHAKE, [0x12, 0x34, 0x56, 0x78]), "w515", 0x81);
        result.main.mode = parseW515Mode(f.payload);
        if (result.main.mode !== "UNKNOWN") {
          const infoFrame = await this.query(buildOtaFrame(OTA_CMD.GET_INFO), "w515", 0x82);
          const info = parseBootInfo(infoFrame.payload);
          if (info && result.main.info && (info.device_id !== result.main.info.device_id || info.app_start !== result.main.info.app_start || info.app_max_size !== result.main.info.app_max_size)) {
            result.main.mode = "UNKNOWN"; result.main.reason = "F7 与 GET_INFO 身份/布局矛盾";
          } else if (info) { result.main.info = info; result.main.infoSource = "GET_INFO"; }
        }
      } catch (error) { checkAbort(this.signal); result.main.reason = error.message; }
      if (result.main.mode === "BOOT") {
        // Current Project.uvprojx has bootloader/protocol/boot_comm, not upgrade_proxy.
        result.slave = { mode: "UNREACHABLE", reason: "当前主控 Boot 无 N32 代理；先恢复主控 APP，再重新探测副板" };
        result.proxy.state = "NOT_AVAILABLE_IN_BOOT"; result.routeClear = true;
        return result;
      }
      if (result.main.mode !== "APP") {
        result.slave.reason = "主控模式未知，无法确认副板通路"; return result;
      }
      // 副板信息：F7 目标=1 经主控代理转发（新固件；不占代理通道）；超时=旧固件不支持，降级走 0x31
      try {
        const sf = await this.query(buildF7Query(1), "f7");
        const sinfo = parseBootInfo(sf.payload);
        if (sinfo && /N32/i.test(sinfo.model)) result.slave.info = sinfo;
      } catch (error) { checkAbort(this.signal); this.log("SYS", "副板 F7 信息查询无响应（主控或副板固件其一较旧）；降级用 0x31 握手探测"); }
      if (scope === "main") { // 仅主控：到此为止，不碰代理
        result.slave.reason = "仅检测主控（未探测副板）"; result.proxy.state = "SKIPPED";
        result.routeClear = true; return result;
      }
      const before = await this.proxy(PROXY_MODE.STATUS, 0);
      if (before !== PROXY_STATUS.INACTIVE) {
        result.proxy.state = before === PROXY_STATUS.OK ? "BUSY" : "UNKNOWN";
        result.slave.reason = "代理被占用或状态不明；不抢占现有会话"; return result;
      }
      result.proxy.state = "INACTIVE";
      // From here a lost START ACK means ownership is ambiguous until queried.
      started = true;
      const status = await this.proxy(PROXY_MODE.START);
      if (status !== PROXY_STATUS.OK) {
        result.slave.reason = `代理启动被拒绝: ${status}`; return result;
      }
      result.proxy.state = "OWNED_NORMAL";
      const response = await this.query(buildOtaFrame(N32_CMD.HANDSHAKE, [0x4E, 0x33, 0x32, 0x42]), "n32", 0xB1);
      const slave = parseN32Info(response.payload);
      // v1.7+ 副板统一信息：同一代理隧道直接问 0x3A "INFO"（不依赖主控 F7 target=1 转发）。
      // 48B BootInfo 布局 → Boot/大小/CRC 字段；旧固件回 BAD_CMD 或超时 → 保留握手信息。
      if (slave.mode === "APP") {
        try {
          const uf = await this.query(buildN32UnifiedInfoQuery(), "n32", 0xBA);
          const uni = parseN32UnifiedResponse(uf.payload);
          if (uni?.ok && uni.info && /N32/i.test(uni.info.model)) slave.info = uni.info;
          else this.log("SYS", `副板统一信息不可用（status=${uni ? uni.status : "?"}）：副板固件较旧，无 0x3A`);
        } catch (error) { checkAbort(this.signal); this.log("SYS", "副板统一信息查询超时（副板固件较旧，无 0x3A）；仅显示握手信息"); }
      }
      if (result.slave.info) slave.info = result.slave.info; // F7 代理信息（版本/CRC/大小）叠加
      result.slave = slave;
      if (result.slave.mode === "UNKNOWN") result.slave.reason = "副板应答格式/状态未确认";
      return result;
    } catch (error) {
      checkAbort(this.signal);
      result.slave.reason = error.message + "；无响应不等于没程序";
      return result;
    } finally {
      if (started && this.adapter.isGattConnected()) {
        try {
          // Even cancellation must release ONLY our own session; never wildcard STOP.
          const status = await this.proxy(PROXY_MODE.STATUS, this.sessionId, null);
          if (status === PROXY_STATUS.INACTIVE) result.routeClear = true;
          else if (status === PROXY_STATUS.OK) {
            const stop = await this.proxy(PROXY_MODE.STOP, this.sessionId, null);
            if (stop === PROXY_STATUS.OK || stop === PROXY_STATUS.INACTIVE) result.routeClear = (await this.proxy(PROXY_MODE.STATUS, this.sessionId, null)) === PROXY_STATUS.INACTIVE;
          }
          result.proxy.state = result.routeClear ? "RELEASED" : "CLEANUP_UNCONFIRMED";
        } catch (error) { result.proxy.state = "CLEANUP_UNCONFIRMED"; result.proxy.reason = error.message; }
      }
      result.checkedAt = this.now(); result.generation = this.adapter.generation;
      this.log("SYS", `状态检测结束: W515=${result.main.mode}; N32=${result.slave.mode}; proxy=${result.proxy.state}`);
      release();
    }
  }
}
