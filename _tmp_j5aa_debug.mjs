import fs from "node:fs";
import { parseIntelHex } from "./src/upgrade/firmware-image.js?v=j5aa-1";

const bin = new Uint8Array(fs.readFileSync("firmware/W515_APP_v0.1.0_0916.bin"));
console.log("W515 bin @0x200:", Array.from(bin.slice(0x200, 0x228)).map(b => b.toString(16).padStart(2, "0")).join(" "));
console.log("W515 bin @0x1F0:", Array.from(bin.slice(0x1F0, 0x200)).map(b => b.toString(16).padStart(2, "0")).join(" "));

const hexText = fs.readFileSync("firmware/N32-APP-v1.6.0-20260916.hex", "ascii");
const p = parseIntelHex(hexText, { min: 0x08002000, max: 0x0800F800 });
console.log("N32 v1.6 hex base=0x" + p.base.toString(16), "size=" + p.bytes.length);
console.log("N32 @0x200:", Array.from(p.bytes.slice(0x200, 0x228)).map(b => b.toString(16).padStart(2, "0")).join(" "));
// 找 N3MT magic 4E 33 4D 54 出现的位置
for (let i = 0; i + 4 <= p.bytes.length; i++) {
  if (p.bytes[i] === 0x4E && p.bytes[i+1] === 0x33 && p.bytes[i+2] === 0x4D && p.bytes[i+3] === 0x54) console.log("N3MT magic @image+0x" + i.toString(16));
}
