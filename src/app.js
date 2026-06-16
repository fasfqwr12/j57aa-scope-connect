import { LocalBridgeAdapter } from "./adapters/local-bridge.js?v=20260616_profile_verify1";
import { WebBluetoothAdapter } from "./adapters/web-bluetooth.js?v=20260616_profile_verify1";
import { buildBallisticInput, densityAltitude, hudFaultText, shotStatusText, solvePreview } from "./core/ballistics.js?v=20260616_profile_verify1";
import { ammoPresets, currentProfile, loadState, makeProfileId, profileIntroCatalog, saveState, setCurrentProfile } from "./core/profile-store.js?v=20260616_profile_verify1";

const steps = [
  { id: "device", label: "设备", title: "设备连接", kicker: "DEVICE" },
  { id: "profile", label: "弹药", title: "弹药 Profile", kicker: "PROFILE" },
  { id: "environment", label: "环境", title: "环境参数", kicker: "ENV" },
  { id: "target", label: "目标", title: "目标 / SCI", kicker: "TARGET" },
  { id: "hud", label: "HUD", title: "HUD 显示", kicker: "HUD" },
  { id: "sync", label: "同步", title: "同步 DOPE", kicker: "SYNC" }
];

const zoneLabels = {
  distance: "DIST 距离",
  wind: "WIND 风偏",
  angle: "ANGLE 角度",
  battery: "BATT 电量",
  densityAltitude: "DA 密度高度",
  temperature: "TEMP 温度",
  bluetooth: "BT 蓝牙",
  energy: "ENERGY 能量",
  velocity: "VEL 末速",
  sci: "SCI X"
};

const state = loadState();
let adapter = null;
let saveTimer = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

init();

function init() {
  renderSteps();
  renderProfileOptions();
  renderAmmoPresets();
  renderZoneToggles();
  bindForms();
  bindActions();
  buildReticle();
  setStep(state.activeStep || "device");
  refreshAll();
  log("SYS", "Scope Connect 已就绪");
}

function bindActions() {
  $("#btn-connect").addEventListener("click", connect);
  $("#btn-connect-panel").addEventListener("click", connect);
  $("#btn-disconnect").addEventListener("click", disconnect);
  $("#btn-read-env").addEventListener("click", readEnvironment);
  $("#btn-read-env-panel").addEventListener("click", readEnvironment);
  $("#btn-listen-range").addEventListener("click", listenMeasurement);
  $("#btn-reset-env").addEventListener("click", () => {
    state.environment = { altitude_m: 0, temp_c: 15, humidity_pct: 50, pressure_pa: 101325 };
    refreshAll();
  });
  $("#btn-new-profile").addEventListener("click", newProfile);
  $("#btn-save-profile").addEventListener("click", () => {
    scheduleSave(true);
    log("SYS", `已保存 Profile: ${currentProfile(state).name}`);
  });
  $("#btn-delete-profile").addEventListener("click", deleteProfile);
  $("#btn-export-profile").addEventListener("click", exportProfile);
  $("#import-profile").addEventListener("change", importProfile);
  $("#ammo-preset").addEventListener("change", ev => applyAmmoPreset(ev.target.value));
  $("#profile-select").addEventListener("change", ev => {
    state.currentProfileId = ev.target.value;
    refreshAll();
  });
  $("#btn-sync-profile").addEventListener("click", syncProfile);
  $("#btn-solve-device").addEventListener("click", solveDevice);
  $("#btn-solve-local").addEventListener("click", solveLocal);
  $("#btn-clear-log").addEventListener("click", () => { $("#log-box").innerHTML = ""; });
  $("#btn-open-hud").addEventListener("click", openLegacyHud);
}

function bindForms() {
  $$("[data-bind]").forEach(el => {
    const update = () => {
      setPath(state, el.dataset.bind, readElement(el));
      if (el.dataset.bind === "target.type") applyTargetDefaults(false);
      refreshAll({ fromInput: el });
    };
    el.addEventListener("input", update);
    el.addEventListener("change", update);
  });
}

function renderSteps() {
  const stepList = $("#step-list");
  const mobile = $("#mobile-tabs");
  stepList.innerHTML = steps.map((s, i) => `
    <button class="step-item" data-step="${s.id}" type="button">
      <span>${String(i + 1).padStart(2, "0")}</span>
      <strong>${s.label}</strong>
      <em>${s.title}</em>
    </button>
  `).join("");
  mobile.innerHTML = steps.map(s => `<button data-step="${s.id}" type="button">${s.label}</button>`).join("");
  $$("[data-step]").forEach(btn => btn.addEventListener("click", () => setStep(btn.dataset.step)));
}

function setStep(step) {
  const target = steps.find(s => s.id === step) || steps[0];
  state.activeStep = target.id;
  $$(".section-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === target.id));
  $$("[data-step]").forEach(btn => btn.classList.toggle("active", btn.dataset.step === target.id));
  $("#section-title").textContent = target.title;
  $("#section-kicker").textContent = target.kicker;
  scheduleSave();
}

function renderProfileOptions() {
  const select = $("#profile-select");
  select.innerHTML = Object.entries(state.profiles).map(([id, p]) => `<option value="${escapeHtml(id)}">${escapeHtml(p.name || p.ammo || id)}</option>`).join("");
  select.value = state.currentProfileId;
}

function renderAmmoPresets() {
  const select = $("#ammo-preset");
  select.innerHTML = `<option value="">选择常用弹种</option>` + Object.entries(ammoPresets)
    .map(([id, p]) => `<option value="${id}">${escapeHtml(p.name)}</option>`)
    .join("");
}

function renderZoneToggles() {
  const host = $("#hud-zone-toggles");
  host.innerHTML = Object.entries(zoneLabels).map(([key, label]) => `
    <label class="toggle-pill">
      <input type="checkbox" data-zone-key="${key}">
      <span>${escapeHtml(label)}</span>
    </label>
  `).join("");
  host.querySelectorAll("input").forEach(input => {
    input.checked = !!state.hud.zones[input.dataset.zoneKey];
    input.addEventListener("change", () => {
      state.hud.zones[input.dataset.zoneKey] = input.checked;
      refreshAll();
    });
  });
}

function refreshAll(options = {}) {
  renderProfileOptions();
  writeBindings(options.fromInput);
  syncZoneInputs();
  const input = buildBallisticInput(state);
  const jsSolution = solvePreview(input);
  state.lastSolution = jsSolution;
  renderPreview(input, state.lastSolution);
  renderDeviceMetrics();
  renderSyncSummary(input);
  renderProfileInfo();
  scheduleSave();
  scheduleBridgeSolve(input);
}

let solveTimer = null;
function scheduleBridgeSolve(input) {
  if (state.connection.mode !== "local-bridge") return;
  if (solveTimer) clearTimeout(solveTimer);
  solveTimer = setTimeout(async () => {
    try {
      const bridge = adapter instanceof LocalBridgeAdapter ? adapter : new LocalBridgeAdapter(state.connection, log);
      const result = await bridge.solveLocal(input);
      state.lastSolution = { ...state.lastSolution, ...result };
      $("#metric-solver").textContent = "LOCAL-C";
      renderPreview(input, state.lastSolution);
    } catch {
      $("#metric-solver").textContent = "JS";
    }
  }, 250);
}

function writeBindings(activeElement) {
  $$("[data-bind]").forEach(el => {
    if (el === activeElement) return;
    const value = getPath(state, el.dataset.bind);
    if (el.type === "checkbox") {
      el.checked = !!value;
      return;
    }
    const text = value === undefined || value === null ? "" : String(value);
    if (el.value !== text) el.value = text;
  });
}

function syncZoneInputs() {
  $$("#hud-zone-toggles input").forEach(input => {
    input.checked = !!state.hud.zones[input.dataset.zoneKey];
  });
}

function renderPreview(input, solution) {
  const units = state.hud.units;
  const dist = fmtDistance(input.range_m, units);
  const wind = Math.abs(Number(solution.windage_mil) || 0);
  const primaryRange = !toBool(state.hud.swapRangeWind);
  $("#hud-primary-label").textContent = primaryRange ? "DIST" : "WIND";
  $("#hud-primary-value").textContent = primaryRange ? dist.value : wind.toFixed(1);
  $("#hud-primary-unit").textContent = primaryRange ? dist.unit : "DOT";
  $("#hud-secondary-label").textContent = primaryRange ? "WIND" : "DIST";
  $("#hud-secondary-value").textContent = primaryRange ? wind.toFixed(1) : dist.value;
  $("#hud-secondary-unit").textContent = primaryRange ? "DOT" : dist.unit;
  $("#hud-angle").textContent = Math.round(input.angle_deg);

  const status = shotStatusText(solution.shot_status);
  $("#shot-state").textContent = status;
  $("#shot-energy").textContent = `${Math.round(solution.energy_j || 0)} J`;
  $("#shot-margin").textContent = solution.min_energy_j > 0 ? `${solution.shot_margin_pct >= 0 ? "+" : ""}${Math.round(solution.shot_margin_pct)}%` : "OFF";
  $("#solve-strip").classList.toggle("bad", status === "NO SHOT");
  $("#solve-strip").classList.toggle("warn", status === "MARGINAL");

  const fault = hudFaultText(solution.hud_fault);
  $("#hud-fault").textContent = fault;
  $("#hud-fault").classList.toggle("show", !!fault);
  $("#shot-x").classList.toggle("show", !!solution.show_x);
  $("#aim-dot").classList.toggle("show", !!solution.show_aim_dot && !solution.show_x);
  $("#aim-dot").style.left = `${Number(solution.reticle_x_pct || 50).toFixed(2)}%`;
  $("#aim-dot").style.top = `${Number(solution.reticle_y_pct || 50).toFixed(2)}%`;

  const previewTarget = $("#preview-target");
  previewTarget.className = `target-shape target-${state.target.type || "deer"}`;
  const scale = targetScale(input);
  previewTarget.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

  $("#metric-aim").textContent = fault || (solution.show_x ? "SCI X" : `R${solution.reticle_row ?? "--"} C${solution.reticle_col ?? "--"}`);
  $("#metric-velocity").textContent = `${Math.round(solution.final_velocity_ms || 0)} m/s`;
  $("#metric-windage").textContent = `${Number(solution.windage_mil || 0).toFixed(2)} mil`;
  $("#metric-reticle").textContent = `${solution.reticle_side < 0 ? "L" : solution.reticle_side > 0 ? "R" : "C"} ${solution.reticle_row ?? "--"}/${solution.reticle_col ?? "--"}`;

  applyHudZoneVisibility();
}

function applyHudZoneVisibility() {
  const zones = state.hud.zones;
  $("#preview-hud-top").classList.toggle("hide-distance", !zones.distance);
  $("#preview-hud-top").classList.toggle("hide-wind", !zones.wind);
  $("#preview-hud-top").classList.toggle("hide-angle", !zones.angle);
  $("#shot-x").classList.toggle("disabled-zone", !zones.sci);
}

function buildReticle() {
  const host = $("#reticle-dots");
  host.innerHTML = "";
  const rowCounts = [1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6];
  rowCounts.forEach((count, row) => {
    const y = 30 + row * 3.1;
    for (let col = 0; col < count; col += 1) {
      const dx = 4.8 + col * 3.5;
      host.appendChild(dot(50 - dx, y));
      host.appendChild(dot(50 + dx, y));
    }
  });
  host.appendChild(dot(50, 29));
  host.appendChild(dot(50, 48));
  host.appendChild(dot(50, 82));
}

function dot(x, y) {
  const el = document.createElement("span");
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  return el;
}

function renderDeviceMetrics() {
  $("#adapter-label").textContent = state.connection.mode === "web-bluetooth" ? "浏览器 BLE" : "上位机 Bridge";
  const m = state.lastMeasurement;
  $("#metric-range").textContent = m ? `${Number(m.distance_m).toFixed(1)} m` : `${Number(state.target.range_m).toFixed(1)} m`;
  $("#metric-battery").textContent = m?.battery ? `${m.battery} 格` : "--";
  $("#metric-env").textContent = `${Math.round(densityAltitude(state.environment))} m DA`;
}

function renderSyncSummary(input) {
  const profile = currentProfile(state);
  $("#sync-summary").innerHTML = `
    <div><span>Profile</span><strong>${escapeHtml(profile.name || profile.ammo)}</strong></div>
    <div><span>弹道</span><strong>${escapeHtml(profile.model)} / BC ${Number(profile.bc).toFixed(3)}</strong></div>
    <div><span>DOPE 预览</span><strong>${Math.round(input.range_m)} m / ${Math.round(input.min_energy_j)} J</strong></div>
    <div><span>HUD</span><strong>${Object.values(state.hud.zones).filter(Boolean).length}/10 区开启</strong></div>
  `;
}

function renderProfileInfo() {
  const host = $("#profile-info");
  if (!host) return;
  const profile = currentProfile(state);
  const preset = Object.values(ammoPresets).find(p => p.name === profile.name || p.ammo === profile.ammo);
  const intro = preset || profileIntroCatalog[profile.name] || profileIntroCatalog[profile.ammo] || {
    role: "自定义枪弹组合",
    summary: "这是用户自定义 Profile。正式使用前需要用测速仪、靶纸和参考弹道表校准初速、BC、镜高和归零距离。"
  };
  const energy = Number(profile.min_energy_j) || 0;
  host.innerHTML = `
    <div class="profile-info-main">
      <span>${escapeHtml(intro.role || "枪弹组合")}</span>
      <strong>${escapeHtml(profile.name || profile.ammo || "Profile")}</strong>
      <p>${escapeHtml(intro.summary || "")}</p>
    </div>
    <div class="profile-info-specs">
      <div><span>模型</span><strong>${escapeHtml(profile.model || "--")}</strong></div>
      <div><span>BC</span><strong>${Number(profile.bc || 0).toFixed(3)}</strong></div>
      <div><span>初速</span><strong>${Math.round(Number(profile.velocity_ms) || 0)} m/s</strong></div>
      <div><span>阈值</span><strong>${energy > 0 ? `${Math.round(energy)} J` : "OFF"}</strong></div>
    </div>
  `;
}

async function connect() {
  try {
    setConnectionState("working", "连接中");
    adapter = makeAdapter();
    const r = await adapter.connect();
    setConnectionState(r.connected ? "on" : "bridge", r.name || "已就绪");
  } catch (err) {
    setConnectionState("off", "连接失败");
    log("ERR", err.message || err);
  }
}

async function disconnect() {
  try {
    if (adapter) await adapter.disconnect();
  } catch (err) {
    log("ERR", err.message || err);
  }
  setConnectionState("off", "未连接");
}

async function readEnvironment() {
  try {
    if (!adapter) adapter = makeAdapter();
    const env = await adapter.readEnvironment();
    state.environment.altitude_m = round(env.altitude_m, 1);
    state.environment.temp_c = round(env.temp_c, 1);
    state.environment.humidity_pct = round(env.humidity_pct, 1);
    state.environment.pressure_pa = Math.round(env.pressure_pa);
    log("SYS", "环境已回填");
    refreshAll();
  } catch (err) {
    log("ERR", err.message || err);
  }
}

async function listenMeasurement() {
  try {
    if (!adapter) adapter = makeAdapter();
    const m = await adapter.listenMeasurement(5);
    state.lastMeasurement = m;
    state.target.range_m = round(m.distance_m, 1);
    log("SYS", `测距已回填: ${state.target.range_m} m`);
    refreshAll();
  } catch (err) {
    log("ERR", err.message || err);
  }
}

async function solveLocal() {
  try {
    const bridge = adapter instanceof LocalBridgeAdapter ? adapter : new LocalBridgeAdapter(state.connection, log);
    const result = await bridge.solveLocal(buildBallisticInput(state));
    state.lastSolution = { ...state.lastSolution, ...result };
    $("#metric-solver").textContent = "LOCAL-C";
    renderPreview(buildBallisticInput(state), state.lastSolution);
    log("SYS", "本地 C 解算已回填");
  } catch (err) {
    log("ERR", err.message || err);
  }
}

async function solveDevice() {
  try {
    if (!adapter) adapter = makeAdapter();
    const result = await adapter.solveDevice(buildBallisticInput(state));
    state.lastSolution = { ...state.lastSolution, ...result };
    $("#metric-solver").textContent = "DEVICE";
    renderPreview(buildBallisticInput(state), state.lastSolution);
    log("SYS", "设备解算已回填");
  } catch (err) {
    log("ERR", err.message || err);
  }
}

async function syncProfile() {
  try {
    if (!adapter) adapter = makeAdapter();
    await adapter.syncProfile(currentProfile(state), state.hud);
    log("SYS", "Profile 已同步");
  } catch (err) {
    if (String(err.message || err).includes("PROFILE_WRITE_NOT_DEFINED")) {
      log("WARN", "固件 Profile/DOPE 写入命令未定版，当前只保存本地配置");
    } else {
      log("ERR", err.message || err);
    }
  }
}

function makeAdapter() {
  return state.connection.mode === "local-bridge"
    ? new LocalBridgeAdapter(state.connection, log)
    : new WebBluetoothAdapter(state.connection, log);
}

function setConnectionState(kind, label) {
  $("#status-dot").className = `status-dot ${kind}`;
  $("#connection-label").textContent = label;
}

function newProfile() {
  const base = currentProfile(state);
  const id = makeProfileId(base.name || base.ammo);
  state.profiles[id] = { ...base, name: `${base.name || "Profile"} Copy` };
  state.currentProfileId = id;
  refreshAll();
}

function deleteProfile() {
  if (state.currentProfileId === "default") {
    log("WARN", "default Profile 不能删除");
    return;
  }
  delete state.profiles[state.currentProfileId];
  state.currentProfileId = "default";
  refreshAll();
}

function applyAmmoPreset(id) {
  if (!id || !ammoPresets[id]) return;
  setCurrentProfile(state, ammoPresets[id]);
  $("#ammo-preset").value = "";
  refreshAll();
}

function exportProfile() {
  const profile = currentProfile(state);
  const blob = new Blob([JSON.stringify({ profile, hud: state.hud }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${profile.name || "scope-profile"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importProfile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const profile = data.profile || data;
    const id = makeProfileId(profile.name || profile.ammo || "imported");
    state.profiles[id] = { ...currentProfile(state), ...profile };
    state.currentProfileId = id;
    if (data.hud) state.hud = { ...state.hud, ...data.hud, zones: { ...state.hud.zones, ...(data.hud.zones || {}) } };
    refreshAll();
    log("SYS", `已导入 ${profile.name || profile.ammo || id}`);
  } catch (err) {
    log("ERR", `导入失败: ${err.message}`);
  } finally {
    event.target.value = "";
  }
}

function applyTargetDefaults(overwrite = true) {
  const presets = {
    deer: { width_m: 1.25, min_energy_j: 1000 },
    sheep: { width_m: 1.05, min_energy_j: 850 },
    boar: { width_m: 0.95, min_energy_j: 900 },
    steel: { width_m: 0.45, min_energy_j: 0 }
  };
  const p = presets[state.target.type] || presets.deer;
  if (overwrite || !state.target.width_m) state.target.width_m = p.width_m;
}

function openLegacyHud() {
  try {
    localStorage.setItem("scope_hud_profiles", JSON.stringify(state.profiles));
    localStorage.setItem("scope_hud_cur_profile", state.currentProfileId);
  } catch {}
  const url = "http://127.0.0.1:8899/web/pages/scope_hud.html";
  window.open(url, "_blank", "noopener");
}

function readElement(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.dataset.number !== undefined) return Number(el.value);
  if (el.value === "true") return true;
  if (el.value === "false") return false;
  return el.value;
}

function getPath(obj, path) {
  if (path.startsWith("profile.")) {
    return currentProfile(state)?.[path.slice("profile.".length)];
  }
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function setPath(obj, path, value) {
  if (path.startsWith("profile.")) {
    currentProfile(state)[path.slice("profile.".length)] = value;
    return;
  }
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) cur = cur[parts[i]];
  cur[parts[parts.length - 1]] = value;
}

function scheduleSave(immediate = false) {
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) {
    saveState(state);
    return;
  }
  saveTimer = setTimeout(() => saveState(state), 120);
}

function log(kind, message) {
  const host = $("#log-box");
  if (!host) return;
  const line = document.createElement("div");
  line.className = `log-line ${kind.toLowerCase()}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${kind}: ${message}`;
  host.appendChild(line);
  host.scrollTop = host.scrollHeight;
}

function fmtDistance(m, units) {
  if (units === "imperial") return { value: String(Math.round(Number(m) * 1.09361)), unit: "Y" };
  return { value: String(Math.round(Number(m))), unit: "M" };
}

function targetScale(input) {
  const width = Math.max(0.2, Number(input.target_width_m) || 1.25);
  const range = Math.max(20, Number(input.range_m) || 300);
  const zoom = Math.max(4, Math.min(20, Number(input.zoom_x) || 10));
  const poseScale = input.target_pose === "frontal" ? 0.44 : (input.target_pose === "quartering" ? 0.72 : 1);
  return Math.max(0.2, Math.min(1.3, (width / range) * zoom * 34 * poseScale));
}

function toBool(value) {
  return value === true || value === "true";
}

function round(value, digits = 0) {
  const n = Number(value);
  const f = 10 ** digits;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
