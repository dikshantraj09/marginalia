// First-run "welcome" walkthrough, replayable anytime from the ? button in
// the topbar. Follows the same reasoning as modal.js: everything is built
// by hand as plain DOM rather than a native <dialog>/alert, because native
// dialogs are unreliable inside a sandboxed artifact iframe (the published
// Claude Artifact build of this app).
//
// A step either targets a real element (spotlighted, with a tooltip placed
// next to it) or has no target (a centered welcome/closing card). The whole
// sequence — welcome, guided steps, closing card — is driven by the same
// stepper so there's one code path instead of a separate "modal" for the
// bookends.

const STORAGE_KEY = 'marginalia-tour-seen';
const PHONE_QUERY = window.matchMedia('(max-width: 640px)');

export default class Tour {
  // steps: [{ target?: string (element id), title, body, before?, after? }]
  //   before(): called just before this step renders — use it to make a
  //     collapsed/hidden panel visible so the spotlight has something real
  //     to point at (e.g. temporarily expanding the notes pane).
  //   after(): called when leaving this step (Back, Next, Skip, or Escape)
  //     — use it to restore whatever before() changed.
  constructor(steps) {
    this.steps = steps;
    this.index = -1;
    this.overlayEl = null;
    this.spotlightEl = null;
    this.dimEl = null;
    this.tooltipEl = null;
    this._onResize = () => { if (this.index >= 0) this._renderStep(); };
    this._onKey = (e) => {
      if (this.index < 0) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
    };
  }

  // Call once at boot. Auto-starts only the very first time the app is
  // opened in this browser; silent no-op every time after.
  maybeAutoStart() {
    let seen = null;
    try { seen = localStorage.getItem(STORAGE_KEY); } catch (err) { /* ignore */ }
    if (!seen) this.start();
  }

  start() {
    this._markSeen();
    this.index = 0;
    this._ensureChrome();
    window.addEventListener('resize', this._onResize);
    document.addEventListener('keydown', this._onKey);
    this._renderStep();
  }

  next() {
    this._runAfter(this.index);
    if (this.index >= this.steps.length - 1) { this.close(); return; }
    this.index += 1;
    this._renderStep();
  }

  back() {
    if (this.index <= 0) return;
    this._runAfter(this.index);
    this.index -= 1;
    this._renderStep();
  }

  close() {
    if (this.index >= 0) this._runAfter(this.index);
    this.index = -1;
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('keydown', this._onKey);
    if (this.overlayEl) this.overlayEl.classList.remove('open');
  }

  _markSeen() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (err) { /* ignore */ }
  }

  _runAfter(index) {
    const step = this.steps[index];
    if (step && typeof step.after === 'function') {
      try { step.after(); } catch (err) { /* ignore */ }
    }
  }

  _ensureChrome() {
    if (this.overlayEl) return;
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';

    const dim = document.createElement('div');
    dim.className = 'tour-dim';
    overlay.appendChild(dim);

    const spotlight = document.createElement('div');
    spotlight.className = 'tour-spotlight';
    overlay.appendChild(spotlight);

    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    tooltip.innerHTML =
      '<button type="button" class="tour-close" aria-label="Close tour">✕</button>' +
      '<div class="tour-eyebrow"></div>' +
      '<h3 class="tour-title"></h3>' +
      '<p class="tour-body"></p>' +
      '<div class="tour-dots"></div>' +
      '<div class="tour-actions">' +
      '<button type="button" class="tour-back">Back</button>' +
      '<button type="button" class="tour-skip">Skip</button>' +
      '<button type="button" class="tour-next">Next</button>' +
      '</div>';
    overlay.appendChild(tooltip);

    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.dimEl = dim;
    this.spotlightEl = spotlight;
    this.tooltipEl = tooltip;

    tooltip.querySelector('.tour-close').addEventListener('click', () => this.close());
    tooltip.querySelector('.tour-skip').addEventListener('click', () => this.close());
    tooltip.querySelector('.tour-back').addEventListener('click', () => this.back());
    tooltip.querySelector('.tour-next').addEventListener('click', () => this.next());
  }

  _renderStep() {
    const step = this.steps[this.index];
    if (!step) return;
    if (typeof step.before === 'function') {
      try { step.before(); } catch (err) { /* ignore */ }
    }

    this.overlayEl.classList.add('open');
    const isPhone = PHONE_QUERY.matches;
    const isFirst = this.index === 0;
    const isLast = this.index === this.steps.length - 1;
    const target = step.target ? document.getElementById(step.target) : null;

    // Content
    this.tooltipEl.querySelector('.tour-eyebrow').textContent =
      isFirst || isLast ? '' : `Step ${this.index} of ${this.steps.length - 2}`;
    this.tooltipEl.querySelector('.tour-title').textContent = step.title;
    // body may be a string or a function — a function lets a step's copy
    // reflect layout state (e.g. phone vs. desktop) at the moment it's
    // actually shown, rather than whatever it was when the tour was built.
    this.tooltipEl.querySelector('.tour-body').textContent =
      typeof step.body === 'function' ? step.body() : step.body;
    this.tooltipEl.querySelector('.tour-back').style.visibility = isFirst ? 'hidden' : 'visible';
    this.tooltipEl.querySelector('.tour-skip').style.display = isLast ? 'none' : 'inline-block';
    this.tooltipEl.querySelector('.tour-next').textContent = isFirst ? 'Start tour' : (isLast ? 'Got it' : 'Next');

    // Progress dots — one per guided step, skipping the welcome/closing
    // bookends since those aren't really "step N of M" to a person reading.
    const dotsEl = this.tooltipEl.querySelector('.tour-dots');
    dotsEl.innerHTML = '';
    if (!isFirst && !isLast) {
      for (let i = 1; i < this.steps.length - 1; i++) {
        const dot = document.createElement('span');
        dot.className = 'tour-dot' + (i === this.index ? ' active' : '');
        dotsEl.appendChild(dot);
      }
      dotsEl.style.display = 'flex';
    } else {
      dotsEl.style.display = 'none';
    }

    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'center' });
      // Let scrollIntoView finish before measuring — it can be async-ish in
      // some browsers even without smooth-scroll behavior.
      requestAnimationFrame(() => this._positionAround(target, isPhone));
      this.dimEl.style.display = 'none';
      this.spotlightEl.style.display = 'block';
    } else {
      this.dimEl.style.display = 'block';
      this.spotlightEl.style.display = 'none';
      this.tooltipEl.classList.remove('sheet');
      this.tooltipEl.classList.add('center');
      this.tooltipEl.style.top = '';
      this.tooltipEl.style.left = '';
    }
  }

  _positionAround(target, isPhone) {
    const rect = target.getBoundingClientRect();
    const pad = 6;
    this.spotlightEl.style.left = (rect.left - pad) + 'px';
    this.spotlightEl.style.top = (rect.top - pad) + 'px';
    this.spotlightEl.style.width = (rect.width + pad * 2) + 'px';
    this.spotlightEl.style.height = (rect.height + pad * 2) + 'px';

    this.tooltipEl.classList.remove('center');

    if (isPhone) {
      // The rail drawer / stacked panes can occupy nearly the full screen
      // on a phone, leaving no reliable open space next to the target to
      // anchor a floating tooltip. A fixed bottom sheet is simpler and
      // more robust than placement math against a target that may fill
      // the whole viewport.
      this.tooltipEl.classList.add('sheet');
      this.tooltipEl.style.top = '';
      this.tooltipEl.style.left = '';
      return;
    }

    this.tooltipEl.classList.remove('sheet');
    // Measure the tooltip itself (it's already in the DOM, just position
    // 0,0 by default) so placement can account for its real size.
    const tw = this.tooltipEl.offsetWidth || 320;
    const th = this.tooltipEl.offsetHeight || 160;
    const margin = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const spaceRight = vw - rect.right;
    const spaceLeft = rect.left;

    let top, left;
    if (spaceBelow >= th + margin) {
      top = rect.bottom + margin;
      left = clamp(rect.left + rect.width / 2 - tw / 2, margin, vw - tw - margin);
    } else if (spaceAbove >= th + margin) {
      top = rect.top - th - margin;
      left = clamp(rect.left + rect.width / 2 - tw / 2, margin, vw - tw - margin);
    } else if (spaceRight >= tw + margin) {
      left = rect.right + margin;
      top = clamp(rect.top + rect.height / 2 - th / 2, margin, vh - th - margin);
    } else if (spaceLeft >= tw + margin) {
      left = rect.left - tw - margin;
      top = clamp(rect.top + rect.height / 2 - th / 2, margin, vh - th - margin);
    } else {
      // Nowhere clean fits (a very cramped window) — fall back to a
      // centered card, same as the welcome/closing steps.
      this.tooltipEl.classList.add('center');
      this.tooltipEl.style.top = '';
      this.tooltipEl.style.left = '';
      return;
    }
    this.tooltipEl.style.top = Math.round(top) + 'px';
    this.tooltipEl.style.left = Math.round(left) + 'px';
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
