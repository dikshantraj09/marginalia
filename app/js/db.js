// Minimal IndexedDB wrapper — no external dependency.
// Stores: folders (kind: 'pdf' | 'note'), documents (PDF blobs),
// canvases (independent notes workspaces), cards (excerpts on a canvas,
// each pointing back at a source document+page), links (card connections).
// Falls back to an in-memory store if IndexedDB is unavailable or blocked
// (private windows, some preview/thumbnail contexts) so the app still renders.

const DB_NAME = 'marginalia';
const DB_VERSION = 3;

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        if (!db.objectStoreNames.contains('folders')) {
          const s = db.createObjectStore('folders', { keyPath: 'id' });
          s.createIndex('parentId', 'parentId');
        }
        if (!db.objectStoreNames.contains('documents')) {
          const s = db.createObjectStore('documents', { keyPath: 'id' });
          s.createIndex('folderId', 'folderId');
        }
        if (!db.objectStoreNames.contains('canvases')) {
          const s = db.createObjectStore('canvases', { keyPath: 'id' });
          s.createIndex('folderId', 'folderId');
        }
        if (!db.objectStoreNames.contains('cards')) {
          const s = db.createObjectStore('cards', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
          s.createIndex('canvasId', 'canvasId');
        } else {
          const s = tx.objectStore('cards');
          if (!s.indexNames.contains('canvasId')) s.createIndex('canvasId', 'canvasId');
        }
        if (!db.objectStoreNames.contains('links')) {
          const s = db.createObjectStore('links', { keyPath: 'id' });
          s.createIndex('canvasId', 'canvasId');
        } else {
          const s = tx.objectStore('links');
          if (!s.indexNames.contains('canvasId')) s.createIndex('canvasId', 'canvasId');
        }
        if (!db.objectStoreNames.contains('bookmarks')) {
          const s = db.createObjectStore('bookmarks', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const ALL_STORES = ['folders', 'documents', 'canvases', 'cards', 'links', 'bookmarks'];

// In-memory fallback store — same shape of API, nothing persists across reloads.
function makeMemoryStore() {
  const data = {};
  ALL_STORES.forEach((s) => (data[s] = new Map()));
  const indexKeys = {
    folders: ['parentId'],
    documents: ['folderId'],
    canvases: ['folderId'],
    cards: ['docId', 'canvasId'],
    links: ['canvasId'],
    bookmarks: ['docId'],
  };
  return {
    async put(store, value) { data[store].set(value.id, value); return value.id; },
    async delete(store, id) { data[store].delete(id); },
    async get(store, id) { return data[store].get(id); },
    async all(store) { return Array.from(data[store].values()); },
    async byIndex(store, index, value) {
      return Array.from(data[store].values()).filter((v) => v[index] === value);
    },
    async clearAll() { ALL_STORES.forEach((s) => data[s].clear()); },
  };
}

let realDbPromise = null;
let memoryStore = null;

async function backend() {
  if (memoryStore) return memoryStore; // already fell back
  if (!realDbPromise) realDbPromise = openDB();
  try {
    const db = await realDbPromise;
    return {
      async put(store, value) {
        return reqToPromise(db.transaction([store], 'readwrite').objectStore(store).put(value));
      },
      async delete(store, id) {
        return reqToPromise(db.transaction([store], 'readwrite').objectStore(store).delete(id));
      },
      async get(store, id) {
        return reqToPromise(db.transaction([store], 'readonly').objectStore(store).get(id));
      },
      async all(store) {
        return reqToPromise(db.transaction([store], 'readonly').objectStore(store).getAll());
      },
      async byIndex(store, index, value) {
        return reqToPromise(db.transaction([store], 'readonly').objectStore(store).index(index).getAll(value));
      },
      async clearAll() {
        const t = db.transaction(ALL_STORES, 'readwrite');
        ALL_STORES.forEach((s) => t.objectStore(s).clear());
      },
    };
  } catch (err) {
    console.warn('Marginalia: IndexedDB unavailable, using in-memory storage for this session.', err);
    memoryStore = makeMemoryStore();
    return memoryStore;
  }
}

const DB = {
  uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },
  async put(store, value) { return (await backend()).put(store, value); },
  async delete(store, id) { return (await backend()).delete(store, id); },
  async get(store, id) { return (await backend()).get(store, id); },
  async all(store) { return (await backend()).all(store); },
  async byIndex(store, index, value) { return (await backend()).byIndex(store, index, value); },
  async clearAll() { return (await backend()).clearAll(); },
};

export default DB;
