// Wire codecs from current W515/N32 firmware. No device I/O in this module.
export const OTA_CMD = Object.freeze({ HANDSHAKE: 1, GET_INFO: 2, ENTER_UPGRADE: 3, ERASE: 4, WRITE: 5, VERIFY: 6, RESET: 7, GET_STATUS: 9 });
export const OTA_MAGIC = Object.freeze({ BOOT: 0x87654321, APP: 0xAA55AA55 });
export const N32_CMD = Object.freeze({ HANDSHAKE: 0x31, INFO: 0x32, ERASE: 0x33, WRITE: 0x34, VERIFY: 0x35, RESET: 0x36, ENTER_APP: 0x37, ENTER_BOOT: 0x38, STATUS: 0x39 });
export const N32_MAGIC = Object.freeze({ BOOT: "N32B", APP: "N32A" });
export const PROXY_MODE = Object.freeze({ START: 1, STOP: 2, STATUS: 3, KEEPALIVE: 4 });
export const PROXY_STATUS = Object.freeze({ OK: 0, BAD_FRAME: 1, BUSY: 3, SESSION_MISMATCH: 4, INACTIVE: 5, UNSUPPORTED: 7 });
export const PROXY_FLAG_RAW_UPGRADE = 2;
export const W515_LAYOUT = Object.freeze({ flashBase: 0x08000000, flashEnd: 0x08200000, appMin: 0x08008000, page: 4096, ramBase: 0x20000000, ramEnd: 0x20070000 });
const bytes = value => Uint8Array.from(value || []);
const view = value => { const b = bytes(value); return new DataView(b.buffer); };
const ascii = value => String.fromCharCode(...value).split("\0")[0];
export const toHex = value => Array.from(value, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
export const u32be = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
export function crc16Modbus(data) {
  let crc = 0xFFFF;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
  }
  return crc & 0xFFFF;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (const b of data) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function buildOtaFrame(cmd, payload = []) {
  if (payload.length > 4096) throw new Error("OTA payload too large");
  const body = bytes([cmd, payload.length >>> 8, payload.length & 255, ...payload]);
  const crc = crc16Modbus(body);
  return bytes([0xAA, ...body, crc >>> 8, crc & 255, 0x55]);
}
export const buildN32Frame = buildOtaFrame;
export const buildF7Query = () => bytes([0xAA, 0xEE, 0xF7, 0, 0, 0, 0, 0xF7, 0xBB, 0xFF]);
// All four requests retain the full 16-byte parameter block (minimum wire length 27).
// Firmware fixes target=RANGE at upgrade_proxy.c:1590; target is NOT a wire field.
export function buildProxyFrame(mode, { session = 0, baud = 115200, idleMs = 5000, totalMs = 12000, flags = 0 } = {}) {
  if (!Object.values(PROXY_MODE).includes(mode)) throw new Error("Unknown GLPX operation");
  if (![0, 2, 4, 8].includes(flags)) throw new Error("Conflicting GLPX service flags");
  const payload = [0x47, 0x4C, 0x50, 0x58, mode, ...u32be(session), ...u32be(baud), ...u32be(idleMs), ...u32be(totalMs)];
  if (mode === PROXY_MODE.START && flags) payload.push(flags);
  const body = bytes([0xAA, 0x7E, 0, payload.length, ...payload]);
  const crc = crc16Modbus(body);
  return bytes([...body, crc >>> 8, crc & 255]);
}
// One bounded stream decoder separates envelopes before matching request replies.
// A GLPE mirror is consumed as an event, never reinterpreted as a fresh N32 ACK.
export class WireDecoder {
  constructor() { this.buffer = new Uint8Array(); }
  reset() { this.buffer = new Uint8Array(); }
  push(value) {
    const incoming = bytes(value);
    const joined = bytes([...this.buffer, ...incoming]);
    this.buffer = joined.length > 32768 ? joined.slice(-32768) : joined;
    const frames = [];
    let i = 0;
    let partial = -1;
    while (i < this.buffer.length) {
      const b = this.buffer;
      if (b[i] !== 0xAA) { i++; continue; }
      if (i + 4 > b.length) { partial = partial < 0 ? i : partial; break; }
      let protocol, length;
      if (b[i + 1] === 0xFE && b[i + 2] === 0xF7) {
        if (b[i + 3] !== 48) { i++; continue; }
        protocol = "f7"; length = 55;
      } else if (b[i + 1] === 0x7E || b[i + 1] === 0xFE) {
        const n = (b[i + 2] << 8) | b[i + 3];
        if (n < 5 || n > 4096) { i++; continue; }
        protocol = b[i + 1] === 0x7E ? "proxy" : "event"; length = n + 6;
      } else if ((b[i + 1] >= 0x81 && b[i + 1] <= 0x89) || (b[i + 1] >= 0xB1 && b[i + 1] <= 0xBA)) {
        const n = (b[i + 2] << 8) | b[i + 3];
        const c = b[i + 1];
        // Known reply shapes reject false incomplete AA headers without searching
        // inside a legitimate (possibly split) outer GLPE frame.
        const sizes = c === 0x81 ? [1, 4] : c === 0x82 ? [48] :
          c >= 0x83 && c <= 0x88 ? [1] : c === 0x89 ? [5, 9, 49] :
          c === 0xB1 ? [1, 17, 33] : c === 0xB2 ? [1, 17] : null;
        if (n > 96 || (sizes && !sizes.includes(n))) { i++; continue; }
        protocol = c < 0xB0 ? "w515" : "n32"; length = n + 7;
      } else { i++; continue; }
      if (i + length > b.length) { partial = i; break; }
      const raw = b.slice(i, i + length);
      let valid = false;
      if (protocol === "f7") {
        let xor = 0;
        for (let k = 2; k < 52; k++) xor ^= raw[k];
        valid = xor === raw[52] && raw[53] === 0xBB && raw[54] === 0xFF;
      } else if (protocol === "proxy" || protocol === "event") {
        valid = ascii(raw.slice(4, 8)) === (protocol === "proxy" ? "GLPX" : "GLPE") &&
          (protocol !== "proxy" || length === 11) &&
          crc16Modbus(raw.slice(0, -2)) === ((raw[length - 2] << 8) | raw[length - 1]);
      } else {
        valid = raw[length - 1] === 0x55 && crc16Modbus(raw.slice(1, -3)) === ((raw[length - 3] << 8) | raw[length - 2]);
      }
      if (!valid) {
        // An event mirror is never a direct reply, even when its outer CRC is bad.
        i += protocol === "event" ? length : 1;
        continue;
      }
      frames.push({ protocol, cmd: raw[1], payload: raw.slice(4, protocol === "f7" ? 52 : length - ((protocol === "proxy" || protocol === "event") ? 2 : 3)), raw, consumed: i + length, crc_ok: protocol !== "f7" });
      i += length;
      partial = -1;
    }
    this.buffer = this.buffer.slice(partial < 0 ? i : partial);
    return frames;
  }
}
export function scanOtaFrames(buf) {
  const frames = new WireDecoder().push(buf).filter(f => f.protocol === "w515" || f.protocol === "n32");
  return { frames, consumed: frames.length ? frames[frames.length - 1].consumed : 0 };
}
export function parseBootInfo(payload) {
  if (!payload || payload.length !== 48) return null;
  const b = bytes(payload), dv = view(b);
  return { device_id: dv.getUint32(0, true), hw_ver: dv.getUint16(4, true), sw_ver: dv.getUint16(6, true), boot_ver: dv.getUint16(8, true), model: ascii(b.slice(12, 28)), flash_size: dv.getUint32(28, true), app_start: dv.getUint32(32, true), app_max_size: dv.getUint32(36, true), app_size: dv.getUint32(40, true), app_crc: dv.getUint32(44, true) };
}
export function scanF7Response(buf) {
  const f = new WireDecoder().push(buf).find(f => f.protocol === "f7");
  return f ? { ...parseBootInfo(f.payload), consumed: f.consumed, raw: f.raw } : null;
}
export function scanProxyResponse(buf) {
  const f = new WireDecoder().push(buf).find(f => f.protocol === "proxy");
  // upgrade_proxy.c:1387-1395: byte 8=status, byte 9/10=CRC. NO mode echo.
  return f ? { status: f.raw[8], consumed: f.consumed, raw: f.raw } : null;
}
export function parseW515Mode(payload) {
  if (!payload || payload.length !== 4) return "UNKNOWN";
  const magic = view(payload).getUint32(0, false);
  return magic === OTA_MAGIC.APP ? "APP" : magic === OTA_MAGIC.BOOT ? "BOOT" : "UNKNOWN";
}
export function parseN32Info(payload) {
  const p = bytes(payload);
  if (!p.length) return { mode: "UNKNOWN", reason: "empty-ack" };
  if (p[0] !== 0) return { mode: "UNKNOWN", status: p[0], reason: "device-error" };
  if (p.length < 5) return { mode: "UNKNOWN", reason: "short-magic" };
  const data = p.slice(1), magic = ascii(data.slice(0, 4)), dv = view(data);
  if (magic === N32_MAGIC.APP && data.length === 32) {
    return { mode: "APP", magic, status: 0, appVersion: dv.getUint16(4, false), appStart: dv.getUint32(8, false), runtimeStage: data[16], uartRxBytes: dv.getUint32(20, false), heartbeat: dv.getUint16(30, false), appValid: null };
  }
  if (magic === N32_MAGIC.BOOT && data.length === 16) {
    return { mode: "BOOT", magic, status: 0, bootVersion: data[4], appStart: dv.getUint32(5, false), appEnd: dv.getUint32(9, false), pageSize: dv.getUint16(13, false), appValid: (data[15] & 1) !== 0 };
  }
  return { mode: "UNKNOWN", reason: "unrecognized-info-layout", magic };
}
export function parseOtaStatus(payload) {
  const p = bytes(payload);
  if (p.length < 5) return null;
  const dv = view(p), be = o => p.length >= o + 4 ? dv.getUint32(o, false) : null;
  return { state: p[0], written_size: be(1), ore_count: be(5), verify_result: p.length >= 10 ? p[9] : null, verify_count: be(13), verify_addr: be(17), verify_size: be(21), expected_crc: be(25), calculated_crc: be(29) };
}
export function readFirmwareMeta(firmware) {
  const b = bytes(firmware);
  if (b.length < 0x240) return null;
  const dv = view(b);
  if (dv.getUint32(0x200, true) !== 0x4649524D) return null;
  return { version: dv.getUint32(0x204, true), hwVersion: dv.getUint32(0x208, true), model: ascii(b.slice(0x210, 0x220)), appSize: dv.getUint32(0x220, true), appCrc: dv.getUint32(0x224, true) };
}
export function crc32MetaCompatible(firmware) {
  const copy = bytes(firmware);
  copy.fill(255, Math.min(copy.length, 0x220), Math.min(copy.length, 0x228));
  return crc32(copy);
}
export function buildVerifyCandidates(firmware, meta) {
  // Current Boot requires metadata consistency. Do not try unrelated CRC/size pairs.
  const b = bytes(firmware).slice(0, meta?.appSize || firmware.length);
  return [{ source: meta ? "firmware-meta" : "raw-calculated", crc: meta ? meta.appCrc : crc32(b), size: b.length }];
}
export function validateW515Window(info) {
  const l = W515_LAYOUT;
  if (!info || info.model !== "J57AA-W515" || info.flash_size !== l.flashEnd - l.flashBase ||
      !Number.isInteger(info.app_start) || info.app_start < l.appMin || info.app_start % l.page !== 0 ||
      !Number.isInteger(info.app_max_size) || info.app_max_size <= 0 || info.app_start + info.app_max_size > l.flashEnd) {
    throw new Error("主控型号或 Flash 窗口未确认；拒绝猜测地址/使用旧16KB Boot布局");
  }
  return info;
}
