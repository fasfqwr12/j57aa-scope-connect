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
