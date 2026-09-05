// J57AA W515 BLE OTA 协议（浏览器移植版）
// 依据: docs/OTA_PORT_SPEC.md（母本 unified-tool web_api/debug_api.py + web/pages/debug_pro.html）
// 帧格式: AA CMD LEN_H LEN_L PAYLOAD CRC_H CRC_L 55
// CRC16-Modbus 覆盖 CMD+LEN+PAYLOAD（不含 AA/55），线上大端（高字节在前）

export const OTA_CMD = {
  HANDSHAKE: 0x01,
  GET_INFO: 0x02,
  ENTER_UPGRADE: 0x03,
  ERASE: 0x04,
  WRITE: 0x05,
  VERIFY: 0x06,
  RESET: 0x07,
  GET_STATUS: 0x09
};

export const OTA_MAGIC = {
  BOOT: 0x87654321,   // Boot 模式（大端前 4B）
  APP: 0xAA55AA55     // App 模式
};

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >> 1) ^ 0xA001) : (c >> 1);
    t[i] = c & 0xFFFF;
  }
  return t;
})();

export function crc16Modbus(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return crc & 0xFFFF;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ---------- 帧构造 ----------

export function buildOtaFrame(cmd, payload = []) {
  const p = payload instanceof Uint8Array ? Array.from(payload) : Array.from(payload || []);
  const body = [cmd & 0xFF, (p.length >> 8) & 0xFF, p.length & 0xFF, ...p];
  const crc = crc16Modbus(body);
  return new Uint8Array([0xAA, ...body, (crc >> 8) & 0xFF, crc & 0xFF, 0x55]);
}

export function u32be(v) {
  return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}

// ---------- 响应帧搜索 ----------
// 在字节缓冲里找 AA (cmd|0x80) LEN payload CRC 55 的完整帧（CRC 覆盖 frame[1..-3]）
// 返回 { frames: [...], consumed: n }，consumed = 可安全丢弃的字节数

export function scanOtaFrames(buf, from = 0) {
  const frames = [];
  let i = from;
  let lastEnd = from;
  while (i < buf.length - 6) {
    if (buf[i] !== 0xAA) { i++; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len > 4096) { i++; continue; }              // L3034
    const frameLen = 4 + len + 3;                    // AA cmd len(2) payload crc(2) 55
    if (i + frameLen > buf.length) break;            // 不完整，等更多字节
    const frame = buf.slice(i, i + frameLen);
    const body = frame.slice(1, frameLen - 3);       // cmd+len+payload
    const crcOnWire = (frame[frameLen - 3] << 8) | frame[frameLen - 2];
    const crcOk = crc16Modbus(body) === crcOnWire;
    if (crcOk) {
      frames.push({
        cmd: frame[1],
        payload: frame.slice(4, 4 + len),
        raw: frame,
        crc_ok: true
      });
      lastEnd = i + frameLen;
      i = lastEnd;
    } else {
      i++;
    }
  }
  return { frames, consumed: lastEnd };
}

// ---------- 固件元数据（0x200 偏移，小端）----------

const FIRM_MAGIC = 0x4649524D; // "FIRM"

export function readFirmwareMeta(fw) {
  const off = 0x200;
  if (fw.length < off + 64) return null;
  const m = fw.slice(off, off + 64);
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== FIRM_MAGIC) return null;
  const appSize = dv.getUint32(0x20, true);
  const appCrc = dv.getUint32(0x24, true);
  const version = dv.getUint32(4, true);
  const model = new TextDecoder().decode(m.slice(0x10, 0x20)).split("\0")[0] || "";
  if (appSize === 0 || appSize > fw.length || appCrc === 0 || appCrc === 0xFFFFFFFF) return null;
  return { version, model, appSize, appCrc };
}

// 元数据兼容 CRC：把 0x200+0x20 / 0x200+0x24 的 app_size/app_crc 置 0xFF 再算整包 CRC32（§3.2）
export function crc32MetaCompatible(fw) {
  const patched = new Uint8Array(fw);
  patched.fill(0xFF, 0x200 + 0x20, 0x200 + 0x24);
  patched.fill(0xFF, 0x200 + 0x24, 0x200 + 0x28);
  return crc32(patched);
}

// W515 固件校验 CRC 候选顺序（§3.3 H5721-5800 简化：meta→兼容→裸）
export function buildVerifyCandidates(fw, meta) {
  const candidates = [];
  if (meta) {
    candidates.push({ source: "firmware-meta", crc: meta.appCrc, size: meta.appSize });
  }
  candidates.push({ source: "meta-compatible-calc", crc: crc32MetaCompatible(fw), size: fw.length });
  candidates.push({ source: "raw-calculated", crc: crc32(fw), size: fw.length });
  return candidates;
}

// ---------- F7 设备信息查询（APP 态，不进 Boot）----------
// 固件源: MCU_Master_W515PIQ6_APP/Template/gd32w51x_it.c L397-490（2026-08 版）
// 请求: AA EE F7 00 00 00 00 F7 BB FF（第 8 字节 0x00 也接受）
// 响应: AA FE F7 30 [48B info 小端] XOR BB FF（55B，XOR 覆盖 frame[2..52]）

export function buildF7Query() {
  return new Uint8Array([0xAA, 0xEE, 0xF7, 0x00, 0x00, 0x00, 0x00, 0xF7, 0xBB, 0xFF]);
}

export function scanF7Response(buf, from = 0) {
  for (let i = from; i + 55 <= buf.length; i++) {
    if (buf[i] !== 0xAA || buf[i + 1] !== 0xFE || buf[i + 2] !== 0xF7) continue;
    if (buf[i + 53] !== 0xBB || buf[i + 54] !== 0xFF) continue;
    let x = 0;
    for (let k = i + 2; k <= i + 52; k++) x ^= buf[k];
    if (x !== 0) continue;   // XOR 校验失败
    const info = buf.slice(i + 4, i + 4 + 48);
    const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
    const le16 = o => dv.getUint16(o, true);
    const le32 = o => dv.getUint32(o, true);
    return {
      consumed: i + 55,
      did: le32(0),
      hw_ver: le16(4),
      sw_ver: le16(6),          // Major<<8 | Minor
      boot_ver: le16(8),
      model: new TextDecoder().decode(info.slice(12, 28)).split("\0")[0] || "Unknown",
      flash_size: le32(28),
      app_start: le32(32),
      app_max_size: le32(36),
      app_size: le32(40),
      app_crc: le32(44)
    };
  }
  return null;
}

// ---------- 代理控制帧（GLPX）----------
// 固件源: upgrade_proxy.c L1504-1650（2026-07-28 版，格式与 debug_api.py 一致）
// AA 7E LEN_H LEN_L "GLPX" MODE [params...] CRC_H CRC_L（CRC16 覆盖 AA..params，无 0x55 尾）

export const PROXY_MODE = { START: 0x01, STOP: 0x02, STATUS: 0x03, KEEPALIVE: 0x04 };
export const PROXY_FLAG_RAW_UPGRADE = 0x02;

export function buildProxyFrame(mode, params = []) {
  const payload = [0x47, 0x4C, 0x50, 0x58, mode & 0xFF, ...params];   // "GLPX" + mode + params
  const len = payload.length;
  const body = [0xAA, 0x7E, (len >> 8) & 0xFF, len & 0xFF, ...payload];
  const crc = crc16Modbus(body);                                       // 覆盖含 AA（与 Boot 帧差异）
  return new Uint8Array([...body, (crc >> 8) & 0xFF, crc & 0xFF]);
}

// 代理响应: AA 7E 00 05 "GLPX" MODE STATUS CRC_H CRC_L（11B）
export function scanProxyResponse(buf, from = 0) {
  for (let i = from; i + 11 <= buf.length; i++) {
    if (buf[i] !== 0xAA || buf[i + 1] !== 0x7E) continue;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len !== 5) continue;
    if (String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]) !== "GLPX") continue;
    const body = buf.slice(i, i + 9);   // AA 7E 00 05 GLPX mode status
    const crcOnWire = (buf[i + 9] << 8) | buf[i + 10];
    if (crc16Modbus(body) !== crcOnWire) continue;
    return { consumed: i + 11, mode: buf[i + 8], status: buf[i + 9] };
  }
  return null;
}

// ---------- N32 Boot 帧（命令 0x31-0x3A，同 Boot 帧格式）----------

export const N32_CMD = {
  HANDSHAKE: 0x31, INFO: 0x32, ERASE: 0x33, WRITE: 0x34,
  VERIFY: 0x35, RESET: 0x36, ENTER_APP: 0x37, ENTER_BOOT: 0x38, STATUS: 0x39
};
export const N32_MAGIC = { BOOT: "N32B", APP: "N32A" };

// N32 握手/进Boot 帧构造
export function buildN32Frame(cmd, payload) {
  return buildOtaFrame(cmd, payload);
}

// ---------- GET_INFO 响应解析（48B，字段小端）----------

export function parseBootInfo(payload) {
  if (!payload || payload.length < 48) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const model = new TextDecoder().decode(payload.slice(12, 28)).split("\0")[0] || "Unknown";
  return {
    device_id: dv.getUint32(0, true),
    hw_ver: dv.getUint16(4, true),
    sw_ver: dv.getUint16(6, true),
    boot_ver: dv.getUint16(8, true),
    model,
    flash_size: dv.getUint32(28, true),
    app_start: dv.getUint32(32, true),
    app_max_size: dv.getUint32(36, true),
    app_size: dv.getUint32(40, true),
    app_crc: dv.getUint32(44, true)
  };
}

// ---------- GET_STATUS 响应解析（§1.8，大端 u32）----------

export function parseOtaStatus(payload) {
  if (!payload || payload.length < 5) return null;
  const state = payload[0];
  const be32 = (o) => (payload[o] << 24 | payload[o + 1] << 16 | payload[o + 2] << 8 | payload[o + 3]) >>> 0;
  return {
    state,
    written_size: be32(1),
    ore_count: be32(5),
    verify_result: payload.length > 9 ? payload[9] : null,
    verify_addr: payload.length > 17 ? be32(17) : null,
    verify_size: payload.length > 21 ? be32(21) : null,
    expected_crc: payload.length > 25 ? be32(25) : null,
    calculated_crc: payload.length > 29 ? be32(29) : null
  };
}
