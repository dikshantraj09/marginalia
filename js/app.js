import DB from './db.js';
import Rail from './rail.js';
import PdfView from './pdfview.js';
import NotesCanvas from './canvas.js';

const readingEl = document.getElementById('reading');
const pdfPagesEl = document.getElementById('pdfPages');
const readingEmptyEl = document.getElementById('readingEmpty');
const pullBtn = document.getElementById('pullBtn');
const docTitleEl = document.getElementById('docTitle');
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
  onLinkAdded: (pair) => DB.put('links', { id: DB.uid('lnk'), canvasId: currentCanvasId, a: pair[0], b: pair[1] }),
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
  } catch (err) {
    // pdfView already shows an inline error in the reading pane
  }
  if (window.innerWidth <= 900) railEl.classList.remove('open');
}

function closeDocument() {
  currentDocId = null;
  docTitleEl.textContent = 'No document open';
  pdfPagesEl.innerHTML = '';
  readingEmptyEl.style.display = 'flex';
  rail.setActiveDoc(null);
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
  const links = linkRecords.map((l) => [l.a, l.b]);
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

// -------- boot --------

(async function init() {
  await rail.load();
})();
