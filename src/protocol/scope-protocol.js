const HEADER = [0xfe, 0xff, 0xff, 0xfe];
const FOOTER = [0xef, 0xff, 0xff, 0xef];

export function bytesToHex(bytes) {
  return Array.from(bytes || []).map(v => v.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

export function hexToBytes(text) {
  return new Uint8Array(String(text || "").trim().split(/\s+/).filter(Boolean).map(x => parseInt(x, 16) & 0xff));
}

export function buildFrame(params) {
  const body = Array.from(params || []);
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  return new Uint8Array([...HEADER, body.length & 0xff, ...body, sum, ...FOOTER]);
}

export function findFrames(buffer) {
  const buf = Array.from(buffer || []);
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    const idx = indexOfSeq(buf, HEADER, i);
    if (idx < 0 || idx + 5 > buf.length) break;
    const len = buf[idx + 4];
    const total = 4 + 1 + len + 1 + 4;
    if (idx + total > buf.length) break;
    const footerAt = idx + 5 + len + 1;
    if (!matchesSeq(buf, FOOTER, footerAt)) {
      i = idx + 1;
      continue;
    }
    const params = buf.slice(idx + 5, idx + 5 + len);
    const recvSum = buf[idx + 5 + len];
    const calcSum = params.reduce((a, b) => (a + b) & 0xff, 0);
    frames.push({
      params: new Uint8Array(params),
      length: len,
      checksum_ok: recvSum === calcSum,
      recv_sum: recvSum,
      calc_sum: calcSum,
      raw: new Uint8Array(buf.slice(idx, idx + total))
    });
    i = idx + total;
  }
  return frames;
}

export function buildSensorQuery() {
  return buildFrame([0x01, 0x00]);
}

export function parseSensorReply(params) {
  const p = Array.from(params || []);
  if (p.length < 10) return null;
  const altitudeRaw = p[0] | (p[1] << 8);
  const tempRaw = p[2] | (p[3] << 8);
  const humidityRaw = p[4] | (p[5] << 8);
  const pressureRaw = u32le(p, 6);
  return {
    altitude_m: altitudeRaw / 10,
    temperature_c: tempRaw - 100,
    humidity_pct: humidityRaw / 10,
    pressure_pa: pressureRaw,
    raw: {
      altitude: altitudeRaw,
      temp: tempRaw,
      humidity: humidityRaw,
      pressure: pressureRaw
    }
  };
}

export function parseMeasurement(params) {
  const p = Array.from(params || []);
  if (p.length < 23) return null;
  const dist = u32le(p, 0);
  const battery = p[4];
  const windCorr = u32le(p, 5);
  const pitchCorr = p[9] | (p[10] << 8);
  const dropDist = u32le(p, 15);
  const vertDrop = u32le(p, 19);
  return {
    distance_m: dist / 100,
    battery,
    wind_correction_px: windCorr - 32767,
    pitch_correction_px: pitchCorr - 32767,
    drop_distance_m: dropDist / 100,
    vertical_drop_m: vertDrop / 100
  };
}

export function buildBallisticQuery(input) {
  const p = input || {};
  const out = [];
  pushU16(out, (p.bc ?? 0.5) * 1000);
  pushU16(out, (p.angle_deg ?? 0) + 90);
  pushU32(out, (p.velocity_ms ?? 0) * 100);
  pushU16(out, p.baseline_mm ?? p.sight_height_mm ?? 0);
  pushU16(out, p.zero_range_m ?? 0);
  pushU16(out, (p.altitude_m ?? 0) * 10);
  pushU16(out, (p.temp_c ?? p.temperature_c ?? 0) + 100);
  pushU16(out, (p.humidity_pct ?? 0) * 10);
  pushU32(out, p.pressure_pa ?? 101325);
  pushU16(out, (p.head_wind_ms ?? 0) * 10 + 32767);
  pushU16(out, (p.cross_wind_ms ?? 0) * 10 + 32767);
  out.push(modelCode(p.model));
  pushU32(out, (p.range_m ?? 0) * 100);
  pushU16(out, p.focal_mm ?? 50);
  out.push(Math.round((p.pixel_um ?? 12) * 10) & 0xff);
  pushU16(out, p.det_w ?? 640);
  pushU16(out, p.det_h ?? 480);
  pushU16(out, p.disp_w ?? 1024);
  pushU16(out, p.disp_h ?? 600);
  return buildFrame(out);
}

export function parseBallisticReply(params) {
  const p = Array.from(params || []);
  if (p.length < 13) return null;
  return {
    result_flag: p[0],
    range_m: u32le(p, 1) / 100,
    h_offset_mm: (p[5] | (p[6] << 8)) - 32767,
    v_offset_mm: (p[7] | (p[8] << 8)) - 32767,
    x_offset_px: (p[9] | (p[10] << 8)) - 32767,
    y_offset_px: (p[11] | (p[12] << 8)) - 32767
  };
}

function modelCode(model) {
  const key = String(model || "G1").toUpperCase();
  return { G1: 1, G2: 2, GA: 3, G5: 5, G6: 6, G7: 7, G8: 8, GL: 9 }[key] || 1;
}

function pushU16(out, value) {
  const v = Math.round(Number(value) || 0) & 0xffff;
  out.push(v & 0xff, (v >> 8) & 0xff);
}

function pushU32(out, value) {
  const v = Math.round(Number(value) || 0) >>> 0;
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}

function u32le(p, offset) {
  return ((p[offset] || 0) | ((p[offset + 1] || 0) << 8) | ((p[offset + 2] || 0) << 16) | ((p[offset + 3] || 0) << 24)) >>> 0;
}

function indexOfSeq(buf, seq, start) {
  for (let i = start; i <= buf.length - seq.length; i += 1) {
    if (matchesSeq(buf, seq, i)) return i;
  }
  return -1;
}

function matchesSeq(buf, seq, idx) {
  for (let i = 0; i < seq.length; i += 1) {
    if (buf[idx + i] !== seq[i]) return false;
  }
  return true;
}
