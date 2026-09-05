// Offline firmware model. Never accesses Bluetooth, serial, network, or flash hardware.
import { WireChannel } from '../src/upgrade/ota-channel.js?v=status-first-1';
export const u32 = v => [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255];
export const be32 = (b, o = 0) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export function referenceCrc16(bytes) {
  let c = 65535;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; ++k) { const low = c % 2; c = Math.floor(c / 2); if (low) c ^= 40961; } }
  return c;
}
export function referenceCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xEDB88320 : 0); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
export function frame(cmd, payload = []) {
  const body = [cmd, payload.length >>> 8, payload.length & 255, ...payload], c = referenceCrc16(body);
  return Uint8Array.from([170, ...body, c >>> 8, c & 255, 85]);
}
export function proxyResponse(status) {
  const body = [170, 126, 0, 5, 71, 76, 80, 88, status], c = referenceCrc16(body);
  return Uint8Array.from([...body, c >>> 8, c & 255]);
}
export function eventMirror(nested) {
  const p = [71, 76, 80, 69, 0x86, 0, 1, 0xB1, 0, ...u32(nested.length), ...nested];
  const body = [170, 254, p.length >>> 8, p.length & 255, ...p], c = referenceCrc16(body);
  return Uint8Array.from([...body, c >>> 8, c & 255]);
}
export function makeInfo({ id = 0x11223344, appStart = 0x08008000, size = 624, crc = 0, sw = 1 } = {}) {
  const b = new Uint8Array(48), d = new DataView(b.buffer);
  d.setUint32(0, id, true); d.setUint16(4, 0x100, true); d.setUint16(6, sw, true); d.setUint16(8, 0x100, true);
  b.set(new TextEncoder().encode('J57AA-W515'), 12);
  d.setUint32(28, 0x200000, true); d.setUint32(32, appStart, true); d.setUint32(36, 0x1F8000, true);
  d.setUint32(40, size, true); d.setUint32(44, crc, true);
  return b;
}
export function f7Response(info = makeInfo()) {
  const b = Uint8Array.from([170, 254, 247, 48, ...info, 0, 187, 255]);
  for (let i = 2; i < 52; i++) b[52] ^= b[i];
  return b;
}
export function n32Info(mode, valid = false) {
  const b = new Uint8Array(mode === 'APP' ? 33 : 17), d = new DataView(b.buffer, 1);
  b.set(new TextEncoder().encode(mode === 'APP' ? 'N32A' : 'N32B'), 1);
  if (mode === 'APP') {
    d.setUint16(4, 0x106, false); d.setUint32(8, 0x08002000, false); d.setUint8(16, 4);
    d.setUint32(20, 1234, false); d.setUint16(30, 77, false);
  } else {
    d.setUint8(4, 1); d.setUint32(5, 0x08002000, false); d.setUint32(9, 0x0800F7FF, false);
    d.setUint16(13, 0x800, false); d.setUint8(15, valid ? 1 : 0);
  }
  return b;
}
export function syntheticFirmware(size = 624, base = 0x08008000) {
  const b = new Uint8Array(size); b.fill(255); const d = new DataView(b.buffer);
  d.setUint32(0, 0x20004000, true); d.setUint32(4, base + 0x241, true);
  d.setUint32(0x200, 0x4649524D, true); d.setUint32(0x204, 0x00010000, true); d.setUint32(0x208, 0x100, true);
  b.fill(0, 0x210, 0x220); b.set(new TextEncoder().encode('J57AA-W515'), 0x210);
  const crc = referenceCrc32(b); d.setUint32(0x220, size, true); d.setUint32(0x224, crc, true);
  return b;
}
export function hexRecord(type, addr = 0, data = []) {
  const body = [data.length, addr >>> 8, addr & 255, type, ...data];
  body.push((-body.reduce((s, b) => s + b, 0)) & 255);
  return ':' + body.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function intelHex(bytes, base = 0x08008000) {
  const out = [hexRecord(4, 0, [base >>> 24, base >>> 16 & 255])];
  for (let o = 0; o < bytes.length; o += 16) out.push(hexRecord(0, (base & 65535) + o, bytes.slice(o, o + 16)));
  out.push(hexRecord(1)); return out.join('\n');
}
export class FakeAdapter {
  constructor(options = {}) {
    this.o = options; this.device = { id: 'fake-w515' }; this.generation = 1; this.connected = true;
    this.main = options.main || 'APP'; this.slave = options.slave || 'APP'; this.owner = options.busy ? 99 : 0;
    this.commands = []; this.written = 0; this.state = 1; this.verified = false; this.image = options.image || syntheticFirmware();
    this.channel = new WireChannel((data, writeOptions) => this.emulate(data, writeOptions));
  }
  isGattConnected() { return this.connected; }
  beginExclusive(owner) { if (this.exclusive) throw new Error('busy'); this.exclusive = owner; return () => { this.exclusive = null; }; }
  async reconnect() { this.connected = true; this.generation++; this.channel.resetConnection(); }
  requestWire(data, options) { return this.channel.request(data, { ...options, timeoutMs: this.o.timeoutMs || 20 }); }
  respond(data) {
    // Exercise partial notifications including status/magic boundaries.
    for (let i = 0; i < data.length; i += 3) this.channel.receive(data.slice(i, i + 3));
  }
  info() {
    const d = new DataView(this.image.buffer);
    return makeInfo({ size: this.image.length, crc: d.getUint32(0x224, true), appStart: this.entered && this.o.wrongBootWindow ? 0x08010000 : 0x08008000 });
  }
  async emulate(data, options) {
    const cmd = data[1], p = data.slice(4, -3);
    this.commands.push({ cmd, data: [...data], chunkSize: options.chunkSize });
    if (this.o.onCommand) this.o.onCommand(cmd, this);
    if (cmd === 0xEE) { if (!this.o.noF7) this.respond(f7Response(this.info())); return; }
    if (cmd === 0x7E) {
      if (options.chunkSize < 27 || data.length !== 27) throw new Error('inactive GLPX dispatch drops partial request');
      const mode = data[8], sid = be32(data, 9);
      if (this.o.proxyTimeout === mode) return;
      if (mode === 1) {
        if (this.owner) this.respond(proxyResponse(3));
        else { this.owner = sid; this.respond(proxyResponse(0)); }
      } else {
        const status = !this.owner ? 5 : sid && sid !== this.owner ? 4 : 0;
        if (mode === 2 && status === 0 && !this.o.stopFails) this.owner = 0;
        this.respond(proxyResponse(status));
      }
      return;
    }
    if (cmd === 0x31) {
      if (!this.owner) throw new Error('N32 requires proxy');
      if (this.slave !== 'UNKNOWN') this.respond(frame(0xB1, n32Info(this.slave, !!this.o.appValid)));
      return;
    }
    if (cmd === 1) {
      if (this.main === 'UNKNOWN' || (this.reset && this.o.noApp)) return;
      if (this.main === 'BOOT') this.state = 1;
      this.respond(frame(0x81, this.main === 'APP' ? [170, 85, 170, 85] : [135, 101, 67, 33])); return;
    }
    if (cmd === 2) { this.respond(frame(0x82, this.info())); return; }
    if (cmd === 3) { this.main = 'BOOT'; this.entered = true; this.respond(frame(0x83, [0])); return; }
    if (cmd === 4) { this.eraseSize = be32(p, 4); this.written = 0; this.state = 0x11; this.respond(frame(0x84, [0])); return; }
    if (cmd === 5) {
      if (p[0] !== 1 || be32(p, 1) !== 0x08008000 + this.written || (p.length - 5) % 4) throw new Error('bad ACK write packet');
      this.written += p.length - 5;
      if (this.o.lostWriteAck) return;
      this.respond(frame(0x85, [this.o.writeError ? 3 : 0])); return;
    }
    if (cmd === 6) {
      if (this.o.verifyFail) { this.respond(frame(0x86, [6])); return; }
      this.verifyData = p; this.verified = true; this.state = 0x20; this.respond(frame(0x86, [0])); return;
    }
    if (cmd === 9) {
      const s = new Uint8Array(49), d = new DataView(s.buffer); s[0] = this.state;
      d.setUint32(1, this.written + (this.o.badCount && this.written ? 4 : 0), false);
      if (this.verified) {
        s[9] = this.o.badDiag ? 3 : 1; d.setUint32(13, 1, false);
        s.set(this.verifyData.slice(0, 12), 17); s.set(this.verifyData.slice(8, 12), 29);
      }
      this.respond(frame(0x89, s)); return;
    }
    if (cmd === 7) {
      if (!this.verified || this.state !== 0x20) { this.respond(frame(0x87, [6])); return; }
      this.reset = true; this.main = 'APP'; this.respond(frame(0x87, [0])); return;
    }
    throw new Error(`unmodelled command ${cmd}`);
  }
}
