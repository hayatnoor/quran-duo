'use strict';

/* Quran Duo — shows one mushaf page when folded, a two-page spread when unfolded.
 *
 * Rendering matches quran.com's reading view: each of the 604 Madani mushaf pages is drawn
 * with its own King Fahd Complex (QPC V2) font, word-by-word glyphs, on the original 15 lines.
 * Data: api.quran.com (Quran Foundation). Fonts: static.qurancdn.com. */

const { API, TOTAL_PAGES, SURAH_START, store, toArabic, escapeHtml } = QD;
const PAGE_FONT_URL = (n) => `https://static.qurancdn.com/fonts/quran/hafs/v2/woff2/p${n}.woff2`;
const LINES_PER_PAGE = 15;

// Short lines that quran.com centres at normal word spacing instead of stretching edge to edge
// (mostly the last line of a surah). Found by measuring all 8,807 lines; every other line is
// within 5% of its page's width. Pages 1–2 are centred as a whole.
const CENTERED_LINES = {
  255: [2], 528: [9], 534: [6], 545: [6], 586: [1], 593: [2], 594: [5], 600: [10],
  602: [5, 15], 603: [10, 15], 604: [4, 9, 14, 15],
};

// Upstream data corrections, each verified against quran.com's own page: page -> "verse:word" -> line.
// p27: the API puts 2:181 word 5 (فَإِنَّمَآ) on line 14; quran.com shows it starting line 15,
// which is also the only placement that gives both lines the page's normal width.
const LINE_FIXES = { 27: { '2:181:5': 15 } };
const BASMALA = 'بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ';

const $ = (id) => document.getElementById(id);
const els = {
  right: $('page-right'),
  left: $('page-left'),
  toolbar: $('toolbar'),
  surah: $('surah-select'),
  pageInput: $('page-input'),
  modeBtn: $('mode-btn'),
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

const surahOf = (verseKey) => parseInt(verseKey.split(':')[0], 10);
const chapterName = (id) => chapters[id - 1]?.ar || `سورة ${toArabic(id)}`;

/* ---------------- viewport ---------------- */
/**
 * The real size of the app's screen area.
 * In an iOS home-screen app, WebKit sometimes reports a viewport shorter than the screen
 * (by about the status-bar height) after navigating from another page, or leaves the page
 * scrolled after the keyboard closes. A home-screen app always owns the whole screen, so
 * when the screen's width matches, trust the screen's height instead.
 */
function viewportSize() {
  let w = window.innerWidth;
  let h = window.innerHeight;
  if (navigator.standalone && screen.width && screen.height) {
    const landscape = w > h;
    const sw = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const sh = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
    if (Math.abs(sw - w) <= 2) h = Math.max(h, sh);
  }
  return { w, h };
}

let measured = { w: 0, h: 0 };
/** Pin the layout to the measured size; returns true when it changed. */
function syncViewport() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  const size = viewportSize();
  if (size.w === measured.w && size.h === measured.h) return false;
  measured = size;
  const root = document.documentElement.style;
  root.setProperty('--app-w', `${size.w}px`);
  root.setProperty('--app-h', `${size.h}px`);
  return true;
}

/* ---------------- layout mode ---------------- */
function computeDual() {
  if (state.mode === 'dual') return true;
  if (state.mode === 'single') return false;
  // Viewport Segments API (foldables / dual-screen): two side-by-side segments → two pages
  const segs = window.viewport && window.viewport.segments;
  if (segs && segs.length === 2 && Math.abs(segs[0].top - segs[1].top) < 1) return true;
  if (window.matchMedia('(horizontal-viewport-segments: 2)').matches) return true;
  // Unfolded inner screen held like an open book (wider than tall) → two pages.
  // Rotating it to portrait, or a folded phone in any orientation → single page.
  const { w, h } = measured;
  return w >= 560 && h >= 500 && w > h;
}

const isLandscape = () => measured.w > measured.h;
let lastLandscape = false; // set at boot, after the first measurement

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
// Same endpoint quran.com's reader uses. With mushaf=1 (QCF V2) it returns the page exactly as
// laid out in the V2 mushaf that the page fonts belong to: only this page's words, V2 line numbers.
// (The public v4 endpoint reports the older 1405-edition pages/lines, which don't always match.)
const PAGE_URL = (n) =>
  `https://api.qurancdn.com/api/qdc/verses/by_page/${n}?words=true&per_page=all&mushaf=1&filter_page_words=true` +
  '&word_fields=verse_key,line_number,page_number,code_v2,char_type_name';

async function fetchPageVerses(n) {
  const r = await fetch(PAGE_URL(n));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.verses;
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
  chapters = await QD.loadChapters();
  els.surah.innerHTML = chapters
    .map((c) => `<option value="${c.id}">${toArabic(c.id)}. ${escapeHtml(c.ar)} — ${escapeHtml(c.en)}</option>`)
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
    v.words.forEach((w, i) => {
      // Safety net: only words on this page (each glyph only exists in its own page's font).
      if (w.page_number !== n) return;
      const ln = LINE_FIXES[n]?.[`${v.verse_key}:${w.position}`] ?? w.line_number;
      if (!lines.has(ln)) lines.set(ln, { type: 'text', words: [] });
      // A verse's last glyph is its number marker (the API mislabels 2:181's as a plain word).
      const end = w.char_type_name === 'end' || i === v.words.length - 1;
      lines.get(ln).words.push({ code: w.code_v2, end });
      if (v.verse_number === 1 && !firstLineOfSurah.has(s)) firstLineOfSurah.set(s, ln);
    });
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
  const total = LINES_PER_PAGE;
  // Pages 1–2 only fill the lower part of the 15-line grid; draw them from their first used line.
  const firstLine = isShort ? Math.min(...lines.keys()) : 1;

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
  const centered = CENTERED_LINES[n] || [];
  for (let i = firstLine; i <= total; i++) {
    const l = lines.get(i) || { type: 'blank' };
    out.push({ ...l, ln: i, center: l.type === 'text' && centered.includes(i) });
  }
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
        const words = l.words.map((w) => `<span class="w${w.end ? ' end' : ''}">${escapeHtml(w.code)}</span>`).join('');
        return `<div class="line text${l.center ? ' center' : ''}" data-ln="${l.ln}" style="font-family:'${font}'">${words}</div>`;
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
 * Centred (short) lines get the page's typical word spacing instead.
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

  // offsetWidth/Height are layout sizes, unaffected by the 3D transforms used while a page turns
  const natural = textLines.map((l) => l.offsetWidth);
  // pages 1–2 are centred as a whole; elsewhere only the CENTERED_LINES are
  const isShortPage = body.classList.contains('short');
  const justified = isShortPage ? [] : textLines.map((l, i) => [l, natural[i]]).filter(([l]) => !l.classList.contains('center'));
  const widest = Math.max(1, ...(justified.length ? justified : textLines.map((l, i) => [l, natural[i]])).map(([, w]) => w));
  // typical gap between words on this page's justified lines, for the centred ones
  const gaps = justified.filter(([l]) => l.children.length > 1)
    .map(([l, w]) => (widest - w) / (l.children.length - 1)).sort((a, b) => a - b);
  if (gaps.length) body.style.setProperty('--word-gap', (gaps[Math.floor(gaps.length / 2)] / REF).toFixed(3) + 'em');
  else body.style.removeProperty('--word-gap');
  const lineCount = body.children.length;
  const lineH = body.children[0] ? body.children[0].offsetHeight : REF * 1.6;
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

  prefetchAround(r);
}

/** Load the neighbouring pages (data + fonts) so page turns are instant. */
function prefetchAround(r) {
  const step = state.dual ? 2 : 1;
  for (const n of [r + step, r + step + 1, r - step, r - step + 1]) {
    if (n >= 1 && n <= TOTAL_PAGES) { loadPage(n).catch(() => {}); loadPageFont(n).catch(() => {}); }
  }
}

function refit() { [els.right, els.left].forEach(fit); }

/** Load page n and draw it, sized to fit, into `el` (any .page element that has a size). */
async function fillPage(el, n) {
  const [verses] = await Promise.all([loadPage(n), loadPageFont(n)]);
  el.innerHTML = pageHtml(n, verses);
  el.dataset.page = n;
  await Promise.all([
    document.fonts.load('20px SurahNames', 'surah001'),
    document.fonts.load('20px UthmanicHafs', BASMALA),
  ]).catch(() => {});
  fit(el);
}

/* ---------------- page turning ---------------- */
/**
 * One page turn. Content is staged so that, at every angle, each visible face shows the right
 * page; state (page number, hash, saved page) only changes when the turn completes.
 *
 *  Two pages, forward: the left page (front) turns over the spine to land on the right,
 *    showing the next right page (back); the next left page is revealed beneath it.
 *  Two pages, back: mirrored — the right page turns over to the left.
 *  One page, forward: the page turns away about its right (binding) edge; the next is beneath.
 *  One page, back: the previous page turns in over the current one.
 */
let activeTurn = null;

function makeFace(sideClass) {
  const f = document.createElement('div');
  f.className = `page${sideClass ? ' ' + sideClass : ''}`;
  return f;
}

class Turn {
  constructor(dir) {
    this.dir = dir;
    this.settled = false;
    this.ready = false;
    this.failed = false;
    const [r] = visiblePages();
    if (state.dual) {
      this.target = dir > 0 ? r + 2 : r - 2; // right-hand page of the new spread
      const forward = dir > 0;
      // the page that lifts, the page it lands on, and what goes where
      this.lift = forward ? els.left : els.right;
      this.land = forward ? els.right : els.left;
      const newRight = this.target;
      const newLeft = this.target + 1 <= TOTAL_PAGES ? this.target + 1 : null;
      this.underPage = forward ? newLeft : newRight; // revealed in place of the lifted page
      this.backPage = forward ? newRight : newLeft; // lands on the other side
      const rect = this.lift.getBoundingClientRect();
      this.front = makeFace(forward ? 'side-left' : 'side-right');
      this.back = makeFace(forward ? 'side-right' : 'side-left');
      this.saved = [...this.lift.childNodes];
      this.savedPage = this.lift.dataset.page;
      this.front.append(...this.saved);
      this.lift.innerHTML = '';
      this.pt = new Flip.PageTurn({
        rect, hinge: forward ? 'right' : 'left', front: this.front, back: this.back,
        under: rect, covered: this.land.getBoundingClientRect(), coveredEl: this.land,
      });
      this.loading = Promise.all([
        this.underPage ? fillPage(this.lift, this.underPage) : Promise.resolve(),
        this.backPage ? fillPage(this.back, this.backPage) : Promise.resolve(),
      ]);
    } else {
      this.target = state.page + dir;
      const rect = els.right.getBoundingClientRect();
      if (dir > 0) {
        // current page turns away, next page beneath
        this.saved = [...els.right.childNodes];
        this.savedPage = els.right.dataset.page;
        this.front = makeFace('');
        this.front.append(...this.saved);
        els.right.innerHTML = '';
        this.back = makeFace('blank');
        this.pt = new Flip.PageTurn({ rect, hinge: 'right', maxAngle: 90, front: this.front, back: this.back, under: rect });
        this.loading = fillPage(els.right, this.target);
      } else {
        // previous page turns in over the current one
        this.front = makeFace('');
        this.back = makeFace('blank');
        this.pt = new Flip.PageTurn({ rect, hinge: 'right', maxAngle: 90, front: this.front, back: this.back, reverse: true, covered: rect, coveredEl: els.right });
        this.loading = fillPage(this.front, this.target);
      }
    }
    this.loading.then(() => { this.ready = true; }, () => { this.failed = true; });
  }

  drag(p) { if (!this.settled) this.pt.setProgress(p); }

  /** Finish (commit) or spring back, animating from wherever the leaf is now. */
  async release(commit, { fromDrag = false, quick = false } = {}) {
    if (this.settled) return;
    this.pt.target = commit ? 1 : 0; // if forced to finish early, end the way the user intended
    if (commit && !this.ready && !this.failed) await Promise.race([this.loading, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
    if (this.settled) return;
    const t = await this.pt.animateTo(commit ? 1 : 0, { fromDrag, quick });
    this.settle(t);
  }

  /** Jump to the end of this turn immediately (a drag that hasn't been released is cancelled). */
  finishNow() {
    if (this.settled) return;
    this.forced = true;
    this.pt.finishNow();
    this.settle(this.pt.target);
  }

  settle(t) {
    if (this.settled) return;
    this.settled = true;
    this.pt.destroy();
    if (activeTurn === this) activeTurn = null;
    if (t === 1) this.commit(); else this.cancel();
    // a tap/key that arrived during this turn plays next
    if (queued.length && !this.forced) {
      const d = queued.shift();
      requestAnimationFrame(() => turnPage(d, { quick: true }));
    }
  }

  commit() {
    if (state.dual) {
      if (this.ready) {
        this.land.replaceChildren(...this.back.childNodes);
        this.land.dataset.page = this.backPage ?? '';
        fit(this.land);
      }
    } else if (this.dir < 0 && this.ready) {
      els.right.replaceChildren(...this.front.childNodes);
      els.right.dataset.page = this.target;
      fit(els.right);
    }
    commitPage(this.target);
    // If the pages hadn't arrived (offline / slow), draw the new spread the normal way.
    if (!this.ready) render(); else prefetchAround(visiblePages()[0]);
  }

  cancel() {
    if (this.saved) {
      const el = state.dual ? this.lift : els.right;
      el.replaceChildren(...this.saved);
      el.dataset.page = this.savedPage ?? '';
    }
  }
}

const queued = []; // taps/keys waiting for the current turn (up to 3)

/** Stop any turn now (jumps, resizes, mode changes) and forget queued taps. */
function settleTurns() {
  queued.length = 0;
  activeTurn?.finishNow();
}

/** Start a turn in direction dir (+1 forward, -1 back); null at the first/last page. */
function startTurn(dir) {
  activeTurn?.finishNow();
  // pages still being drawn (e.g. after a jump): nothing stable to turn yet
  const [r0, l0] = visiblePages();
  if (els.right.dataset.page !== String(r0) || (l0 && els.left.dataset.page !== String(l0))) return null;
  const [r] = visiblePages();
  const ok = state.dual ? (dir > 0 ? r + 2 <= TOTAL_PAGES : r > 1) : (dir > 0 ? state.page < TOTAL_PAGES : state.page > 1);
  if (!ok) return null;
  renderToken++; // a turn takes over from any render still in flight
  activeTurn = new Turn(dir);
  return activeTurn;
}

function turnPage(dir, { quick = false } = {}) {
  if (activeTurn && !activeTurn.settled) { // play after the current turn
    if (queued.length < 3) queued.push(dir);
    return;
  }
  const t = startTurn(dir);
  if (t) t.release(true, { quick: quick || queued.length > 0 });
}

/* ---------------- navigation ---------------- */
/** Record the current page (state, saved page, link, toolbar) without drawing anything. */
function commitPage(n) {
  state.page = clampPage(n);
  store.set('qd.page', String(state.page));
  history.replaceState(null, '', `#p=${state.page}`);
  syncToolbar();
}

/** Jump straight to a page (surah picker, page box, links) — no animation. */
function goTo(n) {
  settleTurns();
  commitPage(n);
  render();
}

const next = () => turnPage(1);
const prev = () => turnPage(-1);

function syncToolbar() {
  els.pageInput.value = state.page;
  if (els.surah.options.length) els.surah.value = String(QD.surahAtPage(state.page));
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
  settleTurns();
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

// Drag to turn: like an Arabic book, drag left→right to go forward, right→left to go back.
// The leaf follows the finger (or mouse) and finishes or springs back on release.
let drag = null;
let suppressClickUntil = 0;

function rubberBand(dx) {
  const spread = $('spread');
  spread.style.transition = 'none';
  spread.style.transform = dx ? `translateX(${Math.sign(dx) * Math.min(28, Math.abs(dx) * 0.12)}px)` : '';
}
function releaseRubberBand() {
  const spread = $('spread');
  spread.style.transition = 'transform .25s ease-out';
  spread.style.transform = '';
}

document.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  if (e.target.closest('.toolbar')) return;
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, turn: null, edge: false, dir: 0, samples: [[e.clientX, e.timeStamp]] };
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  drag.samples.push([e.clientX, e.timeStamp]);
  if (drag.samples.length > 5) drag.samples.shift();

  if (!drag.dir) {
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    drag.dir = dx > 0 ? 1 : -1;
    drag.turn = startTurn(drag.dir);
    drag.edge = !drag.turn; // first/last page: nothing to turn to
    drag.width = (state.dual ? els.left : els.right).getBoundingClientRect().width;
  }
  e.preventDefault();
  if (drag.edge) { rubberBand(dx); return; }
  if (drag.turn && !drag.turn.pt.reduced) {
    drag.turn.drag(Flip.progressFromDrag(Math.max(0, dx * drag.dir), drag.width, state.dual ? 180 : 90));
  }
}, { passive: false });

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.dir) return; // a tap: let the tap zones handle it
  suppressClickUntil = performance.now() + 400;
  if (d.edge) { releaseRubberBand(); return; }
  if (!d.turn) return;
  const dx = (e.clientX - d.x0) * d.dir;
  // speed in the turn's direction over the last few moves (px/ms)
  const [x1, t1] = d.samples[0];
  const v = ((e.clientX - x1) * d.dir) / Math.max(1, e.timeStamp - t1);
  const p = d.turn.pt.progress;
  const commit = !cancelled && (d.turn.pt.reduced ? dx > 50 || v > 0.35 : p > 0.3 || (v > 0.35 && dx > 15));
  d.turn.release(commit, { fromDrag: true });
}
document.addEventListener('pointerup', (e) => endDrag(e, false));
document.addEventListener('pointercancel', (e) => endDrag(e, true));

// A drag ends over a tap zone; don't let that also count as a tap.
document.addEventListener('click', (e) => {
  if (performance.now() < suppressClickUntil && e.target.closest('.tap')) { e.stopPropagation(); e.preventDefault(); }
}, true);

// Re-layout on fold/unfold, rotation, or resize
let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    settleTurns();
    syncViewport();
    const wasDual = state.dual;
    // Rotating the phone always hands control back to automatic mode, so a manual
    // "two pages" choice doesn't stick after turning the open phone to portrait.
    const landscape = isLandscape();
    if (landscape !== lastLandscape && state.mode !== 'auto') {
      state.mode = 'auto';
      store.set('qd.mode', state.mode);
    }
    lastLandscape = landscape;
    applyMode();
    if (wasDual !== state.dual) render(); else refit();
  }, 120);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
if (window.viewport && 'addEventListener' in window.viewport) window.viewport.addEventListener('change', onResize);
window.matchMedia('(horizontal-viewport-segments: 2)').addEventListener?.('change', onResize);
window.visualViewport?.addEventListener('resize', onResize);

// iOS can change the viewport without a resize event: right after arriving from the surah
// list, when returning to the app, or when the keyboard closes. Re-check at those moments.
const recheckViewport = () => { if (syncViewport()) onResize(); };
window.addEventListener('pageshow', () => { recheckViewport(); refit(); });
window.addEventListener('focus', recheckViewport);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckViewport(); });
els.pageInput.addEventListener('blur', () => setTimeout(recheckViewport, 50));
els.surah.addEventListener('blur', () => setTimeout(recheckViewport, 50));
for (const ms of [50, 250, 600, 1200, 2500]) setTimeout(recheckViewport, ms);

window.addEventListener('hashchange', () => {
  const p = parseInt(new URLSearchParams(location.hash.slice(1)).get('p'), 10);
  if (p && p !== state.page) goTo(p);
});

/* ---------------- boot ---------------- */
syncViewport();
lastLandscape = isLandscape();
applyMode();
syncToolbar();
render();
loadChapters();
