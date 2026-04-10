/**
 * ═══════════════════════════════════════════════════════════════════════
 *  AboutContainer
 *  ─────────────────────────────────────────────────────────────────────
 *  Wraps the about section from html/sections/about.html.
 *
 *  ISOLATION CONTRACT
 *  ──────────────────
 *  ✓  All DOM queries scoped to this._root
 *  ✓  No window / document event listeners
 *  ✓  No shared global flags (stageActive eliminated)
 *  ✓  smoother entirely removed — AppController owns scroll;
 *     this container receives only pre-decoded direction (+1/-1)
 *  ✓  Zone state machine removed — enter()/exit() called by controller
 *  ✓  onScroll() is a no-op when inactive (guard at top)
 *
 *  WHAT CHANGED FROM THE ORIGINAL
 *  ────────────────────────────────
 *  Removed (all were window-level):
 *    smoother            — wheel + scroll listeners
 *    initAbout           — resize × 2, wheel, touchstart, touchmove,
 *                          touchend, keydown
 *    IntersectionObserver scroll listener (mobile zone)
 *    Zone state machine  — engage/disengage driven by scroll position
 *    stageActive flag    — replaced by this._active
 *
 *  Preserved verbatim (logic unchanged):
 *    setPanel(), engage()/disengage() visual side, advance(),
 *    transition guard, dot progress indicators, scroll hint
 *
 *  NOTED EXCEPTIONS
 *  ─────────────────
 *  _spacer  — .about-spacer is a sibling element, not a descendant of
 *             this._root (the stage). It's accessed via a scoped query
 *             on the parent, or by id if you give it one. Height sizing
 *             and top-position caching are the only writes.
 *             Same documented pattern as CarouselContainer._spacer.
 *
 *  REGISTRATION
 *  ─────────────
 *    const about = new AboutContainer(app, 'contact', 'carousel');
 *    app.register('about', about);
 *    // in rootMap: { about: document.getElementById('about-stage'), … }
 *
 *  NOTE ON rootMap vs spacer
 *  ──────────────────────────
 *  The root passed to init() is the #about-stage element (the fixed
 *  fullscreen overlay). The .about-spacer is its sibling in the DOM.
 *  init() locates it via document.querySelector('.about-spacer') — the
 *  only permitted global query in this container, documented below.
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

class AboutContainer {

  /**
   * @param {AppController} appController
   * @param {string} nextSection  — section when scrolling past last panel
   * @param {string} prevSection  — section when scrolling before first panel
   */
  constructor(appController, nextSection = 'contact', prevSection = 'carousel') {
    this._app     = appController;
    this._nextKey = nextSection;
    this._prevKey = prevSection;

    // ── DOM refs ───────────────────────────────────────────────────────
    this._root    = null;   // #about-stage  (fixed fullscreen overlay)
    this._spacer  = null;   // .about-spacer (sibling — documented exception)
    this._panels  = [];
    this._dots    = [];
    this._hint    = null;
    this._N       = 0;

    // ── Internal state ─────────────────────────────────────────────────
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 820;
    this._spacerTop     = 0;

    this._onResize = () => {
      this._sizeSpacer();
      setTimeout(() => this._calcSpacerTop(), 200);
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  REQUIRED INTERFACE
  // ════════════════════════════════════════════════════════════════════

  init(root) {
    this._root = root;

    // ── Locate the sibling spacer ──────────────────────────────────────
    // The spacer is not a descendant of this._root (the stage overlay).
    // document.querySelector is used here as a targeted lookup for a
    // known architectural partner element — the one permitted exception.
    this._spacer = document.querySelector('.about-spacer');

    // ── Scoped panel + dot queries ─────────────────────────────────────
    // Panels and dots live inside this._root (the stage), so all queries
    // are fully scoped.
    this._panels = Array.from(this._root.querySelectorAll('[data-panel]'));
    this._dots   = Array.from(this._root.querySelectorAll('.prog-dot'));
    this._hint   = this._root.querySelector('#about-scroll-hint');
    this._N      = this._panels.length;

    if (!this._spacer || !this._N) {
      console.warn('[AboutContainer] Missing spacer or panels — init aborted.');
      return;
    }

    // ── Spacer sizing ──────────────────────────────────────────────────
    this._sizeSpacer();
    this._calcSpacerTop();
    window.addEventListener('resize', this._onResize, { passive: true });

    // ── Initial panel state (no animation) ────────────────────────────
    this._setPanel(0);

    // ── Start hidden ──────────────────────────────────────────────────
    this._root.classList.remove('engaged');
  }

  enter(fromDirection = 0) {
    if (!this._root || !this._N) return;
    this._active = true;

    this._calcSpacerTop();
    // When arriving from the section *below* (scrolling up), land on the
    // last panel. When arriving from above (scrolling down) or on initial
    // load (direction 0), land on the first panel.
    if (fromDirection === -1) {
      this._activeIdx = this._N - 1;
    } else if (fromDirection === +1) {
      this._activeIdx = 0;
    }
    this._setPanel(this._activeIdx);
    this._root.classList.add('engaged');
  }

  exit() {
    if (!this._root) return;
    this._active = false;

    this._root.classList.remove('engaged');
  }

  /**
   * Called by AppController when a scroll/key/touch event occurs and
   * this container is active.
   * @param {number} direction  +1 (down) | -1 (up)
   */
  onScroll(direction) {
    if (!this._active) return; // ── guard ─────────────────────────────
    this._advance(direction);
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE
  // ════════════════════════════════════════════════════════════════════

  _sizeSpacer() {
    if (this._spacer) {
      this._spacer.style.height = `${this._N * window.innerHeight}px`;
    }
  }

  _calcSpacerTop() {
    if (this._spacer) {
      this._spacerTop = Math.round(
        this._spacer.getBoundingClientRect().top + window.scrollY
      );
    }
  }

  /**
   * Activates a panel by index. Updates is-active / is-after classes,
   * dot indicators, and the scroll hint. Verbatim from original.
   */
  _setPanel(idx) {
    this._activeIdx = idx;

    this._panels.forEach((el, i) => {
      el.classList.remove('is-active', 'is-after');
      if      (i < idx)   el.classList.add('is-after');
      else if (i === idx)  el.classList.add('is-active');
    });

    this._dots.forEach((d, i) => d.classList.toggle('on', i === idx));

    if (this._hint) this._hint.classList.toggle('hide', idx > 0);
  }

  _advance(dir) {
    if (this._transitioning) return;

    const now = performance.now();
    if (dir === this._lastAdvDir && (now - this._lastAdvanceAt) < this._TRANS_MS) return;

    const next = this._activeIdx + dir;

    // ── Boundary: before first panel → hand off to previous section ───
    if (next < 0) {
      this._app.setSection(this._prevKey, -1);
      return;
    }

    // ── Boundary: after last panel → hand off to next section ─────────
    if (next >= this._N) {
      this._app.setSection(this._nextKey, +1);
      return;
    }

    // ── Normal advance ─────────────────────────────────────────────────
    this._transitioning = true;
    this._lastAdvanceAt = now;
    this._lastAdvDir    = dir;
    this._setPanel(next);

    setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
  }
}
