import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as codec from '../src/upgrade/ota-protocol.js?v=status-first-1';
import { WireChannel } from '../src/upgrade/ota-channel.js?v=status-first-1';
import { DeviceProbe, snapshotIsFresh, w515Gate } from '../src/upgrade/device-probe.js?v=status-first-1';
import { inspectFirmware, validateFirmwareForDevice, parseIntelHex } from '../src/upgrade/firmware-image.js?v=status-first-1';
import { firmwareUrl, verifyDownload } from '../src/upgrade/firmware-library.js?v=status-first-1';
import { W515OtaSession } from '../src/upgrade/w515-ota.js?v=status-first-1';
import { WebBluetoothAdapter } from '../src/adapters/web-bluetooth.js';
import { frame, proxyResponse, eventMirror, makeInfo, f7Response, n32Info, syntheticFirmware, intelHex, hexRecord, referenceCrc16, referenceCrc32, FakeAdapter } from './fixtures.mjs';
const text = s => new TextEncoder().encode(s);
const fw = () => inspectFirmware(syntheticFirmware(), 'W515_APP_test.bin');
const info = () => codec.parseBootInfo(makeInfo());
const commands = a => a.commands.map(c => c.cmd);
const run = (a, extra = {}, hooks = {}) => new W515OtaSession(a, { delay: async () => {}, ...hooks }).run(fw(), { confirmed: true, expectedDeviceId: a.device.id, ...extra });
const probe = a => new DeviceProbe(a, { sessionId: 123 }).run();
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('independent CRC known vectors and W515 handshake', () => {
  assert.equal(codec.crc16Modbus(text('123456789')), 0x4B37);
  assert.equal(codec.crc32(text('123456789')), 0xCBF43926);
  assert.equal(codec.crc16Modbus(text('123456789')), referenceCrc16(text('123456789')));
  assert.equal(codec.toHex(codec.buildOtaFrame(1, [0x12, 0x34, 0x56, 0x78])), 'AA01000412345678348155');
  assert.equal(codec.parseW515Mode([170, 85, 170, 85]), 'APP');
  assert.equal(codec.parseW515Mode([135, 101, 67, 33]), 'BOOT');
  assert.equal(codec.parseW515Mode([0, 135, 101, 67, 33]), 'UNKNOWN');
});
test('GLPX all operations use full parameter block, CRC and no response mode', () => {
  for (const mode of [1, 2, 3, 4]) {
    const b = codec.buildProxyFrame(mode, { session: 123 });
    assert.equal(b.length, 27); assert.equal(b[8], mode);
    assert.equal(referenceCrc16(b.slice(0, -2)), b.at(-2) * 256 + b.at(-1));
  }
  assert.equal(codec.buildProxyFrame(1, { flags: 2 }).length, 28);
  assert.throws(() => codec.buildProxyFrame(1, { flags: 10 }), /Conflicting/);
  const parsed = codec.scanProxyResponse(proxyResponse(5));
  assert.equal(parsed.status, 5); assert.equal(parsed.mode, undefined);
});
test('F7, W515, N32 and GLPX survive every two-piece notification split', () => {
  for (const wire of [f7Response(), frame(0x81, [170, 85, 170, 85]), frame(0xB1, n32Info('APP')), proxyResponse(0)]) {
    for (let split = 1; split < wire.length; split++) {
      const d = new codec.WireDecoder();
      assert.equal(d.push(wire.slice(0, split)).length, 0);
      const found = d.push(wire.slice(split)); assert.equal(found.length, 1); assert.deepEqual(found[0].raw, wire);
    }
  }
});
test('F7 length/checksum/tail and boot information bounds are strict', () => {
  assert.equal(codec.scanF7Response(f7Response()).app_start, 0x08008000);
  for (const index of [3, 52, 53, 54]) { const b = f7Response(); b[index] ^= 1; assert.equal(codec.scanF7Response(b), null); }
  assert.equal(codec.parseBootInfo(new Uint8Array(47)), null);
  assert.equal(codec.parseBootInfo(new Uint8Array(49)), null);
  assert.equal(codec.parseBootInfo([...makeInfo()]).model, 'J57AA-W515');
});
test('GLPE mirror never becomes an N32 response, even split or with invalid CRC', () => {
  const ack = frame(0xB1, n32Info('APP'));
  for (const corrupt of [false, true]) {
    const event = eventMirror(ack); if (corrupt) event[event.length - 1] ^= 1;
    for (let split = 1; split < event.length; split++) {
      const d = new codec.WireDecoder();
      const out = [...d.push(event.slice(0, split)), ...d.push(event.slice(split))];
      assert.equal(out.filter(f => f.protocol === 'n32').length, 0);
      assert.equal(d.push(ack).filter(f => f.protocol === 'n32').length, 1);
    }
  }
});
test('noise, oversized headers, bad CRC and bad EOF cannot produce a reply', () => {
  const ok = frame(0x81, [170, 85, 170, 85]), bad = ok.slice(); bad[bad.length - 1] = 0;
  const d = new codec.WireDecoder();
  assert.equal(d.push([1, 2, 3, 170, 129, 255, 255, ...bad, ...ok]).length, 1);
  const badCrc = ok.slice(); badCrc[badCrc.length - 3] ^= 1;
  assert.equal(new codec.WireDecoder().push(badCrc).length, 0);
  const bounded = new codec.WireDecoder(); bounded.push(new Uint8Array(100000)); assert.ok(bounded.buffer.length <= 32768);
});
test('N32 status prefix and APP/Boot payload shapes are independently decoded', () => {
  const app = codec.parseN32Info(n32Info('APP'));
  assert.equal(app.mode, 'APP'); assert.equal(app.appVersion, 0x106); assert.equal(app.uartRxBytes, 1234); assert.equal(app.heartbeat, 77); assert.equal(app.appValid, null);
  for (const valid of [true, false]) { const b = codec.parseN32Info(n32Info('BOOT', valid)); assert.equal(b.mode, 'BOOT'); assert.equal(b.appValid, valid); assert.equal(b.pageSize, 2048); }
  for (const p of [[], [0], n32Info('APP').slice(1), [1, ...n32Info('BOOT').slice(1)]]) assert.equal(codec.parseN32Info(p).mode, 'UNKNOWN');
});
test('GET_STATUS never reads truncated fields or invents verification success', () => {
  for (let len = 0; len < 49; len++) assert.doesNotThrow(() => codec.parseOtaStatus(new Uint8Array(len)));
  assert.equal(codec.parseOtaStatus(new Uint8Array(4)), null);
  assert.equal(codec.parseOtaStatus(new Uint8Array(5)).calculated_crc, null);
  assert.equal(codec.parseOtaStatus(new Uint8Array(9)).verify_result, null);
});
test('firmware metadata CRC, target, vector, hardware and erase bounds gate writes', () => {
  const image = fw();
  assert.equal(validateFirmwareForDevice(image, info()).eraseSize, 4096);
  assert.equal(codec.crc32(image.bytes), referenceCrc32(image.bytes));
  const corrupt = image.bytes.slice(); corrupt[400] ^= 1; assert.throws(() => inspectFirmware(corrupt, 'APP.bin'), /CRC32/);
  for (const name of ['N32_APP.bin', 'W515_BOOT.bin', 'W515_IAP.hex', 'APP.enc']) assert.throws(() => inspectFirmware(image.bytes, name));
  assert.throws(() => inspectFirmware(new Uint8Array(100), 'APP.bin'), /元数据/);
  assert.throws(() => validateFirmwareForDevice(image, { ...info(), hw_ver: 2 }), /硬件/);
  assert.throws(() => validateFirmwareForDevice(image, { ...info(), app_start: 0x08004000 }), /窗口/);
  assert.throws(() => validateFirmwareForDevice(image, { ...info(), app_max_size: 1024 }), /擦除区/);
  assert.throws(() => validateFirmwareForDevice(inspectFirmware(syntheticFirmware(624, 0x08004000), 'APP.bin'), info()), /复位入口/);
});
test('Intel HEX checksum, overlap, address preservation, EOF and unsupported records', () => {
  const b = syntheticFirmware(), hx = intelHex(b);
  const image = inspectFirmware(text(hx), 'W515_APP.hex');
  assert.deepEqual(image.bytes, b); assert.equal(image.base, 0x08008000); validateFirmwareForDevice(image, info());
  assert.throws(() => parseIntelHex(hx.replace(/.$/, '1')), /校验和/);
  assert.throws(() => parseIntelHex(hx + '\n' + hexRecord(1)), /EOF/);
  assert.throws(() => parseIntelHex(hx.split('\n').slice(0, -1).join('\n')), /EOF/);
  assert.throws(() => parseIntelHex([hexRecord(4, 0, [8, 0]), hexRecord(0, 0, [1]), hexRecord(1)].join('\n')), /越界/);
  assert.throws(() => parseIntelHex([hexRecord(4, 0, [8, 0]), hexRecord(0, 0x8000, [1, 2]), hexRecord(0, 0x8001, [2]), hexRecord(1)].join('\n')), /重叠/);
  assert.throws(() => parseIntelHex(hexRecord(9)), /类型/);
});
test('Pages project subpath and online firmware full-file hashes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../firmware/versions.json', import.meta.url), 'utf8'));
  const entry = manifest.files[0], bytes = new Uint8Array(await readFile(new URL('../firmware/' + entry.name, import.meta.url)));
  assert.equal(firmwareUrl(entry, 'https://example.org/j57aa/src/upgrade/firmware-library.js').href, 'https://example.org/j57aa/firmware/' + entry.name);
  await verifyDownload(bytes, entry); inspectFirmware(bytes, entry.name);
  for (const name of ['../secret.bin', 'https://evil/file.bin', 'a/../b.bin', '..bin']) assert.throws(() => firmwareUrl({ ...entry, name }));
  await assert.rejects(verifyDownload(bytes.slice(1), entry), /长度/);
  await assert.rejects(verifyDownload(bytes, { ...entry, sha256: '0'.repeat(64) }), /SHA-256/);
});
for (const main of ['APP', 'BOOT', 'UNKNOWN']) for (const slave of ['APP', 'BOOT', 'UNKNOWN']) {
  test(`non-flashing dual-board probe ${main}/${slave}`, async () => {
    const a = new FakeAdapter({ main, slave }), s = await probe(a);
    assert.equal(s.main.mode, main);
    assert.equal(s.slave.mode, main === 'BOOT' ? 'UNREACHABLE' : main === 'UNKNOWN' ? 'UNKNOWN' : slave);
    assert.equal(s.routeClear, main !== 'UNKNOWN');
    assert.ok(commands(a).every(c => [0xEE, 1, 2, 0x7E, 0x31].includes(c)));
    assert.equal(a.exclusive, null);
    if (main !== 'APP') assert.ok(!commands(a).includes(0x31));
    for (const cmd of a.commands.filter(c => c.cmd === 0x7E && c.data[8] === 2)) assert.deepEqual(cmd.data.slice(9, 13), [0, 0, 0, 123]);
  });
}
test('N32 Boot validity only comes from its own vector-check field', async () => {
  for (const appValid of [true, false]) {
    const s = await probe(new FakeAdapter({ slave: 'BOOT', appValid })); assert.equal(s.slave.appValid, appValid);
  }
});
test('F7 is optional information, never a substitute for handshake mode', async () => {
  assert.equal((await probe(new FakeAdapter({ noF7: true }))).main.mode, 'APP');
  const s = await probe(new FakeAdapter({ main: 'UNKNOWN' })); assert.ok(s.main.info); assert.ok(w515Gate(s));
});
test('occupied or unreleased proxy cannot authorize OTA', async () => {
  const busy = new FakeAdapter({ busy: true }), s = await probe(busy);
  assert.equal(s.routeClear, false); assert.equal(busy.owner, 99); assert.ok(!commands(busy).includes(0x31));
  assert.equal(busy.commands.filter(c => c.cmd === 0x7E).length, 1);
  const failed = await probe(new FakeAdapter({ stopFails: true })); assert.equal(failed.routeClear, false); assert.ok(w515Gate(failed));
});
test('lost GLPX acknowledgement taints channel until real reconnect', async () => {
  const a = new FakeAdapter({ proxyTimeout: 1 }), s = await probe(a);
  assert.equal(s.routeClear, false); assert.equal(a.channel.proxyUncertain, true);
  await assert.rejects(a.requestWire(codec.buildProxyFrame(3), { protocol: 'proxy' }), /重连/);
  delete a.o.proxyTimeout; await a.reconnect(); assert.equal(a.channel.proxyUncertain, false);
});
test('cancelled N32 query cleans up only the owned proxy', async () => {
  const controller = new AbortController();
  const a = new FakeAdapter({ onCommand: cmd => { if (cmd === 0x31) controller.abort(); } });
  await assert.rejects(new DeviceProbe(a, { sessionId: 123, signal: controller.signal }).run(), { name: 'AbortError' });
  assert.equal(a.owner, 0); assert.equal(a.exclusive, null); assert.ok(!commands(a).includes(0x38));
});
test('snapshots expire and invalidate on device swap, disconnect or generation change', async () => {
  const a = new FakeAdapter(), s = await probe(a);
  assert.equal(snapshotIsFresh(s, a, s.checkedAt + 59999), true);
  assert.equal(snapshotIsFresh(s, a, s.checkedAt + 60000), false);
  a.generation++; assert.equal(snapshotIsFresh(s, a), false); a.generation--;
  a.device.id = 'other'; assert.equal(snapshotIsFresh(s, a), false);
});
test('wire matching ignores unrelated protocol/cmd and refuses concurrent requests', async () => {
  const ch = new WireChannel(async () => {});
  const first = ch.request([1], { protocol: 'w515', cmd: 0x81, timeoutMs: 100 });
  await assert.rejects(ch.request([2], { protocol: 'n32' }), /并发/);
  ch.receive(proxyResponse(0)); ch.receive(frame(0xB1, n32Info('APP'))); ch.receive(frame(0x82, makeInfo()));
  assert.ok(ch.pending); ch.receive(frame(0x81, [170, 85, 170, 85])); assert.equal((await first).cmd, 0x81);
});
test('disconnect, timeout and write failure reject instead of fake ACK success', async () => {
  const ch = new WireChannel(async () => {}), p = ch.request([1], { protocol: 'w515', timeoutMs: 100 });
  ch.disconnect(); await assert.rejects(p, /断开/);
  await assert.rejects(ch.request([1], { protocol: 'w515', timeoutMs: 5 }), /超时/);
  const broken = new WireChannel(async () => { broken.receive(frame(0x81, [170, 85, 170, 85])); throw new Error('GATT failed'); });
  await assert.rejects(broken.request([1], { protocol: 'w515', cmd: 0x81 }), /GATT failed/);
});
test('timeout does not release exclusive session before an in-flight write settles', async () => {
  let finishWrite; const ch = new WireChannel(() => new Promise(r => { finishWrite = r; }));
  let settled = false;
  const request = ch.request([1], { protocol: 'w515', timeoutMs: 5 }).finally(() => { settled = true; });
  request.catch(() => {}); await sleep(10); assert.equal(settled, false); finishWrite(); await assert.rejects(request, /超时/);
});
test('actual BLE adapter exclusivity blocks normal operations', async () => {
  const a = new WebBluetoothAdapter({}); a.connected = true; a.device = { gatt: { connected: true } };
  const release = a.beginExclusive('test');
  await assert.rejects(a.write([1]), /独占/); await assert.rejects(a.listenMeasurement(), /独占/);
  assert.throws(() => a.beginExclusive('other'), /忙/); release(); assert.equal(a.exclusive, null);
});
test('BLE reconnect reacquires RX/TX and resubscribes notifications', async () => {
  let notifications = 0, lookups = 0;
  const rx = { addEventListener() {}, removeEventListener() {}, async startNotifications() { notifications++; } };
  const tx = { properties: { write: true } };
  const service = { async getCharacteristic(id) { lookups++; return id.includes('fff1') ? rx : tx; } };
  const a = new WebBluetoothAdapter({ serviceUuid: 'fff0', rxUuid: 'fff1', txUuid: 'fff2' });
  a.device = { gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryService: async () => service }; }, disconnect() { this.connected = false; } } };
  await a.reconnect(); a.device.gatt.connected = false; a.disconnectHandler(); await a.reconnect();
  assert.equal(notifications, 2); assert.equal(lookups, 4); assert.equal(a.tx, tx);
});
test('upgrade requires explicit consent and rechecks both boards before erase', async () => {
  const noConsent = new FakeAdapter(); await assert.rejects(new W515OtaSession(noConsent).run(fw()), /确认/); assert.equal(noConsent.commands.length, 0);
  const a = new FakeAdapter(); const result = await run(a);
  assert.equal(result.success, true); assert.equal(result.appConfirmed, true); assert.equal(a.eraseSize, 4096);
  const cmds = commands(a); assert.ok(cmds.indexOf(0x31) < cmds.indexOf(4));
  assert.ok(!cmds.slice(cmds.indexOf(6) + 1, cmds.indexOf(7)).includes(1));
  assert.equal(a.written, fw().bytes.length); assert.equal(a.exclusive, null);
});
test('main Boot recovery needs explicit acknowledgment of unreachable slave', async () => {
  const a = new FakeAdapter({ main: 'BOOT' }); await assert.rejects(run(a), /副板未确认/); assert.ok(!commands(a).includes(4));
  assert.equal((await run(new FakeAdapter({ main: 'BOOT' }), { acknowledgeSlaveUnknown: true })).success, true);
});
test('unknown slave never silently authorizes main upgrade', async () => {
  const a = new FakeAdapter({ slave: 'UNKNOWN' }); await assert.rejects(run(a), /副板未确认/); assert.ok(!commands(a).includes(4));
});
for (const fault of ['wrongBootWindow', 'lostWriteAck', 'writeError', 'badCount', 'verifyFail', 'badDiag']) {
  test(`upgrade fail-closed: ${fault}`, async () => {
    const a = new FakeAdapter({ [fault]: true }); await assert.rejects(run(a));
    assert.ok(!commands(a).includes(7)); assert.equal(a.exclusive, null);
    assert.ok(commands(a).filter(c => c === 4).length <= 1);
    if (fault === 'lostWriteAck') assert.equal(commands(a).filter(c => c === 5).length, 1);
    if (fault === 'wrongBootWindow') assert.ok(!commands(a).includes(4));
  });
}
test('APP no-response is failure even after successful verify/reset', async () => {
  const a = new FakeAdapter({ noApp: true }); await assert.rejects(run(a), /APP 运行模式未确认/);
  assert.equal(commands(a).filter(c => c === 7).length, 1); assert.equal(a.exclusive, null);
});
test('abort after first write never verifies or resets or retries', async () => {
  const a = new FakeAdapter(); let session;
  a.o.onCommand = cmd => { if (cmd === 5) session.abort(); };
  session = new W515OtaSession(a, { delay: async () => {} });
  await assert.rejects(session.run(fw(), { confirmed: true }), { name: 'AbortError' });
  assert.equal(commands(a).filter(c => c === 5).length, 1); assert.ok(!commands(a).includes(6)); assert.ok(!commands(a).includes(7));
});
