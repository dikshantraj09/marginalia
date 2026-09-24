// A small in-page modal used in place of window.prompt()/confirm(). Native
// browser dialogs are unreliable here — a sandboxed iframe (e.g. how the
// published artifact version of this app is hosted) silently blocks them,
// so prompt() returns null and confirm() returns false with no dialog ever
// shown, which looked like "delete and create both silently do nothing."
// This works identically everywhere since it's just DOM, no browser API.

let overlayEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay';
  overlayEl.innerHTML =
    '<div class="modal-box" role="dialog" aria-modal="true">' +
    '<div class="modal-message"></div>' +
    '<input class="modal-input" type="text" />' +
    '<div class="modal-actions">' +
    '<button type="button" class="modal-cancel">Cancel</button>' +
    '<button type="button" class="modal-ok">OK</button>' +
    '</div></div>';
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function openModal({ message, showInput, defaultValue, okLabel, danger }) {
  return new Promise((resolve) => {
    const el = ensureOverlay();
    el.querySelector('.modal-message').textContent = message;
    const input = el.querySelector('.modal-input');
    const okBtn = el.querySelector('.modal-ok');
    const cancelBtn = el.querySelector('.modal-cancel');

    input.style.display = showInput ? 'block' : 'none';
    input.value = showInput ? (defaultValue || '') : '';
    okBtn.textContent = okLabel || 'OK';
    okBtn.classList.toggle('danger', !!danger);
    el.classList.add('open');
    if (showInput) setTimeout(() => { input.focus(); input.select(); }, 20);
    else okBtn.focus();

    function cleanup(result) {
      el.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      el.removeEventListener('click', onOverlayClick);
      resolve(result);
    }
    function onOk() { cleanup(showInput ? (input.value.trim() || null) : true); }
    function onCancel() { cleanup(showInput ? null : false); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }
    function onOverlayClick(e) { if (e.target === el) onCancel(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    el.addEventListener('click', onOverlayClick);
  });
}

// Resolves to the trimmed string, or null if cancelled / left empty.
export function showPrompt(message, defaultValue) {
  return openModal({ message, showInput: true, defaultValue, okLabel: 'Create' });
}

// Resolves to true/false.
export function showConfirm(message, okLabel) {
  return openModal({ message, showInput: false, okLabel: okLabel || 'Delete', danger: true });
}

// A plain acknowledgement dialog — same reasoning as the rest of this file
// (window.alert() is just as unreliable in a sandboxed artifact iframe as
// prompt()/confirm() are). Resolves once dismissed; nothing to read back.
export function showAlert(message, okLabel) {
  return openModal({ message, showInput: false, okLabel: okLabel || 'OK', danger: false });
}
