// Renders a PDF into the reading pane: page canvases + a text layer (for
// crisp glyph geometry) + a highlight overlay for excerpts pulled onto the
// notes canvas.
//
// Selection is a custom drag-marquee rather than the browser's native text
// Range. PDF content streams (especially tables from Word/legal-drafting
// tools) very often list a page's text in column-major order — the whole
// first cell, then the whole second cell — rather than top-to-bottom visual
// reading order. A native Range follows that DOM order, so dragging across
// a table row can select fragments out of sequence and produce highlight
// rects that look scattered. A marquee sidesteps this: we grab whichever
// spans fall inside the dragged rectangle and sort THEM by visual position
// ourselves, so the result always matches what was actually dragged over —
// on any document, table or not, and identically on mouse and touch.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
// Resolve explicitly against this module's own URL (not the page's URL) —
// the worker is constructed by the browser relative to document location by
// default, which breaks whenever the page isn't served from a plain root
// (e.g. hosted artifact paths), even though the static `import` above is
// always resolved correctly per the ES module spec.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

// The page is always laid out at this fixed CSS pixel width (a comfortable
// manuscript-style reading column), independent of the PDF's native page
// size. Canvas and text-layer are both derived from a viewport computed for
// THIS width, so the invisible, selectable text spans always land exactly on
// top of what's visually drawn — previously the canvas was scaled down to
// fit via CSS while the text layer kept its own unscaled pixel size, so
// dragging over visible text could land on completely different, offset
// spans underneath (worse the further right/down on the page, and worst of
// all on a standard Letter/A4 page, which is wider than the reading column).
const TARGET_PAGE_WIDTH = 640;

// A span only counts as "inside" the marquee once this much of its own area
// overlaps it — lets a sloppy drag catch a line without also grabbing a
// neighboring line/column it barely brushes.
const OVERLAP_THRESHOLD = 0.35;
// Pixels of movement before a pointerdown commits to being a drag at all
// (versus a tap, which does nothing new).
const DRAG_THRESHOLD = 6;
// A gesture that starts mostly-vertical and moves fast is read as "trying to
// scroll the page," not "trying to select a table cell" — so it's left
// alone rather than hijacked into a marquee.
const SCROLL_INTENT_MIN_DY = 14;
const SCROLL_INTENT_RATIO = 2.2;

export default class PdfView {
  constructor(container, pullBtn, onSelectionReady, onHighlightClick) {
    this.container = container; // holds rendered pages — cleared/rebuilt on each load()
    this.scrollHost = container.closest('.reading-scroll') || container.closest('.reading') || container.parentElement; // scrollable ancestor, used for measurement
    this.pullBtn = pullBtn;
    this.onSelectionReady = onSelectionReady;
    this.onHighlightClick = onHighlightClick;
    this.onPageChange = null; // (pageNum) => void — fired as the visible page changes while scrolling
    this.onSearchResults = null; // (activeIndex1Based, total) => void
    this.pageWraps = new Map(); // pageNum -> wrap el
    this.pdf = null;
    this._selection = null;
    this.zoom = 1;
    this._searchMatches = [];
    this._searchIndex = -1;

    this._drag = null; // active marquee gesture state, or null
    this.container.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.container.addEventListener('pointermove', (e) => this._onPointerMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
    // The browser can cancel an in-flight pointer stream mid-gesture (seen in
    // practice right after a page is freshly re-rendered while the notes
    // panel has narrowed the reading column) with no pointerup ever firing.
    // Treating that as a silent abort would make a drag that was otherwise
    // going fine just do nothing — instead we finish the gesture with
    // whatever rectangle was tracked up to that point, same as a real
    // pointerup, so the person still gets a selection instead of nothing.
    window.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    this._pageObserver = new IntersectionObserver(
      (entries) => this._onPageIntersect(entries),
      { root: this.scrollHost, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    this._visibility = new Map(); // pageNum -> intersection ratio, used to pick the "current" page
  }

  async load(arrayBuffer) {
    this.container.innerHTML = '';
    this.pageWraps.clear();
    this._visibility.clear();
    this._pageObserver.disconnect();
    this._cancelDrag();
    this.clearSearch();
    this.zoom = 1;
    this.container.style.zoom = 1;
    try {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      this.pdf = await loadingTask.promise;
      for (let pageNum = 1; pageNum <= this.pdf.numPages; pageNum++) {
        await this._renderPage(pageNum);
      }
    } catch (err) {
      console.error('Marginalia: failed to load PDF', err);
      this.container.innerHTML =
        '<div style="padding:24px;color:var(--danger);font-size:13px;max-width:420px;">' +
        "Couldn't open this PDF (" + (err && err.message ? err.message : 'unknown error') + '). ' +
        'Try re-importing the file, or a different PDF.</div>';
      throw err;
    }
  }

  async _renderPage(pageNum) {
    const page = await this.pdf.getPage(pageNum);
    // cssViewport is the ground truth for layout: everything the user can
    // see or interact with (canvas display size, text-layer, highlight
    // rects) is positioned in this same CSS-pixel space, whatever the PDF's
    // native page size is.
    const baseViewport = page.getViewport({ scale: 1 });
    const cssScale = TARGET_PAGE_WIDTH / baseViewport.width;
    const cssViewport = page.getViewport({ scale: cssScale });
    // The canvas is rasterized at a higher pixel density for crispness on
    // high-DPI screens, but its CSS width/height still match cssViewport
    // exactly, so it never needs a CSS width:100% scaling trick that would
    // otherwise drift out of sync with the text layer.
    const dpr = window.devicePixelRatio || 1;
    const renderViewport = page.getViewport({ scale: cssScale * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = pageNum;
    wrap.style.width = cssViewport.width + 'px';
    wrap.style.height = cssViewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    textLayerDiv.style.width = cssViewport.width + 'px';
    textLayerDiv.style.height = cssViewport.height + 'px';
    wrap.appendChild(textLayerDiv);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    wrap.appendChild(highlightLayer);

    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee-box';
    wrap.appendChild(marqueeEl);

    this.container.appendChild(wrap);
    const pageNumEl = document.createElement('div');
    pageNumEl.className = 'page-num';
    pageNumEl.textContent = '— ' + pageNum + ' —';
    this.container.appendChild(pageNumEl);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: cssViewport,
    });
    await textLayer.render();

    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    wrap.appendChild(searchLayer);

    this.pageWraps.set(pageNum, { wrap, viewport: cssViewport, highlightLayer, marqueeEl, searchLayer, page });
    this._pageObserver.observe(wrap);
  }

  _onPageIntersect(entries) {
    for (const entry of entries) {
      const pageNum = parseInt(entry.target.dataset.page, 10);
      this._visibility.set(pageNum, entry.isIntersecting ? entry.intersectionRatio : 0);
    }
    let bestPage = null;
    let bestRatio = 0;
    for (const [pageNum, ratio] of this._visibility) {
      if (ratio > bestRatio) { bestRatio = ratio; bestPage = pageNum; }
    }
    if (bestPage && this.onPageChange) this.onPageChange(bestPage);
  }

  getPageCount() {
    return this.pdf ? this.pdf.numPages : 0;
  }

  goToPage(pageNum) {
    const info = this.pageWraps.get(pageNum);
    if (!info) return;
    info.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- zoom ----------
  // Applied via CSS `zoom` on the whole page container: it participates in
  // layout (so scrolling still works correctly, unlike `transform: scale`)
  // and getBoundingClientRect()/pointer coordinates already account for it,
  // so nothing else here — marquee selection, highlight rects — needs to
  // know the zoom level at all.

  setZoom(z) {
    this.zoom = Math.min(2.5, Math.max(0.5, z));
    this.container.style.zoom = this.zoom;
    // Zooming in can widen the page past the pane, and jumping to a search
    // match while zoomed can then scroll it sideways to bring a wide line
    // into view. That horizontal offset doesn't self-correct when zooming
    // back out — it just gets clamped to whatever's still in range at the
    // new (narrower) width — so without this the page can end up
    // permanently shifted right even at 100% zoom. Simplest fix: every zoom
    // change re-centers horizontally instead of trying to preserve a scroll
    // position computed for a different content width.
    this.scrollHost.scrollLeft = 0;
    return this.zoom;
  }
  zoomIn() { return this.setZoom(Math.round((this.zoom + 0.15) * 100) / 100); }
  zoomOut() { return this.setZoom(Math.round((this.zoom - 0.15) * 100) / 100); }
  zoomReset() { return this.setZoom(1); }

  // ---------- table of contents ----------

  async getOutline() {
    if (!this.pdf) return [];
    try {
      return (await this.pdf.getOutline()) || [];
    } catch (err) {
      return [];
    }
  }

  // A bookmark's `dest` is either a named destination (string, needs a
  // lookup) or an already-explicit destination array whose first element is
  // a page ref.
  async resolveDestPage(dest) {
    if (!this.pdf || !dest) return null;
    try {
      const explicitDest = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!explicitDest || !explicitDest[0]) return null;
      const pageIndex = await this.pdf.getPageIndex(explicitDest[0]);
      return pageIndex + 1;
    } catch (err) {
      return null;
    }
  }

  // ---------- search ----------
  // Matches within a single text span (a span is usually one line of one
  // run) rather than reconstructing exact substring geometry — a match
  // highlights the whole run it was found in. Simple, and accurate enough
  // to find and jump to a phrase.

  search(term) {
    this.clearSearch();
    if (!term || !term.trim()) {
      if (this.onSearchResults) this.onSearchResults(0, 0);
      return;
    }
    const lower = term.trim().toLowerCase();
    for (const [pageNum, info] of this.pageWraps) {
      const spans = info.wrap.querySelectorAll('.text-layer span');
      spans.forEach((span) => {
        if (span.textContent.toLowerCase().includes(lower)) {
          this._searchMatches.push({ page: pageNum, span });
        }
      });
    }
    this._searchIndex = this._searchMatches.length ? 0 : -1;
    this._renderSearchHighlights();
    if (this.onSearchResults) this.onSearchResults(this._searchMatches.length ? 1 : 0, this._searchMatches.length);
    if (this._searchMatches.length) this._scrollToMatch(0);
  }

  nextMatch() {
    if (!this._searchMatches.length) return;
    this._searchIndex = (this._searchIndex + 1) % this._searchMatches.length;
    this._renderSearchHighlights();
    this._scrollToMatch(this._searchIndex);
    if (this.onSearchResults) this.onSearchResults(this._searchIndex + 1, this._searchMatches.length);
  }

  prevMatch() {
    if (!this._searchMatches.length) return;
    this._searchIndex = (this._searchIndex - 1 + this._searchMatches.length) % this._searchMatches.length;
    this._renderSearchHighlights();
    this._scrollToMatch(this._searchIndex);
    if (this.onSearchResults) this.onSearchResults(this._searchIndex + 1, this._searchMatches.length);
  }

  clearSearch() {
    this._searchMatches = [];
    this._searchIndex = -1;
    for (const [, info] of this.pageWraps) info.searchLayer.innerHTML = '';
  }

  _renderSearchHighlights() {
    for (const [, info] of this.pageWraps) info.searchLayer.innerHTML = '';
    this._searchMatches.forEach((m, i) => {
      const info = this.pageWraps.get(m.page);
      if (!info) return;
      const wrapRect = info.wrap.getBoundingClientRect();
      const r = m.span.getBoundingClientRect();
      const el = document.createElement('div');
      el.className = 'search-hit' + (i === this._searchIndex ? ' active' : '');
      el.style.left = (((r.left - wrapRect.left) / wrapRect.width) * 100) + '%';
      el.style.top = (((r.top - wrapRect.top) / wrapRect.height) * 100) + '%';
      el.style.width = ((r.width / wrapRect.width) * 100) + '%';
      el.style.height = ((r.height / wrapRect.height) * 100) + '%';
      info.searchLayer.appendChild(el);
    });
  }

  _scrollToMatch(i) {
    const m = this._searchMatches[i];
    if (!m) return;
    m.span.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- marquee selection ----------

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // left click / primary touch only
    if (e.target.closest('.highlight-rect')) return; // let its own click (jump to card) fire
    if (e.target.closest('.pull-btn')) return;
    const pageWrap = e.target.closest('.pdf-page-wrap');
    if (!pageWrap || !this.container.contains(pageWrap)) return;

    // Without this, a fast or wide drag that carries the pointer off the
    // rendered page (into the pane's margin, past the page edge, or briefly
    // over a sibling element) stops delivering move/up events to this
    // container the instant the pointer leaves it — the drag would just
    // silently stop tracking, which reads as the selection "getting stuck."
    // Capturing to the element that received pointerdown keeps every
    // subsequent event for this gesture routed here regardless of where the
    // pointer physically travels.
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* not critical if unsupported */ }

    this._drag = {
      pointerId: e.pointerId,
      pageWrap,
      startX: e.clientX,
      startY: e.clientY,
      committed: false, // becomes true once movement crosses DRAG_THRESHOLD and we decide it's a selection, not a scroll
      aborted: false, // true once we've decided this gesture is a scroll and should be left alone
    };
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId || d.aborted) return;

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (!d.committed) {
      const dist = Math.hypot(dx, dy);
      if (dist < DRAG_THRESHOLD) return;
      // A fast, mostly-vertical gesture reads as "scroll the reading pane,"
      // not "select this text" — leave it alone rather than hijacking it.
      if (Math.abs(dy) > SCROLL_INTENT_MIN_DY && Math.abs(dy) > Math.abs(dx) * SCROLL_INTENT_RATIO) {
        d.aborted = true;
        return;
      }
      d.committed = true;
      this.clearSelectionUI();
      this.pullBtn.style.display = 'none';
    }

    e.preventDefault();
    const info = this.pageWraps.get(parseInt(d.pageWrap.dataset.page, 10));
    if (!info) return;
    const wrapRect = d.pageWrap.getBoundingClientRect();
    const curX = Math.min(Math.max(e.clientX, wrapRect.left), wrapRect.right);
    const curY = Math.min(Math.max(e.clientY, wrapRect.top), wrapRect.bottom);
    const startX = Math.min(Math.max(d.startX, wrapRect.left), wrapRect.right);
    const startY = Math.min(Math.max(d.startY, wrapRect.top), wrapRect.bottom);

    const left = Math.min(startX, curX) - wrapRect.left;
    const top = Math.min(startY, curY) - wrapRect.top;
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);

    info.marqueeEl.style.left = left + 'px';
    info.marqueeEl.style.top = top + 'px';
    info.marqueeEl.style.width = width + 'px';
    info.marqueeEl.style.height = height + 'px';
    info.marqueeEl.style.display = 'block';

    d.rectPageRelative = { left, top, width, height };
  }

  _onPointerUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this._drag = null;

    const info = this.pageWraps.get(parseInt(d.pageWrap.dataset.page, 10));
    if (info) info.marqueeEl.style.display = 'none';

    if (!d.committed || !d.rectPageRelative) return; // tap, or a gesture we treated as scroll

    const result = this._computeSelectionFromRect(d.pageWrap, d.rectPageRelative);
    if (!result) return;

    const pageNum = parseInt(d.pageWrap.dataset.page, 10);
    this._selection = { page: pageNum, rects: result.rects, text: result.text, image: result.image || null };
    this._positionPullBtn(d.pageWrap, result.rects);
    if (this.onSelectionReady) this.onSelectionReady(this._selection);
  }

  _cancelDrag() {
    if (this._drag) {
      const info = this.pageWraps.get(parseInt(this._drag.pageWrap.dataset.page, 10));
      if (info) info.marqueeEl.style.display = 'none';
    }
    this._drag = null;
  }

  // Finds every text span whose box substantially overlaps the dragged
  // rectangle, clusters them into visual rows (not DOM order), and builds
  // both the extracted text and one clean highlight rect per row.
  _computeSelectionFromRect(pageWrap, rect) {
    const wrapRect = pageWrap.getBoundingClientRect();
    const marquee = { left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height };
    const spans = pageWrap.querySelectorAll('.text-layer span');
    const hits = [];

    for (const span of spans) {
      const text = span.textContent;
      if (!text || !text.trim()) continue;
      const r = span.getBoundingClientRect();
      const left = r.left - wrapRect.left;
      const top = r.top - wrapRect.top;
      const right = r.right - wrapRect.left;
      const bottom = r.bottom - wrapRect.top;

      const overlapW = Math.max(0, Math.min(right, marquee.right) - Math.max(left, marquee.left));
      const overlapH = Math.max(0, Math.min(bottom, marquee.bottom) - Math.max(top, marquee.top));
      const spanArea = Math.max(1, (right - left) * (bottom - top));
      if ((overlapW * overlapH) / spanArea < OVERLAP_THRESHOLD) continue;

      hits.push({ text, left, top, right, bottom });
    }
    if (!hits.length) return this._imageFallbackSelection(pageWrap, rect, wrapRect);

    // Cluster into rows by vertical position, not DOM order — this is what
    // makes multi-column content (tables) come out in reading order.
    hits.sort((a, b) => a.top - b.top);
    const rows = [];
    for (const h of hits) {
      const rowHeight = h.bottom - h.top;
      let row = rows.find((r) => Math.abs(r.top - h.top) < rowHeight * 0.6);
      if (!row) {
        row = { top: h.top, bottom: h.bottom, items: [] };
        rows.push(row);
      }
      row.items.push(h);
      row.top = Math.min(row.top, h.top);
      row.bottom = Math.max(row.bottom, h.bottom);
    }
    rows.sort((a, b) => a.top - b.top);

    const textParts = [];
    const rects = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.left - b.left);
      let rowText = '';
      let prevRight = null;
      let rowLeft = Infinity;
      let rowRight = -Infinity;
      for (const item of row.items) {
        if (prevRight !== null && item.left - prevRight > 2) rowText += ' ';
        rowText += item.text;
        prevRight = item.right;
        rowLeft = Math.min(rowLeft, item.left);
        rowRight = Math.max(rowRight, item.right);
      }
      const trimmed = rowText.trim();
      if (!trimmed) continue;
      textParts.push(trimmed);
      rects.push({
        xPct: rowLeft / wrapRect.width,
        yPct: row.top / wrapRect.height,
        wPct: (rowRight - rowLeft) / wrapRect.width,
        hPct: (row.bottom - row.top) / wrapRect.height,
      });
    }
    if (!textParts.length) return this._imageFallbackSelection(pageWrap, rect, wrapRect);

    return { text: textParts.join(' ').replace(/\s+/g, ' ').trim(), rects };
  }

  // No text spans fell inside the drag — most likely a scanned/photographed
  // page with no extractable text at all, where the row-clustering logic
  // above has nothing to work with. Rather than silently discarding the
  // gesture (which reads as "the selection isn't working"), fall back to
  // treating the dragged rectangle itself as the excerpt and snapshotting
  // that region of the rendered page as an image, so scanned documents can
  // still be pulled onto the canvas and linked back to their exact page.
  _imageFallbackSelection(pageWrap, rect, wrapRect) {
    if (rect.width < 4 || rect.height < 4) return null; // too small to be a real drag
    const rectPct = {
      xPct: rect.left / wrapRect.width,
      yPct: rect.top / wrapRect.height,
      wPct: rect.width / wrapRect.width,
      hPct: rect.height / wrapRect.height,
    };
    const image = this._cropPageImage(pageWrap, rectPct);
    if (!image) return null;
    return { text: null, image, rects: [rectPct] };
  }

  // Crops the given percentage-rect out of a page's already-rendered canvas
  // and returns it as a PNG data URL. Uses the canvas's own native pixel
  // dimensions (not CSS/zoom-affected measurements) so the crop stays sharp
  // regardless of current zoom level.
  _cropPageImage(pageWrap, rectPct) {
    const srcCanvas = pageWrap.querySelector('canvas');
    if (!srcCanvas) return null;
    const sx = Math.round(rectPct.xPct * srcCanvas.width);
    const sy = Math.round(rectPct.yPct * srcCanvas.height);
    const sw = Math.max(1, Math.round(rectPct.wPct * srcCanvas.width));
    const sh = Math.max(1, Math.round(rectPct.hPct * srcCanvas.height));
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext('2d');
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    try {
      return out.toDataURL('image/png');
    } catch (err) {
      return null; // e.g. a tainted canvas — shouldn't happen for our own renders, but don't crash the gesture over it
    }
  }

  _positionPullBtn(pageWrap, rects) {
    if (!rects.length) return;
    const wrapRect = pageWrap.getBoundingClientRect();
    const readingRect = this.scrollHost.getBoundingClientRect();
    const first = rects[0];
    const firstTopClient = wrapRect.top + first.yPct * wrapRect.height;
    const firstLeftClient = wrapRect.left + first.xPct * wrapRect.width;
    const firstBottomClient = firstTopClient + first.hPct * wrapRect.height;

    const btnWidth = 150; // approx — clamped so it never runs off the right edge
    const left = Math.min(
      Math.max(8, firstLeftClient - readingRect.left),
      readingRect.width - btnWidth
    );
    // prefer just above the selection, but flip below it if that would go
    // off the top of the visible pane
    const aboveTop = firstTopClient - readingRect.top + this.scrollHost.scrollTop - 38;
    const top = aboveTop < this.scrollHost.scrollTop + 4
      ? firstBottomClient - readingRect.top + this.scrollHost.scrollTop + 8
      : aboveTop;
    this.pullBtn.style.left = left + 'px';
    this.pullBtn.style.top = top + 'px';
    this.pullBtn.style.display = 'flex';
  }

  clearSelectionUI() {
    this.pullBtn.style.display = 'none';
    this._selection = null;
    for (const [, info] of this.pageWraps) info.marqueeEl.style.display = 'none';
  }

  // Draw (or redraw) the highlight rects for a card onto its page.
  drawHighlight(card) {
    const info = this.pageWraps.get(card.page);
    if (!info || !card.rects) return;
    const existing = info.highlightLayer.querySelectorAll('[data-card="' + card.id + '"]');
    existing.forEach((n) => n.remove());
    card.rects.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'highlight-rect';
      el.dataset.card = card.id;
      el.style.left = (r.xPct * 100) + '%';
      el.style.top = (r.yPct * 100) + '%';
      el.style.width = (r.wPct * 100) + '%';
      el.style.height = (r.hPct * 100) + '%';
      el.addEventListener('click', () => {
        if (this.onHighlightClick) this.onHighlightClick(card);
      });
      info.highlightLayer.appendChild(el);
    });
  }

  // Wipe every highlight from every rendered page — used when switching
  // which notes canvas is active, since a different canvas means a
  // different set of cards (and thus highlights) apply to this PDF.
  clearAllHighlights() {
    for (const [, info] of this.pageWraps) info.highlightLayer.innerHTML = '';
  }

  removeHighlight(cardId, page) {
    const info = this.pageWraps.get(page);
    if (!info) return;
    info.highlightLayer.querySelectorAll('[data-card="' + cardId + '"]').forEach((n) => n.remove());
  }

  jumpToCard(card) {
    const info = this.pageWraps.get(card.page);
    if (!info) return;
    info.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const rects = info.highlightLayer.querySelectorAll('[data-card="' + card.id + '"]');
    rects.forEach((el) => {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }
}
