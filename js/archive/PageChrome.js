/**
 * ═══════════════════════════════════════════════════════════════════════
 *  PageChrome
 *  ─────────────────────────────────────────────────────────────────────
 *  Owns the page-level ambient UI that belongs to no single section:
 *    • Progress bar  (#prog)
 *    • Custom cursor (#cur / #cur-r)
 *    • body.ready class
 *
 *  WHY THIS EXISTS
 *  ────────────────
 *  The original html/sections/portfolio-section.html mixed these into the carousel
 *  script block because it was a standalone page. In the container
 *  architecture they must live somewhere that is:
 *    — not inside any section container (they survive section changes)
 *    — not inside AppController (it is input-routing only)
 *  PageChrome is that somewhere.
 *
 *  It is the ONLY object besides AppController that may attach
 *  document-level listeners. It attaches exactly:
 *    document  mousemove, mousedown, mouseup, mouseleave, mouseenter
 *  It does NOT attach wheel, scroll, keydown, or touch listeners —
 *  those remain AppController's exclusive domain.
 *
 *  SCROLL POSITION
 *  ────────────────
 *  The progress bar needs the current scroll ratio. PageChrome exposes
 *  an onScroll(y) method. AppController calls it alongside the active
 *  container — it is NOT a window scroll listener.
 *
 *  CAROUSEL PROJ HOVER
 *  ─────────────────────
 *  CarouselContainer dispatches custom events 'carousel:proj-enter' and
 *  'carousel:proj-leave' (bubbling) when the pointer enters/leaves a
 *  project card. PageChrome listens for these on the document to update
 *  the cursor ring size — a clean one-way signal with no shared state.
 *
 *  USAGE
 *  ──────
 *    const chrome = new PageChrome();
 *    chrome.init();
 *    // In AppController._dispatchScroll, also call:
 *    chrome.onScroll(window.scrollY);
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

class PageChrome {

  constructor() {
    this._cur    = null;
    this._curR   = null;
    this._prog   = null;

    // Cursor tracking state
    this._mx     = window.innerWidth  / 2;
    this._my     = window.innerHeight / 2;
    this._rx     = this._mx;
    this._ry     = this._my;
    this._isDown = false;
    this._inLink = false;
    this._inProj = false;
    this._ringTgt = 42;
    this._ringCur = 42;

    this._STATES = {
      default: { dot: 8,  ring: 42,  ringColor: 'rgba(91,160,164,.32)' },
      link:    { dot: 5,  ring: 64,  ringColor: 'rgba(91,160,164,.6)'  },
      proj:    { dot: 4,  ring: 120, ringColor: 'rgba(91,160,164,.18)' },
      click:   { dot: 14, ring: 42,  ringColor: 'rgba(91,160,164,.5)'  },
    };
  }

  // ── Public API ────────────────────────────────────────────────────

  init() {
    this._cur  = document.getElementById('cur');
    this._curR = document.getElementById('cur-r');
    this._prog = document.getElementById('prog');

    // ── body.ready ────────────────────────────────────────────────────
    requestAnimationFrame(() => document.body.classList.add('ready'));

    // ── Cursor — document-level (intentional, documented above) ───────
    document.addEventListener('mousemove', e => {
      this._mx = e.clientX;
      this._my = e.clientY;
      if (this._cur) {
        this._cur.style.left = `${this._mx}px`;
        this._cur.style.top  = `${this._my}px`;
      }
    });

    document.addEventListener('mousedown',  () => { this._isDown = true;  this._applyCursor(); });
    document.addEventListener('mouseup',    () => { this._isDown = false; this._applyCursor(); });
    document.addEventListener('mouseleave', () => {
      if (this._cur)  this._cur.style.opacity  = '0';
      if (this._curR) this._curR.style.opacity = '0';
    });
    document.addEventListener('mouseenter', () => {
      if (this._cur)  this._cur.style.opacity  = '1';
      if (this._curR) this._curR.style.opacity = '1';
    });

    // Link hover — scoped querySelectorAll is fine here; PageChrome owns
    // all link/button cursor reactions across the full document.
    document.querySelectorAll('a, button').forEach(el => {
      el.addEventListener('mouseenter', () => { this._inLink = true;  this._applyCursor(); });
      el.addEventListener('mouseleave', () => { this._inLink = false; this._applyCursor(); });
    });

    // Carousel project card hover — via custom events from CarouselContainer.
    // No direct dependency on CarouselContainer's DOM.
    document.addEventListener('carousel:proj-enter', () => { this._inProj = true;  this._applyCursor(); });
    document.addEventListener('carousel:proj-leave', () => { this._inProj = false; this._applyCursor(); });

    // ── Cursor ring RAF loop ───────────────────────────────────────────
    if (window.matchMedia('(pointer:fine)').matches) {
      const loop = () => {
        const rxN = this._rx + (this._mx - this._rx) * 0.1;
        const ryN = this._ry + (this._my - this._ry) * 0.1;
        const rN  = this._ringCur + (this._ringTgt - this._ringCur) * 0.12;
        if (
          Math.abs(rxN - this._rx) > 0.02 ||
          Math.abs(ryN - this._ry) > 0.02 ||
          Math.abs(rN  - this._ringCur) > 0.05
        ) {
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

    this._applyCursor();
  }

  /**
   * Update the progress bar. Called by AppController alongside
   * _dispatchScroll — NOT via a window scroll listener.
   * @param {number} y  current scroll position in px
   */
  onScroll(y) {
    if (!this._prog) return;
    const max = document.body.scrollHeight - window.innerHeight;
    this._prog.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
  }

  // ── Private ───────────────────────────────────────────────────────

  _curState() {
    return this._isDown ? 'click'
         : this._inLink ? 'link'
         : this._inProj ? 'proj'
         : 'default';
  }

  _applyCursor() {
    const s = this._STATES[this._curState()];
    if (this._cur) {
      this._cur.style.width  = `${s.dot}px`;
      this._cur.style.height = `${s.dot}px`;
    }
    this._ringTgt = s.ring;
    if (this._curR) this._curR.style.borderColor = s.ringColor;
  }
}
