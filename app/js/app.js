import DB from './db.js';
import Rail from './rail.js';
import PdfView from './pdfview.js';
import NotesCanvas from './canvas.js';
import Tour from './tour.js';
import { showAlert } from './modal.js';

const readingEl = document.getElementById('reading');
const pdfPagesEl = document.getElementById('pdfPages');
const readingEmptyEl = document.getElementById('readingEmpty');
const pullBtn = document.getElementById('pullBtn'); // the floating group container — positioned/shown by PdfView, same as before
const pullTextBtn = document.getElementById('pullTextBtn');
const pullImageBtn = document.getElementById('pullImageBtn');
const docTitleEl = document.getElementById('docTitle');
const pdfToolbar = document.getElementById('pdfToolbar');
const tocToggle = document.getElementById('tocToggle');
const tocClose = document.getElementById('tocClose');
const tocBackdrop = document.getElementById('tocBackdrop');
const tocPanel = document.getElementById('tocPanel');
const tocListEl = document.getElementById('tocList');
const tocTabContents = document.getElementById('tocTabContents');
const tocTabBookmarks = document.getElementById('tocTabBookmarks');
const bookmarksListEl = document.getElementById('bookmarksList');
const bookmarkPageToggle = document.getElementById('bookmarkPageToggle');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomInBtn = document.getElementById('zoomIn');
const zoomLevelEl = document.getElementById('zoomLevel');
const prevPageBtn = document.getElementById('prevPage');
const nextPageBtn = document.getElementById('nextPage');
const pageInput = document.getElementById('pageInput');
const pageCountEl = document.getElementById('pageCount');
const searchInput = document.getElementById('searchInput');
const searchCountEl = document.getElementById('searchCount');
const searchPrevBtn = document.getElementById('searchPrev');
const searchNextBtn = document.getElementById('searchNext');
const searchCloseBtn = document.getElementById('searchClose');
const canvasTitleEl = document.getElementById('canvasTitle');
const canvasEl = document.getElementById('canvas');
const canvasInnerEl = document.getElementById('canvasInner');
const canvasEmptyEl = document.getElementById('canvasEmpty');
const linkGroupEl = document.getElementById('linkGroup');
const railEl = document.getElementById('rail');
const railToggle = document.getElementById('railToggle');
const importBtn = document.getElementById('importBtn');
const emptyImportBtn = document.getElementById('emptyImportBtn');
const fileInput = document.getElementById('fileInput');
const themeToggle = document.getElementById('themeToggle');
const tourHelpBtn = document.getElementById('tourHelpBtn');
const bodyRowEl = document.getElementById('bodyRow');
const canvasWrapEl = document.getElementById('canvasWrap');
const canvasCollapseBtn = document.getElementById('canvasCollapseBtn');
const canvasExportBtn = document.getElementById('canvasExportBtn');
const canvasZoomOutBtn = document.getElementById('canvasZoomOut');
const canvasZoomInBtn = document.getElementById('canvasZoomIn');
const canvasZoomLevelEl = document.getElementById('canvasZoomLevel');
const canvasExpandTab = document.getElementById('canvasExpandTab');

// A PDF (currentDocId) and a notes canvas (currentCanvasId) are opened
// independently — a canvas can hold excerpts pulled from more than one PDF,
// so opening one doesn't imply or require the other.
let currentDocId = null;
let currentCanvasId = null;

const pdfView = new PdfView(
  pdfPagesEl,
  pullBtn,
  () => {}, // pullBtn positioning is handled internally by PdfView
  (card) => pdfView.jumpToCard(card) // clicking a highlight in the page just flashes it
);
pdfView.onPageChange = (pageNum) => {
  if (document.activeElement !== pageInput) pageInput.value = pageNum;
  refreshBookmarkStar();
};
pdfView.onSearchResults = (active, total) => {
  if (total === null) { searchCountEl.textContent = 'Searching…'; return; } // large-doc scan in progress
  searchCountEl.textContent = total ? active + ' / ' + total : (searchInput.value.trim() ? '0 / 0' : '');
};
// Keeps the toolbar's zoom readout in sync with pinch-zoom too, not just
// the +/- buttons (which already set this same text directly, redundantly
// but harmlessly, on click).
pdfView.onZoomChange = (z) => { zoomLevelEl.textContent = Math.round(z * 100) + '%'; };

const canvas = new NotesCanvas(canvasEl, canvasInnerEl, linkGroupEl, canvasEmptyEl, {
  onCardAdded: (card) => DB.put('cards', card),
  onCardChanged: (card) => DB.put('cards', card),
  onCardRemoved: async (id) => {
    await DB.delete('cards', id);
    for (const [pageNum] of pdfView.pageWraps) pdfView.removeHighlight(id, pageNum);
    // an orphaned link (pointing at a card that no longer exists) is dead
    // weight in storage — clean it up rather than let it accumulate
    const links = await DB.byIndex('links', 'canvasId', currentCanvasId);
    for (const l of links) {
      if (l.a === id || l.b === id) await DB.delete('links', l.id);
    }
  },
  onCardClick: (card) => jumpToCard(card),
  onLinkAdded: (link) => DB.put('links', { ...link, canvasId: currentCanvasId }),
  onLinkChanged: (link) => DB.put('links', { ...link, canvasId: currentCanvasId }),
  onLinkRemoved: (linkId) => DB.delete('links', linkId),
  onZoomChange: (z) => { canvasZoomLevelEl.textContent = Math.round(z * 100) + '%'; },
});

const rail = new Rail(railEl, {
  onOpenDoc: (docId) => openDocument(docId),
  onOpenCanvas: (canvasId) => openCanvas(canvasId),
  onDocDeleted: async (docId) => {
    if (currentCanvasId) canvas.removeCardsByDoc(docId);
    if (docId === currentDocId) closeDocument();
    const orphaned = await DB.byIndex('bookmarks', 'docId', docId);
    for (const bm of orphaned) await DB.delete('bookmarks', bm.id);
  },
  onCanvasDeleted: (canvasId) => {
    if (canvasId === currentCanvasId) closeCanvas();
  },
  onDocRenamed: (doc) => {
    if (doc.id === currentDocId) docTitleEl.textContent = doc.name;
    if (currentCanvasId) canvas.renameDocOnCards(doc.id, doc.name);
  },
  onCanvasRenamed: (cv) => {
    if (cv.id === currentCanvasId) canvasTitleEl.textContent = cv.name;
  },
});

// -------- opening / closing documents & canvases --------

async function openDocument(docId) {
  const doc = await DB.get('documents', docId);
  if (!doc) return;
  currentDocId = docId;
  rail.setActiveDoc(docId);
  readingEmptyEl.style.display = 'none';
  docTitleEl.textContent = doc.name;

  const buffer = doc.blob.slice(0); // ArrayBuffer copy since pdf.js detaches it
  try {
    await pdfView.load(buffer);
    await refreshHighlights();
    pdfToolbar.classList.add('visible');
    const count = pdfView.getPageCount();
    pageCountEl.textContent = count;
    pageInput.value = 1;
    // pdfView.load() already reset zoom to 100%, which is the right default
    // on desktop/tablet — but a page rendered at its native ~640px CSS
    // width is wider than the entire phone viewport, so at 100% the user
    // opens a document to find its first lines sliced off the right edge
    // with nothing to indicate the page can be scrolled sideways to see the
    // rest. Fit the page to whatever width is actually available instead,
    // so the whole page is visible (and readable) the moment it opens; the
    // zoom controls still work normally from there for reading up close.
    if (isStacked()) {
      const available = pdfView.scrollHost.clientWidth - 52; // minus reading-scroll's 26px side padding
      pdfView.setZoom(Math.max(0.5, Math.min(1, available / 640)));
    } else {
      zoomLevelEl.textContent = '100%';
    }
    searchInput.value = '';
    searchCountEl.textContent = '';
    await populateToc();
    await loadBookmarks(docId);
  } catch (err) {
    // pdfView already shows an inline error in the reading pane
    pdfToolbar.classList.remove('visible');
  }
  if (window.innerWidth <= 900) railEl.classList.remove('open');
}

function closeDocument() {
  currentDocId = null;
  docTitleEl.textContent = 'No document open';
  pdfPagesEl.innerHTML = '';
  readingEmptyEl.style.display = 'flex';
  rail.setActiveDoc(null);
  pdfToolbar.classList.remove('visible');
  closeToc();
  loadBookmarks(null);
}

async function openCanvas(canvasId) {
  const cv = await DB.get('canvases', canvasId);
  if (!cv) return;
  currentCanvasId = canvasId;
  rail.setActiveCanvas(canvasId);
  canvasTitleEl.textContent = cv.name;

  const [cardRecords, linkRecords] = await Promise.all([
    DB.byIndex('cards', 'canvasId', canvasId),
    DB.byIndex('links', 'canvasId', canvasId),
  ]);
  const links = linkRecords.map((l) => ({ id: l.id, a: l.a, b: l.b, type: l.type || null }));
  canvas.setCanvas(canvasId, cardRecords, links);
  // setCanvas() above always resets to 100% — the right call on desktop,
  // where a 200px-wide card is a normal size against a canvas that's
  // usually 800px+. On a phone-width screen that same card renders at
  // barely half the screen's width, so opening Notes shows one narrow
  // column of tiny text with a wide, empty (if visually consistent) dot
  // grid on either side — cards aren't unusably small so much as the
  // default zoom just isn't sized for how much of the screen is actually
  // available. Scale up so a card comfortably fills most of the width
  // instead of requiring a pinch-zoom before the first note is readable.
  if (isStacked()) {
    const available = canvas.canvasEl.clientWidth;
    canvas.setZoom(Math.min(2, Math.max(1, (available * 0.82) / 200)));
  }
  await refreshHighlights();
}

function closeCanvas() {
  currentCanvasId = null;
  canvasTitleEl.textContent = 'Notes';
  canvas.setCanvas(null, [], []);
  pdfView.clearAllHighlights();
}

// Highlights shown on the PDF page are exactly: cards in the *currently
// open canvas* that were pulled from the *currently open PDF*. Recompute
// this whenever either side changes.
async function refreshHighlights() {
  pdfView.clearAllHighlights();
  if (!currentDocId || !currentCanvasId) return;
  canvas.cards.filter((c) => c.docId === currentDocId).forEach((c) => pdfView.drawHighlight(c));
}

async function jumpToCard(card) {
  if (card.docId !== currentDocId) {
    const doc = await DB.get('documents', card.docId);
    if (!doc) { alert('That PDF isn\'t available anymore.'); return; }
    await openDocument(card.docId);
  }
  pdfView.jumpToCard(card);
}

async function getOrCreateActiveCanvas() {
  if (currentCanvasId) return currentCanvasId;
  // Friction-free default: the first time you pull an excerpt with no
  // canvas open, we start one for you instead of blocking on a prompt.
  const cv = { id: DB.uid('cv'), name: 'My notes', folderId: null, createdAt: Date.now() };
  await DB.put('canvases', cv);
  await rail.addCanvasSilently(cv);
  await openCanvas(cv.id);
  return cv.id;
}

// -------- pulling an excerpt onto the canvas --------
// Two options on the same floating button group: pull the extracted text
// (falls back to an image automatically if the page has no text layer —
// e.g. a scanned page), or force an image snapshot of the exact dragged
// region regardless of what text extraction found — useful on documents
// like this one, where the text layer exists but its OCR is bad enough
// that a picture of the original is more useful than the text would be.

async function pullSelection({ asImage }) {
  const sel = pdfView._selection;
  if (!sel || !currentDocId) return;
  const doc = await DB.get('documents', currentDocId);
  await getOrCreateActiveCanvas();
  const image = asImage ? (pdfView.captureSelectionImage() || sel.image) : sel.image;
  const card = canvas.addExcerptCard({
    docId: currentDocId,
    docName: doc ? doc.name : '',
    page: sel.page,
    rects: sel.rects,
    text: asImage ? null : sel.text,
    image,
  });
  pdfView.drawHighlight(card);
  pdfView.clearSelectionUI();
}

pullTextBtn.addEventListener('mousedown', (e) => e.preventDefault());
pullImageBtn.addEventListener('mousedown', (e) => e.preventDefault());
pullTextBtn.addEventListener('click', () => pullSelection({ asImage: false }));
pullImageBtn.addEventListener('click', () => pullSelection({ asImage: true }));

// -------- importing PDFs --------

// Nothing here previously caught a failure, so the two realistic ways this
// can go wrong both failed silently: picking a file the browser can't read
// back as bytes (rare — a permissions error, a file that vanished after the
// picker closed), and IndexedDB refusing the write because the browser's
// storage quota for this origin is full (a large PDF is exactly the case
// most likely to hit that). Either way `importPdf` used to just reject with
// nothing awaiting it — an unhandled promise rejection, invisible to the
// person who clicked Import and is now looking at a picker that closed and
// nothing else happening. Route both into the one error-dialog pattern this
// app already has (modal.js) rather than inventing a second one.
async function importPdf(file) {
  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (err) {
    await showAlert('Couldn’t read "' + file.name + '". Try importing it again.');
    return;
  }
  const doc = { id: DB.uid('doc'), name: file.name, folderId: null, createdAt: Date.now(), blob: arrayBuffer };
  try {
    await DB.put('documents', doc);
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      await showAlert(
        'Your browser’s storage is full, so "' + file.name + '" couldn’t be saved. ' +
        'Everything in Marginalia lives only in this browser (see the storage indicator in the sidebar) ' +
        '— free up space by removing a PDF or notes canvas you no longer need, then try again.'
      );
    } else {
      await showAlert('Couldn’t save "' + file.name + '". Try importing it again.');
    }
    return;
  }
  await rail.addDocument(doc);
  await openDocument(doc.id);
}

importBtn.addEventListener('click', () => fileInput.click());
emptyImportBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) importPdf(file);
  fileInput.value = '';
});

railToggle.addEventListener('click', () => railEl.classList.toggle('open'));

// -------- folder rail collapse (desktop "just read" mode, mirrors the
// notes-panel collapse below) --------

const railCollapseBtn = document.getElementById('railCollapseBtn');
const railExpandTab = document.getElementById('railExpandTab');

function setRailCollapsed(collapsed) {
  // An inline width (set by dragging railResize below) beats the class
  // rule's `.rail.collapsed { width: 0 }` — inline style always wins over
  // any selector — so collapsing wouldn't visually do anything once the
  // rail had ever been manually resized. Clear it going in, restore
  // whatever was saved going back out.
  if (collapsed) {
    railEl.style.width = '';
  } else {
    try {
      const rw = parseFloat(localStorage.getItem('marginalia-rail-width'));
      if (rw) railEl.style.width = rw + 'px';
    } catch (err) { /* ignore */ }
  }
  railEl.classList.toggle('collapsed', collapsed);
  bodyRowEl.classList.toggle('rail-collapsed', collapsed);
  try { localStorage.setItem('marginalia-rail-collapsed', collapsed ? '1' : '0'); } catch (err) { /* ignore */ }
}
(function initRailCollapsed() {
  let saved = null;
  try { saved = localStorage.getItem('marginalia-rail-collapsed'); } catch (err) { /* ignore */ }
  if (saved === '1') setRailCollapsed(true);
})();
railCollapseBtn.addEventListener('click', () => setRailCollapsed(true));
railExpandTab.addEventListener('click', () => setRailCollapsed(false));

// -------- resizable panes (rail | reading | notes) --------
// A drag handle between each pair of panes lets the person set their own
// split instead of living with the fixed 232px / ~48%-52% defaults. Only
// meaningful in the side-by-side layout — below the "stacked" breakpoint
// (see styles.css) reading and notes stack vertically and the rail becomes
// a full-height drawer, where a horizontal pixel width doesn't apply.

const railResizeEl = document.getElementById('railResize');
const canvasResizeEl = document.getElementById('canvasResize');
const stackQuery = window.matchMedia('(max-width: 640px)');
const isStacked = () => stackQuery.matches;

function wirePaneResize(handleEl, { getMin, getMax, onDrag, onEnd }) {
  let dragging = false;
  handleEl.addEventListener('pointerdown', (e) => {
    if (isStacked() || e.button !== undefined && e.button !== 0) return;
    dragging = true;
    handleEl.classList.add('dragging');
    handleEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const min = getMin();
    const max = getMax();
    onDrag(Math.min(max, Math.max(min, e.clientX)));
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove('dragging');
    if (onEnd) onEnd();
  };
  handleEl.addEventListener('pointerup', stop);
  handleEl.addEventListener('pointercancel', stop);
}

wirePaneResize(railResizeEl, {
  getMin: () => railEl.getBoundingClientRect().left + 160,
  getMax: () => railEl.getBoundingClientRect().left + 420,
  onDrag: (clientX) => {
    railEl.style.width = (clientX - railEl.getBoundingClientRect().left) + 'px';
  },
  onEnd: () => {
    try { localStorage.setItem('marginalia-rail-width', Math.round(railEl.getBoundingClientRect().width)); } catch (err) { /* ignore */ }
  },
});

wirePaneResize(canvasResizeEl, {
  getMin: () => readingEl.getBoundingClientRect().left + 280,
  getMax: () => bodyRowEl.getBoundingClientRect().right - 280,
  onDrag: (clientX) => {
    readingEl.style.flex = '0 0 ' + (clientX - readingEl.getBoundingClientRect().left) + 'px';
  },
  onEnd: () => {
    try { localStorage.setItem('marginalia-reading-width', Math.round(readingEl.getBoundingClientRect().width)); } catch (err) { /* ignore */ }
  },
});

// Reapply a saved reading-pane width whenever the layout is side-by-side —
// on load, and again if the window widens back out of the stacked phone
// layout (where the inline flex-basis is cleared below, since a pixel
// WIDTH there would get reinterpreted as a HEIGHT once .body-row switches
// to flex-direction: column).
function applyReadingWidth() {
  if (isStacked()) {
    readingEl.style.flex = '';
    return;
  }
  try {
    const dw = parseFloat(localStorage.getItem('marginalia-reading-width'));
    if (dw) readingEl.style.flex = '0 0 ' + dw + 'px';
  } catch (err) { /* ignore */ }
}
applyReadingWidth();
stackQuery.addEventListener('change', (e) => {
  applyReadingWidth();
  // Rotating a phone from portrait to landscape (or resizing a window
  // across the 640px line with a document open) can cross into the
  // stacked layout after the doc already opened at desktop's 100% zoom —
  // refit it the same way openDocument() does initially, so the page
  // doesn't suddenly get clipped off the right edge.
  if (e.matches && currentDocId && pdfView.pdf) {
    const available = pdfView.scrollHost.clientWidth - 52;
    pdfView.setZoom(Math.max(0.5, Math.min(1, available / 640)));
  }
  if (e.matches && currentCanvasId) {
    const available = canvas.canvasEl.clientWidth;
    canvas.setZoom(Math.min(2, Math.max(1, (available * 0.82) / 200)));
  }
});

(function initRailWidth() {
  if (isStacked() || railEl.classList.contains('collapsed')) return;
  try {
    const rw = parseFloat(localStorage.getItem('marginalia-rail-width'));
    if (rw) railEl.style.width = rw + 'px';
  } catch (err) { /* ignore */ }
})();

// -------- notes panel collapse (a "just read" mode) --------

function setNotesCollapsed(collapsed) {
  canvasWrapEl.classList.toggle('collapsed', collapsed);
  bodyRowEl.classList.toggle('notes-collapsed', collapsed);
  // Dragging the reading/notes divider (wirePaneResize above) sets an
  // inline `flex: 0 0 <px>` directly on .reading, which — being inline —
  // outranks the CSS class rules either side of it here: neither the
  // default `.reading{flex:1 1 48%}` nor `.canvas-wrap.collapsed{flex:0 0
  // 0}` can override it. So collapsing Notes after ever resizing the
  // reading pane just shrank Notes to nothing while reading stayed pinned
  // at its last dragged width, leaving the freed space as a dead, empty
  // gap between the two — not actually part of either pane. Clearing the
  // inline width on collapse lets `.reading{flex:1 1 48%}` take over and
  // fill the row properly; reapplying the saved width on expand restores
  // the split exactly where the user left it.
  if (!isStacked()) {
    if (collapsed) {
      readingEl.style.flex = '';
    } else {
      applyReadingWidth();
    }
  }
  try { localStorage.setItem('marginalia-notes-collapsed', collapsed ? '1' : '0'); } catch (err) { /* ignore */ }
}
(function initNotesCollapsed() {
  let saved = null;
  try { saved = localStorage.getItem('marginalia-notes-collapsed'); } catch (err) { /* ignore */ }
  if (saved === '1') setNotesCollapsed(true);
})();
canvasCollapseBtn.addEventListener('click', () => setNotesCollapsed(true));
canvasExpandTab.addEventListener('click', () => setNotesCollapsed(false));

// -------- export link map --------

canvasExportBtn.addEventListener('click', () => {
  if (!currentCanvasId) return;
  const md = canvas.getLinkMapMarkdown(canvasTitleEl.textContent);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const name = (canvasTitleEl.textContent || 'link-map').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'link-map';
  a.href = url;
  a.download = name + '-link-map.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// -------- download the open PDF --------

downloadPdfBtn.addEventListener('click', async () => {
  if (!currentDocId) return;
  const doc = await DB.get('documents', currentDocId);
  if (!doc) return;
  // .slice(0): the stored ArrayBuffer must stay intact for next time this
  // doc is opened — pdf.js detaches whatever buffer it's handed, and a
  // Blob constructed from a later-detached buffer would go empty.
  const blob = new Blob([doc.blob.slice(0)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.name || 'document.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// -------- theme --------

const themeColorMeta = document.getElementById('themeColorMeta');
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  // Keeps the installed-PWA title bar / mobile status bar (and Safari's
  // tab bar) in step with the in-app toggle, rather than a static color
  // that only ever matched one theme.
  if (themeColorMeta) themeColorMeta.setAttribute('content', theme === 'dark' ? '#17150F' : '#F7F4EC');
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('marginalia-theme'); } catch (err) { /* private mode etc. */ }
  applyTheme(saved || 'light');
})();
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('marginalia-theme', next); } catch (err) { /* ignore */ }
});

// -------- table of contents --------

async function populateToc() {
  const outline = await pdfView.getOutline();
  tocListEl.innerHTML = '';
  if (!outline.length) {
    tocListEl.innerHTML = '<div class="toc-empty">This PDF has no table of contents.</div>';
    return;
  }
  const renderItems = async (items, depth) => {
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'toc-item';
      el.style.paddingLeft = (8 + depth * 14) + 'px';
      el.textContent = item.title || 'Untitled';
      el.addEventListener('click', async () => {
        const pageNum = await pdfView.resolveDestPage(item.dest);
        if (pageNum) pdfView.goToPage(pageNum);
        closeToc();
      });
      tocListEl.appendChild(el);
      if (item.items && item.items.length) await renderItems(item.items, depth + 1);
    }
  };
  await renderItems(outline, 0);
}

function openToc(tab) {
  tocPanel.classList.add('open');
  tocBackdrop.classList.add('open');
  if (tab) setTocTab(tab);
}
function closeToc() {
  tocPanel.classList.remove('open');
  tocBackdrop.classList.remove('open');
}
function setTocTab(tab) {
  const showBookmarks = tab === 'bookmarks';
  tocTabContents.classList.toggle('active', !showBookmarks);
  tocTabBookmarks.classList.toggle('active', showBookmarks);
  tocListEl.style.display = showBookmarks ? 'none' : '';
  bookmarksListEl.style.display = showBookmarks ? '' : 'none';
}
tocToggle.addEventListener('click', () => {
  tocPanel.classList.contains('open') ? closeToc() : openToc('contents');
});
tocTabContents.addEventListener('click', () => setTocTab('contents'));
tocTabBookmarks.addEventListener('click', () => setTocTab('bookmarks'));
tocClose.addEventListener('click', closeToc);
tocBackdrop.addEventListener('click', closeToc);

// -------- bookmarks --------
// Separate from the table of contents (which mirrors the PDF's own
// embedded outline, when it has one) — these are the reader's own saved
// pages, the way a browser bookmark works: no outline required, and it
// works even on documents (like scanned/OCR'd ones) that have no outline
// at all.

let currentBookmarks = [];

async function loadBookmarks(docId) {
  currentBookmarks = docId ? await DB.byIndex('bookmarks', 'docId', docId) : [];
  currentBookmarks.sort((a, b) => a.page - b.page);
  renderBookmarksList();
  refreshBookmarkStar();
}

function renderBookmarksList() {
  bookmarksListEl.innerHTML = '';
  if (!currentBookmarks.length) {
    bookmarksListEl.innerHTML = '<div class="toc-empty">No bookmarks yet — tap the ☆ in the toolbar to save a page.</div>';
    return;
  }
  for (const bm of currentBookmarks) {
    const el = document.createElement('div');
    el.className = 'bookmark-item';
    el.innerHTML =
      '<span class="page-tag">p.' + bm.page + '</span>' +
      '<span class="label"></span>' +
      '<span class="del" title="Remove bookmark">✕</span>';
    el.querySelector('.label').textContent = bm.label || ('Page ' + bm.page);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      pdfView.goToPage(bm.page);
      closeToc();
    });
    el.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await DB.delete('bookmarks', bm.id);
      currentBookmarks = currentBookmarks.filter((b) => b.id !== bm.id);
      renderBookmarksList();
      refreshBookmarkStar();
    });
    bookmarksListEl.appendChild(el);
  }
}

function currentPageNum() {
  return parseInt(pageInput.value, 10) || 1;
}

function refreshBookmarkStar() {
  const page = currentPageNum();
  const bookmarked = currentDocId && currentBookmarks.some((b) => b.page === page);
  bookmarkPageToggle.classList.toggle('active', !!bookmarked);
}

bookmarkPageToggle.addEventListener('click', async () => {
  if (!currentDocId) return;
  const page = currentPageNum();
  const existing = currentBookmarks.find((b) => b.page === page);
  if (existing) {
    await DB.delete('bookmarks', existing.id);
    currentBookmarks = currentBookmarks.filter((b) => b.id !== existing.id);
  } else {
    const bm = { id: DB.uid('bm'), docId: currentDocId, page, label: '', createdAt: Date.now() };
    await DB.put('bookmarks', bm);
    currentBookmarks.push(bm);
    currentBookmarks.sort((a, b) => a.page - b.page);
  }
  renderBookmarksList();
  refreshBookmarkStar();
});

// -------- zoom --------

zoomInBtn.addEventListener('click', () => {
  const z = pdfView.zoomIn();
  zoomLevelEl.textContent = Math.round(z * 100) + '%';
});
zoomOutBtn.addEventListener('click', () => {
  const z = pdfView.zoomOut();
  zoomLevelEl.textContent = Math.round(z * 100) + '%';
});

canvasZoomInBtn.addEventListener('click', () => {
  const z = canvas.zoomIn();
  canvasZoomLevelEl.textContent = Math.round(z * 100) + '%';
});
canvasZoomOutBtn.addEventListener('click', () => {
  const z = canvas.zoomOut();
  canvasZoomLevelEl.textContent = Math.round(z * 100) + '%';
});

// -------- page navigation --------

prevPageBtn.addEventListener('click', () => {
  const n = Math.max(1, (parseInt(pageInput.value, 10) || 1) - 1);
  pdfView.goToPage(n);
});
nextPageBtn.addEventListener('click', () => {
  const n = Math.min(pdfView.getPageCount(), (parseInt(pageInput.value, 10) || 1) + 1);
  pdfView.goToPage(n);
});
pageInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = parseInt(pageInput.value, 10);
  if (n >= 1 && n <= pdfView.getPageCount()) pdfView.goToPage(n);
  pageInput.blur();
});
pageInput.addEventListener('blur', () => {
  // if left invalid/empty, snap back to whatever page is actually showing
});

// -------- search --------

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => pdfView.search(searchInput.value), 200);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? pdfView.prevMatch() : pdfView.nextMatch(); }
  if (e.key === 'Escape') { searchInput.value = ''; pdfView.clearSearch(); searchCountEl.textContent = ''; searchInput.blur(); }
});
searchPrevBtn.addEventListener('click', () => pdfView.prevMatch());
searchNextBtn.addEventListener('click', () => pdfView.nextMatch());
searchCloseBtn.addEventListener('click', () => {
  searchInput.value = '';
  pdfView.clearSearch();
  searchCountEl.textContent = '';
});

// -------- welcome tour --------
// A first-run walkthrough (replayable from the ? button) that spotlights
// the app's main pieces. Some targets live inside panels that can be
// collapsed/hidden (the folder rail, the notes canvas) — before/after
// hooks on those steps temporarily reveal them for the step, then put
// them back exactly as the person had them, rather than leaving a
// collapsed pane forced open once the tour moves on.

function tourOpenRail() {
  if (isStacked()) {
    const wasOpen = railEl.classList.contains('open');
    railEl.classList.add('open');
    return () => { if (!wasOpen) railEl.classList.remove('open'); };
  }
  const wasCollapsed = railEl.classList.contains('collapsed');
  if (wasCollapsed) setRailCollapsed(false);
  return () => { if (wasCollapsed) setRailCollapsed(true); };
}

// The notes canvas needs to stay visible across two consecutive steps (the
// canvas itself, then the export button inside its header). Only the first
// of the two opens it and only the second restores it, so moving forward
// between them doesn't collapse-then-reopen the pane (that transition
// animates, so doing both back to back would flicker). The tradeoff: if
// the tour is closed or skipped while sitting exactly on the first of the
// two steps, the pane is left open rather than restored — harmless (the
// person can just collapse it again) and far less noticeable than a flicker
// on the common forward-through-the-tour path.
function tourHoldNotesOpen() {
  const wasCollapsed = canvasWrapEl.classList.contains('collapsed');
  if (wasCollapsed) setNotesCollapsed(false);
  return () => { if (wasCollapsed) setNotesCollapsed(true); };
}
let tourRestoreNotes = null;

// Closed over by the rail step's before/after hooks below, rather than
// stashed on `this` — these hooks are plain arrow functions passed into a
// steps array, not methods on Tour, so `this` inside them isn't the Tour
// instance.
let tourRestoreRail = null;

function isStackedRailHint() {
  return isStacked()
    ? 'PDFs and notes canvases live here, organized into folders. Tap ☰ Folders anytime to open this panel.'
    : 'PDFs and notes canvases live here, organized into folders you can create and rename.';
}

const tour = new Tour([
  {
    target: null,
    title: 'Welcome to Marginalia',
    body: "Marginalia is a PDF reader with notes that stay linked to the page they came from. Pull out a quote or a screenshot and it becomes a card you can click anytime to jump straight back to that exact spot. Quick tour — about 6 steps.",
  },
  {
    target: 'importBtn',
    title: 'Import a PDF',
    body: 'Start here. Import as many PDFs as you like — each one shows up in your library on the left.',
  },
  {
    target: 'rail',
    title: 'Your library',
    body: isStackedRailHint,
    before: () => { tourRestoreRail = tourOpenRail(); },
    after: () => { if (tourRestoreRail) { tourRestoreRail(); tourRestoreRail = null; } },
  },
  {
    target: 'readingScroll',
    title: 'Read & select',
    body: 'Select text, or drag over an image, anywhere in an open PDF. Buttons appear letting you pull that excerpt onto your notes canvas.',
  },
  {
    target: 'canvasWrap',
    title: 'Your notes canvas',
    body: 'Pulled quotes and images land here as cards. Drag the small circle on a card to link it to another, and click any card to jump straight back to the exact page it came from.',
    before: () => { tourRestoreNotes = tourHoldNotesOpen(); },
  },
  {
    target: 'canvasExportBtn',
    title: 'Export your notes',
    body: 'Export the whole linked note map — excerpts, pages, your notes and links — as Markdown. Handy for study notes, or hand it to an AI along with the PDF.',
    after: () => { if (tourRestoreNotes) { tourRestoreNotes(); tourRestoreNotes = null; } },
  },
  {
    target: 'themeToggle',
    title: 'Light or dark',
    body: 'Switch between a light and dark reading theme anytime.',
  },
  {
    target: null,
    title: "You're all set",
    body: 'Import a PDF to get started. You can replay this tour anytime from the ? button up top.',
  },
]);

tourHelpBtn.addEventListener('click', () => tour.start());

// -------- PWA: install prompt + service worker --------
// Chrome/Edge/Android hold the native install prompt back until the page
// calls preventDefault() on `beforeinstallprompt`, which is also the only
// signal that the browser considers this page installable right now — so
// the button stays hidden until that fires, rather than guessing.
// Safari/iOS never fires it at all (installing there is a manual Share >
// Add to Home Screen), and no browser fires it once the app is already
// running installed, so this never shows a stale "Install" button.
const installAppBtn = document.getElementById('installAppBtn');
let deferredInstallPrompt = null;

function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true; // iOS's own flag
}

function setInstallBtnVisible(visible) {
  installAppBtn.style.display = visible ? '' : 'none';
  // Lets the phone topbar (see styles.css) reclaim the "☰ Folders" label's
  // width only while a 4th icon button is actually competing for space,
  // instead of shrinking that label in the common case where it isn't.
  document.body.classList.toggle('pwa-install-available', visible);
}

if (!isRunningStandalone()) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    setInstallBtnVisible(true);
  });
}
installAppBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  setInstallBtnVisible(false);
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice; // resolves once the person answers the native dialog
  deferredInstallPrompt = null;
});
window.addEventListener('appinstalled', () => {
  setInstallBtnVisible(false);
  deferredInstallPrompt = null;
});

// Registering from `/app/` scopes the service worker to just this app, not
// the marketing landing page one level up. Feature-detected and swallowed
// on failure since this also runs inside a sandboxed artifact iframe (this
// app's other home), where service workers can't register at all — that's
// fine, there's nothing to install there anyway.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => { /* e.g. sandboxed iframe, unsupported browser */ });
  });
}

// -------- boot --------

(async function init() {
  await rail.load();
  tour.maybeAutoStart();
})();
