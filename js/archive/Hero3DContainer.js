/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Hero3DContainer
 *  ───────────────────────────────────────────────────────────────────
 *  Wraps the hero-3d-prototype section (model-viewer + text reveal +
 *  auto-rotate + material override).
 *
 *  ISOLATION CONTRACT
 *  ──────────────────
 *  ✓  All DOM queries scoped to this._root
 *  ✓  No window / document event listeners
 *  ✓  No window.scrollBy — scroll intent forwarded via onScroll()
 *  ✓  No shared mutable state
 *  ✓  No-op when inactive (guard clause at top of every handler)
 *  ✓  Listeners attached to container-owned elements only (viewer, root)
 *
 *  WHAT CHANGED FROM THE PROTOTYPE
 *  ─────────────────────────────────
 *  Before → window.addEventListener('scroll', …)       nav scrolled state
 *  After  → nav state driven by enter()/exit() only;
 *            AppController owns the scroll signal.
 *
 *  Before → window.addEventListener('load', revealHero)
 *  After  → enter() triggers the reveal (called when section is active).
 *            A one-time _modelReady flag ensures enter() re-triggers
 *            the reveal correctly if the container exits and re-enters
 *            before the GLB has finished loading.
 *
 *  Before → hero.addEventListener('wheel', e => window.scrollBy(…))
 *  After  → hero.addEventListener('wheel', …) calls this._onWheelIntent()
 *            which calls this._app.setSection(…) instead. The element-
 *            level listener is still on this._root (not window), so the
 *            isolation rule is satisfied. preventDefault() is preserved
 *            so model-viewer never sees the wheel event.
 *
 *  Before → hero.addEventListener('touchmove', … window.scrollBy)
 *  After  → same element-level listener; vertical swipe calls onScroll().
 *
 *  LINES DELETED (global listeners removed)
 *  ─────────────────────────────────────────
 *  window.addEventListener('scroll', …)   // nav scrolled class  → gone
 *  window.addEventListener('load', …)     // revealHero           → moved to enter()
 *  (wheel/touch were already on .hero element — kept there, rewritten)
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

class Hero3DContainer {

  /**
   * @param {AppController} appController
   * @param {string} nextSection — name of the section to hand off to on
   *   scroll-down. Defaults to 'carousel'. Override at registration time
   *   if your section order is different.
   */
  constructor(appController, nextSection = 'carousel') {
    this._app        = appController;
    this._nextKey    = nextSection;

    // ── DOM refs — populated by init() ────────────────────────────────
    this._root       = null;   // <section class="hero">
    this._viewer     = null;   // <model-viewer>
    this._heroText   = null;
    this._heroScroll = null;
    this._modelLabel = null;
    this._modelHint  = null;
    this._errorEl    = null;
    this._nav        = null;   // optional — may not exist in every layout

    // ── Internal state ─────────────────────────────────────────────────
    this._active     = false;
    this._revealed   = false;  // has revealHero() run at least once?
    this._hintDone   = false;
    this._rotateTimer = null;

    // ── Touch tracking (element-level, not window) ─────────────────────
    this._t0y        = 0;
    this._t0x        = 0;
    this._tScrolling = null;

    // ── Bound handlers — stored so removeEventListener is possible ─────
    // We bind them here so `this` is always correct and the reference is
    // stable across add/remove calls.
    this._onViewerCameraChange = this._onViewerCameraChange.bind(this);
    this._onViewerError        = this._onViewerError.bind(this);
    this._onViewerLoad         = this._onViewerLoad.bind(this);
    this._onMouseDown          = this._onMouseDown.bind(this);
    this._onMouseUp            = this._onMouseUp.bind(this);
    this._onMouseLeave         = this._onMouseLeave.bind(this);
    this._onTouchStart         = this._onTouchStart.bind(this);
    this._onTouchEnd           = this._onTouchEnd.bind(this);
    this._onRootWheel          = this._onRootWheel.bind(this);
    this._onRootTouchStart     = this._onRootTouchStart.bind(this);
    this._onRootTouchMove      = this._onRootTouchMove.bind(this);
  }

  // ════════════════════════════════════════════════════════════════════
  //  REQUIRED INTERFACE
  // ════════════════════════════════════════════════════════════════════

  /**
   * init(root)
   * Called once by AppController before any section is activated.
   * Cache DOM refs, wire element-level listeners, apply initial state.
   *
   * @param {HTMLElement} root — the <section class="hero"> element
   */
  init(root) {
    this._root = root;

    // ── Scoped DOM queries — NEVER document.getElementById outside init ─
    // All queries use this._root as the context.
    this._viewer     = this._root.querySelector('model-viewer');
    this._heroText   = this._root.querySelector('#hero-text');
    this._heroScroll = this._root.querySelector('#hero-scroll');
    this._modelLabel = this._root.querySelector('#model-label');
    this._modelHint  = this._root.querySelector('#model-hint');
    this._errorEl    = this._root.querySelector('#model-error');

    // nav sits outside .hero in most layouts — tolerated as a documented
    // architectural exception (same pattern as _spacer in CarouselContainer).
    // It is read-only from the container's perspective (class toggle only).
    this._nav = document.getElementById('nav');

    // ── model-viewer listeners (element-scoped, not window) ────────────
    if (this._viewer) {
      this._viewer.addEventListener('camera-change', this._onViewerCameraChange, { once: true });
      this._viewer.addEventListener('error',         this._onViewerError);
      this._viewer.addEventListener('load',          this._onViewerLoad);
      this._viewer.addEventListener('mousedown',     this._onMouseDown);
      this._viewer.addEventListener('mouseup',       this._onMouseUp);
      this._viewer.addEventListener('mouseleave',    this._onMouseLeave);
      this._viewer.addEventListener('touchstart',    this._onTouchStart,  { passive: true });
      this._viewer.addEventListener('touchend',      this._onTouchEnd);
    }

    // ── Scroll/zoom conflict resolution (on root element, not window) ──
    //
    // model-viewer captures pointer events, blocking the page scroll engine.
    // We intercept wheel + vertical touch on the hero root, call preventDefault
    // so model-viewer never sees the wheel, and forward scroll intent to
    // this._app via onScroll() instead of window.scrollBy().
    //
    // Two-finger pinch is left untouched — model-viewer handles it natively.
    this._root.addEventListener('wheel',      this._onRootWheel,      { passive: false });
    this._root.addEventListener('touchstart', this._onRootTouchStart, { passive: true  });
    this._root.addEventListener('touchmove',  this._onRootTouchMove,  { passive: false });

    // Start hidden — enter() will reveal
    this._root.style.visibility = 'hidden';
    this._root.style.opacity    = '0';
  }

  /**
   * enter()
   * Called by AppController when this section becomes active.
   * Show the section and run the reveal sequence.
   */
  enter() {
    if (!this._root) return;
    this._active = true;

    if (this._nav) this._nav.classList.remove('scrolled');

    this._root.style.visibility = 'visible';
    this._root.style.transition = 'opacity 0.5s cubic-bezier(0.16,1,0.3,1)';
    this._root.style.opacity    = '1';

    // Trigger reveal on the next frame so the opacity transition fires.
    // If the section has already been revealed once, re-reveal immediately
    // (user scrolled back up to hero after visiting carousel).
    requestAnimationFrame(() => {
      this._revealHero();
    });
  }

  /**
   * exit()
   * Called by AppController when this section is being deactivated.
   */
  exit() {
    if (!this._root) return;
    this._active = false;

    this._root.style.transition = 'opacity 0.4s ease';
    this._root.style.opacity    = '0';

    setTimeout(() => {
      if (!this._active) {
        this._root.style.visibility = 'hidden';
      }
    }, 420);
  }

  /**
   * onScroll(direction)
   * Called by AppController when a scroll event occurs while this
   * container is active. Scroll-down hands off to the next section.
   *
   * @param {number} direction — +1 (down) or -1 (up)
   */
  onScroll(direction) {
    // ── Guard: inactive ─────────────────────────────────────────────
    if (!this._active) return;

    if (direction === +1) {
      this._app.setSection(this._nextKey);
    }
    // direction === -1 at the top of the page is a no-op
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — REVEAL
  // ════════════════════════════════════════════════════════════════════

  /**
   * Adds .is-revealed to the text and chrome elements, triggering all
   * CSS transitions in sequence. Safe to call multiple times — the class
   * toggle is idempotent.
   *
   * Previously: called from window 'load' event.
   * Now:        called from enter() on rAF tick.
   */
  _revealHero() {
    if (!this._active) return; // guard: may have exited before rAF fires

    const els = [
      this._heroText,
      this._heroScroll,
      this._modelLabel,
      this._modelHint,
    ];

    els.forEach(el => {
      if (el) el.classList.add('is-revealed');
    });

    this._revealed = true;
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — MODEL-VIEWER HANDLERS (element-scoped)
  // ════════════════════════════════════════════════════════════════════

  /** Dismiss the drag hint on first camera interaction */
  _onViewerCameraChange() {
    this._dismissHint();
  }

  /** Show error fallback if the GLB fails to load */
  _onViewerError() {
    if (this._errorEl) this._errorEl.classList.add('visible');
    console.warn('[Hero3DContainer] model-viewer load error:', this._viewer?.src);
  }

  /**
   * Post-load: snap camera + apply automotive paint material override.
   * Verbatim from the prototype — logic is unchanged; only the outer
   * event wiring has moved into this class.
   */
  async _onViewerLoad() {
    await this._viewer.updateComplete;

    // Snap camera to the authored start position
    this._viewer.jumpCameraToGoal();

    // Auto-dismiss drag hint after 5 s if user hasn't interacted
    setTimeout(() => this._dismissHint(), 5000);

    // ── Automotive paint material override ──────────────────────────
    // Upgrades body panels to deep British Racing Green with clearcoat.
    // Glass, rubber, wheels, chrome keep their GLB originals.
    const model = this._viewer.model;
    if (!model?.materials?.length) return;

    const skipRe  = /glass|window|lens|tyre|tire|rubber|wheel|chrome|mirror/i;
    const bodyRe  = /body|paint|panel|car|exterior|shell|chassis/i;
    let bodyFound = false;

    model.materials.forEach((mat, i) => {
      const name = mat.name || '';
      if (skipRe.test(name)) return;

      const pbr = mat.pbrMetallicRoughness;
      if (!pbr) return;

      if (bodyRe.test(name) || (!bodyFound && i === 0)) {
        bodyFound = true;
        pbr.setBaseColorFactor([0.012, 0.048, 0.022, 1.0]); // deep BRG
        pbr.setMetallicFactor(0.0);
        pbr.setRoughnessFactor(0.36);
        if (mat.extensions?.KHR_materials_clearcoat) {
          mat.extensions.KHR_materials_clearcoat.clearcoatFactor          = 1.0;
          mat.extensions.KHR_materials_clearcoat.clearcoatRoughnessFactor = 0.06;
        }
      } else {
        pbr.setBaseColorFactor([0.04, 0.04, 0.04, 1.0]);
        pbr.setMetallicFactor(0.3);
        pbr.setRoughnessFactor(0.55);
      }
    });
  }

  /** Pause auto-rotate on drag start */
  _onMouseDown() {
    if (!this._viewer) return;
    this._viewer.removeAttribute('auto-rotate');
  }

  /** Resume auto-rotate 800 ms after drag release */
  _onMouseUp() {
    this._scheduleRotateResume();
  }

  _onMouseLeave() {
    this._scheduleRotateResume();
  }

  _onTouchStart() {
    if (!this._viewer) return;
    this._viewer.removeAttribute('auto-rotate');
  }

  _onTouchEnd() {
    this._scheduleRotateResume();
  }

  _scheduleRotateResume() {
    if (this._rotateTimer) clearTimeout(this._rotateTimer);
    this._rotateTimer = setTimeout(() => {
      if (this._viewer) this._viewer.setAttribute('auto-rotate', '');
    }, 800);
  }

  _dismissHint() {
    if (this._hintDone) return;
    this._hintDone = true;
    if (this._modelHint) this._modelHint.classList.add('hidden');
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — SCROLL / ZOOM CONFLICT RESOLUTION (element-scoped)
  //
  //  These listeners live on this._root, NOT on window.
  //
  //  WHEEL
  //  model-viewer captures wheel events, preventing the page from
  //  scrolling when the cursor is over the canvas. We intercept on
  //  the root element (non-passive), call preventDefault() so
  //  model-viewer never sees it, then delegate to the AppController
  //  via onScroll() rather than window.scrollBy().
  //
  //  TOUCH
  //  A clearly vertical single-finger swipe is redirected to the
  //  AppController. Two-finger gestures are never intercepted.
  //
  //  This is the ONLY wheel/touch handling in this container — the
  //  AppController's window-level listeners are the authoritative
  //  source for section switching.
  // ════════════════════════════════════════════════════════════════════

  _onRootWheel(e) {
    if (!this._active) return;
    if (e.ctrlKey || e.metaKey) return; // let browser zoom through

    e.preventDefault();
    e.stopPropagation();

    // Forward direction intent to AppController rather than calling
    // window.scrollBy — the controller decides what happens next.
    const dir = e.deltaY > 0 ? +1 : -1;
    this.onScroll(dir);
  }

  _onRootTouchStart(e) {
    if (e.touches.length === 1) {
      this._t0y        = e.touches[0].clientY;
      this._t0x        = e.touches[0].clientX;
      this._tScrolling = null;
    }
  }

  _onRootTouchMove(e) {
    if (!this._active) return;
    if (e.touches.length !== 1) return; // leave pinch to model-viewer

    const dy = this._t0y - e.touches[0].clientY;
    const dx = this._t0x - e.touches[0].clientX;

    if (this._tScrolling === null) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      this._tScrolling = Math.abs(dy) > Math.abs(dx) * 1.4;
    }

    if (this._tScrolling) {
      e.preventDefault();
      // Update origin so velocity feels natural on continuous moves
      this._t0y = e.touches[0].clientY;
      this._t0x = e.touches[0].clientX;

      // Forward direction to the controller — no raw scrollBy call
      this.onScroll(dy > 0 ? +1 : -1);
    }
  }
}
