// ─── Grab — frontend ───

const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? ''
  : 'https://grab-api.msedge.lol';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const form = $("#searchForm");
const urlInput = $("#urlInput");
let goBtn = $("#goBtn");
const grabBtnWrap = $("#grabBtnWrap");
const resultEl = $("#result");
const errorEl = $("#error");
const heroSection = $(".hero-section");

urlInput.focus();

urlInput.addEventListener("input", () => {
  if (goBtnMode === "download") {
    setGoBtn("search");
    moveBtnToWrap();
  }
});

// ─── Theme toggle ───
const themeToggle = $("#themeToggle");
const html = document.documentElement;
const savedTheme = localStorage.getItem("grab-theme") || "dark";
html.setAttribute("data-theme", savedTheme);

themeToggle.addEventListener("click", () => {
  const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("grab-theme", next);
  themeToggle.style.transform = 'rotate(180deg)';
  setTimeout(() => { themeToggle.style.transform = 'rotate(0deg)'; }, 300);
  // Re-apply palette for the new theme (or clear if none active)
  if (window.__palette) {
    applyAccentColors(window.__palette);
  } else {
    clearInlineTheme();
  }
});

// ─── Clear inline theme variables (restore stylesheet defaults) ──
function clearInlineTheme() {
  window.__palette = null;
  const s = document.documentElement.style;
  const vars = ['--accent','--accent-h','--accent-bg','--accent-glow',
    '--bg','--bg-2','--bg-3','--glass-bg','--glass-border',
    '--input-bg','--seg-bg','--seg-active','--scrollbar'];
  for (const v of vars) s.removeProperty(v);
}

// ─── Adaptive theming: apply full color palette from server ───
function applyAccentColors(palette) {
  if (!palette || !palette.accent) return;
  const { accent, bg, surface } = palette;
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) return;

  window.__palette = palette;

  const parse = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(accent);
  const darken = (v) => Math.max(0, Math.round(v * 0.78));
  const lighten = (v) => Math.min(255, Math.round(v * 1.25));

  const root = document.documentElement, s = root.style;
  const isDark = root.getAttribute("data-theme") !== "light";

  // ── accent: buttons, links, active (always applied, glow varies by theme) ──
  s.setProperty('--accent', accent);
  s.setProperty('--accent-h', `rgb(${darken(ar)},${darken(ag)},${darken(ab)})`);
  s.setProperty('--accent-bg', `rgba(${ar},${ag},${ab},0.10)`);

  if (isDark) {
    // ── DARK MODE: full background tint from palette ──
    s.setProperty('--accent-glow', `rgba(${ar},${ag},${ab},0.16)`);
    if (bg) {
      const [br, bgg, bb] = parse(bg);
      s.setProperty('--bg', bg);
      s.setProperty('--bg-2', `rgb(${Math.round(br*0.85)},${Math.round(bgg*0.85)},${Math.round(bb*0.85)})`);
      s.setProperty('--bg-3', `rgb(${Math.round(br*0.70)},${Math.round(bgg*0.70)},${Math.round(bb*0.70)})`);
      s.setProperty('--glass-bg', `rgba(${br},${bgg},${bb},0.28)`);
      s.setProperty('--glass-border', `rgba(${br},${bgg},${bb},0.22)`);
    } else {
      s.setProperty('--glass-bg', `rgba(${ar},${ag},${ab},0.10)`);
      s.setProperty('--glass-border', `rgba(${ar},${ag},${ab},0.12)`);
    }
    if (surface) {
      const [sr, sgg, sb] = parse(surface);
      s.setProperty('--input-bg', `rgba(${sr},${sgg},${sb},0.35)`);
      s.setProperty('--seg-bg', `rgba(${sr},${sgg},${sb},0.30)`);
      s.setProperty('--seg-active', `rgba(${sr},${sgg},${sb},0.45)`);
      s.setProperty('--scrollbar', `rgba(${sr},${sgg},${sb},0.20)`);
    } else {
      s.setProperty('--input-bg', `rgba(${ar},${ag},${ab},0.20)`);
      s.setProperty('--seg-bg', `rgba(${ar},${ag},${ab},0.18)`);
      s.setProperty('--seg-active', `rgba(${ar},${ag},${ab},0.28)`);
      s.setProperty('--scrollbar', `rgba(${ar},${ag},${ab},0.12)`);
    }
  } else {
    // ── LIGHT MODE: keep paper-white base, tint elements subtly with accent ──
    s.setProperty('--accent-glow', `rgba(${ar},${ag},${ab},0.20)`);
    // Clear bg overrides (restore stylesheet paper-white)
    s.removeProperty('--bg');
    s.removeProperty('--bg-2');
    s.removeProperty('--bg-3');
    // Glass card gets a soft accent tint on light background
    s.setProperty('--glass-bg', `rgba(${ar},${ag},${ab},0.06)`);
    s.setProperty('--glass-border', `rgba(${ar},${ag},${ab},0.10)`);
    // Interactive elements get light accent tints
    s.setProperty('--input-bg', `rgba(${ar},${ag},${ab},0.08)`);
    s.setProperty('--seg-bg', `rgba(${ar},${ag},${ab},0.07)`);
    s.setProperty('--seg-active', `rgba(255,252,240,0.75)`);
    s.setProperty('--scrollbar', `rgba(${ar},${ag},${ab},0.10)`);
  }
}

// ─── helpers ───
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
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
}
function fmtDate(d) {
  if (!d) return "";
  const y = d.slice(0, 4), m = d.slice(4, 6), day = d.slice(6, 8);
  return new Date(`${y}-${m}-${day}`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function normalizeUrl(raw) {
  if (!raw) return raw;
  let videoId = null;
  // youtu.be/ID and you.tube/ID
  const ytBe = raw.match(/^https?:\/\/(?:youtu\.be|you\.tube)\/([A-Za-z0-9_-]{11})/);
  if (ytBe) videoId = ytBe[1];
  if (!videoId) {
    const ytWatch = raw.match(/^https?:\/\/(?:www\.|m\.|music\.|gaming\.|(?:[-\w]+\.))*youtube(?:-nocookie)?\.com\/(?:watch\?v=|v\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    if (ytWatch) videoId = ytWatch[1];
  }
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return raw;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── submit ───
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (goBtnMode === "download") {
    startSingleDownload();
    return;
  }
  clearError();
  const url = urlInput.value.trim();
  if (!url) return;
  // Normalize for clean display and consistent caching
  const normalized = normalizeUrl(url);
  if (normalized !== url) urlInput.value = normalized;
  goBtnMode = "search";
  setLoading(true);
  renderSkeleton();
  try {
    const r = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(normalized)}`);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(r.ok ? "Server returned an unexpected response." : `Server error (${r.status}).`);
    }
    if (!r.ok) throw new Error(data.error || "Failed to fetch info.");

    // Apply adaptive color palette from server
    if (data.palette) {
      applyAccentColors(data.palette);
    } else if (data.accentHex) {
      applyAccentColors({ accent: data.accentHex });
    }

    renderResult(data);
    if (data.kind !== "multi") setGoBtn("download");

    // Trigger boids reaction
    if (window.boidsBurst) window.boidsBurst();
  } catch (err) {
    resultEl.innerHTML = "";
    moveBtnToWrap();
    showError(err.message || "Something went wrong.");
    goBtnMode = "search";
    setLoading(false);
  } finally {
    if (!resultEl.innerHTML) { goBtnMode = "search"; moveBtnToWrap(); setLoading(false); }
  }
});

function renderSkeleton() {
  resultEl.innerHTML = `
    <div class="skeleton">
      <div class="skel skel-line"></div>
      <div class="skel skel-line short"></div>
      <div class="skel skel-line" style="height:72px"></div>
    </div>`;
}

function renderResult(data) {
  if (data.kind === "multi") return renderMulti(data);
  return renderSingle(data);
}

function sourcePillHtml(platformMeta, sourceType) {
  const meta = platformMeta || { label: "Web", color: "#94a3b8" };
  const color = meta.color || "#94a3b8";
  const label = meta.label || "Web";
  const arrow = sourceType === "match" ? `<span class="arrow"> → YouTube</span>` : "";
  return `<div class="source-pill"><span class="dot" style="background:${color}"></span>${escapeHtml(label)}${arrow}</div>`;
}

function matchedNoteHtml() {
  return `<div class="matched-note">Audio sourced from YouTube & tagged with original metadata.</div>`;
}

// ═══════════════════════════════════════════════
//  SINGLE ITEM
// ═══════════════════════════════════════════════
let currentData = null;
let currentMode = "video";
let selected = { formatId: null, label: "Best available", size: null, height: null, codec: null };
let goBtnMode = "search";

function setGoBtn(mode) {
  goBtnMode = mode;
  goBtn.disabled = false;
  if (mode === "search") {
    goBtn.textContent = "Grab";
    goBtn.classList.remove("btn-dl-mode");
  } else if (mode === "download") {
    goBtn.textContent = "Download";
    goBtn.classList.add("btn-dl-mode");
  } else if (mode === "loading") {
    goBtn.disabled = true;
    goBtn.innerHTML = `<span class="spinner"></span> Grab`;
    goBtn.classList.remove("btn-dl-mode");
  } else if (mode === "downloading") {
    goBtn.disabled = true;
    goBtn.innerHTML = `<span class="spinner"></span> Preparing`;
  }
}

function setLoading(on) {
  if (on) { setGoBtn("loading"); }
  else { setGoBtn(goBtnMode); }
}

function moveBtnToWrap() {
  const oldBtn = $("#goBtn");
  if (oldBtn) oldBtn.remove();
  grabBtnWrap.innerHTML = `<button class="btn-grab" type="submit" id="goBtn" form="searchForm">Grab</button>`;
  grabBtnWrap.style.display = "";
  goBtn = $("#goBtn");
  if (heroSection) heroSection.classList.remove("has-results");
  form.classList.remove("collapsed");
}

function renderSingle(data) {
  currentData = data;
  currentMode = data.isAudioOnly ? "audio" : "video";
  selected = { formatId: null, label: "Best available", size: null, height: null, codec: null };

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
    data.viewCount && `<span class="item">${fmtViews(data.viewCount)} views</span>`,
    data.uploadDate && `<span class="item">${fmtDate(data.uploadDate)}</span>`,
  ].filter(Boolean).join(`<span class="sep">·</span>`);

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
                <button type="button" class="${currentMode === 'video' ? 'active' : ''}" data-mode="video">Video</button>
                <button type="button" class="${currentMode === 'audio' ? 'active' : ''}" data-mode="audio">Audio</button>
              </div>
            </div>
            <div class="opts-audio" style="${currentMode === 'audio' ? '' : 'display:none'}">
              <div class="field">
                <div class="field-label">Bitrate</div>
                <div class="select">
                  <select id="qualitySelect"></select>
                </div>
              </div>
            </div>
            <div class="opts-video" style="${currentMode === 'video' ? '' : 'display:none'}">
              <div class="select-row">
                <div class="field">
                  <div class="field-label">Resolution</div>
                  <div class="select">
                    <select id="resSelect"></select>
                  </div>
                </div>
                <div class="field">
                  <div class="field-label">Codec</div>
                  <div class="select">
                    <select id="codecSelect"></select>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ` : ''}

          <div class="dl-bar">
            <div class="dl-info" id="dlInfo">${isMatch ? '<b>MP3 audio</b> — matched & tagged' : '<b>MP4 video</b> · Best available'}</div>
            <div id="dlBtnSlot"><button class="btn-grab" type="submit" id="goBtn" form="searchForm"></button></div>
          </div>
        </div>
      </div>
    </div>`;

  const oldBtn = $("#goBtn");
  if (oldBtn) oldBtn.remove();
  goBtn = $("#goBtn");
  grabBtnWrap.style.display = "none";
  if (heroSection) heroSection.classList.add("has-results");
  form.classList.add("collapsed");

  if (!isMatch) {
    $$("#modeSeg button").forEach((btn) =>
      btn.addEventListener("click", () => {
        currentMode = btn.dataset.mode;
        selected = { formatId: null, label: "Best available", size: null, height: null, codec: null };
        $$("#modeSeg button").forEach((b) => b.classList.toggle("active", b === btn));
        const audioOpts = document.querySelector(".opts-audio");
        const videoOpts = document.querySelector(".opts-video");
        if (audioOpts) audioOpts.style.display = currentMode === "audio" ? "" : "none";
        if (videoOpts) videoOpts.style.display = currentMode === "video" ? "" : "none";
        populateFormatSelects();
        updateDlInfo();
      })
    );
    populateFormatSelects();
    updateDlInfo();
  }

  const slot = $("#dlBtnSlot");
  if (slot) {
    slot.appendChild(goBtn);
    grabBtnWrap.style.display = "none";
  }
}

// ─── cascading format selects ───
function populateFormatSelects() {
  if (!currentData || !currentData.formats) return;
  if (currentMode === "audio") { populateAudioSelect(); return; }

  const v = currentData.formats.video;
  if (!v || !v.resolutions || !v.resolutions.length) {
    const codecSel = $("#codecSelect");
    if (codecSel) codecSel.innerHTML = `<option value="">No codec data</option>`;
    updateDlInfo();
    return;
  }

  const resSel = $("#resSelect");
  const codecSel = $("#codecSelect");
  if (!resSel || !codecSel) return;

  const bestAudioSize = currentData.formats.bestAudioSize;
  resSel.innerHTML = `<option value="">Best quality</option>`;
  for (const h of v.resolutions) {
    const codecs = v.byRes[h] || [];
    const best = codecs[0];
    const estSize = best && best.filesize && bestAudioSize ? (best.filesize + bestAudioSize) : (best && best.filesize);
    const sizeTxt = estSize ? ` · ~${fmtSize(estSize)}` : "";
    const fpsTxt = best && best.fps >= 50 ? ` ${best.fps}fps` : "";
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = `${h}p${fpsTxt}${sizeTxt}`;
    resSel.appendChild(opt);
  }

  function updateCodecSelect(resHeight) {
    codecSel.innerHTML = "";
    const codecs = resHeight ? (v.byRes[resHeight] || []) : [];
    if (!codecs.length) {
      codecSel.innerHTML = `<option value="">Any available</option>`;
      selected = { formatId: null, label: "Best available", size: null, height: resHeight || null, codec: null };
      return;
    }
    for (const c of codecs) {
      const estSize = c.filesize && bestAudioSize ? (c.filesize + bestAudioSize) : c.filesize;
      const sizeTxt = estSize ? ` · ~${fmtSize(estSize)}` : "";
      const fpsTxt = c.fps >= 50 ? ` ${c.fps}fps` : "";
      const opt = document.createElement("option");
      opt.value = c.formatId;
      opt.dataset.formatId = c.formatId;
      opt.dataset.size = estSize || "";
      opt.dataset.codec = c.codec;
      opt.dataset.height = c.height;
      opt.textContent = `${c.codec}${fpsTxt}${sizeTxt}`;
      codecSel.appendChild(opt);
    }
    const first = codecs[0];
    if (first) {
      const estSize = first.filesize && bestAudioSize ? (first.filesize + bestAudioSize) : first.filesize;
      selected = { formatId: first.formatId, label: first.codec, size: estSize, height: first.height, codec: first.codec };
    }
  }

  if (!resSel._listenersReady) {
    resSel.addEventListener("change", () => {
      const h = resSel.value ? parseInt(resSel.value) : null;
      updateCodecSelect(h);
      onCodecChange();
      updateDlInfo();
    });
    codecSel.addEventListener("change", () => {
      onCodecChange();
      updateDlInfo();
    });
    resSel._listenersReady = true;
  }

  updateCodecSelect(null);

  function onCodecChange() {
    const opt = codecSel.options[codecSel.selectedIndex];
    if (!opt || !opt.value) {
      const h = resSel.value ? parseInt(resSel.value) : null;
      selected = { formatId: null, label: "Best available", size: null, height: h, codec: null };
    } else {
      const h = parseInt(opt.dataset.height) || null;
      selected = {
        formatId: opt.dataset.formatId || null,
        label: opt.dataset.codec || opt.value,
        size: opt.dataset.size ? Number(opt.dataset.size) : null,
        height: h,
        codec: opt.dataset.codec || null,
      };
    }
  }
}

function populateAudioSelect() {
  const sel = $("#qualitySelect");
  if (!sel || !currentData || !currentData.formats) return;
  sel.innerHTML = "";
  addOption(sel, "Best available (320 kbps)", "", null);
  const audios = currentData.formats.audio || [];
  for (const o of audios.slice(0, 8)) {
    addOption(sel, `${o.label}${o.filesize ? " · " + fmtSize(o.filesize) : ""}`, o.label, o);
  }
  selected = { formatId: null, label: "Best available", size: null, height: null, codec: null };

  if (!sel._listenersReady) {
    sel.addEventListener("change", () => {
      const opt = sel.options[sel.selectedIndex];
      if (!opt || !opt.value) {
        selected = { formatId: null, label: "Best available", size: null, height: null, codec: null };
      } else {
        selected = {
          formatId: opt.dataset.formatId || null,
          label: opt.value || "Best available",
          size: opt.dataset.size ? Number(opt.dataset.size) : null,
          height: null, codec: null,
        };
      }
      updateDlInfo();
    });
    sel._listenersReady = true;
  }
  updateDlInfo();
}

function addOption(sel, text, shortLabel, opt) {
  const o = document.createElement("option");
  o.textContent = text;
  o.value = shortLabel;
  o.dataset.formatId = opt ? opt.formatId : "";
  o.dataset.size = (opt && opt.filesize) ? opt.filesize : "";
  sel.appendChild(o);
}

function updateDlInfo() {
  const el = $("#dlInfo");
  if (!el) return;
  if (currentMode === "audio") {
    el.innerHTML = `<b>MP3 audio</b> · ${escapeHtml(selected.label)}`;
  } else if (selected.height) {
    const codecTag = selected.codec ? `<span class="codec-tag">${escapeHtml(selected.codec)}</span>` : "";
    el.innerHTML = `<b>${selected.height}p</b>${codecTag} · ${escapeHtml(selected.label)}`;
  } else {
    el.innerHTML = `<b>MP4 video</b> · Best quality`;
  }
}

// ═══════════════════════════════════════════════
//  DOWNLOAD · Animated progress ring
// ═══════════════════════════════════════════════
const PROGRESS_RING_R = 34;
const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_R;

async function startSingleDownload() {
  clearError();
  if (!currentData) return;

  const isMatch = currentData.sourceType === "match";
  setGoBtn("downloading");

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
          url: normalizeUrl(urlInput.value.trim()),
          mode: currentMode === "audio" ? "audio" : "video",
          formatId: selected.formatId,
          title: currentData.title,
          sourceType: "direct",
          platform: currentData.platform,
        };

    const prep = await fetch(`${API_BASE}/api/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (prep.error) throw new Error(prep.error);

    await fetch(`${API_BASE}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: prep.token }),
    });

    // Trigger boids burst on download start
    if (window.boidsBurst) window.boidsBurst();

    startProgressUI(prep.token, goBtn);
  } catch (err) {
    showError(err.message || "Download failed.");
    goBtn.disabled = false;
    setGoBtn("download");
  }
}

function startProgressUI(token, btn) {
  const dlInfo = $("#dlInfo");
  if (!dlInfo) return;

  // Build SVG progress ring
  dlInfo.innerHTML = `
    <div class="progress-ring-wrap">
      <div class="progress-ring-container">
        <svg class="progress-ring-svg" viewBox="0 0 80 80">
          <circle class="progress-ring-track"
            cx="40" cy="40" r="${PROGRESS_RING_R}" />
          <circle class="progress-ring-fill" id="ringFill"
            cx="40" cy="40" r="${PROGRESS_RING_R}"
            stroke-dasharray="${PROGRESS_CIRCUMFERENCE}"
            stroke-dashoffset="${PROGRESS_CIRCUMFERENCE}" />
        </svg>
        <div class="progress-ring-text">
          <span class="progress-ring-pct" id="ringPct">0%</span>
        </div>
        <div class="progress-ring-check" id="ringCheck">
          <svg viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>
      <span class="progress-ring-step" id="ringStep">Preparing…</span>
      <div class="progress-ring-meta">
        <span class="progress-ring-speed" id="ringSpeed"></span>
        <span class="progress-ring-eta" id="ringEta"></span>
      </div>
    </div>`;

  btn.style.display = "none";

  let completed = false;

  const restoreBtn = () => {
    btn.style.display = "";
    setGoBtn("download");
  };

  const showComplete = (data) => {
    completed = true;
    // Trigger boids expansion on completion
    if (window.boidsExpand) window.boidsExpand();

    const a = document.createElement("a");
    a.href = `${API_BASE}${data.downloadUrl}`;
    a.download = data.filename || "";
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Show checkmark
    const check = $("#ringCheck");
    if (check) check.classList.add("show");
    const pct = $("#ringPct");
    if (pct) pct.style.display = "none";

    const step = $("#ringStep");
    if (step) {
      step.textContent = data.filename ? `Saved as ${data.filename}` : "Download complete";
      step.style.color = "var(--ok)";
    }

    dlInfo.innerHTML = `<div class="dl-complete">
      <span>Downloaded</span>
      <span class="dl-filename">${escapeHtml(data.filename || "")}</span>
      ${data.size ? `<span class="dl-filesize">${fmtSize(data.size)}</span>` : ""}
    </div>`;
    setTimeout(() => restoreBtn(), 5000);
  };

  const updateProgress = (data) => {
    const fill = $("#ringFill");
    const pct = $("#ringPct");
    const step = $("#ringStep");
    const speed = $("#ringSpeed");
    const eta = $("#ringEta");

    const percent = data.percent != null ? Math.min(data.percent, 99) : 0;
    if (fill) {
      const offset = PROGRESS_CIRCUMFERENCE - (percent / 100) * PROGRESS_CIRCUMFERENCE;
      fill.setAttribute("stroke-dashoffset", offset);
    }
    if (pct) {
      pct.textContent = data.percent != null ? `${Math.round(data.percent)}%` : "";
    }
    if (step) {
      step.textContent = data.detail && data.step ? `${data.step} · ${data.detail}` : (data.step || "");
    }
    if (speed) speed.textContent = data.speed || "";
    if (eta) eta.textContent = data.eta ? `ETA ${data.eta}` : "";
  };

  const evtSource = new EventSource(`${API_BASE}/api/progress/${encodeURIComponent(token)}`);

  evtSource.addEventListener("progress", (e) => {
    try {
      const data = JSON.parse(e.data);
      updateProgress(data);
    } catch {}
  });

  evtSource.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      evtSource.close();
      if (data.status === "complete") {
        updateProgress(data);
        setTimeout(() => showComplete(data), 400);
      } else {
        showError(data.error || "Download failed.");
        dlInfo.innerHTML = `<div class="dl-error">${escapeHtml(data.error || "Download failed.")}</div>`;
        restoreBtn();
      }
    } catch {}
  });

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.status === "complete") {
        evtSource.close();
        updateProgress(data);
        setTimeout(() => showComplete(data), 400);
      } else if (data.status === "error") {
        evtSource.close();
        showError(data.error || "Download failed.");
        dlInfo.innerHTML = `<div class="dl-error">${escapeHtml(data.error || "Download failed.")}</div>`;
        restoreBtn();
      } else {
        updateProgress(data);
      }
    } catch {}
  };

  evtSource.onerror = () => {
    setTimeout(() => {
      if (!completed) {
        evtSource.close();
        showError("Connection lost. Please try again.");
        restoreBtn();
      }
    }, 8000);
  };
}

function startZipProgress(token, zipBtn, origBtnText) {
  zipBtn.disabled = true;
  zipBtn.innerHTML = `<span class="spinner"></span> Archiving`;

  let completed = false;

  const restoreBtn = () => {
    zipBtn.disabled = false;
    zipBtn.innerHTML = origBtnText;
  };

  const evtSource = new EventSource(`${API_BASE}/api/progress/${encodeURIComponent(token)}`);

  evtSource.addEventListener("progress", (e) => {
    try {
      const data = JSON.parse(e.data);
      const step = data.step || "Processing…";
      const pct = data.percent != null ? ` ${Math.round(data.percent)}%` : "";
      zipBtn.innerHTML = `<span class="spinner"></span> ${step}${pct}`;
    } catch {}
  });

  evtSource.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      evtSource.close();
      completed = true;
      if (window.boidsExpand) window.boidsExpand();
      if (data.status === "complete") {
        const a = document.createElement("a");
        a.href = `${API_BASE}${data.downloadUrl}`;
        a.download = data.filename || "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        zipBtn.innerHTML = `Downloaded`;
        setTimeout(restoreBtn, 5000);
      } else {
        showError(data.error || "Archive download failed.");
        restoreBtn();
      }
    } catch {}
  });

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.status === "complete") {
        evtSource.close();
        completed = true;
        if (window.boidsExpand) window.boidsExpand();
        const a = document.createElement("a");
        a.href = `${API_BASE}${data.downloadUrl}`;
        a.download = data.filename || "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        zipBtn.innerHTML = `Downloaded`;
        setTimeout(restoreBtn, 5000);
      } else if (data.status === "error") {
        evtSource.close();
        completed = true;
        showError(data.error || "Archive download failed.");
        restoreBtn();
      } else {
        const step = data.step || "Processing…";
        const pct = data.percent != null ? ` ${Math.round(data.percent)}%` : "";
        zipBtn.innerHTML = `<span class="spinner"></span> ${step}${pct}`;
      }
    } catch {}
  };

  evtSource.onerror = () => {
    setTimeout(() => {
      if (!completed) {
        evtSource.close();
        showError("Connection lost. Please try again.");
        restoreBtn();
      }
    }, 8000);
  };
}

// ═══════════════════════════════════════════════
//  MULTI-ITEM
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
      ? `<div class="item-thumb"><img src="${item.thumbnail}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none'></div>`
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

  moveBtnToWrap();
  if (heroSection) heroSection.classList.add("has-results");

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
        <button class="btn-primary" id="zipBtn" disabled>Download ZIP</button>
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
    zipBtn.innerHTML = `<span class="spinner"></span> Archiving`;

    try {
      const selectedItems = Array.from(checked).sort((a, b) => a - b).map((i) => items[i]);
      let body;
      if (isMatch) {
        body = { sourceType: "match", platform: data.platform, isBatch: true, name, items: selectedItems };
      } else {
        body = { sourceType: "direct", platform: data.platform, isBatch: true, mode: multiMode, formatId: multiSelected.formatId, name, items: selectedItems };
      }

      const prep = await fetch(`${API_BASE}/api/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (prep.error) throw new Error(prep.error);

      await fetch(`${API_BASE}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: prep.token }),
      });

      if (window.boidsBurst) window.boidsBurst();
      startZipProgress(prep.token, zipBtn, orig);
    } catch (err) {
      showError(err.message || "Failed to prepare archive.");
      zipBtn.disabled = false;
      zipBtn.innerHTML = orig;
    }
  });
}
