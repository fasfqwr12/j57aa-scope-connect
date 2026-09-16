// 固件库发布面板（仅 ?admin=1）：选文件 → 自动识别版本/校验 → GitHub Contents API 上传并更新在线清单。
// token 存 localStorage（仅本浏览器），不经过任何第三方；建议用仅本仓库 Contents 读写的细粒度 PAT。
import { inspectFirmware, inspectN32Firmware } from "./firmware-image.js?v=confirmfix-3";

const REPO = "fasfqwr12/j57aa-scope-connect";
const BRANCH = "main";
const TOKEN_KEY = "dsh.fwRepoToken";

const crc32Of = bytes => {
  const table = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const hex8 = v => v.toString(16).toUpperCase().padStart(8, "0");
const b64 = bytes => btoa(String.fromCharCode(...bytes));

export function initReleasePanel(onPublished) {
  if (new URLSearchParams(location.search).get("admin") !== "1") return null;

  // ── UI ──
  const css = document.createElement("link");
  css.rel = "stylesheet"; css.href = "./src/ui/release-panel.css?v=rel-1";
  document.head.append(css);

  const details = document.createElement("details");
  details.className = "field-band release-panel";
  details.innerHTML = `
    <summary>固件库发布<span>上传新固件到在线库（GitHub）· 仅管理员</span></summary>
    <div class="rel-grid">
      <label class="rel-field">GitHub PAT（细粒度·仅本仓库 Contents 读写）
        <input type="password" id="rel-token" placeholder="github_pat_... / ghp_..." autocomplete="off">
      </label>
      <label class="rel-field">固件文件（.bin / .hex）
        <input type="file" id="rel-file" accept=".bin,.hex">
      </label>
      <label class="rel-field">目标
        <select id="rel-target">
          <option value="auto">自动识别</option>
          <option value="w515-app">W515 主控 APP</option>
          <option value="n32-app">N32 副板 APP</option>
        </select>
      </label>
      <label class="rel-field">版本（自动填，可改）
        <input type="text" id="rel-version" placeholder="如 0.1.1 / 1.6.0">
      </label>
      <label class="rel-field">日期
        <input type="text" id="rel-date" placeholder="YYYY-MM-DD">
      </label>
      <label class="rel-field">说明
        <input type="text" id="rel-notes" placeholder="变更摘要（显示在在线库条目）">
      </label>
      <label class="rel-check"><input type="checkbox" id="rel-recommended" checked> 标记为推荐（同目标旧条目自动降级）</label>
      <div class="rel-actions">
        <button class="btn primary" id="rel-upload" type="button" disabled>上传并更新在线库</button>
        <span class="rel-status" id="rel-status"></span>
      </div>
      <pre class="rel-preview" id="rel-preview" hidden></pre>
    </div>`;
  const otaLogDetails = document.getElementById("ota-log-details");
  otaLogDetails.before(details);

  const $ = id => details.querySelector("#" + id);
  const tokenEl = $("rel-token"), fileEl = $("rel-file"), targetEl = $("rel-target"),
    verEl = $("rel-version"), dateEl = $("rel-date"), notesEl = $("rel-notes"),
    recEl = $("rel-recommended"), upBtn = $("rel-upload"), statusEl = $("rel-status"), previewEl = $("rel-preview");

  tokenEl.value = localStorage.getItem(TOKEN_KEY) || "";
  dateEl.value = new Date().toISOString().slice(0, 10);
  tokenEl.addEventListener("change", () => localStorage.setItem(TOKEN_KEY, tokenEl.value.trim()));

  let entry = null; // 待发布条目
  fileEl.addEventListener("change", async () => {
    entry = null; upBtn.disabled = true; previewEl.hidden = true; statusEl.textContent = "";
    const f = fileEl.files[0];
    if (!f) return;
    try {
      const raw = new Uint8Array(await f.arrayBuffer());
      const name = f.name;
      const isHex = /\.hex$/i.test(name);
      const autoTarget = isHex
        ? (/n32/i.test(name) ? "n32-app" : null)
        : "w515-app";
      const target = targetEl.value === "auto" ? autoTarget : targetEl.value;
      if (!target) throw new Error("无法自动识别目标（hex 名不含 N32？），请手动选择目标");

      // 版本识别：W515 bin 读内嵌 meta；N32 hex 从文件名
      let version = null, metaCrc = null, noteExtra = "";
      if (target === "w515-app") {
        const fw = inspectFirmware(raw, name, "w515-app");
        if (fw.meta?.version) {
          const v = fw.meta.version;
          version = `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}`;
          metaCrc = fw.meta.appCrc;
          noteExtra = ` · meta 版本 v${version}`;
        }
      } else {
        const m3 = name.match(/v(\d+)\.(\d+)\.(\d+)/i) || name.match(/v(\d)(\d)[p.](\d+)/i);
        if (m3) version = `${Number(m3[1])}.${Number(m3[2])}.${Number(m3[3])}`;
        try {
          const fw = inspectN32Firmware(raw, name);
          noteExtra = ` · 数据${fw.bytes.length}B@0x08002000`;
        } catch { /* 解析失败不影响发布 */ }
      }
      if (targetEl.value === "auto" && autoTarget) targetEl.value = autoTarget;
      verEl.value = version || verEl.value;
      entry = {
        name, target, version: version || verEl.value || "0.0.0",
        date: dateEl.value || new Date().toISOString().slice(0, 10),
        size: raw.length,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))).map(b => b.toString(16).padStart(2, "0")).join(""),
        fileCrc32: hex8(crc32Of(raw)),
        ...(metaCrc != null ? { metaCrc32: hex8(metaCrc) } : {}),
        notes: "", recommended: recEl.checked,
        raw
      };
      previewEl.hidden = false;
      previewEl.textContent =
        `文件: ${name}（${raw.length}B）\n目标: ${target}   版本: v${entry.version}\n` +
        `SHA-256: ${entry.sha256}\n文件CRC32: ${entry.fileCrc32}${metaCrc != null ? `\nmeta CRC32: ${entry.metaCrc32}` : ""}${noteExtra}`;
      upBtn.disabled = false;
    } catch (e) {
      statusEl.textContent = "读取失败：" + e.message;
    }
  });
  targetEl.addEventListener("change", () => { if (fileEl.files[0]) fileEl.dispatchEvent(new Event("change")); });

  upBtn.addEventListener("click", async () => {
    const token = tokenEl.value.trim();
    if (!token || !entry) return;
    if (upBtn.disabled) return;
    upBtn.disabled = true;
    entry.version = verEl.value.trim() || entry.version;
    entry.date = dateEl.value.trim() || entry.date;
    entry.recommended = recEl.checked;
    const userNotes = notesEl.value.trim();
    const baseNotes = entry.target === "w515-app" ? "主控 W515 APP" : "副板 N32G430 APP";
    entry.notes = userNotes || `${baseNotes} · v${entry.version}`;

    const gh = async (path, opts = {}) => {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        ...opts,
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(opts.headers || {})
        }
      });
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${r.statusText}${r.status === 409 ? "（冲突：文件已存在/清单变了，重试）" : r.status === 401 ? "（token 无效或无权限）" : ""}`);
      return r.json();
    };
    const put = (path, content, message, sha) =>
      gh(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, content, branch: BRANCH, ...(sha ? { sha } : {}) }) });

    try {
      statusEl.textContent = "上传固件文件…";
      await put(`firmware/${entry.name}`, b64(entry.raw), `固件库上传: ${entry.name} v${entry.version}`);

      statusEl.textContent = "更新 versions.json…";
      const listPath = "firmware/versions.json";
      const cur = await gh(listPath + `?t=${Date.now()}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
      const list = JSON.parse(atob(cur.content.replace(/\n/g, "")));
      const e2 = { ...entry }; delete e2.raw;
      const i = list.files.findIndex(x => x.name === e2.name);
      if (i >= 0) list.files[i] = e2; else list.files.push(e2);
      if (e2.recommended) for (const f of list.files) if (f.target === e2.target && f.name !== e2.name) f.recommended = false;
      await put(listPath, b64(new TextEncoder().encode(JSON.stringify(list, null, 2) + "\n")), `固件库清单: ${e2.name} v${e2.version}`, cur.sha);

      statusEl.textContent = `✓ 已发布 v${entry.version}（GitHub Pages ~1-2 分钟后生效）`;
      previewEl.hidden = false;
      previewEl.textContent += `\n\n✓ 已提交到 ${REPO} @${BRANCH}`;
      onPublished?.();
    } catch (e) {
      statusEl.textContent = "发布失败：" + e.message;
    } finally {
      upBtn.disabled = !entry;
    }
  });

  return { getEntry: () => entry };
}
