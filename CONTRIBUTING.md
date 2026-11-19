# Contributing to Countersign

Issues and pull requests are welcome. This page is the short version of how the project is built and what a change needs.

## Ground rules

- **The app stays one file.** `index.html` has no framework and no build step. The engine and the proxies have no dependencies. The libraries the page loads are pinned by an integrity hash.
- **No real customer data.** Do not put RFPs, proposals, customer documents, keys or tokens in the repository, in fixtures, in screenshots or in commit messages. Fixtures and screenshots use invented names.
- **Your change comes under the project's licence.** By sending a change you confirm you wrote it or may share it, and that it is distributed under the GNU AGPL-3.0 in `LICENSE`; the copyright holder may also license the code under other terms.

## Run the checks

Node 18 or later. The first two need no API key and no install.

```bash
node test/servers.js   # engine, proxy.js and proxy.php against local fakes of the Anthropic and Gemini APIs
node eval/run.js       # retrieval and groundedness against eval/baseline.json
```

The `proxy.php` checks are skipped when PHP is not installed. The browser suite installs Playwright into its own folder and drives the real page with every LLM endpoint mocked; see [`e2e/README.md`](e2e/README.md).

```bash
npm install --prefix e2e --no-save playwright@1.63.0
cd e2e
npx playwright install chromium
node run.js
node tools/mutation-check.js   # proves the checks fail when the behavior they guard is broken
```

## What a change needs

- **A check that fails without it.** An engine, proxy or retrieval change gets a check in `test/servers.js` or a case in `eval/`. A page change gets a check in `e2e/`.
- **Documentation that stays true.** Update the README, `ENGINE.md` or `eval/README.md` when behavior a user can see changes, and add a line under Unreleased in [CHANGELOG.md](CHANGELOG.md).
- **Screenshots from the real page.** `node e2e/scripts/screenshots.js` rebuilds them with an invented vendor and RFP.

## Commits and pull requests

- Conventional commit subjects (`fix(engine): ...`, `feat(app): ...`, `docs: ...`), imperative mood, one logical change per commit. The body says why.
- Open a pull request against `main`, say what changed and what you ran, and wait for CI.
