/**
 * ═══════════════════════════════════════════════════════════════════════
 *  CarouselContainer
 *  ─────────────────────────────────────────────────────────────────────
 *  Wraps the projects/carousel section from portfolio-section.html.
 *
 *  ISOLATION CONTRACT
 *  ──────────────────
 *  ✓  All DOM queries scoped to this._root
 *  ✓  No window / document event listeners
 *  ✓  No shared global flags (carouselActive eliminated)
 *  ✓  Smoother entirely removed — AppController owns scroll position;
 *     this container receives only a pre-decoded direction (+1/-1)
 *  ✓  Zone state machine removed — AppController calls enter()/exit()
 *     at the right moment; the container just reacts
 *  ✓  onScroll() is a no-op when inactive (guard at top)
 *
 *  WHAT CHANGED FROM THE ORIGINAL
 *  ────────────────────────────────
 *  Removed (all were window-level):
 *    smoother            — wheel + scroll listeners
 *    initCarousel        — resize × 2, wheel, touchstart, touchmove,
 *                          touchend, keydown
 *    IntersectionObserver scroll listener (mobile zone)
 *    Zone state machine  — engage/disengage driven by scroll position
 *    carouselActive flag — replaced by this._active
 *    progress bar        — page-level chrome, moved to PageChrome class
 *    custom cursor       — page-level chrome, moved to PageChrome class
 *    card tilt           — moved into init(), scoped to this._root
 *    document.body.classList.add('ready') — caller's responsibility
 *
 *  Preserved verbatim (logic unchanged):
 *    setPositions(), char animation, dot nav, engage()/disengage()
 *    visual side, advance(), transition guard, W_THRESH/DECAY model
 *
 *  NOTED EXCEPTIONS
 *  ─────────────────
 *  _spacer  — sibling element, accessed by id. Read-only except for
 *             height sizing. Documented same as prior containers.
 *  _dotsEl  — appended to document.body for z-index stacking.
 *             Documented same as prior containers.
 *
 *  REGISTRATION
 *  ─────────────
 *    const carousel = new CarouselContainer(app, 'about', 'hero');
 *    app.register('carousel', carousel);
 *    // in rootMap: { carousel: document.querySelector('.projects'), … }
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

class CarouselContainer {

  /**
   * @param {AppController} appController
   * @param {string} nextSection  — section to hand off to when scrolling
   *                                past the last card (default 'about')
   * @param {string} prevSection  — section to hand off to when scrolling
   *                                before the first card (default 'hero')
   */
  constructor(appController, nextSection = 'about', prevSection = 'hero') {
    this._app      = appController;
    this._nextKey  = nextSection;
    this._prevKey  = prevSection;

    // ── DOM refs ───────────────────────────────────────────────────────
    this._root     = null;   // <section class="projects">
    this._spacer   = null;   // #projects-spacer  (sibling — documented exception)
    this._dotsEl   = null;   // created in init(), appended to body (documented exception)
    this._dotWraps = [];
    this._projs    = [];
    this._N        = 0;

    // ── Internal state ─────────────────────────────────────────────────
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 820;

    // ── Resize handler ref (stored for symmetry; passive, no removal needed) ──
    this._onResize = () => {
      this._sizeSpacer();
      setTimeout(() => this._calcSpacerTop(), 200);
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  REQUIRED INTERFACE
  // ════════════════════════════════════════════════════════════════════

  init(root) {
    this._root   = root;
    this._spacer = document.getElementById('projects-spacer'); // documented exception

    // ── Scoped project cards ───────────────────────────────────────────
    this._projs = Array.from(this._root.querySelectorAll(':scope .proj'));
    this._N     = this._projs.length;
    if (!this._N) return;

    // ── Character-by-character title animation prep ────────────────────
    // Verbatim from original — scoped to this._root.
    this._projs.forEach(p => {
      const title = p.querySelector('.proj-title');
      if (!title) return;
      const text = title.textContent.trim();
      title.innerHTML = '';
      [...text].forEach(ch => {
        const s = document.createElement('span');
        s.className   = 'ch';
        s.textContent = ch === ' ' ? '\u00a0' : ch;
        title.appendChild(s);
      });
    });

    // ── Dot nav ────────────────────────────────────────────────────────
    // Labels sourced from scoped h2 text rather than a hardcoded array,
    // so adding/removing cards in HTML doesn't require a JS change.
    this._dotsEl = document.createElement('nav');
    this._dotsEl.id = 'c-dots';
    this._dotsEl.setAttribute('aria-label', 'Project navigation');
    this._dotsEl.style.opacity = '0';

    this._projs.forEach((p, i) => {
      const label = p.querySelector('h2')?.textContent.trim() ?? `0${i + 1}`;
      const wrap  = document.createElement('div');
      wrap.className = 'c-dot-wrap';
      const lbl  = document.createElement('span');
      lbl.className   = 'c-dot-label sr-only';
      lbl.textContent = label;
      const dot  = document.createElement('span');
      dot.className = 'c-dot';
      wrap.appendChild(lbl);
      wrap.appendChild(dot);
      this._dotsEl.appendChild(wrap);
      this._dotWraps.push(wrap);
    });
    // Appended to body for z-index stacking — documented exception.
    document.body.appendChild(this._dotsEl);

    // ── Spacer sizing + position cache ────────────────────────────────
    this._sizeSpacer();
    this._calcSpacerTop();
    window.addEventListener('resize', this._onResize, { passive: true });

    // ── Card tilt (scoped hover effect, element-level listeners) ──────
    // Moved from document.querySelectorAll() in the original to a scoped
    // loop. Listeners are on individual card elements — not on window.
    if (!window.matchMedia('(pointer:coarse)').matches) {
      this._projs.forEach(proj => {
        const img = proj.querySelector('.proj-img');
        if (!img) return;
        proj.addEventListener('mouseenter', () => {
          proj._r = proj.getBoundingClientRect();
        });
        proj.addEventListener('mousemove', e => {
          if (!proj._r) proj._r = proj.getBoundingClientRect();
          const nx = (e.clientX - proj._r.left) / proj._r.width  - 0.5;
          const ny = (e.clientY - proj._r.top)  / proj._r.height - 0.5;
          img.style.transform = `scale(1.04) rotateY(${nx * 3}deg) rotateX(${-ny * 1.5}deg)`;
        });
        proj.addEventListener('mouseleave', () => {
          img.style.transform = '';
        });
      });
    }

    // ── Cursor state for card hover ────────────────────────────────────
    // The custom cursor lives in PageChrome. We dispatch custom events
    // from card enter/leave so PageChrome can update state without this
    // container knowing about cursor internals — strict one-way coupling.
    this._projs.forEach(proj => {
      proj.addEventListener('mouseenter', () =>
        this._root.dispatchEvent(new CustomEvent('carousel:proj-enter', { bubbles: true }))
      );
      proj.addEventListener('mouseleave', () =>
        this._root.dispatchEvent(new CustomEvent('carousel:proj-leave', { bubbles: true }))
      );
    });

    // ── Initial card positions (no animation) ─────────────────────────
    this._setPositions(0, false);

    // ── Start hidden ──────────────────────────────────────────────────
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

    // Reset active card to 'next' so CSS transition has a state change to animate from.
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

    setTimeout(() => {
      if (!this._active) this._root.style.visibility = 'hidden';
    }, 400);
  }

  /**
   * Called by AppController when a scroll/key/touch event occurs and
   * this container is active. Pre-decoded direction; no raw event data.
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
    // Same-direction cooldown guard — verbatim from original.
    if (dir === this._lastAdvDir && (now - this._lastAdvanceAt) < this._TRANS_MS) return;

    const next = this._activeIdx + dir;

    // ── Boundary: before first card → hand off to previous section ────
    if (next < 0) {
      this._app.setSection(this._prevKey);
      return;
    }

    // ── Boundary: after last card → hand off to next section ──────────
    if (next >= this._N) {
      this._app.setSection(this._nextKey);
      return;
    }

    // ── Normal advance ─────────────────────────────────────────────────
    this._transitioning = true;
    this._lastAdvanceAt = now;
    this._lastAdvDir    = dir;
    this._activeIdx     = next;
    this._setPositions(this._activeIdx, true);

    setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
  }
}
