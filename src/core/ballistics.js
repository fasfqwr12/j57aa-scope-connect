export function buildBallisticInput(state) {
  const profile = state.profiles[state.currentProfileId] || state.profiles.default;
  return {
    ammo: profile.ammo,
    bc: Number(profile.bc) || 0.48,
    model: profile.model || "G7",
    velocity_ms: Number(profile.velocity_ms) || 850,
    bullet_weight_g: Number(profile.bullet_weight_g) || 4,
    baseline_mm: Number(profile.baseline_mm) || 20,
    zero_range_m: Number(profile.zero_range_m) || 100,
    altitude_m: Number(state.environment.altitude_m) || 0,
    temp_c: Number(state.environment.temp_c) || 15,
    humidity_pct: Number(state.environment.humidity_pct) || 50,
    pressure_pa: Number(state.environment.pressure_pa) || 101325,
    head_wind_ms: Number(state.target.head_wind_ms) || 0,
    cross_wind_ms: Number(state.target.cross_wind_ms) || 0,
    angle_deg: Number(state.target.angle_deg) || 0,
    range_m: Number(state.target.range_m) || 100,
    target_type: state.target.type || "deer",
    target_width_m: Number(state.target.width_m) || 1.25,
    target_pose: state.target.pose || "broadside",
    shotcall_j: Number(profile.min_energy_j) || 0,
    min_energy_j: Number(profile.min_energy_j) || 0,
    zoom_x: Number(state.hud.zoom_x) || 10,
    reticle_min_range_m: Number(state.hud.reticle_min_range_m) || 100,
    reticle_max_range_m: Number(state.hud.reticle_max_range_m) || 1500,
    reticle_mil_per_row_at_10x: Number(state.hud.reticle_mil_per_row_at_10x) || 1.28,
    reticle_rows: Number(state.hud.reticle_rows) || 17,
    reticle_max_wind_cols: Number(state.hud.reticle_max_wind_cols) || 6,
    focal_mm: 50,
    pixel_um: 12,
    det_w: 640,
    det_h: 480,
    disp_w: 1024,
    disp_h: 600
  };
}

export function solvePreview(input) {
  const p = input || {};
  const range = Math.max(1, Number(p.range_m) || 1);
  const zero = Math.max(25, Number(p.zero_range_m) || 100);
  const sight = Math.max(0, Number(p.baseline_mm) || 0) / 1000;
  const g = 9.80665;
  const zeroFlight = flightAtRange(p, zero);
  const shotFlight = flightAtRange(p, range);
  const zeroAngle = (sight + 0.5 * g * zeroFlight.time_s * zeroFlight.time_s) / zero;
  const angleCos = Math.cos((Number(p.angle_deg) || 0) * Math.PI / 180);
  const gravityDrop = 0.5 * g * shotFlight.time_s * shotFlight.time_s * Math.max(0.45, angleCos);
  const dropM = Math.max(-1, gravityDrop - zeroAngle * range + sight);
  const windFactor = 0.18 + Math.min(0.12, range / 9000);
  const windM = -(Number(p.cross_wind_ms) || 0) * shotFlight.time_s * windFactor;
  const elevationMil = Math.abs(dropM / range * 1000);
  const windageMil = windM / range * 1000;
  const energyJ = energyJoules(p.bullet_weight_g, shotFlight.velocity_ms);
  const minEnergy = Math.max(0, Number(p.min_energy_j ?? p.shotcall_j) || 0);
  const margin = minEnergy > 0 ? ((energyJ - minEnergy) / minEnergy) * 100 : 0;
  const shotStatus = minEnergy <= 0 ? 4 : (energyJ < minEnergy ? 3 : (margin < 18 ? 2 : 1));
  const zoom = clamp(Number(p.zoom_x) || 10, 4, 20);
  const rows = Math.max(1, Number(p.reticle_rows) || 17);
  const milPerRow = Math.max(0.1, Number(p.reticle_mil_per_row_at_10x) || 1.28);
  const rawRow = elevationMil * (zoom / 10) / milPerRow;
  const hudFault = range > (Number(p.reticle_max_range_m) || 1500) ? 1 : (rawRow > rows - 1 + 0.28 ? 2 : 0);
  const maxCols = Math.max(1, Number(p.reticle_max_wind_cols) || 6);
  const reticleCol = clamp(Math.round(Math.abs(windageMil)), 0, maxCols);
  const reticleSide = windageMil < 0 ? -1 : (windageMil > 0 ? 1 : 0);
  const row = clamp(Math.round(rawRow), 0, rows - 1);
  const xPct = 50 + reticleSide * reticleCol * 3.5;
  const yPct = 48 + row * 2.45;
  return {
    result_flag: 1,
    range_m: range,
    time_s: shotFlight.time_s,
    final_velocity_ms: shotFlight.velocity_ms,
    energy_j: energyJ,
    min_energy_j: minEnergy,
    shot_margin_pct: margin,
    shot_status: shotStatus,
    hud_fault: hudFault,
    show_x: shotStatus === 3 || hudFault === 1,
    show_aim_dot: hudFault === 0,
    can_shoot: hudFault === 0 && shotStatus !== 3,
    drop_m: dropM,
    wind_drift_m: windM,
    elevation_mil: elevationMil,
    windage_mil: windageMil,
    h_offset_mm: Math.round(windM * 1000),
    v_offset_mm: Math.round(dropM * 1000),
    reticle_raw_row: rawRow,
    reticle_row: row,
    reticle_col: reticleCol,
    reticle_side: reticleSide,
    reticle_x_pct: clamp(xPct, 20, 80),
    reticle_y_pct: clamp(yPct, 28, 86),
    model: "js-preview"
  };
}

export function shotStatusText(status) {
  const n = Number(status);
  if (n === 1) return "VALID";
  if (n === 2) return "MARGINAL";
  if (n === 3) return "NO SHOT";
  if (n === 4) return "OFF";
  return "WAIT";
}

export function hudFaultText(fault) {
  const n = Number(fault);
  if (n === 1) return "TOO FAR";
  if (n === 2) return "ZOOM OUT";
  if (n === 3) return "PARAM";
  return "";
}

export function densityAltitude(environment) {
  const altitude = Number(environment.altitude_m) || 0;
  const temp = Number(environment.temp_c) || 15;
  const isaT = 15 - 0.0065 * altitude;
  return altitude + 120 * (isaT - temp);
}

function flightAtRange(p, rangeM) {
  const range = Math.max(1, Number(rangeM) || 1);
  const bcEff = bcEffective(p);
  const rho = airDensityRatio(p);
  const v0 = Math.max(120, Number(p.velocity_ms) || 500);
  const head = Number(p.head_wind_ms) || 0;
  const dragK = 0.00034 * rho * Math.max(0.78, Math.min(1.18, 1 + head / Math.max(250, v0)));
  let x = 0;
  let v = v0;
  let t = 0;
  while (x < range) {
    const dx = Math.min(4, range - x);
    const vMid = Math.max(80, v * Math.exp(-dragK * dx / (2 * bcEff)));
    t += dx / vMid;
    v = Math.max(80, v * Math.exp(-dragK * dx / bcEff));
    x += dx;
  }
  return { time_s: t, velocity_ms: v };
}

function energyJoules(weightG, velocityMs) {
  return 0.5 * (Math.max(0, Number(weightG) || 0) / 1000) * velocityMs * velocityMs;
}

function airDensityRatio(p) {
  const tempK = (Number(p.temp_c) || 15) + 273.15;
  const pressure = Number(p.pressure_pa) || 101325;
  const rho = pressure / (287.05 * tempK);
  return clamp(rho / 1.225, 0.62, 1.25);
}

function bcEffective(p) {
  const bc = Math.max(0.08, Number(p.bc) || 0.3);
  const model = String(p.model || "G1").toUpperCase();
  const shape = model === "G7" ? 0.5975 : 1.1275;
  return bc / shape;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
