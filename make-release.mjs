#!/usr/bin/env node
// 发布清单生成器：读固件文件 → 自动算 size/SHA-256/CRC32 + 读 W515 内嵌元数据版本
// 用法: node make-release.mjs <固件文件> [固件文件2 ...] [--date 2026-08-28] [--notes "说明"] [--recommended]
// 生成条目打印到 stdout；--write 直接合并进 firmware/versions.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith("--"));
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

const crc32Of = bytes => {
  const table = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
// W515 元数据布局同 ota-protocol.js readFirmwareMeta（偏移 0x204 版本）
const readW515Meta = bytes => {
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 0x228) return null;
  const ascii = (s, e) => String.fromCharCode(...b.slice(s, e)).replace(/\0.*$/, "");
  return {
    version: dv.getUint32(0x204, true),
    hwVersion: dv.getUint32(0x208, true),
    model: ascii(0x210, 0x220),
    appSize: dv.getUint32(0x220, true),
    appCrc: dv.getUint32(0x224, true)
  };
};
// FW_VERSION_PACK: (major<<24)|(minor<<16)|(patch<<8)|build —— 取 major.minor（对齐 F7 sw_ver 口径）
const verText = v => v == null || v === 0 ? null : `${v >>> 24}.${(v >>> 16) & 255}`;

if (!files.length) {
  console.error("用法: node make-release.mjs <固件文件...> [--date YYYY-MM-DD] [--notes 文案] [--recommended] [--write]");
  process.exit(1);
}
const entries = [];
for (const f of files) {
  const raw = new Uint8Array(readFileSync(f));
  const name = basename(f);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const isHex = /\.hex$/i.test(name);
  const isN32 = /N32/i.test(name);
  const meta = (!isHex && !isN32) ? readW515Meta(raw) : null;
  const fileNameVer = isHex ? (name.match(/v0*(\d+)[p.]?0*(\d+)/i)?.slice(1).map(Number).join(".") ?? null) : null;
  const version = verText(meta?.version) ?? fileNameVer ?? "0.0.0";
  if (!isHex && !isN32 && !meta) console.warn(`⚠️ ${name}: 读不到 W515 元数据（偏移0x204），版本填 0.0.0`);
  entries.push({
    name,
    target: isN32 ? "n32-app" : "w515-app",
    version,
    date: opt("date", new Date().toISOString().slice(0, 10)),
    size: raw.length,
    sha256,
    fileCrc32: crc32Of(raw).toString(16).toUpperCase().padStart(8, "0"),
    ...(meta ? { metaCrc32: meta.appCrc.toString(16).toUpperCase().padStart(8, "0") } : {}),
    notes: opt("notes", meta ? `版本 v${version}（bin 内嵌元数据识别）` : isN32 ? `副板 N32 APP v${version}` : "—"),
    recommended: flag("recommended")
  });
}
console.log(JSON.stringify(entries, null, 2));
if (flag("write")) {
  const listPath = resolve(root, "firmware/versions.json");
  const list = JSON.parse(readFileSync(listPath, "utf8"));
  for (const e of entries) {
    const i = list.files.findIndex(x => x.name === e.name);
    if (i >= 0) { list.files[i] = e; console.log(`更新条目: ${e.name}`); }
    else { list.files.push(e); console.log(`新增条目: ${e.name}`); }
  }
  writeFileSync(listPath, JSON.stringify(list, null, 2) + "\n", "utf8");
  console.log(`已写入 firmware/versions.json`);
}
