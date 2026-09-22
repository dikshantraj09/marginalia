import DB from './db.js';
import Rail from './rail.js';
import PdfView from './pdfview.js';
import NotesCanvas from './canvas.js';

const readingEl = document.getElementById('reading');
const pdfPagesEl = document.getElementById('pdfPages');
const readingEmptyEl = document.getElementById('readingEmpty');
const pullBtn = document.getElementById('pullBtn');
const docTitleEl = document.getElementById('docTitle');
const pdfToolbar = document.getElementById('pdfToolbar');
const tocToggle = document.getElementById('tocToggle');
const tocClose = document.getElementById('tocClose');
const tocBackdrop = document.getElementById('tocBackdrop');
const tocPanel = document.getElementById('tocPanel');
const tocListEl = document.getElementById('tocList');
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
};
pdfView.onSearchResults = (active, total) => {
  searchCountEl.textContent = total ? active + ' / ' + total : (searchInput.value.trim() ? '0 / 0' : '');
};

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
  onDocDeleted: (docId) => {
    if (currentCanvasId) canvas.removeCardsByDoc(docId);
    if (docId === currentDocId) closeDocument();
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
    zoomLevelEl.textContent = '100%';
    searchInput.value = '';
    searchCountEl.textContent = '';
    await populateToc();
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

pullBtn.addEventListener('mousedown', (e) => e.preventDefault());
pullBtn.addEventListener('click', async () => {
  const sel = pdfView._selection;
  if (!sel || !currentDocId) return;
  const doc = await DB.get('documents', currentDocId);
  await getOrCreateActiveCanvas();
  const card = canvas.addExcerptCard({
    docId: currentDocId,
    docName: doc ? doc.name : '',
    page: sel.page,
    rects: sel.rects,
    text: sel.text,
    image: sel.image,
  });
  pdfView.drawHighlight(card);
  pdfView.clearSelectionUI();
});

// -------- importing PDFs --------

async function importPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const doc = { id: DB.uid('doc'), name: file.name, folderId: null, createdAt: Date.now(), blob: arrayBuffer };
  await DB.put('documents', doc);
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

// -------- notes panel collapse (a "just read" mode) --------

function setNotesCollapsed(collapsed) {
  canvasWrapEl.classList.toggle('collapsed', collapsed);
  bodyRowEl.classList.toggle('notes-collapsed', collapsed);
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
  const md = canvas.getLinkMapMarkdown();
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

// -------- theme --------

function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
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

function openToc() {
  tocPanel.classList.add('open');
  tocBackdrop.classList.add('open');
}
function closeToc() {
  tocPanel.classList.remove('open');
  tocBackdrop.classList.remove('open');
}
tocToggle.addEventListener('click', () => {
  tocPanel.classList.contains('open') ? closeToc() : openToc();
});
tocClose.addEventListener('click', closeToc);
tocBackdrop.addEventListener('click', closeToc);

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

// -------- boot --------

(async function init() {
  await rail.load();
})();
