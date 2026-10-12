# Browser end-to-end suite

Drives the real `index.html` in headless Chromium with Playwright: 91 tests and 722 checks
covering page load, all six bucket formats, RFP intake (PDF, DOCX, XLSX with a title
block, CSV, pasted text), every provider, retries and errors, all four exports read back
with real libraries, the round trip into the issuer's workbook, persistence and two tabs
on one browser, stored XSS, blocked CDNs, retrieval of versions and non-Latin text, and a
375 px phone layout.

The page and its parsing and export libraries are real, loaded from their CDNs. Every LLM
endpoint, the team proxy and the engine are mocked with `page.route`, so no API key is
needed. Fixtures are generated at run time; nothing binary is committed.

## Run it

The app itself has no dependencies, so Playwright is installed into this folder only:

```bash
npm install --prefix e2e --no-save playwright@1.63.0
cd e2e
npx playwright install chromium
node run.js
```

`node run.js` tests the repository it sits in. Options:

- `--only <name>[,<name>]` runs the tests whose names contain any of the substrings, and
  `--list` prints every test name.
- `--jobs N` sets how many tests run at once (default 3).
- `--root <dir>` tests another copy of the app.
- `PLAYWRIGHT_DIR=<path to node_modules/playwright>` uses an install elsewhere.

It prints one PASS, FAIL or INFO line per check and a SUMMARY line, and exits non-zero if
any check fails. A failing test leaves a screenshot and a log in `out/`. The local server
it starts takes a free port between 18840 and 18859.

`PHONE_SHOTS=<dir> node run.js --only layout.phone` saves a screenshot of each page at
phone width.

## Proving the checks bite

`node tools/mutation-check.js` copies the app to a temporary folder, breaks `index.html` in
one specific way per mutation, and requires the matching tests to fail. The repository is
never touched.

## Scripts

- `scripts/checkjs.js <file.html>` compiles each inline script, which `node --check`
  cannot do for HTML, and reports raw control characters.
- `scripts/timeout-check.js <dir>` checks that a provider which never answers fails with
  one retry.
- `scripts/live-app-gemini.js <dir>` runs the page's own extraction, retrieval and answer
  code against the live Gemini API. It needs `GEMINI_API_KEY`; `GEMINI_MODEL` is optional.
- `scripts/dashes.js <file>` lists em and en dashes outside code comments.
