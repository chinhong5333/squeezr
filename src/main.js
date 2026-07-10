import JSZip from 'jszip';
import '@fontsource-variable/inter';
import './style.css';

// Reload once when a *new* service worker takes control after a redeploy, so the
// still-running old page never lazily imports a hashed codec chunk the new SW has
// already evicted (which would 404). Skips the very first controller acquisition.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });
}

// ------------------------------------------------------------------ worker ---
let worker;
function createWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = onWorkerError;
}
createWorker();

// ------------------------------------------------------------------- state ---
/**
 * @typedef {Object} Item
 * @property {number} id
 * @property {File}   file
 * @property {string} name
 * @property {number} size
 * @property {string} mime
 * @property {?string} thumbUrl    // object URL for the list thumbnail
 * @property {?number} srcW        // original pixel width (once decoded for the thumb)
 * @property {?number} srcH        // original pixel height
 * @property {boolean} webp        // WebP setting frozen at compress time
 * @property {number}  scale       // resize % (10–100) frozen at compress time; 100 = no resize
 * @property {'pending'|'queued'|'processing'|'done'|'kept'|'error'} status
 * @property {?Object} result
 * @property {?string} error
 */

/** @type {Item[]} */
const items = [];
const byId = (id) => items.find((it) => it.id === id);
let idSeq = 0;

let queue = [];
let activeId = null;
let busy = false;
// Progress is scoped to the current run so a second batch starts from 0, not
// from the all-time completed count.
let batchTotal = 0;
let batchDone = 0;

// --------------------------------------------------------------------- dom ---
const $ = (sel) => document.querySelector(sel);
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const controlsCta = $('#controls-cta');
const webpToggle = $('#webp-toggle');
const resizeToggle = $('#resize-toggle');
const resizeSelect = $('#resize-select');
const btnCompress = $('#btn-compress');
const btnDownload = $('#btn-download');
const btnClear = $('#btn-clear');
const overall = $('#overall');
const overallFill = $('#overall-fill');
const overallText = $('#overall-text');
const summary = $('#summary');
const fileList = $('#file-list');
const notice = $('#notice');

// ----------------------------------------------------------------- helpers ---
const ACCEPT = new Set(['image/png', 'image/jpeg']);
const MAX_BATCH = 20;

let noticeTimer;
function showNotice(msg) {
  notice.textContent = msg;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 5000);
}

// -------------------------------------------------------------------- theme ---
// The saved theme is applied pre-paint by an inline script in index.html; here we
// only wire the toggle. Default is the light (coffee) theme.
const THEME_KEY = 'squeezr-theme';
const themeBtn = $('#theme-btn');
const themeIsDark = () => document.documentElement.dataset.theme === 'dark';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {
    /* private mode / storage disabled */
  }
  themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
themeBtn.setAttribute('aria-label', themeIsDark() ? 'Switch to light theme' : 'Switch to dark theme');
themeBtn.addEventListener('click', () => applyTheme(themeIsDark() ? 'light' : 'dark'));

// ------------------------------------------------------------ bg spotlight ---
// Feed the pointer position into the background layers via --cx/--cy. rAF-throttled so
// at most one style write per frame; skipped entirely when reduced motion is preferred.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const root = document.documentElement;
  let px = 0;
  let py = 0;
  let queued = false;
  window.addEventListener(
    'pointermove',
    (e) => {
      px = e.clientX;
      py = e.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        root.style.setProperty('--cx', `${px}px`);
        root.style.setProperty('--cy', `${py}px`);
      });
    },
    { passive: true }
  );
}

// The percent dropdown is only meaningful while the resize toggle is on.
resizeToggle.addEventListener('change', () => {
  resizeSelect.disabled = !resizeToggle.checked;
  refreshPendingDims();
});
resizeSelect.addEventListener('change', refreshPendingDims);
// Sync once at startup: a browser that restores the checkbox state across a reload
// (Firefox soft reload / session restore) does so without firing 'change', which
// would otherwise leave the toggle checked but the dropdown stuck disabled.
resizeSelect.disabled = !resizeToggle.checked;

/** Re-render not-yet-compressed cards so their resized-size preview stays current. */
function refreshPendingDims() {
  items.filter((it) => it.status === 'pending').forEach(renderItem);
}

function mimeOf(file) {
  if (ACCEPT.has(file.type)) return file.type;
  const n = file.name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return file.type || '';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function savedPct(orig, next) {
  if (!orig) return 0;
  return Math.max(0, Math.round((1 - next / orig) * 100));
}

// ------------------------------------------------------------------- input ---
function addFiles(fileArr) {
  const supported = fileArr.filter((f) => ACCEPT.has(mimeOf(f)));
  const rejectedType = fileArr.length - supported.length;
  const room = Math.max(0, MAX_BATCH - items.length);
  const toAdd = supported.slice(0, room);
  const rejectedCap = supported.length - toAdd.length;

  const fresh = [];
  for (const file of toAdd) {
    const mime = mimeOf(file);
    const it = {
      id: idSeq++,
      file,
      name: file.name || `pasted-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`,
      size: file.size,
      mime,
      thumbUrl: null,
      srcW: null,
      srcH: null,
      webp: false,
      scale: 100,
      status: 'pending',
      result: null,
      error: null,
    };
    items.push(it);
    fresh.push(it);
  }

  if (rejectedCap > 0) {
    showNotice(`Batch limit is ${MAX_BATCH} images — added ${toAdd.length}, skipped ${rejectedCap}.`);
  } else if (rejectedType > 0) {
    showNotice(`Skipped ${rejectedType} unsupported file${rejectedType === 1 ? '' : 's'} (PNG & JPEG only).`);
  }

  if (fresh.length > 0) {
    // Options stay visible even with no files; the Clear + Compress actions appear now.
    btnClear.hidden = false;
    controlsCta.hidden = false;
    render();
    refreshButtons();
    // Thumbnails are generated off the render path so the list appears instantly.
    fresh.forEach((it) =>
      makeThumb(it.file).then((res) => {
        if (!res) return;
        // The item may have been removed/cleared while decoding — don't leak the URL.
        if (!byId(it.id)) {
          URL.revokeObjectURL(res.url);
          return;
        }
        it.thumbUrl = res.url;
        it.srcW = res.w;
        it.srcH = res.h;
        // Re-render so the thumbnail and the now-known dimensions both appear.
        renderItem(it);
      })
    );
  }
  return fresh.length;
}

/**
 * Decode + downscale a file to a small thumbnail blob URL (bounded memory).
 * Also returns the source pixel dimensions so the card can show the image size.
 */
async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const srcW = bmp.width;
    const srcH = bmp.height;
    // Big enough to stay crisp in the card box on high-DPR screens; never upscaled.
    const max = 400;
    const scale = Math.min(max / srcW, max / srcH, 1);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await oc.convertToBlob({ type: 'image/png' });
    return { url: URL.createObjectURL(blob), w: srcW, h: srcH };
  } catch (_) {
    return null;
  }
}

// click to browse
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

// drag & drop
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-drag');
  })
);
['dragleave', 'dragend', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
  })
);
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(Array.from(e.dataTransfer.files));
});

// A file dropped anywhere outside the dropzone would otherwise make the browser
// navigate to it, unloading the app and losing all in-memory results. Swallow it.
['dragover', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => e.preventDefault())
);

// paste (screenshots)
window.addEventListener('paste', (e) => {
  const files = [];
  const dt = e.clipboardData;
  if (!dt) return;
  if (dt.files && dt.files.length) files.push(...dt.files);
  else if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length && addFiles(files)) e.preventDefault();
});

// ---------------------------------------------------------------- compress ---
btnCompress.addEventListener('click', startCompress);

function startCompress() {
  const pending = items.filter((it) => it.status === 'pending');
  if (!pending.length || busy) return;
  busy = true;
  batchTotal = pending.length;
  batchDone = 0;
  const wantWebp = webpToggle.checked;
  const wantScale = resizeToggle.checked ? Number(resizeSelect.value) || 100 : 100;
  for (const it of pending) {
    it.webp = wantWebp;
    it.scale = wantScale;
    it.status = 'queued';
    queue.push(it.id);
  }
  overall.hidden = false;
  render();
  refreshButtons();
  pump();
}

async function pump() {
  if (activeId != null) return;
  const nextId = queue.shift();
  if (nextId == null) {
    finishBatch();
    return;
  }
  const it = byId(nextId);
  if (!it) {
    pump();
    return;
  }
  activeId = nextId;
  it.status = 'processing';
  renderItem(it);
  updateOverall();

  let buffer;
  try {
    buffer = await it.file.arrayBuffer();
  } catch (_readErr) {
    // The file was moved/deleted/unmounted between selection and read.
    it.status = 'error';
    it.error = 'Could not read the file (it may have been moved or deleted).';
    activeId = null;
    batchDone++;
    renderItem(it);
    updateOverall();
    pump();
    return;
  }
  worker.postMessage(
    { type: 'compress', id: it.id, buffer, mime: it.mime, name: it.name, webp: it.webp, scale: it.scale },
    [buffer]
  );
}

function onWorkerMessage(e) {
  const d = e.data;
  if (!d || d.type !== 'done') return;
  const it = byId(d.id);
  activeId = null;
  if (!it) {
    pump();
    return;
  }
  if (d.ok) {
    it.result = {
      blob: new Blob([d.buffer], { type: d.mime }),
      name: d.name,
      mime: d.mime,
      newSize: d.newSize,
      originalSize: d.originalSize,
      method: d.method,
      keptOriginal: d.keptOriginal,
      outW: d.outWidth,
      outH: d.outHeight,
    };
    // The worker's decode is authoritative for the source dimensions.
    if (d.srcWidth) {
      it.srcW = d.srcWidth;
      it.srcH = d.srcHeight;
    }
    it.status = d.keptOriginal ? 'kept' : 'done';
  } else {
    it.status = 'error';
    it.error = d.error;
  }
  batchDone++;
  renderItem(it);
  updateOverall();
  pump();
}

// A hard worker fault (e.g. OOM crash) never produces a `done` message. Without
// this, activeId/busy would stay pinned and both Compress and Clear stay disabled.
function onWorkerError(err) {
  err?.preventDefault?.();
  if (activeId != null) {
    const it = byId(activeId);
    if (it) {
      it.status = 'error';
      it.error = 'Compression crashed for this file (it may be too large).';
      renderItem(it);
    }
    activeId = null;
    batchDone++;
  }
  // The crashed worker is unusable — replace it so the rest of the queue proceeds.
  try {
    worker.terminate();
  } catch (_) {
    /* already dead */
  }
  createWorker();
  updateOverall();
  pump();
}

function finishBatch() {
  busy = false;
  updateOverall();
  updateSummary();
  refreshButtons();
}

// ------------------------------------------------------------------- render ---
function refreshButtons() {
  const hasPending = items.some((it) => it.status === 'pending');
  btnCompress.disabled = busy || !hasPending;
  btnCompress.querySelector('.btn-label').textContent = busy ? 'Compressing…' : 'Compress';
  const hasResults = items.some((it) => it.result);
  btnDownload.hidden = !hasResults;
  btnClear.disabled = busy;
}

function statusBadge(it) {
  switch (it.status) {
    case 'pending':
      return '<span class="badge badge-idle">Ready</span>';
    case 'queued':
      return '<span class="badge badge-idle">Queued</span>';
    // 'processing' has no corner badge — the thumbnail loading overlay owns that state.
    case 'error':
      return `<span class="badge badge-err">Error</span>`;
    case 'kept':
    case 'done': {
      const o = it.result.originalSize;
      const n = it.result.newSize;
      // A requested resize ships even if the re-encoded file grew — show the gain honestly.
      if (it.status === 'done' && n > o) {
        return `<span class="badge badge-kept">+${Math.round((n / o - 1) * 100)}%</span>`;
      }
      const cls = it.status === 'kept' ? 'badge-kept' : 'badge-ok';
      const label = it.status === 'kept' ? 'Kept original' : `−${savedPct(o, n)}%`;
      return `<span class="badge ${cls}">${label}</span>`;
    }
    default:
      return '';
  }
}

/**
 * Pixel-dimension line for a card. Shows the source size, plus an arrow to the
 * resized size — the real output once compressed, or a live preview of what the
 * current resize setting would produce while the item is still pending.
 */
function dimsLine(it) {
  if (!it.srcW) return '';
  const src = `${it.srcW}×${it.srcH}`;
  if (it.result && it.result.outW) {
    return it.result.outW !== it.srcW || it.result.outH !== it.srcH
      ? `${src} <span class="row-arrow">→</span> <strong>${it.result.outW}×${it.result.outH}</strong>`
      : src;
  }
  if (it.status === 'pending' && resizeToggle.checked) {
    const pct = Number(resizeSelect.value) || 100;
    if (pct < 100) {
      const w = Math.max(1, Math.round((it.srcW * pct) / 100));
      const h = Math.max(1, Math.round((it.srcH * pct) / 100));
      return `${src} <span class="row-arrow">→</span> <strong>${w}×${h}</strong>`;
    }
  }
  return src;
}

/**
 * Uppercase output-format label for the thumbnail badge (e.g. `WEBP`, `PNG`, `JPG`).
 * Uses the result's filename once compressed (what actually downloads), else the source.
 */
function formatLabel(it) {
  const name = it.result ? it.result.name : it.name;
  const dot = name.lastIndexOf('.');
  let ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'jpeg') ext = 'jpg';
  return ext ? ext.toUpperCase() : it.mime === 'image/png' ? 'PNG' : 'JPG';
}

/**
 * Render a filename as a truncatable base + a pinned extension, so the extension
 * stays visible even when the basename is clipped (e.g. `mountain-vista-….jpg`).
 */
function nameHtml(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return `<span class="rn-base">${escapeHtml(name)}</span>`;
  }
  return `<span class="rn-base">${escapeHtml(name.slice(0, dot))}</span><span class="rn-ext">${escapeHtml(
    name.slice(dot)
  )}</span>`;
}

function itemMarkup(it) {
  const r = it.result;
  const sizeLine = r
    ? `${formatBytes(r.originalSize)} <span class="row-arrow">→</span> <strong>${formatBytes(r.newSize)}</strong>`
    : `${formatBytes(it.size)}`;
  const dims = dimsLine(it);
  const done = it.status === 'done' || it.status === 'kept';
  const pending = it.status === 'pending';
  const processing = it.status === 'processing';
  const thumb = it.thumbUrl ? `<img class="row-thumb" src="${it.thumbUrl}" alt="" />` : '';
  // Top-right of the thumbnail: a remove button while pending, otherwise the
  // status / savings badge. The format badge sits top-left. While processing the
  // corner stays empty — the centered loading overlay owns the thumbnail.
  const corner = pending
    ? `<button class="fi-remove" data-remove="${it.id}" title="Remove" aria-label="Remove ${escapeHtml(
        it.name
      )}">&times;</button>`
    : processing
      ? ''
      : statusBadge(it);
  // Compressing — animated overlay on the image only; the info section is untouched.
  const loading = processing
    ? `<div class="thumb-loading" role="status" aria-label="Compressing">
         <span class="tl-spin">
           <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <path d="M4 4 L9 9 M9 5 V9 H5" />
             <path d="M20 20 L15 15 M15 19 V15 H19" />
             <path d="M20 4 L15 9 M15 5 V9 H19" />
             <path d="M4 20 L9 15 M9 19 V15 H5" />
           </svg>
         </span>
       </div>`
    : '';
  // Once compressed, show the output filename (matches the format badge and what downloads).
  const displayName = r ? r.name : it.name;
  const infoLine =
    it.status === 'error'
      ? `<div class="row-err">${escapeHtml(it.error || 'Failed')}</div>`
      : dims
        ? `<div class="row-dims">${dims}</div>`
        : '';
  // Ratio bar — fill is the % saved, so a fuller bar means more compression.
  let ratioBar = '';
  if (done && r) {
    const saved = savedPct(r.originalSize, r.newSize);
    const title = saved > 0 ? `Compressed ${saved}%` : 'No size reduction';
    ratioBar = `<div class="row-bar" title="${title}"><span style="width:${saved}%"></span></div>`;
  }
  return `
    <div class="fi-thumb${processing ? ' is-loading' : ''}">
      ${thumb}
      <span class="fmt-badge">${formatLabel(it)}</span>
      ${loading}
      ${corner}
    </div>
    <div class="fi-info">
      <div class="row-name" title="${escapeHtml(displayName)}">${nameHtml(displayName)}</div>
      <div class="row-size">${sizeLine}</div>
      ${ratioBar}
      ${infoLine}
      ${
        done
          ? `<div class="fi-actions">
               <button class="act-btn" data-preview="${it.id}">
                 <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                 Preview
               </button>
               <button class="act-btn act-btn-dl" data-download="${it.id}">
                 <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M6 20h12"/></svg>
                 Download
               </button>
             </div>`
          : ''
      }
    </div>`;
}

function render() {
  fileList.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.id = String(it.id);
    li.innerHTML = itemMarkup(it);
    fileList.appendChild(li);
  }
}

function renderItem(it) {
  const li = fileList.querySelector(`li[data-id="${it.id}"]`);
  if (li) li.innerHTML = itemMarkup(it);
  else render();
}

function updateOverall() {
  const pct = batchTotal ? Math.round((batchDone / batchTotal) * 100) : 0;
  overallFill.style.width = `${pct}%`;
  overallFill.classList.toggle('is-busy', busy);
  overallText.textContent = busy
    ? `Compressing ${Math.min(batchDone + 1, batchTotal)}/${batchTotal}…`
    : batchDone
      ? `Done — ${batchDone} file${batchDone === 1 ? '' : 's'} processed`
      : '';
}

function updateSummary() {
  const done = items.filter((it) => it.result);
  if (!done.length) {
    summary.hidden = true;
    return;
  }
  const totalOrig = done.reduce((s, it) => s + it.result.originalSize, 0);
  const totalNew = done.reduce((s, it) => s + it.result.newSize, 0);
  const saved = totalOrig - totalNew;
  // With resize, a batch can net larger than the originals — keep the headline sane.
  const grew = saved < 0;
  const pct = savedPct(totalOrig, totalNew);
  const largerPct = grew ? Math.round((totalNew / totalOrig - 1) * 100) : 0;
  const pctLabel = grew ? `${largerPct}% larger` : `${pct}% smaller`;
  const errors = items.filter((it) => it.status === 'error').length;
  summary.hidden = false;
  summary.innerHTML = `
    <div class="sum-head">
      <span class="sum-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v13m0 0 5-5m-5 5-5-5" />
        </svg>
      </span>
      <div class="sum-headtext">
        <div class="summary-big">${grew ? 'Added' : 'Saved'} ${formatBytes(Math.abs(saved))}</div>
        <div class="sum-sublabel">across ${done.length} file${done.length === 1 ? '' : 's'}${
          errors ? ` · ${errors} failed` : ''
        }</div>
      </div>
      <span class="sum-pill"><span class="summary-pct">${grew ? largerPct : pct}%</span>&nbsp;${
        grew ? 'larger' : 'smaller'
      }</span>
    </div>
    <div class="sum-stats">
      <div class="sum-tile"><div class="sum-tile-val">${done.length}</div><div class="sum-tile-lbl">Files</div></div>
      <div class="sum-tile"><div class="sum-tile-val">${formatBytes(totalOrig)}</div><div class="sum-tile-lbl">Original</div></div>
      <div class="sum-tile"><div class="sum-tile-val">${formatBytes(totalNew)}</div><div class="sum-tile-lbl">Compressed</div></div>
    </div>
    <div class="sum-bar" role="img" aria-label="${pctLabel}">
      <div class="sum-bar-fill" style="width:${pct}%"></div>
    </div>`;
}

// ------------------------------------------------------------------ preview ---
const overlay = $('#preview-overlay');
const previewBefore = $('#preview-before');
const previewAfter = $('#preview-after');
const previewClip = $('#preview-clip');
const previewHandle = $('#preview-handle');
const previewStage = $('#preview-stage');
const previewMeta = $('#preview-meta');
let previewUrls = [];

fileList.addEventListener('click', (e) => {
  const pv = e.target.closest('[data-preview]');
  if (pv) {
    const it = byId(Number(pv.dataset.preview));
    if (it && it.result) openPreview(it);
    return;
  }
  const dl = e.target.closest('[data-download]');
  if (dl) {
    const it = byId(Number(dl.dataset.download));
    if (it && it.result) downloadOne(it);
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    removeItem(Number(rm.dataset.remove));
  }
});

/** Remove a not-yet-compressed item from the list. */
function removeItem(id) {
  const idx = items.findIndex((it) => it.id === id);
  if (idx === -1 || items[idx].status !== 'pending') return;
  if (items[idx].thumbUrl) URL.revokeObjectURL(items[idx].thumbUrl);
  items.splice(idx, 1);
  const li = fileList.querySelector(`li[data-id="${id}"]`);
  if (li) li.remove();
  if (!items.length) {
    // Keep the options panel; only the file-dependent actions go away.
    btnClear.hidden = true;
    controlsCta.hidden = true;
    overall.hidden = true;
    summary.hidden = true;
  }
  refreshButtons();
}

/** Download a single compressed result. */
function downloadOne(it) {
  const url = URL.createObjectURL(it.result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = it.result.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function openPreview(it) {
  revokePreviewUrls();
  const beforeUrl = URL.createObjectURL(it.file);
  const afterUrl = URL.createObjectURL(it.result.blob);
  previewUrls = [beforeUrl, afterUrl];

  // Size the stage from the ORIGINAL dimensions. With resize on, the compressed
  // image is smaller (e.g. 10% → 90×60) and would otherwise collapse the stage; the
  // after image fills the same box via width/height:100%, keeping a fair comparison.
  previewBefore.onload = () => {
    const nw = previewBefore.naturalWidth;
    const nh = previewBefore.naturalHeight;
    const maxW = Math.min(nw, Math.floor(window.innerWidth * 0.9));
    const maxH = Math.floor(window.innerHeight * 0.8);
    const scale = Math.min(maxW / nw, maxH / nh, 1);
    const w = Math.round(nw * scale);
    const h = Math.round(nh * scale);
    previewStage.style.width = `${w}px`;
    previewStage.style.height = `${h}px`;
    previewBefore.style.width = `${w}px`;
    previewBefore.style.height = `${h}px`;
    setSplit(50);
  };
  previewAfter.src = afterUrl;
  previewBefore.src = beforeUrl;

  const o = it.result.originalSize;
  const n = it.result.newSize;
  const deltaTxt =
    it.status === 'kept'
      ? 'kept original'
      : n > o
        ? `+${Math.round((n / o - 1) * 100)}% larger`
        : `−${savedPct(o, n)}%`;
  previewMeta.innerHTML = `<strong>${escapeHtml(it.name)}</strong> · ${formatBytes(o)} → ${formatBytes(
    n
  )} · ${deltaTxt} · drag the divider`;

  overlay.hidden = false;
  document.addEventListener('keydown', onPreviewKey);
}

function setSplit(pct) {
  const p = Math.max(0, Math.min(100, pct));
  previewClip.style.width = `${p}%`;
  previewHandle.style.left = `${p}%`;
}

function pointerToSplit(clientX) {
  const rect = previewStage.getBoundingClientRect();
  setSplit(((clientX - rect.left) / rect.width) * 100);
}

let dragging = false;
previewStage.addEventListener('pointerdown', (e) => {
  dragging = true;
  previewStage.setPointerCapture(e.pointerId);
  pointerToSplit(e.clientX);
});
previewStage.addEventListener('pointermove', (e) => {
  if (dragging) pointerToSplit(e.clientX);
});
previewStage.addEventListener('pointerup', () => (dragging = false));
previewStage.addEventListener('pointercancel', () => (dragging = false));

$('#preview-close').addEventListener('click', closePreview);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closePreview();
});

function onPreviewKey(e) {
  if (e.key === 'Escape') closePreview();
}

function closePreview() {
  overlay.hidden = true;
  document.removeEventListener('keydown', onPreviewKey);
  revokePreviewUrls();
  // Drop the decoded images (and the onload closure) so a closed preview holds
  // no image memory.
  previewBefore.onload = null;
  previewBefore.removeAttribute('src');
  previewAfter.removeAttribute('src');
}

function revokePreviewUrls() {
  previewUrls.forEach((u) => URL.revokeObjectURL(u));
  previewUrls = [];
}

// ----------------------------------------------------------------- download ---
btnDownload.addEventListener('click', async () => {
  const done = items.filter((it) => it.result);
  if (!done.length) return;
  btnDownload.disabled = true;
  btnDownload.querySelector('.btn-label').textContent = 'Zipping…';
  try {
    const zip = new JSZip();
    const used = new Set();
    for (const it of done) {
      let name = it.result.name;
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 1;
        while (used.has(`${base}-${i}${ext}`)) i++;
        name = `${base}-${i}${ext}`;
      }
      used.add(name);
      zip.file(name, it.result.blob);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compressed-images-${zipStamp()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } finally {
    btnDownload.disabled = false;
    btnDownload.querySelector('.btn-label').textContent = 'Download ZIP';
  }
});

// -------------------------------------------------------------------- clear ---
btnClear.addEventListener('click', () => {
  if (busy) return;
  items.forEach((it) => {
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
  });
  items.length = 0;
  queue = [];
  activeId = null;
  idSeq = 0;
  batchTotal = 0;
  batchDone = 0;
  fileList.innerHTML = '';
  summary.hidden = true;
  overall.hidden = true;
  btnClear.hidden = true;
  controlsCta.hidden = true;
  notice.hidden = true;
  refreshButtons();
});

// ---------------------------------------------------------------- utilities ---
/** Local timestamp for the ZIP name, e.g. 260710-150000 (YYMMDD-HHMMSS). */
function zipStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${yy}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
