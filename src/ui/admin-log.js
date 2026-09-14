// 管理员协议日志面板：?admin=1 激活。仅观察，不发送任何帧。
import { ProtocolTap } from "../debug/protocol-tap.js?v=admin-log-1";

let tap = null, ui = null, paused = false, filter = "all", autoScroll = true;

export function initAdminLog() {
  if (new URLSearchParams(location.search).get("admin") !== "1") return null;
  tap = new ProtocolTap();
  buildUi();
  return tap;
}
function buildUi() {
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "./src/ui/admin-log.css?v=admin-log-1";
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.id = "admin-log-fab"; btn.type = "button"; btn.textContent = "协议日志";
  btn.addEventListener("click", open);
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "admin-log-overlay"; panel.hidden = true;
  panel.innerHTML = `
    <div class="al-panel">
      <header class="al-head">
        <strong>管理员 · 协议交互日志</strong>
        <span class="al-count" id="al-count">0 条</span>
        <div class="al-spacer"></div>
        <div class="al-filters" id="al-filters">
          ${["all:全部", "tx:TX", "rx:RX", "w515:W515", "n32:N32", "glpx:GLPX", "event:GLPE", "f7:F7", "noise:噪声"].map(s => { const [v, l] = s.split(":"); return `<button type="button" data-f="${v}" class="${v === "all" ? "on" : ""}">${l}</button>`; }).join("")}
        </div>
        <button type="button" id="al-inject" class="al-act">注入示例</button>
        <button type="button" id="al-pause" class="al-act">暂停</button>
        <button type="button" id="al-clear" class="al-act">清空</button>
        <button type="button" id="al-export" class="al-act">导出</button>
        <button type="button" id="al-close" class="al-act al-close">✕</button>
      </header>
      <div class="al-table-head"><span>时间</span><span>向</span><span>协议</span><span>解读</span><span>HEX</span></div>
      <div class="al-body" id="al-body"></div>
      <footer class="al-foot">
        <span>仅观察通道：面板不发送任何帧；RX 在升级独占期同样捕获。</span>
        <label class="al-autoscroll"><input type="checkbox" id="al-autoscroll" checked>自动滚动</label>
      </footer>
    </div>`;
  document.body.appendChild(panel);
  ui = { panel, body: panel.querySelector("#al-body"), count: panel.querySelector("#al-count") };

  panel.querySelector("#al-close").addEventListener("click", close);
  panel.querySelector("#al-pause").addEventListener("click", ev => { paused = !paused; ev.target.textContent = paused ? "继续" : "暂停"; ev.target.classList.toggle("on", paused); });
  panel.querySelector("#al-clear").addEventListener("click", () => { tap.clear(); render(); });
  panel.querySelector("#al-inject").addEventListener("click", () => { tap.injectDemo(); });
  panel.querySelector("#al-export").addEventListener("click", exportLog);
  panel.querySelector("#al-autoscroll").addEventListener("change", ev => { autoScroll = ev.target.checked; });
  panel.querySelector("#al-filters").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-f]"); if (!b) return;
    filter = b.dataset.f;
    panel.querySelectorAll("#al-filters button").forEach(x => x.classList.toggle("on", x === b));
    render();
  });
  ui.body.addEventListener("scroll", () => { autoScroll = ui.body.scrollTop + ui.body.clientHeight >= ui.body.scrollHeight - 30; panel.querySelector("#al-autoscroll").checked = autoScroll; });

  tap.on(entry => { if (!paused && entry) appendRow(entry); refreshCount(); });
}
function open() { ui.panel.hidden = false; render(); }
function close() { ui.panel.hidden = true; }
function matchFilter(e) {
  if (filter === "all") return true;
  if (filter === "tx" || filter === "rx") return e.dir.toLowerCase() === filter;
  if (filter === "glpx") return e.protocol === "proxy";
  return e.protocol === filter;
}
function render() {
  ui.body.replaceChildren();
  for (const e of tap.entries) if (matchFilter(e)) appendRow(e);
  refreshCount();
  scrollBottom();
}
function appendRow(e) {
  if (!matchFilter(e)) return;
  const row = document.createElement("div");
  row.className = `al-row ${e.dir.toLowerCase()} p-${e.protocol}`;
  const t = e.time instanceof Date ? e.time : new Date(e.time);
  row.innerHTML = `<span class="al-time">${t.toLocaleTimeString("zh-CN", { hour12: false })}.${String(t.getMilliseconds()).padStart(3, "0")}</span>
    <span class="al-dir">${e.dir}</span><span class="al-proto">${e.name}</span>
    <span class="al-detail">${escapeHtml(e.detail)}</span><span class="al-hex">${e.hex}</span>`;
  ui.body.appendChild(row);
  if (autoScroll) scrollBottom();
}
function refreshCount() { ui.count.textContent = `${tap.entries.length} 条`; }
function scrollBottom() { ui.body.scrollTop = ui.body.scrollHeight; }
function exportLog() {
  const data = { exportedAt: new Date().toISOString(), filter, entries: tap.entries.filter(matchFilter) };
  const text = data.entries.map(e => `${e.time instanceof Date ? e.time.toISOString() : e.time} [${e.dir}] ${e.name} ${e.detail} ${e.hex}`).join("\n");
  for (const [name, content, type] of [["protocol-log.json", JSON.stringify(data, null, 2), "application/json"], ["protocol-log.txt", text, "text/plain"]]) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
