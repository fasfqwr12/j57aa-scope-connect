// 弹道数据契约：只负责组装下发参数与文本映射，网页不再本地解算。
// 解算结果只有两个来源——设备解算（BLE，固件内 C 核）或上位机 C 核（Bridge）。
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
