// A one-line "thanks, and here's the coffee jar" note, shown only after
// Marginalia has clearly been useful to someone: the first time they copy
// their notes for AI or export them, or once a canvas grows to 10 cards.
// Never in the first session, at most once a week, and gone for good after
// "Don't show again" or a click on the coffee button. Everything lives in
// localStorage; nothing is sent anywhere. If storage isn't available (a
// sandboxed iframe, private mode), the note simply never appears.

const STORAGE_KEY = 'marginalia-thanks';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COFFEE_URL = 'https://buymeacoffee.com/dikshantraj09';

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return null;
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    return false;
  }
}

export default class ThanksNote {
  // isBusy(): return true while something else owns the screen (the tour,
  // a modal), so the note waits for the next trigger instead.
  constructor({ isBusy = () => false } = {}) {
    this.isBusy = isBusy;
    this.el = null;
    this.pending = null;
    // Recorded on the very first page load. That load (the whole session)
    // never shows the note; a later page load or 24h later can.
    const state = readState();
    this.storageOk = state !== null && writeState(state);
    this.firstSession = false;
    if (this.storageOk && !state.firstSeen) {
      state.firstSeen = Date.now();
      writeState(state);
      this.firstSession = true;
    }
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.el && !e.defaultPrevented) this.hide();
    };
  }

  _eligible() {
    if (!this.storageOk || this.el) return false;
    const state = readState();
    if (!state || state.off) return false;
    const now = Date.now();
    if (this.firstSession && now - (state.firstSeen || now) < DAY_MS) return false;
    if (state.lastShown && now - state.lastShown < WEEK_MS) return false;
    return true;
  }

  // Call after a successful copy/export (or when the canvas reaches 10
  // cards). A short delay lets the button's own "Copied" feedback land first.
  maybeShow() {
    if (!this._eligible() || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      if (!this._eligible() || this.isBusy()) return;
      this._show();
    }, 1200);
  }

  _show() {
    const state = readState();
    state.lastShown = Date.now();
    writeState(state);

    const el = document.createElement('div');
    el.className = 'thanks-note';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<p class="thanks-note-msg">Glad Marginalia helped ☕ It’s free and ad-free. If you’d like to keep it that way:</p>' +
      '<div class="thanks-note-actions">' +
        '<a class="thanks-note-coffee" target="_blank" rel="noopener">Buy me a coffee</a>' +
        '<button type="button" class="thanks-note-later">Not now</button>' +
        '<button type="button" class="thanks-note-never">Don’t show again</button>' +
      '</div>';
    const coffee = el.querySelector('.thanks-note-coffee');
    coffee.href = COFFEE_URL;
    coffee.addEventListener('click', () => this._turnOff());
    el.querySelector('.thanks-note-later').addEventListener('click', () => this.hide());
    el.querySelector('.thanks-note-never').addEventListener('click', () => this._turnOff());
    document.body.appendChild(el);
    this.el = el;
    document.addEventListener('keydown', this._onKey);
    requestAnimationFrame(() => el.classList.add('open'));
  }

  _turnOff() {
    const state = readState() || {};
    state.off = true;
    writeState(state);
    this.hide();
  }

  hide() {
    const el = this.el;
    if (!el) return;
    this.el = null;
    document.removeEventListener('keydown', this._onKey);
    el.classList.remove('open');
    setTimeout(() => el.remove(), 200);
  }
}
