import { rafThrottle } from './raf-throttle.js';

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
//
// A link between two cards is a small object `{id, a, b, type}` — `a` is
// the card the thread was dragged FROM, `b` the one it was dropped on
// (drawn with an arrowhead pointing at `b`), and `type` an optional short
// label ("Supports", "Contradicts", ...) set from the picker menu that
// opens after a link is made or when an existing thread is clicked.

function truncateName(name) {
  const base = name.replace(/\.pdf$/i, '');
  return base.length > 22 ? base.slice(0, 22) + '…' : base;
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeHtml(s) {
  return escapeAttr(s);
}

// Where a straight line from `from` to `to` first enters axis-aligned
// `rect` (Liang-Barsky segment clipping) — used to pull a link's arrowhead
// back to the target card's actual edge instead of its center, which
// would otherwise land the whole arrowhead underneath the (opaque, on
// top) card and make it invisible. Approximates the real cubic curve with
// its chord, which is accurate enough this close to the endpoint.
//
// Also reports which pair of edges was actually crossed (`axis: 'x'` for
// the left/right edges, `'y'` for top/bottom) — the curve build in
// _addPath needs that to orient the arrowhead correctly (see the comment
// there): entering through a side edge wants a left/right-pointing arrow,
// through the top or bottom a up/down-pointing one, and a curve shaped
// for one but ending at the other draws a technically-attached but
// visibly wrong-facing arrowhead.
function segmentRectEntry(from, to, rect) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const span = (p, d, lo, hi) => {
    if (d === 0) return p >= lo && p <= hi ? { enter: -Infinity, exit: Infinity } : null;
    let a = (lo - p) / d, b = (hi - p) / d;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    return { enter: a, exit: b };
  };
  const xs = span(from.x, dx, rect.left, rect.right);
  const ys = span(from.y, dy, rect.top, rect.bottom);
  if (!xs || !ys) return null;
  const t0 = Math.max(0, xs.enter, ys.enter);
  const t1 = Math.min(1, xs.exit, ys.exit);
  if (t0 > t1) return null;
  const axis = xs.enter >= ys.enter ? 'x' : 'y';
  return { x: from.x + dx * t0, y: from.y + dy * t0, axis };
}

const MARGIN = 40; // world-space padding used when framing cards on open

// Preset labels offered in the link picker menu — anything else typed into
// the custom field is stored verbatim.
const LINK_TYPES = ['Supports', 'Contradicts', 'References', 'Same clause'];

export default class NotesCanvas {
  constructor(canvasEl, innerEl, svgGroupEl, emptyEl, callbacks) {
    this.canvasEl = canvasEl;
    this.inner = innerEl;
    // Zoom lives on its own wrapper one level out from `inner` (see
    // setZoom) — .canvas-zoom in the markup, i.e. inner's own parent.
    this.zoomHost = innerEl.parentElement || innerEl;
    this.svgGroup = svgGroupEl;
    this.emptyEl = emptyEl;
    this.cb = callbacks || {};
    this.cards = [];
    this.links = [];
    this.cardEls = new Map();
    this.canvasId = null;
    this._saveTimers = new Map();
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this._menuEl = null;
    this._wirePanning();
    this._ensureMarker();
  }

  setCanvas(canvasId, cards, links) {
    this.canvasId = canvasId;
    this.cards = cards || [];
    this.links = links || [];
    this._closeLinkMenu();
    this.setZoom(1);
    this._frameCards();
    this._renderAll();
  }

  // ---------- zoom ----------
  // Same `zoom` (not `transform: scale`) approach as the PDF pane, and for
  // the same reason: it participates in layout, so getBoundingClientRect()
  // on a card or the canvas already reflects it.
  //
  // It's applied to `this.zoomHost`, one level OUT from `this.inner` (which
  // carries the pan transform), rather than to `inner` itself — putting
  // `zoom` and a `transform` on the very same element leaves it ambiguous
  // (and inconsistent across engines) whether the transform's px values are
  // scaled by that element's own zoom or not. On a separate ancestor
  // there's no ambiguity: `inner`'s translate is authored in local
  // (pre-zoom) px, exactly the world-coordinate units cards and links
  // already use, and the wrapper's `zoom` scales the rendered result of
  // that uniformly. The one thing this means for the rest of the file:
  // any raw pointer-movement delta (clientX/clientY) has to be divided by
  // `this.zoom` before being treated as a world-space distance, the same
  // way a screen pixel is more or less than one world unit at any zoom
  // level other than 100%.
  setZoom(z) {
    // Lower bound is well below the PDF pane's (0.5) on purpose: the point
    // of zooming out here is to see a whole sprawling map of cards at
    // once, not just read one comfortably, so it needs more headroom.
    this.zoom = Math.min(2, Math.max(0.15, z));
    this.zoomHost.style.zoom = this.zoom;
    if (this.cb.onZoomChange) this.cb.onZoomChange(this.zoom);
    return this.zoom;
  }
  zoomIn() { return this.setZoom(Math.round((this.zoom + 0.15) * 100) / 100); }
  zoomOut() { return this.setZoom(Math.round((this.zoom - 0.15) * 100) / 100); }
  zoomReset() { return this.setZoom(1); }

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
    // panned layer, so it never scales with zoom) moving in lockstep so it
    // still reads as one continuous plane instead of a patch that stays
    // put while content slides under it. `x`/`y` are world (pre-zoom) px,
    // but this layer isn't zoomed, so they're scaled up to real screen px
    // here to match how far the (zoomed) content actually just moved.
    this.canvasEl.style.backgroundPosition = (x * this.zoom) + 'px ' + (y * this.zoom) + 'px';
  }

  // Drag on empty canvas background (not a card, not a link thread) pans
  // the view — one finger (or the mouse) pans, two fingers pinch-zoom
  // (with the pinch's own two-finger drag panning at the same time, same
  // as any native map/photo app). Mirrors the PDF reading pane's own
  // gesture handling in pdfview.js, including treating a browser-issued
  // pointercancel the same as a normal pointerup so an in-progress
  // gesture still lands wherever it had gotten to rather than silently
  // doing nothing.
  _wirePanning() {
    // Every currently-down pointer that belongs to this gesture (started on
    // empty canvas background, not a card/menu/thread) — pointerId -> last
    // known {x, y}. Size 1 is a plain pan; size 2 is a pinch. A 3rd+
    // simultaneous pointer is tracked (so the count when fingers lift is
    // still right) but otherwise ignored — re-pairing mid-gesture isn't
    // worth the complexity for a three-finger touch.
    const pointers = new Map();
    let mode = null; // 'pan' | 'pinch' | null
    let startX, startY, startPanX, startPanY; // 'pan' gesture baseline
    let pinchIds = null; // the two pointerIds the active pinch is measured from
    let pinchStartDist = 0, pinchStartZoom = 1, pinchStartMid = null, pinchStartPan = null;
    let pinchStartOrigin = null; // canvasEl's own screen rect, captured once per pinch (see beginPinch)

    const twoPoints = () => pinchIds.map((id) => pointers.get(id));
    const midpoint = (pts) => ({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
    const distance = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

    const beginPan = (x, y) => {
      mode = 'pan';
      startX = x; startY = y;
      startPanX = this.pan.x; startPanY = this.pan.y;
      this.canvasEl.classList.add('panning');
    };
    const beginPinch = () => {
      mode = 'pinch';
      this.canvasEl.classList.remove('panning');
      pinchIds = [...pointers.keys()].slice(0, 2);
      const pts = twoPoints();
      pinchStartDist = distance(pts) || 1;
      pinchStartZoom = this.zoom;
      pinchStartMid = midpoint(pts);
      pinchStartPan = { x: this.pan.x, y: this.pan.y };
      // The canvas element doesn't move during the gesture, so its screen
      // rect is a valid, constant reference for converting the pinch's
      // screen-space coordinates into the canvas's own local space — see
      // the anchoring math in onMove.
      pinchStartOrigin = this.canvasEl.getBoundingClientRect();
    };

    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('.card')) return; // card's own handler owns this gesture
      if (e.target.closest('.link-menu')) return;
      // A link thread's own hit-path or label owns clicks on itself (to open
      // the picker menu) — starting a pan here would call setPointerCapture
      // on the canvas, which retargets the resulting `click` event to the
      // canvas div and the thread's click handler would never fire.
      if (e.target.closest && e.target.closest('.hit, .link-label')) return;
      // A card drag is already in progress on a different pointer (e.g. a
      // resting second finger on a touchscreen landed on empty canvas
      // background). Bail out so this stray touch doesn't start a pan —
      // panning would shift `this.pan`, which the dragged card's rendered
      // position is relative to, causing it to jitter under the finger
      // actually moving it. See the `_draggingCard` flag in `_wireCard`.
      if (this._draggingCard) return;
      try { this.canvasEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._closeLinkMenu();
      if (pointers.size === 1) beginPan(e.clientX, e.clientY);
      else if (pointers.size === 2) beginPinch();
    };
    // setZoom applies CSS `zoom`, which is layout-affecting — on a canvas
    // with many cards, running the full pinch math (setZoom + _setPan, each
    // forcing layout) once per touchmove event rather than once per
    // animation frame is what makes the gesture stutter, same root cause as
    // the PDF pane's pinch-zoom (see pdfview.js's _pinchThrottle). Coalesce
    // to one update per frame, reading whatever the latest two finger
    // positions are by the time the frame runs — see raf-throttle.js.
    const pinchThrottle = rafThrottle(() => {
      if (mode !== 'pinch') return;
      const pts = twoPoints();
      const dist = distance(pts) || 1;
      const mid = midpoint(pts);
      // Anchor the pinch to the world point that was under the fingers
      // when the gesture started, so the content under them stays under
      // them as they spread/pinch — the same math as the PDF pane's own
      // pinch-zoom (see pdfview.js), adapted to this canvas's
      // translate-then-zoom layering (see the comment on setZoom above):
      // a local (pre-zoom) point L maps to screen as origin + zoom*L, and
      // a card's local position is pan + card.xy, so solving for the pan
      // that keeps the same local point under the (possibly also
      // dragged) new midpoint gives pan' = (mid-origin)/zoom' - worldXY.
      const origin = pinchStartOrigin;
      const worldX = (pinchStartMid.x - origin.x) / pinchStartZoom - pinchStartPan.x;
      const worldY = (pinchStartMid.y - origin.y) / pinchStartZoom - pinchStartPan.y;
      const newZoom = this.setZoom(pinchStartZoom * (dist / pinchStartDist));
      this._setPan(
        (mid.x - origin.x) / newZoom - worldX,
        (mid.y - origin.y) / newZoom - worldY
      );
    });

    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === 'pinch') {
        e.preventDefault();
        pinchThrottle.call();
      } else if (mode === 'pan') {
        // Screen-px deltas, converted to the pan transform's local (pre-zoom)
        // px so the content tracks the cursor 1:1 at any zoom level.
        this._setPan(
          startPanX + (e.clientX - startX) / this.zoom,
          startPanY + (e.clientY - startY) / this.zoom
        );
      }
    };
    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (mode === 'pinch' && pointers.size < 2) {
        // Lifting one finger of a pinch ends the zoom gesture rather than
        // snapping into a one-finger pan from that finger's (unrelated)
        // starting point — the remaining finger just needs a fresh
        // pointerdown to do anything again.
        mode = null;
        pinchIds = null;
        pinchThrottle.cancel();
      } else if (mode === 'pan' && pointers.size === 0) {
        mode = null;
      }
      this.canvasEl.classList.remove('panning');
    };

    this.canvasEl.addEventListener('pointerdown', onDown);
    this.canvasEl.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    // Trackpads and mouse wheels. A trackpad never produces pointer events
    // for its gestures: two-finger scrolling arrives as `wheel` events, and
    // a pinch arrives as `wheel` with ctrlKey set (Chrome, Firefox, Edge)
    // or as Safari's own gesturestart/gesturechange. Two-finger scroll pans
    // the canvas; pinch (or Ctrl/⌘ + wheel) zooms around the cursor, using
    // the same anchoring as the touch pinch above.
    const zoomAround = (clientX, clientY, newZoomRaw) => {
      const origin = this.canvasEl.getBoundingClientRect();
      const worldX = (clientX - origin.left) / this.zoom - this.pan.x;
      const worldY = (clientY - origin.top) / this.zoom - this.pan.y;
      const z = this.setZoom(newZoomRaw);
      this._setPan((clientX - origin.left) / z - worldX, (clientY - origin.top) / z - worldY);
    };

    // Wheel events fire far faster than frames; accumulate and apply once
    // per frame so a long, card-heavy canvas doesn't reflow per event.
    let wheelPan = { x: 0, y: 0 }, wheelZoom = 1, wheelAt = null;
    const wheelThrottle = rafThrottle(() => {
      if (wheelZoom !== 1 && wheelAt) zoomAround(wheelAt.x, wheelAt.y, this.zoom * wheelZoom);
      if (wheelPan.x || wheelPan.y) {
        this._setPan(this.pan.x - wheelPan.x / this.zoom, this.pan.y - wheelPan.y / this.zoom);
      }
      wheelPan = { x: 0, y: 0 }; wheelZoom = 1; wheelAt = null;
    });
    this.canvasEl.addEventListener('wheel', (e) => {
      if (e.target.closest && e.target.closest('.link-menu')) return;
      // Let a card's own scrollable quote scroll when it can (plain scroll
      // only — a pinch over a card should still zoom the canvas).
      const quote = !e.ctrlKey && e.target.closest && e.target.closest('.card-quote');
      if (quote && quote.scrollHeight > quote.clientHeight) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvasEl.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        wheelZoom *= Math.exp(-Math.max(-50, Math.min(50, e.deltaY * unit)) * 0.01);
        wheelAt = { x: e.clientX, y: e.clientY };
      } else {
        wheelPan.x += e.deltaX * unit;
        wheelPan.y += e.deltaY * unit;
      }
      wheelThrottle.call();
    }, { passive: false });

    // Safari (macOS) reports trackpad pinch through its non-standard
    // GestureEvent instead of ctrl+wheel. preventDefault also stops the
    // whole page from zooming.
    let gestureStartZoom = 1;
    this.canvasEl.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureStartZoom = this.zoom;
    });
    this.canvasEl.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      zoomAround(e.clientX, e.clientY, gestureStartZoom * e.scale);
    });
    this.canvasEl.addEventListener('gestureend', (e) => e.preventDefault());
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

  addExcerptCard({ docId, docName, page, rects, text, image }) {
    const pos = this._claimPosition();
    const card = {
      id: 'card_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      canvasId: this.canvasId,
      docId,
      docName,
      page,
      rects,
      // Scanned/image-only pages have no extractable text — the marquee
      // still captures a snapshot of that region so the excerpt isn't lost.
      // Stored in full: the card's quote box caps its own height and
      // scrolls, and the Markdown export needs the whole passage.
      excerpt: text || '',
      image: image || null,
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

    let quote;
    if (c.image) {
      quote = document.createElement('img');
      quote.className = 'card-quote card-image';
      quote.src = c.image;
      quote.alt = 'Excerpt image from page ' + c.page;
      // Images are natively draggable in every browser by default. Left
      // as-is, starting a drag on an image card kicks off the browser's
      // own drag-and-drop gesture (a ghost image that follows the cursor)
      // *alongside* this file's own pointer-based dragging — the two
      // fight over the same gesture, and what the person sees is the card
      // sliding away from the cursor rather than tracking it. Turning off
      // native drag leaves pointer events as the only thing driving it.
      quote.draggable = false;
    } else {
      quote = document.createElement('div');
      quote.className = 'card-quote';
      quote.textContent = '“' + c.excerpt + '”';
    }

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
    // Redrawing every link thread on every raw pointermove (_drawLinks
    // wipes and rebuilds the whole SVG group, and _edgePoint reads
    // el.offsetHeight per linked card, forcing layout) is more reflow work
    // than a touchmove stream can keep up with on a big canvas — the
    // symptom is the thread visibly lagging behind the card, or snapping
    // into place only once the drag ends, which reads as the arrow "not
    // correctly connecting" while dragging far. Coalescing to one redraw
    // per animation frame, same fix as the pinch-zoom handlers above, keeps
    // the card position updates (cheap: a style write, no layout read)
    // immediate while capping the expensive part to what the screen can
    // actually show. See raf-throttle.js.
    const linkRedrawThrottle = rafThrottle(() => this._drawLinks());

    el.addEventListener('pointerdown', (e) => {
      if (e.target === nub) {
        this._startLink(c, e);
        return;
      }
      if (e.target === delBtn) return;
      if (e.target === noteEl || noteEl.contains(e.target)) return; // let editing work normally
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      origX = c.x; origY = c.y;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore — synthetic/edge pointer events */ }
      this._closeLinkMenu();
      // The canvas-level pan/pinch handler (_wirePanning) only ignores a
      // touch that LANDS on a card — it has no way to know a card drag is
      // already under way when a second, stray touch (a resting thumb,
      // most often) lands on the empty background elsewhere. On a
      // touchscreen that second contact point is common enough that it
      // isn't really an edge case: without this flag it silently starts a
      // pan gesture at the same time as this drag, and since a pan moves
      // `this.pan` — which every card's screen position is rendered
      // relative to — the card being dragged visibly jitters/drifts on
      // top of the finger actually moving it. This flag lets the pan
      // handler bail out for as long as any card drag is in progress,
      // regardless of which element a second touch happens to land on.
      this._draggingCard = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Same screen-to-world conversion as panning above.
      const dx = (e.clientX - startX) / this.zoom, dy = (e.clientY - startY) / this.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      // No lower bound — the canvas is infinite in every direction, so a
      // card is free to move into negative world coordinates too.
      c.x = origX + dx;
      c.y = origY + dy;
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
      linkRedrawThrottle.call();
    });
    const endDrag = () => {
      if (dragging && moved) {
        // Finish with one synchronous redraw at the card's final position —
        // otherwise a coalesced-away in-flight frame could leave the
        // thread one step behind where the card actually stopped.
        linkRedrawThrottle.cancel();
        this._drawLinks();
      }
      if (dragging && !moved) {
        if (this.cb.onCardClick) this.cb.onCardClick(c);
      }
      if (dragging && moved) this._persistCard(c);
      dragging = false;
      this._draggingCard = false;
    };
    el.addEventListener('pointerup', endDrag);
    // A touch drag can be cancelled by the OS mid-gesture (an incoming
    // notification, an edge-swipe system gesture) without ever firing
    // pointerup — treated the same as pointerup elsewhere in this file for
    // exactly that reason. Without also clearing `_draggingCard` here, a
    // cancelled card drag would leave canvas panning permanently disabled
    // for the rest of the session (see the flag's own comment above).
    el.addEventListener('pointercancel', endDrag);

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
    const droppedLinks = this.links.filter((l) => l.a === c.id || l.b === c.id);
    this.links = this.links.filter((l) => l.a !== c.id && l.b !== c.id);
    const el = this.cardEls.get(c.id);
    if (el) el.remove();
    this.cardEls.delete(c.id);
    this._closeLinkMenu();
    this._drawLinks();
    this._updateEmptyState();
    if (!(opts && opts.alreadyPersisted)) {
      if (this.cb.onCardRemoved) this.cb.onCardRemoved(c.id);
      // The card's own delete cascades to its links server-side too, but do
      // it here as well so a caller relying purely on onLinkRemoved (e.g.
      // an export or undo feature added later) sees a consistent trail.
      if (this.cb.onLinkRemoved) droppedLinks.forEach((l) => this.cb.onLinkRemoved(l.id));
    }
  }

  _persistCard(c) {
    if (this.cb.onCardChanged) this.cb.onCardChanged(c);
  }

  _cardCenter(c) {
    return { x: c.x + 100, y: c.y + 38 };
  }

  // The point a link line should actually start/end at: just outside the
  // given card's edge (along the line toward `from`, the other end of the
  // link) rather than the card's center. A path drawn all the way to
  // center is entirely covered by the opaque card on top of it — for the
  // target end that means the arrowhead (drawn right at that point) is
  // invisible, not just "running underneath" the way the old plain-line
  // version read; for the source end it means a hit-path midpoint can
  // land back inside the source card on two cards placed close together,
  // which is also where a click ought to land on empty canvas, not on a
  // card. `gap` is extra clearance past the edge — 0 for the plain start
  // point, enough to clear the marker's own ~11px length for the end.
  _edgePoint(from, card, gap) {
    const center = this._cardCenter(card);
    const el = this.cardEls.get(card.id);
    // Browsers disagree on whether offsetHeight under an ancestor's CSS
    // `zoom` is scaled (older engines) or not (current Chrome/Firefox, which
    // report layout px). Dividing by this.zoom unconditionally made cards
    // look several times taller when zoomed out, so arrows ended in empty
    // space below them. Calibrating against the card's fixed 200px world
    // width converts to world units correctly under either behavior.
    const scale = (el && el.offsetWidth / 200) || 1;
    const height = (el && el.offsetHeight / scale) || 90;
    const rect = { left: card.x, right: card.x + 200, top: card.y, bottom: card.y + height };
    const entry = segmentRectEntry(from, center, rect);
    if (!entry) return { x: center.x, y: center.y, axis: 'x' };
    const dx = center.x - from.x, dy = center.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return {
      x: entry.x - (dx / len) * gap,
      y: entry.y - (dy / len) * gap,
      axis: entry.axis, // which pair of edges this landed on — see _addPath
    };
  }

  // A <marker> element (the arrowhead) has to be defined once and referenced
  // by id from each path's marker-end — SVG doesn't let you inline one.
  _ensureMarker() {
    const svg = this.svgGroup.ownerSVGElement || this.svgGroup.closest('svg');
    if (!svg || svg.querySelector('#link-arrow')) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<marker id="link-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" class="link-arrow-head"></path>' +
      '</marker>';
    svg.insertBefore(defs, svg.firstChild);
  }

  _drawLinks(tempLine) {
    this.svgGroup.innerHTML = '';
    this._ensureMarker();
    this.links.forEach((link) => {
      const a = this.cards.find((c) => c.id === link.a);
      const b = this.cards.find((c) => c.id === link.b);
      if (!a || !b) return;
      const centerA = this._cardCenter(a);
      const centerB = this._cardCenter(b);
      const p1 = this._edgePoint(centerB, a, 2);
      const p2 = this._edgePoint(centerA, b, 8);
      this._addPath(p1, p2, { link });
    });
    if (tempLine) this._addPath(tempLine.from, tempLine.to, { live: true });
  }

  _addPath(p1, p2, opts) {
    opts = opts || {};
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    // Each control point is placed so the curve approaches its endpoint
    // along that endpoint's own axis: sharing the *other* point's
    // coordinate on the axis the entry edge runs along, and the midpoint
    // on the axis it doesn't. A control point of (mx, p.y) makes the
    // curve's tangent at `p` purely horizontal (right for a left/right
    // edge entry); (p.x, my) makes it purely vertical (a top/bottom edge
    // entry). Getting this wrong doesn't just look a little off — the
    // marker-end arrowhead orients itself along whatever tangent the
    // curve actually has there, so a horizontal-only curve produces a
    // sideways-pointing arrow even when the line visibly runs into the
    // card from above or below. `axis` defaults to 'x' (the original
    // always-horizontal behavior) for callers that don't set it, i.e. the
    // in-progress drag preview, which has no card edge to align to yet.
    const c1 = (p1.axis === 'y') ? { x: p1.x, y: my } : { x: mx, y: p1.y };
    const c2 = (p2.axis === 'y') ? { x: p2.x, y: my } : { x: mx, y: p2.y };
    const d = 'M ' + p1.x + ' ' + p1.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + p2.x + ' ' + p2.y;

    if (opts.link) {
      // A wide, invisible path drawn first (so the thin visible one paints
      // over it) gives a much easier click/tap target than the 2px visible
      // stroke itself would.
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.classList.add('hit');
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openLinkMenu(opts.link, e.clientX, e.clientY);
      });
      this.svgGroup.appendChild(hit);
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    if (opts.live) path.classList.add('live');
    if (opts.link) {
      path.setAttribute('marker-end', 'url(#link-arrow)');
      path.dataset.linkId = opts.link.id;
    }
    this.svgGroup.appendChild(path);

    if (opts.link && opts.link.type) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', mx);
      label.setAttribute('y', my);
      label.classList.add('link-label');
      label.textContent = opts.link.type;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openLinkMenu(opts.link, e.clientX, e.clientY);
      });
      this.svgGroup.appendChild(label);
    }
  }

  _startLink(fromCard, e) {
    const fromCenter = this._cardCenter(fromCard);
    const onMove = (ev) => {
      // Same reasoning as the PDF marquee drag: without this, the browser
      // can start its own native drag/selection over whatever the thread
      // happens to cross (e.g. the reading pane just to the left of the
      // canvas) at the same time as this custom gesture, and cancel the
      // pointer stream outright when they collide.
      ev.preventDefault();
      const rect = this.inner.getBoundingClientRect();
      const to = { x: (ev.clientX - rect.left) / this.zoom, y: (ev.clientY - rect.top) / this.zoom };
      this._drawLinks({ from: fromCenter, to });
    };
    const finish = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      // A pointercancel carries no useful coordinates — just drop the
      // in-progress thread rather than guessing a drop target from (0,0).
      if (ev.type === 'pointercancel') { this._drawLinks(); return; }
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      let targetCard = target ? target.closest('.card') : null;
      // Releasing back over the SAME card you dragged from (very likely on
      // a tall card, where the nub sits far from the top and a modest drag
      // never actually clears the card's own bottom edge) isn't a valid
      // drop target — treat it the same as missing the mark entirely and
      // fall through to the proximity search below rather than silently
      // doing nothing.
      const sameCard = targetCard && targetCard.dataset.id === fromCard.id;
      if (!targetCard || sameCard) {
        // A precise drop is a small, fiddly target — if the release point
        // isn't exactly over a DIFFERENT card, fall back to whichever
        // other card's box is nearest the release point, as long as it's
        // close enough that this was clearly an attempt to drop on it
        // rather than empty canvas.
        const SNAP_MARGIN = 60;
        let best = null, bestDist = Infinity;
        for (const [id, el] of this.cardEls) {
          if (id === fromCard.id) continue;
          const r = el.getBoundingClientRect();
          const dx = Math.max(r.left - ev.clientX, 0, ev.clientX - r.right);
          const dy = Math.max(r.top - ev.clientY, 0, ev.clientY - r.bottom);
          const dist = Math.hypot(dx, dy);
          if (dist <= SNAP_MARGIN && dist < bestDist) { best = el; bestDist = dist; }
        }
        targetCard = best; // null if nothing nearby either — a real non-drop
      }
      let newLink = null;
      if (targetCard && targetCard.dataset.id !== fromCard.id) {
        const toId = targetCard.dataset.id;
        const exists = this.links.some(
          (l) => (l.a === fromCard.id && l.b === toId) || (l.a === toId && l.b === fromCard.id)
        );
        if (!exists) {
          newLink = {
            id: 'lnk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            a: fromCard.id,
            b: toId,
            type: null,
          };
          this.links.push(newLink);
          if (this.cb.onLinkAdded) this.cb.onLinkAdded(newLink);
        }
      }
      this._drawLinks();
      // Freshly-made threads open straight into the label picker — tagging
      // what the connection MEANS is the whole point; skip it (click
      // anywhere else) if you just want a bare thread.
      if (newLink) this._openLinkMenu(newLink, ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish);
    // Without this, a browser-cancelled pointer stream (see onMove above)
    // would leave these window listeners attached forever — every future
    // mouse move anywhere in the app would keep redrawing a phantom
    // "in-progress" link thread from the original card.
    window.addEventListener('pointercancel', finish);
    e.stopPropagation();
  }

  // ---------- link picker menu (label / reverse / delete) ----------

  _closeLinkMenu() {
    if (this._menuEl) { this._menuEl.remove(); this._menuEl = null; }
    if (this._menuOutsideHandler) {
      window.removeEventListener('pointerdown', this._menuOutsideHandler, true);
      this._menuOutsideHandler = null;
    }
  }

  _openLinkMenu(link, clientX, clientY) {
    this._closeLinkMenu();

    const menu = document.createElement('div');
    menu.className = 'link-menu';

    const typeBtns = LINK_TYPES.map((t) => {
      const active = link.type === t;
      return '<button type="button" class="link-menu-type' + (active ? ' active' : '') + '" data-type="' + escapeAttr(t) + '">' + escapeHtml(t) + '</button>';
    }).join('');

    menu.innerHTML =
      '<div class="link-menu-types">' + typeBtns + '</div>' +
      '<div class="link-menu-custom">' +
      '<input type="text" class="link-menu-input" placeholder="Custom label…" value="' + (link.type && !LINK_TYPES.includes(link.type) ? escapeAttr(link.type) : '') + '" />' +
      '</div>' +
      '<div class="link-menu-row">' +
      '<button type="button" class="link-menu-action" data-act="clear">No label</button>' +
      '<button type="button" class="link-menu-action" data-act="reverse">Reverse ↔</button>' +
      '<button type="button" class="link-menu-action danger" data-act="delete">Delete</button>' +
      '</div>';

    document.body.appendChild(menu);
    this._menuEl = menu;

    // Position, clamped so it never runs off the viewport edge.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, clientX - rect.width / 2), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, clientY + 12), window.innerHeight - rect.height - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    const setType = (type) => {
      link.type = type || null;
      if (this.cb.onLinkChanged) this.cb.onLinkChanged(link);
      this._drawLinks();
      this._closeLinkMenu();
    };

    menu.querySelectorAll('.link-menu-type').forEach((btn) => {
      btn.addEventListener('click', () => setType(btn.dataset.type));
    });
    const input = menu.querySelector('.link-menu-input');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') setType(input.value.trim());
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    menu.querySelector('[data-act="clear"]').addEventListener('click', () => setType(null));
    menu.querySelector('[data-act="reverse"]').addEventListener('click', () => {
      const a = link.a; link.a = link.b; link.b = a;
      if (this.cb.onLinkChanged) this.cb.onLinkChanged(link);
      this._drawLinks();
      this._closeLinkMenu();
    });
    menu.querySelector('[data-act="delete"]').addEventListener('click', () => {
      this.links = this.links.filter((l) => l.id !== link.id);
      if (this.cb.onLinkRemoved) this.cb.onLinkRemoved(link.id);
      this._drawLinks();
      this._closeLinkMenu();
    });

    // Any pointerdown outside the menu closes it without acting — capture
    // phase so it fires before the canvas-pan / card-drag handlers below it.
    this._menuOutsideHandler = (e) => {
      if (!menu.contains(e.target)) this._closeLinkMenu();
    };
    // Skip the gesture that opened the menu itself.
    setTimeout(() => window.addEventListener('pointerdown', this._menuOutsideHandler, true), 0);
  }

  // ---------- export ----------

  // Writes the canvas out as a self-describing Markdown document, meant to
  // be read by a person or handed to an AI alongside the source PDF. Every
  // card appears exactly once (numbered C1, C2, …) with its full excerpt,
  // source page and the reader's own note, plus its links in BOTH
  // directions — so a card that is only ever linked *to* still shows its
  // note. A flat "Connections" list at the end restates the whole graph.
  //
  // Image excerpts are embedded as data-URI images by default, so the
  // downloaded file is self-contained. `images: 'placeholder'` swaps them
  // for a one-line pointer to the page instead — used by "Copy for AI",
  // where megabytes of base64 pasted into a chat box would just be noise.
  getLinkMapMarkdown(title, { images = 'embed' } = {}) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const ids = new Map(this.cards.map((c, i) => [c.id, 'C' + (i + 1)]));
    const source = (c) => (c.docName ? c.docName + ', ' : '') + 'p.' + c.page;
    const verbOf = (l) => (l.type ? l.type.toLowerCase() : 'links to');
    const links = this.links.filter((l) => ids.has(l.a) && ids.has(l.b));

    const lines = ['# ' + (clean(title) || 'Link map'), ''];
    if (!this.cards.length) {
      lines.push('_No cards on this canvas yet._');
      return lines.join('\n');
    }

    const docs = [...new Set(this.cards.map((c) => c.docName).filter(Boolean))];
    lines.push(
      '_Exported from Marginalia. Each card is an excerpt taken from a PDF' +
        (docs.length ? ' (' + docs.join(', ') + ')' : '') +
        ', with the page it came from and the reader\'s own note on it. ' +
        'Links record how the reader thinks the excerpts relate._',
      '',
      '**' + this.cards.length + ' card' + (this.cards.length === 1 ? '' : 's') + ', ' +
        links.length + ' link' + (links.length === 1 ? '' : 's') + '.**',
      '',
      '## Cards',
      ''
    );

    this.cards.forEach((c) => {
      const id = ids.get(c.id);
      lines.push('### ' + id + ' · ' + source(c), '');
      const excerpt = clean(c.excerpt);
      if (excerpt) lines.push('> ' + excerpt, '');
      if (c.image) {
        lines.push(
          images === 'embed'
            ? '![Image excerpt from ' + source(c) + '](' + c.image + ')'
            : '> _[Image excerpt: see ' + source(c) + ' in the PDF]_',
          ''
        );
      } else if (!excerpt) {
        lines.push('> _[empty excerpt]_', '');
      }
      const note = (c.note || '').trim();
      if (note) {
        lines.push('**Note:** ' + note.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(' / '), '');
      }
      const out = links.filter((l) => l.a === c.id).map((l) => '- ' + verbOf(l) + ' → ' + ids.get(l.b));
      const inc = links.filter((l) => l.b === c.id).map((l) => '- ' + ids.get(l.a) + ' ' + verbOf(l) + ' → this');
      if (out.length || inc.length) lines.push('**Links:**', ...out, ...inc, '');
      else lines.push('_Not linked to other cards._', '');
    });

    if (links.length) {
      lines.push('## Connections', '');
      links.forEach((l) => {
        const a = this.cards.find((x) => x.id === l.a);
        const b = this.cards.find((x) => x.id === l.b);
        const snip = (c) => {
          const t = clean(c.excerpt) || '[image excerpt]';
          return '"' + (t.length > 80 ? t.slice(0, 80) + '…' : t) + '"';
        };
        lines.push('- ' + ids.get(l.a) + ' ' + snip(a) + ' **' + verbOf(l) + '** ' + ids.get(l.b) + ' ' + snip(b));
      });
      lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
  }
}
