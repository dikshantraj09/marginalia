# Marginalia

A PDF reader with a freeform notes canvas next to it. Pull excerpts out of the
PDF, write your own notes on them, connect related excerpts with a thread,
and click any card to jump straight back to the exact page it came from.

Organize PDFs into folders on the left; every PDF automatically gets its own
paired notes canvas, listed under Notes.

## Running it

This is a static site (no backend, no build step) — but it uses ES modules,
which browsers refuse to load from `file://`, so it needs to be served over
HTTP. From this folder:

```
python3 -m http.server 8080
# or: npx serve .
```

Then open `http://localhost:8080`.

## How it works

- **PDF.js** (vendored in `vendor/pdfjs/`, no CDN needed) renders pages and
  provides the selectable text layer.
- **IndexedDB** stores your PDFs and notes locally in the browser — nothing
  leaves your machine, no server, no account.
- Everything is plain HTML/CSS/JS — no build step, no framework, no
  dependencies to install to run it (PDF.js is only needed if you want to
  re-vendor a newer version; see `package.json`).

## Project structure

```
index.html          the app shell
css/styles.css       all styles (light mode)
js/
  app.js             wires everything together
  db.js               IndexedDB wrapper (folders, documents, cards, links)
  rail.js             folder tree — PDFs + paired Notes
  pdfview.js           renders PDF pages, text selection, highlights
  canvas.js            the freeform notes canvas — cards, links, drag
vendor/pdfjs/         vendored PDF.js build (offline, no CDN dependency)
```

## What's not in this first pass

Cloud sync across devices, PDF markup/drawing tools, export, and search.
