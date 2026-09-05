// 升级 Tab UI 逻辑（W515 BLE OTA）
import { W515OtaSession, OTA_PRESETS } from "./w515-ota.js?v=20260703_v3";
import { crc16Modbus, crc32, buildOtaFrame, toHex } from "./ota-protocol.js?v=20260703_v3";

const STAGES = [
  { id: "parse", label: "解析固件" },
  { id: "handshake", label: "握手" },
  { id: "enterboot", label: "进入 Boot" },
  { id: "info", label: "Boot 信息" },
  { id: "erase", label: "擦除" },
  { id: "write", label: "写入" },
  { id: "verify", label: "校验" },
  { id: "reset", label: "复位" },
  { id: "done", label: "完成" }
];

let firmware = null;        // Uint8Array
let session = null;         // W515OtaSession
let ctx = null;             // { getAdapter, connect, isConnected }

export function initOtaUpgrade(context) {
  ctx = context;
  const $ = s => document.querySelector(s);

  $("#ota-firmware-file").addEventListener("change", async ev => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    firmware = buf;
    const meta = readMetaBrief(buf);
    $("#ota-file-meta").innerHTML = meta
      ? `<strong>${escapeHtml(file.name)}</strong> · ${buf.length}B · ${escapeHtml(meta)}`
      : `<strong>${escapeHtml(file.name)}</strong> · ${buf.length}B · 无元数据(整包CRC)`;
    otaLog("SYS", `固件已载入: ${file.name} (${buf.length}B) CRC32=0x${crc32(buf).toString(16).toUpperCase()}`);
    ev.target.value = "";
  });

  $("#ota-start").addEventListener("click", startUpgrade);
  $("#ota-abort").addEventListener("click", () => {
    if (session) { session.abort(); otaLog("WARN", "中止请求已发出"); }
  });
  $("#ota-clear-log").addEventListener("click", () => { $("#ota-log-box").innerHTML = ""; });

  // 目标选择（N32 暂未开放）
  document.querySelectorAll('input[name="ota-target"]').forEach(radio => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".ota-target").forEach(el => el.classList.toggle("selected", el.querySelector("input").checked));
    });
  });
}

async function startUpgrade() {
  const $ = s => document.querySelector(s);
  if (!firmware) { otaLog("ERR", "请先选择固件 .bin 文件"); return; }
  if (!ctx.isConnected()) {
    otaLog("SYS", "未连接，先连接 BLE…");
    await ctx.connect();
    if (!ctx.isConnected()) { otaLog("ERR", "BLE 未连接，升级中止"); return; }
  }
  const adapter = ctx.getAdapter();
  if (!adapter || typeof adapter.writeRaw !== "function") {
    otaLog("ERR", "当前连接方式不支持 OTA（需要浏览器 BLE 直连）");
    return;
  }

  const presetKey = $("#ota-preset").value;
  $("#ota-progress-band").style.display = "";
  $("#ota-start").disabled = true;
  $("#ota-abort").disabled = false;
  renderStageList(null);

  session = new W515OtaSession(adapter, {
    onLog: (type, msg) => otaLog(type, msg),
    onStage: (stage, label) => {
      $("#ota-stage-label").textContent = label;
      renderStageList(stage);
    },
    onProgress: info => {
      const pct = info.total ? Math.floor(info.written / info.total * 100) : 0;
      $("#ota-progress-fill").style.width = pct + "%";
      $("#ota-stat-progress").textContent = pct + "%";
      $("#ota-stat-speed").textContent = fmtSpeed(info.speed);
      $("#ota-stat-packets").textContent = `${info.packetIndex}/${info.packets}`;
      $("#ota-stat-mode").textContent = `${info.chunk}B×w${session?.preset?.window ?? "--"}`;
    }
  });

  try {
    const result = await session.run(firmware, presetKey);
    if (result.success) {
      otaLog("SYS", `升级成功: size=${result.verify.size} crc=0x${result.verify.crc.toString(16).toUpperCase()} (${result.verify.source})${result.app_unconfirmed ? " · App 回应未确认" : ""}`);
      $("#ota-stage-label").textContent = "完成";
      $("#ota-progress-fill").style.width = "100%";
      $("#ota-stat-progress").textContent = "100%";
    } else {
      otaLog("ERR", "升级失败");
    }
  } catch (err) {
    otaLog("ERR", err.message || String(err));
    $("#ota-stage-label").textContent = "失败";
  } finally {
    $("#ota-start").disabled = false;
    $("#ota-abort").disabled = true;
    session = null;
  }
}

function renderStageList(activeStage) {
  const host = document.querySelector("#ota-stage-list");
  if (!host) return;
  const idx = STAGES.findIndex(s => s.id === activeStage);
  host.innerHTML = STAGES.map((s, i) => {
    const state = idx < 0 ? "" : (i < idx ? "done" : (i === idx ? "active" : ""));
    return `<span class="ota-stage ${state}">${state === "done" ? "✓" : ""}${s.label}</span>`;
  }).join("");
}

function otaLog(type, msg) {
  const box = document.querySelector("#ota-log-box");
  if (!box) return;
  const line = document.createElement("div");
  line.className = `log-line ${String(type).toLowerCase()}`;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
  line.textContent = `[${hh}] [${type}] ${msg}`;
  box.appendChild(line);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function readMetaBrief(fw) {
  try {
    const off = 0x200;
    if (fw.length < off + 64) return null;
    const dv = new DataView(fw.buffer, fw.byteOffset, fw.byteLength);
    if (dv.getUint32(off, true) !== 0x4649524D) return null;
    const appSize = dv.getUint32(off + 0x20, true);
    const version = dv.getUint32(off + 4, true);
    const model = new TextDecoder().decode(fw.slice(off + 0x10, off + 0x20)).split("\0")[0] || "?";
    return `${model} v${(version >>> 24) & 0xFF}.${(version >>> 16) & 0xFF}.${(version >>> 8) & 0xFF} app=${appSize}B`;
  } catch { return null; }
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "-- B/s";
  if (bps > 1024) return (bps / 1024).toFixed(1) + " KB/s";
  return Math.round(bps) + " B/s";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== 自检（控制台）：帧构造/CRC 与母本用例比对 =====
// 母本用例: AA 01 00 04 12 34 56 78 31 C3 55（握手帧，ble_upgrade_w515_app.py boot_frame）
self.addEventListener("load", () => {
  const hs = buildOtaFrame(0x01, [0x12, 0x34, 0x56, 0x78]);
  const expected = "AA010004123456783 1C355".replace(" ", "");
  const got = toHex(hs);
  const ref = toHex(new Uint8Array([0xAA, 0x01, 0x00, 0x04, 0x12, 0x34, 0x56, 0x78, 0x31, 0xC3, 0x55]));
  console.info(`[OTA 自检] 握手帧: ${got} ${got === ref ? "✓ 与母本一致" : "✗ 不一致 ref=" + ref}`);
});
