'use strict';

/* Page-turn engine: a 3D leaf that turns about a hinge edge, with shading.
 * It knows nothing about the Quran; app.js decides which content goes on each face. */
const Flip = (() => {
  const speed = Math.max(0.1, parseFloat(new URLSearchParams(location.search).get('turnSpeed')) || 1);
  const DURATION = 650 * speed; // a full turn
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  function place(el, r) {
    Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /**
   * opts:
   *  rect        – where the leaf sits (the page it lifts from)
   *  hinge       – 'left' | 'right': the leaf edge it turns about (the spine)
   *  front, back – face elements (.page); back is shown after the leaf passes 90°
   *  reverse     – the leaf starts turned (maxAngle) and comes back flat; used when a page
   *                turns *in* (single-page view, going back)
   *  maxAngle    – 180 for a full turn over the spine (two pages); 90 for a single page, which
   *                only needs to swing from flat to edge-on at the edge of the screen
   *  under       – rect of the page revealed beneath the leaf (gets a spine shadow)
   *  covered     – rect of the page the leaf lands on (gets a shadow as it lands)
   *  coveredEl   – that page's element; its text is hidden while the leaf lies over it, so
   *                the two pages' text never shows at the same time
   */
  class PageTurn {
    constructor(opts) {
      this.opts = opts;
      this.progress = 0; // 0 = not turned, 1 = turn complete
      this.target = null; // where an animation is heading
      this.reduced = reducedMotion();
      this._raf = 0;
      this._resolve = null;

      const layer = (this.layer = document.createElement('div'));
      layer.className = 'flip-layer';
      const r = opts.rect;
      const hingeX = opts.hinge === 'right' ? r.left + r.width : r.left;
      layer.style.perspective = `${Math.round(r.width * 4.5)}px`;
      layer.style.perspectiveOrigin = `${hingeX}px ${r.top + r.height / 2}px`;

      const shadow = (cls, rect) => {
        if (!rect) return null;
        const s = document.createElement('div');
        s.className = `flip-shadow ${cls} hinge-${opts.hinge}`;
        place(s, rect);
        layer.append(s);
        return s;
      };
      this.underShadow = shadow('under', opts.under);
      this.coveredShadow = shadow('covered', opts.covered);

      const leaf = (this.leaf = document.createElement('div'));
      leaf.className = `leaf hinge-${opts.hinge}`;
      place(leaf, r);
      opts.front.classList.add('face', 'front');
      opts.back.classList.add('face', 'back');
      leaf.append(opts.front, opts.back);
      layer.append(leaf);
      document.body.append(layer);
      this.setProgress(0);
    }

    /** Angle of the leaf in degrees for a given progress. */
    angle(p) {
      const a = (this.opts.reverse ? 1 - p : p) * (this.opts.maxAngle || 180);
      return this.opts.hinge === 'right' ? a : -a; // both turn their free edge over the spine
    }

    setProgress(p) {
      this.progress = clamp01(p);
      const a = Math.abs(this.angle(this.progress));
      const lift = Math.sin((a * Math.PI) / 180); // 0 flat, 1 standing upright
      const st = this.layer.style;
      if (this.reduced) {
        // Crossfade instead of a 3D turn
        this.leaf.style.transform = '';
        this.leaf.style.opacity = String(this.opts.reverse ? this.progress : 1 - this.progress);
        st.setProperty('--front-shade', '0');
        st.setProperty('--back-shade', '0');
        st.setProperty('--under-shade', '0');
        st.setProperty('--covered-shade', '0');
        return;
      }
      this.leaf.style.transform = `rotateY(${this.angle(this.progress)}deg)`;
      // Show exactly one side of the leaf. (backface-visibility alone isn't reliable in iOS
      // Safari when the faces contain layered content, which let both sides show through.)
      const pastHalf = a > 90;
      this.opts.front.style.visibility = pastHalf ? 'hidden' : '';
      this.opts.back.style.visibility = pastHalf ? '' : 'hidden';
      // Blank the page underneath while the leaf lies over it: past the spine for a full turn;
      // the whole time for a page swinging in over a single page.
      const full = (this.opts.maxAngle || 180) >= 180;
      this.opts.coveredEl?.classList.toggle('flip-covered', full ? pastHalf : this.progress > 0);
      if ((this.opts.maxAngle || 180) < 180) {
        // single page: the leaf is edge-on at one end of the turn, so ease the shading in/out there
        const p = this.progress;
        const k = Math.min(1, (this.opts.reverse ? p : 1 - p) * 4) * lift;
        st.setProperty('--front-shade', (0.28 * k).toFixed(3));
        st.setProperty('--back-shade', '0');
        st.setProperty('--under-shade', (this.opts.reverse ? 0 : 0.5 * k).toFixed(3));
        st.setProperty('--covered-shade', (this.opts.reverse ? 0.4 * k : 0).toFixed(3));
        return;
      }
      st.setProperty('--front-shade', (a <= 90 ? 0.28 * lift : 0).toFixed(3));
      st.setProperty('--back-shade', (a > 90 ? 0.22 * lift : 0).toFixed(3));
      st.setProperty('--under-shade', (a <= 90 ? 0.55 * lift : 0.25 * lift).toFixed(3));
      st.setProperty('--covered-shade', (a > 90 ? 0.45 * lift : 0).toFixed(3));
    }

    /** Animate to 1 (complete) or 0 (spring back). Resolves with the target. */
    animateTo(target, { fromDrag = false, quick = false } = {}) {
      cancelAnimationFrame(this._raf);
      this.target = target;
      const from = this.progress;
      const span = Math.abs(target - from);
      const ms = this.reduced ? 180 * speed
        : Math.max(120, DURATION * (fromDrag ? Math.max(span, 0.35) : 1) * (quick ? 0.55 : 1));
      const ease = fromDrag ? easeOut : easeInOut;
      const start = performance.now();
      return new Promise((resolve) => {
        this._resolve = resolve;
        const step = (now) => {
          const t = clamp01((now - start) / ms);
          this.setProgress(from + (target - from) * ease(t));
          if (t < 1) this._raf = requestAnimationFrame(step);
          else this._done();
        };
        this._raf = requestAnimationFrame(step);
      });
    }

    /** Jump straight to the end of whatever is happening (a drag in progress counts as cancelled). */
    finishNow() {
      cancelAnimationFrame(this._raf);
      if (this.target === null) this.target = 0;
      this.setProgress(this.target);
      this._done();
    }

    _done() {
      const resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve(this.target);
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this.opts.coveredEl?.classList.remove('flip-covered');
      this.layer.remove();
    }
  }

  /** Map a horizontal drag (px, in the turn's direction) to progress, so the leaf's free edge follows the finger. */
  function progressFromDrag(distance, pageWidth, maxAngle = 180) {
    const lo = maxAngle >= 180 ? -1 : 0; // a 90° turn is complete once the edge reaches the hinge
    const c = Math.min(1, Math.max(lo, 1 - distance / pageWidth));
    return Math.acos(c) / ((maxAngle * Math.PI) / 180);
  }

  return { PageTurn, progressFromDrag, reducedMotion, DURATION };
})();
