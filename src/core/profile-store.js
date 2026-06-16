const KEY = "j57aa_scope_connect_state_v1";

export const ammoPresets = {
  "223_55_vmax": { name: "223 REM 55gr V-MAX", ammo: "223 REM 55gr V-MAX", bc: 0.255, model: "G1", velocity_ms: 990, bullet_weight_g: 3.56, baseline_mm: 20, zero_range_m: 100, min_energy_j: 850 },
  "556_62_fmj": { name: "5.56 NATO 62gr FMJ", ammo: "5.56 NATO 62gr FMJ", bc: 0.304, model: "G1", velocity_ms: 920, bullet_weight_g: 4.02, baseline_mm: 20, zero_range_m: 100, min_energy_j: 900 },
  "243_95_sst": { name: ".243 WIN 95gr SST", ammo: ".243 WIN 95gr SST", bc: 0.355, model: "G1", velocity_ms: 940, bullet_weight_g: 6.16, baseline_mm: 20, zero_range_m: 180, min_energy_j: 1200 },
  "65cm_143_eldx": { name: "6.5 Creedmoor 143gr ELD-X", ammo: "6.5 Creedmoor 143gr ELD-X", bc: 0.315, model: "G7", velocity_ms: 823, bullet_weight_g: 9.27, baseline_mm: 20, zero_range_m: 200, min_energy_j: 1500 },
  "308_168_match": { name: ".308 WIN 168gr Match", ammo: ".308 WIN 168gr Match", bc: 0.223, model: "G7", velocity_ms: 808, bullet_weight_g: 10.89, baseline_mm: 20, zero_range_m: 100, min_energy_j: 1600 },
  "300wm_178_eldx": { name: ".300 WM 178gr ELD-X", ammo: ".300 WM 178gr ELD-X", bc: 0.278, model: "G7", velocity_ms: 900, bullet_weight_g: 11.53, baseline_mm: 20, zero_range_m: 200, min_energy_j: 1800 }
};

export function defaultState() {
  return {
    activeStep: "device",
    currentProfileId: "default",
    connection: {
      mode: "web-bluetooth",
      scanMode: "all",
      namePrefix: "E104",
      serviceUuid: "0000fff0-0000-1000-8000-00805f9b34fb",
      rxUuid: "0000fff1-0000-1000-8000-00805f9b34fb",
      txUuid: "0000fff2-0000-1000-8000-00805f9b34fb",
      bridgeBase: "http://127.0.0.1:8766"
    },
    profiles: {
      default: {
        name: "DA_556",
        ammo: "DA_556",
        model: "G7",
        bc: 0.48,
        velocity_ms: 850,
        bullet_weight_g: 4,
        baseline_mm: 20,
        zero_range_m: 100,
        min_energy_j: 1000
      }
    },
    environment: {
      altitude_m: 200,
      temp_c: 25,
      humidity_pct: 50,
      pressure_pa: 101325
    },
    target: {
      type: "deer",
      pose: "broadside",
      width_m: 1.25,
      range_m: 300,
      angle_deg: 0,
      head_wind_ms: 0,
      cross_wind_ms: 0
    },
    hud: {
      units: "metric",
      swapRangeWind: false,
      zoom_x: 10,
      reticle_min_range_m: 100,
      reticle_max_range_m: 1500,
      reticle_mil_per_row_at_10x: 1.28,
      reticle_rows: 17,
      reticle_max_wind_cols: 6,
      zones: {
        distance: true,
        wind: true,
        angle: true,
        battery: true,
        densityAltitude: true,
        temperature: true,
        bluetooth: true,
        energy: true,
        velocity: true,
        sci: true
      }
    },
    lastMeasurement: null,
    lastSolution: null
  };
}

export function loadState() {
  const base = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return mergeState(base, saved);
  } catch {
    return base;
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function currentProfile(state) {
  return state.profiles[state.currentProfileId] || state.profiles.default;
}

export function setCurrentProfile(state, profile) {
  state.profiles[state.currentProfileId] = { ...currentProfile(state), ...profile };
}

export function makeProfileId(name) {
  const safe = String(name || "profile").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (safe || "profile") + "_" + Date.now().toString(36);
}

function mergeState(base, saved) {
  const out = { ...base, ...saved };
  out.connection = { ...base.connection, ...(saved.connection || {}) };
  out.profiles = { ...base.profiles, ...(saved.profiles || {}) };
  out.environment = { ...base.environment, ...(saved.environment || {}) };
  out.target = { ...base.target, ...(saved.target || {}) };
  out.hud = { ...base.hud, ...(saved.hud || {}) };
  out.hud.zones = { ...base.hud.zones, ...((saved.hud && saved.hud.zones) || {}) };
  if (!out.profiles[out.currentProfileId]) out.currentProfileId = "default";
  return out;
}
