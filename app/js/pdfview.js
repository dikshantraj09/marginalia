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
    this.onZoomChange = null; // (zoom) => void — fired on every zoom change, including from pinch, not just zoomIn()/zoomOut()
    this.pageWraps = new Map(); // pageNum -> wrap el
    this.pdf = null;
    this._selection = null;
    this.zoom = 1;
    this._searchMatches = [];
    this._searchIndex = -1;

    this._drag = null; // active marquee gesture state, or null
    this._pointers = new Map(); // pointerId -> last known {x, y}, for every finger currently down
    this._pinch = null; // active two-finger pinch-zoom gesture state, or null
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

    // Pages are rendered lazily (see _createPlaceholder/_ensureRendered):
    // this observer watches every placeholder with a large rootMargin so a
    // page's canvas + text layer get built well before it's actually
    // scrolled into view, not the instant it crosses the viewport edge.
    this._lazyObserver = new IntersectionObserver(
      (entries) => this._onLazyIntersect(entries),
      { root: this.scrollHost, rootMargin: '1600px 0px' }
    );
    this._textCache = new Map(); // pageNum -> lowercased full page text, built lazily for search
    this._searchToken = 0; // bumped on every search()/load() so a stale in-flight search can bail out
  }

  async load(arrayBuffer) {
    this.container.innerHTML = '';
    this.pageWraps.clear();
    this._visibility.clear();
    this._pageObserver.disconnect();
    this._lazyObserver.disconnect();
    this._cancelDrag();
    this._pinch = null;
    this._pointers.clear();
    this._textCache.clear();
    this._searchToken++;
    this.clearSearch();
    this.zoom = 1;
    this.container.style.zoom = 1;
    try {
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      this.pdf = await loadingTask.promise;

      // Every placeholder is sized from page 1's viewport as a uniform
      // estimate — fetching each page's own viewport up front would mean
      // touching all 700+ pages before the document is usable at all, which
      // is the exact problem this refactor exists to avoid. A page that
      // turns out a different size self-corrects (see _doRenderPage) once
      // it's actually rendered, which can nudge the scroll position slightly
      // for that one page — a minor, rare trade-off against "the app is
      // unusable for four minutes on a 700-page PDF."
      const firstPage = await this.pdf.getPage(1);
      const baseViewport = firstPage.getViewport({ scale: 1 });
      const cssScale = TARGET_PAGE_WIDTH / baseViewport.width;
      const estViewport = firstPage.getViewport({ scale: cssScale });

      for (let pageNum = 1; pageNum <= this.pdf.numPages; pageNum++) {
        this._createPlaceholder(pageNum, estViewport);
      }

      // Render the first page eagerly so the document is immediately usable
      // the moment load() resolves; the rest come in via the lazy observer
      // as they near the viewport (page 2 is kicked off right away too,
      // without blocking on it, since it's almost always visible at once).
      await this._ensureRendered(1);
      if (this.pdf.numPages > 1) this._ensureRendered(2);
    } catch (err) {
      console.error('Marginalia: failed to load PDF', err);
      this.container.innerHTML =
        '<div style="padding:24px;color:var(--danger);font-size:13px;max-width:420px;">' +
        "Couldn't open this PDF (" + (err && err.message ? err.message : 'unknown error') + '). ' +
        'Try re-importing the file, or a different PDF.</div>';
      throw err;
    }
  }

  // Cheap: just the DOM shell for a page, sized from the shared estimate.
  // No canvas, no text layer, no PDF.js page object touched yet — this is
  // what makes creating all 700+ of these upfront fast.
  _createPlaceholder(pageNum, viewport) {
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = pageNum;
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    wrap.appendChild(textLayerDiv);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    wrap.appendChild(highlightLayer);

    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee-box';
    wrap.appendChild(marqueeEl);

    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    wrap.appendChild(searchLayer);

    this.container.appendChild(wrap);
    const pageNumEl = document.createElement('div');
    pageNumEl.className = 'page-num';
    pageNumEl.textContent = '— ' + pageNum + ' —';
    this.container.appendChild(pageNumEl);

    // highlightLayer/searchLayer/marqueeEl exist from the start, so
    // drawHighlight/search/etc. work identically on a placeholder or a
    // fully rendered page — only the pixels (canvas) and selectable text
    // (text-layer spans) are actually deferred.
    this.pageWraps.set(pageNum, {
      wrap, viewport, highlightLayer, marqueeEl, searchLayer, textLayerDiv,
      page: null, rendered: false, renderPromise: null,
    });
    this._pageObserver.observe(wrap);
    this._lazyObserver.observe(wrap);
  }

  _onLazyIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageNum = parseInt(entry.target.dataset.page, 10);
      this._ensureRendered(pageNum);
    }
  }

  // Idempotent and safe to call multiple times concurrently for the same
  // page (search, the lazy observer, and jumpToCard can all want the same
  // page at once) — everyone gets the same in-flight promise.
  _ensureRendered(pageNum) {
    const info = this.pageWraps.get(pageNum);
    if (!info) return Promise.resolve();
    if (info.rendered) return Promise.resolve();
    if (info.renderPromise) return info.renderPromise;
    info.renderPromise = this._doRenderPage(pageNum, info).finally(() => {
      info.renderPromise = null;
    });
    return info.renderPromise;
  }

  async _doRenderPage(pageNum, info) {
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

    // Self-correct the placeholder if this page's real size differs from
    // the page-1 estimate it was created with.
    if (
      Math.abs(cssViewport.width - info.viewport.width) > 0.5 ||
      Math.abs(cssViewport.height - info.viewport.height) > 0.5
    ) {
      info.wrap.style.width = cssViewport.width + 'px';
      info.wrap.style.height = cssViewport.height + 'px';
      info.textLayerDiv.style.width = cssViewport.width + 'px';
      info.textLayerDiv.style.height = cssViewport.height + 'px';
    }
    info.viewport = cssViewport;

    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';
    // Canvas has to render behind the text layer/highlight/marquee/search
    // layers, same stacking order as before this was split in two.
    info.wrap.insertBefore(canvas, info.wrap.firstChild);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: info.textLayerDiv,
      viewport: cssViewport,
    });
    await textLayer.render();

    info.page = page;
    info.rendered = true;
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
    this._ensureRendered(pageNum);
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
    //
    // _updatePinch (below) deliberately sets its own scrollLeft/scrollTop
    // right after calling this, overriding this reset — that's the one
    // case where a non-zero, non-recentered scroll position is exactly the
    // point (keeping the pinch anchored under the fingers).
    this.scrollHost.scrollLeft = 0;
    if (this.onZoomChange) this.onZoomChange(this.zoom);
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
  // Every occurrence gets its own entry (one per matching span, same
  // granularity as before this file supported lazy rendering) — as long as
  // that stays cheap. It stops being cheap exactly when a document is huge
  // AND the term is common enough to match a large fraction of its pages
  // (e.g. "the" across all 700 pages of a scanned brief): rendering every
  // matched page just to enumerate its spans would reintroduce the same
  // eager-render-everything cost this whole refactor exists to avoid. See
  // RENDER_CAP below for the exact/coarse split this makes.

  // Fast text-only pass: page.getTextContent() without ever rasterizing a
  // canvas or building a text layer, to find which pages contain the term.
  // Cached per page so repeat searches (or Next after Prev) don't re-fetch.
  async search(term) {
    this.clearSearch();
    if (!term || !term.trim() || !this.pdf) {
      if (this.onSearchResults) this.onSearchResults(0, 0);
      return;
    }
    const lower = term.trim().toLowerCase();
    this._lastSearchTerm = lower;
    const token = ++this._searchToken;
    const numPages = this.pdf.numPages;
    const matchedPages = [];

    // On a large document the scan below can take a few seconds — long
    // enough that silence reads as "search is broken." Signal "searching"
    // immediately (a null total, by convention) so the toolbar can show
    // that instead of nothing.
    if (this.onSearchResults) this.onSearchResults(0, null);

    // Pages are fetched/text-extracted in small concurrent batches rather
    // than one at a time — pdf.js's worker pipelines overlapping requests,
    // so this cuts wall-clock time substantially over a strict sequential
    // await-per-page loop on a document with hundreds of pages.
    const BATCH_SIZE = 24;
    const textOf = async (pageNum) => {
      let text = this._textCache.get(pageNum);
      if (text === undefined) {
        try {
          const info = this.pageWraps.get(pageNum);
          const page = (info && info.page) || (await this.pdf.getPage(pageNum));
          const textContent = await page.getTextContent();
          text = textContent.items.map((it) => it.str).join(' ').toLowerCase();
        } catch (err) {
          text = '';
        }
        this._textCache.set(pageNum, text);
      }
      return text;
    };
    for (let start = 1; start <= numPages; start += BATCH_SIZE) {
      if (token !== this._searchToken) return; // superseded by a newer search or a fresh load()
      const batch = [];
      for (let pageNum = start; pageNum < start + BATCH_SIZE && pageNum <= numPages; pageNum++) batch.push(pageNum);
      const texts = await Promise.all(batch.map(textOf));
      batch.forEach((pageNum, i) => { if (texts[i].includes(lower)) matchedPages.push(pageNum); });
    }
    if (token !== this._searchToken) return;

    if (!matchedPages.length) {
      this._searchMatches = [];
      this._searchIndex = -1;
      if (this.onSearchResults) this.onSearchResults(0, 0);
      return;
    }

    // Typical case (and always true for anything but a large document with
    // a very common term): render every matched page and enumerate its real
    // spans, so Enter/Next cycles through every actual occurrence, exactly
    // as before lazy rendering existed.
    const RENDER_CAP = 60;
    if (matchedPages.length <= RENDER_CAP) {
      for (const pageNum of matchedPages) {
        await this._ensureRendered(pageNum);
        if (token !== this._searchToken) return;
      }
      for (const pageNum of matchedPages) {
        const info = this.pageWraps.get(pageNum);
        if (!info) continue;
        const spans = info.wrap.querySelectorAll('.text-layer span');
        spans.forEach((span) => {
          if (span.textContent.toLowerCase().includes(lower)) {
            this._searchMatches.push({ page: pageNum, span });
          }
        });
      }
    } else {
      // Too many matched pages to render eagerly without reintroducing the
      // original hang — fall back to one entry per PAGE (not occurrence),
      // with the span resolved lazily as each page is actually visited
      // (see _resolveMatch, shared with nextMatch/prevMatch).
      this._searchMatches = matchedPages.map((pageNum) => ({ page: pageNum, span: null }));
      await this._resolveMatch(0);
      if (token !== this._searchToken) return;
    }

    this._searchIndex = this._searchMatches.length ? 0 : -1;
    this._renderSearchHighlights();
    if (this.onSearchResults) this.onSearchResults(this._searchMatches.length ? 1 : 0, this._searchMatches.length);
    if (this._searchMatches.length) this._scrollToMatch(0);
  }

  // Renders the page for _searchMatches[i] (if it isn't already) and finds
  // the actual span the term appears in on that page, so it can be
  // highlighted/scrolled to precisely rather than just landing on the page.
  async _resolveMatch(i) {
    const m = this._searchMatches[i];
    if (!m || m.span) return;
    await this._ensureRendered(m.page);
    const info = this.pageWraps.get(m.page);
    if (!info) return;
    const spans = info.wrap.querySelectorAll('.text-layer span');
    for (const span of spans) {
      if (span.textContent.toLowerCase().includes(this._lastSearchTerm)) {
        m.span = span;
        break;
      }
    }
  }

  async nextMatch() {
    if (!this._searchMatches.length) return;
    this._searchIndex = (this._searchIndex + 1) % this._searchMatches.length;
    const token = this._searchToken;
    await this._resolveMatch(this._searchIndex);
    if (token !== this._searchToken) return;
    this._renderSearchHighlights();
    this._scrollToMatch(this._searchIndex);
    if (this.onSearchResults) this.onSearchResults(this._searchIndex + 1, this._searchMatches.length);
  }

  async prevMatch() {
    if (!this._searchMatches.length) return;
    this._searchIndex = (this._searchIndex - 1 + this._searchMatches.length) % this._searchMatches.length;
    const token = this._searchToken;
    await this._resolveMatch(this._searchIndex);
    if (token !== this._searchToken) return;
    this._renderSearchHighlights();
    this._scrollToMatch(this._searchIndex);
    if (this.onSearchResults) this.onSearchResults(this._searchIndex + 1, this._searchMatches.length);
  }

  clearSearch() {
    this._searchToken++; // cancel any in-flight search() pass
    this._searchMatches = [];
    this._searchIndex = -1;
    for (const [, info] of this.pageWraps) info.searchLayer.innerHTML = '';
  }

  _renderSearchHighlights() {
    for (const [, info] of this.pageWraps) info.searchLayer.innerHTML = '';
    this._searchMatches.forEach((m, i) => {
      if (!m.span) return; // not resolved yet (page not visited) — see _resolveMatch
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
    if (!m.span) {
      // _resolveMatch couldn't find/render the exact span (shouldn't
      // normally happen since callers await it first) — fall back to just
      // bringing the page into view.
      const info = this.pageWraps.get(m.page);
      if (info) info.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    // Not scrollIntoView: with overflow-x set on this pane (for wide pages
    // at high zoom — see setZoom above), its default `inline: 'nearest'`
    // can also scroll horizontally to bring a match into view, visibly
    // shifting the page sideways on every Enter press. Scroll vertically
    // only, by exactly the offset needed, and leave scrollLeft alone.
    const hostRect = this.scrollHost.getBoundingClientRect();
    const spanRect = m.span.getBoundingClientRect();
    const delta = (spanRect.top + spanRect.height / 2) - (hostRect.top + hostRect.height / 2);
    this.scrollHost.scrollBy({ top: delta, behavior: 'smooth' });
  }

  // ---------- marquee selection ----------
  // One finger drags a selection marquee (below); a second finger arriving
  // mid-gesture means this was actually a pinch, not a selection — see
  // _beginPinch/_updatePinch further down.

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // left click / primary touch only
    if (e.target.closest('.highlight-rect')) return; // let its own click (jump to card) fire
    if (e.target.closest('.pull-btn')) return;
    const pageWrap = e.target.closest('.pdf-page-wrap');

    if (this._pointers.size === 0) {
      // The first finger/pointer of a gesture must land on an actual
      // rendered page — same requirement as before this method tracked
      // multiple pointers, and what makes a stray tap on the pane's margin
      // a no-op.
      if (!pageWrap || !this.container.contains(pageWrap)) return;
    } else if (!this.scrollHost.contains(e.target)) {
      return; // a stray extra pointer outside the reading pane entirely
    }

    // Without this, a fast or wide drag that carries the pointer off the
    // rendered page (into the pane's margin, past the page edge, or briefly
    // over a sibling element) stops delivering move/up events to this
    // container the instant the pointer leaves it — the drag would just
    // silently stop tracking, which reads as the selection "getting stuck."
    // Capturing to the element that received pointerdown keeps every
    // subsequent event for this gesture routed here regardless of where the
    // pointer physically travels.
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* not critical if unsupported */ }
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 1) {
      this._drag = {
        pointerId: e.pointerId,
        pageWrap,
        startX: e.clientX,
        startY: e.clientY,
        committed: false, // becomes true once movement crosses DRAG_THRESHOLD and we decide it's a selection, not a scroll
        aborted: false, // true once we've decided this gesture is a scroll and should be left alone
      };
    } else if (this._pointers.size === 2) {
      // A second finger means this is actually a pinch — drop whatever
      // marquee state the first finger had started (its marquee box, if
      // any, along with the selection UI) and switch gestures entirely.
      this._cancelDrag();
      this._beginPinch();
    }
  }

  _onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pinch) {
      e.preventDefault();
      this._updatePinch();
      return;
    }

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

    // left/top/width/height above are screen-space (post-zoom) pixel
    // deltas from getBoundingClientRect(). marqueeEl lives inside
    // this.container, which has the reading pane's own CSS `zoom` applied
    // (see setZoom) — so a plain `Npx` written here gets RE-multiplied by
    // that zoom when the browser renders it, landing the visible box at
    // N*zoom screen pixels instead of N, growing further from the cursor
    // the more the page is zoomed in. Dividing by zoom here cancels that
    // out so the box ends up exactly under the drag regardless of zoom
    // level. d.rectPageRelative (used only for the actual selection-rect
    // math in _computeSelectionFromRect, never assigned to a style) stays
    // in plain screen-space — that math already compares two
    // getBoundingClientRect() results against each other consistently, so
    // it doesn't go through this zoom-rescaling at all.
    info.marqueeEl.style.left = (left / this.zoom) + 'px';
    info.marqueeEl.style.top = (top / this.zoom) + 'px';
    info.marqueeEl.style.width = (width / this.zoom) + 'px';
    info.marqueeEl.style.height = (height / this.zoom) + 'px';
    info.marqueeEl.style.display = 'block';

    d.rectPageRelative = { left, top, width, height };
  }

  _onPointerUp(e) {
    this._pointers.delete(e.pointerId);

    if (this._pinch) {
      // Lifting one finger ends the pinch rather than snapping into a
      // one-finger drag from that finger's unrelated starting point — the
      // remaining finger just needs a fresh pointerdown to do anything.
      if (this._pointers.size < 2) this._pinch = null;
      return;
    }

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

  // ---------- pinch-to-zoom ----------
  // Two fingers pinching zoom the page in/out around the pinch's own
  // midpoint (and pan with it, if the fingers also drag together) — the
  // same anchor-preserving approach as the notes canvas's pinch handling
  // in canvas.js, adapted to how zoom works here: `setZoom` scales
  // `this.container` via CSS `zoom`, and the reading pane scrolls it
  // natively (`this.scrollHost`), so "the point under the fingers" is
  // expressed in scrollLeft/scrollTop rather than a translate() pan.

  _beginPinch() {
    const ids = [...this._pointers.keys()].slice(0, 2);
    const pts = ids.map((id) => this._pointers.get(id));
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    // The reading pane doesn't move during the gesture, so its screen rect
    // is a valid, constant reference for the whole pinch.
    const hostRect = this.scrollHost.getBoundingClientRect();
    this._pinch = {
      ids,
      startDist: dist,
      startZoom: this.zoom,
      hostRect,
      // The pre-zoom ("un-scaled") position of whatever point was under
      // the pinch's midpoint when it started, held fixed and used on every
      // move to recompute the scroll offset that keeps that same point
      // under the fingers as they spread, pinch, or drag together.
      worldX: (this.scrollHost.scrollLeft + (mid.x - hostRect.left)) / this.zoom,
      worldY: (this.scrollHost.scrollTop + (mid.y - hostRect.top)) / this.zoom,
    };
  }

  _updatePinch() {
    const p = this._pinch;
    const pts = p.ids.map((id) => this._pointers.get(id));
    if (pts.some((pt) => !pt)) { this._pinch = null; return; } // a tracked pointer vanished without an up event
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    // setZoom resets scrollLeft to 0 as a side effect (see its own comment
    // — that's the fix for the unrelated search-jump bug), so the
    // pinch-anchored scroll position below has to be set AFTER calling it,
    // not before, to actually take effect.
    const newZoom = this.setZoom(p.startZoom * (dist / p.startDist));
    this.scrollHost.scrollLeft = p.worldX * newZoom - (mid.x - p.hostRect.left);
    this.scrollHost.scrollTop = p.worldY * newZoom - (mid.y - p.hostRect.top);
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
      // Keep whitespace-only spans too: PDF.js's TextLayer renders a real
      // space character from the source text as its own <span> with its own
      // position, even when the visual pixel gap between the glyphs on
      // either side of it is ~0 (common in badly-calibrated OCR text
      // layers, where word-spacing metrics are wrong but the space
      // character itself is still present in the underlying text). Only
      // the fully-empty string (no textContent at all) is skipped.
      if (!text) continue;
      const r = span.getBoundingClientRect();
      const left = r.left - wrapRect.left;
      const top = r.top - wrapRect.top;
      const right = r.right - wrapRect.left;
      const bottom = r.bottom - wrapRect.top;

      const overlapW = Math.max(0, Math.min(right, marquee.right) - Math.max(left, marquee.left));
      const overlapH = Math.max(0, Math.min(bottom, marquee.bottom) - Math.max(top, marquee.top));
      const spanArea = Math.max(1, (right - left) * (bottom - top));
      if ((overlapW * overlapH) / spanArea < OVERLAP_THRESHOLD) continue;

      hits.push({ text, left, top, right, bottom, isSpace: !text.trim() });
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
        // Prefer the explicit space span the text layer already gave us
        // (see the loop above) over guessing from pixel gaps — a >2px gap
        // check as a backstop only, and only when it wouldn't duplicate a
        // space that's already there, for the rare case of two adjacent
        // non-space items with no space item between them at all (e.g.
        // table cells laid out as separate text runs).
        if (prevRight !== null && !item.isSpace && item.left - prevRight > 2 && !/\s$/.test(rowText)) {
          rowText += ' ';
        }
        rowText += item.text;
        prevRight = item.right;
        if (!item.isSpace) {
          rowLeft = Math.min(rowLeft, item.left);
          rowRight = Math.max(rowRight, item.right);
        }
      }
      const trimmed = rowText.replace(/\s+/g, ' ').trim();
      if (!trimmed || rowLeft === Infinity) continue;
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

  async jumpToCard(card) {
    const info = this.pageWraps.get(card.page);
    if (!info) return;
    info.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // The target page may still be an unrendered placeholder (far outside
    // the lazy observer's margin) — force it to render now rather than
    // waiting for the scroll to carry it into that margin naturally, so the
    // flash below isn't racing an empty page.
    await this._ensureRendered(card.page);
    const rects = info.highlightLayer.querySelectorAll('[data-card="' + card.id + '"]');
    rects.forEach((el) => {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }
}
