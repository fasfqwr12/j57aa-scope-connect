// J57AA 统一镜像头解析（规范见 docs/IMAGE_HEADER_SPEC.md）。
// 设计：所有 J57AA 镜像（W515/N32 × APP/Boot）的信息块固定在 image+0x200，按 magic 自分发：
//   "J5AA" 新统一头 v1（48B，自述类型/目标/版本/大小/CRC，双 CRC 口径见规范）
//   "FIRM" W515 旧元数据（40B，Boot 三连校验事实源，保留不动）
//   "N3MT" N32 旧元数据（32B，0x3A 上报事实源，保留不动）
// 上位机只读不算：三个格式归一化成同一个 meta 对象；扫不到 magic 返回 null 走回退。
// 本模块零依赖（纯函数），避免牵动 ota-protocol 导入链。

const META_OFFSET = 0x200;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function ascii(bytes, start, len) {
  let out = "";
  for (let i = start; i < start + len && bytes[i] !== 0; i++) out += String.fromCharCode(bytes[i]);
  return out.replace(/[^\x20-\x7E]/g, "");
}

// J5AA v1（48B @0x200）：hcrc=头前44B的CRC32；payload_crc=整像排除头块的CRC32（幂等）
export const J5AA_HEADER_SIZE = 0x30;
export function buildJ5aaHeader({ headerVer = 1, imageType = 0, target = 1, fwVersion = 0, hwVersion = 0x100, payloadBase = 0x08002000, minBoot = 0, flags = 1, model = "J57AA-N32" } = {}) {
  const h = new Uint8Array(J5AA_HEADER_SIZE).fill(0xFF);
  h[0] = 0x4A; h[1] = 0x35; h[2] = 0x41; h[3] = 0x41;              // "J5AA"
  const dv = new DataView(h.buffer);
  dv.setUint16(4, headerVer, true);
  h[6] = imageType; h[7] = target;
  dv.setUint16(8, fwVersion, true);
  dv.setUint16(0x0A, hwVersion, true);
  dv.setUint32(0x14, payloadBase, true);
  dv.setUint32(0x18, flags, true);
  dv.setUint16(0x1C, minBoot, true);
  for (let i = 0; i < 12 && i < model.length; i++) h[0x20 + i] = model.charCodeAt(i);
  return h; // size/payloadCrc/hcrc 由 finalizeJ5aaImage 按整像回填
}
// 组装完整 J5AA 镜像（构建/测试用）：payload 为不含头的镜像字节（前 0x200 字节 + 头后数据）
export function finalizeJ5aaImage(header, payloadBefore, payloadAfter = new Uint8Array(0)) {
  const size = 0x200 + J5AA_HEADER_SIZE + payloadAfter.length;
  const image = new Uint8Array(size);
  image.set(payloadBefore, 0);
  image.set(header, 0x200);
  image.set(payloadAfter, 0x200 + J5AA_HEADER_SIZE);
  const dv = new DataView(image.buffer);
  dv.setUint32(0x200 + 0x0C, size, true);                            // payload_size=整像含头
  // payload_crc：整像排除头块 [0x200,0x230)
  const parts = [image.subarray(0, 0x200), image.subarray(0x230)];
  let c = 0xFFFFFFFF;
  for (const p of parts) for (const b of p) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  dv.setUint32(0x200 + 0x10, (c ^ 0xFFFFFFFF) >>> 0, true);
  // hcrc：头前 44B（hcrc 字段自身不参与）
  dv.setUint32(0x200 + 0x2C, crc32(image, 0x200, 0x200 + 0x2C), true);
  return image;
}

// 统一入口：读 image+0x200 的 magic，按格式归一化；无任何已知 magic → null（走回退）
export function readImageMeta(image) {
  try {
    if (!(image instanceof Uint8Array) || image.length < META_OFFSET + 0x28) return null;
    const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const m0 = image[META_OFFSET], m1 = image[META_OFFSET + 1], m2 = image[META_OFFSET + 2], m3 = image[META_OFFSET + 3];
    if (m0 === 0x4A && m1 === 0x35 && m2 === 0x41 && m3 === 0x41) {           // "J5AA"
      if (image.length < META_OFFSET + J5AA_HEADER_SIZE) return null;
      const h = image.subarray(META_OFFSET, META_OFFSET + J5AA_HEADER_SIZE);
      const hdv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      const hcrcOk = crc32(h, 0, 0x2C) === hdv.getUint32(0x2C, true);
      return {
        format: "j5aa", headerSize: J5AA_HEADER_SIZE, hcrcOk,
        headerVer: hdv.getUint16(4, true),
        imageType: h[6] === 0 ? "app" : h[6] === 1 ? "boot" : h[6],   // 自我介绍：我是谁
        target: h[7] === 0 ? "w515" : h[7] === 1 ? "n32" : h[7],       // 我属于哪块板
        fwVersion: hdv.getUint16(8, true),
        hwVersion: hdv.getUint16(0x0A, true),
        appSize: hdv.getUint32(0x0C, true),
        appCrc: hdv.getUint32(0x10, true),
        payloadBase: hdv.getUint32(0x14, true),
        flags: hdv.getUint32(0x18, true),
        minBoot: hdv.getUint16(0x1C, true),
        model: ascii(h, 0x20, 12),
      };
    }
    if (m0 === 0x46 && m1 === 0x49 && m2 === 0x52 && m3 === 0x4D) {           // "FIRM"（W515 旧，Boot 三连事实源）
      return {
        format: "firm", headerSize: 0x28, hcrcOk: null,
        fwVersion: dv.getUint32(META_OFFSET + 4, true),
        hwVersion: dv.getUint32(META_OFFSET + 8, true),
        appSize: dv.getUint32(META_OFFSET + 0x20, true),
        appCrc: dv.getUint32(META_OFFSET + 0x24, true),
        model: ascii(image, META_OFFSET + 0x10, 16),
      };
    }
    if (m0 === 0x4E && m1 === 0x33 && m2 === 0x4D && m3 === 0x54) {           // "N3MT"（N32 旧，0x3A 上报事实源）
      return {
        format: "n3mt", headerSize: 0x20, hcrcOk: null,
        fwVersion: dv.getUint16(META_OFFSET + 4, true),
        hwVersion: dv.getUint32(META_OFFSET + 0x10, true),
        appSize: dv.getUint32(META_OFFSET + 8, true),
        appCrc: dv.getUint32(META_OFFSET + 0x0C, true),
        model: ascii(image, META_OFFSET + 0x14, 12),
      };
    }
    return null;
  } catch { return null; }
}

// J5AA 整像校验（排除头块口径），供发布/下载后完整性核对
export function j5aaPayloadCrc(image) {
  const meta = readImageMeta(image);
  if (meta?.format !== "j5aa") return null;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < image.length; i++) {
    if (i >= 0x200 && i < 0x230) continue;
    c = CRC_TABLE[(c ^ image[i]) & 255] ^ (c >>> 8);
  }
  return { ok: ((c ^ 0xFFFFFFFF) >>> 0) === meta.appCrc, crc: (c ^ 0xFFFFFFFF) >>> 0, expect: meta.appCrc };
}
