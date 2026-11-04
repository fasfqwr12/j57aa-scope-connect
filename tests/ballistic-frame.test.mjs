// 弹道板协议对齐测试：JS 侧字节必须与上位机 Python（core/scope_protocol.py + web_api.debug_api._build_proxy_packet）
// 逐字节一致。参考值由上位机同一组参数现场生成后固化，用来锁死「协议不通」这类回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBallisticQuery } from '../src/protocol/scope-protocol.js';
import { buildProxyFrame, PROXY_MODE, PROXY_FLAG_BALLISTIC_TRANSACTION } from '../src/upgrade/ota-protocol.js';

const hex = bytes => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join('');

const PARAMS = {
  bc: 0.48, angle_deg: 0, velocity_ms: 850, baseline_mm: 20, zero_range_m: 100,
  altitude_m: 200, temp_c: 25, humidity_pct: 50, pressure_pa: 101325,
  head_wind_ms: 0, cross_wind_ms: 0, model: 'G7', range_m: 300,
  focal_mm: 50, pixel_um: 12, det_w: 640, det_h: 480, disp_w: 1024, disp_h: 600
};

test('52 字节弹道查询帧与上位机 Python 输出一致', () => {
  const frame = buildBallisticQuery(PARAMS);
  assert.equal(frame.length, 52);
  assert.equal(hex(frame), 'FEFFFFFE2AE0015A00084C010014006400D0077D00F401CD8B0100FF7FFF7F07307500003200788002E00100045802BDEFFFFFEF');
});

test('弹道查询帧参数区 42 字节、校验为 SUM8', () => {
  const frame = Array.from(buildBallisticQuery(PARAMS));
  assert.equal(frame[4], 42);                                  // LEN
  const params = frame.slice(5, 5 + 42);
  assert.equal(frame[47], params.reduce((a, b) => a + b, 0) & 0xFF);
  assert.deepEqual(frame.slice(0, 4), [0xFE, 0xFF, 0xFF, 0xFE]);
  assert.deepEqual(frame.slice(48), [0xEF, 0xFF, 0xFF, 0xEF]);
});

test('GLPX 弹道事务 START(flags=0x04) 与上位机一致', () => {
  const frame = buildProxyFrame(PROXY_MODE.START, {
    session: 0x12345678, baud: 115200, idleMs: 2500, totalMs: 5000,
    flags: PROXY_FLAG_BALLISTIC_TRANSACTION
  });
  assert.equal(frame.length, 28);
  assert.equal(hex(frame), 'AA7E0016474C505801123456780001C200000009C400001388044D1E');
});

test('GLPX STOP 与上位机一致', () => {
  const frame = buildProxyFrame(PROXY_MODE.STOP, { session: 0x12345678, baud: 115200, idleMs: 2500, totalMs: 5000 });
  assert.equal(frame.length, 27);
  assert.equal(hex(frame), 'AA7E0015474C505802123456780001C200000009C4000013883B6A');
});

test('START 必须带 flags=4，否则是普通代理（弹道板不会响应）', () => {
  const plain = buildProxyFrame(PROXY_MODE.START, { session: 1, baud: 115200, idleMs: 2500, totalMs: 5000, flags: 0 });
  const ballistic = buildProxyFrame(PROXY_MODE.START, { session: 1, baud: 115200, idleMs: 2500, totalMs: 5000, flags: PROXY_FLAG_BALLISTIC_TRANSACTION });
  assert.equal(plain.length, 27);
  assert.equal(ballistic.length, 28);
  assert.equal(ballistic[ballistic.length - 3], 0x04);   // flags 紧邻 CRC 之前
});
