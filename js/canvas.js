// The freeform notes canvas: excerpt cards (with your own notes attached),
// dragging, linking cards with threads, and click-to-jump back to the source page.
//
// The canvas is infinite in every direction rather than a large-but-fixed
// scrollable area: cards live in unbounded "world" coordinates (including
// negative), and `.canvas-inner` is positioned purely with a CSS
// `translate(panX, panY)` that this file drives directly — there's no
// native scrolling involved, so there's nothing to hit a scroll-range edge
// against. Dragging empty canvas background pans the view; dragging a card
// moves the card. The dotted background pans in lockstep (via
// background-position) so it always reads as one continuous plane.

function truncateName(name) {
  const base = name.replace(/\.pdf$/i, '');
  return base.length > 22 ? base.slice(0, 22) + '…' : base;
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MARGIN = 40; // world-space padding used when framing cards on open

export default class NotesCanvas {
  constructor(canvasEl, innerEl, svgGroupEl, emptyEl, callbacks) {
    this.canvasEl = canvasEl;
    this.inner = innerEl;
    this.svgGroup = svgGroupEl;
    this.emptyEl = emptyEl;
    this.cb = callbacks || {};
    this.cards = [];
    this.links = [];
    this.cardEls = new Map();
    this.canvasId = null;
    this._saveTimers = new Map();
    this.pan = { x: 0, y: 0 };
    this._wirePanning();
  }

  setCanvas(canvasId, cards, links) {
    this.canvasId = canvasId;
    this.cards = cards || [];
    this.links = links || [];
    this._frameCards();
    this._renderAll();
  }

  // Positions the view so whatever's already on the canvas is visible when
  // it's opened — there's no scrollbar to land somewhere sensible on its
  // own now that panning is transform-driven, so this does that job once
  // up front. An empty canvas just starts at the origin.
  _frameCards() {
    if (!this.cards.length) { this._setPan(0, 0); return; }
    let minX = Infinity, minY = Infinity;
    for (const c of this.cards) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
    this._setPan(-minX + MARGIN, -minY + MARGIN);
  }

  _setPan(x, y) {
    this.pan.x = x;
    this.pan.y = y;
    this.inner.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    // Keeps the dotted background (painted on the viewport, not the
    // panned layer) moving in lockstep so it still reads as one
    // continuous plane instead of a patch that stays put while content
    // slides under it.
    this.canvasEl.style.backgroundPosition = x + 'px ' + y + 'px';
  }

  // Drag on empty canvas background (not a card, not a link thread) pans
  // the view. Mirrors the PDF reading pane's own marquee gesture handling,
  // including treating a browser-issued pointercancel the same as a normal
  // pointerup so an in-progress pan still lands wherever it had gotten to
  // rather than silently doing nothing.
  _wirePanning() {
    let dragging = false, startX, startY, startPanX, startPanY;

    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.card')) return; // card's own handler owns this gesture
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startPanX = this.pan.x; startPanY = this.pan.y;
      this.canvasEl.classList.add('panning');
      try { this.canvasEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    const onMove = (e) => {
      if (!dragging) return;
      this._setPan(startPanX + (e.clientX - startX), startPanY + (e.clientY - startY));
    };
    const onUp = () => {
      dragging = false;
      this.canvasEl.classList.remove('panning');
    };

    this.canvasEl.addEventListener('pointerdown', onDown);
    this.canvasEl.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  _renderAll() {
    this.inner.querySelectorAll('.card').forEach((n) => n.remove());
    this.cardEls.clear();
    this.cards.forEach((c) => this._renderCard(c));
    this._drawLinks();
    this._updateEmptyState();
  }

  _updateEmptyState() {
    this.emptyEl.style.display = this.cards.length ? 'none' : 'block';
  }

  addExcerptCard({ docId, docName, page, rects, text }) {
    const pos = this._claimPosition();
    const card = {
      id: 'card_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      canvasId: this.canvasId,
      docId,
      docName,
      page,
      rects,
      excerpt: text.length > 220 ? text.slice(0, 220) + '…' : text,
      note: '',
      x: pos.x,
      y: pos.y,
    };
    this.cards.push(card);
    this._renderCard(card);
    this._updateEmptyState();
    if (this.cb.onCardAdded) this.cb.onCardAdded(card);
    return card;
  }

  // Lay new cards out in a simple grid, wide and tall enough that a card
  // with a couple of lines of note text won't overlap its neighbors. This
  // is only a starting position — the point of a freeform canvas is that
  // the user can drag from here.
  _claimPosition() {
    const COLS = 5, COL_W = 240, ROW_H = 190;
    const index = this.cards.length;
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    return { x: MARGIN + col * COL_W, y: MARGIN + row * ROW_H };
  }

  _renderCard(c) {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.left = c.x + 'px';
    el.style.top = c.y + 'px';
    el.dataset.id = c.id;

    const quote = document.createElement('div');
    quote.className = 'card-quote';
    quote.textContent = '“' + c.excerpt + '”';

    const note = document.createElement('div');
    note.className = 'card-note';
    note.contentEditable = 'true';
    note.dataset.placeholder = 'Add your thoughts…';
    note.textContent = c.note || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const sourceLabel = (c.docName ? truncateName(c.docName) + ' · ' : '') + 'p.' + c.page;
    meta.innerHTML =
      '<span class="page-tag" title="' + escapeAttr(c.docName || '') + ', page ' + c.page + '">' + escapeAttr(sourceLabel) + '</span>' +
      '<span class="card-actions"><span class="del" title="Remove">✕</span><span class="link-nub" title="Drag to link"></span></span>';

    el.appendChild(quote);
    el.appendChild(note);
    el.appendChild(meta);
    this.inner.appendChild(el);
    this.cardEls.set(c.id, el);

    this._wireCard(el, c, note, meta.querySelector('.link-nub'), meta.querySelector('.del'));
  }

  _wireCard(el, c, noteEl, nub, delBtn) {
    let dragging = false, moved = false, startX, startY, origX, origY;

    el.addEventListener('pointerdown', (e) => {
      if (e.target === nub) { this._startLink(c, e); return; }
      if (e.target === delBtn) return;
      if (e.target === noteEl || noteEl.contains(e.target)) return; // let editing work normally
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      origX = c.x; origY = c.y;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore — synthetic/edge pointer events */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      // No lower bound — the canvas is infinite in every direction, so a
      // card is free to move into negative world coordinates too.
      c.x = origX + dx;
      c.y = origY + dy;
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
      this._drawLinks();
    });
    el.addEventListener('pointerup', () => {
      if (dragging && !moved) {
        if (this.cb.onCardClick) this.cb.onCardClick(c);
      }
      if (dragging && moved) this._persistCard(c);
      dragging = false;
    });

    delBtn.addEventListener('click', () => this._removeCard(c));

    noteEl.addEventListener('input', () => {
      c.note = noteEl.textContent;
      clearTimeout(this._saveTimers.get(c.id));
      this._saveTimers.set(c.id, setTimeout(() => this._persistCard(c), 400));
    });
  }

  // Called after a source PDF is deleted elsewhere — drop any cards pulled
  // from it (their DB records are already gone; this just syncs the view).
  removeCardsByDoc(docId) {
    const toRemove = this.cards.filter((c) => c.docId === docId);
    toRemove.forEach((c) => this._removeCard(c, { alreadyPersisted: true }));
  }

  // Called after a source PDF is renamed elsewhere — keep the "p.N" labels
  // showing the current name without a full reload.
  renameDocOnCards(docId, newName) {
    this.cards.filter((c) => c.docId === docId).forEach((c) => {
      c.docName = newName;
      const el = this.cardEls.get(c.id);
      const tag = el && el.querySelector('.page-tag');
      if (tag) {
        tag.textContent = truncateName(newName) + ' · p.' + c.page;
        tag.title = newName + ', page ' + c.page;
      }
    });
  }

  _removeCard(c, opts) {
    this.cards = this.cards.filter((x) => x.id !== c.id);
    this.links = this.links.filter((l) => l[0] !== c.id && l[1] !== c.id);
    const el = this.cardEls.get(c.id);
    if (el) el.remove();
    this.cardEls.delete(c.id);
    this._drawLinks();
    this._updateEmptyState();
    if (!(opts && opts.alreadyPersisted) && this.cb.onCardRemoved) this.cb.onCardRemoved(c.id);
  }

  _persistCard(c) {
    if (this.cb.onCardChanged) this.cb.onCardChanged(c);
  }

  _cardCenter(c) {
    return { x: c.x + 100, y: c.y + 38 };
  }

  _drawLinks(tempLine) {
    this.svgGroup.innerHTML = '';
    this.links.forEach((pair) => {
      const a = this.cards.find((c) => c.id === pair[0]);
      const b = this.cards.find((c) => c.id === pair[1]);
      if (!a || !b) return;
      this._addPath(this._cardCenter(a), this._cardCenter(b), false);
    });
    if (tempLine) this._addPath(tempLine.from, tempLine.to, true);
  }

  _addPath(p1, p2, live) {
    const mx = (p1.x + p2.x) / 2;
    const d = 'M ' + p1.x + ' ' + p1.y + ' C ' + mx + ' ' + p1.y + ', ' + mx + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    if (live) path.classList.add('live');
    this.svgGroup.appendChild(path);
  }

  _startLink(fromCard, e) {
    const fromCenter = this._cardCenter(fromCard);
    const onMove = (ev) => {
      const rect = this.inner.getBoundingClientRect();
      const to = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      this._drawLinks({ from: fromCenter, to });
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetCard = target ? target.closest('.card') : null;
      if (targetCard && targetCard.dataset.id !== fromCard.id) {
        const pair = [fromCard.id, targetCard.dataset.id];
        const exists = this.links.some(
          (l) => (l[0] === pair[0] && l[1] === pair[1]) || (l[0] === pair[1] && l[1] === pair[0])
        );
        if (!exists) {
          this.links.push(pair);
          if (this.cb.onLinkAdded) this.cb.onLinkAdded(pair);
        }
      }
      this._drawLinks();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.stopPropagation();
  }
}
