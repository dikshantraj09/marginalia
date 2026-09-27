# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Students, lawyers, and other professionals who read PDFs closely and take notes while doing it — no single vertical yet, but people doing deep, source-grounded reading (research papers, case files, reports) where losing track of which page a note came from is a real cost.

## Product Purpose

Marginalia is a PDF reader with a freeform notes canvas next to it. Pull excerpts out of any PDF, write notes on them, connect related excerpts with a thread, and click any card to jump straight back to the exact page it came from. Success is a reader never losing the link between a note and its source.

## Positioning

100% local: everything — PDFs and notes — lives in the browser via IndexedDB. No account, no upload, no server. This is the claim a note-taking competitor with a backend (Notion, Readwise, cloud-based annotation tools) could not truthfully copy without becoming a different product.

The note→page jump-back mechanic (click any note, land exactly back on the page/spot it came from) is the core interaction that makes the privacy claim useful rather than just a constraint.

## Operating Context

- Static site, no backend, no build step (vanilla HTML/CSS/JS, PDF.js vendored locally).
- Deployed at https://marginalianotes.app/ (Cloudflare Workers; the original https://marginalia.dikshantraj09.workers.dev/ still serves the same build), GitHub repo dikshantraj09/marginalia. Deploys are pushed by the user, not this session.
- Installable as a PWA (manifest + service worker cache the app shell for offline use).
- Text selection in the PDF is a drag-marquee (draw a box) rather than native browser text selection, chosen for accuracy on tables/multi-column layouts where visual reading order doesn't match underlying text order.
- PDFs and notes canvases are organized independently in their own folder trees; one canvas can hold excerpts from multiple PDFs.

## Capabilities and Constraints

- Must stay fully client-side: no backend, no accounts, ever. This is core to the product identity, not a current-version limitation.
- No monetization/business model decided yet — the maker is weighing this alongside a job search and another project (legal-PDF-focused OCR tool).

## Evidence on Hand

- Live product at https://marginalianotes.app/, README.md, and full app source in this repo.
- No real user testimonials, customers, or usage numbers yet — future copy must not fabricate these.

## Product Principles

- Privacy is structural, not a settings toggle: no account and no upload aren't features to configure, they're the architecture.
- A note is only useful if it remembers where it came from — the jump-back is the product's reason to exist, not a nice-to-have.
- Serve the reading moment across audiences (student, lawyer, generalist) rather than narrowing to one vertical's jargon or workflow assumptions.
- Ship what's real: no invented testimonials, benchmarks, or customer claims until they exist.
