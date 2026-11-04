'use strict';

/* Quran Duo — shows one mushaf page when folded, a two-page spread when unfolded.
 *
 * Rendering matches quran.com's reading view: each of the 604 Madani mushaf pages is drawn
 * with its own King Fahd Complex (QPC V2) font, word-by-word glyphs, on the original 15 lines.
 * Data: api.quran.com (Quran Foundation). Fonts: static.qurancdn.com. */

const API = 'https://api.quran.com/api/v4';
const PAGE_FONT_URL = (n) => `https://static.qurancdn.com/fonts/quran/hafs/v2/woff2/p${n}.woff2`;
const TOTAL_PAGES = 604;
const LINES_PER_PAGE = 15;
const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

// First page of each surah in the Madani mushaf (index 0 = surah 1)
const SURAH_START = [
  1, 2, 50, 77, 106, 128, 151, 177, 187, 208, 221, 235, 249, 255, 262, 267, 282, 293, 305, 312,
  322, 332, 342, 350, 359, 367, 377, 385, 396, 404, 411, 415, 418, 428, 434, 440, 446, 453, 458, 467,
  477, 483, 489, 496, 499, 502, 507, 511, 515, 518, 520, 523, 526, 528, 531, 534, 537, 542, 545, 549,
  551, 553, 554, 556, 558, 560, 562, 564, 566, 568, 570, 572, 574, 575, 577, 578, 580, 582, 583, 585,
  586, 587, 587, 589, 590, 591, 591, 592, 593, 594, 595, 595, 596, 596, 597, 597, 598, 598, 599, 599,
  600, 600, 601, 601, 601, 602, 602, 602, 603, 603, 603, 604, 604, 604,
];

const $ = (id) => document.getElementById(id);
const els = {
  right: $('page-right'),
  left: $('page-left'),
  toolbar: $('toolbar'),
  surah: $('surah-select'),
  pageInput: $('page-input'),
  modeBtn: $('mode-btn'),
};

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  page: clampPage(parseInt(new URLSearchParams(location.hash.slice(1)).get('p') || store.get('qd.page', '1'), 10)),
  mode: store.get('qd.mode', 'auto'), // auto | dual | single
  dual: false,
};

let chapters = []; // [{id, ar, en}]
const pageCache = new Map(); // page -> Promise<verses[]>
const fontCache = new Map(); // page -> Promise<void>

/* ---------------- helpers ---------------- */
function clampPage(n) { return Math.min(TOTAL_PAGES, Math.max(1, Number.isFinite(n) ? n : 1)); }

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabic = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const surahOf = (verseKey) => parseInt(verseKey.split(':')[0], 10);
const chapterName = (id) => chapters[id - 1]?.ar || `سورة ${toArabic(id)}`;

/* ---------------- layout mode ---------------- */
function computeDual() {
  if (state.mode === 'dual') return true;
  if (state.mode === 'single') return false;
  // Viewport Segments API (foldables / dual-screen): two side-by-side segments → two pages
  const segs = window.viewport && window.viewport.segments;
  if (segs && segs.length === 2 && Math.abs(segs[0].top - segs[1].top) < 1) return true;
  if (window.matchMedia('(horizontal-viewport-segments: 2)').matches) return true;
  // Unfolded inner screen: wide-ish and tall enough. Folded phone (portrait or landscape) → single.
  const w = window.innerWidth;
  const h = window.innerHeight;
  return w >= 560 && h >= 500 && w / h >= 0.8;
}

function applyMode() {
  state.dual = computeDual();
  document.body.classList.toggle('dual', state.dual);
  document.body.classList.toggle('single', !state.dual);
  els.modeBtn.textContent = { auto: 'تلقائي', dual: 'صفحتان', single: 'صفحة' }[state.mode];
}

/** Pages shown right now: [rightPage, leftPage|null]. Mushaf spreads put odd pages on the right. */
function visiblePages() {
  if (!state.dual) return [state.page, null];
  const r = state.page % 2 === 1 ? state.page : state.page - 1;
  return [r, r + 1 <= TOTAL_PAGES ? r + 1 : null];
}

/* ---------------- data ---------------- */
async function fetchPageVerses(n) {
  const verses = [];
  for (let p = 1; p; ) {
    const url = `${API}/verses/by_page/${n}?words=true&word_fields=code_v2,line_number&mushaf=1&per_page=50&page=${p}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    verses.push(...j.verses);
    p = j.pagination?.next_page || 0;
  }
  return verses;
}

function loadPage(n) {
  if (!pageCache.has(n)) {
    const p = fetchPageVerses(n);
    p.catch(() => pageCache.delete(n));
    pageCache.set(n, p);
  }
  return pageCache.get(n);
}

function loadPageFont(n) {
  if (!fontCache.has(n)) {
    const face = new FontFace(`qpc-p${n}`, `url(${PAGE_FONT_URL(n)}) format("woff2")`, { display: 'block' });
    const p = face.load().then((f) => { document.fonts.add(f); });
    p.catch(() => fontCache.delete(n));
    fontCache.set(n, p);
  }
  return fontCache.get(n);
}

async function loadChapters() {
  try {
    const cached = store.get('qd.chapters.v2', null);
    chapters = cached ? JSON.parse(cached) : [];
    if (!chapters.length) {
      const j = await (await fetch(`${API}/chapters?language=ar`)).json();
      chapters = j.chapters.map((c) => ({ id: c.id, ar: c.name_arabic, en: c.name_simple }));
      store.set('qd.chapters.v2', JSON.stringify(chapters));
    }
  } catch {
    chapters = SURAH_START.map((_, i) => ({ id: i + 1, ar: `سورة ${toArabic(i + 1)}`, en: '' }));
  }
  els.surah.innerHTML = chapters
    .map((c) => `<option value="${c.id}">${toArabic(c.id)}. ${escapeHtml(c.ar)}${c.en ? ' — ' + escapeHtml(c.en) : ''}</option>`)
    .join('');
  syncToolbar();
  // headers already on screen may have been drawn before names arrived
  render();
}

/* ---------------- page model ---------------- */
/**
 * Build the page's line list. The API only places words; lines without words are surah headers
 * and basmalas. They sit directly above a verse 1 — or, when a surah starts on the next page,
 * at the bottom of this page.
 */
function buildLines(n, verses) {
  const lines = new Map(); // lineNo -> {type, ...}
  const firstLineOfSurah = new Map();

  for (const v of verses) {
    const s = surahOf(v.verse_key);
    for (const w of v.words) {
      const ln = w.line_number;
      if (!lines.has(ln)) lines.set(ln, { type: 'text', words: [] });
      lines.get(ln).words.push({ code: w.code_v2, end: w.char_type_name === 'end' });
      if (v.verse_number === 1 && !firstLineOfSurah.has(s)) firstLineOfSurah.set(s, ln);
    }
  }

  const putHeaders = (surah, ln) => {
    const hasBasmala = surah !== 1 && surah !== 9;
    if (hasBasmala) {
      if (ln - 1 >= 1 && !lines.has(ln - 1)) lines.set(ln - 1, { type: 'basmala' });
      if (ln - 2 >= 1 && !lines.has(ln - 2)) lines.set(ln - 2, { type: 'header', surah });
    } else if (ln - 1 >= 1 && !lines.has(ln - 1)) {
      lines.set(ln - 1, { type: 'header', surah });
    }
  };
  for (const [s, ln] of firstLineOfSurah) putHeaders(s, ln);

  const isShort = n <= 2;
  const total = isShort ? Math.max(...lines.keys()) : LINES_PER_PAGE;

  // Trailing empty lines → header (+ basmala) of the surah that begins on the next page
  const lastText = Math.max(...[...lines.entries()].filter(([, l]) => l.type === 'text').map(([k]) => k));
  if (!isShort && lastText < total) {
    const nextSurah = surahOf(verses[verses.length - 1].verse_key) + 1;
    if (nextSurah <= 114 && SURAH_START[nextSurah - 1] === n + 1) {
      lines.set(lastText + 1, { type: 'header', surah: nextSurah });
      if (lastText + 2 <= total && nextSurah !== 9) lines.set(lastText + 2, { type: 'basmala' });
    }
  }

  const out = [];
  for (let i = 1; i <= total; i++) out.push(lines.get(i) || { type: 'blank' });
  return { lines: out, isShort, lastText };
}

/* ---------------- rendering ---------------- */
function pageHtml(n, verses) {
  const { lines, isShort } = buildLines(n, verses);
  const first = verses[0];
  const font = `qpc-p${n}`;

  const lineHtml = lines.map((l, i) => {
    switch (l.type) {
      case 'header': {
        const code = `surah${String(l.surah).padStart(3, '0')}`;
        return `<div class="line sura-header" title="${escapeHtml(chapterName(l.surah))}"><span class="name">${code}</span></div>`;
      }
      case 'basmala':
        return `<div class="line basmala">${BASMALA}</div>`;
      case 'blank':
        return '<div class="line">&nbsp;</div>';
      default: {
        // last line of a page often ends mid-verse and is centred in the printed mushaf only when short
        const words = l.words.map((w) => `<span class="w${w.end ? ' end' : ''}">${escapeHtml(w.code)}</span>`).join('');
        return `<div class="line text" data-ln="${i + 1}" style="font-family:'${font}'">${words}</div>`;
      }
    }
  }).join('');

  return `
    <header class="page-head">
      <span>${escapeHtml(chapterName(surahOf(first.verse_key)))}</span>
      <span>الجزء ${toArabic(first.juz_number)}</span>
    </header>
    <section class="body${isShort ? ' short' : ''}">${lineHtml}</section>
    <footer class="page-foot"><span class="num">${toArabic(n)}</span></footer>`;
}

function statusHtml(msg, retry) {
  return `<div class="status">${msg}${retry ? '<br><button type="button" data-retry>إعادة المحاولة</button>' : ''}</div>`;
}

/**
 * Size the page: find the font size at which the widest mushaf line fits the width and all
 * lines fit the height, then justify every line to the width of that widest line.
 */
function fit(pageEl) {
  const body = pageEl.querySelector('.body');
  if (!body) return;
  const W = body.clientWidth;
  const H = body.clientHeight;
  if (!W || !H) return;

  const REF = 100;
  body.style.fontSize = REF + 'px';
  body.style.setProperty('--line-w', 'max-content');
  const textLines = [...body.querySelectorAll('.line.text')];
  textLines.forEach((l) => { l.style.justifyContent = 'flex-start'; });

  const widest = Math.max(1, ...textLines.map((l) => l.getBoundingClientRect().width));
  const lineCount = body.children.length;
  const lineH = body.children[0] ? body.children[0].getBoundingClientRect().height : REF * 1.6;
  const neededH = lineH * lineCount * (body.classList.contains('short') ? 1.25 : 1.04);

  const size = Math.max(6, Math.min((W * 0.985 * REF) / widest, (H * REF) / neededH, 90));
  textLines.forEach((l) => { l.style.justifyContent = ''; });
  body.style.fontSize = size.toFixed(2) + 'px';
  body.style.setProperty('--line-w', ((widest * size) / REF).toFixed(1) + 'px');
}

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  const [r, l] = visiblePages();
  const targets = [[els.right, r], [els.left, l]].filter(([, n]) => n);

  for (const [el, n] of targets) {
    if (el.dataset.page !== String(n)) el.innerHTML = statusHtml('…');
  }

  await Promise.all(targets.map(async ([el, n]) => {
    try {
      const [verses] = await Promise.all([loadPage(n), loadPageFont(n)]);
      if (token !== renderToken) return;
      el.innerHTML = pageHtml(n, verses);
      el.dataset.page = n;
    } catch {
      if (token !== renderToken) return;
      el.innerHTML = statusHtml('تعذّر تحميل الصفحة', true);
      el.dataset.page = '';
    }
  }));
  if (token !== renderToken) return;

  if (!l) { els.left.innerHTML = ''; els.left.dataset.page = ''; }
  await Promise.all([
    document.fonts.load('20px SurahNames', 'surah001'),
    document.fonts.load(`20px UthmanicHafs`, BASMALA),
  ]).catch(() => {});
  if (token !== renderToken) return;
  targets.forEach(([el]) => fit(el));

  // Prefetch neighbours (data + fonts) for instant page turns
  const step = state.dual ? 2 : 1;
  for (const n of [r + step, r + step + 1, r - step, r - step + 1]) {
    if (n >= 1 && n <= TOTAL_PAGES) { loadPage(n).catch(() => {}); loadPageFont(n).catch(() => {}); }
  }
}

function refit() { [els.right, els.left].forEach(fit); }

/* ---------------- navigation ---------------- */
function goTo(n) {
  state.page = clampPage(n);
  store.set('qd.page', String(state.page));
  history.replaceState(null, '', `#p=${state.page}`);
  syncToolbar();
  render();
}

function next() {
  const [r] = visiblePages();
  if (state.dual) { if (r + 2 <= TOTAL_PAGES) goTo(r + 2); } else goTo(state.page + 1);
}
function prev() {
  const [r] = visiblePages();
  if (state.dual) { if (r > 1) goTo(r - 2); } else goTo(state.page - 1);
}

function syncToolbar() {
  els.pageInput.value = state.page;
  let s = 1;
  for (let i = 0; i < SURAH_START.length; i++) if (SURAH_START[i] <= state.page) s = i + 1;
  if (els.surah.options.length) els.surah.value = String(s);
}

function toggleToolbar(show = els.toolbar.hidden) { els.toolbar.hidden = !show; }

/* ---------------- events ---------------- */
$('tap-next').addEventListener('click', next);
$('tap-prev').addEventListener('click', prev);
$('tap-menu').addEventListener('click', () => toggleToolbar());
$('close-btn').addEventListener('click', () => toggleToolbar(false));

els.surah.addEventListener('change', () => goTo(SURAH_START[+els.surah.value - 1]));
els.pageInput.addEventListener('change', () => goTo(parseInt(els.pageInput.value, 10)));
els.pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.pageInput.blur(); });

els.modeBtn.addEventListener('click', () => {
  state.mode = { auto: 'dual', dual: 'single', single: 'auto' }[state.mode];
  store.set('qd.mode', state.mode);
  applyMode();
  render();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-retry]')) { e.stopPropagation(); render(); }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowRight' || e.key === 'PageUp') { e.preventDefault(); prev(); }
  else if (e.key === 'Escape') toggleToolbar(false);
});

// Swipe: like turning an Arabic book, drag left→right to go forward.
let touch = null;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  const fast = Date.now() - touch.t < 600;
  touch = null;
  if (fast && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    e.preventDefault(); // suppress the tap-zone click
    dx > 0 ? next() : prev();
  }
}, { passive: false });

// Re-layout on fold/unfold, rotation, or resize
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const wasDual = state.dual;
    applyMode();
    if (wasDual !== state.dual) render(); else refit();
  }, 120);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
if (window.viewport && 'addEventListener' in window.viewport) window.viewport.addEventListener('change', onResize);
window.matchMedia('(horizontal-viewport-segments: 2)').addEventListener?.('change', onResize);

window.addEventListener('hashchange', () => {
  const p = parseInt(new URLSearchParams(location.hash.slice(1)).get('p'), 10);
  if (p && p !== state.page) goTo(p);
});

/* ---------------- boot ---------------- */
applyMode();
syncToolbar();
render();
loadChapters();
