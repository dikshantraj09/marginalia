// Whole-library backup/restore — the privacy-preserving alternative to a
// sync server: Export writes everything (folders, PDFs, canvases, cards,
// links) into a single file the person saves wherever they want; Import
// reads that file back in. No account, no server, nothing ever leaves the
// device except as a file the person explicitly chose to save.
//
// This is how cross-device use is meant to work here: save the exported
// file into a folder that's already synced by whatever cloud drive the
// person uses (iCloud Drive, Dropbox, Google Drive, ...), then Import it
// from that same folder on another device. The sync is theirs, not ours —
// this app never talks to a server at all. It's a couple of taps rather
// than automatic, but it works everywhere, including iPad Safari, where
// the fancier File System Access API (silent, no-tap folder sync) isn't
// available at all — see the export/import button handlers in app.js.

import DB from './db.js';

const VAULT_VERSION = 1;

// PDF bytes (ArrayBuffer) have to become JSON-safe text to live in the
// vault file — base64 is the simplest reliable way to do that with zero
// dependencies. It costs about 33% extra size over the raw PDF bytes;
// trading that for "the whole vault is one plain, inspectable JSON file
// that works identically in every browser" is the right call for a
// personal library, not something meant to hold many gigabytes.
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode.apply chokes on huge arg lists in one call
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Builds the vault and hands it to the browser's normal download flow
// (an <a download> click) — the same mechanism the Markdown export
// already uses, which is what makes iOS's "Save to Files" (including
// straight into iCloud Drive) available for it with no extra code.
export async function exportVault() {
  const [folders, documents, canvases, cards, links] = await Promise.all([
    DB.all('folders'),
    DB.all('documents'),
    DB.all('canvases'),
    DB.all('cards'),
    DB.all('links'),
  ]);

  const vault = {
    marginaliaVault: VAULT_VERSION,
    exportedAt: new Date().toISOString(),
    folders,
    canvases,
    cards,
    links,
    documents: documents.map((d) => ({ ...d, blob: bufToBase64(d.blob) })),
  };

  const json = JSON.stringify(vault);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = 'marginalia-vault-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Deferred, not immediate: revoking the URL right away can race the
  // browser/OS's own download handoff (most visible on iOS's "Save to
  // Files" sheet, which reads the blob asynchronously after the click).
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return {
    folders: folders.length,
    documents: documents.length,
    canvases: canvases.length,
    cards: cards.length,
    links: links.length,
  };
}

// Merge, not replace: every record in the vault is written with its
// original id, so importing the SAME vault twice is a harmless no-op
// (each `put` just overwrites itself with identical data), and importing
// a DIFFERENT device's vault adds/updates those records while leaving
// whatever's only on this device untouched. That also means the two
// devices' libraries simply union together rather than either one ever
// silently deleting the other's data — the safe default for a sync
// mechanism that's a manual, occasional tap rather than continuous.
export async function importVault(file) {
  let vault;
  try {
    vault = JSON.parse(await file.text());
  } catch (err) {
    throw new Error("That file isn't valid — it doesn't look like a Marginalia vault export.");
  }
  if (!vault || typeof vault.marginaliaVault !== 'number') {
    throw new Error("That file doesn't look like a Marginalia vault export.");
  }

  const documents = (vault.documents || []).map((d) => ({ ...d, blob: base64ToBuf(d.blob) }));
  for (const f of vault.folders || []) await DB.put('folders', f);
  for (const d of documents) await DB.put('documents', d);
  for (const c of vault.canvases || []) await DB.put('canvases', c);
  for (const c of vault.cards || []) await DB.put('cards', c);
  for (const l of vault.links || []) await DB.put('links', l);

  return {
    folders: (vault.folders || []).length,
    documents: documents.length,
    canvases: (vault.canvases || []).length,
    cards: (vault.cards || []).length,
    links: (vault.links || []).length,
  };
}
