const KEY = "j57aa_scope_connect_state_v1";

export const ammoPresets = {
  "223_55_vmax": {
    name: "223 REM 55gr V-MAX",
    ammo: "223 REM 55gr V-MAX",
    bc: 0.255,
    model: "G1",
    velocity_ms: 990,
    bullet_weight_g: 3.56,
    baseline_mm: 20,
    zero_range_m: 100,
    min_energy_j: 850,
    role: "小口径高速 / 低后坐",
    summary: ".223 Remington 常见轻弹头配置，弹道平、后坐小，适合作为小口径训练和小型目标 Profile。"
  },
  "556_62_fmj": {
    name: "5.56 NATO 62gr FMJ",
    ammo: "5.56 NATO 62gr FMJ",
    bc: 0.304,
    model: "G1",
    velocity_ms: 920,
    bullet_weight_g: 4.02,
    baseline_mm: 20,
    zero_range_m: 100,
    min_energy_j: 900,
    role: "AR 平台常见 / 通用基线",
    summary: "5.56 NATO 62gr 全被甲常见于半自动平台，适合做 5.56 口径的通用调试基线。"
  },
  "243_95_sst": {
    name: ".243 WIN 95gr SST",
    ammo: ".243 WIN 95gr SST",
    bc: 0.355,
    model: "G1",
    velocity_ms: 940,
    bullet_weight_g: 6.16,
    baseline_mm: 20,
    zero_range_m: 180,
    min_energy_j: 1200,
    role: "高速低后坐 / 中小型目标",
    summary: ".243 Winchester 速度高、弹道平，常用于鹿、羊这类中小型猎物或中距离靶场校验。"
  },
  "65cm_143_eldx": {
    name: "6.5 Creedmoor 143gr ELD-X",
    ammo: "6.5 Creedmoor 143gr ELD-X",
    bc: 0.315,
    model: "G7",
    velocity_ms: 823,
    bullet_weight_g: 9.27,
    baseline_mm: 20,
    zero_range_m: 200,
    min_energy_j: 1500,
    role: "远距离 / 抗风偏",
    summary: "6.5 Creedmoor 高 BC 弹头保速好、风偏小，适合中远距离弹道和风偏验证。"
  },
  "308_168_match": {
    name: ".308 WIN 168gr Match",
    ammo: ".308 WIN 168gr Match",
    bc: 0.223,
    model: "G7",
    velocity_ms: 808,
    bullet_weight_g: 10.89,
    baseline_mm: 20,
    zero_range_m: 100,
    min_energy_j: 1600,
    role: "成熟基准 / 靶场对照",
    summary: ".308 Winchester 168gr Match 数据资料多、平台常见，适合作为算法回归和靶纸校准基准。"
  },
  "300wm_178_eldx": {
    name: ".300 WM 178gr ELD-X",
    ammo: ".300 WM 178gr ELD-X",
    bc: 0.278,
    model: "G7",
    velocity_ms: 900,
    bullet_weight_g: 11.53,
    baseline_mm: 20,
    zero_range_m: 200,
    min_energy_j: 1800,
    role: "大能量 / 远距离",
    summary: ".300 Winchester Magnum 能量和速度余量大，适合远距离能量阈值、TOO FAR 和阵列边界验证。"
  },
  "375ct_350_elr": {
    name: ".375 CheyTac 350gr ELR",
    ammo: ".375 CheyTac 350gr ELR",
    bc: 0.470,
    model: "G7",
    velocity_ms: 930,
    bullet_weight_g: 22.68,
    baseline_mm: 55,
    zero_range_m: 300,
    min_energy_j: 1500,
    hud: { reticle_max_range_m: 2200, reticle_mil_per_row_at_10x: 1.9 },
    role: "ELR / 2000m 下限",
    summary: ".375 CheyTac 属于超远距离组合，2000m 仍可保留约 1500J 级能量，适合验证 2000m 有效命中下限和阵列极限。"
  },
  "408ct_419_elr": {
    name: ".408 CheyTac 419gr ELR",
    ammo: ".408 CheyTac 419gr ELR",
    bc: 0.475,
    model: "G7",
    velocity_ms: 884,
    bullet_weight_g: 27.15,
    baseline_mm: 55,
    zero_range_m: 300,
    min_energy_j: 1600,
    hud: { reticle_max_range_m: 2200, reticle_mil_per_row_at_10x: 1.9 },
    role: "ELR / 2000m 有效",
    summary: ".408 CheyTac 是典型 ELR 组合，2000m 末端能量可接近或超过 1600J，用来闭环远距离能量阈值和 HUD TOO FAR 状态。"
  },
  "50bmg_750_amax": {
    name: ".50 BMG 750gr A-MAX",
    ammo: ".50 BMG 750gr A-MAX",
    bc: 0.520,
    model: "G7",
    velocity_ms: 860,
    bullet_weight_g: 48.60,
    baseline_mm: 70,
    zero_range_m: 300,
    min_energy_j: 2500,
    hud: { reticle_max_range_m: 2200, reticle_mil_per_row_at_10x: 1.9 },
    role: "重型 ELR / 能量充足",
    summary: ".50 BMG 重弹在 2000m 仍有明显能量余量，适合验证大能量阈值、长飞行时间和设备远距边界。"
  }
};

export const profileIntroCatalog = {
  DA_556: {
    role: "项目默认 / 调试占位",
    summary: "DA_556 是当前默认自定义 Profile，用来跑通 5.56 类输入、HUD 显示和 BLE 流程；正式使用前必须替换成实测初速、镜高和归零数据。"
  }
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
  if (!["all", "name", "service"].includes(out.connection.scanMode)) out.connection.scanMode = "all";
  out.profiles = { ...base.profiles, ...(saved.profiles || {}) };
  out.environment = { ...base.environment, ...(saved.environment || {}) };
  out.target = { ...base.target, ...(saved.target || {}) };
  out.hud = { ...base.hud, ...(saved.hud || {}) };
  out.hud.zones = { ...base.hud.zones, ...((saved.hud && saved.hud.zones) || {}) };
  if (!out.profiles[out.currentProfileId]) out.currentProfileId = "default";
  return out;
}
