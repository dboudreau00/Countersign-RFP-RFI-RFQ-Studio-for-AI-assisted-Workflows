# Countersign, Claude artifact edition

`make-artifact.mjs` turns the repository's `index.html` into a page that runs as a
claude.ai artifact: answers are drafted through the viewer's own Claude account, with no
API key and no server. To install it, follow
[Install it as a Claude artifact](../README.md#install-it-as-a-claude-artifact-no-key-no-server).

```bash
node artifact/make-artifact.mjs            # reads index.html, writes artifact/dist/
```

Publish `artifact/dist/index.html` together with its three `vendor/` files, at the same
relative paths, and declare the capabilities `sample`, `db`, `user` and `downloads`.
Every patch must match its target exactly once, so a change to `index.html` that moves
the code stops the build instead of producing a half-patched page. `artifact/dist/` and
`artifact/vendor/` are build output and are not committed.

## What differs from index.html

An artifact runs in a frame that blocks every outbound request, download links, the
browser's confirm and prompt dialogs, and scripts from all but a few CDNs. So:

| Area | index.html | Artifact edition |
|---|---|---|
| AI | Claude, Claude API, Gemini, OpenAI-compatible, team proxy, Countersign Engine | Claude only, through the viewer's account (`sample`). Claude asks the viewer before the first draft. A permission, account or usage-limit failure stops a batch; nothing is retried automatically. |
| Saving | Claude storage, then this browser, then memory | The viewer's private store (`db`, under `data/users/<id>/`, which nobody else can read, the owner included), then this browser, then memory. Values over 240 KB are split into parts written under a fresh version and published by writing a head document last. A refused write (view-only access) switches that browser to saving locally. |
| Exports | Download links | The viewer's save prompt (`downloads`): Word, Excel, CSV and the workspace file. |
| Confirmations | `confirm()` and `prompt()` | An in-page dialog; Escape, the backdrop and Cancel all mean no. |
| Libraries | SheetJS from cdn.sheetjs.com; pdf.js fetched with SRI into blob URLs | Published next to the page from `vendor/`, see below. mammoth (cdnjs), docx (jsDelivr) and Google Fonts load as before. |
| Settings | Engine section, "Load from site" | Hidden; a first visit starts empty instead of looking for `countersign-data.json`. |
| Theme | OS setting, then the in-app toggle | The viewer's theme in Claude wins over the OS setting and is followed live. |

## Libraries

The build reads each library's URL and SRI hash from `index.html`, downloads it once into
`artifact/vendor/`, and stops if the bytes do not match the hash. A copy already there is
used only when it matches. Offline, or behind a proxy Node cannot use, save the files at
those paths by hand and build again. With the current pins:

| File | Source | Size (bytes) | Pinned SRI |
|---|---|---|---|
| `vendor/xlsx/xlsx.full.min.js` | cdn.sheetjs.com, SheetJS 0.20.3 | 951,904 | `sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT` |
| `vendor/pdfjs/pdf.min.mjs` | jsDelivr, pdfjs-dist 6.3.289 legacy | 518,555 | `sha384-5NjcDwbJzXhI7QGdIeL4gC2aaEUnzbpPCN461DegG6G/1ym8f1MBJQpAjcXNOi5s` |
| `vendor/pdfjs/pdf.worker.min.mjs` | jsDelivr, pdfjs-dist 6.3.289 legacy | 1,317,034 | `sha384-2elss7Fc57S3C8hPKJxxGbtpWJRNsg0VWJqPR6PSSaIetveaFPnpIRIGVSml+d5+` |

SheetJS 0.20.3 is not on npm or cdnjs (both stop at 0.18.5, which has CVE-2023-30533 and
CVE-2024-22363), so it is published with the page rather than downgraded.

The artifact publisher refuses text files that hold control characters or U+FFFD, and
SheetJS and pdf.js keep both inside string literals (codepage and font tables). The build
rewrites every control and non-ASCII character inside a literal or comment as its
`\uXXXX` escape, which JavaScript reads as the same character. A small lexer places each
one; the build stops if one sits outside a literal or in a tagged template, and every
rewritten string, template chunk and regex must evaluate (or match) exactly as the
original. The page loads SheetJS with the escaped file's own SRI hash, which the build
prints with the size of each file it writes.

## Checked

Inside Claude (2026-11-13): the page loads with every library, follows the viewer's
theme, saves to the viewer's account and reads it back after a reload, shows the in-page
dialog, and sends an export through Claude's save prompt. Drafting, file import and the
fallbacks were checked in headless Chromium against a stand-in for Claude's runtime.
