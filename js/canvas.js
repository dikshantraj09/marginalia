// The freeform notes canvas: excerpt cards (with your own notes attached),
// dragging, linking cards with threads, and click-to-jump back to the source page.

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
    this.docId = null;
    this._nextPos = { x: 40, y: 40 };
    this._saveTimers = new Map();
  }

  setDocument(docId, cards, links) {
    this.docId = docId;
    this.cards = cards || [];
    this.links = links || [];
    this._nextPos = { x: 40, y: 40 };
    this._renderAll();
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

  addExcerptCard({ page, rects, text }) {
    const pos = this._claimPosition();
    const card = {
      id: 'card_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      docId: this.docId,
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

  _claimPosition() {
    const pos = { ...this._nextPos };
    this._nextPos.x += 36;
    this._nextPos.y += 26;
    if (this._nextPos.x > 900) this._nextPos.x = 40;
    if (this._nextPos.y > 1100) this._nextPos.y = 40;
    return pos;
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
    meta.innerHTML =
      '<span class="page-tag">p.' + c.page + '</span>' +
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
      c.x = Math.max(0, origX + dx);
      c.y = Math.max(0, origY + dy);
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

  _removeCard(c) {
    this.cards = this.cards.filter((x) => x.id !== c.id);
    this.links = this.links.filter((l) => l[0] !== c.id && l[1] !== c.id);
    const el = this.cardEls.get(c.id);
    if (el) el.remove();
    this.cardEls.delete(c.id);
    this._drawLinks();
    this._updateEmptyState();
    if (this.cb.onCardRemoved) this.cb.onCardRemoved(c.id);
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
