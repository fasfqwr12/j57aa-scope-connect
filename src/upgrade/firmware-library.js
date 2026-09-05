import { crc32 } from "./ota-protocol.js?v=status-first-1";
// Resolve relative to this module, not the page: GitHub Pages runs under a project subpath.
export const firmwareDirectory = (moduleUrl = import.meta.url) => new URL("../../firmware/", moduleUrl);
export function firmwareUrl(entry, moduleUrl = import.meta.url) {
  if (entry.target !== "w515-app" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(bin|hex)$/i.test(entry.name) || entry.name.includes("..")) throw new Error("固件清单目标或路径不合法");
  return new URL(entry.name, firmwareDirectory(moduleUrl));
}
export async function verifyDownload(data, entry) {
  if (!Number.isSafeInteger(entry.size) || data.length !== entry.size) throw new Error("下载长度与清单不符");
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256 || "")) throw new Error("在线固件缺少 SHA-256，请先完善发布清单");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  if (sha !== entry.sha256.toLowerCase()) throw new Error("下载 SHA-256 与清单不符");
  if (entry.fileCrc32 && crc32(data) !== parseInt(entry.fileCrc32, 16)) throw new Error("下载整文件 CRC32 不符");
  return sha;
}
