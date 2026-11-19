# Changelog

Notable changes to Countersign, newest first. Dates are commit dates. Earlier detail is in the commit log.

## [1.0.0] - 2026-11-19

First tagged release. It covers everything below.

### What it does

- Builds a knowledge base from up to 500 sources (PDF, DOCX, XLSX, CSV and text) and extracts the questions from an RFP, RFI or RFQ in the same formats or from pasted text.
- Drafts a grounded answer for each question with citations and a coverage score, and flags the questions the documentation cannot answer.
- Exports to DOCX, XLSX and CSV, or writes the answers back into the issuer's original workbook.
- Runs on the Claude API, Gemini, any OpenAI-compatible endpoint, a team proxy (`proxy.php` or `proxy.js`), the standalone answer engine (`engine.js`), or inside Claude as an artifact.
- Ships its own checks: an evaluation harness with a CI canary (`eval/`), a browser end-to-end suite (`e2e/`) and behavior checks for the engine and the proxies (`test/`).
- Licensed under the GNU AGPL-3.0.

## Before 1.0.0

- **2026-11-14.** The engine answers with Gemini as well as Claude, writes knowledge base files atomically, and leaves Gemini's thought parts out of answers. The artifact edition is built from `index.html` by `artifact/make-artifact.mjs`, with an install guide.
- **2026-11-13.** Countersign logo in the sidebar and README. OpenAI reasoning models are retried with `max_completion_tokens`. RFP acronyms are expanded in local retrieval. `/ingest` caps the document count and the indexed text. A same-host HTTPS origin is accepted without a token.
- **2026-11-02.** The interface is rebuilt around a question list and an answer panel, with end-to-end coverage of filters, question navigation, RFP intake and the phone layout.
- **2026-10-21.** Proxy hardening: `proxy.php` refuses to forward without a team token, and a negative `max_tokens` falls back to the cap.
- **2026-10-11.** The licence is the GNU AGPL-3.0 (an MIT licence added earlier that day was replaced). The browser end-to-end suite is added. The round trip no longer overwrites the issuer's cells unasked, two tabs merge instead of overwriting each other, cross-origin and DNS-rebound requests are refused when no token is set, different document names no longer overwrite each other in the engine, and retrieval matches short versions, percentages, accented words and CJK text.
- **2026-09-30.** pdf.js, SheetJS, mammoth and docx are updated. The engine and proxies bind to loopback and require JSON bodies. CSV export neutralizes formula prefixes. The default Claude model moves to `claude-sonnet-5-5`. The engine updates its index per document.
- **2026-09-16 and 2026-09-17.** The evaluation harness is added, with retrieval metrics, recorded answers and groundedness scoring in CI. Repairs after the first full test: the Gemini provider, the round-trip export, a stored XSS and the engine's `/forget`.
- **2026-07-22.** First upload.
