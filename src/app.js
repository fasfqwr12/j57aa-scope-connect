import { LocalBridgeAdapter } from "./adapters/local-bridge.js?v=ballistic-tx-1";
import { WebBluetoothAdapter } from "./adapters/web-bluetooth.js?v=ballistic-tx-1";
import { buildBallisticInput, densityAltitude, hudFaultText, shotStatusText } from "./core/ballistics.js?v=nojs-1";
import { ammoPresets, currentProfile, loadState, makeProfileId, profileIntroCatalog, saveState, setCurrentProfile } from "./core/profile-store.js?v=20260616_closure1";
import { initMobileScreens } from "./ui/mobile-screens.js?v=mobile-screen-12";
import { initAdminLog } from "./ui/admin-log.js?v=admin-log-1";
import { initTestApi } from "./debug/test-api.js?v=admin-log-2";
import { initOtaUpgrade } from "./upgrade/ota-ui.js?v=inline-15";

const steps = [
  { id: "device", label: "设备", title: "设备连接", kicker: "DEVICE" },
  { id: "profile", label: "弹药", title: "弹药 Profile", kicker: "PROFILE" },
  { id: "environment", label: "环境", title: "环境参数", kicker: "ENV" },
  { id: "target", label: "目标", title: "目标 / SCI", kicker: "TARGET" },
  { id: "hud", label: "HUD", title: "HUD 显示", kicker: "HUD" },
  { id: "sync", label: "解算", title: "弹道解算", kicker: "SOLVE" },
  { id: "upgrade", label: "升级", title: "固件升级", kicker: "OTA" }
];

const pageDescriptions = {
  device: "连接设备，查看链路与设备信息。",
  profile: "管理本地配置，修改后保存到当前 Profile。",
  environment: "集中管理环境输入与数据来源。",
  target: "查看当前目标配置与本地参数。",
  hud: "调整显示布局，在预览区查看效果。",
  sync: "选数据源 → 点解算 → 看结果表或协议原文。",
  upgrade: "先检测双板状态，再核验文件并确认更新。"
};
const ASSET_V = "status-first-1";
const targetAssets = { deer: "deer", sheep: "sheep", boar: "boar", steel: "steel" };

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
let adapterMode = null;
let solveTimer = null;
let saveTimer = null;
let otaBusy = false;
let connecting = false;
let mobileScreens = null;
let adminTap = null;

const $ = selector => document.querySelector(selector);
// 版本标记直接取入口 URL 的 ?v=，与缓存链同源，不会写错
const BUILD_VERSION = (import.meta.url.match(/[?&]v=([^&]+)/) || [])[1] || '';
const $$ = selector => Array.from(document.querySelectorAll(selector));

init();

function init() {
  renderSteps();
  renderProfileOptions();
  renderAmmoPresets();
  renderZoneToggles();
  mobileScreens = initMobileScreens();
  adminTap = initAdminLog();
  initTestApi({
    getAdapter: () => adapter,
    setAdapter: value => { adapter = value; },
    setStatus: (kind, label) => setConnectionState(kind, label),
    getTap: () => adminTap,
    getOtaState: () => window.__otaOtaState?.()
  });
  bindForms();
  bindActions();
  buildReticle();
  const buildTag = $("#build-tag");
  if (buildTag) buildTag.textContent = BUILD_VERSION || "dev";
  const sourceSel = $("#solve-source");
  if (sourceSel) {
    sourceSel.value = state.solveSource || (state.connection.mode === "local-bridge" ? "bridge" : "device");
    state.solveSource = sourceSel.value;
  }
  renderSolveResult(null, null);
  setStep(state.activeStep || "device");
  refreshAll();
  initOtaUpgrade({
    getAdapter: () => adapter,
    connect,
    isConnected: () => !!(adapter && adapter.connected),
    setBusy: value => {
      otaBusy = value;
      $$("#btn-connect, #btn-connect-panel, #btn-hint-connect, #btn-disconnect, #btn-read-env, #btn-read-env-panel, #btn-listen-range, #btn-solve-device, #btn-sync-profile, [data-bind^='connection.']").forEach(el => { el.disabled = value; });
      if (value) setConnBanner("busy", "检测/升级进行中，蓝牙与连接按钮暂时锁定；结束后会恢复");
      else clearConnBanner("busy");
    }
  });
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
  $("#btn-solve-run").addEventListener("click", solveFromUi);
  $("#btn-solve-protocol").addEventListener("click", toggleProtocol);
  $("#solve-source").addEventListener("change", ev => {
    // 切换数据源后旧结果作废，必须重新解算，避免把设备结果当上位机结果看
    state.solveSource = ev.target.value;
    state.lastSolution = null;
    state.lastSolveMeta = null;
    scheduleSave();
    renderSolveResult(null, null);
    renderPreview(buildBallisticInput(state), null);
  });
  $("#btn-clear-log").addEventListener("click", () => { $("#log-box").innerHTML = ""; });
  $("#btn-open-hud").addEventListener("click", openLegacyHud);
  $("#btn-hint-connect").addEventListener("click", connect);
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
  stepList.innerHTML = steps.map(s => `
    <button class="step-item" data-step="${s.id}" type="button" title="${s.title}">
      <svg class="step-icon" aria-hidden="true"><use href="#i-${s.id}"/></svg>
      <strong>${s.label}</strong>
    </button>
  `).join("");
  mobile.innerHTML = steps.map(s => `<button data-step="${s.id}" type="button"><svg><use href="#i-${s.id}" xlink:href="#i-${s.id}"/></svg>${s.label}</button>`).join("");
  $$("[data-step]").forEach(btn => btn.addEventListener("click", () => setStep(btn.dataset.step)));
}

function setStep(step) {
  const target = steps.find(s => s.id === step) || steps[0];
  state.activeStep = target.id;
  document.body.dataset.page = target.id;
  $(".preview-rail").hidden = target.id === "upgrade";
  $$(".section-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === target.id));
  $$("[data-step]").forEach(btn => {
    const active = btn.dataset.step === target.id;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  $("#section-title").textContent = target.title;
  $("#section-kicker").textContent = target.kicker;
  $("#section-description").textContent = pageDescriptions[target.id];
  scheduleSave();
  mobileScreens?.show(target.id);
  $(".workspace").scrollTop = 0;
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
    input.closest(".toggle-pill").classList.toggle("on", input.checked);
    input.addEventListener("change", () => {
      state.hud.zones[input.dataset.zoneKey] = input.checked;
      input.closest(".toggle-pill").classList.toggle("on", input.checked);
      refreshAll();
    });
  });
}

function refreshAll(options = {}) {
  renderProfileOptions();
  writeBindings(options.fromInput);
  syncZoneInputs();
  const input = buildBallisticInput(state);
  // 网页不做本地解算：结果只能来自设备（BLE）或上位机 C 核（Bridge）；参数一变旧结果立即失效
  state.lastSolution = null;
  renderPreview(input, null);
  renderDeviceMetrics();
  renderSyncSummary(input);
  renderProfileInfo();
  scheduleSave();
  scheduleBridgeSolve(input);
}

function scheduleBridgeSolve(input) {
  if (state.connection.mode !== "local-bridge") return;
  if (state.solveSource === "device") return;   // 数据源选设备时不打扰，等用户手动点解算
  if (solveTimer) clearTimeout(solveTimer);
  solveTimer = setTimeout(async () => {
    try {
      const bridge = adapter instanceof LocalBridgeAdapter ? adapter : new LocalBridgeAdapter(state.connection, log);
      const t0 = performance.now();
      const result = await bridge.solveLocal(input);
      const ms = Math.round(performance.now() - t0);
      state.lastSolution = { ...result, solveSource: "bridge" };
      state.lastSolveMeta = { source: "bridge", at: stamp(), ms, request: input, response: result };
      renderPreview(input, state.lastSolution);
      renderSolveResult(state.lastSolution, state.lastSolveMeta);
      log("SYS", `上位机 C 核解算已回填：${result.version || "ballistics_core"}`);
    } catch (err) {
      state.lastSolution = null;
      renderPreview(input, null);
      renderSolveResult(null, { source: "bridge", at: stamp(), error: err.message || String(err), request: input });
      log("WARN", `上位机 C 核解算失败：${err.message || err}（检查上位机是否在 ${state.connection.bridgeBase || "http://127.0.0.1:8766"} 运行）`);
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
    input.closest(".toggle-pill").classList.toggle("on", input.checked);
  });
}

function renderPreview(input, solution) {
  const units = state.hud.units;
  const ok = !!solution;
  const dist = fmtDistance(input.range_m, units);
  const wind = Math.abs(Number(solution?.windage_mil) || 0);
  const primaryRange = !toBool(state.hud.swapRangeWind);
  $("#hud-primary-label").textContent = primaryRange ? "DIST" : "WIND";
  $("#hud-primary-value").textContent = primaryRange ? dist.value : (ok ? wind.toFixed(1) : "--");
  $("#hud-primary-unit").textContent = primaryRange ? dist.unit : "DOT";
  $("#hud-secondary-label").textContent = primaryRange ? "WIND" : "DIST";
  $("#hud-secondary-value").textContent = primaryRange ? (ok ? wind.toFixed(1) : "--") : dist.value;
  $("#hud-secondary-unit").textContent = primaryRange ? "DOT" : dist.unit;
  $("#hud-angle").textContent = Math.round(input.angle_deg);

  const status = ok ? shotStatusText(solution.shot_status) : "未连接";
  $("#shot-state").textContent = status;
  $("#shot-energy").textContent = ok ? `${Math.round(solution.energy_j || 0)} J` : "-- J";
  $("#shot-margin").textContent = ok
    ? (solution.min_energy_j > 0 ? `${solution.shot_margin_pct >= 0 ? "+" : ""}${Math.round(solution.shot_margin_pct)}%` : "OFF")
    : "--";
  $("#solve-strip").classList.toggle("bad", ok && status === "NO SHOT");
  $("#solve-strip").classList.toggle("warn", ok && status === "MARGINAL");

  const fault = ok ? hudFaultText(solution.hud_fault) : "";
  $("#hud-fault").textContent = fault;
  $("#hud-fault").classList.toggle("show", !!fault);
  $("#shot-x").classList.toggle("show", !!solution?.show_x);
  $("#aim-dot").classList.toggle("show", !!solution?.show_aim_dot && !solution?.show_x);
  $("#aim-dot").style.left = ok ? `${Number(solution.reticle_x_pct || 50).toFixed(2)}%` : "50%";
  $("#aim-dot").style.top = ok ? `${Number(solution.reticle_y_pct || 50).toFixed(2)}%` : "48%";
  $("#metric-solver").textContent = ok ? (solution.solveSource === "device" ? "设备" : solution.solveSource === "bridge" ? "上位机 C" : "外部") : "—";

  const previewTarget = $("#preview-target");
  previewTarget.className = `target-shape target-${state.target.type || "deer"}`;
  const targetImg = $("#target-img");
  if (targetImg && targetImg.dataset.type !== (state.target.type || "deer")) {
    targetImg.dataset.type = state.target.type || "deer";
    targetImg.src = `./assets/targets/${targetAssets[state.target.type] || "deer"}.svg?v=${ASSET_V}`;
  }
  const scale = targetScale(input);
  previewTarget.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

  $("#metric-aim").textContent = ok ? (fault || (solution.show_x ? "SCI X" : `R${solution.reticle_row ?? "--"} C${solution.reticle_col ?? "--"}`)) : "--";
  $("#metric-velocity").textContent = ok ? `${Math.round(solution.final_velocity_ms || 0)} m/s` : "-- m/s";
  $("#metric-windage").textContent = ok ? `${Number(solution.windage_mil || 0).toFixed(2)} mil` : "-- mil";
  $("#metric-reticle").textContent = ok
    ? `${solution.reticle_side < 0 ? "L" : solution.reticle_side > 0 ? "R" : "C"} ${solution.reticle_row ?? "--"}/${solution.reticle_col ?? "--"}`
    : "--";

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

function renderSyncSummary() {
  // 同步摘要已并入「弹道解算」卡，仅在旧布局存在时渲染
  const host = $("#sync-summary");
  if (!host) return;
  const profile = currentProfile(state);
  host.innerHTML = `
    <div><span>Profile</span><strong>${escapeHtml(profile.name || profile.ammo)}</strong></div>
    <div><span>弹道</span><strong>${escapeHtml(profile.model)} / BC ${Number(profile.bc).toFixed(3)}</strong></div>
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
  if (connecting || adapter?.exclusive) {
    setConnBanner("warn", adapter?.exclusive ? "检测/升级正在进行，蓝牙通道被独占；等它结束后再连接" : "正在连接中，请稍候");
    log("WARN", "连接/检测/升级进行中，不更换设备");
    return;
  }
  const mode = state.connection.mode === "local-bridge" ? "local-bridge" : "web-bluetooth";
  if (mode === "web-bluetooth" && !globalThis.navigator?.bluetooth) {
    setConnBanner("error", "当前浏览器不支持 Web Bluetooth：请改用 Android / 电脑版 Chrome 或 Edge；iOS Safari、微信、QQ 等内置浏览器不支持蓝牙升级");
    log("ERR", "当前浏览器不支持 Web Bluetooth");
    return;
  }
  connecting = true;
  // 复用同一适配器：换设备时由适配器先弹选择框再断开旧链路，
  // 保证 requestDevice 紧贴点击手势（否则手机端会静默不弹框）。
  if (!adapter || adapterMode !== mode) { adapter = makeAdapter(); adapterMode = mode; }
  setConnBanner("info", mode === "web-bluetooth"
    ? "正在唤起浏览器设备选择框，请在扫描结果里选中 E104-BT5005A…"
    : "正在连接上位机 Bridge…");
  try {
    setConnectionState("working", "连接中");
    const r = await adapter.connect();
    setConnectionState(r.connected ? "on" : "bridge", r.name || "已就绪");
    setConnBanner("", "");
  } catch (err) {
    setConnectionState("off", "连接失败");
    setConnBanner("error", err.message || String(err));
    log("ERR", err.message || err);
  } finally { connecting = false; }
}

async function disconnect() {
  if (otaBusy) { log("WARN", "请先中止检测/升级，等待清理完成"); return; }
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

function solveFromUi() {
  return $("#solve-source")?.value === "bridge" ? solveLocal() : solveDevice();
}

async function solveLocal() {
  const input = buildBallisticInput(state);
  try {
    const bridge = new LocalBridgeAdapter(state.connection, log);
    const t0 = performance.now();
    const result = await bridge.solveLocal(input);
    const ms = Math.round(performance.now() - t0);
    state.lastSolution = { ...result, solveSource: "bridge" };
    state.lastSolveMeta = { source: "bridge", at: stamp(), ms, request: input, response: result };
    renderSolveResult(state.lastSolution, state.lastSolveMeta);
    renderPreview(input, state.lastSolution);
    log("SYS", `上位机 C 核解算完成（${ms}ms）`);
  } catch (err) {
    state.lastSolution = null;
    state.lastSolveMeta = { source: "bridge", at: stamp(), error: err.message || String(err), request: input };
    renderSolveResult(null, state.lastSolveMeta);
    renderPreview(input, null);
    log("ERR", `上位机解算失败：${err.message || err}（确认上位机在 ${state.connection.bridgeBase || "http://127.0.0.1:8766"} 运行）`);
  }
}

async function solveDevice() {
  const input = buildBallisticInput(state);
  try {
    if (!adapter) adapter = makeAdapter();
    // BLE 模式必须已连设备；Bridge 模式由上位机自己判断链路（它可能已经连着瞄具）
    if (state.connection.mode !== "local-bridge" && !adapter.connected) {
      throw new Error("设备未连接：先在「设备」页连接 BLE，再点解算");
    }
    const t0 = performance.now();
    const result = await adapter.solveDevice(input);
    const ms = Math.round(performance.now() - t0);
    state.lastSolution = { ...result, solveSource: "device" };
    state.lastSolveMeta = { source: "device", at: stamp(), ms, request: input, response: result };
    renderSolveResult(state.lastSolution, state.lastSolveMeta);
    renderPreview(input, state.lastSolution);
    log("SYS", `设备解算完成（${ms}ms，${state.connection.mode === "local-bridge" ? "上位机转发 BLE" : "BLE"}）`);
  } catch (err) {
    state.lastSolution = null;
    const stage = err.detail?.stage ? `（阶段 ${err.detail.stage}）` : "";
    state.lastSolveMeta = {
      source: "device", at: stamp(), error: `${err.message || err}${stage}`, request: input,
      response: err.detail || (err.trace ? { trace: err.trace } : null)
    };
    renderSolveResult(null, state.lastSolveMeta);
    renderPreview(input, null);
    log("ERR", `设备解算失败：${err.message || err}${stage}`);
  }
}

function stamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

// 解算结果表：字段口径对齐上位机 ballistics_core 输出，未解算一律空值
function renderSolveResult(solution, meta) {
  const pill = $("#solve-pill");
  if (pill) {
    pill.textContent = solution ? (meta?.source === "device" ? "设备解算" : "上位机 C 核") : "未解算";
    pill.className = `source-pill${solution ? " live" : ""}`;
  }
  const banner = $("#solve-banner");
  if (banner) {
    if (meta?.error) {
      banner.hidden = false; banner.dataset.kind = "error";
      banner.textContent = meta.error;
    } else if (solution) {
      banner.hidden = false; banner.dataset.kind = "info";
      banner.textContent = `${meta?.source === "device" ? "设备解算（BLE）" : "上位机 C 核（Bridge）"} · ${meta?.ms ?? "-"} ms · ${meta?.at ?? ""}`;
    } else {
      banner.hidden = true; banner.textContent = ""; banner.removeAttribute("data-kind");
    }
  }
  const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  const ids = ["#sv-drop", "#sv-wind", "#sv-time", "#sv-vel", "#sv-energy", "#sv-margin", "#sv-reticle", "#sv-dot", "#sv-status", "#sv-fault", "#sv-density", "#sv-canshoot"];
  if (!solution) { ids.forEach(id => set(id, "--")); return; }
  const mil = v => `${Number(v || 0).toFixed(2)} mil`;
  const moa = v => `${Number(v || 0).toFixed(2)} moa`;
  set("#sv-drop", `${mil(solution.elevation_mil)} / ${moa(solution.elevation_moa)}`);
  set("#sv-wind", `${mil(solution.windage_mil)} / ${moa(solution.windage_moa)}`);
  set("#sv-time", `${Number(solution.time_s || 0).toFixed(3)} s`);
  set("#sv-vel", `${Math.round(solution.final_velocity_ms || 0)} m/s`);
  set("#sv-energy", `${Math.round(solution.energy_j || 0)} J`);
  set("#sv-margin", solution.min_energy_j > 0 ? `${Math.round(solution.shot_margin_pct)}%` : "OFF");
  set("#sv-reticle", solution.reticle_row == null ? "--" : `${solution.reticle_side < 0 ? "L" : solution.reticle_side > 0 ? "R" : "C"} ${solution.reticle_row}/${solution.reticle_col}`);
  set("#sv-dot", solution.reticle_x_pct == null ? "--" : `${Number(solution.reticle_x_pct).toFixed(1)}% / ${Number(solution.reticle_y_pct).toFixed(1)}%`);
  set("#sv-status", `${shotStatusText(solution.shot_status)}${solution.shot_status == null ? "" : ` (#${solution.shot_status})`}`);
  set("#sv-fault", hudFaultText(solution.hud_fault) || "无");
  set("#sv-density", solution.density_kg_m3 ? `${Number(solution.density_kg_m3).toFixed(3)} kg/m³` : "--");
  set("#sv-canshoot", solution.can_shoot == null ? "--" : (solution.can_shoot ? "是" : "否"));
  const proto = $("#solve-protocol");
  if (proto && !proto.hidden) renderProtocol(meta);
}

function protocolMethod(source) {
  return source === "device"
    ? "scope_ballistic_solve（经主控代理下发瞄具）"
    : "scope_ballistic_solve_local（上位机 C 核）";
}

function renderProtocol(meta) {
  const el = $("#solve-protocol");
  if (!el) return;
  if (!meta) { el.textContent = "尚未解算。点「解算」后此处显示请求与响应原文。"; return; }
  el.textContent = [
    `# 请求 method = ${protocolMethod(meta.source)}`,
    JSON.stringify(meta.request ?? null, null, 2),
    "",
    `# 响应${meta.error ? "（失败）" : ""}`,
    JSON.stringify(meta.error
      ? { success: false, error: meta.error, detail: meta.response ?? null }
      : meta.response ?? null, null, 2)
  ].join("\n");
}

function toggleProtocol() {
  const el = $("#solve-protocol");
  if (!el) return;
  el.hidden = !el.hidden;
  if (!el.hidden) renderProtocol(state.lastSolveMeta);
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
  const a = state.connection.mode === "local-bridge"
    ? new LocalBridgeAdapter(state.connection, log)
    : new WebBluetoothAdapter(state.connection, log);
  if (adminTap) a.tap = adminTap;
  return a;
}

function setConnectionState(kind, label) {
  $("#status-dot").className = `status-dot ${kind}`;
  $("#connection-label").textContent = label;
  document.body.classList.toggle("ble-live", kind === "on" || kind === "bridge");
}

// 设备页连接横幅：把"扫描/连接"的进度和失败原因直接显示在按钮上方，
// 不再要求用户切到"同步"页翻日志才知道为什么没反应。
function setConnBanner(kind, text) {
  const el = $("#conn-banner");
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ""; el.removeAttribute("data-kind"); return; }
  el.hidden = false;
  el.dataset.kind = kind || "info";
  el.textContent = text;
}

function clearConnBanner(kind) {
  const el = $("#conn-banner");
  if (el && (!kind || el.dataset.kind === kind)) setConnBanner("", "");
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
  const preset = ammoPresets[id];
  setCurrentProfile(state, preset);
  if (preset.hud) state.hud = { ...state.hud, ...preset.hud };
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
