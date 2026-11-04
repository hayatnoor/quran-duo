'use strict';

/* Landing page: pick a surah to start reading, or continue where you left off. */
const { store, toArabic, escapeHtml } = QD;

// Links from before the landing page existed (…/#p=367) still open the reader.
if (/^#p=\d+/.test(location.hash)) location.replace(`read.html${location.hash}`);

const list = document.getElementById('surahs');
const search = document.getElementById('search');
const empty = document.getElementById('empty');
let chapters = [];

const PLACE = { makkah: 'مكية', madinah: 'مدنية' };

// Arabic: drop diacritics/tatweel and unify alef forms; Latin: lowercase, drop punctuation.
const normalize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^a-z0-9ء-ي]/g, '');

function cardHtml(c) {
  const glyph = `surah${String(c.id).padStart(3, '0')}`;
  const verses = c.verses ? `${toArabic(c.verses)} آية` : '';
  return `
    <li>
      <a class="surah" href="read.html#p=${c.page}" data-id="${c.id}" data-page="${c.page}"
         aria-label="${escapeHtml(`${c.id}. ${c.ar} — ${c.en}`)}">
        <span class="num">${c.id}</span>
        <span class="names">
          <span class="name-ar" data-glyph="${glyph}" data-text="${escapeHtml(c.ar)}">${escapeHtml(c.ar)}</span>
          <span class="name-en"><b>${escapeHtml(c.en)}</b>${c.tr ? ' · ' + escapeHtml(c.tr) : ''}</span>
        </span>
        <span class="meta">
          ${verses ? `<span>${verses}${c.place ? ' · ' + PLACE[c.place] : ''}</span>` : ''}
          <span class="page">ص ${toArabic(c.page)}</span>
        </span>
      </a>
    </li>`;
}

function renderList() {
  const q = normalize(search.value.trim());
  const shown = q
    ? chapters.filter((c) => String(c.id) === q || [c.ar, c.en, c.tr].some((t) => normalize(t).includes(q)))
    : chapters;
  list.innerHTML = shown.map(cardHtml).join('');
  empty.hidden = shown.length > 0;
  if (document.body.classList.contains('glyphs')) useGlyphs();
}

// Swap in quran.com's calligraphic surah names only when the font has actually loaded,
// so an offline/failed font never leaves "surah026" placeholders on screen.
function useGlyphs() {
  document.body.classList.add('glyphs');
  list.querySelectorAll('.name-ar').forEach((el) => { el.textContent = el.dataset.glyph; });
}

function showContinue() {
  const page = parseInt(store.get('qd.page', ''), 10);
  if (!page) return;
  const c = chapters[QD.surahAtPage(page) - 1];
  const link = document.getElementById('continue');
  link.href = `read.html#p=${page}`;
  document.getElementById('continue-detail').textContent =
    `صفحة ${toArabic(page)}${c ? ' · سورة ' + c.ar : ''}`;
  link.hidden = false;
}

list.addEventListener('click', (e) => {
  const a = e.target.closest('a.surah');
  if (!a) return;
  store.set('qd.page', a.dataset.page);
  // Close the search keyboard first; opening the reader with it up leaves iOS
  // with a shrunken/scrolled viewport.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});

search.addEventListener('input', renderList);

(async () => {
  chapters = await QD.loadChapters();
  renderList();
  showContinue();
  try {
    await document.fonts.load('34px SurahNames', 'surah001');
    if (document.fonts.check('34px SurahNames', 'surah001')) useGlyphs();
  } catch { /* keep plain Arabic names */ }
})();
