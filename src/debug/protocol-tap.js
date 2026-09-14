// 管理员协议分接器：捕获 TX/RX 原始字节，解码为结构化中文解读。
// 解读映射全部来自当前固件源码提取（docs/OTA_PROTOCOL_SPEC.md），仅观察不发送。
import { WireDecoder, toHex, PROXY_MODE } from "../upgrade/ota-protocol.js?v=status-first-1";

const W515_STATE = { 0x00: "IDLE", 0x01: "CONNECTING", 0x02: "CONNECTED", 0x10: "BOOT模式", 0x11: "擦除中", 0x12: "写入中", 0x13: "校验中", 0x20: "升级成功", 0xF0: "错误", 0xF1: "超时" };
const W515_ERR = { 0x00: "成功", 0x01: "未知命令", 0x02: "参数/长度错", 0x03: "Flash失败", 0x04: "CRC错(未用)", 0x05: "超时(未用)", 0x06: "校验失败" };
const N32_ERR = { 0x00: "成功", 0x01: "未知命令", 0x02: "长度错", 0x03: "APP载荷错/Boot范围或顺序错", 0x04: "CRC错", 0x05: "Flash错", 0x06: "校验失败" };
const PROXY_ST = { 0x00: "成功/活动", 0x01: "坏帧", 0x03: "忙(已激活)", 0x04: "会话不符", 0x05: "未激活", 0x07: "不支持" };
const GLPE_EV = { 0x81: "BLE→UART1整包发出", 0x82: "N32首字节返回", 0x83: "N32应答超时", 0x84: "N32响应CRC正确", 0x85: "N32响应CRC错/超长", 0x86: "N32回包镜像" };
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
      if (p.length >= 30) s += ` verify=${W515_ERR[p[9]] || hex(p[9])} crc计算=${hex(be32(p, 29))}`;
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
function proxyTx(p) {
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
  if (frame.protocol === "proxy") return `GLPX 应答: ${PROXY_ST[p ? p[0] : 0xFF] || hex(p ? p[0] : 0xFF)}`;
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
  if (bytes.length >= 9 && bytes[0] === 0xAA && bytes[1] === 0x7E) return { protocol: "glpx", name: "GLPX 控制", detail: proxyTx(bytes.slice(4)) };
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
    // RX: 先喂解码器提取协议帧，剩余计为噪声
    let consumed = 0;
    for (const frame of this.decoder.push(bytes)) {
      this.add({ time, dir: "RX", protocol: frame.protocol, name: frameLabel(frame), detail: interpretFrame(frame), hex: toHex(frame.raw) });
      consumed = frame.consumed;
    }
    const noise = bytes.length - Math.min(consumed, bytes.length);
    if (noise > 0) { this.rxNoise += noise; this.add({ time, dir: "RX", protocol: "noise", name: "未识别字节", detail: `+${noise}B(累计${this.rxNoise}B)`, hex: "" }); }
  }
  add(entry) {
    entry.id = ++this.seq;
    this.entries.push(entry);
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    this.emit(entry);
  }
  clear() { this.entries = []; this.rxNoise = 0; this.decoder.reset(); this.emit(null); }
  injectDemo() {
    // 无真机自验：按 docs/OTA_FLOW_INTERACTIONS.md §2 检测序列注入示例帧（CRC 均程序验证过）
    const D = [
      ["tx", "AA EE F7 00 00 00 00 F7 BB FF"],
      ["rx", "AA FE F7 30 4D 3C 2B 1A 00 01 00 01 00 01 00 00 4A 35 37 41 41 2D 57 35 31 35 00 00 00 00 00 00 20 00 00 80 00 08 00 80 1F 00 00 00 01 00 EF BE AD DE 91 BB FF"],
      ["tx", "AA 01 00 04 12 34 56 78 34 81 55"],
      ["rx", "AA 81 00 04 AA 55 AA 55 9F F4 55"],
      ["tx", "AA 7E 00 15 47 4C 50 58 03 00 00 00 00 00 01 C2 00 00 00 13 88 00 00 2E E0 B5 77"],
      ["rx", "AA 7E 00 05 47 4C 50 58 05 E7 53"],
      ["tx", "AA 7E 00 16 47 4C 50 58 01 12 34 56 78 00 01 C2 00 00 00 13 88 00 00 2E E0 00 4F 14"],
      ["rx", "AA 7E 00 05 47 4C 50 58 00 E4 93"],
      ["tx", "AA 31 00 04 4E 33 32 42 75 B8 55"],
      ["rx", "AA B1 00 11 00 4E 33 32 42 01 08 00 20 00 08 00 F7 FF 08 00 01 49 58 55"],
      ["rx", "AA FE 00 0D 47 4C 50 45 81 00 01 33 00 00 00 00 00 25 6C"],
      ["tx", "AA 7E 00 15 47 4C 50 58 02 12 34 56 78 00 00 00 00 00 00 00 00 00 00 00 00 2F 36"],
      ["rx", "AA 7E 00 05 47 4C 50 58 00 E4 93"],
      ["tx", "AA 03 00 00 C0 81 55"],
      ["rx", "AA 83 00 01 00 30 28 55"],
      ["tx", "AA 04 00 09 08 00 80 00 00 02 00 00 00 52 A2 55"],
      ["rx", "AA 84 00 01 00 44 29 55"],
      ["tx", "AA 05 00 29 01 08 00 80 00 11 22 33 44 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 1D 93 55"],
      ["rx", "AA 85 00 01 00 B8 28 55"],
      ["tx", "AA 09 00 00 C2 A1 55"],
      ["rx", "AA 89 00 31 12 00 00 00 29 00 00 00 00 00 00 01 00 00 00 00 00 00 01 08 00 80 00 00 00 00 29 DE AD BE EF DE AD BE EF 46 49 52 4D 00 00 00 29 DE AD BE EF 00 00 01 F4 99 A1 55"],
      ["rx", "AA 85 00 01 03 B9 68 55"]
    ];
    for (const [dir, h] of D) this.push(dir, Uint8Array.from(h.split(" ").map(s => parseInt(s, 16))));
  }
}
function frameLabel(frame) {
  const n = { f7: "F7", proxy: "GLPX", event: "GLPE", w515: "W515", n32: "N32" };
  return `${n[frame.protocol] || frame.protocol} ${hex(frame.cmd)}`;
}
