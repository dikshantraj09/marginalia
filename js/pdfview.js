// Renders a PDF into the reading pane: page canvases + selectable text layer +
// a highlight overlay for excerpts pulled onto the notes canvas.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdfjs/pdf.worker.min.mjs';

const RENDER_SCALE = 1.5;

export default class PdfView {
  constructor(container, pullBtn, onSelectionReady, onHighlightClick) {
    this.container = container; // holds rendered pages — cleared/rebuilt on each load()
    this.scrollHost = container.closest('.reading') || container.parentElement; // scrollable ancestor, used for measurement
    this.pullBtn = pullBtn;
    this.onSelectionReady = onSelectionReady;
    this.onHighlightClick = onHighlightClick;
    this.pageWraps = new Map(); // pageNum -> wrap el
    this.pdf = null;
    this._selection = null;

    document.addEventListener('selectionchange', () => this._handleSelectionChange());
  }

  async load(arrayBuffer) {
    this.container.innerHTML = '';
    this.pageWraps.clear();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    this.pdf = await loadingTask.promise;

    for (let pageNum = 1; pageNum <= this.pdf.numPages; pageNum++) {
      await this._renderPage(pageNum);
    }
  }

  async _renderPage(pageNum) {
    const page = await this.pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = pageNum;
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    wrap.appendChild(textLayerDiv);

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    wrap.appendChild(highlightLayer);

    this.container.appendChild(wrap);
    const pageNumEl = document.createElement('div');
    pageNumEl.className = 'page-num';
    pageNumEl.textContent = '— ' + pageNum + ' —';
    this.container.appendChild(pageNumEl);

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    this.pageWraps.set(pageNum, { wrap, viewport, highlightLayer, page });
  }

  _handleSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.pullBtn.style.display = 'none';
      this._selection = null;
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container.nodeType === 1 ? container : container.parentElement;
    const pageWrap = el ? el.closest('.pdf-page-wrap') : null;
    if (!pageWrap || !this.container.contains(pageWrap)) {
      this.pullBtn.style.display = 'none';
      this._selection = null;
      return;
    }

    const pageNum = parseInt(pageWrap.dataset.page, 10);
    const wrapRect = pageWrap.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects());
    if (!clientRects.length) return;

    // store rects as percentages of the page so they survive re-render/zoom
    const rects = clientRects.map((r) => ({
      xPct: (r.left - wrapRect.left) / wrapRect.width,
      yPct: (r.top - wrapRect.top) / wrapRect.height,
      wPct: r.width / wrapRect.width,
      hPct: r.height / wrapRect.height,
    }));

    const text = this._extractText(range, pageWrap).trim();
    if (!text) { this.pullBtn.style.display = 'none'; return; }

    this._selection = { page: pageNum, rects, text };

    const readingRect = this.scrollHost.getBoundingClientRect();
    const firstRect = clientRects[0];
    this.pullBtn.style.left = Math.max(8, firstRect.left - readingRect.left) + 'px';
    this.pullBtn.style.top = (firstRect.top - readingRect.top + this.scrollHost.scrollTop - 38) + 'px';
    this.pullBtn.style.display = 'flex';

    if (this.onSelectionReady) this.onSelectionReady(this._selection);
  }

  // PDF text layers rarely encode an explicit space at a line wrap, so a
  // plain range.toString() often glues the last word of one line to the
  // first word of the next. Rebuild the string span-by-span instead, and
  // insert a space whenever a new line (new vertical position) starts.
  _extractText(range, pageWrap) {
    const spans = Array.from(pageWrap.querySelectorAll('.text-layer span'));
    const parts = [];
    let lastTop = null;
    for (const span of spans) {
      if (!range.intersectsNode(span)) continue;
      let text = span.textContent;
      if (span.contains(range.startContainer) && range.startContainer.nodeType === 3) {
        text = span.textContent.slice(range.startOffset);
      }
      if (span.contains(range.endContainer) && range.endContainer.nodeType === 3) {
        const endOffset = span.contains(range.startContainer) && range.startContainer === range.endContainer
          ? range.endOffset - range.startOffset
          : range.endOffset;
        text = text.slice(0, endOffset);
      }
      if (!text) continue;
      const top = span.getBoundingClientRect().top;
      if (lastTop !== null && Math.abs(top - lastTop) > 2 && parts.length) {
        parts.push(' ');
      }
      parts.push(text);
      lastTop = top;
    }
    return parts.join('').replace(/\s+/g, ' ');
  }

  clearSelectionUI() {
    this.pullBtn.style.display = 'none';
    window.getSelection().removeAllRanges();
    this._selection = null;
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
