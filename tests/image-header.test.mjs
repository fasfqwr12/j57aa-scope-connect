import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readImageMeta, j5aaPayloadCrc, buildJ5aaHeader, finalizeJ5aaImage, J5AA_HEADER_SIZE } from '../src/upgrade/image-header.js?v=j5aa-1';
import { inspectN32Firmware, inspectFirmware } from '../src/upgrade/firmware-image.js?v=j5aa-1';

// 合成 J5AA 镜像：头块之外填固定字节，SP/复位向量合法（仅为头解析测试，不做整像校验）
function syntheticJ5aa({ fwVersion = 0x0203, imageType = 0, target = 1, model = 'J57AA-N32' } = {}) {
  const before = new Uint8Array(0x200).fill(0x12);
  before[0] = 0x00; before[1] = 0x20; before[2] = 0x00; before[3] = 0x20;
  before[4] = 0x01; before[5] = 0x22;
  const hdr = buildJ5aaHeader({ imageType, target, fwVersion, hwVersion: 0x0100, payloadBase: 0x08002000, minBoot: 0x0106, model });
  return finalizeJ5aaImage(hdr, before, new Uint8Array(0x300).fill(0x34));
}

test('J5AA 头自述解析：magic/类型/目标/版本/型号/基址/大小/hcrc', () => {
  const image = syntheticJ5aa();
  const meta = readImageMeta(image);
  assert.equal(meta.format, 'j5aa');
  assert.equal(meta.headerSize, J5AA_HEADER_SIZE);
  assert.equal(meta.imageType, 'app');
  assert.equal(meta.target, 'n32');
  assert.equal(meta.fwVersion, 0x0203);
  assert.equal(meta.model, 'J57AA-N32');
  assert.equal(meta.minBoot, 0x0106);
  assert.equal(meta.payloadBase, 0x08002000);
  assert.equal(meta.appSize, image.length);   // payload_size = 整像含头
  assert.equal(meta.hcrcOk, true);
});

test('J5AA payload_crc 覆盖整像排除头块，且篡改可检出', () => {
  const image = syntheticJ5aa();
  assert.equal(j5aaPayloadCrc(image).ok, true);
  const bodyTampered = Uint8Array.from(image); bodyTampered[0x300] ^= 0xFF;
  assert.equal(j5aaPayloadCrc(bodyTampered).ok, false);
  const headerTampered = Uint8Array.from(image); headerTampered[0x200 + 8] ^= 0x01;
  assert.equal(readImageMeta(headerTampered).hcrcOk, false);   // hcrc 只盖头前 44B
});

test('J5AA magic 兼容反序拼写', () => {
  const image = syntheticJ5aa();
  image[0x200] = 0x4A; image[0x200 + 1] = 0x35; image[0x200 + 2] = 0x41; image[0x200 + 3] = 0x41;
  assert.equal(readImageMeta(image).format, 'j5aa');           // 4A 35 41 41（规范字节序）
});

test('真实 W515 bin 分发到 FIRM 旧格式，且校验事实源仍是 meta', () => {
  const bin = new Uint8Array(fs.readFileSync(new URL('../firmware/W515_APP_20260918.bin', import.meta.url)));
  const meta = readImageMeta(bin);
  assert.equal(meta.format, 'firm');
  assert.equal(meta.model, 'J57AA-W515');
  assert.equal(meta.appSize, bin.length);
  const insp = inspectFirmware(bin, 'W515_APP_20260918.bin');
  assert.equal(insp.header.format, 'firm');
  assert.equal(insp.header.appCrc, insp.meta.appCrc);
});

test('真实 N32 hex 分发到 N3MT 旧格式：展示口径与校验口径并存', () => {
  const hex = new TextEncoder().encode(fs.readFileSync(new URL('../firmware/N32-APP-v1.7.0-20260918.hex', import.meta.url), 'ascii'));
  const insp = inspectN32Firmware(hex, 'N32-APP-v1.7.0-20260918.hex');
  assert.equal(insp.header.format, 'n3mt');
  assert.equal(insp.header.fwVersion, 0x0107);
  assert.equal(insp.header.appSize, 34940);
  assert.equal(insp.header.appCrc, 0x3ED69120);               // meta 口径（0xFF 掩码）
  assert.equal(insp.crc, 0xD1BC2147);                          // 校验口径（整像 plain，Boot 现行）
  assert.notEqual(insp.crc, insp.header.appCrc);
});

test('无头固件回退为 null 且照常可解析', () => {
  const image = new Uint8Array(4096).fill(0xAA);
  // 合法向量表：SP=0x20001000、PC=0x08002101，其余填充 0xAA（无 N3MT 头）
  image.set([0x00, 0x10, 0x00, 0x20, 0x01, 0x21, 0x00, 0x08], 0);
  const base = 0x08002000;
  const rec = (bytes) => ':' + [...bytes, (0x100 - (bytes.reduce((a, b) => a + b, 0) & 0xFF)) & 0xFF]
    .map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('') + '\n';
  let hex = rec([0x02, 0x00, 0x00, 0x04, 0x08, 0x00]);
  for (let off = 0; off < image.length; off += 16) {
    const slice = image.subarray(off, off + 16);
    const abs = base + off;
    hex += rec([slice.length, (abs >> 8) & 0xFF, abs & 0xFF, 0x00, ...slice]);
  }
  hex += ':00000001FF\n';
  const insp = inspectN32Firmware(new TextEncoder().encode(hex), 'headerless.hex');
  assert.equal(insp.header, null);
  assert.equal(insp.target, 'n32-app');
  assert.ok(insp.size > 0);
});

test('边界：过短镜像与随机字节不误判', () => {
  assert.equal(readImageMeta(new Uint8Array(0x10)), null);
  assert.equal(readImageMeta(new Uint8Array(0x400).fill(0xAA)), null);
});
