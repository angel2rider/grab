// ─── Grab — frontend ───

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const form = $("#searchForm");
const urlInput = $("#urlInput");
const goBtn = $("#goBtn");
const resultEl = $("#result");
const errorEl = $("#error");

urlInput.focus();

// ---------- helpers ----------
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("show");
}
function clearError() {
  errorEl.classList.remove("show");
}

function fmtDuration(s) {
  if (!s && s !== 0) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function fmtSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}
function fmtViews(n) {
  if (!n) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K views`;
  return `${n} views`;
}
function fmtDate(d) {
  if (!d) return "";
  const y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
  return new Date(`${y}-${m}-${day}`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function setLoading(on) {
  goBtn.disabled = on;
  goBtn.innerHTML = on ? `<span class="spinner"></span> Grabbing…` : `Grab`;
}

// ─── submit ───
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  const url = urlInput.value.trim();
  if (!url) return;
  setLoading(true);
  renderSkeleton();
  try {
    const r = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Failed to fetch info.");
    renderResult(data);
  } catch (err) {
    resultEl.innerHTML = "";
    showError(err.message || "Something went wrong.");
  } finally {
    setLoading(false);
  }
});

function renderSkeleton() {
  resultEl.innerHTML = `
    <div class="skeleton">
      <div class="skel skel-line"></div>
      <div class="skel skel-line short"></div>
      <div class="skel skel-line" style="height:80px"></div>
    </div>`;
}

function renderResult(data) {
  if (data.kind === "multi") return renderMulti(data);
  return renderSingle(data);
}

function sourcePillHtml(platformMeta, sourceType) {
  const meta = platformMeta || { label: "Web", color: "#80868b" };
  const color = meta.color || "#80868b";
  const label = meta.label || "Web";
  const arrow = sourceType === "match" ? `<span class="arrow">→ YouTube</span>` : "";
  return `<div class="source-pill"><span class="dot" style="background:${color}"></span>${escapeHtml(label)}${arrow}</div>`;
}

function matchedNoteHtml() {
  return `<div class="matched-note">Audio is sourced from YouTube and tagged with the original metadata from the linked service.</div>`;
}

// ═══════════════════════════════════════════════
//  SINGLE ITEM
// ═══════════════════════════════════════════════
let currentData = null;
let currentMode = "video";
let selected = { formatId: null, label: "Best available", size: null };

function renderSingle(data) {
  currentData = data;
  currentMode = data.isAudioOnly ? "audio" : "video";
  selected = { formatId: null, label: "Best available", size: null };

  const isMatch = data.sourceType === "match";
  const thumb = data.thumbnail
    ? `<img src="${data.thumbnail}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : "";
  const dur = data.duration ? `<div class="duration-pill">${fmtDuration(data.duration)}</div>` : "";
  const channel = isMatch
    ? (data.tracks?.[0]?.artist && `<span class="item">${escapeHtml(Array.isArray(data.tracks[0].artist) ? data.tracks[0].artist.join(", ") : data.tracks[0].artist)}</span>`)
    : (data.channel && `<span class="item">${escapeHtml(data.channel)}</span>`);
  const subItems = [
    channel,
    data.viewCount && `<span class="item">${fmtViews(data.viewCount)}</span>`,
    data.uploadDate && `<span class="item">${fmtDate(data.uploadDate)}</span>`,
  ].filter(Boolean).join("");

  resultEl.innerHTML = `
    <div class="card">
      <div class="result-grid">
        <div class="thumb-box">
          ${thumb}
          ${dur}
        </div>
        <div class="result-body">
          ${sourcePillHtml(data.platformMeta, data.sourceType)}
          ${isMatch ? matchedNoteHtml() : ""}
          <h2>${escapeHtml(data.title)}</h2>
          <div class="meta-row">${subItems}</div>

          ${!isMatch ? `
          <div class="options">
            <div class="field">
              <div class="field-label">Format</div>
              <div class="seg" id="modeSeg">
                <button type="button" class="${currentMode === 'video' ? 'active' : ''}" data-mode="video">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  Video
                </button>
                <button type="button" class="${currentMode === 'audio' ? 'active' : ''}" data-mode="audio">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  Audio (MP3)
                </button>
              </div>
            </div>
            <div class="field">
              <div class="field-label" id="qualityLabel">Quality</div>
              <div class="select">
                <select id="qualitySelect"></select>
              </div>
            </div>
          </div>
          ` : ''}

          <div class="dl-bar">
            <div class="dl-info" id="dlInfo">${isMatch ? '<b>MP3 audio</b> — matched & tagged' : '<b>MP4 video</b> · Best available quality'}</div>
            <button class="btn-dl" id="dlBtn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              Download
            </button>
          </div>
        </div>
      </div>
    </div>`;

  // Wire mode toggle (direct only)
  if (!isMatch) {
    $$("#modeSeg button").forEach((btn) =>
      btn.addEventListener("click", () => {
        currentMode = btn.dataset.mode;
        selected = { formatId: null, label: "Best available", size: null };
        $$("#modeSeg button").forEach((b) => b.classList.toggle("active", b === btn));
        populateQualitySelect();
        updateDlInfo();
      })
    );
    populateQualitySelect();
    $("#qualitySelect").addEventListener("change", onQualityChange);
  }

  $("#dlBtn").addEventListener("click", startSingleDownload);
}

// ─── quality dropdown ───
function populateQualitySelect() {
  const sel = $("#qualitySelect");
  const labelEl = $("#qualityLabel");
  if (!sel || !currentData) return;
  const formats = currentData.formats;
  sel.innerHTML = "";

  if (currentMode === "audio") {
    labelEl.textContent = "Bitrate";
    addOption(sel, "Best available (320 kbps)", "", null);
    (formats.audio || []).slice(0, 8).forEach((o) => {
      addOption(sel, `${o.label}${o.filesize ? " · " + fmtSize(o.filesize) : ""}`, o.label, o);
    });
  } else {
    labelEl.textContent = "Resolution";
    addOption(sel, "Best available (up to 4K+)", "", null);
    (formats.video || []).forEach((o) => {
      const estSize = o.filesize && formats.bestAudioSize
        ? (o.filesize + formats.bestAudioSize)
        : o.filesize;
      const sizeTxt = estSize ? " · " + fmtSize(estSize) : "";
      addOption(sel, `${o.label}${sizeTxt}`, o.label, o);
    });
  }
}

function addOption(sel, text, shortLabel, opt) {
  const o = document.createElement("option");
  o.textContent = text;
  o.value = shortLabel;
  o.dataset.formatId = opt ? opt.formatId : "";
  o.dataset.size = (opt && opt.filesize) ? opt.filesize : "";
  sel.appendChild(o);
}

function onQualityChange() {
  const sel = $("#qualitySelect");
  const idx = sel.selectedIndex;
  const opt = sel.options[idx];
  const formatId = opt.dataset.formatId || null;
  selected = {
    formatId,
    label: formatId ? opt.value : "Best available",
    size: opt.dataset.size ? Number(opt.dataset.size) : null,
  };
  updateDlInfo();
}

function updateDlInfo() {
  const el = $("#dlInfo");
  if (!el) return;
  if (currentMode === "audio") {
    el.innerHTML = `<b>MP3 audio</b> · ${escapeHtml(selected.label)}`;
  } else {
    el.innerHTML = `<b>MP4 video</b> · ${escapeHtml(selected.label)}`;
  }
}

// ─── single download with progress ───
async function startSingleDownload() {
  const dlBtn = $("#dlBtn");
  clearError();
  if (!currentData) return;

  const isMatch = currentData.sourceType === "match";
  dlBtn.disabled = true;
  const orig = dlBtn.innerHTML;
  dlBtn.innerHTML = `<span class="spinner"></span> Preparing…`;

  try {
    const body = isMatch
      ? {
          url: currentData.tracks[0].resolvedUrl,
          title: currentData.title,
          mode: "audio",
          sourceType: "match",
          platform: currentData.platform,
          meta: {
            title: currentData.tracks[0].title,
            artist: currentData.tracks[0].artist,
            album: currentData.tracks[0].album,
            image: currentData.tracks[0].artwork,
          },
        }
      : {
          url: urlInput.value.trim(),
          mode: currentMode === "audio" ? "audio" : "video",
          formatId: selected.formatId,
          title: currentData.title,
          sourceType: "direct",
          platform: currentData.platform,
        };

    const prep = await fetch("/api/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (prep.error) throw new Error(prep.error);

    // Start download in background, listen to progress via SSE
    await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: prep.token }),
    });

    startProgressUI(prep.token, orig, dlBtn);
  } catch (err) {
    showError(err.message || "Download failed.");
    dlBtn.disabled = false;
    dlBtn.innerHTML = orig;
  }
}

/**
 * Connect to SSE and show live progress bar while downloading.
 * @param {string} token
 * @param {string} origBtnHtml - original innerHTML to restore on the button
 * @param {HTMLElement} dlBtn - the download button element
 */
function startProgressUI(token, origBtnHtml, dlBtn) {
  const dlBar = dlBtn.closest(".dl-bar");
  const dlInfo = $("#dlInfo");
  if (!dlInfo) return;

  // Show progress in the dl-info area
  dlInfo.innerHTML = `
    <div class="dl-progress-wrap">
      <div class="dl-progress-step" id="dlStep">Starting…</div>
      <div class="dl-progress-bar"><div class="dl-progress-fill" id="dlProgressFill"></div></div>
      <div class="dl-progress-meta">
        <span class="dl-progress-pct" id="dlPct">0%</span>
        <span class="dl-progress-speed" id="dlSpeed"></span>
        <span class="dl-progress-eta" id="dlEta"></span>
      </div>
    </div>`;

  // Hide the download button while downloading
  dlBtn.style.display = "none";

  const restoreBtn = () => {
    dlBtn.style.display = "";
    dlBtn.disabled = false;
    dlBtn.innerHTML = origBtnHtml;
  };

  const evtSource = new EventSource(`/api/progress/${encodeURIComponent(token)}`);

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.status === "complete") {
        evtSource.close();
        // Trigger the actual file download
        const a = document.createElement("a");
        a.href = data.downloadUrl;
        a.download = data.filename || "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Show success state
        dlInfo.innerHTML = `<div class="dl-complete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1e8e3e" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          <span>Downloaded</span>
          <span class="dl-filename">${escapeHtml(data.filename || "")}</span>
          ${data.size ? `<span class="dl-filesize">${fmtSize(data.size)}</span>` : ""}
        </div>`;
        setTimeout(restoreBtn, 4000);
        return;
      }

      if (data.status === "error") {
        evtSource.close();
        showError(data.error || "Download failed.");
        dlInfo.innerHTML = `<div class="dl-error">Failed</div>`;
        restoreBtn();
        return;
      }

      // Update progress
      const fill = $("#dlProgressFill");
      const step = $("#dlStep");
      const pct = $("#dlPct");
      const speed = $("#dlSpeed");
      const eta = $("#dlEta");

      if (step) step.textContent = data.step || "";
      if (pct) pct.textContent = data.percent != null ? `${Math.round(data.percent)}%` : "—";
      if (fill) {
        fill.style.width = data.percent != null ? `${Math.min(data.percent, 100)}%` : "50%";
        fill.classList.toggle("indeterminate", data.percent == null);
      }
      if (speed) speed.textContent = data.speed || "";
      if (eta) eta.textContent = data.eta ? `ETA ${data.eta}` : "";
    } catch (err) {
      // ignore parse errors
    }
  };

  evtSource.onerror = () => {
    // EventSource auto-reconnects; only show error after a timeout
    setTimeout(() => {
      evtSource.close();
      showError("Connection lost. Please try again.");
      restoreBtn();
    }, 30_000);
  };
}

/**
 * Simplified SSE progress for ZIP/batch downloads.
 * Updates the zip button text with progress, then triggers file download on complete.
 */
function startZipProgress(token, origBtnHtml, zipBtn) {
  zipBtn.disabled = true;
  zipBtn.innerHTML = `<span class="spinner"></span> Preparing archive…`;

  const restoreBtn = () => {
    zipBtn.disabled = false;
    zipBtn.innerHTML = origBtnHtml;
  };

  const evtSource = new EventSource(`/api/progress/${encodeURIComponent(token)}`);

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.status === "complete") {
        evtSource.close();
        const a = document.createElement("a");
        a.href = data.downloadUrl;
        a.download = data.filename || "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        zipBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Downloaded`;
        setTimeout(restoreBtn, 4000);
        return;
      }

      if (data.status === "error") {
        evtSource.close();
        showError(data.error || "Archive download failed.");
        restoreBtn();
        return;
      }

      // Update button text with step info
      const step = data.step || "Processing…";
      const pct = data.percent != null ? ` ${Math.round(data.percent)}%` : "";
      zipBtn.innerHTML = `<span class="spinner"></span> ${step}${pct}`;
    } catch {}
  };

  evtSource.onerror = () => {
    setTimeout(() => {
      evtSource.close();
      showError("Connection lost. Please try again.");
      restoreBtn();
    }, 30_000);
  };
}

// ═══════════════════════════════════════════════
//  MULTI-ITEM (playlist / album / batch)
// ═══════════════════════════════════════════════
function renderMulti(data) {
  const isMatch = data.sourceType === "match";
  const items = isMatch ? data.tracks : data.items;
  const name = data.name || "Playlist";

  let multiMode = "audio";
  let multiSelected = { formatId: null, label: "Best available" };

  const rows = items.map((item, i) => {
    const title = isMatch
      ? `${escapeHtml(Array.isArray(item.artist) ? item.artist.join(", ") : item.artist || "")}${item.artist ? " — " : ""}${escapeHtml(item.title)}`
      : escapeHtml(item.title);
    const sub = isMatch
      ? (item.matchedBy ? `Matched by ${escapeHtml(item.matchedBy)}` : "")
      : (item.channel || item.uploader || "");
    const dur = fmtDuration(item.duration);
    const thumb = item.thumbnail
      ? `<div class="item-thumb"><img src="${item.thumbnail}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'"></div>`
      : `<div class="item-thumb"></div>`;
    const avail = isMatch && !item.resolvedUrl ? " unavailable" : "";

    return `<div class="item-row${avail}" data-index="${i}">
      <div class="item-check" data-index="${i}">✓</div>
      ${thumb}
      <div class="item-info">
        <div class="item-title">${title}</div>
        ${sub ? `<div class="item-sub">${escapeHtml(sub)}</div>` : ""}
      </div>
      ${dur ? `<div class="item-dur">${dur}</div>` : ""}
    </div>`;
  }).join("");

  resultEl.innerHTML = `
    <div class="card">
      <div class="multi-head">
        <h3>
          ${sourcePillHtml(data.platformMeta, data.sourceType)}
          ${escapeHtml(name)}
          <span class="multi-count">${items.length} items</span>
        </h3>
        <button class="btn-link" id="selectAll">Select all</button>
      </div>
      ${isMatch ? matchedNoteHtml() : ""}
      ${!isMatch ? `
      <div class="multi-options">
        <div class="field">
          <span class="field-label">Format</span>
          <div class="seg" id="multiModeSeg">
            <button type="button" class="${multiMode === 'video' ? 'active' : ''}" data-mode="video">Video</button>
            <button type="button" class="${multiMode === 'audio' ? 'active' : ''}" data-mode="audio">Audio (MP3)</button>
          </div>
        </div>
        <div class="field">
          <span class="field-label">Quality</span>
          <div class="select"><select id="multiQualitySelect"></select></div>
        </div>
      </div>
      ` : ''}
      <div class="item-list" id="itemList">${rows}</div>
      <div class="multi-foot">
        <span class="selected-count" id="selectedCount">0 selected</span>
        <button class="btn-primary" id="zipBtn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Download ZIP
        </button>
      </div>
    </div>`;

  const checked = new Set();
  const zipBtn = $("#zipBtn");
  const countEl = $("#selectedCount");
  const updateCount = () => {
    const n = checked.size;
    countEl.textContent = `${n} selected`;
    zipBtn.disabled = n === 0;
  };

  $$(".item-check").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index);
      if (checked.has(idx)) { checked.delete(idx); el.classList.remove("checked"); }
      else { checked.add(idx); el.classList.add("checked"); }
      updateCount();
    });
  });
  $$(".item-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".item-check")) return;
      if (row.classList.contains("unavailable")) return;
      const idx = parseInt(row.dataset.index);
      const chk = row.querySelector(".item-check");
      if (checked.has(idx)) { checked.delete(idx); chk.classList.remove("checked"); }
      else { checked.add(idx); chk.classList.add("checked"); }
      updateCount();
    });
  });

  const selectAllBtn = $("#selectAll");
  let allSelected = false;
  selectAllBtn.addEventListener("click", () => {
    allSelected = !allSelected;
    items.forEach((_, i) => {
      const row = document.querySelector(`.item-row[data-index="${i}"]`);
      if (!row || row.classList.contains("unavailable")) return;
      const chk = row.querySelector(".item-check");
      if (allSelected) { checked.add(i); chk.classList.add("checked"); }
      else { checked.delete(i); chk.classList.remove("checked"); }
    });
    selectAllBtn.textContent = allSelected ? "Deselect all" : "Select all";
    updateCount();
  });

  if (!isMatch) {
    const modeSeg = $("#multiModeSeg");
    const qSel = $("#multiQualitySelect");
    const repopulate = () => {
      qSel.innerHTML = "";
      if (multiMode === "audio") {
        addOption(qSel, "Best available (320 kbps)", "", null);
        addOption(qSel, "320 kbps", "320", { formatId: "320", filesize: 0 });
        addOption(qSel, "256 kbps", "256", { formatId: "256", filesize: 0 });
        addOption(qSel, "192 kbps", "192", { formatId: "192", filesize: 0 });
      } else {
        addOption(qSel, "Best available (up to 4K+)", "", null);
        addOption(qSel, "1080p", "1080p", { formatId: "1080p", filesize: 0 });
        addOption(qSel, "720p", "720p", { formatId: "720p", filesize: 0 });
        addOption(qSel, "480p", "480p", { formatId: "480p", filesize: 0 });
      }
      multiSelected = { formatId: null, label: "Best available" };
    };
    repopulate();
    modeSeg.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        multiMode = btn.dataset.mode;
        modeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        repopulate();
      });
    });
    qSel.addEventListener("change", () => {
      const opt = qSel.options[qSel.selectedIndex];
      multiSelected = {
        formatId: opt.dataset.formatId || null,
        label: opt.value || "Best available",
      };
    });
  }

  zipBtn.addEventListener("click", async () => {
    if (checked.size === 0) return;
    clearError();
    zipBtn.disabled = true;
    const orig = zipBtn.innerHTML;
    zipBtn.innerHTML = `<span class="spinner"></span> Preparing archive…`;

    try {
      const selectedItems = Array.from(checked).sort((a, b) => a - b).map((i) => items[i]);
      let body;
      if (isMatch) {
        body = { sourceType: "match", platform: data.platform, isBatch: true, name, items: selectedItems };
      } else {
        body = { sourceType: "direct", platform: data.platform, isBatch: true, mode: multiMode, formatId: multiSelected.formatId, name, items: selectedItems };
      }

      const prep = await fetch("/api/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (prep.error) throw new Error(prep.error);

      // Trigger download in background
      await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: prep.token }),
      });

      startZipProgress(prep.token, orig, zipBtn);
    } catch (err) {
      showError(err.message || "Failed to prepare archive.");
      zipBtn.disabled = false;
      zipBtn.innerHTML = orig;
    }
  });
}
