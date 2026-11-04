# Quran Duo

A web app that displays the Quran as a two-page mushaf spread on unfolded / dual-screen phones, and a single page when folded.

- Landing page to pick a surah (searchable in Arabic or English) or continue where you left off
- Same Uthmani script as [quran.com](https://quran.com): each of the 604 Madani mushaf pages is drawn with its own King Fahd Complex (QPC V2) font, on its original 15 lines
- Two pages side by side when the screen is opened (odd page on the right, as in a printed mushaf); one page when folded
- Supports the CSS Viewport Segments API so each page lines up with its side of a hinge/fold
- Swipe or tap the edges to turn pages, arrow keys on a keyboard; tap the centre for surah/page navigation and display mode
- Remembers your last page; `read.html#p=50` links open a specific page
- Home-screen icon for iPhone (Add to Home Screen) and Android

## Live

https://hayatnoor.github.io/quran-duo/ (deployed from `public/` by GitHub Actions on every push to `main`)

## Run locally

```
npm start
```

Then open the printed LAN address on your phone (same Wi-Fi network). No dependencies are needed.

Text and fonts are loaded at runtime from the Quran Foundation API (`api.quran.com`) and `static.qurancdn.com`, so an internet connection is required.
