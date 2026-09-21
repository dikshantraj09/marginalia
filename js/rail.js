// Left rail: two independent folder trees — PDFs and Notes (canvases).
// A canvas is no longer tied to one PDF: it can hold excerpts pulled from
// any PDF, so the two trees are organized (and deleted, renamed, moved)
// independently of each other.

import DB from './db.js';

const DRAG_TYPE = { pdf: 'text/pdf-doc-id', note: 'text/note-canvas-id' };

export default class Rail {
  constructor(railEl, callbacks) {
    this.railEl = railEl;
    this.cb = callbacks || {};
    this.folders = [];
    this.documents = [];
    this.canvases = [];
    this.collapsed = new Set();
    this.activeDocId = null;
    this.activeCanvasId = null;
    this.docRowEls = new Map(); // docId -> row element, so active-state changes never need a full rebuild
    this.canvasRowEls = new Map();

    this.pdfGroupEl = railEl.querySelector('#pdfGroup');
    this.notesGroupEl = railEl.querySelector('#notesGroup');
    railEl.querySelector('#addPdfFolder').addEventListener('click', () => this._createFolder(null, 'pdf'));
    railEl.querySelector('#addCanvas').addEventListener('click', () => this._createCanvas(null));
  }

  async load() {
    [this.folders, this.documents, this.canvases] = await Promise.all([
      DB.all('folders'),
      DB.all('documents'),
      DB.all('canvases'),
    ]);
    this.render();
  }

  // Switching which doc/canvas is "active" must never trigger a full
  // rebuild: a rebuild mid double-click would tear out the contentEditable
  // node a rename just started on. Just move the highlight class.
  setActiveDoc(docId) {
    this.activeDocId = docId;
    this.docRowEls.forEach((el, id) => el.classList.toggle('active', id === docId));
  }
  setActiveCanvas(canvasId) {
    this.activeCanvasId = canvasId;
    this.canvasRowEls.forEach((el, id) => el.classList.toggle('active', id === canvasId));
  }

  render() {
    this.pdfGroupEl.innerHTML = '';
    this.notesGroupEl.innerHTML = '';
    this.docRowEls.clear();
    this.canvasRowEls.clear();
    this._renderLevel(null, this.pdfGroupEl, 'pdf');
    this._renderLevel(null, this.notesGroupEl, 'note');
  }

  _childFolders(parentId, kind) {
    return this.folders
      .filter((f) => f.parentId === parentId && f.kind === kind)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  _childDocs(folderId) {
    return this.documents.filter((d) => d.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  }
  _childCanvases(folderId) {
    return this.canvases.filter((c) => c.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  }

  _renderLevel(parentId, container, kind) {
    const folders = this._childFolders(parentId, kind);
    const leaves = kind === 'pdf' ? this._childDocs(parentId) : this._childCanvases(parentId);

    if (!folders.length && !leaves.length && parentId === null) {
      container.innerHTML =
        '<div class="rail-empty">' +
        (kind === 'pdf' ? 'No PDFs yet — import one to start.' : 'No notes yet — create one, or pull an excerpt from a PDF.') +
        '</div>';
      return;
    }
    folders.forEach((f) => container.appendChild(this._renderFolder(f, kind)));
    leaves.forEach((item) => container.appendChild(kind === 'pdf' ? this._renderDoc(item) : this._renderCanvas(item)));
  }

  _renderFolder(f, kind) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'folder-row' + (this.collapsed.has(f.id) ? ' collapsed' : '');
    row.innerHTML = '<span class="chev">▾</span><span class="icon">📁</span><span class="folder-name">' + escapeHtml(f.name) + '</span>';

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    actions.innerHTML = '<span title="New subfolder" data-act="add">＋</span><span title="Delete folder" data-act="del">✕</span>';
    row.appendChild(actions);

    const nameEl = row.querySelector('.folder-name');
    row.addEventListener('click', (e) => {
      if (nameEl.isContentEditable || actions.contains(e.target)) return;
      if (this.collapsed.has(f.id)) this.collapsed.delete(f.id); else this.collapsed.add(f.id);
      row.classList.toggle('collapsed');
      children.classList.toggle('hidden');
    });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this._beginRename(nameEl, f.name, async (newName) => { f.name = newName; await DB.put('folders', f); }); });

    actions.querySelector('[data-act="add"]').addEventListener('click', (e) => { e.stopPropagation(); this._createFolder(f.id, kind); });
    actions.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); this._deleteFolder(f); });

    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE[kind])) { e.preventDefault(); row.classList.add('drop-target'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const id = e.dataTransfer.getData(DRAG_TYPE[kind]);
      if (!id) return;
      if (kind === 'pdf') await this._moveDoc(id, f.id); else await this._moveCanvas(id, f.id);
    });

    wrap.appendChild(row);
    const children = document.createElement('div');
    children.className = 'children' + (this.collapsed.has(f.id) ? ' hidden' : '');
    wrap.appendChild(children);
    this._renderLevel(f.id, children, kind);
    return wrap;
  }

  _renderDoc(d) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (this.activeDocId === d.id ? ' active' : '');
    row.draggable = true;
    row.innerHTML =
      '<span class="dot"></span><span class="icon">📄</span><span class="folder-name">' + escapeHtml(d.name) + '</span>' +
      '<span class="row-actions"><span title="Delete" data-act="del">✕</span></span>';
    const nameEl = row.querySelector('.folder-name');
    row.addEventListener('click', (e) => { if (!nameEl.isContentEditable && !e.target.closest('[data-act]')) this.cb.onOpenDoc && this.cb.onOpenDoc(d.id); });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this._beginRename(nameEl, d.name, async (newName) => { d.name = newName; await DB.put('documents', d); this.cb.onDocRenamed && this.cb.onDocRenamed(d); }); });
    row.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); this._deleteDoc(d); });
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData(DRAG_TYPE.pdf, d.id));
    this.docRowEls.set(d.id, row);
    return row;
  }

  _renderCanvas(c) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (this.activeCanvasId === c.id ? ' active' : '');
    row.draggable = true;
    row.innerHTML =
      '<span class="dot"></span><span class="icon">✎</span><span class="folder-name">' + escapeHtml(c.name) + '</span>' +
      '<span class="row-actions"><span title="Delete" data-act="del">✕</span></span>';
    const nameEl = row.querySelector('.folder-name');
    row.addEventListener('click', (e) => { if (!nameEl.isContentEditable && !e.target.closest('[data-act]')) this.cb.onOpenCanvas && this.cb.onOpenCanvas(c.id); });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this._beginRename(nameEl, c.name, async (newName) => { c.name = newName; await DB.put('canvases', c); this.cb.onCanvasRenamed && this.cb.onCanvasRenamed(c); }); });
    row.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); this._deleteCanvas(c); });
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData(DRAG_TYPE.note, c.id));
    this.canvasRowEls.set(c.id, row);
    return row;
  }

  _beginRename(nameEl, currentValue, onCommit) {
    nameEl.contentEditable = 'true';
    nameEl.focus();
    document.execCommand('selectAll', false, null);
    const finish = async () => {
      nameEl.contentEditable = 'false';
      nameEl.removeEventListener('blur', finish);
      nameEl.removeEventListener('keydown', onKey);
      const newName = nameEl.textContent.trim();
      if (newName && newName !== currentValue) { await onCommit(newName); this.render(); }
      else nameEl.textContent = currentValue;
    };
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } if (e.key === 'Escape') { nameEl.textContent = currentValue; nameEl.blur(); } };
    nameEl.addEventListener('blur', finish);
    nameEl.addEventListener('keydown', onKey);
  }

  async _createFolder(parentId, kind) {
    const name = prompt('Folder name:', 'New folder');
    if (!name) return;
    const folder = { id: DB.uid('fld'), name: name.trim(), parentId, kind };
    await DB.put('folders', folder);
    this.folders.push(folder);
    this.render();
  }

  async _deleteFolder(f) {
    const hasChildren = this.folders.some((x) => x.parentId === f.id) ||
      this.documents.some((x) => x.folderId === f.id) || this.canvases.some((x) => x.folderId === f.id);
    if (hasChildren && !confirm('"' + f.name + '" isn\'t empty. Move its contents up a level and delete the folder?')) return;
    for (const sub of this.folders.filter((x) => x.parentId === f.id)) { sub.parentId = f.parentId; await DB.put('folders', sub); }
    for (const doc of this.documents.filter((x) => x.folderId === f.id)) { doc.folderId = f.parentId; await DB.put('documents', doc); }
    for (const cv of this.canvases.filter((x) => x.folderId === f.id)) { cv.folderId = f.parentId; await DB.put('canvases', cv); }
    this.folders = this.folders.filter((x) => x.id !== f.id);
    await DB.delete('folders', f.id);
    this.render();
  }

  async _moveDoc(docId, folderId) {
    const doc = this.documents.find((d) => d.id === docId);
    if (!doc) return;
    doc.folderId = folderId;
    await DB.put('documents', doc);
    this.render();
  }
  async _moveCanvas(canvasId, folderId) {
    const cv = this.canvases.find((c) => c.id === canvasId);
    if (!cv) return;
    cv.folderId = folderId;
    await DB.put('canvases', cv);
    this.render();
  }

  async _deleteDoc(d) {
    const cards = await DB.byIndex('cards', 'docId', d.id);
    const msg = cards.length
      ? 'Delete "' + d.name + '"? ' + cards.length + ' excerpt' + (cards.length > 1 ? 's' : '') + ' pulled from it will also be removed from your notes.'
      : 'Delete "' + d.name + '"?';
    if (!confirm(msg)) return;
    for (const c of cards) { await DB.delete('cards', c.id); }
    await DB.delete('documents', d.id);
    this.documents = this.documents.filter((x) => x.id !== d.id);
    this.render();
    this.cb.onDocDeleted && this.cb.onDocDeleted(d.id, cards);
  }

  async _deleteCanvas(c) {
    const cards = await DB.byIndex('cards', 'canvasId', c.id);
    const msg = cards.length
      ? 'Delete "' + c.name + '"? It has ' + cards.length + ' card' + (cards.length > 1 ? 's' : '') + ' on it.'
      : 'Delete "' + c.name + '"?';
    if (!confirm(msg)) return;
    for (const card of cards) { await DB.delete('cards', card.id); }
    const links = await DB.byIndex('links', 'canvasId', c.id);
    for (const l of links) { await DB.delete('links', l.id); }
    await DB.delete('canvases', c.id);
    this.canvases = this.canvases.filter((x) => x.id !== c.id);
    this.render();
    this.cb.onCanvasDeleted && this.cb.onCanvasDeleted(c.id);
  }

  async _createCanvas(folderId) {
    const name = prompt('Name this notes canvas:', 'New notes');
    if (!name) return null;
    const cv = { id: DB.uid('cv'), name: name.trim(), folderId, createdAt: Date.now() };
    await DB.put('canvases', cv);
    this.canvases.push(cv);
    this.render();
    return cv;
  }

  async addDocument(doc) { this.documents.push(doc); this.render(); }
  async addCanvasSilently(cv) { this.canvases.push(cv); this.render(); }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
