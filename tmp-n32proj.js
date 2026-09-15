const fs = require("fs");
const p = "E:/tof/qiangmiao/data/J57AACode_20260507/J57AACode_20260507/MCU_Slave/Keil_project/SP56622-Coaxial-N32G430.uvprojx";
const src = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const targets = [...src.matchAll(/<TargetName>([^<]+)<\/TargetName>/g)].map(m => m[1]);
console.log("Targets:", targets.join(" | "));
const defines = [...src.matchAll(/<Define>([^<]*)<\/Define>/g)].map(m => m[1]).filter(Boolean);
console.log("Defines:", defines.join(" ; "));
const sct = [...src.matchAll(/<ScatterFile>([^<]*)<\/ScatterFile>/g)].map(m => m[1]);
console.log("ScatterFile:", sct.join(" | ") || "(无-默认内存布局)");
const after = [...src.matchAll(/<UserProg[12]Name>([^<]*)<\/UserProg[12]Name>/g)].map(m => m[1]).filter(Boolean);
console.log("After Build:", after.join(" ; ") || "(无)");
const out = [...src.matchAll(/<OutputName>([^<]*)<\/OutputName>/g)].map(m => m[1]).filter(Boolean);
console.log("OutputName:", out.join(" | "));
const files = [...src.matchAll(/<FileName>([^<]+\.c)<\/FileName>/g)].map(m => m[1]);
console.log("源文件数:", files.length);
console.log("关键文件:", files.filter(f => /MiniModule|SystemConfig|main/.test(f)).join(", "));
// IROM 配置（起始地址）
const irom = [...src.matchAll(/<IROM>([^<]*)<\/IROM>/g)].map(m => m[1]);
console.log("IROM:", irom.join(" | "));
