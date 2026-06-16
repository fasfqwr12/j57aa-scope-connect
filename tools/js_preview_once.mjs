import { solvePreview } from "../src/core/ballistics.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const p = JSON.parse(input);
const result = solvePreview({
  ammo: p.name,
  bc: p.bc,
  model: p.model,
  velocity_ms: p.velocity_ms,
  bullet_weight_g: p.bullet_weight_g,
  baseline_mm: p.baseline_mm,
  zero_range_m: p.zero_range_m,
  altitude_m: p.altitude_m ?? 0,
  temp_c: p.temp_c ?? 15,
  humidity_pct: p.humidity_pct ?? 50,
  pressure_pa: p.pressure_pa ?? 101325,
  head_wind_ms: p.head_wind_ms ?? 0,
  cross_wind_ms: p.cross_wind_ms ?? 0,
  angle_deg: p.angle_deg ?? 0,
  range_m: p.range_m,
  target_type: p.target_type ?? "steel",
  target_width_m: p.target_width_m ?? 1,
  target_pose: p.target_pose ?? "broadside",
  shotcall_j: p.min_energy_j,
  min_energy_j: p.min_energy_j,
  zoom_x: p.zoom_x ?? 10,
  reticle_min_range_m: p.reticle_min_range_m ?? 100,
  reticle_max_range_m: p.reticle_max_range_m ?? 2200,
  reticle_mil_per_row_at_10x: p.reticle_mil_per_row_at_10x ?? 1.9,
  reticle_rows: p.reticle_rows ?? 17,
  reticle_max_wind_cols: p.reticle_max_wind_cols ?? 6,
});

console.log(JSON.stringify({
  time_s: result.time_s,
  drop_mil: -result.elevation_mil,
  wind_mil: result.windage_mil,
  velocity_ms: result.final_velocity_ms,
  energy_j: result.energy_j,
  shot_status: result.shot_status,
  hud_fault: result.hud_fault,
  can_shoot: result.can_shoot,
  reticle_raw_row: result.reticle_raw_row,
  reticle_row: result.reticle_row,
  reticle_col: result.reticle_col,
}));
