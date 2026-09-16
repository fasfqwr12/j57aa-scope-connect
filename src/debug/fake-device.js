// 固件仿真器（管理员闭环测试专用，不进正常用户路径）。
// 严格按源码提取协议仿真：W515 APP/Boot 状态机、GLPX 代理会话、N32 APP/Boot 顺序锁。
// 帧/状态码/CRC 行为依据 docs/OTA_PROTOCOL_SPEC.md；仿真目的=闭环验证网页全链路，不替代真机。
import { WireChannel, checkAbort } from "../upgrade/ota-channel.js?v=resync-1";
import { buildOtaFrame, buildProxyFrame, crc16Modbus, crc32, crc32MetaCompatible } from "../upgrade/ota-protocol.js?v=status-first-1";

const W515 = {
  APP_BASE: 0x08008000, APP_MAX: 0x001F8000, FLASH_END: 0x08200000, PAGE: 4096,
  MAGIC_REQ: 0x12345678, MAGIC_APP: 0xAA55AA55, MAGIC_BOOT: 0x87654321,
  DEVICE_ID: 0x1A2B3C4D, HW: 0x0100, BOOT_VER: 0x0100, MODEL: "J57AA-W515",
  ERR: { NONE: 0, UNKNOWN: 1, LEN: 2, FLASH: 3, VERIFY: 6, DENIED: 6 }
};
const N32 = {
  APP_BASE: 0x08002000, APP_END: 0x0800F7FF, PAGE: 2048,
  MAGIC: "N32B", MAGIC_APP: "N32A", BOOT_VER: 1
};
const PROXY_ST = { OK: 0, BAD: 1, BUSY: 3, SESS: 4, INACT: 5, UNSUP: 7 };
const ascii = s => Array.from(s, c => c.charCodeAt(0));
const be32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const u32be = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = v => [v & 255, (v >> 8) & 255];
const be16 = v => [(v >> 8) & 255, v & 255]; // W515/N32 帧 LEN 为大端（与 buildOtaFrame 一致）

class VirtualW515 {
  constructor() { this.reset(); }
  reset() {
    this.mode = "APP"; this.state = 0x00; this.written = 0; this.verify = null;
    this.flash = new Uint8Array(W515.FLASH_END - W515.APP_BASE).fill(0xFF);
    this.appInfo = { size: 0, crc: 0, sw: 0x0100 };
  }
  info48() {
    const b = new Uint8Array(48);
    const dv = new DataView(b.buffer);
    // Boot/升级后：APP 身份来自 Flash 内 FIRM 元数据（真实 Boot 读 Flash meta）
    const meta = this.readMeta();
    const size = meta ? meta.size : (this.mode === "APP" ? this.appInfo.size : 0);
    const crc = meta ? meta.crc : (this.mode === "APP" ? this.appInfo.crc : 0);
    const sw = meta ? meta.version : (this.mode === "APP" ? this.appInfo.sw : 0);
    dv.setUint32(0, W515.DEVICE_ID, true);
    dv.setUint16(4, W515.HW, true);
    dv.setUint16(6, this.mode === "APP" ? (sw >>> 16) : 0, true);
    dv.setUint16(8, W515.BOOT_VER, true);
    b.set(ascii(W515.MODEL), 12);
    dv.setUint32(28, 0x00200000, true);   // flash 2MB
    dv.setUint32(32, W515.APP_BASE, true);
    dv.setUint32(36, W515.APP_MAX, true);
    dv.setUint32(40, size, true);
    dv.setUint32(44, crc, true);
    return b;
  }
  handle(cmd, payload) { // 返回响应 payload 或 null(静默)
    if (cmd === 0x01) return u32be(this.mode === "APP" ? W515.MAGIC_APP : W515.MAGIC_BOOT);
    if (cmd === 0x02) return this.info48();
    if (this.mode !== "BOOT") { // WA:160-176：APP 仅 0x01/0x02/0x03 有应答
      if (cmd === 0x03) { // ACK 后直跳 Boot（upgrade_port_enter_bootloader 保电直跳）
        this.mode = "BOOT"; this.state = 0x00; return [W515.ERR.NONE];
      }
      if (cmd >= 0x04 && cmd <= 0x09) return null; // WA:173-176 静默
      return [W515.ERR.UNKNOWN];
    }
    switch (cmd) {
      case 0x03: this.state = 0x10; return [W515.ERR.NONE];
      case 0x04: {
        if (payload.length < 8) return [W515.ERR.LEN];
        const addr = be32(payload, 0), size = be32(payload, 4);
        if (addr !== W515.APP_BASE || size === 0 || size > W515.APP_MAX || size % W515.PAGE) return [W515.ERR.LEN];
        this.flash.fill(0xFF, 0, size); this.written = 0; this.state = 0x11;
        return [W515.ERR.NONE];
      }
      case 0x05: {
        // 双形态（SPEC §1.6）：[flag:1][addr:4][data] 带ACK / [addr:4][data] 流式静默
        if (payload.length < 4) return [W515.ERR.LEN];
        let flag = 0, addr, data;
        if (payload.length >= 5 && be32(payload, 1) === W515.APP_BASE + this.written) { flag = payload[0]; addr = be32(payload, 1); data = payload.slice(5); }
        else if (be32(payload, 0) === W515.APP_BASE + this.written) { addr = be32(payload, 0); data = payload.slice(4); }
        else return [W515.ERR.LEN]; // 乱序/地址错
        if (data.length % 4) return [W515.ERR.LEN];
        this.flash.set(data, this.written); this.written += data.length; this.state = 0x12;
        return flag & 1 ? [W515.ERR.NONE] : null; // 流式(flag=0)静默（WB 双形态）
      }
      case 0x06: {
        if (payload.length < 12) return [W515.ERR.LEN];
        const addr = be32(payload, 0), size = be32(payload, 4), crc = be32(payload, 8);
        if (addr !== W515.APP_BASE || size !== this.written) { this.state = 0xF0; return [W515.ERR.LEN]; }
        // Boot 以"meta 区 0x220-0x227 视为 0xFF"口径计算 CRC（与 crc32MetaCompatible 一致）
        const calc = crc32MetaCompatible(this.flash.slice(0, size));
        this.state = calc === crc ? 0x20 : 0xF0;
        this.verify = { result: calc === crc ? 1 : 2, addr, size, expected: crc, calculated: calc, count: 1, crc };
        return [W515.ERR.NONE];
      }
      case 0x07: {
        if (this.state !== 0x20) return [W515.ERR.DENIED];
        // 复位进 APP：flash 前段即为新 APP（含 meta），APP 读取自身 meta
        const meta = this.readMeta();
        if (meta) this.appInfo = meta;
        else this.appInfo = { size: this.written, crc: this.verify?.crc || 0, sw: this.appInfo.sw };
        this.mode = "APP"; this.state = 0x00;
        return [W515.ERR.NONE];
      }
      case 0x09: {
        const v = this.verify || { result: 0, addr: 0, size: 0, expected: 0, calculated: 0, count: 0, crc: 0 };
        const b = new Uint8Array(49);
        b[0] = this.state;
        b.set(u32be(this.written), 1);
        b.set(u32be(0), 5); // ore
        b[9] = v.result;
        b.set(u32be(v.count), 13);
        b.set(u32be(v.addr), 17);
        b.set(u32be(v.size), 21);
        b.set(u32be(v.expected), 25);
        b.set(u32be(v.calculated), 29);
        b.set(ascii("FIRM"), 33);
        b.set(u32be(this.appInfo.size || v.size), 37);
        b.set(u32be(this.verify ? this.verify.crc : 0), 41);
        b.set(u32be(500), 45); // elapsed
        return b;
      }
      default: return [W515.ERR.UNKNOWN];
    }
  }
  readMeta() {
    const dv = new DataView(this.flash.buffer);
    if (dv.getUint32(0x200, true) !== 0x4649524D) return null;
    return { version: dv.getUint32(0x204, true), size: dv.getUint32(0x220, true), crc: dv.getUint32(0x224, true), sw: dv.getUint32(0x204, true) >>> 16 };
  }
  f7Response() {
    const info = this.info48();
    const frame = [0xAA, 0xFE, 0xF7, 48, ...info];
    let x = 0; for (let k = 2; k < 52; k++) x ^= frame[k];
    frame.push(x, 0xBB, 0xFF);
    return frame;
  }
}

class VirtualN32 {
  constructor() { this.reset(); }
  reset() { this.mode = "APP"; this.flash = new Uint8Array(N32.APP_END - N32.APP_BASE + 1).fill(0xFF); this.written = 0; this.stayBoot = true;
    // 模拟固件行为：APP 版本/size/CRC 读 flash meta 块（偏移 0x200，"N3MT"）；Boot 版本嵌入块 0x0102
    this.infoBoot = 0x0102; }
  // meta 块 @ APP+0x200（与固件 g_n32_app_meta 对齐；升级时由镜像自带）
  readMeta() {
    const dv = new DataView(this.flash.buffer);
    if (dv.getUint32(0x200, true) !== 0x4E334D54) return null;  // "N3MT"
    const size = dv.getUint32(0x200 + 8, true), crc = dv.getUint32(0x200 + 12, true);
    if (size === 0xFFFFFFFF || crc === 0xFFFFFFFF) return { sw: dv.getUint16(0x200 + 4, true), size: 0, crc: 0 };
    return { sw: dv.getUint16(0x200 + 4, true), size, crc };
  }
  infoSw() { return this.readMeta()?.sw ?? 0x0001; }
  appValid() {
    const dv = new DataView(this.flash.buffer);
    const sp = dv.getUint32(0, true), pc = dv.getUint32(4, true);
    return sp > 0x20000000 && sp <= 0x20008000 && (pc & 1) === 1 && pc >= N32.APP_BASE && pc <= N32.APP_END;
  }
  info32() { // APP 握手应答 data32
    const dv = new DataView(this.flash.buffer);
    const b = new Uint8Array(32);
    b.set(ascii(N32.MAGIC_APP), 0);
    b.set([0x00, 0x01], 4); // version BE16
    b.set(u32be(N32.APP_BASE), 8);
    b[16] = 2; // runtime stage
    b.set(u32be(0), 20); b.set([0x00, 0x0A], 30);
    return b;
  }
  info16() { // Boot 握手应答 data16
    const b = new Uint8Array(16);
    b.set(ascii(N32.MAGIC), 0);
    b[4] = N32.BOOT_VER;
    b.set(u32be(N32.APP_BASE), 5);
    b.set(u32be(N32.APP_END), 9);
    b.set([0x08, 0x00], 13); // page BE16
    b[15] = this.appValid() ? 1 : 0;
    return b;
  }
  handle(cmd, payload) { // 返回 {status, data?}
    if (this.mode === "APP") {
      if (cmd === 0x31) return { status: 0, data: this.info32() };
      if (cmd === 0x38) { // 进 Boot：回显后复位，BKP10R=magic 永久停留
        const echo = payload.slice(0, 4);
        this.mode = "BOOT"; this.written = 0;
        return { status: 0, data: echo };
      }
      return { status: 0x01 }; // NA:194-237 APP 无升级命令
    }
    switch (cmd) { // Boot 模式
      case 0x31: return { status: 0, data: this.info16() };
      case 0x32: return { status: 0, data: this.info16() };
      case 0x33: {
        const magic = String.fromCharCode(...payload.slice(0, 4));
        if (magic !== N32.MAGIC || payload.length < 14) return { status: 0x02 };
        const addr = be32(payload, 4), size = be32(payload, 8), page = (payload[12] << 8) | payload[13];
        if (addr !== N32.APP_BASE || page !== N32.PAGE || size === 0 || size % N32.PAGE || addr + size - 1 > N32.APP_END) return { status: 0x03 };
        this.flash.fill(0xFF, 0, size); this.written = 0;
        return { status: 0 };
      }
      case 0x34: {
        // 双形态：[flag:1][addr:4][data] 带ACK / [addr:4][data] 流式静默（NB:1238-1305）
        if (payload.length < 4) return { status: 0x02 };
        let flag = 0, addr, data;
        if (payload.length >= 5 && be32(payload, 1) === N32.APP_BASE + this.written) { flag = payload[0]; addr = be32(payload, 1); data = payload.slice(5); }
        else if (be32(payload, 0) === N32.APP_BASE + this.written) { addr = be32(payload, 0); data = payload.slice(4); }
        else return { status: 0x03 }; // 乱序地址
        if (data.length % 4) return { status: 0x02 };
        this.flash.set(data, this.written); this.written += data.length;
        return { status: flag & 1 ? 0 : null }; // 无 ACK 位成功不回帧（NB:1303-1305）
      }
      case 0x35: {
        const magic = String.fromCharCode(...payload.slice(0, 4));
        if (magic !== N32.MAGIC || payload.length < 16) return { status: 0x02 };
        const addr = be32(payload, 4), size = be32(payload, 8), crc = be32(payload, 12);
        if (addr !== N32.APP_BASE || size > this.written) return { status: 0x03 };
        const calc = crc32(this.flash.slice(0, size));
        return { status: calc === crc ? 0 : 0x06, data: [...u32be(addr), ...u32be(size), ...u32be(crc), ...u32be(calc)] };
      }
      case 0x36: { this.written = 0; return { status: 0 }; } // 复位不清 magic → 仍回 Boot
      case 0x37: {
        if (!this.appValid()) return { status: 0x03 };
        this.mode = "APP"; this.written = 0; return { status: 0 };
      }
      case 0x39: { // 状态：status@0, written be32@1, lastAddr be32@5（NB 62B 诊断前段）；status由 handleN32 统一前置
        const b = new Uint8Array(8);
        b.set(u32be(this.written), 0);
        b.set(u32be(N32.APP_BASE + Math.max(0, this.written - 4)), 4);
        return { status: 0, data: b };
      }
      default: return { status: 0x01 };
    }
  }
}

export class FakeAdapter {
  // 接口与 WebBluetoothAdapter 对齐；channel 复用真实 WireChannel（解码/配对逻辑同链路）
  constructor(log = () => {}) {
    this.log = log; this.device = { id: "fake-j57aa-001" }; this.connected = false;
    this.generation = 1; this.exclusive = null; this.normalRequests = 0; this.writing = false;
    this.w515 = new VirtualW515(); this.n32 = new VirtualN32();
    this.proxy = { active: false, session: 0 };
    this.channel = new WireChannel((bytes, options) => this.fakeWrite(bytes, options), log);
    this.rttMs = 4; this.failRate = 0; // 可注入故障
  }
  supported() { return true; }
  async connect() {
    if (this.exclusive) throw new Error("检测/升级中，不可更换设备");
    this.connected = true; this.generation++; this.channel.resetConnection();
    this.log("SYS", "仿真设备已连接: FAKE-J57AA (W515 APP + N32 APP)");
    return { connected: true, name: "FAKE-J57AA" };
  }
  async disconnect() { this.channel.disconnect(); this.connected = false; this.generation++; this.proxy = { active: false, session: 0 }; return { connected: false }; }
  async reconnect() { this.connected = true; this.channel.resetConnection(); return true; }
  isGattConnected() { return this.connected; }
  beginExclusive(owner) {
    if (this.exclusive || this.normalRequests || this.writing || this.channel.active) throw new Error("蓝牙通道忙，请等上一操作完成");
    this.exclusive = owner;
    return () => { if (this.exclusive === owner) this.exclusive = null; };
  }
  assertNormal() { if (this.exclusive) throw new Error("状态检测/升级正在独占蓝牙通道"); }
  requestWire(frame, options) {
    if (!this.exclusive) throw new Error("先获取独占通道再发送升级协议");
    this.tap?.push?.("tx", frame);
    return this.channel.request(frame, options);
  }
  async write(value) { this.assertNormal(); this.tap?.push?.("tx", value); return this.fakeWrite(value, { chunkSize: value.length }); }
  async fakeWrite(value, { signal } = {}) {
    checkAbort(signal);
    if (!this.connected) throw new Error("BLE 未连接");
    if (this.writing) throw new Error("禁止并行 GATT 写入");
    this.writing = true;
    try {
      await new Promise((r, j) => { const t = setTimeout(r, this.rttMs); signal?.addEventListener("abort", () => { clearTimeout(t); j(new DOMException("操作已取消", "AbortError")); }, { once: true }); });
      if (this.failRate > 0 && Math.random() < this.failRate) throw new Error("注入的 GATT 写入失败");
      // 设备逐字节接收：模拟分片重组后完整帧处理
      this.deviceReceive(Uint8Array.from(value));
    } finally { this.writing = false; }
  }
  deviceReceive(bytes) {
    // 完整帧到达设备侧：按前缀分派（对应 RT 分发表/WP/NA 解析）
    for (const response of this.dispatch(bytes)) {
      if (!response) continue;
      // RX 回路：tap + channel.receive（与 onNotify 同路径）
      queueMicrotask(() => {
        this.tap?.push?.("rx", Uint8Array.from(response));
        this.channel.receive(Uint8Array.from(response));
        if (!this.exclusive) this.log("RX", Array.from(response, b => b.toString(16).padStart(2, "0").toUpperCase()).join(""));
      });
    }
  }
  dispatch(bytes) {
    // RAW 空闲自动恢复：超过 idle 无字节则主控退出代理（PX 语义）
    if (this.proxy.active && this.proxy.raw && Date.now() - (this.proxy.lastTraffic || 0) > (this.proxy.idleMs || 2000)) {
      this.proxy = { active: false, session: 0 };
    }
    if (this.proxy.active) this.proxy.lastTraffic = Date.now();
    const out = [];
    // RAW 透传：所有字节（含 GLPX 控制帧）直接转发 N32，主控不解析（PX:1203-1205）
    if (this.proxy.active && this.proxy.raw) {
      if (bytes[0] === 0xAA && bytes[1] >= 0x31 && bytes[1] <= 0x39) { out.push(this.handleN32(bytes)); return out; }
      return out; // RAW 下 GLPX/其他帧透传给 N32 当垃圾丢弃（无回应）
    }
    if (bytes.length >= 10 && bytes[0] === 0xAA && bytes[1] === 0xEE && bytes[2] === 0xF7) {
      if (bytes[7] === 0xF7 || bytes[7] === 0x00) {
        // 目标字节 byte[4]：0=主控（旧固件整帧匹配）；1=副板（新固件代理转发 N32 0x3A）
        if (bytes[4] === 1) {
          if (this.w515.mode === "APP" && this.f7RelaySupported !== false) out.push(this.n32F7Response());
          // 主控在 Boot 或旧固件：静默（网页超时降级）
        } else out.push(this.w515.f7Response());
      }
      return out;
    }
    if (bytes.length >= 9 && bytes[0] === 0xAA && bytes[1] === 0x7E) { out.push(this.handleProxy(bytes)); return out; }
    if (bytes[0] === 0xAA && bytes[1] >= 0x31 && bytes[1] <= 0x39) {
      // 代理激活→转发 N32；未激活→APP 的 W515 升级通道（RT 表序 2）
      if (this.proxy.active) { out.push(this.handleN32(bytes)); return out; }
      const frame = this.handleW515(bytes);
      if (frame) out.push(frame);
      return out;
    }
    if (bytes[0] === 0xAA && bytes[1] >= 0x01 && bytes[1] <= 0x09) {
      const frame = this.handleW515(bytes);
      if (frame) out.push(frame);
      return out;
    }
    return out; // 业务帧等：不回应
  }
  // F7 目标=1 应答：主控代理转发 N32 0x3A 的结果，填进 48B 统一布局（型号 J57AA-N32）
  n32F7Response() {
    const n = this.n32, b = new Uint8Array(48), dv = new DataView(b.buffer);
    const meta = n.mode === "APP" ? n.readMeta() : n.readMeta(); // meta 在 flash：APP/Boot 模式都可读
    const size = meta?.size ?? 0, crc = meta?.crc ?? 0, sw = meta?.sw ?? 0x0001, boot = n.infoBoot ?? 0x0102;
    dv.setUint32(0, 0x4E333200, true);      // N32 设备标识
    dv.setUint16(4, 0x0100, true);          // hw 1.0
    dv.setUint16(6, sw, true);              // APP 版本（meta）
    dv.setUint16(8, boot, true);            // Boot 版本（嵌入块）
    b.set(ascii("J57AA-N32"), 12);
    dv.setUint32(28, 128 * 1024, true);     // flash 128KB
    dv.setUint32(32, N32.APP_BASE, true);
    dv.setUint32(36, N32.APP_END - N32.APP_BASE + 1, true);
    dv.setUint32(40, size, true);
    dv.setUint32(44, crc, true);
    const frame = [0xAA, 0xFE, 0xF7, 48, ...b];
    let x = 0; for (let k = 2; k < 52; k++) x ^= frame[k];
    frame.push(x, 0xBB, 0xFF);
    return frame;
  }
  frameOk(bytes) { // CRC + 帧尾校验（失败静默，同固件）
    return bytes[bytes.length - 1] === 0x55 &&
      crc16Modbus(bytes.slice(1, -3)) === ((bytes[bytes.length - 3] << 8) | bytes[bytes.length - 2]);
  }
  handleW515(bytes) {
    if (!this.frameOk(bytes)) return null;
    const cmd = bytes[1], len = (bytes[2] << 8) | bytes[3], payload = bytes.slice(4, 4 + len);
    const resp = this.w515.handle(cmd, payload);
    if (resp == null) return null; // 静默（APP 对 03-09 / 无ACK写）
    return [0xAA, cmd | 0x80, ...be16(resp.length), ...resp, 0, 0, 0x55];
  }
  handleProxy(bytes) {
    const len = (bytes[2] << 8) | bytes[3];
    const p = bytes.slice(4, 4 + len);
    if (String.fromCharCode(...p.slice(0, 4)) !== "GLPX") return null;
    if (crc16Modbus(bytes.slice(0, -2)) !== ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1])) return null;
    const mode = p[4], session = be32(p, 5);
    let status;
    if (mode === 1) { // START：固件要求整帧≥27B（payload≥21）；payload=22 时含 flags
      if (len < 21) status = PROXY_ST.BAD;
      else if (this.proxy.active) status = PROXY_ST.BUSY;
      else {
        const flags = len >= 22 ? p[21] : 0;
        if (flags & 2) { // RAW 透传：记 idle 供自动恢复语义
          this.proxy = { active: true, session, flags, raw: true, idleMs: be32(p, 13), lastTraffic: Date.now() };
        } else this.proxy = { active: true, session, flags };
        status = PROXY_ST.OK;
      }
    } else if (mode === 2 || mode === 4) { // STOP / KEEPALIVE
      if (!this.proxy.active) status = PROXY_ST.INACT;
      else if (session !== 0 && session !== this.proxy.session) status = PROXY_ST.SESS;
      else { if (mode === 2) this.proxy = { active: false, session: 0 }; status = PROXY_ST.OK; }
    } else if (mode === 3) { // STATUS
      if (!this.proxy.active) status = PROXY_ST.INACT;
      else if (session !== 0 && session !== this.proxy.session) status = PROXY_ST.SESS;
      else status = PROXY_ST.OK;
    } else status = PROXY_ST.UNSUP;
    return [0xAA, 0x7E, 0x00, 0x05, ...ascii("GLPX"), status, 0, 0];
  }
  handleN32(bytes) {
    if (!this.frameOk(bytes)) return null;
    const cmd = bytes[1], len = (bytes[2] << 8) | bytes[3], payload = bytes.slice(4, 4 + len);
    const r = this.n32.handle(cmd, payload);
    if (r.status == null) return null;
    const data = r.data || [];
    return [0xAA, cmd | 0x80, ...be16(1 + data.length), r.status, ...data, 0, 0, 0x55];
  }
}
// 帧构建统一收口：把上面的占位替换为真实 CRC（W515/GLPX/N32 三类）
const _origDispatch = FakeAdapter.prototype.dispatch;
FakeAdapter.prototype.dispatch = function (bytes) {
  const frames = _origDispatch.call(this, bytes);
  return frames.map(f => f == null ? null : withCrc(f));
};
function withCrc(f) {
  if (f[1] === 0x7E) { // GLPX：CRC 覆盖 AA..status，无尾
    const c = crc16Modbus(f.slice(0, -2));
    f[f.length - 2] = c >> 8; f[f.length - 1] = c & 255; return f;
  }
  if (f[1] === 0xFE && f[2] === 0xF7) return f; // F7: XOR 已算好
  const c = crc16Modbus(f.slice(1, -3));
  f[f.length - 3] = c >> 8; f[f.length - 2] = c & 255; return f;
}
