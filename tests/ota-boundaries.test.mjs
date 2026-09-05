import test from 'node:test';
import assert from 'node:assert/strict';
import { WireDecoder } from '../src/upgrade/ota-protocol.js?v=status-first-1';
import { snapshotIsFresh } from '../src/upgrade/device-probe.js?v=status-first-1';
import { inspectFirmware } from '../src/upgrade/firmware-image.js?v=status-first-1';
import { WebBluetoothAdapter } from '../src/adapters/web-bluetooth.js';
import { buildFrame } from '../src/protocol/scope-protocol.js';
import { frame, syntheticFirmware, eventMirror, n32Info } from './fixtures.mjs';
import { WireChannel } from '../src/upgrade/ota-channel.js?v=status-first-1';

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
