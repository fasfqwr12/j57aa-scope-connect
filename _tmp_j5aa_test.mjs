// J5AA 统一镜像头解析测试：合成镜像 + 真实固件库文件三分发
import { readImageMeta, j5aaPayloadCrc, buildJ5aaHeader, finalizeJ5aaImage, J5AA_HEADER_SIZE } from "./src/upgrade/image-header.js?v=j5aa-1";
import { inspectN32Firmware, inspectFirmware } from "./src/upgrade/firmware-image.js?v=j5aa-1";
import { crc32 } from "./src/upgrade/ota-protocol.js?v=status-first-1";
import fs from "node:fs";

let fail = 0;
const ok = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!cond) fail++; };

// ---- 1) 合成 J5AA 镜像（N32 APP v2.3）----
{
  const before = new Uint8Array(0x200).fill(0x12);
  before[0] = 0x00; before[1] = 0x20; before[2] = 0x00; before[3] = 0x20; // 合法 SP
  before[4] = 0x01; before[5] = 0x22; // reset thumb
  const after = new Uint8Array(0x300).fill(0x34);
  const hdr = buildJ5aaHeader({ imageType: 0, target: 1, fwVersion: 0x0203, hwVersion: 0x0100, payloadBase: 0x08002000, minBoot: 0x0106, model: "J57AA-N32" });
  const image = finalizeJ5aaImage(hdr, before, after);
  const meta = readImageMeta(image);
  ok("j5aa magic+格式", meta?.format === "j5aa");
  ok("j5aa 自述类型=app", meta?.imageType === "app");
  ok("j5aa 自述目标=n32", meta?.target === "n32");
  ok("j5aa 版本 0x0203", meta?.fwVersion === 0x0203, `got 0x${(meta?.fwVersion||0).toString(16)}`);
  ok("j5aa 型号", meta?.model === "J57AA-N32");
  ok("j5aa min_boot=0x0106", meta?.minBoot === 0x0106);
  ok("j5aa payload_base=0x08002000", meta?.payloadBase === 0x08002000);
  ok("j5aa appSize=整像", meta?.appSize === image.length, `${meta?.appSize} vs ${image.length}`);
  ok("j5aa hcrc ✓", meta?.hcrcOk === true);
  const pc = j5aaPayloadCrc(image);
  ok("j5aa payload_crc ✓", pc?.ok === true, `crc=0x${(pc?.crc||0).toString(16).toUpperCase()}`);
  // 幂等：重跑 finalize 值不变（同输入本来就同输出）；篡改一个 payload 字节必须能检出
  const bad = Uint8Array.from(image); bad[0x300] ^= 0xFF;
  ok("j5aa 篡改可检出", j5aaPayloadCrc(bad)?.ok === false);
  const badHdr = Uint8Array.from(image); badHdr[0x200 + 8] ^= 0x01; // 改 fw_version → hcrc 失配
  ok("j5aa 头篡改可检出(hcrc)", readImageMeta(badHdr)?.hcrcOk === false);
}

// ---- 2) 真实 W515 bin → FIRM 分发 ----
{
  const bin = new Uint8Array(fs.readFileSync("firmware/W515_APP_v0.1.0_0916.bin"));
  const meta = readImageMeta(bin);
  ok("w515 magic=FIRM", meta?.format === "firm");
  ok("w515 型号 J57AA-W515", meta?.model === "J57AA-W515");
  ok("w515 appSize=64152", meta?.appSize === 64152, `${meta?.appSize}`);
  const insp = inspectFirmware(bin, "W515_APP_v0.1.0_0916.bin");
  ok("w515 inspect 附加 header", insp.header?.format === "firm" && insp.header?.appCrc === insp.meta.appCrc);
  ok("w515 inspect 校验仍通过(meta)", insp.meta.appSize === bin.length);
}

// ---- 3) 真实 N32 v1.6 hex → N3MT 分发 ----
{
  const hex = new TextEncoder().encode(fs.readFileSync("firmware/N32-APP-v1.6.0-20260916.hex", "ascii"));
  const insp = inspectN32Firmware(hex, "N32-APP-v1.6.0-20260916.hex");
  ok("n32 inspect 附加 header=n3mt", insp.header?.format === "n3mt");
  ok("n32 header 版本 0x0106", insp.header?.fwVersion === 0x0106, `0x${(insp.header?.fwVersion||0).toString(16)}`);
  ok("n32 header appCrc=meta口径", insp.header?.appCrc === 0x3ED69120, `0x${(insp.header?.appCrc||0).toString(16).toUpperCase()}`);
  ok("n32 校验 crc 仍=plain口径", insp.crc === 0xD1BC2147, `0x${(insp.crc||0).toString(16).toUpperCase()}`);
}

// ---- 4) 旧 N32 hex（无任何头）→ null 回退 ----
{
  const hex = new TextEncoder().encode(fs.readFileSync("firmware/N32-APP-v01p2-20260728.hex", "ascii"));
  const insp = inspectN32Firmware(hex, "N32-APP-v01p2-20260728.hex");
  ok("旧n32 header=null 回退", insp.header === null);
  ok("旧n32 inspect 照常成功", insp.target === "n32-app" && insp.size > 0);
}

// ---- 5) 边界：太短/随机字节 ----
{
  ok("短镜像 null", readImageMeta(new Uint8Array(0x10)) === null);
  ok("随机无magic null", readImageMeta(new Uint8Array(0x400).fill(0xAA)) === null);
}

process.exit(fail ? 1 : 0);
