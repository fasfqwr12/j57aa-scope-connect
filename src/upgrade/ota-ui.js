import { W515OtaSession } from "./w515-ota.js?v=status-first-1";
import { DeviceProbe, snapshotIsFresh, w515Gate } from "./device-probe.js?v=status-first-1";
import { inspectFirmware, validateFirmwareForDevice } from "./firmware-image.js?v=status-first-1";
import { firmwareDirectory, firmwareUrl, verifyDownload } from "./firmware-library.js?v=status-first-1";

const STAGES = ["probe", "enterboot", "info", "erase", "write", "verify", "reset", "done"];
const LABELS = ["检测双板", "进入 Boot", "核对窗口", "擦除", "ACK写入", "CRC校验", "确认 APP", "完成"];
const MODE = { APP: "APP 运行", BOOT: "Boot 运行", UNKNOWN: "未确认", UNREACHABLE: "通路不可达" };
const ROUTE = { UNKNOWN: "未确认", INACTIVE: "未占用", BUSY: "已有会话占用", OWNED_NORMAL: "检测会话占用", RELEASED: "已确认释放", CLEANUP_UNCONFIRMED: "释放未确认", NOT_AVAILABLE_IN_BOOT: "当前 Boot 无代理" };
const $ = s => document.querySelector(s);
const hex = v => v == null ? "—" : "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");
const version = v => v == null ? "—" : `${v >>> 8}.${v & 255}`;
let ctx, firmware = null, snapshot = null, busy = false, session = null, probeAbort = null, wakeLock = null;
let onlineSelection = null;

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
      firmware = inspectFirmware(new Uint8Array(await file.arrayBuffer()), file.name);
      renderFirmware();
    } catch (error) { firmware = null; renderFirmware(); otaLog("ERR", error.message); }
    finally { setBusy(false); }
  });
  $("#ota-main-only").addEventListener("change", renderGate);
  $("#ota-online-refresh").addEventListener("click", () => { if (!busy) loadOnlineFirmware(); });
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
async function detect() {
  if (busy) return;
  if (!window.confirm("检测会暂时占用测距 UART，不发送进 Boot 或擦写命令。若副板已在 Boot 启动窗口，查询会使其停留在 Boot。请停止测距并保持页面前台。继续检测？")) return;
  snapshot = null; $("#ota-main-only").checked = false; renderSnapshot();
  setBusy(true); probeAbort = new AbortController();
  try {
    const adapter = await adapterForProbe(); await keepAwake();
    snapshot = await new DeviceProbe(adapter, { signal: probeAbort.signal, onLog: otaLog }).run();
    renderSnapshot();
  } catch (error) { otaLog("ERR", error.message); }
  finally { probeAbort = null; await releaseAwake(); setBusy(false); }
}
function renderSnapshot() {
  const main = snapshot?.main, slave = snapshot?.slave, info = main?.info;
  $("#ota-main-mode").textContent = MODE[main?.mode] || "未检测";
  $("#ota-slave-mode").textContent = MODE[slave?.mode] || "未检测";
  $("#ota-main-mode").dataset.mode = main?.mode || "UNKNOWN";
  $("#ota-slave-mode").dataset.mode = slave?.mode || "UNKNOWN";
  $("#ota-main-info").textContent = info ? `${info.model} · 硬件 ${version(info.hw_ver)} · APP ${version(info.sw_ver)} · 上报Boot ${version(info.boot_ver)}\nAPP ${hex(info.app_start)} · ${info.app_size}B · CRC ${hex(info.app_crc)}` : "等待主控身份与地址信息";
  const details = slave?.mode === "APP" ? `APP v${version(slave.appVersion)} · 入口 ${hex(slave.appStart)} · 运行阶段 ${slave.runtimeStage} · 心跳计数 ${slave.heartbeat}` : slave?.mode === "BOOT" ? `Boot v${slave.bootVersion} · 入口 ${hex(slave.appStart)} · APP 向量检查${slave.appValid ? "通过（非整包CRC）" : "未通过（不能区分空白/损坏）"}` : slave?.reason;
  $("#ota-slave-info").textContent = details || "必须收到副板自身应答；代理正常不等于副板在线";
  if (main?.reason) $("#ota-main-info").textContent += `\n检测异常：${main.reason}`;
  $("#ota-proxy-state").textContent = (ROUTE[snapshot?.proxy.state] || "未检测") + (snapshot?.proxy.reason ? `：${snapshot.proxy.reason}` : "");
  $("#ota-state-time").textContent = snapshot ? `检测于 ${new Date(snapshot.checkedAt).toLocaleTimeString()} · 60秒内有效` : "尚无有效状态；断连或过期后需重查";
  $("#ota-main-only-row").hidden = !snapshot || ["APP", "BOOT"].includes(slave?.mode);
  renderGate();
}
function renderFirmware() {
  $("#ota-file-meta").textContent = firmware ? `${firmware.name} · ${firmware.bytes.length}B · ${firmware.meta.model} · CRC已核对` : "未选择有效固件";
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
  const gate = w515Gate(snapshot); if (gate) return gate;
  if (!firmware) return "第二步：选择匹配的 W515 APP 固件";
  try { validateFirmwareForDevice(firmware, snapshot.main.info); } catch (e) { return e.message; }
  if (!["APP", "BOOT"].includes(snapshot.slave.mode) && !$("#ota-main-only").checked) return "副板状态未确认；仅恢复主控须明确勾选";
  return null;
}
function renderGate() {
  const reason = gateReason();
  $("#ota-start").disabled = busy || !!reason;
  $("#ota-gate-reason").dataset.state = busy ? "busy" : reason ? "blocked" : "ready";
  $("#ota-gate-reason").textContent = busy ? "正在操作，蓝牙通道独占中" : reason || "可确认升级；执行前会再次检测双板，仍需真机验证";
}
function onStage(stage, label) {
  $("#ota-progress-band").style.display = "";
  $("#ota-stage-label").textContent = label;
  $("#ota-stage-list").replaceChildren(...STAGES.map((s, i) => {
    const el = document.createElement("span");
    el.className = "ota-stage" + (s === stage ? " active" : i < STAGES.indexOf(stage) ? " done" : "");
    el.textContent = LABELS[i]; return el;
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
  const mainOnly = $("#ota-main-only").checked;
  if (!window.confirm(`仅升级 W515 APP：${image.name}\n将擦除并写入 ${hex(snapshot.main.info.app_start)} 的 APP 区。N32 不会被刷写。\n此浏览器实现尚未真机验证，请保持稳定供电、亮屏和前台；失败可能需要 Boot 恢复。确认执行？`)) return;
  setBusy(true);
  try {
    await keepAwake();
    session = new W515OtaSession(adapter, { onLog: otaLog, onStage, onProgress, onSnapshot: value => { snapshot = value; renderSnapshot(); } });
    const result = await session.run(image, { confirmed: true, expectedDeviceId: deviceId, acknowledgeSlaveUnknown: mainOnly });
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
    const files = (Array.isArray(data.files) ? data.files : []).filter(f => f.target === "w515-app");
    files.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || String(b.date).localeCompare(String(a.date)));
    list.replaceChildren();
    if (!files.length) { list.textContent = "未发布 W515 APP 固件"; return; }
    for (const entry of files) {
      const item = document.createElement("button"); item.type = "button"; item.className = "ota-online-item"; item.disabled = busy;
      item.dataset.fileName = entry.name;
      item.setAttribute("aria-pressed", "false");
      const icon = document.createElement("span"); icon.className = "fw-icon"; icon.textContent = "APP"; icon.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span"); copy.className = "fw-copy";
      const name = document.createElement("strong"); name.textContent = entry.name;
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
          const image = inspectFirmware(bytes, entry.name, entry.target);
          if (entry.metaCrc32 && image.meta.appCrc !== parseInt(entry.metaCrc32, 16)) throw new Error("元数据 CRC 与清单不符");
          firmware = image; onlineSelection = entry.name; renderFirmware(); otaLog("SYS", "在线固件长度、SHA-256 和元数据 CRC 已核对（不代表真机验收）");
        } catch (error) { firmware = null; renderFirmware(); otaLog("ERR", error.message); }
        finally { setBusy(false); }
      });
      list.append(item);
    }
    renderOnlineSelection();
  } catch (error) { list.textContent = `在线库不可用：${error.message}；可刷新清单或选择本地文件`; }
}
