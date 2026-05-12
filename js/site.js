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
// MOUSE: min ms between consecutive fires in the SAME direction (prevents mechanical double-tick)
const MOUSE_COOLDOWN_MS = 350;
// MOUSE: min ms between fires in OPPOSITE directions — much shorter since reversal is unambiguous
const MOUSE_REVERSAL_MS = 80;
// TRACKPAD: fire once net displacement in rolling window exceeds this
const TRACKPAD_THRESH   = 55;   // px net; comfortable flick without requiring a hard shove
// TRACKPAD: rolling window duration — events older than this are discarded
const TRACKPAD_WINDOW_MS= 180;  // ms; wide enough for a natural swipe, short for inertia rejection
// TRACKPAD: ignore individual events below this (sub-pixel jitter filter)
const TRACKPAD_MIN_DELTA= 1.5;  // px
// POST-FIRE: absorb inertia/bounce in the SAME direction as the last fire
const SETTLE_MS         = 440;  // ms; covers trackpad inertia tail without feeling slow
// POST-FIRE: settle window for the OPPOSITE direction — near-zero so reversals feel instant.
// A small non-zero value (40ms) prevents a stray simultaneous event on the wrong path
// from double-firing, without making reversal feel sluggish.
const SETTLE_REVERSAL_MS = 40;
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

    // ── Last fire direction — used to make settle + cooldowns direction-aware ──
    // A reversal (opposite dir) gets a much shorter settle/cooldown than a
    // continuation (same dir), making the engine feel responsive to intentional
    // direction changes without compromising inertia rejection.
    this._lastFireDir   = 0; // 0 = no fire yet, +1 = last fired down, -1 = last fired up

    // ── Mouse path state ───────────────────────────────────────────────
    this._mouseLastFire = 0; // timestamp of last mouse-path fire

    // ── Trackpad path state ────────────────────────────────────────────
    // Fixed-size ring buffer: avoids allocating a new array on every wheel
    // event (the old filter() approach). Size is generous — at 60 fps and
    // TRACKPAD_WINDOW_MS=180ms you see at most ~11 events; 32 slots is ample.
    this._tpBuf     = new Array(32);
    this._tpHead    = 0; // write pointer (next slot to overwrite)
    this._tpCount   = 0; // how many slots are currently valid

    // ── Touch mid-gesture reversal tracking ────────────────────────────
    // touchstart sets the origin; touchmove watches for a direction flip
    // past a minimum threshold and resets the origin to the reversal point.
    // This prevents a downward swipe followed by an upward recovery within
    // the same touch gesture from reporting a near-zero net dy at touchend.
    this._touchLastDir  = 0; // direction of the most recent touchmove segment

    // ── Global listeners — ONLY place in the codebase ─────────────────
    window.addEventListener('wheel', (e) => {
      // All sections are scroll-locked; the engine always intercepts wheel events.
      e.preventDefault();

      // Normalise delta to pixels regardless of deltaMode
      const raw = e.deltaMode === 1 ? e.deltaY * 32
                : e.deltaMode === 2 ? e.deltaY * window.innerHeight
                : e.deltaY;
      if (raw === 0) return;

      const now    = performance.now();
      const dir    = raw > 0 ? +1 : -1;
      const absRaw = Math.abs(raw);

      // ── POST-FIRE SETTLE: direction-aware ────────────────────────────
      const isReversal = this._lastFireDir !== 0 && dir !== this._lastFireDir;
      const effectiveSettle = isReversal ? SETTLE_REVERSAL_MS : SETTLE_MS;
      if (now < this._settleUntil) {
        const settleStart = this._settleUntil - SETTLE_MS;
        if (!isReversal || now < settleStart + effectiveSettle) return;
      }

      // ── CLASSIFY: mouse vs trackpad ──────────────────────────────────
      const isMouse = absRaw >= MOUSE_THRESHOLD;

      if (isMouse) {
        const sinceLastFire = now - this._mouseLastFire;
        const cooldown = isReversal ? MOUSE_REVERSAL_MS : MOUSE_COOLDOWN_MS;
        if (sinceLastFire < cooldown) return;
        // Use _fireSoft when locked: a rejected setSection call shouldn't
        // cost 440ms of settle. The full _fire settle is still armed on a
        // successful transition (inside _activateDirect / enter()).
        if (this._locked) { this._fireSoft(dir); } else { this._fire(dir); }
      } else {
        if (absRaw < TRACKPAD_MIN_DELTA) return;

        // Direction-reversal flush
        if (this._tpCount > 0) {
          let existingNet = 0;
          const bufLen0 = this._tpBuf.length;
          for (let i = 0; i < this._tpCount; i++) {
            const slot = this._tpBuf[(this._tpHead - 1 - i + bufLen0) % bufLen0];
            if (now - slot.t > TRACKPAD_WINDOW_MS) break;
            existingNet += slot.dy;
          }
          if (existingNet !== 0 && Math.sign(existingNet) !== Math.sign(raw)) {
            this._tpHead = 0; this._tpCount = 0;
          }
        }

        this._tpBuf[this._tpHead] = { t: now, dy: raw };
        this._tpHead = (this._tpHead + 1) % this._tpBuf.length;
        if (this._tpCount < this._tpBuf.length) this._tpCount++;

        // Net displacement across entries still within the rolling window
        let net = 0;
        const bufLen = this._tpBuf.length;
        for (let i = 0; i < this._tpCount; i++) {
          const slot = this._tpBuf[(this._tpHead - 1 - i + bufLen) % bufLen];
          if (now - slot.t > TRACKPAD_WINDOW_MS) break;
          net += slot.dy;
        }

        if (Math.abs(net) >= TRACKPAD_THRESH) {
          const fireDir = net > 0 ? +1 : -1;
          this._tpHead = 0; this._tpCount = 0;
          if (this._locked) { this._fireSoft(fireDir); } else { this._fire(fireDir); }
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
      // Left/Right arrows navigate the about carousel when it is engaged.
      // Route through the fire path (settle window + transitioning guard)
      // so key-repeat cannot double-fire a panel advance.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const about = this._containers.get('about');
        if (about?._active) {
          e.preventDefault();
          const now = performance.now();
          if (now >= this._settleUntil) this._fire(e.key === 'ArrowRight' ? 1 : -1);
        }
      }
      if (e.key === 'Escape') {
        const active = this._containers.get(this._activeKey);
        if (active?.onEscape) active.onEscape();
      }
    });

    let _ty0 = 0, _tx0 = 0, _tTime0 = 0, _tIsRotateZone = false;
    window.addEventListener('touchstart', (e) => {
      _ty0 = e.touches[0].clientY;
      _tx0 = e.touches[0].clientX;
      _tTime0 = performance.now();
      this._touchLastDir = 0; // reset mid-gesture direction tracking on new touch
      // Track if this touch started in the hero rotate zone (left half on mobile)
      _tIsRotateZone = false;
      if (this._activeKey === 'hero' && window.matchMedia('(pointer:coarse)').matches) {
        _tIsRotateZone = _tx0 < window.innerWidth / 2;
      }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      // If in hero rotate zone, let model-viewer handle it — don't treat as scroll
      if (_tIsRotateZone) return;
      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;
      const dy = Math.abs(currentY - _ty0);
      const dx = Math.abs(currentX - _tx0);
      if (dy > dx && dy > 10) {
        const touchDir = (currentY - _ty0) > 0 ? -1 : +1;
        e.preventDefault();

        // ── Mid-gesture reversal reset ──────────────────────────────────
        // If the user reverses direction mid-gesture (e.g. starts scrolling
        // down then pulls back up), reset the origin to the current point.
        // Without this, touchend measures dy from the original origin and sees
        // a small or wrong-sign net, causing the gesture to misfire or drop.
        // Only reset after a minimum displacement (12px) in the new direction
        // to avoid flipping on micro-jitter at the turn-around point.
        if (this._touchLastDir !== 0 && touchDir !== this._touchLastDir) {
          const reversalDy = Math.abs(currentY - _ty0);
          if (reversalDy > 12) {
            _ty0    = currentY;
            _tx0    = currentX;
            _tTime0 = performance.now();
          }
        }
        this._touchLastDir = touchDir;
      }
    }, { passive: false });
    window.addEventListener('touchend', (e) => {
      // Ignore if this was a rotate-zone touch (handled by model-viewer)
      if (_tIsRotateZone) { _tIsRotateZone = false; return; }
      const dy     = _ty0 - e.changedTouches[0].clientY;
      const dx     = Math.abs(e.changedTouches[0].clientX - _tx0);
      const dt     = Math.max(1, performance.now() - _tTime0);
      const vel    = Math.abs(dy) / dt;
      const locked = Math.abs(dy) > dx * 1.2;
      const valid  = (vel >= 0.25 && Math.abs(dy) >= 18) || Math.abs(dy) >= 40;
      if (locked && valid) {
        const dir = dy > 0 ? +1 : -1;
        const now = performance.now();
        // Direction-aware settle for touch too: reversals pass through faster
        const isReversal = this._lastFireDir !== 0 && dir !== this._lastFireDir;
        const settleStart = this._settleUntil - SETTLE_MS;
        const effectiveSettle = isReversal ? SETTLE_REVERSAL_MS : SETTLE_MS;
        if (now < this._settleUntil) {
          if (!isReversal || now < settleStart + effectiveSettle) return;
        }
        this._fire(dir);
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
        this._settleUntil   = 0;
        this._mouseLastFire = 0;
        this._lastFireDir   = 0;
        this._touchLastDir  = 0;
        this._tpHead = 0; this._tpCount = 0;
        this._locked = false;
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
    // Always arm with the full SETTLE_MS — the direction-aware check in the
    // wheel handler computes the effective window at read-time using _lastFireDir,
    // so we only need to record the ceiling here.
    const now = performance.now();
    this._settleUntil   = now + SETTLE_MS;
    this._mouseLastFire = now;
    this._lastFireDir   = dir;
    // Clear trackpad buffer so the settle period starts clean
    this._tpHead = 0; this._tpCount = 0;
    this._dispatchScroll(dir);
  }

  /**
   * Like _fire but does NOT re-arm the settle window.
   * Used when the container wants to attempt a section change that may be
   * rejected by _locked — we don't want a failed setSection call to cost
   * the user 440ms of frozen input.
   */
  _fireSoft(dir) {
    const now = performance.now();
    this._mouseLastFire = now;
    this._lastFireDir   = dir;
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
      this._lastFireDir   = 0;
      this._touchLastDir  = 0;
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
    // Extend the settle window to cover the full lock period so a single scroll
    // gesture cannot simultaneously trigger the section change AND the first
    // advance in the new section.
    const settleEnd = performance.now() + LOCK_MS;
    if (settleEnd > this._settleUntil) this._settleUntil = settleEnd;
    next.enter(fromDirection);
    this._chrome?.notifySection?.(name);
  }

  _dispatchScroll(direction) {
    if (!this._activeKey) return;
    const active = this._containers.get(this._activeKey);
    if (active?.onScroll) active.onScroll(direction);
  }

  /** Navigate directly to the contact panel (last About panel). */
  goToContactPanel() {
    const about = this._containers.get('about');
    // Wait for the section-change LOCK_MS to clear before jumping to the
    // last panel, so the panel jump is never swallowed by the lock guard.
    if (about) setTimeout(() => about.goToLastPanel(), LOCK_MS);
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
      '#contact': 'about',  // contact is now the last panel of about
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
          this._app.setSection(sectionKey, 0, true);
          // #contact jumps to the last About panel — ask the app to do it cleanly
          if (href === '#contact') this._app.goToContactPanel();
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

    // ── Nav scrolled + hero scroll hint ───────────────────────────────
    const heroScrollEl = document.getElementById('hero-scroll');
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (this._navEl) this._navEl.classList.toggle('scrolled', y > 40);
      if (heroScrollEl && y > 60) heroScrollEl.style.opacity = '0';
    }, { passive: true });

    // ── Resize ─────────────────────────────────────────────────────────
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
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

  // Cursor state is expressed as body classes so CSS owns all appearance.

  /**
   * Called by AppController._activateDirect whenever the active section changes.
   * Updates body[data-section] and the section indicator label.
   * @param {string} sectionKey  'hero' | 'carousel' | 'about'
   */
  notifySection(key) {
    // Drive body[data-section] so CSS can show/hide section-specific UI
    // (e.g. the nav availability badge which should only appear on hero).
    document.body.dataset.section = key;
    // Update nav section label — shows current section on hover
    const navLabel = document.getElementById('n-section-label');
    if (navLabel) {
      const labelMap = { hero: '', carousel: 'Projects', about: 'About' };
      navLabel.textContent = labelMap[key] ?? '';
    }
    // Legacy section indicator (now hidden via CSS, but keep update for backwards compat)
    if (!this._secInd) return;
    const labelMap = { hero: 'Hero', carousel: 'Projects', about: 'About' };
    const label = labelMap[key];
    if (label) {
      this._secInd.textContent = label;
      this._secInd.classList.toggle('visible', key !== 'hero');
    }
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
    // Mobile touch zone tracking
    this._touchIsRotate  = false; // true = left-half touch (rotate model), false = right-half (scroll)
    this._touchStartX    = 0;

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
    // Re-enable auto-rotate (was removed on exit to prevent GPU thrash)
    if (this._viewer) {
      this._viewer.setAttribute('auto-rotate', '');
    }
    requestAnimationFrame(() => this._revealHero());
    // Mobile swipe hint — show once per session on touch devices
    if (window.matchMedia('(pointer:coarse)').matches) {
      const mobileHint = document.getElementById('hero-mobile-hint');
      const alreadySeen = (() => { try { return sessionStorage.getItem('heroHintSeen'); } catch(e) { return null; } })();
      if (mobileHint && !alreadySeen) {
        setTimeout(() => {
          if (!this._active) return;
          mobileHint.classList.add('visible');
          setTimeout(() => {
            mobileHint.classList.remove('visible');
            mobileHint.classList.add('gone');
            try { sessionStorage.setItem('heroHintSeen', '1'); } catch(e) {}
          }, 3000);
        }, 1200);
      }
    }
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
    // Pause model-viewer on mobile to prevent GPU/state thrash when
    // the user scrolls away and back repeatedly. Pausing stops the render
    // loop and prevents the auto-rotate from accumulating delta while hidden.
    if (this._viewer) {
      this._viewer.removeAttribute('auto-rotate');
      // On mobile, also reset camera to default orbit so re-entry always
      // shows the model from the correct angle after extended interaction.
      if (window.matchMedia('(pointer: coarse)').matches) {
        try {
          this._viewer.cameraOrbit = '-20deg 92deg 50%';
          this._viewer.jumpCameraToGoal();
        } catch(e) { /* non-fatal — viewer may not be loaded yet */ }
      }
    }
    setTimeout(() => { if (!this._active) this._root.style.visibility = 'hidden'; }, 420);
    // Dismiss mobile hint immediately if still visible
    const mobileHint = document.getElementById('hero-mobile-hint');
    if (mobileHint) { mobileHint.classList.remove('visible'); mobileHint.classList.add('gone'); }
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

  _onViewerCameraChange(e) {
    // Only dismiss hint on genuine user interaction (drag), not on auto-rotate
    // camera-change events which fire continuously during the idle spin.
    if (e && e.detail && e.detail.source === 'user-interaction') {
      this._dismissHint();
    }
  }
  _onViewerError() {
    if (this._errorEl) this._errorEl.classList.add('visible');
    console.warn('[Hero3DContainer] model-viewer error:', this._viewer?.src);
  }

  async _onViewerLoad() {
    try { await this._viewer.updateComplete; } catch(e) { /* non-fatal */ }
    this._viewer.jumpCameraToGoal();
    // Open the dismiss gate after the fadeUp animation has had time to play
    // so camera-change on init doesn't hide the hint before it appears.
    setTimeout(() => { this._hintReady = true; }, 1800);
    // No auto-dismiss timer — hint stays until the user actually drags the model.
    if (this._hintTimer) { clearTimeout(this._hintTimer); this._hintTimer = null; }
  }

  _onMouseDown()   { this._viewer?.removeAttribute('auto-rotate'); }
  _onMouseUp()     { this._scheduleRotateResume(); }
  _onMouseLeave()  { this._scheduleRotateResume(); }
  _onTouchStart(e) {
    // On mobile, only treat left-half touches as rotation gestures.
    // Right-half touches are scroll gestures — don't stop auto-rotate or dismiss hint.
    if (window.matchMedia('(pointer:coarse)').matches) {
      const x = e?.touches?.[0]?.clientX ?? 0;
      if (x >= window.innerWidth / 2) return; // right half = scroll zone, ignore
    }
    this._viewer?.removeAttribute('auto-rotate');
    this._dismissHint();
  }
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
      this._t0y = e.touches[0].clientY;
      this._t0x = e.touches[0].clientX;
      this._tScrolling = null;
      // Mobile touch zone: left half = rotate model, right half = scroll
      if (window.matchMedia('(pointer:coarse)').matches) {
        this._touchStartX    = e.touches[0].clientX;
        this._touchIsRotate  = this._touchStartX < window.innerWidth / 2;
        if (this._touchIsRotate) {
          // Let model-viewer handle this touch — stop it from being a scroll
          // by NOT calling preventDefault in touchmove (model-viewer needs the event).
          // We need to tell AppController not to scroll: set a flag.
          this._viewer?.removeAttribute('auto-rotate');
          this._dismissHint();
        }
      }
    }
  }

  _onRootTouchMove(e) {
    if (!this._active || e.touches.length !== 1) return;
    const dy = this._t0y - e.touches[0].clientY;
    const dx = this._t0x - e.touches[0].clientX;
    // On mobile, left half touches are for model rotation — pass through to model-viewer
    if (window.matchMedia('(pointer:coarse)').matches && this._touchIsRotate) {
      // Don't preventDefault — let model-viewer's internal touch handler rotate the model
      // But DO prevent the global AppController from treating this as a scroll:
      // We stop propagation so AppController's touchmove handler doesn't see it.
      // Note: AppController uses window listeners, so we stop here at the root level.
      // Actually we need to swallow the event from AppController's perspective.
      // The cleanest way: don't preventDefault (lets model-viewer rotate), 
      // but call stopPropagation so AppController window listener doesn't see it.
      e.stopPropagation();
      return;
    }
    if (this._tScrolling === null) {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      this._tScrolling = Math.abs(dy) > Math.abs(dx) * 1.4;
    }
    if (this._tScrolling) {
      e.preventDefault();
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
    this._dogEar        = null; // dog-ear tab element
    this._dogEarText    = null; // dog-ear text label
    this._dogEarDismissed = false; // one-time teach: hide after first advance
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
      // Click-to-navigate: jump directly to this project
      wrap.addEventListener('click', () => {
        if (!this._active || this._transitioning) return;
        const dir = i - this._activeIdx;
        if (dir === 0) return;
        this._transitioning = true;
        this._activeIdx = i;
        this._setPositions(this._activeIdx, true);
        setTimeout(() => { this._transitioning = false; }, this._TRANS_MS);
      });
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

    // Dog-ear tab — lives in the projects section HTML, manage via JS
    this._dogEar     = document.getElementById('c-dog-ear');
    this._dogEarText = document.getElementById('dog-ear-text');
    if (this._dogEar) {
      this._dogEar.addEventListener('click', () => {
        if (!this._active) return;
        // On last slide, advance to next section; otherwise advance carousel
        if (this._activeIdx >= this._N - 1) {
          this._app.setSection(this._nextKey, +1);
        } else {
          this._advance(+1);
        }
      });
    }
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
    // Reset dog-ear dismiss state so it re-teaches on re-entry
    this._dogEarDismissed = false;
    if (this._dogEar) {
      this._dogEar.classList.remove('is-last');
      this._dogEar.classList.add('visible');
    }
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
    if (this._dogEar)   this._dogEar.classList.remove('visible');
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
    // Dog-ear: update label for last slide, dismiss after first successful advance
    if (this._dogEar) {
      const isLast = idx === this._N - 1;
      this._dogEar.classList.toggle('is-last', isLast);
      if (this._dogEarText) {
        this._dogEarText.textContent = isLast ? 'About' : 'Next';
      }
      // One-time teach: hide after first advance (animate = true signals a real advance)
      if (animate && !this._dogEarDismissed) {
        this._dogEarDismissed = true;
        // Small delay so the user sees the tab disappear after the advance lands
        setTimeout(() => {
          if (this._dogEar) this._dogEar.classList.remove('visible');
        }, 900);
      }
    }
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
    // Index of the contact panel (last panel) — set in init() once panels are counted
    this._contactPanelIdx  = -1;
    // Index of the personal-statement panel (second-to-last) — YouTube iframe is
    // injected lazily the first time this panel becomes active.
    this._statementPanelIdx = -1;
    this._iframeInjected    = false;
    this._resizeTopTimer    = null; // debounce handle for _calcSpacerTop after resize

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
    // The last panel is the contact panel — track its index so we can
    // update the section indicator label and suppress its dot.
    this._contactPanelIdx   = this._N - 1;
    this._statementPanelIdx = this._N - 2;

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

  /** Called by AppController.goToContactPanel() when a nav link targets #contact. */
  goToLastPanel() {
    if (this._active) this._setPanel(this._N - 1);
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
      // Hide off-screen panels from AT — they are visually hidden and their
      // links/text should not be reachable by keyboard or screen reader
      el.setAttribute('aria-hidden', i === idx ? 'false' : 'true');
    });
    // Announce the newly active panel to screen readers via the polite live region
    const announcer = document.getElementById('about-announcer');
    if (announcer) {
      const label = this._panels[idx]?.getAttribute('aria-label') || '';
      announcer.textContent = label;
    }
    // Only drive dots for the non-contact panels (contact panel has no dot —
    // it uses the more-below arrow as its indicator instead).
    this._dots.forEach((d, i) => d.classList.toggle('on', i === idx));
    if (this._hint) this._hint.classList.toggle('hide', idx > 0);
    // Show "more below" chevron on the panel BEFORE the contact panel (statement)
    // — this signals there's one more slide (contact) without giving contact its own dot.
    // Hide it on the contact panel itself (nothing below).
    if (this._moreBelow) {
      const showArrow = idx === this._N - 2; // second-to-last = statement panel
      this._moreBelow.classList.toggle('visible', showArrow);
    }
    // Update section indicator label: "Contact" on contact panel, "About" otherwise
    const secInd = document.getElementById('section-indicator');
    if (secInd) {
      if (idx === this._contactPanelIdx) {
        secInd.textContent = 'Contact';
      } else if (this._active) {
        secInd.textContent = 'About';
      }
    }
    // Update about counter indicator
    const counter = document.getElementById('about-counter');
    if (counter) {
      const curEl    = counter.querySelector('.ac-cur');
      const chevron  = counter.querySelector('.about-counter-chevron');
      const sepEl    = counter.querySelector('.ac-sep');
      const totEl    = counter.querySelector('.ac-total');
      const isContact       = idx === this._contactPanelIdx;           // panel 5
      const isStatementPanel = idx === this._N - 2;                     // panel 4 = 5/5
      // Total displayed panels = N-1 (panels 0..4, not counting contact)
      const displayTotal = this._N - 1;

      if (isContact) {
        // Contact panel: CSS :has hides counter, but keep DOM consistent
        if (curEl)  curEl.textContent = 'Next Section';
        if (sepEl)  sepEl.style.display = 'none';
        if (totEl)  totEl.style.display = 'none';
        if (chevron) chevron.classList.add('hide');
      } else if (isStatementPanel) {
        // Last navigable About panel — show "Next Section" instead of "5/5"
        if (curEl)  curEl.textContent = 'Next Section';
        if (sepEl)  sepEl.style.display = 'none';
        if (totEl)  totEl.style.display = 'none';
        if (chevron) chevron.classList.add('hide');
      } else {
        // Normal panels: show N/Total
        if (sepEl)  sepEl.style.display = '';
        if (totEl)  { totEl.style.display = ''; totEl.textContent = displayTotal; }
        if (curEl)  curEl.textContent = idx + 1;
        if (chevron) chevron.classList.remove('hide');
      }
    }
    // Reveal contact panel content — .contact-inner carries .rev-stagger which is
    // intentionally excluded from the global IntersectionObserver (it lives inside
    // #about-stage). Drive the .in class here instead so the entrance animation fires
    // when the contact panel becomes active, and resets when it leaves.
    const contactPanel = this._panels[this._contactPanelIdx];
    if (contactPanel) {
      contactPanel.querySelectorAll('.rev-stagger').forEach(el => {
        el.classList.toggle('in', idx === this._contactPanelIdx);
      });
    }
    // Inject the YouTube iframe the first time panel 3 (personal statement) becomes
    // active. Keeping it out of the DOM until then prevents the browser from
    // initiating the YouTube connection (DNS, TLS, iframe JS) during earlier panel
    // transitions, which was a primary contributor to sluggishness mid-slideshow.
    if (idx >= this._statementPanelIdx && !this._iframeInjected) {
      const stmtPanel = this._panels[this._statementPanelIdx];
      const frameWrap = stmtPanel?.querySelector('.stmt-video-frame');
      const placeholder = frameWrap?.querySelector('iframe[data-src]');
      if (placeholder) {
        placeholder.src = placeholder.dataset.src;
        placeholder.removeAttribute('data-src');
        this._iframeInjected = true;
      }
    }
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
   §6  BOOTSTRAP
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
  // About is now the terminal section — contact is embedded as its final panel.
  const about    = new AboutContainer(app,    /* next */ null,        /* prev */ 'carousel');

  app.register('hero',     hero);
  app.register('carousel', carousel);
  app.register('about',    about);

  app.init(
    {
      hero:     document.querySelector('.hero'),
      carousel: document.querySelector('.projects'),
      about:    document.getElementById('about-stage'),
    },
    'hero'
  );

  chrome.init();
})();
