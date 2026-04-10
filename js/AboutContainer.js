/**
 * ═══════════════════════════════════════════════════════════════════════
 *  AboutContainer  —  REFACTORED: Scroll-driven sticky storytelling
 *  ─────────────────────────────────────────────────────────────────────
 *
 *  WHAT CHANGED
 *  ─────────────
 *  FROM: Scroll-locked slideshow
 *    • Hijacked wheel/touch events via AppController's +1/-1 dispatch
 *    • Managed an internal advance() engine with transition locks
 *    • Relied on a sibling .about-spacer to fake scroll height
 *    • Called this._app.setSection() to hand scroll control back
 *
 *  TO: Passive scroll-driven sticky viewport
 *    • The root element itself becomes a tall scroll container
 *      (height = N × 100vh via --about-scroll-height CSS custom property)
 *    • A `.panels-host` child is `position: sticky; top: 0` — it stays
 *      in the viewport the entire time the user scrolls through the root
 *    • Scroll progress within the root is mapped to panel index via an
 *      IntersectionObserver on per-step sentinel <div>s injected once
 *      during init() — no polling, no RAF loops, no global listeners
 *    • `onScroll(direction)` is kept (required interface) but does nothing
 *      while the section is active — native scroll drives everything
 *    • `enter()` / `exit()` show/hide the root and reset state
 *
 *  STICKY STRUCTURE (injected into existing DOM)
 *  ──────────────────────────────────────────────
 *
 *  #about-stage  ← root (becomes tall: height = N × 100vh)
 *  └─ .panels-host  ← sticky viewport (position:sticky; top:0; height:100vh)
 *     ├─ .panel[data-panel="0"]  ← panels already exist, unchanged
 *     ├─ .panel[data-panel="1"]
 *     └─ ...
 *  └─ .about-sentinels  ← injected; N invisible <div>s, each 100vh tall
 *     ├─ .about-sentinel (data-step="0")
 *     ├─ .about-sentinel (data-step="1")
 *     └─ ...
 *
 *  HOW SCROLL DRIVES ANIMATIONS
 *  ──────────────────────────────
 *  1. The root's height is set to N × 100vh so the browser has scroll
 *     distance proportional to the number of panels.
 *
 *  2. N sentinel divs (height: 100vh each) are stacked after panels-host
 *     inside the root. As the user scrolls, each sentinel crosses the
 *     50% vertical threshold of the viewport.
 *
 *  3. An IntersectionObserver (root = this._root, threshold = 0.5)
 *     fires when a sentinel enters/exits. The intersecting sentinel's
 *     data-step maps directly to a panel index → _setPanel(idx) is
 *     called with the existing class-toggle logic (is-active, is-after).
 *
 *  4. All visual transitions (fade, slide, per-word reveal) are already
 *     CSS-driven off .panel.is-active — no animation code changes needed.
 *
 *  ISOLATION CONTRACT (unchanged from original)
 *  ─────────────────────────────────────────────
 *  ✓ All DOM queries scoped to this._root
 *  ✓ No window / document event listeners
 *  ✓ No shared global flags
 *  ✓ No scroll locking or preventDefault
 *  ✓ No wheel/touch listeners
 *  ✓ IntersectionObserver root = this._root (not the viewport)
 *
 *  NOTED EXCEPTION
 *  ────────────────
 *  window.addEventListener('resize', …) for recalculating root height.
 *  This is the same exception the original made and is the minimum
 *  necessary — a passive listener that only writes one CSS custom property.
 *
 *  REQUIRED INTERFACE (fully preserved)
 *  ───────────────────────────────────────
 *    init(rootElement)   — wire DOM, inject sentinels, start observer
 *    enter()             — show root, reset to panel 0, start observing
 *    exit()              — hide root, disconnect observer
 *    onScroll(direction) — guard-only no-op while active (native scroll wins)
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

class AboutContainer {

  /**
   * @param {AppController} appController
   * @param {string} nextSection  — unused in sticky mode (no section hand-off
   *                               needed; user scrolls naturally past the section)
   * @param {string} prevSection  — section to activate when scrolling back above
   *                               the root (handled by AppController if desired)
   */
  constructor(appController, nextSection = null, prevSection = 'carousel') {
    this._app     = appController;
    this._nextKey = nextSection;   // retained for API compatibility
    this._prevKey = prevSection;   // retained for API compatibility

    // ── DOM refs (all populated in init) ──────────────────────────────
    this._root      = null;   // #about-stage
    this._host      = null;   // .panels-host (sticky child)
    this._panels    = [];     // [data-panel] articles
    this._dots      = [];     // .prog-dot elements
    this._hint      = null;   // #about-scroll-hint
    this._sentinels = [];     // injected .about-sentinel divs
    this._N         = 0;

    // ── State ──────────────────────────────────────────────────────────
    this._active    = false;
    this._activeIdx = 0;

    // ── Observer (created once in init, connected/disconnected in enter/exit)
    this._observer  = null;

    // ── Resize handler (single passive window listener — documented exception)
    this._onResize  = () => this._setRootHeight();
  }

  // ════════════════════════════════════════════════════════════════════
  //  REQUIRED INTERFACE
  // ════════════════════════════════════════════════════════════════════

  init(root) {
    this._root = root;

    // ── Cache scoped DOM refs ──────────────────────────────────────────
    this._host   = root.querySelector('.panels-host');
    this._panels = Array.from(root.querySelectorAll('[data-panel]'));
    this._dots   = Array.from(root.querySelectorAll('.prog-dot'));
    this._hint   = root.querySelector('#about-scroll-hint');
    this._N      = this._panels.length;

    if (!this._host || !this._N) {
      console.warn('[AboutContainer] Missing .panels-host or panels — init aborted.');
      return;
    }

    // ── 1. Make root a tall scroll container ───────────────────────────
    // The root is already `position:fixed` in the original CSS. For the
    // sticky model it must become a normal in-flow element whose height
    // creates scroll distance. We override only what's needed.
    this._applyRootScrollStyles();
    this._setRootHeight();
    window.addEventListener('resize', this._onResize, { passive: true });

    // ── 2. Make panels-host sticky inside the root ─────────────────────
    // panels-host already has `position:relative; width:100%; height:100%`
    // We augment it to be sticky so it pins while sentinels scroll past.
    this._applyStickyHostStyles();

    // ── 3. Inject sentinel strip after panels-host ─────────────────────
    // N invisible divs, each 100vh tall. The IntersectionObserver watches
    // these — when a sentinel crosses the 50% midpoint, its data-step
    // index becomes the active panel.
    this._injectSentinels();

    // ── 4. Build IntersectionObserver ─────────────────────────────────
    // root = this._root constrains observation to scrolling within the
    // about section, not the whole viewport — fully isolated.
    this._observer = new IntersectionObserver(
      entries => this._onSentinelIntersect(entries),
      {
        root:       this._root,
        rootMargin: '0px',
        threshold:  0.5,   // fire when sentinel is half-visible in root
      }
    );

    // ── 5. Initial panel state (no animation on load) ──────────────────
    this._setPanel(0);

    // ── 6. Start hidden (observer not yet connected) ───────────────────
    this._root.classList.remove('engaged');
  }

  enter() {
    if (!this._root || !this._N) return;
    this._active = true;

    // Reset to top of section + first panel
    this._root.scrollTop = 0;
    this._setPanel(0);
    this._root.classList.add('engaged');

    // Connect observer — only active while section is showing
    if (this._observer) {
      this._sentinels.forEach(s => this._observer.observe(s));
    }
  }

  exit() {
    if (!this._root) return;
    this._active = false;

    this._root.classList.remove('engaged');

    // Disconnect observer when section is not visible — zero wasted checks
    if (this._observer) {
      this._sentinels.forEach(s => this._observer.unobserve(s));
    }
  }

  /**
   * Called by AppController on wheel/key/touch events.
   *
   * In sticky mode, native scroll drives everything — we do NOT advance
   * panels here. This method is intentionally a guard-only no-op while
   * active. It is kept to satisfy the required container interface.
   *
   * @param {number} direction  +1 | -1  (ignored while active)
   */
  onScroll(direction) {
    if (!this._active) return;
    // Native scroll drives panel changes via IntersectionObserver.
    // AppController still calls us — we simply do nothing.
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — DOM setup
  // ════════════════════════════════════════════════════════════════════

  /**
   * Convert the fixed root into a scrollable in-flow container.
   *
   * Original CSS: position:fixed; inset:0; visibility:hidden
   * We must override position and add overflow:auto so the root scrolls
   * internally. The sentinel divs scroll inside it; panels-host sticks.
   *
   * Visibility toggling is preserved via .engaged (original CSS rule kept).
   */
  _applyRootScrollStyles() {
    const s = this._root.style;
    s.position   = 'relative';   // in-flow, not fixed
    s.inset      = 'auto';       // clear the fixed inset
    s.overflow   = 'auto';       // allow internal scroll
    s.height     = '100vh';      // clamp visible window to one screen height
    s.maxHeight  = '100vh';
    s.visibility = 'visible';    // override original hidden; .engaged handles opacity
  }

  /**
   * Set root height = N panels × viewport height.
   * This gives the browser the scroll distance needed for N full panels.
   * Called on init and on every resize.
   */
  _setRootHeight() {
    // scrollHeight of the root must accommodate:
    //   • panels-host: 100vh (sticky, doesn't add scroll distance)
    //   • N sentinel divs: N × 100vh each
    // Total height = (N + 1) × 100vh ensures last sentinel fully scrolls in.
    this._root.style.height = `${(this._N + 1) * window.innerHeight}px`;
  }

  /**
   * Make panels-host sticky so it pins while sentinels scroll beneath it.
   *
   * `position:sticky; top:0; height:100vh` keeps the visual stage
   * stationary. The sentinel strip below it provides scroll distance.
   */
  _applyStickyHostStyles() {
    const s = this._host.style;
    s.position = 'sticky';
    s.top      = '0';
    s.height   = '100vh';
    s.overflow = 'hidden';   // panels clip correctly within the sticky host
    s.zIndex   = '1';
  }

  /**
   * Inject N sentinel <div>s after panels-host inside the root.
   *
   * Each sentinel is 100vh tall and invisible. They stack vertically
   * below the sticky host, creating the scroll distance that moves
   * them past the IntersectionObserver's midpoint threshold.
   *
   * Sentinel layout inside the root:
   *   [panels-host — sticky, 100vh] ← always visible
   *   [sentinel-0  — 100vh        ] ← scrolls into/out-of root viewport
   *   [sentinel-1  — 100vh        ]
   *   [sentinel-N-1— 100vh        ]
   */
  _injectSentinels() {
    // Wrapper to keep root DOM tidy
    const strip = document.createElement('div');
    strip.className        = 'about-sentinels';
    strip.style.cssText    = 'position:relative; pointer-events:none;';
    strip.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < this._N; i++) {
      const s = document.createElement('div');
      s.className          = 'about-sentinel';
      s.dataset.step       = String(i);
      // Each sentinel is exactly one viewport height tall so only one
      // sentinel can be "half visible" at a time → clean 1:1 step mapping.
      s.style.cssText      = 'height:100vh; width:100%; pointer-events:none;';
      strip.appendChild(s);
      this._sentinels.push(s);
    }

    this._root.appendChild(strip);
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — Intersection callback
  // ════════════════════════════════════════════════════════════════════

  /**
   * Fired by IntersectionObserver when sentinels cross the 50% threshold.
   *
   * Logic: find the highest-index sentinel that is currently intersecting.
   * This correctly handles fast scrolls (multiple entries in one batch)
   * and gives us the "furthest along" step the user has reached.
   *
   * @param {IntersectionObserverEntry[]} entries
   */
  _onSentinelIntersect(entries) {
    if (!this._active) return;

    // Collect all currently-intersecting step indices
    let highestVisible = -1;

    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const step = parseInt(entry.target.dataset.step, 10);
        if (step > highestVisible) highestVisible = step;
      }
    });

    // Also check all sentinels to handle the case where no entry fired
    // (e.g. on enter() when root.scrollTop = 0 → sentinel-0 is visible)
    if (highestVisible === -1) {
      this._sentinels.forEach(s => {
        const rect = s.getBoundingClientRect();
        const rootRect = this._root.getBoundingClientRect();
        // Is sentinel at least 50% within the root's visible area?
        const sentinelTop    = rect.top    - rootRect.top;
        const sentinelBottom = rect.bottom - rootRect.top;
        const rootHeight     = rootRect.height;
        const visible = Math.max(0, Math.min(sentinelBottom, rootHeight) - Math.max(sentinelTop, 0));
        if (visible / rect.height >= 0.5) {
          const step = parseInt(s.dataset.step, 10);
          if (step > highestVisible) highestVisible = step;
        }
      });
    }

    if (highestVisible !== -1 && highestVisible !== this._activeIdx) {
      this._setPanel(highestVisible);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRIVATE — Panel state (verbatim from original)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Activates a panel by index.
   * Updates is-active / is-after classes, dot indicators, and scroll hint.
   *
   * Logic is verbatim from the original _setPanel — CSS transitions
   * on .panel.is-active / .panel.is-after / .panel.is-below continue
   * to drive all visual animation without any changes.
   *
   * @param {number} idx  0-based panel index
   */
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
}
