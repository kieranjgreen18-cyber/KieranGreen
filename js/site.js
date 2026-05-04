/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ISOLATED CONTAINER ARCHITECTURE  —  FULL SITE
 *  ─────────────────────────────────────────────────────────────────────────
 *  §1  AppController       — owns ALL global input, routes to containers
 *  §2  PageChrome          — progress bar, custom cursor, body.ready, veil,
 *                            nav scrolled state, section indicator,
 *                            scroll reveal, anchor nav, theme, hamburger,
 *                            logo scramble, copyright year
 *  §3  Hero3DContainer     — model-viewer hero section
 *  §4  CarouselContainer   — projects / carousel section
 *  §5  AboutContainer      — about scroll-lock panel stack
 *  §6  Bootstrap           — instantiates + wires everything
 *
 *  BOUNDARY RULES
 *  ─────────────────────────────────────────────────────────────────────────
 *  AppController  — SOLE interpreter of raw wheel/keyboard/touch on window
 *  PageChrome     — document-level mouse listeners + page chrome only
 *  Containers     — fully input-agnostic; receive only onScroll(+1|-1)
 *                   all DOM queries scoped to their own root element
 *                   communicate upward only via this._app.setSection()
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

   SCROLL ENGINE — Intent Classifier Model
   ────────────────────────────────────────
   The old velocity-accumulator model required 3+ mouse notches to fire and
   produced a sticky, laggy feel on trackpads due to aggressive decay fighting
   legitimate swipe intent. This engine uses a two-path classifier instead:

   MOUSE PATH  (large discrete impulses, deltaY ≥ MOUSE_THRESHOLD per event)
     One notch fires immediately. The event itself IS the intent.
     A post-fire cooldown (MOUSE_COOLDOWN_MS) prevents double-fire from
     mechanical bounce, but is short enough to feel instant.

   TRACKPAD PATH  (many small continuous deltas)
     Events are bucketed into a rolling window. The window's net displacement
     must exceed TRACKPAD_THRESH before firing. After firing, the settle window
     (SETTLE_MS) absorbs the inertia tail so it cannot chain into the next slide.
     The key insight: we measure net displacement in a short time window, NOT
     a velocity accumulator with exponential decay. This is more intuitive and
     does not penalise users with slower deliberate swipes.

   Both paths share the same settle window so the system cannot double-fire
   regardless of input device.
   ───────────────────────────────────────────────────────────────────────── */

// ── Tuning constants (all at module scope for easy adjustment) ────────────
// MOUSE: raw |deltaY| >= this → treat as a discrete mouse wheel notch
const MOUSE_THRESHOLD   = 60;   // px; typical notch is 100–120, even scaled-down is 60+
// MOUSE: min ms between consecutive fires (prevents mechanical double-tick)
const MOUSE_COOLDOWN_MS = 350;
// TRACKPAD: fire once net displacement in rolling window exceeds this
const TRACKPAD_THRESH   = 55;   // px net; comfortable flick without requiring a hard shove
// TRACKPAD: rolling window duration — events older than this are discarded
const TRACKPAD_WINDOW_MS= 180;  // ms; wide enough for a natural swipe, short for inertia rejection
// TRACKPAD: ignore individual events below this (sub-pixel jitter filter)
const TRACKPAD_MIN_DELTA= 1.5;  // px
// POST-FIRE: absorb inertia/bounce for this long after any fire
const SETTLE_MS         = 440;  // ms; covers trackpad inertia tail without feeling slow
// GLOBAL LOCK: hard lock between section changes — must be ≥ largest container TRANS_MS
// About panels animate for 850ms; 950ms gives full clearance with a small margin.
const LOCK_MS           = 950;

class AppController {

  constructor(chrome = null) {
    this._chrome     = chrome;
    this._containers = new Map();
    this._activeKey  = null;
    this._locked     = false;

    // ── Settle window (shared by both input paths) ─────────────────────
    this._settleUntil   = 0;

    // ── Mouse path state ───────────────────────────────────────────────
    this._mouseLastFire = 0; // timestamp of last mouse-path fire

    // ── Trackpad path state ────────────────────────────────────────────
    // Fixed-size ring buffer: avoids allocating a new array on every wheel
    // event (the old filter() approach). Size is generous — at 60 fps and
    // TRACKPAD_WINDOW_MS=180ms you see at most ~11 events; 32 slots is ample.
    this._tpBuf     = new Array(32);
    this._tpHead    = 0; // write pointer (next slot to overwrite)
    this._tpCount   = 0; // how many slots are currently valid

    // ── Global listeners — ONLY place in the codebase ─────────────────
    window.addEventListener('wheel', (e) => {
      const rawDir = e.deltaY > 0 ? +1 : e.deltaY < 0 ? -1 : 0;
      const activeContainer = this._activeKey ? this._containers.get(this._activeKey) : null;
      const nativeAllowed = activeContainer?.nativeScrollDirection?.(rawDir) === true;
      if (!nativeAllowed) e.preventDefault();

      // Normalise delta to pixels regardless of deltaMode
      const raw = e.deltaMode === 1 ? e.deltaY * 32
                : e.deltaMode === 2 ? e.deltaY * window.innerHeight
                : e.deltaY;
      if (raw === 0) return;

      const now = performance.now();

      // ── POST-FIRE SETTLE: swallow everything until inertia clears ────
      if (now < this._settleUntil) return;

      const absRaw = Math.abs(raw);
      const dir    = raw > 0 ? +1 : -1;

      // ── CLASSIFY: mouse vs trackpad ──────────────────────────────────
      // Mouse wheels produce large discrete impulses (≥ MOUSE_THRESHOLD per
      // event). Trackpads produce many small continuous deltas. Checking the
      // per-event magnitude reliably separates them without heuristic state.
      const isMouse = absRaw >= MOUSE_THRESHOLD;

      if (isMouse) {
        // MOUSE PATH — one notch = one slide, gated by cooldown only
        if (nativeAllowed) return; // browser handles it; nothing for us to do
        const sinceLastFire = now - this._mouseLastFire;
        if (sinceLastFire < MOUSE_COOLDOWN_MS) return;
        this._fire(dir, false);
      } else {
        // TRACKPAD PATH — accumulate in rolling window, fire on threshold
        if (absRaw < TRACKPAD_MIN_DELTA) return;

        // Write into ring buffer; evict head if it falls outside the window
        this._tpBuf[this._tpHead] = { t: now, dy: raw };
        this._tpHead = (this._tpHead + 1) % this._tpBuf.length;
        if (this._tpCount < this._tpBuf.length) this._tpCount++;

        // If this direction is natively handled we still need to accumulate
        // so the buffer stays directionally consistent, but we must not fire.
        if (nativeAllowed) return;

        // Net displacement across entries still within the rolling window
        let net = 0;
        const bufLen = this._tpBuf.length;
        for (let i = 0; i < this._tpCount; i++) {
          const slot = this._tpBuf[(this._tpHead - 1 - i + bufLen) % bufLen];
          if (now - slot.t > TRACKPAD_WINDOW_MS) break; // entries are newest-first; stop at first stale
          net += slot.dy;
        }

        if (Math.abs(net) >= TRACKPAD_THRESH) {
          const fireDir = net > 0 ? +1 : -1;
          this._tpHead = 0; this._tpCount = 0; // reset ring buffer so next swipe starts clean
          this._fire(fireDir, false);
        }
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        const now = performance.now();
        if (now >= this._settleUntil) this._fire(+1);
      }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        const now = performance.now();
        if (now >= this._settleUntil) this._fire(-1);
      }
      if (e.key === 'Escape') {
        const active = this._containers.get(this._activeKey);
        if (active?.onEscape) active.onEscape();
      }
    });

    let _ty0 = 0, _tx0 = 0, _tTime0 = 0;
    window.addEventListener('touchstart', (e) => {
      _ty0 = e.touches[0].clientY; _tx0 = e.touches[0].clientX; _tTime0 = performance.now();
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      const dy = Math.abs(e.touches[0].clientY - _ty0);
      const dx = Math.abs(e.touches[0].clientX - _tx0);
      if (dy > dx && dy > 10) {
        const touchDir = (e.touches[0].clientY - _ty0) > 0 ? -1 : +1;
        const activeContainer = this._activeKey ? this._containers.get(this._activeKey) : null;
        const nativeAllowed = activeContainer?.nativeScrollDirection?.(touchDir) === true;
        if (!nativeAllowed) e.preventDefault();
      }
    }, { passive: false });
    window.addEventListener('touchend', (e) => {
      const dy     = _ty0 - e.changedTouches[0].clientY;
      const dx     = Math.abs(e.changedTouches[0].clientX - _tx0);
      const dt     = Math.max(1, performance.now() - _tTime0);
      const vel    = Math.abs(dy) / dt;
      const locked = Math.abs(dy) > dx * 1.2;
      const valid  = (vel >= 0.25 && Math.abs(dy) >= 18) || Math.abs(dy) >= 40;
      if (locked && valid) {
        const dir = dy > 0 ? +1 : -1;
        const now = performance.now();
        if (now < this._settleUntil) return;
        const activeContainer = this._activeKey ? this._containers.get(this._activeKey) : null;
        const nativeAllowed = activeContainer?.nativeScrollDirection?.(dir) === true;
        if (!nativeAllowed) this._fire(dir);
      }
    }, { passive: true });

    // ── Visibility change — phone lock/unlock recovery ─────────────────
    // When the screen turns off mid-scroll, in-flight touch events are
    // silently cancelled and the settle/lock timers keep running but their
    // setTimeout callbacks fire while the page is hidden. On resume the
    // settle window may still be non-zero (blocking all input) and
    // _mouseLastFire may be stale, leaving the scroll engine locked.
    // Fix: flush all transient per-gesture state on visibility restore.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Reset settle window and mouse cooldown so the first gesture after
        // unlock is never blocked by a timer that fired while hidden.
        this._settleUntil   = 0;
        this._mouseLastFire = 0;
        this._tpHead = 0; this._tpCount = 0;
        // If a section transition was in progress, clear the lock —
        // the animation is long gone so there is nothing to protect.
        this._locked = false;
        // Re-sync chrome section indicator to the current active section
        // in case notifySection fired while the page was hidden.
        if (this._activeKey) {
          this._chrome?.notifySection?.(this._activeKey);
        }
      }
    });
  }

  /**
   * Common fire path for both mouse and trackpad.
   * Arms the settle window and dispatches to the active container.
   * @param {number} dir  +1 | -1
   */
  _fire(dir) {
    // Arm settle window BEFORE dispatch so any inertia burst that arrives
    // synchronously during the dispatch is already gated out.
    const now = performance.now();
    this._settleUntil   = now + LOCK_MS;
    this._mouseLastFire = now;
    // Clear trackpad buffer so the settle period starts clean
    this._tpHead = 0; this._tpCount = 0;
    this._dispatchScroll(dir);
  }

  register(name, container) {
    if (this._containers.has(name)) console.warn(`[AppController] "${name}" already registered — overwriting.`);
    this._containers.set(name, container);
  }

  init(rootMap, startSection) {
    for (const [name, container] of this._containers) {
      const root = rootMap[name];
      if (!root) { console.error(`[AppController] No root element for "${name}".`); continue; }
      container.init(root);
    }
    this._activateDirect(startSection);
  }

  setSection(name, fromDirection = 0, force = false) {
    if (this._locked && !force)     return;
    if (name === this._activeKey)   return;
    if (!this._containers.has(name)) { console.warn(`[AppController] setSection("${name}") — not registered.`); return; }
    this._locked = true;
    if (force) {
      // Forced nav (e.g. from a nav anchor click): clear any active settle window
      // so the first scroll in the target section isn't eaten.
      this._settleUntil   = 0;
      this._mouseLastFire = 0;
      this._tpHead = 0; this._tpCount = 0;
    }
    this._activateDirect(name, fromDirection);
    setTimeout(() => { this._locked = false; }, LOCK_MS);
  }

  _activateDirect(name, fromDirection = 0) {
    const next = this._containers.get(name);
    if (!next) return;
    if (this._activeKey) this._containers.get(this._activeKey)?.exit();
    this._activeKey = name;
    // Flush trackpad buffer — stale events from the old section must not
    // bleed into the new one.
    this._tpHead = 0; this._tpCount = 0;
    // IMPORTANT: do NOT reset _mouseLastFire here. The cooldown must persist
    // across section changes so a single scroll gesture cannot simultaneously
    // trigger the section change AND the first advance in the new section.
    // Instead, extend the settle window to cover the full lock period so both
    // guards are consistent.
    const settleEnd = performance.now() + LOCK_MS;
    if (settleEnd > this._settleUntil) this._settleUntil = settleEnd;
    next.enter(fromDirection);
    this._chrome?.notifySection?.(name);
    const suppressMs = name === 'contact' ? 750 : LOCK_MS;
    this._chrome?.suppressScrollIndicator?.(suppressMs);
  }

  _dispatchScroll(direction) {
    if (!this._activeKey) return;
    const active = this._containers.get(this._activeKey);
    if (active?.onScroll) active.onScroll(direction);
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §2  PAGE CHROME
   ─────────────────────────────────────────────────────────────────────────
   Owns ALL page-level ambient UI that belongs to no single section:
     • Progress bar, custom cursor, body.ready, page veil
     • Nav scrolled state + section indicator
     • IntersectionObserver scroll reveal (.rev / .rev-stagger)
     • Smooth anchor nav (click delegation)
     • Theme toggle
     • Hamburger / mobile drawer
     • Logo scramble
     • Copyright year

   ONLY object besides AppController that may attach document-level listeners.
   Attaches: mousemove, mousedown, mouseup, mouseleave, mouseenter, click.
   Does NOT attach wheel, scroll, keydown, or touch — AppController owns those.
   ───────────────────────────────────────────────────────────────────────── */
class PageChrome {

  constructor() {
    // AppController reference — set via setApp() after bootstrap wires everything
    this._app     = null;

    // Cursor — positions initialised in init() once elements exist
    this._cur     = null;
    this._curR    = null;
    this._mx      = 0;
    this._my      = 0;
    this._rx      = 0;
    this._ry      = 0;
    this._isDown  = false;
    this._inLink  = false;
    this._inProj  = false;

    // Section indicator
    this._secInd  = null;
    this._navEl   = null;
    this._suppressIndicatorUntil = 0; // timestamp — scroll-based updates are muted until this time
    this._SECTIONS = [
      { id: 'top',           label: 'Hero'     },
      { id: 'projects-spacer', label: 'Projects' },
      { id: 'about',         label: 'About'    },
      { id: 'contact',       label: 'Contact'  },
    ];
    this._sectionOffsets = [];

    // Theme
    this._currentTheme = 'dark';
    this._SVG_SUN  = '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    this._SVG_MOON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }

  /** Called by bootstrap after AppController is created */
  setApp(app) { this._app = app; }

  init() {
    // ── Cursor + progress bar ──────────────────────────────────────────
    this._cur   = document.getElementById('cur');
    this._curR  = document.getElementById('cur-r');
    this._navEl = document.getElementById('nav');
    this._secInd= document.getElementById('section-indicator');
    // Initialise cursor position to viewport centre now that elements exist
    this._mx = this._rx = window.innerWidth  / 2;
    this._my = this._ry = window.innerHeight / 2;

    // ── Veil + body ready ──────────────────────────────────────────────
    const veil = document.getElementById('veil');
    const onReady = (fn) => {
      if (document.readyState !== 'loading') fn();
      else document.addEventListener('DOMContentLoaded', fn);
    };
    onReady(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.add('ready');
        if (veil) veil.classList.add('gone');
      }));
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && veil) {
        veil.style.transition = 'none';
        veil.style.clipPath = 'inset(0 100% 0 0)';
        veil.style.pointerEvents = 'none';
        void veil.offsetWidth;
        requestAnimationFrame(() => { if (veil) { veil.style.transition = ''; } });
      }
    });

    // ── Document-level mouse ───────────────────────────────────────────
    document.addEventListener('mousemove', e => {
      this._mx = e.clientX; this._my = e.clientY;
      if (this._cur) { this._cur.style.left = `${e.clientX}px`; this._cur.style.top = `${e.clientY}px`; }
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
    document.querySelectorAll('.proj').forEach(el => {
      el.addEventListener('mouseenter', () => { this._inProj = true;  this._apply(); });
      el.addEventListener('mouseleave', () => { this._inProj = false; this._apply(); });
    });

    // Cursor follower — position tracking only.
    // Width/height/appearance are owned entirely by CSS via body classes.
    // _cursorMoved is a dirty flag: set on mousemove, cleared when follower
    // catches up. This lets the RAF bail out early on idle frames instead of
    // running the lerp and threshold check on every single frame.
    if (window.matchMedia('(pointer:fine)').matches) {
      let rafId = 0;
      const loop = () => {
        rafId = 0;
        const rxN = this._rx + (this._mx - this._rx) * 0.12;
        const ryN = this._ry + (this._my - this._ry) * 0.12;
        const stillMoving = Math.abs(rxN - this._rx) > 0.08 || Math.abs(ryN - this._ry) > 0.08;
        this._rx = stillMoving ? rxN : this._mx;
        this._ry = stillMoving ? ryN : this._my;
        if (this._curR) {
          this._curR.style.left = `${this._rx}px`;
          this._curR.style.top  = `${this._ry}px`;
        }
        // Only continue while the follower is catching up; goes fully idle otherwise.
        if (stillMoving) rafId = requestAnimationFrame(loop);
      };
      document.addEventListener('mousemove', () => {
        if (!rafId) rafId = requestAnimationFrame(loop);
      }, { passive: true });
    }
    this._apply();

    // ── Scroll reveal ──────────────────────────────────────────────────
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.06 });
    document.querySelectorAll('.rev, .rev-stagger').forEach(r => {
      // Skip elements inside the About scroll-lock stage and the Carousel fixed
      // overlay — these are revealed by their own enter() logic, not by scroll
      // position. Observing them causes spurious style recalcs mid-transition.
      if (r.closest('#about-stage, .projects')) return;
      io.observe(r);
    });

    // ── Anchor nav — routes through AppController so the scroll-lock
    //    container system stays in sync instead of fighting window.scrollTo.
    //    Mapping: anchor hash → registered section key.
    //    Falls back to window.scrollTo for any hash not in the map
    //    (e.g. in-page sub-anchors the container system doesn't own).
    const ANCHOR_SECTION_MAP = {
      '#top':     'hero',
      '#work':    'carousel',
      '#about':   'about',
      '#contact': 'contact',
    };
    document.addEventListener('click', e => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#')) {
        e.preventDefault();
        const sectionKey = ANCHOR_SECTION_MAP[href];
        if (sectionKey && this._app) {
          this._app.setSection(sectionKey, 0, true); // force=true: nav clicks bypass transition lock
        } else {
          // Fallback for anchors outside the container system
          const targetId = href.slice(1);
          const t = document.getElementById(targetId) || document.querySelector(href);
          if (t) window.scrollTo({ top: Math.round(t.getBoundingClientRect().top + window.scrollY), behavior: 'smooth' });
        }
        return;
      }
      if (href.startsWith('http') || href.startsWith('mailto') || href.endsWith('.pdf')) return;
    });

    // ── Theme toggle ───────────────────────────────────────────────────
    const savedTheme = (() => { try { return localStorage.getItem('theme'); } catch(e) { return null; } })();
    this._setTheme(savedTheme === 'light' ? 'light' : 'dark');
    const themeBtn = document.getElementById('theme-btn');
    if (themeBtn) themeBtn.onclick = () => this._setTheme(this._currentTheme === 'dark' ? 'light' : 'dark');

    // ── Hamburger / drawer ─────────────────────────────────────────────
    const hamburger = document.getElementById('hamburger');
    const navDrawer = document.getElementById('nav-drawer');
    if (hamburger && navDrawer) {
      hamburger.addEventListener('click', () => {
        const isOpen = document.body.classList.toggle('menu-open');
        hamburger.setAttribute('aria-expanded', String(isOpen));
        hamburger.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
        navDrawer.setAttribute('aria-hidden', String(!isOpen));
      });
      // Close drawer when any nav drawer link is tapped.
      // The anchor click then bubbles to the document delegation handler which
      // routes via app.setSection() — order is correct (close first, then navigate).
      navDrawer.addEventListener('click', (e) => {
        if (e.target.closest('a')) {
          document.body.classList.remove('menu-open');
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
          navDrawer.setAttribute('aria-hidden', 'true');
        }
      });
    }

    // ── Logo scramble ──────────────────────────────────────────────────
    const logo     = document.querySelector('.n-logo');
    const logoLast = logo && logo.querySelector('.logo-last');
    const CHARS    = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ·—';
    let scrambling = false;
    if (logo && logoLast) {
      const scramble = () => {
        if (scrambling) return; scrambling = true;
        let iter = 0; const TARGET = 'Green';
        const iv = setInterval(() => {
          logoLast.textContent = TARGET.split('').map((c, i) =>
            i < Math.floor(iter) ? c : CHARS[Math.floor(Math.random() * CHARS.length)]
          ).join('');
          if (Math.floor(iter) >= TARGET.length) { clearInterval(iv); logoLast.textContent = 'Green'; scrambling = false; }
          iter += 0.38; // fractional step: slows the letter-resolve relative to the 26ms tick
        }, 26);
      };
      logo.addEventListener('mouseenter', scramble);
      logo.addEventListener('focus', () => { if (!scrambling) scramble(); });
    }

    // ── Nav scrolled + section indicator ──────────────────────────────
    const heroScrollEl = document.getElementById('hero-scroll');
    const buildOffsets = () => {
      this._sectionOffsets = this._SECTIONS.map(s => {
        const el = document.getElementById(s.id);
        return { label: s.label, top: el ? el.getBoundingClientRect().top + window.scrollY : 0 };
      });
    };
    // ResizeObserver on body: rebuild section offsets after any layout change.
    // Kept connected (no disconnect) so dynamic content changes (e.g. spacer
    // height updates from containers) also trigger a rebuild. Debounced so
    // rapid resize events don't hammer getBoundingClientRect.
    let roTimer;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      // Use a 160ms debounce (was 100ms) to ensure we measure AFTER any
      // container transition that triggered the layout change has committed.
      roTimer = setTimeout(() => buildOffsets(), 160);
    });
    ro.observe(document.body);
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (this._navEl) this._navEl.classList.toggle('scrolled', y > 40);
      if (heroScrollEl && y > 60) heroScrollEl.style.opacity = '0';
      if (this._secInd && this._sectionOffsets.length) {
        // Skip all indicator work while a container transition is settling —
        // notifySection() already set the correct label and visibility state.
        if (performance.now() < this._suppressIndicatorUntil) return;
        let active = this._SECTIONS[0].label;
        for (let i = this._sectionOffsets.length - 1; i >= 0; i--) {
          if (y >= this._sectionOffsets[i].top - 100) { active = this._sectionOffsets[i].label; break; }
        }
        this._secInd.textContent = active;
        this._secInd.classList.toggle('visible', y > window.innerHeight * 0.5);
      }
    }, { passive: true });

    // ── Resize ─────────────────────────────────────────────────────────
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        buildOffsets();
        if (window.innerWidth > 768) {
          document.body.classList.remove('menu-open');
          const h = document.getElementById('hamburger');
          const d = document.getElementById('nav-drawer');
          if (h) { h.setAttribute('aria-expanded', 'false'); h.setAttribute('aria-label', 'Open menu'); }
          if (d) d.setAttribute('aria-hidden', 'true');
        }
      }, 150);
    }, { passive: true });

    // ── Copyright year ─────────────────────────────────────────────────
    const copyYear = document.getElementById('copy-year');
    if (copyYear) copyYear.textContent = new Date().getFullYear();
  }

  /**
   * Retained as an extension point for future chrome-level scroll effects.
   * Progress bar removed; AppController no longer calls this method.
   * If you re-introduce a chrome scroll effect, re-add the call in
   * AppController._dispatchScroll.
   */
  onScroll(y) {
    // intentionally empty
  }

  /**
   * Called by AppController._activateDirect whenever the active section changes.
   * Updates the section indicator label directly from the container key, bypassing
   * the scroll-position heuristic which is unreliable in a scroll-locked layout.
   * @param {string} sectionKey  e.g. 'hero' | 'carousel' | 'about' | 'contact'
   */
  notifySection(key) {
    // Drive body[data-section] so CSS can show/hide section-specific UI
    // (e.g. the nav availability badge which should only appear on hero).
    document.body.dataset.section = key;
    if (!this._secInd) return;
    const labelMap = { hero: 'Hero', carousel: 'Projects', about: 'About', contact: 'Contact' };
    const label = labelMap[key];
    if (label) {
      this._secInd.textContent = label;
      this._secInd.classList.toggle('visible', key !== 'hero');
    }
  }

  /**
   * Mutes the scroll-position-based section indicator for `ms` milliseconds.
   * Called by AppController._activateDirect after every section change so that
   * an in-flight smooth scroll (ContactContainer.enter) cannot clobber the label
   * that notifySection() just set.
   * @param {number} ms
   */
  suppressScrollIndicator(ms) {
    this._suppressIndicatorUntil = performance.now() + ms;
  }

  // Cursor state is expressed as body classes so CSS owns all appearance.
  // Priority: click > link > proj > default (matches original _state() logic).
  _apply() {
    const b = document.body;
    b.classList.toggle('cur-click', this._isDown);
    b.classList.toggle('cur-link',  !this._isDown && this._inLink);
    b.classList.toggle('cur-proj',  !this._isDown && !this._inLink && this._inProj);
  }

  _setTheme(t) {
    this._currentTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    const btn  = document.getElementById('theme-btn');
    const icon = btn && btn.querySelector('svg');
    if (icon) icon.innerHTML = t === 'dark' ? this._SVG_SUN : this._SVG_MOON;
    if (btn)  btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    try { localStorage.setItem('theme', t); } catch(e) {}
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §3  HERO 3D CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Root element: <section class="hero">
   ───────────────────────────────────────────────────────────────────────── */
class Hero3DContainer {

  constructor(app, nextSection = 'carousel') {
    this._app         = app;
    this._nextKey     = nextSection;
    this._root        = null;
    this._viewer      = null;
    this._heroText    = null;
    this._heroScroll  = null;
    this._modelLabel  = null;
    this._modelHint   = null;
    this._errorEl     = null;
    this._nav         = null;
    this._active      = false;
    this._hintDone    = false;
    this._hintReady   = false;
    this._rotateTimer = null;
    this._hintTimer   = null;  // tracks the 18s auto-dismiss timer so it can be cancelled
    this._t0y         = 0;
    this._t0x         = 0;
    this._tScrolling  = null;

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

  init(root) {
    this._root       = root;
    this._viewer     = root.querySelector('model-viewer');
    this._heroText   = root.querySelector('#hero-text');
    this._heroScroll = root.querySelector('#hero-scroll');
    this._modelLabel = root.querySelector('#model-label');
    this._modelHint  = root.querySelector('#model-hint');
    this._errorEl    = root.querySelector('#model-error');
    this._nav        = document.getElementById('nav'); // documented exception

    // ── Model-viewer preload: warm the HDR environment cache as soon as
    //    the container inits. The GLB is preloaded via <link rel="preload">
    //    in <head>; the HDR has no standard preload type so we use a no-op
    //    fetch() here. Both are relatively large assets and benefit from
    //    being in-cache before model-viewer requests them, significantly
    //    reducing the "white box" pop-in on first visit.
    if (this._viewer) {
      const hdr = this._viewer.getAttribute('skybox-image');
      if (hdr) {
        // Low-priority background fetch — won't block any critical resources.
        // 'no-cors' is used because modelviewer.dev doesn't send CORS headers
        // for the HDR; we only need to warm the cache, not read the response.
        try {
          fetch(hdr, { mode: 'no-cors', priority: 'low' }).catch(() => {});
        } catch (e) { /* ignore — purely opportunistic */ }
      }
    }

    if (this._viewer) {
      this._viewer.addEventListener('camera-change', this._onViewerCameraChange);
      this._viewer.addEventListener('error',         this._onViewerError);
      this._viewer.addEventListener('load',          this._onViewerLoad);
      this._viewer.addEventListener('mousedown',     this._onMouseDown);
      this._viewer.addEventListener('mouseup',       this._onMouseUp);
      this._viewer.addEventListener('mouseleave',    this._onMouseLeave);
      this._viewer.addEventListener('touchstart',    this._onTouchStart,  { passive: true });
      this._viewer.addEventListener('touchend',      this._onTouchEnd,    { passive: true });
    }

    // Intercept wheel/touch on root so model-viewer doesn't eat them
    this._root.addEventListener('wheel',      this._onRootWheel,      { passive: false });
    this._root.addEventListener('touchstart', this._onRootTouchStart, { passive: true  });
    this._root.addEventListener('touchmove',  this._onRootTouchMove,  { passive: false });

    this._root.style.visibility = 'hidden';
    this._root.style.opacity    = '0';
  }

  enter() {
    if (!this._root) return;
    this._active = true;
    // Reset hint state so re-entry always shows the 360° hint again
    this._hintDone  = false;
    this._hintReady = false;
    if (this._nav) this._nav.classList.remove('scrolled');
    window.scrollTo({ top: 0, behavior: 'instant' });
    this._root.style.visibility = 'visible';
    this._root.style.transition = 'opacity 0.5s cubic-bezier(0.16,1,0.3,1)';
    this._root.style.opacity    = '1';
    // Clear any inline opacity set by the scroll listener so the CSS transition plays correctly
    if (this._heroScroll) this._heroScroll.style.opacity = '';
    // Force a clean re-reveal: strip classes first so re-adding them in the
    // next frame always triggers the entrance transition even on re-entry.
    [this._heroText, this._heroScroll, this._modelLabel, this._modelHint]
      .forEach(el => el?.classList.remove('is-revealed'));
    requestAnimationFrame(() => this._revealHero());
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    // Cancel any pending auto-rotate resume so it cannot fire after we've left.
    if (this._rotateTimer) { clearTimeout(this._rotateTimer); this._rotateTimer = null; }
    // Cancel the hint auto-dismiss timer — it will be re-armed on next load event.
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
    // Restore the hint element so it will be visible on re-entry.
    this._modelHint?.classList.remove('hidden');
    this._root.style.transition = 'opacity 0.4s ease';
    this._root.style.opacity    = '0';
    // Strip reveal classes so re-entering Hero re-plays the entrance animation.
    [this._heroText, this._heroScroll, this._modelLabel, this._modelHint]
      .forEach(el => el?.classList.remove('is-revealed'));
    setTimeout(() => { if (!this._active) this._root.style.visibility = 'hidden'; }, 420);
  }

  onScroll(direction) {
    if (!this._active) return;
    if (direction === +1) this._app.setSection(this._nextKey, +1);
  }

  _revealHero() {
    if (!this._active) return;
    [this._heroText, this._heroScroll, this._modelLabel, this._modelHint]
      .forEach(el => el?.classList.add('is-revealed'));
  }

  _onViewerCameraChange() { this._dismissHint(); }
  _onViewerError() {
    if (this._errorEl) this._errorEl.classList.add('visible');
    console.warn('[Hero3DContainer] model-viewer error:', this._viewer?.src);
  }

  async _onViewerLoad() {
    await this._viewer.updateComplete;
    this._viewer.jumpCameraToGoal();
    // Open the dismiss gate after the fadeUp animation has had time to play
    // so camera-change on init doesn't hide the hint before it appears.
    setTimeout(() => { this._hintReady = true; }, 1800);
    // Auto-dismiss after 18s — tracked so exit() can cancel it.
    if (this._hintTimer) clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this._hintTimer = null;
      if (!this._active) return; // navigated away — don't touch DOM
      this._hintReady = true;
      this._dismissHint();
    }, 18000);

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

  _onMouseDown()   { this._viewer?.removeAttribute('auto-rotate'); }
  _onMouseUp()     { this._scheduleRotateResume(); }
  _onMouseLeave()  { this._scheduleRotateResume(); }
  _onTouchStart()  { this._viewer?.removeAttribute('auto-rotate'); }
  _onTouchEnd()    { this._scheduleRotateResume(); }

  _scheduleRotateResume() {
    if (this._rotateTimer) clearTimeout(this._rotateTimer);
    this._rotateTimer = setTimeout(() => this._viewer?.setAttribute('auto-rotate', ''), 800);
  }

  _dismissHint() {
    if (!this._hintReady || this._hintDone) return;
    this._hintDone = true;
    this._modelHint?.classList.add('hidden');
  }

  _onRootWheel(e) {
    if (!this._active) return;
    if (e.ctrlKey || e.metaKey) return;
    // preventDefault stops the browser from scrolling the page.
    // stopPropagation is intentionally NOT called — the window-level
    // wheel listener in AppController must receive this event to
    // accumulate velocity and dispatch scroll when threshold is met.
    e.preventDefault();
  }

  _onRootTouchStart(e) {
    if (e.touches.length === 1) {
      this._t0y = e.touches[0].clientY; this._t0x = e.touches[0].clientX; this._tScrolling = null;
    }
  }

  _onRootTouchMove(e) {
    if (!this._active || e.touches.length !== 1) return;
    const dy = this._t0y - e.touches[0].clientY;
    const dx = this._t0x - e.touches[0].clientX;
    if (this._tScrolling === null) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      this._tScrolling = Math.abs(dy) > Math.abs(dx) * 1.4;
    }
    if (this._tScrolling) {
      e.preventDefault();
      // Don't call this.onScroll() directly — AppController's touchend
      // handler owns the dispatch for touch events.
      // NOTE: do NOT reset _t0y/_t0x here — the origin must remain fixed
      // so AppController.touchend can measure total swipe displacement.
    }
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §4  CAROUSEL CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Root element: <section class="projects">
   ───────────────────────────────────────────────────────────────────────── */
class CarouselContainer {

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
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 720; // carousel CSS: 0.68s transform + margin
    this._nextArrow     = null; // c-next-arrow element
    this._resizeTopTimer = null; // debounce handle for _calcSpacerTop after resize

    this._onResize = () => {
      this._sizeSpacer();
      clearTimeout(this._resizeTopTimer);
      this._resizeTopTimer = setTimeout(() => this._calcSpacerTop(), 220);
    };
  }

  init(root) {
    this._root   = root;
    this._spacer = document.getElementById('projects-spacer'); // documented exception

    this._projs = Array.from(root.querySelectorAll(':scope .proj'));
    this._N     = this._projs.length;
    if (!this._N) return;

    // Character-by-character title animation prep
    this._projs.forEach(p => {
      const title = p.querySelector('.proj-title');
      if (!title) return;
      const text = title.textContent.trim();
      title.innerHTML = '';
      [...text].forEach(ch => {
        const s = document.createElement('span');
        s.className = 'ch'; s.textContent = ch === ' ' ? '\u00a0' : ch;
        title.appendChild(s);
      });
    });

    // Dot nav — reuse the static #c-dots already in the HTML (documented exception).
    // The HTML has a placeholder <nav id="c-dots"> for z-index stacking; we
    // populate it here rather than creating a duplicate element.
    this._dotsEl = document.getElementById('c-dots');
    if (!this._dotsEl) {
      // #c-dots is expected in the HTML. This fallback appends to body as a
      // last resort, which places it outside the projects section — visible
      // but potentially mis-styled. Log a warning so it surfaces in dev.
      console.warn('[CarouselContainer] #c-dots element not found in HTML; appending fallback to document.body.');
      this._dotsEl = document.createElement('nav');
      this._dotsEl.id = 'c-dots';
      this._dotsEl.setAttribute('aria-label', 'Project navigation');
      document.body.appendChild(this._dotsEl);
    }
    this._dotsEl.innerHTML = ''; // clear any existing dots
    this._dotsEl.style.opacity = '0';
    this._dotWraps = [];
    this._projs.forEach((p, i) => {
      const label = p.querySelector('h2')?.textContent.trim() ?? `0${i + 1}`;
      const wrap  = document.createElement('div'); wrap.className = 'c-dot-wrap';
      const lbl   = document.createElement('span'); lbl.className = 'c-dot-label sr-only'; lbl.textContent = label;
      const dot   = document.createElement('span'); dot.className = 'c-dot';
      wrap.appendChild(lbl); wrap.appendChild(dot);
      this._dotsEl.appendChild(wrap);
      this._dotWraps.push(wrap);
    });

    this._sizeSpacer();
    this._calcSpacerTop();
    window.addEventListener('resize', this._onResize, { passive: true });

    // Create the next-section arrow and append it to the dots container AFTER
    // innerHTML is cleared — so it always exists and is never wiped.
    const arrowEl = document.createElement('div');
    arrowEl.className = 'c-next-arrow';
    arrowEl.id = 'c-next-arrow';
    arrowEl.setAttribute('aria-hidden', 'true');
    arrowEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 9" fill="none"><line x1="3" y1="0" x2="3" y2="6" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><polyline points="1,4 3,7 5,4" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    if (this._dotsEl) this._dotsEl.appendChild(arrowEl);
    this._nextArrow = arrowEl;
    if (!window.matchMedia('(pointer:coarse)').matches) {
      const rectCache = new WeakMap(); // avoids hanging non-standard properties on DOM nodes
      this._projs.forEach(proj => {
        const img = proj.querySelector('.proj-img');
        if (!img) return;
        proj.addEventListener('mouseenter', () => { rectCache.set(proj, proj.getBoundingClientRect()); });
        proj.addEventListener('mousemove',  e => {
          if (!rectCache.has(proj)) rectCache.set(proj, proj.getBoundingClientRect());
          const r  = rectCache.get(proj);
          const nx = (e.clientX - r.left) / r.width  - 0.5;
          const ny = (e.clientY - r.top)  / r.height - 0.5;
          img.style.transform = `scale(1.04) rotateY(${nx * 3}deg) rotateX(${-ny * 1.5}deg)`;
        });
        proj.addEventListener('mouseleave', () => { img.style.transform = ''; });
      });
    }

    this._setPositions(0, false);
    this._root.style.visibility = 'hidden';
    this._root.classList.remove('carousel-active');
  }

  enter(fromDirection = 0) {
    if (!this._root || !this._N) return;
    this._active = true;
    // If arriving from below (scrolling up), land on the last card.
    // Any other direction (including direct nav jump = 0) resets to first card.
    if (fromDirection === -1) this._activeIdx = this._N - 1;
    else                      this._activeIdx = 0;
    // Hold _transitioning true until the double-rAF entrance animation fires.
    // Releasing it here (before rAF) would allow a rapid second scroll to
    // advance the carousel before the entrance animation completes.
    this._transitioning  = true;
    this._lastAdvanceAt  = 0;
    this._lastAdvDir     = 0;
    this._calcSpacerTop();
    this._root.style.visibility = 'visible';
    this._root.classList.add('carousel-active');
    if (this._dotsEl) this._dotsEl.style.opacity = '1';
    this._projs[this._activeIdx].dataset.pos = fromDirection === -1 ? 'prev' : 'next';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._setPositions(this._activeIdx, true);
      // Release lock AFTER positions are applied so the first advance is always clean.
      setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
    }));
    // On first entry, start background image loads for all slides now that
    // the carousel is visible. Images that are already loaded are no-ops.
    this._projs.forEach(p => {
      const img = p.querySelector('.proj-img');
      if (img && img.dataset.bg) {
        img.style.backgroundImage = `url('${img.dataset.bg}')`;
        delete img.dataset.bg;
      }
    });
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    this._root.classList.remove('carousel-active');
    if (this._dotsEl) this._dotsEl.style.opacity = '0';
    if (this._nextArrow) this._nextArrow.classList.remove('visible');
    setTimeout(() => { if (!this._active) this._root.style.visibility = 'hidden'; }, 400);
  }

  onScroll(direction) {
    if (!this._active) return;
    this._advance(direction);
  }

  _sizeSpacer() {
    if (this._spacer) this._spacer.style.height = `${this._N * window.innerHeight}px`;
  }

  _calcSpacerTop() {
    if (this._spacer) this._spacerTop = Math.round(this._spacer.getBoundingClientRect().top + window.scrollY);
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
            s.style.transitionDelay = `${420 + ci * 20}ms`; s.classList.add('show');
          });
        }
      }
      else if (delta === 1) p.dataset.pos = 'next';
      else                  p.dataset.pos = 'far-below';
      if (delta !== 0) {
        p.querySelectorAll('.proj-title .ch').forEach(s => { s.style.transitionDelay = '0ms'; s.classList.remove('show'); });
      }
    });
    this._dotWraps.forEach((w, i) => w.classList.toggle('on', i === idx));
    // Show next-section arrow only on the last slide
    if (this._nextArrow) this._nextArrow.classList.toggle('visible', idx === this._N - 1);
  }

  _advance(dir) {
    if (this._transitioning) return;
    const now = performance.now();

    const next = this._activeIdx + dir;
    if (next < 0) {
      // Lock out further _advance calls while we hand off to the previous section.
      // Without this, rapid trackpad ticks during the handoff (before AppController's
      // LOCK_MS engages) can re-enter _advance and double-fire setSection, causing the
      // "sticky on scroll-up" symptom on the Sabretta pen slide.
      this._transitioning = true;
      this._app.setSection(this._prevKey, -1);
      // Safety net: clear _transitioning if enter() never fires to reset it.
      setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
      return;
    }
    if (next >= this._N) {
      this._transitioning = true;
      this._app.setSection(this._nextKey, +1);
      setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
      return;
    }
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
   Root element: #about-stage (fixed fullscreen overlay)

   ISOLATION NOTES
   • _spacer (.about-spacer) — sibling of the stage. Located via
     document.querySelector — the one permitted exception, documented.
   • All other queries scoped to this._root.
   ───────────────────────────────────────────────────────────────────────── */
class AboutContainer {

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
    this._moreBelow = null;
    this._N       = 0;
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 900; // about panel CSS: 0.85s transform + margin

    this._onResize = () => {
      this._sizeSpacer();
      clearTimeout(this._resizeTopTimer);
      this._resizeTopTimer = setTimeout(() => this._calcSpacerTop(), 220);
    };
  }

  init(root) {
    this._root   = root;
    this._spacer = document.querySelector('.about-spacer'); // documented exception
    this._moreBelow = document.getElementById('about-more-below'); // documented exception

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
    // Preload panel 1 immediately on init — the user is very likely to scroll
    // to it and it's cheaper to fetch during idle than on first advance.
    this._preloadPanel(1);
    this._root.classList.remove('engaged');
  }

  enter(fromDirection = 0) {
    if (!this._root || !this._N) return;
    this._active = true;
    // Restore spacer height before engaging so layout is correct when the
    // stage becomes visible (was collapsed to 0 on exit to prevent gap).
    this._sizeSpacer();
    // Cache spacerTop synchronously with the current layout — this gives a
    // usable value immediately, even before the double-rAF resolves.
    this._calcSpacerTop();
    // Arrive on last panel when scrolling back up from below.
    // Any other direction (including direct nav = 0) resets to first panel.
    if (fromDirection === -1) this._activeIdx = this._N - 1;
    else                      this._activeIdx = 0;
    // Reset debounce state so the first scroll in any direction is never blocked.
    this._lastAdvDir    = 0;
    this._lastAdvanceAt = 0;
    this._transitioning = false;
    this._setPanel(this._activeIdx);
    this._root.classList.add('engaged');
    // Re-cache after layout has fully flushed (spacer height change triggers a
    // layout pass that may not be stable until the next paint frame).
    requestAnimationFrame(() => requestAnimationFrame(() => this._calcSpacerTop()));
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    this._root.classList.remove('engaged');
    // Collapse the spacer so no raw document gap is visible if a native-scroll
    // event slips through while the about-stage is hidden (visibility:hidden).
    // It is restored in enter() before the stage becomes visible again.
    if (this._spacer) this._spacer.style.height = '0px';
  }

  onScroll(direction) {
    if (!this._active) return;
    this._advance(direction);
  }

  _sizeSpacer() {
    if (this._spacer) this._spacer.style.height = `${this._N * window.innerHeight}px`;
  }

  _calcSpacerTop() {
    if (this._spacer) this._spacerTop = Math.round(this._spacer.getBoundingClientRect().top + window.scrollY);
  }

  _setPanel(idx) {
    this._activeIdx = idx;
    this._panels.forEach((el, i) => {
      el.classList.remove('is-active', 'is-after', 'is-below');
      if      (i < idx)  el.classList.add('is-after');
      else if (i === idx) el.classList.add('is-active');
      else               el.classList.add('is-below');
    });
    this._dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    if (this._hint) this._hint.classList.toggle('hide', idx > 0);
    // Show "more below" chevron only on the final panel
    if (this._moreBelow) this._moreBelow.classList.toggle('visible', idx === this._N - 1);
    // Preload images for this panel AND the next — so they're decoded before arrival.
    this._preloadPanel(idx);
    this._preloadPanel(idx + 1);
  }

  /**
   * Flush data-src → src on all <img data-src> inside a panel so the
   * browser starts fetching while the panel transition is still running.
   * Safe to call multiple times — img.src assignment is a no-op if the
   * src is already set to the same value.
   */
  _preloadPanel(idx) {
    const panel = this._panels[idx];
    if (!panel) return;
    panel.querySelectorAll('img[data-src]').forEach(img => {
      const src = img.dataset.src;
      if (src && img.src !== src) {
        img.src = src;
        img.removeAttribute('data-src');
      }
    });
  }

  _advance(dir) {
    if (this._transitioning) return;
    const now = performance.now();

    const next = this._activeIdx + dir;
    if (next < 0) {
      // Lock out further _advance calls while we hand off to the previous section.
      // Without this, rapid trackpad ticks during the handoff re-enter _advance
      // (transitioning is false, debounce doesn't match) and fire setSection again.
      this._transitioning = true;
      if (this._prevKey) this._app.setSection(this._prevKey, -1);
      // Safety net: clear _transitioning if enter() never fires to reset it.
      setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
      return;
    }
    if (next >= this._N) {
      this._transitioning = true;
      if (this._nextKey) {
        this._app.setSection(this._nextKey, +1);
      }
      // Safety net: clear _transitioning after TRANS_MS in case setSection is
      // blocked (e.g. LOCK_MS guard) and enter() never fires to reset it.
      setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
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
   §6  CONTACT CONTAINER
   ─────────────────────────────────────────────────────────────────────────
   Root element: <section class="contact"> (plus the preceding personal-
   statement section, which is part of the same scrollable region).

   The contact section is a normal, scrollable section that lives below the
   About scroll-lock stage. It is NOT a scroll-lock container itself — it
   has no internal panels to advance through. Its sole jobs are:

     enter()    — make the section visible / scroll it into view
     exit()     — called when the user scrolls back up into About
     onScroll() — only cares about upward scroll (hands back to About)

   The contact + personal-statement area is rendered in normal document
   flow. enter() uses window.scrollTo to reveal it; this is intentional
   because the container system releases scroll-lock when ContactContainer
   is active, allowing natural page scroll within this region.

   ISOLATION CONTRACT
   ──────────────────
   ✓  Root query scoped to this._root (contact section)
   ✓  No wheel / keydown / touch listeners (AppController owns those)
   ✓  Communicates upward only via this._app.setSection()
   ─────────────────────────────────────────────────────────────────────── */
class ContactContainer {

  constructor(app, prevSection = 'about') {
    this._app     = app;
    this._prevKey = prevSection;
    this._root    = null;
    this._active  = false;
    // Track how far the user has scrolled past the contact top, so we know
    // when an upward scroll should hand back to About vs just scroll up in page.
    this._contactTop = 0;
  }

  init(root) {
    this._root = root;
    // Cache contact top on resize
    window.addEventListener('resize', () => { this._cacheTop(); }, { passive: true });
  }

  _cacheTop() {
    if (this._root) {
      // rAF ensures we read after any pending layout has flushed,
      // so getBoundingClientRect() returns a stable value.
      requestAnimationFrame(() => {
        if (this._root) {
          this._contactTop = Math.round(this._root.getBoundingClientRect().top + window.scrollY);
        }
      });
    }
  }

  enter(fromDirection = 0) {
    if (!this._root) return;
    this._active = true;
    document.body.classList.add('section-contact');

    // Immediately jump to contact top so the ticker and spacer are never
    // visible — even if the about-stage hasn't finished fading out yet.
    // Read position synchronously here (not via rAF) so scrollTo fires
    // in the same task; _cacheTop() will then re-verify with rAF below.
    const top = Math.round(this._root.getBoundingClientRect().top + window.scrollY);
    this._contactTop = top;
    window.scrollTo({ top, behavior: 'instant' });

    // Re-cache twice: once after a short delay (covers most layout flushes)
    // and once after a longer delay (covers mobile reflow of the about-spacer
    // which AboutContainer.exit collapses to 0 — the layout change can shift
    // the contact section's document position by several hundred px on mobile).
    // Both measurements use rAF inside _cacheTop for an accurate read.
    setTimeout(() => this._cacheTop(), 120);
    setTimeout(() => this._cacheTop(), 500);
  }

  exit() {
    if (!this._root) return;
    this._active = false;
    document.body.classList.remove('section-contact');
    // Abort any in-flight smooth scroll so scrollY is deterministic before
    // AboutContainer (or any other container) takes over. Without this, the
    // continuing smooth scroll fires PageChrome's scroll listener with
    // intermediate scrollY values that trip nativeScrollDirection incorrectly
    // on the very next wheel event.
    window.scrollTo({ top: window.scrollY, behavior: 'instant' });
  }

  /**
   * nativeScrollDirection — called by AppController's wheel handler.
   * Returns true for downward scroll (+1) so the browser can scroll the
   * contact/statement/footer area naturally. Returns false for upward (-1)
   * so we can intercept it and hand back to About when the user scrolls
   * back up to the top of the contact region.
   *
   * @param {number} dir  +1 (down) | -1 (up)
   * @returns {boolean}
   */
  nativeScrollDirection(dir) {
    if (!this._active) return false;
    // Always allow downward native scroll so footer is reachable.
    if (dir === +1) return true;
    // For upward: allow native scroll while the user is still scrolled
    // below the entry point of the contact region. Once they've scrolled
    // back up to within 80px of the top, intercept and hand back to About.
    // If scrollY is somehow BELOW contactTop (stale cache after spacer collapse),
    // re-measure immediately so we don't get permanently stuck.
    if (dir === -1) {
      // Lazy re-cache: if our cached top looks wrong (page hasn't scrolled there),
      // update it now to avoid mis-blocking the hand-back.
      if (this._root && window.scrollY < this._contactTop - 200) {
        this._contactTop = Math.round(this._root.getBoundingClientRect().top + window.scrollY);
      }
      const atTop = window.scrollY <= this._contactTop + 80;
      return !atTop;
    }
    return false;
  }

  onScroll(direction) {
    if (!this._active) return;
    // Reached only when nativeScrollDirection returned false —
    // user is at the contact top and scrolled up.
    // AppController's settle window will absorb inertia after the handoff.
    if (direction === -1) {
      this._app.setSection(this._prevKey, -1);
    }
  }
}


/* ─────────────────────────────────────────────────────────────────────────
   §7  BOOTSTRAP
   ─────────────────────────────────────────────────────────────────────────
   The ONLY block that:
     • instantiates all classes
     • encodes section order (via constructor args)
     • maps section names to DOM elements
   ───────────────────────────────────────────────────────────────────────── */
(function bootstrap() {
  const chrome   = new PageChrome();
  const app      = new AppController(chrome);

  // Give PageChrome a reference to app so nav anchor clicks can call
  // app.setSection() instead of window.scrollTo (which fights the scroll lock).
  chrome.setApp(app);

  const hero     = new Hero3DContainer(app,   /* next */ 'carousel');
  const carousel = new CarouselContainer(app, /* next */ 'about',    /* prev */ 'hero');
  // FIX: was null — AboutContainer never handed off to contact
  const about    = new AboutContainer(app,    /* next */ 'contact',  /* prev */ 'carousel');
  const contact  = new ContactContainer(app,  /* prev */ 'about');

  app.register('hero',     hero);
  app.register('carousel', carousel);
  app.register('about',    about);
  app.register('contact',  contact);

  app.init(
    {
      hero:     document.querySelector('.hero'),
      carousel: document.querySelector('.projects'),
      about:    document.getElementById('about-stage'),
      // Contact root is the <section class="contact"> element.
      contact:  document.getElementById('contact'),
    },
    'hero'
  );

  chrome.init();
})();
