// 管理员协议分接器：捕获 TX/RX 原始字节，解码为结构化中文解读。
// 解读映射全部来自当前固件源码提取（docs/OTA_PROTOCOL_SPEC.md），仅观察不发送。
import { WireDecoder, toHex, PROXY_MODE, buildOtaFrame, buildProxyFrame } from "../upgrade/ota-protocol.js?v=status-first-1";

const W515_STATE = { 0x00: "IDLE", 0x01: "CONNECTING", 0x02: "CONNECTED", 0x10: "BOOT模式", 0x11: "擦除中", 0x12: "写入中", 0x13: "校验中", 0x20: "升级成功", 0xF0: "错误", 0xF1: "超时" };
const W515_ERR = { 0x00: "成功", 0x01: "未知命令", 0x02: "参数/长度错", 0x03: "Flash失败", 0x04: "CRC错(未用)", 0x05: "超时(未用)", 0x06: "校验失败" };
const N32_ERR = { 0x00: "成功", 0x01: "未知命令", 0x02: "长度错", 0x03: "APP载荷错/Boot范围或顺序错", 0x04: "CRC错", 0x05: "Flash错", 0x06: "校验失败" };
const PROXY_ST = { 0x00: "成功/活动", 0x01: "坏帧", 0x03: "忙(已激活)", 0x04: "会话不符", 0x05: "未激活", 0x07: "不支持" };
const GLPE_EV = { 0x81: "BLE→UART1整包发出", 0x82: "N32首字节返回", 0x83: "N32应答超时", 0x84: "N32响应CRC正确", 0x85: "N32响应CRC错/超长", 0x86: "N32回包镜像" };
const VERIFY_RESULT = { 0x00: "未校验", 0x01: "成功", 0x02: "CRC失败", 0x03: "meta失败", 0xE1: "长度失败" };
const W515_CMD = { 0x01: "握手", 0x02: "读信息", 0x03: "进Boot", 0x04: "擦除", 0x05: "写入", 0x06: "校验", 0x07: "复位", 0x09: "查状态" };
const N32_CMD = { 0x31: "N32握手", 0x32: "N32信息", 0x33: "N32擦除", 0x34: "N32写入", 0x35: "N32校验", 0x36: "N32复位", 0x37: "N32进APP", 0x38: "N32进Boot", 0x39: "N32状态" };
const PROXY_MODE_NAME = { [PROXY_MODE.START]: "启动", [PROXY_MODE.STOP]: "停止", [PROXY_MODE.STATUS]: "状态查询", [PROXY_MODE.KEEPALIVE]: "保活" };

const be32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const hex = v => "0x" + v.toString(16).toUpperCase().padStart(v > 0xFFFFFF ? 8 : 2, "0");

function w515Tx(cmd, p) {
  switch (cmd) {
    case 0x01: return `握手请求 magic=${toHex(p.slice(0, 4))}`;
    case 0x02: return "读设备信息(48B)";
    case 0x03: return "请求进入Boot";
    case 0x04: return `擦除 addr=${hex(be32(p, 0))} size=${be32(p, 4)}B`;
    case 0x05: return p.length >= 5 ? `写${p[0] & 1 ? "(要ACK)" : ""} addr=${hex(be32(p, 1))} len=${p.length - 5}B` : `写(短帧${p.length}B)`;
    case 0x06: return `校验 addr=${hex(be32(p, 0))} size=${be32(p, 4)}B crc=${hex(be32(p, 8))}${p.length >= 16 ? ` ver=${hex(be32(p, 12))}` : ""}`;
    case 0x07: return "请求复位";
    case 0x09: return "查询升级状态";
    default: return `命令0x${cmd.toString(16)}`;
  }
}
function w515Rx(cmd, p) {
  switch (cmd) {
    case 0x81:
      if (p.length === 4) { const m = hex(be32(p, 0)); return `握手应答: ${be32(p, 0) === 0xAA55AA55 ? "APP" : be32(p, 0) === 0x87654321 ? "Boot" : "未知"} magic=${m}`; }
      return `握手应答错误 ${W515_ERR[p[0]] || hex(p[0])}`;
    case 0x82: {
      if (p.length !== 48) return `信息应答(异常${p.length}B)`;
      const model = String.fromCharCode(...p.slice(12, 28)).split("\0")[0];
      const le = o => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
      return `信息48: ${model} hw=${hex(p[4] | p[5] << 8)} sw=${hex(p[6] | p[7] << 8)} app=${le(40)}B crc=${hex(le(44))}`;
    }
    case 0x89: {
      if (p.length < 5) return `状态应答(旧版${p.length}B)`;
      const st = `${hex(p[0])}${W515_STATE[p[0]] ? "(" + W515_STATE[p[0]] + ")" : ""}`;
      const written = be32(p, 1);
      let s = `状态: state=${st} written=${written}B`;
      if (p.length >= 30) s += ` verify=${VERIFY_RESULT[p[9]] || hex(p[9])} crc计算=${hex(be32(p, 29))}`;
      if (p.length >= 49) s += `(${p.length}B新版)`;
      return s;
    }
    default: return `ACK ${W515_CMD[cmd & 0x7F] || hex(cmd)} → ${W515_ERR[p[0]] ?? hex(p[0])}${p[0] === 0 ? "" : "!"}`;
  }
}
function n32Tx(cmd, p) {
  switch (cmd) {
    case 0x31: case 0x32: return `${N32_CMD[cmd]} payload=${toHex(p)}`;
    case 0x33: return `N32擦除 addr=${hex(be32(p, 4))} size=${be32(p, 8)}B 页=${p.length >= 14 ? hex(p[12] << 8 | p[13]) : "?"}`;
    case 0x34: return p.length >= 5 ? `N32写${p[0] & 1 ? "(要ACK)" : "(无ACK)"} addr=${hex(be32(p, 1))} len=${p.length - 5}B` : `N32写(短帧)`;
    case 0x35: return `N32校验 addr=${hex(be32(p, 4))} size=${be32(p, 8)}B crc=${hex(be32(p, 12))}`;
    default: return N32_CMD[cmd] || `N32命令${hex(cmd)}`;
  }
}
function n32Rx(cmd, p) {
  const st = p[0];
  const base = `status=${hex(st)}${N32_ERR[st] ? "(" + N32_ERR[st] + ")" : ""}`;
  if (cmd === 0xB1 || cmd === 0xB2) {
    if (st !== 0) return `${cmd === 0xB1 ? "N32握手" : "N32信息"}应答 ${base}`;
    const magic = String.fromCharCode(...p.slice(1, 5));
    if (magic === "N32B") return `N32应答: **Boot** v${p[5]} app=${hex(be32(p, 6))}~${hex(be32(p, 10))} appValid=${p[15] & 1}`;
    if (magic === "N32A") return `N32应答: **APP** v${p[5] << 8 | p[6]} 入口=${hex(be32(p, 9))}`;
    return `N32应答: magic=${magic}`;
  }
  if (cmd === 0xB5 && st === 0 && p.length >= 17) return `N32校验应答: 通过 addr=${hex(be32(p, 1))} 期望=${hex(be32(p, 9))} 实算=${hex(be32(p, 13))}`;
  if (cmd === 0xB9 && st === 0 && p.length >= 5) return `N32状态62B: written=${be32(p, 1)}B 最近写=${hex(be32(p, 5))}`;
  return `N32 ACK ${N32_CMD[cmd & 0x7F] || hex(cmd)} ${base}`;
}
function proxyTx(bytes) {
  const len = (bytes[2] << 8) | bytes[3];
  const p = bytes.slice(4, 4 + len); // 严格按 LEN 截断，不含 CRC
  const mode = p[4];
  const name = PROXY_MODE_NAME[mode] || hex(mode);
  const session = be32(p, 5);
  const parts = [`session=${hex(session)}`];
  if (mode === PROXY_MODE.START) parts.push(`baud=${be32(p, 9)} idle=${be32(p, 13)}ms total=${be32(p, 17)}ms${p.length > 21 ? ` flags=${hex(p[21])}` : ""}`);
  return `GLPX ${name} ${parts.join(" ")}`;
}
function interpretFrame(frame) {
  const p = frame.payload;
  if (frame.protocol === "f7") return frame.cmd === 0xF7 ? "F7 信息应答(48B)" : "F7 帧";
  if (frame.protocol === "proxy") { const st = frame.raw[8]; return `GLPX 应答: ${PROXY_ST[st] || hex(st)}(${hex(st)})`; }
  if (frame.protocol === "event") {
    const ev = frame.raw[8];
    return `GLPE 事件: ${GLPE_EV[ev] || hex(ev)} cmd=${hex(frame.raw[11])} value=${hex(be32(frame.raw, 13))}`;
  }
  const cmd = frame.cmd;
  if (cmd >= 0xB1 && cmd <= 0xBA) return n32Rx(cmd, p);
  return w515Rx(cmd, p);
}
function interpretTx(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0xAA && bytes[1] === 0xEE && bytes[2] === 0xF7) return { protocol: "f7", name: "F7 信息查询", detail: "" };
  if (bytes.length >= 9 && bytes[0] === 0xAA && bytes[1] === 0x7E) return { protocol: "glpx", name: "GLPX 控制", detail: proxyTx(bytes) };
  if (bytes.length >= 4 && bytes[0] === 0xFE && bytes[1] === 0xFF && bytes[2] === 0xFF && bytes[3] === 0xFE) return { protocol: "biz", name: "业务帧", detail: `len=${bytes.length}B` };
  if (bytes.length >= 4 && bytes[0] === 0xAA) {
    const cmd = bytes[1];
    const len = (bytes[2] << 8) | bytes[3];
    const p = bytes.slice(4, 4 + len);
    if (cmd >= 0x31 && cmd <= 0x39) return { protocol: "n32", name: N32_CMD[cmd] || "N32", detail: n32Tx(cmd, p) };
    if (cmd >= 0x01 && cmd <= 0x09) return { protocol: "w515", name: W515_CMD[cmd] || "W515", detail: w515Tx(cmd, p) };
  }
  return { protocol: "raw", name: "未知帧", detail: `len=${bytes.length}B` };
}

export class ProtocolTap {
  constructor({ cap = 4000 } = {}) {
    this.cap = cap; this.entries = []; this.listeners = [];
    this.decoder = new WireDecoder(); this.rxNoise = 0;
    this.seq = 0;
  }
  on(fn) { this.listeners.push(fn); }
  emit(entry) { for (const fn of this.listeners) { try { fn(entry); } catch {} } }
  push(dir, bytes) {
    const time = new Date();
    if (dir === "tx") {
      const { protocol, name, detail } = interpretTx(bytes);
      this.add({ time, dir: "TX", protocol, name, detail, hex: toHex(bytes) });
      return;
    }
    // RX: 业务信封直接识别；协议帧走解码器；其余字节计入累计未识别（页脚显示）
    if (bytes.length >= 11 && bytes[0] === 0xFE && bytes[1] === 0xFF && bytes[2] === 0xFF && bytes[3] === 0xFE) {
      this.add({ time, dir: "RX", protocol: "biz", name: "业务帧", detail: `len=${bytes.length}B(测距/弹道数据)`, hex: "" });
      this.decoder.push(bytes); // 解码器吞掉整包，防止残留
      return;
    }
    const before = this.decoder.buffer.length;
    const frames = this.decoder.push(bytes);
    for (const frame of frames) {
      this.add({ time, dir: "RX", protocol: frame.protocol, name: frameLabel(frame), detail: interpretFrame(frame), hex: toHex(frame.raw) });
    }
    if (!frames.length) {
      const swallowed = before + bytes.length - this.decoder.buffer.length;
      if (swallowed > 0) this.rxNoise += swallowed;
    }
  }
  add(entry) {
    entry.id = ++this.seq;
    this.entries.push(entry);
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    this.emit(entry);
  }
  clear() { this.entries = []; this.rxNoise = 0; this.decoder.reset(); this.emit(null); }
  injectDemo() {
    // 无真机自验：按 docs/OTA_FLOW_INTERACTIONS.md §2 检测序列注入示例帧（全部程序构建，CRC 保证正确）
    const F = (bytes, dir = "rx") => this.push(dir, Uint8Array.from(bytes));
    F([0xAA, 0xEE, 0xF7, 0x00, 0x00, 0x00, 0x00, 0xF7, 0xBB, 0xFF], "tx");
    const info48 = new Array(48).fill(0);
    [0x4D, 0x3C, 0x2B, 0x1A].forEach((b, i) => info48[i] = b);
    info48[5] = 0x01; info48[7] = 0x01; info48[9] = 0x01;
    "J57AA-W515".split("").forEach((ch, i) => info48[12 + i] = ch.charCodeAt(0));
    info48[28] = 0x20; info48[33] = 0x08; info48[35] = 0x80; info48[36] = 0x1F;
    info48[42] = 0x01; info48[44] = 0xEF; info48[45] = 0xBE; info48[46] = 0xAD; info48[47] = 0xDE;
    const f7 = [0xAA, 0xFE, 0xF7, 0x30, ...info48];
    let x = 0; for (let k = 2; k < 52; k++) x ^= f7[k];
    f7.push(x, 0xBB, 0xFF);
    F(f7);
    F(buildOtaFrame(0x01, [0x12, 0x34, 0x56, 0x78]), "tx");
    F([0xAA, 0x81, 0x00, 0x04, 0xAA, 0x55, 0xAA, 0x55, 0x9F, 0xF4, 0x55]);
    F(buildProxyFrame(3, { session: 0 }), "tx");
    F([0xAA, 0x7E, 0x00, 0x05, 0x47, 0x4C, 0x50, 0x58, 0x05, 0xE7, 0x53]);
    F(buildProxyFrame(1, { session: 0x12345678, baud: 115200, idleMs: 5000, totalMs: 12000 }), "tx");
    F([0xAA, 0x7E, 0x00, 0x05, 0x47, 0x4C, 0x50, 0x58, 0x00, 0xE4, 0x93]);
    F(buildOtaFrame(0x31, [..."N32B"].map(c => c.charCodeAt(0))), "tx");
    F([0xAA, 0xB1, 0x00, 0x11, 0x00, 0x4E, 0x33, 0x32, 0x42, 0x01, 0x08, 0x00, 0x20, 0x00, 0x08, 0x00, 0xF7, 0xFF, 0x08, 0x00, 0x01, 0x49, 0x58, 0x55]);
    F([0xAA, 0xFE, 0x00, 0x0D, 0x47, 0x4C, 0x50, 0x45, 0x81, 0x00, 0x01, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0x25, 0x6C]);
    F(buildProxyFrame(2, { session: 0x12345678 }), "tx");
    F([0xAA, 0x7E, 0x00, 0x05, 0x47, 0x4C, 0x50, 0x58, 0x00, 0xE4, 0x93]);
    F(buildOtaFrame(0x03, []), "tx");
    F([0xAA, 0x83, 0x00, 0x01, 0x00, 0x30, 0x28, 0x55]);
    F(buildOtaFrame(0x04, [0x08, 0x00, 0x80, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]), "tx");
    F([0xAA, 0x84, 0x00, 0x01, 0x00, 0x44, 0x29, 0x55]);
    F(buildOtaFrame(0x05, [0x01, 0x08, 0x00, 0x80, 0x00, ...new Array(40).fill(0)]), "tx");
    F([0xAA, 0x85, 0x00, 0x01, 0x00, 0xB8, 0x28, 0x55]);
    F(buildOtaFrame(0x09, []), "tx");
    const st = [0x12, 0, 0, 0, 41, 0, 0, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 1, 0x08, 0x00, 0x80, 0x00, 0, 0, 0, 41, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0x46, 0x49, 0x52, 0x4D, 0, 0, 0, 41, 0xDE, 0xAD, 0xBE, 0xEF, 0, 0, 1, 0xF4];
    F([0xAA, 0x89, 0x00, 0x31, ...st, 0x73, 0x29, 0x55]);
    F([0xAA, 0x85, 0x00, 0x01, 0x03, 0xB9, 0x68, 0x55]);
  }
}
function frameLabel(frame) {
  const n = { f7: "F7", proxy: "GLPX", event: "GLPE", w515: "W515", n32: "N32" };
  if (frame.protocol === "f7") return "F7 应答";
  return `${n[frame.protocol] || frame.protocol} ${hex(frame.cmd)}`;
}
