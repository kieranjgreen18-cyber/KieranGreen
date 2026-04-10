/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ISOLATED CONTAINER ARCHITECTURE  —  FULL INTEGRATION
 *  ─────────────────────────────────────────────────────────────────────────
 *  FILE SECTIONS
 *  ─────────────────────────────────────────────────────────────────────────
 *   §1  AppController       — owns all global input, routes to containers
 *   §2  PageChrome          — progress bar, custom cursor, body.ready
 *   §3  Hero3DContainer     — model-viewer hero section
 *   §4  CarouselContainer   — projects / carousel section
 *   §5  AboutContainer      — about panel stack section
 *   §6  Bootstrap           — instantiates + wires everything
 *
 *  SECTION ORDER  (defined by hand-offs in onScroll(), not by controller)
 *  ─────────────────────────────────────────────────────────────────────────
 *   hero  →  carousel  →  about
 *         ←           ←
 *
 *  BOUNDARY RULES
 *  ─────────────────────────────────────────────────────────────────────────
 *   AppController  — SOLE interpreter of raw input; attaches wheel / keyboard
 *                    / touch on window only; emits only +1 / -1 to containers
 *   PageChrome     — may attach mousemove / mousedown / mouseup /
 *                    mouseleave / mouseenter on document only
 *   Containers     — fully input-agnostic; receive only onScroll(+1|-1)
 *                  — all DOM queries scoped to their own root element
 *                  — no-ops when inactive (guard at top of every handler)
 *                  — communicate upward only via this._app.setSection()
 *                  — element-level mouse/touch on their own child nodes
 *                    permitted only for non-scroll UX (tilt, rotate, etc.)
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────────────
   §1  APP CONTROLLER
   ─────────────────────────────────────────────────────────────────────────
   Single owner of:
     • wheel / keyboard / touch listeners on window
     • which container is active
     • scroll direction dispatch
     • transition lock (prevents skipping sections mid-animation)
   ───────────────────────────────────────────────────────────────────────── */
class AppController {

  /**
   * @param {PageChrome} chrome  — receives onScroll(y) calls for progress bar.
   *   Pass null if not using PageChrome.
   */
  constructor(chrome = null) {
    this._chrome     = chrome;
    this._containers = new Map();
    this._activeKey  = null;
    this._locked     = false;

    // Lock duration must be >= the longest container _TRANS_MS (820ms) + buffer.
    this._LOCK_MS = 850;

    // ── Wheel velocity model ───────────────────────────────────────────────
    // Identical to the original portfolio smoother — decay + threshold.
    // Containers never see raw wheel events; they receive only +1 / -1.
    this._wVel      = 0;
    this._wLastTime = 0;
    const W_THRESH  = 160;
    const W_DECAY   = 0.94;
    const W_CLAMP   = 90;
    const W_MIN     = 20;

    // ── Global listeners — ONLY place in the codebase ─────────────────────

    window.addEventListener('wheel', (e) => {
      e.preventDefault();

      const raw = e.deltaMode === 1 ? e.deltaY * 32
                : e.deltaMode === 2 ? e.deltaY * window.innerHeight
                : e.deltaY;

      const now = performance.now();
      const gap = now - this._wLastTime;

      if (gap > 600 || this._wLastTime === 0) {
        this._wVel = 0;
      } else {
        this._wVel *= Math.pow(W_DECAY, gap / 16);
      }
      this._wLastTime = now;

      const contrib = raw === 0 ? 0
        : Math.sign(raw) * Math.min(Math.max(Math.abs(raw), W_MIN), W_CLAMP);
      this._wVel += contrib;

      if (this._wVel >  W_THRESH) { this._wVel = 0; this._dispatchScroll(+1); }
      if (this._wVel < -W_THRESH) { this._wVel = 0; this._dispatchScroll(-1); }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault(); this._dispatchScroll(+1);
      }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault(); this._dispatchScroll(-1);
      }
      // Escape — let the active container handle it if it wants
      if (e.key === 'Escape') {
        const active = this._containers.get(this._activeKey);
        if (active?.onEscape) active.onEscape();
      }
    });

    let _ty0 = 0, _tx0 = 0, _tTime0 = 0;
    window.addEventListener('touchstart', (e) => {
      _ty0    = e.touches[0].clientY;
      _tx0    = e.touches[0].clientX;
      _tTime0 = performance.now();
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      const dy = Math.abs(e.touches[0].clientY - _ty0);
      const dx = Math.abs(e.touches[0].clientX - _tx0);
      if (dy > dx && dy > 10) e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      const dy     = _ty0 - e.changedTouches[0].clientY;
      const dx     = Math.abs(e.changedTouches[0].clientX - _tx0);
      const dt     = Math.max(1, performance.now() - _tTime0);
      const vel    = Math.abs(dy) / dt;
      const locked = Math.abs(dy) > dx * 1.2;
      const valid  = (vel >= 0.3 && Math.abs(dy) >= 20) || Math.abs(dy) >= 44;
      if (locked && valid) this._dispatchScroll(dy > 0 ? +1 : -1);
    }, { passive: true });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Register a container. Must be called before init().
   * @param {string} name
   * @param {object} container — implements { init, enter, exit, onScroll }
   */
  register(name, container) {
    if (this._containers.has(name)) {
      console.warn(`[AppController] "${name}" already registered — overwriting.`);
    }
    this._containers.set(name, container);
  }

  /**
   * Call init(root) on every registered container, then activate startSection.
   * @param {object} rootMap      — { [name]: HTMLElement }
   * @param {string} startSection — name of section active on load
   */
  init(rootMap, startSection) {
    for (const [name, container] of this._containers) {
      const root = rootMap[name];
      if (!root) {
        console.error(`[AppController] No root element for container "${name}".`);
        continue;
      }
      container.init(root);
    }
    this._activateDirect(startSection);
  }

  /**
   * Switch the active container. Called by containers via this._app.setSection().
   * Applies a transition lock to prevent cascading switches mid-animation.
   * @param {string} name
   */
  setSection(name, fromDirection = 0) {
    if (this._locked)                      return; // mid-transition
    if (name === this._activeKey)          return; // already active
    if (!this._containers.has(name)) {
      console.warn(`[AppController] setSection("${name}") — not registered.`);
      return;
    }

    this._locked = true;
    this._activateDirect(name, fromDirection);
    setTimeout(() => { this._locked = false; }, this._LOCK_MS);
  }

  // ── Private ────────────────────────────────────────────────────────────

  _activateDirect(name, fromDirection = 0) {
    const next = this._containers.get(name);
    if (!next) return;

    if (this._activeKey) {
      this._containers.get(this._activeKey)?.exit();
    }

    this._activeKey = name;
    next.enter(fromDirection);
  }

  _dispatchScroll(direction) {
    // Update progress bar before forwarding to container
    if (this._chrome) this._chrome.onScroll(window.scrollY);

    if (!this._activeKey) return;
    const active = this._containers.get(this._activeKey);
    if (active?.onScroll) active.onScroll(direction);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §2  PAGE CHROME
   ─────────────────────────────────────────────────────────────────────────
   Page-level ambient UI that survives section transitions:
     • Progress bar  (#prog)
     • Custom cursor (#cur / #cur-r)
     • body.ready

   ONLY object besides AppController that may attach document-level
   listeners. Attaches: mousemove, mousedown, mouseup, mouseleave,
   mouseenter on document. Nothing else.

   Cursor proj-hover state is received via custom events dispatched by
   CarouselContainer — no direct coupling between the two.
   ───────────────────────────────────────────────────────────────────────── */
class PageChrome {
  constructor() {
    this._cur     = null;
    this._curR    = null;
    this._prog    = null;
    this._mx      = window.innerWidth  / 2;
    this._my      = window.innerHeight / 2;
    this._rx      = this._mx;
    this._ry      = this._my;
    this._isDown  = false;
    this._inLink  = false;
    this._inProj  = false;
    this._ringTgt = 42;
    this._ringCur = 42;

    this._STATES = {
      default: { dot: 8,  ring: 42,  ringColor: 'rgba(91,160,164,.32)' },
      link:    { dot: 5,  ring: 64,  ringColor: 'rgba(91,160,164,.6)'  },
      proj:    { dot: 4,  ring: 120, ringColor: 'rgba(91,160,164,.18)' },
      click:   { dot: 14, ring: 42,  ringColor: 'rgba(91,160,164,.5)'  },
    };
  }

  init() {
    this._cur  = document.getElementById('cur');
    this._curR = document.getElementById('cur-r');
    this._prog = document.getElementById('prog');

    requestAnimationFrame(() => document.body.classList.add('ready'));

    // ── Cursor — document-level (justified: owns full-page cursor state) ──
    document.addEventListener('mousemove', e => {
      this._mx = e.clientX; this._my = e.clientY;
      if (this._cur) {
        this._cur.style.left = `${e.clientX}px`;
        this._cur.style.top  = `${e.clientY}px`;
      }
    });
    document.addEventListener('mousedown',  () => { this._isDown = true;  this._apply(); });
    document.addEventListener('mouseup',    () => { this._isDown = false; this._apply(); });
    document.addEventListener('mouseleave', () => {
      if (this._cur)  this._cur.style.opacity  = '0';
      if (this._curR) this._curR.style.opacity = '0';
    });
    document.addEventListener('mouseenter', () => {
      if (this._cur)  this._cur.style.opacity  = '1';
      if (this._curR) this._curR.style.opacity = '1';
    });

    document.querySelectorAll('a, button').forEach(el => {
      el.addEventListener('mouseenter', () => { this._inLink = true;  this._apply(); });
      el.addEventListener('mouseleave', () => { this._inLink = false; this._apply(); });
    });

    // Proj hover — custom events from CarouselContainer, no direct coupling
    document.addEventListener('carousel:proj-enter', () => { this._inProj = true;  this._apply(); });
    document.addEventListener('carousel:proj-leave', () => { this._inProj = false; this._apply(); });

    // ── Cursor ring RAF loop ───────────────────────────────────────────────
    if (window.matchMedia('(pointer:fine)').matches) {
      const loop = () => {
        const rxN = this._rx + (this._mx - this._rx) * 0.1;
        const ryN = this._ry + (this._my - this._ry) * 0.1;
        const rN  = this._ringCur + (this._ringTgt - this._ringCur) * 0.12;
        if (Math.abs(rxN - this._rx) > 0.02 ||
            Math.abs(ryN - this._ry) > 0.02 ||
            Math.abs(rN  - this._ringCur) > 0.05) {
          this._rx = rxN; this._ry = ryN; this._ringCur = rN;
          if (this._curR) {
            this._curR.style.left   = `${this._rx}px`;
            this._curR.style.top    = `${this._ry}px`;
            this._curR.style.width  = `${this._ringCur}px`;
            this._curR.style.height = `${this._ringCur}px`;
          }
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    this._apply();
  }

  /** Called by AppController._dispatchScroll on every scroll event. */
  onScroll(y) {
    if (!this._prog) return;
    const max = document.body.scrollHeight - window.innerHeight;
    this._prog.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
  }

  _state()  { return this._isDown ? 'click' : this._inLink ? 'link' : this._inProj ? 'proj' : 'default'; }
  _apply()  {
    const s = this._STATES[this._state()];
    if (this._cur) { this._cur.style.width = `${s.dot}px`; this._cur.style.height = `${s.dot}px`; }
    this._ringTgt = s.ring;
    if (this._curR) this._curR.style.borderColor = s.ringColor;
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §3  HERO 3D CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Manages: model-viewer, text reveal, auto-rotate, material override.

   Root element: <section class="hero">

   ISOLATION NOTES
   • All DOM queries scoped to this._root
   • model-viewer listeners on this._viewer (element, not window/document)
     — mousedown/up/leave and touchstart/end manage auto-rotate only;
       they are NOT scroll/gesture interpreters
   • All scroll intent arrives via onScroll(direction) from AppController
   • _nav is a documented exception — sibling/ancestor element, class toggle only
   ───────────────────────────────────────────────────────────────────────── */
class Hero3DContainer {

  /**
   * @param {AppController} app
   * @param {string} nextSection — section to activate on scroll-down
   */
  constructor(app, nextSection = 'carousel') {
    this._app      = app;
    this._nextKey  = nextSection;
    this._root     = null;
    this._viewer   = null;
    this._heroText = null;
    this._heroScroll = null;
    this._modelLabel = null;
    this._modelHint  = null;
    this._errorEl    = null;
    this._nav        = null;
    this._active     = false;
    this._hintDone   = false;
    this._rotateTimer = null;

    // Bound handlers — viewer-element interactions only (not scroll/gesture)
    this._onViewerCameraChange = this._onViewerCameraChange.bind(this);
    this._onViewerError        = this._onViewerError.bind(this);
    this._onViewerLoad         = this._onViewerLoad.bind(this);
    this._onMouseDown          = this._onMouseDown.bind(this);
    this._onMouseUp            = this._onMouseUp.bind(this);
    this._onMouseLeave         = this._onMouseLeave.bind(this);
    this._onTouchStartViewer   = this._onTouchStartViewer.bind(this);
    this._onTouchEndViewer     = this._onTouchEndViewer.bind(this);
  }

  init(root) {
    this._root       = root;
    this._viewer     = root.querySelector('model-viewer');
    this._heroText   = root.querySelector('#hero-text');
    this._heroScroll = root.querySelector('#hero-scroll');
    this._modelLabel = root.querySelector('#model-label');
    this._modelHint  = root.querySelector('#model-hint');
    this._errorEl    = root.querySelector('#model-error');
    this._nav        = document.getElementById('nav'); // documented exception

    if (this._viewer) {
      this._viewer.addEventListener('camera-change', this._onViewerCameraChange, { once: true });
      this._viewer.addEventListener('error',         this._onViewerError);
      this._viewer.addEventListener('load',          this._onViewerLoad);
      this._viewer.addEventListener('mousedown',     this._onMouseDown);
      this._viewer.addEventListener('mouseup',       this._onMouseUp);
      this._viewer.addEventListener('mouseleave',    this._onMouseLeave);
      this._viewer.addEventListener('touchstart',    this._onTouchStartViewer, { passive: true });
      this._viewer.addEventListener('touchend',      this._onTouchEndViewer);
    }

    this._root.style.visibility = 'hidden';
    this._root.style.opacity    = '0';
  }

  enter() {
    if (!this._root) return;
    this._active = true;
    if (this._nav) this._nav.classList.remove('scrolled');
    this._root.style.visibility = 'visible';
    this._root.style.transition = 'opacity 0.5s cubic-bezier(0.16,1,0.3,1)';
    this._root.style.opacity    = '1';
    requestAnimationFrame(() => this._reveal());
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    this._root.style.transition = 'opacity 0.4s ease';
    this._root.style.opacity    = '0';
    setTimeout(() => { if (!this._active) this._root.style.visibility = 'hidden'; }, 420);
  }

  onScroll(direction) {
    if (!this._active) return;
    if (direction === +1) this._app.setSection(this._nextKey, +1);
    // -1 at the top of the page: no-op
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _reveal() {
    if (!this._active) return;
    [this._heroText, this._heroScroll, this._modelLabel, this._modelHint]
      .forEach(el => el?.classList.add('is-revealed'));
  }

  _onViewerCameraChange() { this._dismissHint(); }
  _onViewerError()        {
    this._errorEl?.classList.add('visible');
    console.warn('[Hero3DContainer] model-viewer load error:', this._viewer?.src);
  }

  async _onViewerLoad() {
    await this._viewer.updateComplete;
    this._viewer.jumpCameraToGoal();
    setTimeout(() => this._dismissHint(), 5000);

    // Automotive paint material override — verbatim from prototype
    const model = this._viewer.model;
    if (!model?.materials?.length) return;
    const skipRe = /glass|window|lens|tyre|tire|rubber|wheel|chrome|mirror/i;
    const bodyRe = /body|paint|panel|car|exterior|shell|chassis/i;
    let bodyFound = false;
    model.materials.forEach((mat, i) => {
      const name = mat.name || '';
      if (skipRe.test(name)) return;
      const pbr = mat.pbrMetallicRoughness;
      if (!pbr) return;
      if (bodyRe.test(name) || (!bodyFound && i === 0)) {
        bodyFound = true;
        pbr.setBaseColorFactor([0.012, 0.048, 0.022, 1.0]);
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

  _onMouseDown()        { this._viewer?.removeAttribute('auto-rotate'); }
  _onMouseUp()          { this._scheduleRotateResume(); }
  _onMouseLeave()       { this._scheduleRotateResume(); }
  _onTouchStartViewer() { this._viewer?.removeAttribute('auto-rotate'); }
  _onTouchEndViewer()   { this._scheduleRotateResume(); }

  _scheduleRotateResume() {
    if (this._rotateTimer) clearTimeout(this._rotateTimer);
    this._rotateTimer = setTimeout(() => this._viewer?.setAttribute('auto-rotate', ''), 800);
  }

  _dismissHint() {
    if (this._hintDone) return;
    this._hintDone = true;
    this._modelHint?.classList.add('hidden');
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §4  CAROUSEL CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Manages: project cards, char animation, dot nav, card tilt.

   Root element: <section class="projects">

   ISOLATION NOTES
   • _spacer (#projects-spacer) — sibling element, documented exception,
     height sizing + top-cache only
   • _dotsEl — appended to document.body for z-index stacking,
     documented exception
   • Card tilt — element-level listeners on individual .proj cards (not window)
   • Cursor proj-hover — dispatches custom events on this._root (bubbles up
     to document where PageChrome listens); no direct coupling
   ───────────────────────────────────────────────────────────────────────── */
class CarouselContainer {

  /**
   * @param {AppController} app
   * @param {string} nextSection — section after last card  (default 'about')
   * @param {string} prevSection — section before first card (default 'hero')
   */
  constructor(app, nextSection = 'about', prevSection = 'hero') {
    this._app      = app;
    this._nextKey  = nextSection;
    this._prevKey  = prevSection;
    this._root     = null;
    this._spacer   = null;
    this._spacerTop = 0;
    this._dotsEl   = null;
    this._dotWraps = [];
    this._projs    = [];
    this._N        = 0;
    this._active   = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 820;

    this._onResize = () => {
      this._sizeSpacer();
      setTimeout(() => this._calcSpacerTop(), 200);
    };
  }

  init(root) {
    this._root   = root;
    this._spacer = document.getElementById('projects-spacer'); // documented exception

    this._projs = Array.from(root.querySelectorAll(':scope .proj'));
    this._N     = this._projs.length;
    if (!this._N) return;

    // ── Character title animation prep ────────────────────────────────────
    this._projs.forEach(p => {
      const title = p.querySelector('.proj-title');
      if (!title) return;
      const text = title.textContent.trim();
      title.innerHTML = '';
      [...text].forEach(ch => {
        const s = document.createElement('span');
        s.className = 'ch';
        s.textContent = ch === ' ' ? '\u00a0' : ch;
        title.appendChild(s);
      });
    });

    // ── Dot nav ────────────────────────────────────────────────────────────
    this._dotsEl = document.createElement('nav');
    this._dotsEl.id = 'c-dots';
    this._dotsEl.setAttribute('aria-label', 'Project navigation');
    this._dotsEl.style.opacity = '0';

    this._projs.forEach((p, i) => {
      const label = p.querySelector('h2')?.textContent.trim() ?? `0${i + 1}`;
      const wrap  = document.createElement('div');
      wrap.className = 'c-dot-wrap';
      const lbl  = document.createElement('span');
      lbl.className = 'c-dot-label sr-only';
      lbl.textContent = label;
      const dot  = document.createElement('span');
      dot.className = 'c-dot';
      wrap.appendChild(lbl); wrap.appendChild(dot);
      this._dotsEl.appendChild(wrap);
      this._dotWraps.push(wrap);
    });
    document.body.appendChild(this._dotsEl); // documented exception

    // ── Spacer ────────────────────────────────────────────────────────────
    this._sizeSpacer();
    this._calcSpacerTop();
    window.addEventListener('resize', this._onResize, { passive: true });

    // ── Card tilt (element-level, scoped to this._projs) ─────────────────
    if (!window.matchMedia('(pointer:coarse)').matches) {
      this._projs.forEach(proj => {
        const img = proj.querySelector('.proj-img');
        if (!img) return;
        proj.addEventListener('mouseenter', () => { proj._r = proj.getBoundingClientRect(); });
        proj.addEventListener('mousemove',  e  => {
          if (!proj._r) proj._r = proj.getBoundingClientRect();
          const nx = (e.clientX - proj._r.left) / proj._r.width  - 0.5;
          const ny = (e.clientY - proj._r.top)  / proj._r.height - 0.5;
          img.style.transform = `scale(1.04) rotateY(${nx * 3}deg) rotateX(${-ny * 1.5}deg)`;
        });
        proj.addEventListener('mouseleave', () => { img.style.transform = ''; });
      });
    }

    // ── Cursor hover signals → PageChrome via custom events ──────────────
    this._projs.forEach(proj => {
      proj.addEventListener('mouseenter', () =>
        this._root.dispatchEvent(new CustomEvent('carousel:proj-enter', { bubbles: true }))
      );
      proj.addEventListener('mouseleave', () =>
        this._root.dispatchEvent(new CustomEvent('carousel:proj-leave', { bubbles: true }))
      );
    });

    this._setPositions(0, false);
    this._root.style.visibility = 'hidden';
    this._root.classList.remove('carousel-active');
  }

  enter() {
    if (!this._root || !this._N) return;
    this._active = true;
    this._calcSpacerTop();
    this._root.style.visibility = 'visible';
    this._root.classList.add('carousel-active');
    if (this._dotsEl) this._dotsEl.style.opacity = '1';
    this._projs[this._activeIdx].dataset.pos = 'next';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this._setPositions(this._activeIdx, true));
    });
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    this._root.classList.remove('carousel-active');
    if (this._dotsEl) this._dotsEl.style.opacity = '0';
    setTimeout(() => { if (!this._active) this._root.style.visibility = 'hidden'; }, 400);
  }

  onScroll(direction) {
    if (!this._active) return;
    this._advance(direction);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _sizeSpacer() {
    if (this._spacer) this._spacer.style.height = `${this._N * window.innerHeight}px`;
  }

  _calcSpacerTop() {
    if (this._spacer) {
      this._spacerTop = Math.round(this._spacer.getBoundingClientRect().top + window.scrollY);
    }
  }

  _setPositions(idx, animate) {
    this._projs.forEach((p, i) => {
      const delta = i - idx;
      if      (delta < -1)   p.dataset.pos = 'far-above';
      else if (delta === -1) p.dataset.pos = 'prev';
      else if (delta === 0) {
        p.dataset.pos = 'active';
        if (animate) {
          p.querySelectorAll('.proj-title .ch').forEach((s, ci) => {
            s.style.transitionDelay = `${420 + ci * 20}ms`;
            s.classList.add('show');
          });
        }
      }
      else if (delta === 1)  p.dataset.pos = 'next';
      else                   p.dataset.pos = 'far-below';

      if (delta !== 0) {
        p.querySelectorAll('.proj-title .ch').forEach(s => {
          s.style.transitionDelay = '0ms';
          s.classList.remove('show');
        });
      }
    });
    this._dotWraps.forEach((w, i) => w.classList.toggle('on', i === idx));
  }

  _advance(dir) {
    if (this._transitioning) return;
    const now  = performance.now();
    if (dir === this._lastAdvDir && (now - this._lastAdvanceAt) < this._TRANS_MS) return;

    const next = this._activeIdx + dir;

    if (next < 0)         { this._app.setSection(this._prevKey, -1); return; }
    if (next >= this._N)  { this._app.setSection(this._nextKey, +1); return; }

    this._transitioning = true;
    this._lastAdvanceAt = now;
    this._lastAdvDir    = dir;
    this._activeIdx     = next;
    this._setPositions(this._activeIdx, true);
    setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §5  ABOUT CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Manages: panel stack, dot progress indicators, scroll hint.

   Root element: #about-stage  (the fixed fullscreen overlay)

   ISOLATION NOTES
   • _spacer (.about-spacer) — sibling of the stage, not a descendant.
     Located via document.querySelector — one permitted exception,
     documented. Height sizing + top-cache only.
   • Panels and dots live inside #about-stage, so all other queries
     are fully scoped to this._root.
   ───────────────────────────────────────────────────────────────────────── */
class AboutContainer {

  /**
   * @param {AppController} app
   * @param {string} nextSection — section after last panel  (default null = no-op)
   * @param {string} prevSection — section before first panel (default 'carousel')
   */
  constructor(app, nextSection = null, prevSection = 'carousel') {
    this._app     = app;
    this._nextKey = nextSection;
    this._prevKey = prevSection;
    this._root    = null;
    this._spacer  = null;
    this._spacerTop = 0;
    this._panels  = [];
    this._dots    = [];
    this._hint    = null;
    this._N       = 0;
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 820;

    this._onResize = () => {
      this._sizeSpacer();
      setTimeout(() => this._calcSpacerTop(), 200);
    };
  }

  init(root) {
    this._root   = root;
    // .about-spacer is a sibling of #about-stage — documented exception.
    this._spacer = document.querySelector('.about-spacer');

    this._panels = Array.from(root.querySelectorAll('[data-panel]'));
    this._dots   = Array.from(root.querySelectorAll('.prog-dot'));
    this._hint   = root.querySelector('#about-scroll-hint');
    this._N      = this._panels.length;

    if (!this._spacer || !this._N) {
      console.warn('[AboutContainer] Missing spacer or panels — check DOM.');
      return;
    }

    this._sizeSpacer();
    this._calcSpacerTop();
    window.addEventListener('resize', this._onResize, { passive: true });

    this._setPanel(0);
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

  onScroll(direction) {
    if (!this._active) return;
    this._advance(direction);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _sizeSpacer() {
    if (this._spacer) this._spacer.style.height = `${this._N * window.innerHeight}px`;
  }

  _calcSpacerTop() {
    if (this._spacer) {
      this._spacerTop = Math.round(this._spacer.getBoundingClientRect().top + window.scrollY);
    }
  }

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

    if (next < 0) {
      if (this._prevKey) this._app.setSection(this._prevKey, -1);
      return;
    }
    if (next >= this._N) {
      if (this._nextKey) this._app.setSection(this._nextKey, +1);
      return;
    }

    this._transitioning = true;
    this._lastAdvanceAt = now;
    this._lastAdvDir    = dir;
    this._setPanel(next);
    setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §6  BOOTSTRAP
   ─────────────────────────────────────────────────────────────────────────
   The ONLY block that:
     • instantiates all classes
     • defines the section order (via constructor args)
     • maps section names to DOM elements

   Section order:  hero → carousel → about
   To change order: adjust nextSection/prevSection constructor args only.
   AppController, containers, and CSS never need to change.
   ───────────────────────────────────────────────────────────────────────── */
(function bootstrap() {
  // 1. Page chrome — init before app so body.ready fires correctly
  const chrome = new PageChrome();

  // 2. App controller — receives chrome for progress bar updates
  const app = new AppController(chrome);

  // 3. Containers — section order encoded in constructor args
  //    hero → carousel → about (about has no next section yet)
  const hero     = new Hero3DContainer(app,  /* next */ 'carousel');
  const carousel = new CarouselContainer(app, /* next */ 'about',    /* prev */ 'hero');
  const about    = new AboutContainer(app,    /* next */ null,        /* prev */ 'carousel');

  // 4. Register
  app.register('hero',     hero);
  app.register('carousel', carousel);
  app.register('about',    about);

  // 5. Init — maps names to root DOM elements, then activates 'hero'
  app.init(
    {
      hero:     document.querySelector('.hero'),
      carousel: document.querySelector('.projects'),
      about:    document.getElementById('about-stage'),
    },
    'hero'
  );

  // 6. Chrome — called after app.init() so all elements exist
  chrome.init();
})();
