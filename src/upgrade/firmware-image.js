import { readFirmwareMeta, crc32MetaCompatible, crc32, W515_LAYOUT, validateW515Window } from "./ota-protocol.js?v=status-first-1";
import { N32_LAYOUT } from "./n32-ota.js?v=resume-1";

// Intel HEX addresses are preserved and validated, never flashed as ASCII text.
export function parseIntelHex(text, { min = W515_LAYOUT.appMin, max = W515_LAYOUT.flashEnd } = {}) {
  let upper = 0, ended = false, startAddress = null;
  const segments = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (ended) throw new Error("HEX EOF 后仍有记录");
    if (!/^:[0-9a-f]+$/i.test(line) || (line.length - 1) % 2) throw new Error("HEX 记录格式错误");
    const r = Uint8Array.from(line.slice(1).match(/../g), h => parseInt(h, 16));
    if (r.length !== r[0] + 5 || (r.reduce((s, b) => s + b, 0) & 255)) throw new Error("HEX 长度或校验和错误");
    const len = r[0], off = (r[1] << 8) | r[2], type = r[3], d = r.slice(4, 4 + len);
    if (type === 0) { if (off + len > 0x10000) throw new Error("HEX 记录跨64KB边界"); if (len) segments.push({ address: upper + off, bytes: d }); }
    else if (type === 1 && len === 0 && off === 0) ended = true;
    else if ((type === 2 || type === 4) && len === 2 && off === 0) upper = ((d[0] << 8) | d[1]) * (type === 2 ? 16 : 65536);
    else if ((type === 3 || type === 5) && len === 4 && off === 0) startAddress = type === 5 ? new DataView(d.buffer).getUint32(0, false) : ((d[0] << 8 | d[1]) * 16 + (d[2] << 8 | d[3]));
    else throw new Error(`不支持或无效的 HEX 记录类型 ${type}`);
  }
  if (!ended || !segments.length) throw new Error("HEX 缺失数据或 EOF");
  segments.sort((a, b) => a.address - b.address);
  const base = segments[0].address, end = Math.max(...segments.map(s => s.address + s.bytes.length));
  if (base < min || end > max || end <= base) throw new Error(`HEX 地址越界（允许 ${"0x" + min.toString(16)}~${"0x" + max.toString(16)}），禁止误刷其它区域`);
  const data = new Uint8Array(end - base); data.fill(255);
  let last = base;
  for (const s of segments) { if (s.address < last) throw new Error("HEX 地址重叠"); data.set(s.bytes, s.address - base); last = s.address + s.bytes.length; }
  return { bytes: data, base, startAddress };
}
export function inspectFirmware(value, name, target = "w515-app") {
  if (target !== "w515-app" || /(?:^|[_-])(BOOT|IAP)(?:[_\-.]|$)/i.test(name) || /N32/i.test(name)) throw new Error("目标不匹配：此入口仅允许 W515 APP");
  const raw = Uint8Array.from(value);
  if (!raw.length || raw.length > 6 * 1024 * 1024) throw new Error("固件文件为空或过大");
  let parsed;
  if (/\.hex$/i.test(name)) parsed = parseIntelHex(new TextDecoder().decode(raw));
  else if (/\.bin$/i.test(name)) parsed = { bytes: raw, base: null };
  else throw new Error("仅支持 .bin / Intel HEX；不接受未实现解密的 .enc");
  const data = parsed.bytes, meta = readFirmwareMeta(data);
  if (!meta || meta.model !== "J57AA-W515" || meta.appSize !== data.length || meta.appSize < 0x240 || meta.appSize % 4) throw new Error("缺少有效 W515 元数据，或型号/长度/4字节对齐错误");
  if (meta.appCrc === 0 || meta.appCrc === 0xFFFFFFFF) throw new Error("Boot 拒绝保留值 CRC，禁止写入此镜像");
  if (crc32MetaCompatible(data) !== meta.appCrc) throw new Error("固件元数据 CRC32 与计算值不符");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), sp = dv.getUint32(0, true), reset = dv.getUint32(4, true);
  if (sp <= W515_LAYOUT.ramBase || sp > W515_LAYOUT.ramEnd || sp % 8 || !(reset & 1)) throw new Error("固件向量表非法");
  return { ...parsed, name, meta, sp, reset, target };
}
export function validateFirmwareForDevice(firmware, info) {
  validateW515Window(info);
  if (firmware.meta.hwVersion !== info.hw_ver) throw new Error("固件硬件版本与设备不匹配");
  const start = info.app_start, size = firmware.bytes.length;
  if (firmware.base !== null && firmware.base !== start) throw new Error("HEX 起址与设备上报 APP 起址不符");
  const reset = firmware.reset - 1;
  if (reset < start || reset >= start + size) throw new Error("复位入口不在设备 APP 窗口；可能是旧地址固件");
  const eraseSize = Math.ceil(size / W515_LAYOUT.page) * W515_LAYOUT.page;
  if (eraseSize > info.app_max_size) throw new Error("固件或擦除区超过 APP 窗口");
  return { appStart: start, size, eraseSize };
}
// N32 副板 APP 镜像：Intel HEX，基址必须 0x08002000，无 FIRM 元数据，CRC32 现算。
// 向量合理性：SP 落在 N32G430 RAM（0x20000000~0x20008000），复位向量落在 APP 窗口。
export function inspectN32Firmware(value, name) {
  if (!/\.hex$/i.test(name)) throw new Error("N32 镜像仅接受 Intel HEX（bin 无基址无法校验）");
  const raw = Uint8Array.from(value);
  if (!raw.length || raw.length > 1024 * 1024) throw new Error("固件文件为空或过大");
  const parsed = parseIntelHex(new TextDecoder().decode(raw), { min: N32_LAYOUT.appBase, max: N32_LAYOUT.appEnd + 1 });
  if (parsed.base !== N32_LAYOUT.appBase) throw new Error(`N32 HEX 基址须为 0x08002000，实际 ${"0x" + parsed.base.toString(16).toUpperCase()}`);
  const size = parsed.bytes.length;
  if (size < 0x40 || parsed.base + size - 1 > N32_LAYOUT.appEnd) throw new Error("N32 镜像长度为 0 或超出 APP 窗口（0x08002000~0x0800F7FF）");
  const dv = new DataView(parsed.bytes.buffer, parsed.bytes.byteOffset, parsed.bytes.byteLength);
  const sp = dv.getUint32(0, true), reset = dv.getUint32(4, true);
  if (sp <= 0x20000000 || sp > 0x20008000 || sp % 4) throw new Error("N32 向量表 SP 非法（不在 RAM 范围）");
  if (!(reset & 1) || reset - 1 < N32_LAYOUT.appBase || reset - 1 > N32_LAYOUT.appEnd) throw new Error("N32 复位向量不在 APP 窗口");
  return { ...parsed, name, target: "n32-app", crc: crc32(parsed.bytes), sp, reset, size };
}
