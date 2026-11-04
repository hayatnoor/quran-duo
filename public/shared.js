'use strict';

/* Shared between the landing page (index.html) and the reader (read.html). */
const QD = (() => {
  const API = 'https://api.quran.com/api/v4';
  const TOTAL_PAGES = 604;

  // First page of each surah in the Madani mushaf (index 0 = surah 1)
  const SURAH_START = [
    1, 2, 50, 77, 106, 128, 151, 177, 187, 208, 221, 235, 249, 255, 262, 267, 282, 293, 305, 312,
    322, 332, 342, 350, 359, 367, 377, 385, 396, 404, 411, 415, 418, 428, 434, 440, 446, 453, 458, 467,
    477, 483, 489, 496, 499, 502, 507, 511, 515, 518, 520, 523, 526, 528, 531, 534, 537, 542, 545, 549,
    551, 553, 554, 556, 558, 560, 562, 564, 566, 568, 570, 572, 574, 575, 577, 578, 580, 582, 583, 585,
    586, 587, 587, 589, 590, 591, 591, 592, 593, 594, 595, 595, 596, 596, 597, 597, 598, 598, 599, 599,
    600, 600, 601, 601, 601, 602, 602, 602, 603, 603, 603, 604, 604, 604,
  ];

  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const toArabic = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Surah whose first page is at or before `page`. */
  const surahAtPage = (page) => {
    let s = 1;
    for (let i = 0; i < SURAH_START.length; i++) if (SURAH_START[i] <= page) s = i + 1;
    return s;
  };

  const fallbackChapters = () =>
    SURAH_START.map((page, i) => ({ id: i + 1, ar: `سورة ${toArabic(i + 1)}`, en: `Surah ${i + 1}`, tr: '', verses: 0, place: '', page }));

  let chaptersPromise = null;
  /** [{id, ar, en, tr, verses, place, page}] — cached in localStorage after the first load. */
  function loadChapters() {
    if (!chaptersPromise) {
      chaptersPromise = (async () => {
        try {
          const cached = JSON.parse(store.get('qd.chapters.v3', 'null'));
          if (Array.isArray(cached) && cached.length === 114) return cached;
          const r = await fetch(`${API}/chapters?language=en`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = await r.json();
          const list = j.chapters.map((c) => ({
            id: c.id,
            ar: c.name_arabic,
            en: c.name_simple,
            tr: c.translated_name?.name || '',
            verses: c.verses_count,
            place: c.revelation_place, // "makkah" | "madinah"
            page: c.pages?.[0] || SURAH_START[c.id - 1],
          }));
          store.set('qd.chapters.v3', JSON.stringify(list));
          return list;
        } catch {
          chaptersPromise = null; // retry next time
          return fallbackChapters();
        }
      })();
    }
    return chaptersPromise;
  }

  return { API, TOTAL_PAGES, SURAH_START, store, toArabic, escapeHtml, surahAtPage, loadChapters };
})();
