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
   ───────────────────────────────────────────────────────────────────────── */
class AppController {

  constructor(chrome = null) {
    this._chrome     = chrome;
    this._containers = new Map();
    this._activeKey  = null;
    this._locked     = false;
    this._LOCK_MS    = 850; // >= longest container _TRANS_MS + buffer

    // ── Wheel velocity model ───────────────────────────────────────────
    this._wVel        = 0;
    this._wLastTime   = 0;
    // After every section change, ignore wheel input for SETTLE_MS so that
    // trackpad inertia from the previous section cannot chain into the next.
    this._settleUntil = 0;
    this._SETTLE_MS   = 520;
    const W_THRESH  = 160;
    const W_DECAY   = 0.94;
    const W_CLAMP   = 90;
    const W_MIN     = 20;

    // ── Global listeners — ONLY place in the codebase ─────────────────
    window.addEventListener('wheel', (e) => {
      // Allow native scroll if the active container opts in for this direction.
      // This lets terminal sections (e.g. Contact) scroll the page naturally
      // downward while still intercepting upward wheel to hand back to About.
      const rawDir = e.deltaY > 0 ? +1 : e.deltaY < 0 ? -1 : 0;
      const activeContainer = this._activeKey ? this._containers.get(this._activeKey) : null;
      const nativeAllowed = activeContainer?.nativeScrollDirection?.(rawDir) === true;
      if (!nativeAllowed) e.preventDefault();

      const raw = e.deltaMode === 1 ? e.deltaY * 32
                : e.deltaMode === 2 ? e.deltaY * window.innerHeight
                : e.deltaY;
      const now = performance.now();
      // During the post-transition settle window, eat the event but don't act.
      // This absorbs trackpad inertia that would otherwise chain into the new section.
      if (now < this._settleUntil) { this._wVel = 0; this._wLastTime = now; return; }
      const gap = now - this._wLastTime;
      if (gap > 600 || this._wLastTime === 0) { this._wVel = 0; }
      else { this._wVel *= Math.pow(W_DECAY, gap / 16); }
      this._wLastTime = now;
      const contrib = raw === 0 ? 0
        : Math.sign(raw) * Math.min(Math.max(Math.abs(raw), W_MIN), W_CLAMP);
      this._wVel += contrib;
      if (!nativeAllowed) {
        if (this._wVel >  W_THRESH) { this._wVel = 0; this._dispatchScroll(+1); }
        if (this._wVel < -W_THRESH) { this._wVel = 0; this._dispatchScroll(-1); }
      } else {
        // Still watch for upward flick past threshold so we can hand back
        if (this._wVel < -W_THRESH) { this._wVel = 0; this._dispatchScroll(-1); }
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); this._dispatchScroll(+1); }
      if (e.key === 'ArrowUp'   || e.key === 'PageUp')   { e.preventDefault(); this._dispatchScroll(-1); }
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
        // Check if active container allows native scroll in this direction
        const touchDir = (e.touches[0].clientY - _ty0) > 0 ? -1 : +1; // finger up = scroll down
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
      const valid  = (vel >= 0.3 && Math.abs(dy) >= 20) || Math.abs(dy) >= 44;
      if (locked && valid) this._dispatchScroll(dy > 0 ? +1 : -1);
    }, { passive: true });
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
    this._activateDirect(name, fromDirection);
    setTimeout(() => { this._locked = false; }, this._LOCK_MS);
  }

  _activateDirect(name, fromDirection = 0) {
    const next = this._containers.get(name);
    if (!next) return;
    if (this._activeKey) this._containers.get(this._activeKey)?.exit();
    this._activeKey = name;
    // Flush velocity and start settle window so inertia from the departing
    // section cannot chain into the newly entered one.
    this._wVel        = 0;
    this._wLastTime   = 0;
    this._settleUntil = performance.now() + this._SETTLE_MS;
    next.enter(fromDirection);
    // Notify PageChrome so the section indicator updates immediately,
    // rather than relying on scroll position (unreliable in scroll-lock mode).
    this._chrome?.notifySection?.(name);
  }

  _dispatchScroll(direction) {
    if (this._chrome) this._chrome.onScroll(window.scrollY);
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
     • Hero coordinates scramble
     • Copyright year

   ONLY object besides AppController that may attach document-level listeners.
   Attaches: mousemove, mousedown, mouseup, mouseleave, mouseenter, click.
   Does NOT attach wheel, scroll, keydown, or touch — AppController owns those.
   ───────────────────────────────────────────────────────────────────────── */
class PageChrome {

  constructor() {
    // AppController reference — set via setApp() after bootstrap wires everything
    this._app     = null;

    // Cursor
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

    // Section indicator
    this._secInd  = null;
    this._navEl   = null;
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
    this._prog  = document.getElementById('prog');
    this._navEl = document.getElementById('nav');
    this._secInd= document.getElementById('section-indicator');

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
        requestAnimationFrame(() => { if (veil) { veil.style.transition = ''; veil.style.clipPath = ''; } });
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

    // Cursor ring RAF loop
    if (window.matchMedia('(pointer:fine)').matches) {
      const loop = () => {
        const rxN = this._rx + (this._mx - this._rx) * 0.1;
        const ryN = this._ry + (this._my - this._ry) * 0.1;
        const rN  = this._ringCur + (this._ringTgt - this._ringCur) * 0.12;
        if (Math.abs(rxN - this._rx) > 0.02 || Math.abs(ryN - this._ry) > 0.02 || Math.abs(rN - this._ringCur) > 0.05) {
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

    // ── Scroll reveal ──────────────────────────────────────────────────
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.06 });
    document.querySelectorAll('.rev, .rev-stagger').forEach(r => io.observe(r));

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
        hamburger.setAttribute('aria-expanded', isOpen);
        hamburger.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
        navDrawer.setAttribute('aria-hidden', !isOpen);
      });
      ['dw-top','dw-work','dw-about','dw-contact'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
          document.body.classList.remove('menu-open');
          hamburger.setAttribute('aria-expanded', 'false');
          hamburger.setAttribute('aria-label', 'Open menu');
          navDrawer.setAttribute('aria-hidden', 'true');
        });
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
        let iter = 0; const TARGET = 'GREEN';
        const iv = setInterval(() => {
          logoLast.textContent = TARGET.split('').map((c, i) =>
            i < iter ? c : CHARS[Math.floor(Math.random() * CHARS.length)]
          ).join('');
          if (iter >= TARGET.length) { clearInterval(iv); logoLast.textContent = 'Green'; scrambling = false; }
          iter += 0.38;
        }, 26);
      };
      logo.addEventListener('mouseenter', scramble);
      logo.addEventListener('focus', () => { if (!scrambling) logo.dispatchEvent(new MouseEvent('mouseenter')); });
    }

    // ── Hero coordinates scramble ──────────────────────────────────────
    (function() {
      const coords = document.querySelectorAll('.hero-coord-item');
      if (!coords.length) return;
      const digits = '0123456789';
      let done = false, frame = 0;
      function scrambleCoords() {
        if (done) return; frame++;
        coords.forEach((el, i) => {
          const labels = ['X','Y','Z'];
          el.textContent = frame > 18 + i * 6
            ? labels[i] + ':' + String(Math.floor(Math.random() * 9999)).padStart(4, '0')
            : labels[i] + ':' + Array.from({ length: 4 }, () => digits[Math.floor(Math.random() * 10)]).join('');
        });
        if (frame < 36) requestAnimationFrame(scrambleCoords);
        else { done = true; coords[0].textContent = 'X:5312'; coords[1].textContent = 'Y:2048'; coords[2].textContent = 'Z:0000'; }
      }
      setTimeout(scrambleCoords, 700);
      window.addEventListener('scroll', () => {
        if (!done) return;
        const pct = Math.round((window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight)) * 9999);
        coords[2].textContent = 'Z:' + String(pct).padStart(4, '0');
      }, { passive: true });
    })();

    // ── Nav scrolled + section indicator ──────────────────────────────
    const heroScrollEl = document.getElementById('hero-scroll');
    const buildOffsets = () => {
      this._sectionOffsets = this._SECTIONS.map(s => {
        const el = document.getElementById(s.id);
        return { label: s.label, top: el ? el.getBoundingClientRect().top + window.scrollY : 0 };
      });
    };
    setTimeout(buildOffsets, 300);
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (this._navEl) this._navEl.classList.toggle('scrolled', y > 40);
      if (heroScrollEl && y > 60) heroScrollEl.style.opacity = '0';
      if (this._secInd && this._sectionOffsets.length) {
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

  /** Called by AppController on every dispatched scroll — updates progress bar */
  onScroll(y) {
    if (!this._prog) return;
    const max = document.body.scrollHeight - window.innerHeight;
    this._prog.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
  }

  /**
   * Called by AppController._activateDirect whenever the active section changes.
   * Updates the section indicator label directly from the container key, bypassing
   * the scroll-position heuristic which is unreliable in a scroll-locked layout.
   * @param {string} sectionKey  e.g. 'hero' | 'carousel' | 'about' | 'contact'
   */
  notifySection(key) {
    if (!this._secInd) return;
    const labelMap = { hero: 'Hero', carousel: 'Projects', about: 'About', contact: 'Contact' };
    const label = labelMap[key];
    if (label) {
      this._secInd.textContent = label;
      this._secInd.classList.toggle('visible', key !== 'hero');
    }
  }

  _state() { return this._isDown ? 'click' : this._inLink ? 'link' : this._inProj ? 'proj' : 'default'; }
  _apply() {
    const s = this._STATES[this._state()];
    if (this._cur) { this._cur.style.width = `${s.dot}px`; this._cur.style.height = `${s.dot}px`; }
    this._ringTgt = s.ring;
    if (this._curR) this._curR.style.borderColor = s.ringColor;
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
    this._rotateTimer = null;
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
    if (this._nav) this._nav.classList.remove('scrolled');
    this._root.style.visibility = 'visible';
    this._root.style.transition = 'opacity 0.5s cubic-bezier(0.16,1,0.3,1)';
    this._root.style.opacity    = '1';
    requestAnimationFrame(() => this._revealHero());
  }

  exit() {
    if (!this._root) return;
    this._active = false;
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
    setTimeout(() => this._dismissHint(), 5000);

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
    if (this._hintDone) return;
    this._hintDone = true;
    this._modelHint?.classList.add('hidden');
  }

  _onRootWheel(e) {
    if (!this._active) return;
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    // Do NOT call this.onScroll() directly here — that would bypass
    // AppController's velocity threshold and fire setSection on every tick.
    // Instead let AppController's window wheel listener handle it.
    // stopPropagation() is removed so the event bubbles to AppController.
    // Note: we still call preventDefault() to stop browser scroll.
    // AppController's listener will dispatch the scroll when threshold is met.
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
      this._t0y = e.touches[0].clientY; this._t0x = e.touches[0].clientX;
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
    this._TRANS_MS      = 820;

    this._onResize = () => { this._sizeSpacer(); setTimeout(() => this._calcSpacerTop(), 200); };
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

    // Card tilt (element-level, not window)
    if (!window.matchMedia('(pointer:coarse)').matches) {
      this._projs.forEach(proj => {
        const img = proj.querySelector('.proj-img');
        if (!img) return;
        proj.addEventListener('mouseenter', () => { proj._r = proj.getBoundingClientRect(); });
        proj.addEventListener('mousemove',  e => {
          if (!proj._r) proj._r = proj.getBoundingClientRect();
          const nx = (e.clientX - proj._r.left) / proj._r.width  - 0.5;
          const ny = (e.clientY - proj._r.top)  / proj._r.height - 0.5;
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
    this._calcSpacerTop();
    this._root.style.visibility = 'visible';
    this._root.classList.add('carousel-active');
    if (this._dotsEl) this._dotsEl.style.opacity = '1';
    this._projs[this._activeIdx].dataset.pos = fromDirection === -1 ? 'prev' : 'next';
    requestAnimationFrame(() => requestAnimationFrame(() => this._setPositions(this._activeIdx, true)));
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
  }

  _advance(dir) {
    if (this._transitioning) return;
    const now = performance.now();
    if (dir === this._lastAdvDir && (now - this._lastAdvanceAt) < this._TRANS_MS) return;
    const next = this._activeIdx + dir;
    if (next < 0)        { this._app.setSection(this._prevKey, -1); return; }
    if (next >= this._N) { this._app.setSection(this._nextKey, +1); return; }
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
    this._N       = 0;
    this._active        = false;
    this._activeIdx     = 0;
    this._transitioning = false;
    this._lastAdvanceAt = 0;
    this._lastAdvDir    = 0;
    this._TRANS_MS      = 820;

    this._onResize = () => { this._sizeSpacer(); setTimeout(() => this._calcSpacerTop(), 200); };
  }

  init(root) {
    this._root   = root;
    this._spacer = document.querySelector('.about-spacer'); // documented exception

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
      this._contactTop = Math.round(this._root.getBoundingClientRect().top + window.scrollY);
    }
  }

  enter(fromDirection = 0) {
    if (!this._root) return;
    this._active = true;
    this._cacheTop();
    // Scroll to the top of the contact section (includes personal-statement above it).
    // Find the personal-statement section which sits just above contact — that's
    // the natural entry point when arriving from About.
    const psEl = document.getElementById('statement') || this._root;
    const top  = Math.round(psEl.getBoundingClientRect().top + window.scrollY);
    // Use instant scroll if we're jumping from a far section (hero/carousel)
    // to avoid a long slow scroll across the whole page.
    const dist = Math.abs(window.scrollY - top);
    window.scrollTo({ top, behavior: dist > window.innerHeight * 2 ? 'instant' : 'smooth' });
    // Re-cache after scroll settles (smooth scroll moves scrollY asynchronously)
    setTimeout(() => this._cacheTop(), 600);
  }

  exit() {
    if (!this._root) return;
    this._active = false;
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
    if (dir === -1) {
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
