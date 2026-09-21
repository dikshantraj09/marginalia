// Left rail: a single folder tree shared by the PDFs and Notes sections.
// Every PDF automatically has a paired notes canvas, so organizing the PDF
// also organizes its notes — no separate structure to keep in sync.

import DB from './db.js';

export default class Rail {
  constructor(railEl, callbacks) {
    this.railEl = railEl;
    this.cb = callbacks || {};
    this.folders = [];
    this.documents = [];
    this.collapsed = new Set();
    this.activeDocId = null;

    this.pdfGroupEl = railEl.querySelector('#pdfGroup');
    this.notesGroupEl = railEl.querySelector('#notesGroup');
    railEl.querySelector('#addPdfFolder').addEventListener('click', () => this._createFolder(null));
  }

  async load() {
    this.folders = await DB.all('folders');
    this.documents = await DB.all('documents');
    // strip blobs from in-memory doc list rendering (blob stays in DB record when needed)
    this.render();
  }

  setActive(docId) {
    this.activeDocId = docId;
    this.render();
  }

  render() {
    this.pdfGroupEl.innerHTML = '';
    this.notesGroupEl.innerHTML = '';
    if (!this.documents.length && !this.folders.length) {
      this.pdfGroupEl.innerHTML = '<div class="rail-empty">No PDFs yet — import one to start.</div>';
      this.notesGroupEl.innerHTML = '<div class="rail-empty">Notes appear once you have a PDF.</div>';
      return;
    }
    this._renderLevel(null, this.pdfGroupEl, 'pdf');
    this._renderLevel(null, this.notesGroupEl, 'notes');
  }

  _childFolders(parentId) {
    return this.folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  }
  _childDocs(folderId) {
    return this.documents.filter((d) => d.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  }

  _renderLevel(parentId, container, mode) {
    const folders = this._childFolders(parentId);
    const docs = this._childDocs(parentId);
    if (!folders.length && !docs.length && parentId === null) {
      container.innerHTML = '<div class="rail-empty">' + (mode === 'pdf' ? 'No PDFs yet.' : 'Nothing here yet.') + '</div>';
      return;
    }

    folders.forEach((f) => container.appendChild(this._renderFolder(f, mode)));
    docs.forEach((d) => container.appendChild(this._renderDoc(d, mode)));
  }

  _renderFolder(f, mode) {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'folder-row' + (this.collapsed.has(f.id) ? ' collapsed' : '');
    row.innerHTML =
      '<span class="chev">▾</span><span class="icon">📁</span><span class="folder-name">' +
      escapeHtml(f.name) +
      '</span>';

    const actions = document.createElement('span');
    actions.style.cssText = 'display:flex;gap:4px;opacity:0;margin-left:4px;';
    actions.innerHTML = '<span title="New subfolder" style="cursor:pointer;font-size:12px;">＋</span><span title="Delete folder" style="cursor:pointer;font-size:12px;">✕</span>';
    row.appendChild(actions);
    row.addEventListener('mouseenter', () => (actions.style.opacity = '1'));
    row.addEventListener('mouseleave', () => (actions.style.opacity = '0'));

    const nameEl = row.querySelector('.folder-name');
    row.addEventListener('click', (e) => {
      if (e.target === nameEl && nameEl.isContentEditable) return;
      if (actions.contains(e.target)) return;
      if (this.collapsed.has(f.id)) this.collapsed.delete(f.id);
      else this.collapsed.add(f.id);
      row.classList.toggle('collapsed');
      children.classList.toggle('hidden');
    });
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameEl.contentEditable = 'true';
      nameEl.focus();
      document.execCommand('selectAll', false, null);
    });
    nameEl.addEventListener('blur', async () => {
      nameEl.contentEditable = 'false';
      const newName = nameEl.textContent.trim() || f.name;
      if (newName !== f.name) {
        f.name = newName;
        await DB.put('folders', f);
      }
      nameEl.textContent = f.name;
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    });

    actions.children[0].addEventListener('click', (e) => { e.stopPropagation(); this._createFolder(f.id); });
    actions.children[1].addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._deleteFolder(f);
    });

    // drop target for moving docs/folders in
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const docId = e.dataTransfer.getData('text/doc-id');
      if (docId) await this._moveDoc(docId, f.id);
    });

    wrap.appendChild(row);

    const children = document.createElement('div');
    children.className = 'children' + (this.collapsed.has(f.id) ? ' hidden' : '');
    wrap.appendChild(children);
    this._renderLevel(f.id, children, mode);

    return wrap;
  }

  _renderDoc(d, mode) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (this.activeDocId === d.id ? ' active' : '');
    row.draggable = true;
    row.innerHTML =
      '<span class="dot"></span><span class="icon">' + (mode === 'pdf' ? '📄' : '✎') + '</span>' +
      '<span class="folder-name">' + escapeHtml(mode === 'pdf' ? d.name : d.name.replace(/\.pdf$/i, '') + ' — notes') + '</span>';
    row.addEventListener('click', () => { if (this.cb.onOpenDoc) this.cb.onOpenDoc(d.id); });
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/doc-id', d.id));
    return row;
  }

  async _createFolder(parentId) {
    const name = prompt('Folder name:', 'New folder');
    if (!name) return;
    const folder = { id: DB.uid('fld'), name: name.trim(), parentId };
    await DB.put('folders', folder);
    this.folders.push(folder);
    this.render();
  }

  async _deleteFolder(f) {
    const hasChildren = this.folders.some((x) => x.parentId === f.id) || this.documents.some((x) => x.folderId === f.id);
    if (hasChildren && !confirm('"' + f.name + '" isn\'t empty. Move its contents up a level and delete the folder?')) return;
    // move children up to this folder's parent
    for (const sub of this.folders.filter((x) => x.parentId === f.id)) {
      sub.parentId = f.parentId;
      await DB.put('folders', sub);
    }
    for (const doc of this.documents.filter((x) => x.folderId === f.id)) {
      doc.folderId = f.parentId;
      await DB.put('documents', doc);
    }
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

  async addDocument(doc) {
    this.documents.push(doc);
    this.render();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
