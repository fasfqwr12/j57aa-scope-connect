import { W515OtaSession } from "./w515-ota.js?v=fast-path-1";
import { N32OtaSession, n32Gate } from "./n32-ota.js?v=raw-path-1";
import { DeviceProbe, snapshotIsFresh, w515Gate } from "./device-probe.js?v=status-first-1";
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
  $("#ota-file-meta").textContent = firmware
    ? (firmware.target === "n32-app"
      ? `${firmware.name} · 副板 N32 APP · ${firmware.bytes.length}B @0x08002000 · CRC32 ${firmware.crc.toString(16).toUpperCase()}`
      : `${firmware.name} · ${firmware.bytes.length}B · ${firmware.meta.model} · CRC已核对`)
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
  $("#ota-gate-reason").dataset.state = busy ? "busy" : reason ? "blocked" : "ready";
  $("#ota-gate-reason").textContent = busy ? "正在操作，蓝牙通道独占中"
    : reason || (n32Mode ? "可确认升级副板；执行前会再次检测，仍需真机验证" : "可确认升级；执行前会再次检测双板，仍需真机验证");
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
      const result = await session.run(image, { confirmed: true, expectedDeviceId: deviceId });
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
