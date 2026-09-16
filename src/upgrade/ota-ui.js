import { W515OtaSession } from "./w515-ota.js?v=tuning-1";
import { N32OtaSession, n32Gate } from "./n32-ota.js?v=ver-1";
import { DeviceProbe, snapshotIsFresh, w515Gate } from "./device-probe.js?v=f7target-2";
import { inspectFirmware, inspectN32Firmware, validateFirmwareForDevice } from "./firmware-image.js?v=status-first-1";
import { firmwareDirectory, firmwareUrl, verifyDownload } from "./firmware-library.js?v=status-first-1";

const STAGES = ["probe", "enterboot", "info", "erase", "write", "verify", "reset", "done"];
const LABELS = ["检测双板", "进入 Boot", "核对窗口", "擦除", "ACK写入", "CRC校验", "确认 APP", "完成"];
const N32_STAGES = ["probe", "proxy", "enterboot", "erase", "write", "verify", "enterapp", "done"];
const N32_LABELS = ["检测双板", "启动代理", "副板进Boot", "擦除", "ACK写入", "CRC校验", "进APP确认", "完成"];
const MODE = { APP: "APP 运行", BOOT: "Boot 运行", UNKNOWN: "未确认", UNREACHABLE: "通路不可达" };
const ROUTE = { UNKNOWN: "未确认", INACTIVE: "未占用", BUSY: "已有会话占用", OWNED_NORMAL: "检测会话占用", RELEASED: "已确认释放", CLEANUP_UNCONFIRMED: "释放未确认", NOT_AVAILABLE_IN_BOOT: "当前 Boot 无代理" };
const $ = s => document.querySelector(s);
const hex = v => v == null ? "—" : "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
const version = v => v == null ? "—" : `${v >>> 8}.${v & 255}`;
let ctx, firmware = null, snapshot = null, busy = false, session = null, probeAbort = null, wakeLock = null;
let onlineSelection = null;
let target = "w515"; // 升级目标：w515 主控 / n32 副板
function selectTarget(value) {
  target = value;
  $("#ota-target-w515")?.classList.toggle("selected", value === "w515");
  $("#ota-target-n32")?.classList.toggle("selected", value === "n32");
  document.querySelector('input[name="ota-target"][value="' + (value === "n32" ? "n32" : "w515") + '"]')?.click();
  renderGate();
}

export function initOtaUpgrade(context) {
  ctx = context;
  $("#ota-query-status").addEventListener("click", detect);
  $("#ota-start").addEventListener("click", startUpgrade);
  $("#ota-abort").addEventListener("click", () => { session?.abort(); probeAbort?.abort(); otaLog("WARN", "已请求停止，等待当前写入结束和本会话清理"); });
  $("#ota-clear-log").addEventListener("click", () => { $("#ota-log-box").replaceChildren(); clearFeedback(); });
  $("#ota-firmware-file").addEventListener("change", async event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || busy) return;
    onlineSelection = null;
    setBusy(true);
    try {
      if (file.size > 6 * 1024 * 1024) throw new Error("文件过大，不是支持的 APP 镜像");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 目标自动识别：文件名含 N32 → 副板；否则按 W515 主控严格校验
      const isN32 = /N32|n32/.test(file.name) || (/_slave|slave_/i.test(file.name));
      firmware = isN32 ? inspectN32Firmware(bytes, file.name) : inspectFirmware(bytes, file.name);
      selectTarget(firmware.target === "n32-app" ? "n32" : "w515");
      renderFirmware();
    } catch (error) { firmware = null; renderFirmware(); otaLog("ERR", error.message); }
    finally { setBusy(false); }
  });
  $("#ota-main-only").addEventListener("change", renderGate);
  document.querySelectorAll('input[name="ota-target"]').forEach(radio => radio.addEventListener("change", () => {
    if (radio.checked) selectTarget(radio.value);
  }));
  $("#ota-online-refresh").addEventListener("click", () => { if (!busy) loadOnlineFirmware(); });
  // 传输档位：切换自定义显隐 + 记忆选择
  const presetSelect = $("#ota-preset");
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      const custom = $("#ota-tuning-custom");
      if (custom) custom.style.display = presetSelect.value === "custom" ? "" : "none";
      saveTuningChoice();
    });
    restoreTuningChoice();
    const custom = $("#ota-tuning-custom");
    if (custom) custom.style.display = presetSelect.value === "custom" ? "" : "none";
    document.querySelectorAll("#ota-tuning-custom input").forEach(input => input.addEventListener("change", saveTuningChoice));
  }
  window.addEventListener("beforeunload", event => { if (busy) { event.preventDefault(); event.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => {
    if (busy && document.hidden) { session?.abort(); probeAbort?.abort(); otaLog("WARN", "页面进入后台，已请求停止；返回后重新检测，不自动续写"); }
  });
  setInterval(() => {
    if (snapshot && (!ctx.getAdapter() || !snapshotIsFresh(snapshot, ctx.getAdapter()))) {
      snapshot = null; $("#ota-main-only").checked = false; renderSnapshot();
    }
    renderGate();
  }, 1000);
  renderSnapshot(); renderGate(); loadOnlineFirmware();
  // 管理员测试 API：升级页内部状态只读快照（配合 window.__ota）
  if (new URLSearchParams(location.search).get("admin") === "1") {
    window.__otaOtaState = () => ({
      target, busy, hasFirmware: !!firmware,
      firmwareName: firmware?.name || null, firmwareTarget: firmware?.target || null,
      firmwareBytes: firmware?.bytes?.length || 0,
      snapshot: snapshot && { mainMode: snapshot.main.mode, slaveMode: snapshot.slave.mode, proxy: snapshot.proxy.state, routeClear: snapshot.routeClear, deviceId: snapshot.deviceId }
    });
    // 固件库发布面板：上传新固件并更新在线清单
    import("./release-panel.js?v=rel-1").then(({ initReleasePanel }) =>
      initReleasePanel(() => { loadOnlineFirmware(); otaLog("SYS", "在线固件库已更新（GitHub Pages 部署约需 1-2 分钟）"); })
    ).catch(() => {});
  }
}
function otaLog(type, text) {
  const row = document.createElement("div"); row.className = "log-row"; row.dataset.level = type;
  row.textContent = `${new Date().toLocaleTimeString()} [${type}] ${text}`;
  const host = $("#ota-log-box"); host.append(row);
  while (host.children.length > 400) host.firstChild.remove();
  if (type === "ERR" || type === "WARN") {
    const feedback = $("#ota-feedback"), details = $("#ota-log-details");
    if (feedback) { feedback.textContent = `${type === "ERR" ? "操作失败" : "注意"}：${text}`; feedback.dataset.level = type; feedback.hidden = false; }
    if (details) details.open = true;
  }
  host.scrollTop = host.scrollHeight;
}
function clearFeedback() {
  const feedback = $("#ota-feedback");
  if (feedback) { feedback.hidden = true; feedback.textContent = ""; delete feedback.dataset.level; }
}
function setBusy(value) {
  if (value) clearFeedback();
  busy = value; ctx.setBusy?.(value);
  $("#ota-query-status").disabled = value;
  $("#ota-firmware-file").disabled = value;
  $("#ota-preset").disabled = value;
  $("#ota-online-refresh").disabled = value;
  $("#ota-main-only").disabled = value;
  $("#ota-abort").disabled = !value;
  document.querySelectorAll(".ota-online-item").forEach(el => { el.disabled = value; });
  renderGate();
}
async function adapterForProbe() {
  if (!ctx.isConnected()) await ctx.connect();
  const adapter = ctx.getAdapter();
  if (!adapter?.requestWire || !adapter.isGattConnected()) throw new Error("请先在设备页选择浏览器 BLE 并连接；Bridge 不提供此升级通道");
  return adapter;
}
async function keepAwake() {
  try { if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request("screen"); }
  catch { otaLog("WARN", "无法保持亮屏，请手动保持页面前台"); }
}
async function releaseAwake() {
  try { await wakeLock?.release(); }
  catch { otaLog("WARN", "亮屏锁已失效，请保持页面前台"); }
  finally { wakeLock = null; }
}
// 页内确认（替代 window.confirm）：不受自动化浏览器自动关闭弹窗影响，也不阻塞页面
function uiConfirm(message) {
  return new Promise(resolve => {
    const prev = document.querySelector("#ota-confirm-overlay");
    if (prev) { prev.remove(); resolve(false); return; }
    const box = document.createElement("div");
    box.id = "ota-confirm-overlay";
    Object.assign(box.style, { position: "fixed", inset: "0", zIndex: "9500", background: "rgba(10,12,8,.45)", display: "flex", alignItems: "center", justifyContent: "center" });
    const card = document.createElement("div");
    Object.assign(card.style, { background: "#fbfbf7", color: "#33362a", borderRadius: "10px", padding: "18px 20px", maxWidth: "min(480px, 90vw)", boxShadow: "0 12px 40px rgba(0,0,0,.35)", fontFamily: "inherit" });
    const p = document.createElement("p");
    p.textContent = message;
    Object.assign(p.style, { fontSize: "13px", lineHeight: "1.6", whiteSpace: "pre-line", margin: "0 0 14px" });
    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", gap: "10px", justifyContent: "flex-end" });
    for (const [label, val, primary] of [["确定", true, true], ["取消", false, false]]) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.dataset.r = val ? "1" : "0";
      Object.assign(b.style, { border: primary ? "none" : "1px solid #9aa084", background: primary ? "#4a5240" : "transparent", color: primary ? "#f4f6e8" : "#4a5240", borderRadius: "8px", padding: "7px 18px", fontSize: "13px", cursor: "pointer" });
      actions.appendChild(b);
    }
    actions.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-r]"); if (!b) return;
      box.remove(); resolve(b.dataset.r === "1");
    });
    card.append(p, actions); box.appendChild(card); document.body.appendChild(box);
  });
}
async function detect() {
  if (busy) return;
  if (!(await uiConfirm("检测会暂时占用测距 UART，不发送进 Boot 或擦写命令。\n若副板已在 Boot 启动窗口，查询会使其停留在 Boot。\n请停止测距并保持页面前台。继续检测？"))) return;
  snapshot = null; $("#ota-main-only").checked = false; renderSnapshot();
  setBusy(true); probeAbort = new AbortController();
  try {
    const adapter = await adapterForProbe(); await keepAwake();
    const scope = $("#ota-probe-scope")?.value || "both";
    snapshot = await new DeviceProbe(adapter, { signal: probeAbort.signal, onLog: otaLog }).run({ scope });
    renderSnapshot();
  } catch (error) { otaLog("ERR", error.message); }
  finally { probeAbort = null; await releaseAwake(); setBusy(false); }
}
// 版本徽章元素：pill("当前 APP", "v0.1") → <span class="ver-pill"><span class="k">当前 APP</span>v0.1</span>
function pill(key, value, { dim = false, note = "" } = {}) {
  const el = document.createElement("span");
  el.className = "ver-pill" + (dim ? " dim" : "");
  const k = document.createElement("span"); k.className = "k"; k.textContent = key;
  el.append(k, document.createTextNode(value + (note ? ` (${note})` : "")));
  return el;
}
function renderSnapshot() {
  const main = snapshot?.main, slave = snapshot?.slave, info = main?.info;
  $("#ota-main-mode").textContent = MODE[main?.mode] || "未检测";
  $("#ota-slave-mode").textContent = slave?.mode === "INFO_ONLY" ? "已识别" : MODE[slave?.mode] || "未检测";
  $("#ota-main-mode").dataset.mode = main?.mode || "UNKNOWN";
  $("#ota-slave-mode").dataset.mode = slave?.mode || "UNKNOWN";
  // Boot 版本可信度：主控=Boot 时 0x02 上报为真实值；APP 模式下 F7 上报在固件升级前是编译期常量
  const bootTag = main?.mode === "BOOT" ? "Boot" : (info?.boot_ver ?? 0) > 0x0100 ? "Boot" : "Boot(编译期)";
  $("#ota-main-info").textContent = info ? `${info.model} · 硬件 ${version(info.hw_ver)} · APP ${version(info.sw_ver)} · ${bootTag} ${version(info.boot_ver)}\nAPP ${hex(info.app_start)} · ${info.app_size}B · CRC ${hex(info.app_crc)}` : "等待主控身份与地址信息";
  const details = slave?.mode === "APP" ? (slave.info
    ? `APP v${version(slave.info.sw_ver)} · Boot v${version(slave.info.boot_ver)} · ${slave.info.model}\nAPP ${hex(slave.info.app_start)} · ${slave.info.app_size}B · CRC ${hex(slave.info.app_crc)}`
    : `APP v${version(slave.appVersion)} · 入口 ${hex(slave.appStart)} · 运行阶段 ${slave.runtimeStage} · 心跳计数 ${slave.heartbeat}`)
    : slave?.mode === "BOOT" ? (slave.info
      ? `Boot v${version(slave.info.boot_ver)} · APP v${version(slave.info.sw_ver)} · ${slave.info.model}\nAPP ${hex(slave.info.app_start)} · ${slave.info.app_size}B · CRC ${hex(slave.info.app_crc)} · 向量检查${slave.appValid ? "通过" : "未通过"}`
      : `Boot v${slave.bootVersion} · 入口 ${hex(slave.appStart)} · APP 向量检查${slave.appValid ? "通过（非整包CRC）" : "未通过（不能区分空白/损坏）"}`)
    : slave?.reason;
  $("#ota-slave-info").textContent = details || "必须收到副板自身应答；代理正常不等于副板在线";
  if (main?.reason) $("#ota-main-info").textContent += `\n检测异常：${main.reason}`;
  // 版本徽章：主控 APP 大徽章 + Boot 小徽章（Boot 模式下 0x02 为真实值；APP 模式 1.0=编译期常量）
  const mainVers = $("#ota-main-vers");
  if (mainVers) {
    if (info) {
      const bootReal = main?.mode === "BOOT" || (info.boot_ver ?? 0) > 0x0100;
      mainVers.hidden = false;
      mainVers.replaceChildren(
        pill("当前 APP", `v${version(info.sw_ver)}`),
        pill("Boot", `v${version(info.boot_ver)}`, { dim: true, note: bootReal ? "" : "编译期" })
      );
    } else { mainVers.hidden = true; mainVers.replaceChildren(); }
  }
  const slaveVers = $("#ota-slave-vers");
  if (slaveVers) {
    if (slave?.mode === "APP" || slave?.mode === "BOOT" || slave?.mode === "INFO_ONLY") {
      const si = slave.info;
      slaveVers.hidden = false;
      if (si) slaveVers.replaceChildren(
        pill("当前 APP", `v${version(si.sw_ver)}`),
        pill("Boot", `v${version(si.boot_ver)}`, { dim: true })
      );
      else if (slave.mode === "APP") slaveVers.replaceChildren(pill("当前 APP", `v${version(slave.appVersion)}`));
      else if (slave.mode === "BOOT") slaveVers.replaceChildren(pill("Boot", `v${slave.bootVersion}`, { dim: true }));
      else slaveVers.replaceChildren();
    } else { slaveVers.hidden = true; slaveVers.replaceChildren(); }
  }
  $("#ota-proxy-state").textContent = (ROUTE[snapshot?.proxy.state] || "未检测") + (snapshot?.proxy.reason ? `：${snapshot.proxy.reason}` : "");
  $("#ota-state-time").textContent = snapshot ? `检测于 ${new Date(snapshot.checkedAt).toLocaleTimeString()} · 60秒内有效` : "尚无有效状态；断连或过期后需重查";
  $("#ota-main-only-row").hidden = !snapshot || ["APP", "BOOT"].includes(slave?.mode);
  renderGate();
}
// 目标固件版本：W515 读 bin 内嵌元数据 meta.version；N32 hex 无内嵌版本，从文件名提取（v0p1 / v01p2 / v1.2 等）
function firmwareVersionText() {
  if (!firmware) return null;
  if (firmware.target === "n32-app") {
    // 文件名约定 v01p2 = v0.1 patch2（NNpN: 前两位=major.minor，p后=patch）；v0.1.2/v1.2 直接三段
    const m3 = firmware.name.match(/v(\d+)\.(\d+)\.(\d+)/i);
    if (m3) return `${Number(m3[1])}.${Number(m3[2])}.${Number(m3[3])}`;
    const m = firmware.name.match(/v(\d)(\d)[p.](\d+)/i);
    return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
  }
  const v = firmware.meta?.version;
  // FW_VERSION_PACK: (major<<24)|(minor<<16)|(patch<<8)|build —— 显示 major.minor 对齐 F7 sw_ver 口径
  return v == null || v === 0 ? null : `${v >>> 24}.${(v >>> 16) & 255}`;
}
// 设备当前版本（检测快照）：W515 用 F7 sw_ver；N32 用副板 appVersion（0x31）
function deviceVersionText() {
  if (!snapshot) return null;
  if (target === "n32") return snapshot.slave?.mode === "APP" ? version(snapshot.slave.appVersion) : null;
  const sw = snapshot.main?.info?.sw_ver;
  return sw == null || sw === 0 ? null : version(sw);
}
// 版本对照：null=未知；1=升级；0=同版本(重刷)；-1=降级（分段数不同按缺段=0 比较）
function compareVersion(cur, next) {
  if (!cur || !next) return null;
  const p = s => String(s).split(".").map(Number);
  const a = p(cur), b = p(next), n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] || 0) - (a[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}
function renderFirmware() {
  const fv = firmwareVersionText();
  $("#ota-file-meta").textContent = firmware
    ? (firmware.target === "n32-app"
      ? `${firmware.name} · 副板 N32 APP${fv ? ` · 新版本 v${fv}` : ""} · ${firmware.bytes.length}B @0x08002000 · CRC32 ${firmware.crc.toString(16).toUpperCase()}`
      : `${firmware.name} · ${firmware.bytes.length}B · ${firmware.meta.model}${fv ? ` · 新版本 v${fv}` : "（meta 无版本）"} · CRC已核对`)
    : "未选择有效固件";
  $("#ota-main-only").checked = false; renderGate();
  renderOnlineSelection();
}
function renderOnlineSelection() {
  document.querySelectorAll(".ota-online-item").forEach(item => {
    const selected = !!firmware && onlineSelection === item.dataset.fileName;
    item.setAttribute("aria-pressed", String(selected));
    item.querySelector(".fw-action").textContent = selected ? "已选择" : "选择";
  });
}
function gateReason() {
  const adapter = ctx?.getAdapter();
  if (!snapshot || !adapter || !snapshotIsFresh(snapshot, adapter)) return "第一步：检测主控与副板状态";
  if (target === "n32") {
    const gate = n32Gate(snapshot); if (gate) return gate;
    if (!firmware || firmware.target !== "n32-app") return "第二步：选择 N32 副板固件（.hex，基址 0x08002000）";
    return null;
  }
  const gate = w515Gate(snapshot); if (gate) return gate;
  if (!firmware || firmware.target !== "w515-app") return "第二步：选择匹配的 W515 APP 固件";
  try { validateFirmwareForDevice(firmware, snapshot.main.info); } catch (e) { return e.message; }
  if (!["APP", "BOOT"].includes(snapshot.slave.mode) && !$("#ota-main-only").checked) return "副板状态未确认；仅恢复主控须明确勾选";
  return null;
}
function renderGate() {
  const reason = gateReason();
  const n32Mode = target === "n32";
  $("#ota-start").disabled = busy || !!reason;
  $("#ota-start").textContent = n32Mode ? "确认并升级副板" : "确认并升级主控";
  // 版本对照行：检测+选好固件后显示 当前→新；升降级给醒目标签
  const verRow = $("#ota-version-compare");
  if (verRow) {
    const cur = deviceVersionText(), next = firmwareVersionText(), cmp = compareVersion(cur, next);
    if (!reason && firmware && (cur || next)) {
      verRow.hidden = false;
      verRow.dataset.cmp = cmp == null ? "unknown" : String(cmp);
      const tag = cmp === 1 ? "升级" : cmp === 0 ? "同版本重刷" : cmp === -1 ? "降级 ⚠️" : "版本未知";
      const mk = (cls, key, val) => {
        const s = document.createElement("span"); s.className = cls;
        if (key) { const k = document.createElement("span"); k.className = "k"; k.textContent = key; s.append(k); }
        s.append(document.createTextNode(val));
        return s;
      };
      verRow.replaceChildren(
        mk("vc-pill", "当前", cur ?? "未知"),
        mk("vc-arrow", null, "→"),
        mk("vc-pill", "新", next ?? "未知"),
        mk("vc-tag", null, tag)
      );
    } else { verRow.hidden = true; verRow.replaceChildren(); }
  }
  $("#ota-gate-reason").dataset.state = busy ? "busy" : reason ? "blocked" : "ready";
  $("#ota-gate-reason").textContent = busy ? "正在操作，蓝牙通道独占中"
    : reason || (n32Mode ? "可确认升级副板；执行前会再次检测，仍需真机验证" : "可确认升级；执行前会再次检测双板，仍需真机验证");
}
// 传输档位：稳(25ms) / 快(4ms) / 自定义（对齐 unified-tool 调试助手可调参数）
const TUNING_STORAGE_KEY = "ota.tuning.v1";
function readTuning() {
  const select = $("#ota-preset"), custom = select?.value === "custom";
  const num = (id, fallback) => {
    const v = Number.parseInt($(id)?.value ?? "", 10);
    return Number.isFinite(v) ? v : fallback;
  };
  if (!select) return { chunk: 180, window: 16, gapMs: 4, delayMs: 4, gattChunk: 244 };
  if (custom) {
    return {
      chunk: num("#ota-tuning-chunk", 180),
      window: num("#ota-tuning-window", 16),
      gapMs: num("#ota-tuning-gap", 4),
      delayMs: num("#ota-tuning-gap", 4),
      gattChunk: num("#ota-tuning-gatt", 244),
      rawIdleMs: num("#ota-tuning-rawidle", 2000),
      totalMs: num("#ota-tuning-total", 300000),
      proxyIdleMs: num("#ota-tuning-proxyidle", 5000)
    };
  }
  if (select.value === "steady") return { chunk: 180, window: 16, gapMs: 25, delayMs: 25, gattChunk: 244 };
  return { chunk: 180, window: 16, gapMs: 4, delayMs: 4, gattChunk: 244 }; // fast 默认
}
function saveTuningChoice() {
  try {
    const payload = { preset: $("#ota-preset")?.value };
    if (payload.preset === "custom") {
      payload.chunk = $("#ota-tuning-chunk")?.value;
      payload.window = $("#ota-tuning-window")?.value;
      payload.gap = $("#ota-tuning-gap")?.value;
      payload.gatt = $("#ota-tuning-gatt")?.value;
    }
    localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(payload));
  } catch { /* localStorage 不可用时忽略 */ }
}
function restoreTuningChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY) || "null");
    if (!saved?.preset) return;
    const select = $("#ota-preset"); if (!select) return;
    if (![...select.options].some(o => o.value === saved.preset)) return;
    select.value = saved.preset;
    if (saved.preset === "custom") {
      if (saved.chunk) $("#ota-tuning-chunk").value = saved.chunk;
      if (saved.window) $("#ota-tuning-window").value = saved.window;
      if (saved.gap) $("#ota-tuning-gap").value = saved.gap;
      if (saved.gatt) $("#ota-tuning-gatt").value = saved.gatt;
    }
  } catch { /* 忽略损坏的存储 */ }
}
function onStage(stage, label) {
  $("#ota-progress-band").style.display = "";
  $("#ota-stage-label").textContent = label;
  const n32Mode = target === "n32" || ["proxy", "enterapp"].includes(stage);
  const stages = n32Mode ? N32_STAGES : STAGES, labels = n32Mode ? N32_LABELS : LABELS;
  $("#ota-stage-list").replaceChildren(...stages.map((s, i) => {
    const el = document.createElement("span");
    el.className = "ota-stage" + (s === stage ? " active" : i < stages.indexOf(stage) ? " done" : "");
    el.textContent = labels[i]; return el;
  }));
}
function onProgress(p) {
  $("#ota-progress-fill").style.width = `${p.percent}%`;
  $("#ota-stat-progress").textContent = `${p.percent.toFixed(1)}%`;
  $("#ota-stat-speed").textContent = `${Math.round(p.speed)} B/s`;
  $("#ota-stat-packets").textContent = `${p.packets}/${p.totalPackets}`;
  $("#ota-stat-mode").textContent = p.mode;
}
async function startUpgrade() {
  if (busy) return;
  const reason = gateReason(); if (reason) { otaLog("WARN", reason); return; }
  const image = firmware, adapter = ctx.getAdapter(), deviceId = snapshot.deviceId;
  if (target === "n32") {
    if (!(await uiConfirm(`升级 N32 副板 APP：${image.name}\n经主控代理擦除并写入 0x08002000 的副板 APP 区（${image.bytes.length}B，CRC32 ${image.crc.toString(16).toUpperCase()}）。\n主控 W515 不会被刷写；N32 Boot 不受影响（失败可重试）。\n此路径尚未真机验证。确认执行？`))) return;
    setBusy(true);
    try {
      await keepAwake();
      session = new N32OtaSession(adapter, { onLog: otaLog, onStage, onProgress, onSnapshot: value => { snapshot = value; renderSnapshot(); } });
      const result = await session.run(image, { confirmed: true, expectedDeviceId: deviceId, tuning: readTuning() });
      otaLog("SYS", result.success ? `副板升级完成：${result.verify.size}B CRC32 ${result.verify.crc.toString(16).toUpperCase()}；建议重新检测确认` : "未完成");
    } catch (error) { onStage("error", "已停止 / 未完成"); otaLog("ERR", error.message); }
    finally { session = null; snapshot = null; renderSnapshot(); await releaseAwake(); setBusy(false); }
    return;
  }
  const mainOnly = $("#ota-main-only").checked;
  if (!(await uiConfirm(`仅升级 W515 APP：${image.name}\n将擦除并写入 ${hex(snapshot.main.info.app_start)} 的 APP 区。N32 不会被刷写。\n此浏览器实现尚未真机验证，请保持稳定供电、亮屏和前台；失败可能需要 Boot 恢复。确认执行？`))) return;
  setBusy(true);
  try {
    await keepAwake();
    session = new W515OtaSession(adapter, { onLog: otaLog, onStage, onProgress, onSnapshot: value => { snapshot = value; renderSnapshot(); } });
    const result = await session.run(image, { confirmed: true, expectedDeviceId: deviceId, acknowledgeSlaveUnknown: mainOnly, tuning: readTuning() });
    otaLog("SYS", result.success ? "主控 APP 回应与固件信息已确认；副板状态须重新检测" : "未完成");
  } catch (error) { onStage("error", "已停止 / 未完成"); otaLog("ERR", error.message); }
  finally { session = null; snapshot = null; renderSnapshot(); await releaseAwake(); setBusy(false); }
}
async function loadOnlineFirmware() {
  const list = $("#ota-online-list"); list.textContent = "读取在线清单…";
  try {
    const response = await fetch(new URL("versions.json", firmwareDirectory()), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const files = (Array.isArray(data.files) ? data.files : []).filter(f => ["w515-app", "n32-app"].includes(f.target));
    files.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || String(b.date).localeCompare(String(a.date)));
    list.replaceChildren();
    if (!files.length) { list.textContent = "未发布固件"; return; }
    for (const entry of files) {
      const item = document.createElement("button"); item.type = "button"; item.className = "ota-online-item"; item.disabled = busy;
      item.dataset.fileName = entry.name;
      item.setAttribute("aria-pressed", "false");
      const icon = document.createElement("span"); icon.className = "fw-icon"; icon.textContent = entry.target === "n32-app" ? "N32" : "APP"; icon.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span"); copy.className = "fw-copy";
      const name = document.createElement("strong"); name.textContent = `${entry.target === "n32-app" ? "副板 " : "主控 "}${entry.name}`;
      const notes = document.createElement("small"); notes.textContent = `${entry.size}B · ${entry.notes || "待验证版本"}`;
      copy.append(name, notes);
      const action = document.createElement("span"); action.className = "fw-action"; action.textContent = "选择";
      item.append(icon, copy, action);
      item.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        action.textContent = "核验中…";
        try {
          const response = await fetch(firmwareUrl(entry), { cache: "no-store" });
          if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
          const bytes = new Uint8Array(await response.arrayBuffer()); await verifyDownload(bytes, entry);
          const image = entry.target === "n32-app" ? inspectN32Firmware(bytes, entry.name) : inspectFirmware(bytes, entry.name, entry.target);
          if (entry.metaCrc32 && image.meta && image.meta.appCrc !== parseInt(entry.metaCrc32, 16)) throw new Error("元数据 CRC 与清单不符");
          firmware = image; onlineSelection = entry.name;
          selectTarget(entry.target === "n32-app" ? "n32" : "w515");
          renderFirmware(); otaLog("SYS", "在线固件长度与 SHA-256 已核对（不代表真机验收）");
        } catch (error) { firmware = null; renderFirmware(); otaLog("ERR", error.message); }
        finally { setBusy(false); }
      });
      list.append(item);
    }
    renderOnlineSelection();
  } catch (error) { list.textContent = `在线库不可用：${error.message}；可刷新清单或选择本地文件`; }
}
