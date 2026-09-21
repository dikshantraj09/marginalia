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

let currentDocId = null;
let currentDocBuffer = null;

const pdfView = new PdfView(
  pdfPagesEl,
  pullBtn,
  () => {}, // onSelectionReady — pullBtn positioning already handled internally
  (card) => pdfView.jumpToCard(card) // clicking a highlight in the page just flashes it
);

const canvas = new NotesCanvas(canvasEl, canvasInnerEl, linkGroupEl, canvasEmptyEl, {
  onCardAdded: (card) => DB.put('cards', card),
  onCardChanged: (card) => DB.put('cards', card),
  onCardRemoved: (id) => {
    DB.delete('cards', id);
    // also remove its highlight from the page if visible
    const c = { id };
    for (const [pageNum] of pdfView.pageWraps) pdfView.removeHighlight(id, pageNum);
  },
  onCardClick: (card) => pdfView.jumpToCard(card),
  onLinkAdded: (pair) => DB.put('links', { id: DB.uid('lnk'), docId: currentDocId, a: pair[0], b: pair[1] }),
});

const rail = new Rail(railEl, {
  onOpenDoc: (docId) => openDocument(docId),
});

async function openDocument(docId) {
  const doc = await DB.get('documents', docId);
  if (!doc) return;
  currentDocId = docId;
  rail.setActive(docId);

  readingEmptyEl.style.display = 'none';
  docTitleEl.textContent = doc.name;
  canvasTitleEl.textContent = doc.name.replace(/\.pdf$/i, '') + ' — canvas';

  const buffer = doc.blob.slice(0); // ArrayBuffer copy since pdf.js detaches it
  const [cardRecords, linkRecords] = await Promise.all([
    DB.byIndex('cards', 'docId', docId),
    DB.byIndex('links', 'docId', docId),
  ]);
  const links = linkRecords.map((l) => [l.a, l.b]);
  canvas.setDocument(docId, cardRecords, links);

  try {
    await pdfView.load(buffer);
    cardRecords.forEach((c) => pdfView.drawHighlight(c));
  } catch (err) {
    // pdfView already shows an inline error in the reading pane; the notes
    // canvas for this doc still works, so we don't block on this.
  }

  if (window.innerWidth <= 900) railEl.classList.remove('open');
}

pullBtn.addEventListener('mousedown', (e) => e.preventDefault());
pullBtn.addEventListener('click', () => {
  const sel = pdfView._selection;
  if (!sel) return;
  const card = canvas.addExcerptCard({ page: sel.page, rects: sel.rects, text: sel.text });
  pdfView.drawHighlight(card);
  pdfView.clearSelectionUI();
});

async function importPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const doc = {
    id: DB.uid('doc'),
    name: file.name,
    folderId: null,
    createdAt: Date.now(),
    blob: arrayBuffer,
  };
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

(async function init() {
  await rail.load();
})();
