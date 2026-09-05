import test from 'node:test';
import assert from 'node:assert/strict';
import { WireDecoder } from '../src/upgrade/ota-protocol.js?v=status-first-1';
import { snapshotIsFresh } from '../src/upgrade/device-probe.js?v=status-first-1';
import { inspectFirmware } from '../src/upgrade/firmware-image.js?v=status-first-1';
import { WebBluetoothAdapter } from '../src/adapters/web-bluetooth.js';
import { buildFrame } from '../src/protocol/scope-protocol.js';
import { frame, syntheticFirmware, eventMirror, n32Info } from './fixtures.mjs';
import { WireChannel } from '../src/upgrade/ota-channel.js?v=status-first-1';

test('deadline stops later native GATT chunks and retains ownership until first settles', async () => {
  const adapter = new WebBluetoothAdapter({});
  adapter.connected = true; adapter.device = { gatt: { connected: true } };
  let finishNative, ioSignal, writes = 0;
  adapter.tx = { properties: { write: true }, writeValueWithResponse() { writes++; return new Promise(r => { finishNative = r; }); } };
  const channel = new WireChannel((bytes, options) => { ioSignal = options.signal; return adapter.writeRaw(bytes, options); });
  const pending = channel.request(new Uint8Array(60), { protocol: 'w515', cmd: 0x85, timeoutMs: 5 });
  pending.catch(() => {});
  await new Promise(resolve => ioSignal.addEventListener('abort', resolve, { once: true }));
  assert.equal(writes, 1); assert.ok(channel.active); assert.equal(adapter.writing, true);
  await assert.rejects(channel.request([1], { protocol: 'w515' }), /并发/);
  finishNative(); await assert.rejects(pending, /超时/);
  assert.equal(writes, 1); assert.equal(channel.active, null); assert.equal(adapter.writing, false);
});
test('early ACK cannot release request while native write is still active', async () => {
  let finishNative;
  const channel = new WireChannel(async () => {
    channel.receive(frame(0x81, [170, 85, 170, 85]));
    await new Promise(r => { finishNative = r; });
  });
  const pending = channel.request([1], { protocol: 'w515', cmd: 0x81, timeoutMs: 1000 });
  assert.equal(channel.pending, null); assert.ok(channel.active);
  await assert.rejects(channel.request([1], { protocol: 'w515' }), /并发/);
  channel.disconnect(); finishNative(); await assert.rejects(pending, /断开/);
});
test('proxy native write failure after ACK requires reconnect', async () => {
  const channel = new WireChannel(async () => {
    const body = [170, 126, 0, 5, 71, 76, 80, 88, 0];
    const { referenceCrc16 } = await import('./fixtures.mjs');
    const crc = referenceCrc16(body); channel.receive([...body, crc >>> 8, crc & 255]);
    throw new Error('native write failed');
  });
  await assert.rejects(channel.request([1], { protocol: 'proxy' }), /native write failed/);
  assert.equal(channel.proxyUncertain, true);
});
test('partial event ownership persists through idle and exclusive session boundaries', async () => {
  const adapter = new WebBluetoothAdapter({});
  adapter.connected = true; adapter.device = { gatt: { connected: true } }; adapter.writeRaw = async () => {};
  const notify = bytes => adapter.onNotify({ target: { value: new DataView(Uint8Array.from(bytes).buffer) } });
  const ack = frame(0xB1, n32Info('APP')), event = eventMirror(ack);
  const releaseFirst = adapter.beginExclusive('first'); notify(event.slice(0, 10)); releaseFirst();
  notify(event.slice(10, 17));
  const release = adapter.beginExclusive('second');
  const pending = adapter.requestWire([1], { protocol: 'n32', cmd: 0xB1, timeoutMs: 100 });
  notify(event.slice(17)); assert.ok(adapter.channel.pending);
  notify(ack); assert.equal((await pending).protocol, 'n32'); release();
});
test('normal readers cannot overwrite each other or overlap an exclusive session', async () => {
  const adapter = new WebBluetoothAdapter({});
  let finishRead; adapter.waitForFrame = () => new Promise(resolve => { finishRead = resolve; });
  adapter.write = async () => {};
  const first = adapter.requestFrame([1], 100);
  await assert.rejects(adapter.requestFrame([2], 100), /并发/);
  await assert.rejects(adapter.listenMeasurement(), /并发/);
  assert.throws(() => adapter.beginExclusive('probe'), /忙/);
  finishRead({ params: [] }); await first; assert.equal(adapter.normalRequests, 0);
});

test('partial GLPE ownership persists across request boundaries', async () => {
  const ack = frame(0xB1, n32Info('APP')), event = eventMirror(ack);
  const channel = new WireChannel(async () => {});
  channel.receive(event.slice(0, 17));
  const request = channel.request([1], { protocol: 'n32', cmd: 0xB1, timeoutMs: 100 });
  channel.receive(event.slice(17));
  assert.ok(channel.pending, 'mirror must not resolve the new request');
  channel.receive(ack);
  assert.equal((await request).protocol, 'n32');
});

test('business envelopes cannot expose embedded OTA replies at any split', () => {
  const ack = frame(0x81, [170, 85, 170, 85]);
  const scope = buildFrame([...ack, 0, 1, 2]);
  for (let split = 1; split < scope.length; split++) {
    const decoder = new WireDecoder();
    assert.equal(decoder.push(scope.slice(0, split)).length, 0);
    assert.equal(decoder.push(scope.slice(split)).length, 0);
    assert.equal(decoder.push(ack).length, 1);
  }
});
test('false incomplete reply header cannot swallow real handshake', () => {
  const ack = frame(0x81, [170, 85, 170, 85]);
  const decoder = new WireDecoder();
  const replies = decoder.push([170, 129, 4, 0, ...ack]);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].raw, ack);
});
test('normal business writes preserve whole frame without assuming reassembly', async () => {
  const adapter = new WebBluetoothAdapter({});
  let sent;
  adapter.writeRaw = async (bytes, options) => { sent = { bytes, options }; };
  await adapter.write(new Uint8Array(52));
  assert.equal(sent.options.chunkSize, 52);
  assert.equal(sent.options.withResponse, false);
  await assert.rejects(adapter.write(new Uint8Array(245)), /过长/);
});
test('reserved metadata CRC values are refused before erase', () => {
  for (const crc of [0, 0xFFFFFFFF]) {
    const bytes = syntheticFirmware();
    new DataView(bytes.buffer).setUint32(0x224, crc, true);
    assert.throws(() => inspectFirmware(bytes, 'APP.bin'), /保留值/);
  }
});
test('clock rollback invalidates snapshot rather than extending consent', () => {
  const snapshot = { deviceId: 'fake', generation: 1, checkedAt: 1000 };
  const adapter = { device: { id: 'fake' }, generation: 1, isGattConnected: () => true };
  assert.equal(snapshotIsFresh(snapshot, adapter, 999), false);
  assert.equal(snapshotIsFresh(snapshot, adapter, 1000), true);
});
