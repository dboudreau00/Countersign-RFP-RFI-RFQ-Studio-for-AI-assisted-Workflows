# Countersign — RFP Response Studio

<img width="1451" height="1023" alt="Screenshot 2026-07-22 142928" src="https://github.com/user-attachments/assets/07cb55a9-7a7b-431f-8414-5b435c20c591" />



A single-file web app that automates SaaS RFP responses: parse a documentation
bucket (up to 500 sources), extract every question from an RFP (PDF, DOCX, XLSX,
CSV or pasted text), generate grounded answers with per-question citations and
coverage scoring, then export to DOCX, XLSX, CSV — or round-trip answers back
into the issuer's original spreadsheet.

## Files

| File | What it is |
|---|---|
| `index.html` | The entire app — a single self-contained HTML file. |
| `proxy.php` | Optional server-side API proxy for shared hosting (cPanel / public_html). |
| `proxy.js` | Optional server-side API proxy for Node 18+ hosts. |
| `engine.js` | Standalone RAG answer engine (Node 18+): knowledge base + retrieval + grounded `/answer` API. See `ENGINE.md`. |
| `ENGINE.md` | Full API reference and deployment guide for the engine. |
| `countersign-data.json` | Optional "directory file" — an exported workspace the app auto-loads. You create this from inside the app. |
| `kb/` | Plain-text knowledge base folder for `engine.js` (see `kb/README.txt`). |

## Quick start (no server code at all)

1. Upload `index.html` to any web root, e.g. `public_html/rfp/index.html`.
2. Open it in a browser. Work persists in each visitor's browser storage (localStorage).
3. Each user opens **⚙ AI settings** and picks a provider:
   - **Claude (your Anthropic API key)** — paste a key from console.anthropic.com
     (defaults to `claude-sonnet-4-6`)
   - **Google Gemini** — paste a Gemini key (defaults to `gemini-flash-latest`)
   - **OpenAI-compatible / Copilot endpoint** — base URL + key
4. Optional: toggle **◐ Dark mode** in the sidebar (follows OS preference by default).

> Keys entered this way live only in that browser session's memory and are sent
> only to the provider. They are never persisted or embedded in the page — which
> also means you re-enter the key (or team token) after every page reload.

> Leave the **Model** field blank to use the default shown above. Model names go
> out of date: if generation fails with a 404 naming your model, clear the field
> or pick a current one from the provider's model list.

## Shipping a shared knowledge base (the directory file)

1. In the app, build your documentation bucket (page 1), then click
   **↓ Export workspace file**. This downloads `countersign-data.json`
   (bucket + question ledger + settings — never API keys).
2. Upload `countersign-data.json` to the **same directory** as the HTML file.
3. A visitor with **no saved work** auto-loads it on first open, so the whole team
   starts from the same source bucket. Anyone with existing local work is not
   overwritten — they pull it manually with **⟳ Load from site directory**, which
   asks for confirmation first because importing replaces the whole workspace.

> The auto-load runs only when browser storage is empty. Once someone has a bucket
> or a ledger saved locally, re-uploading the file does **not** reach them until
> they press **⟳ Load from site directory**.

Update the shared bucket any time by re-exporting and re-uploading the JSON.

## Team proxy: one API key for everyone (recommended)

Instead of every user pasting a key, deploy one of the bundled proxies. The key
lives on the server; browsers never see it. Both proxies enforce a model
allowlist and a `max_tokens` cap, and support an optional shared **team token**
so strangers who find the URL can't spend your credits.

### Option A — PHP (`proxy.php`), for cPanel/shared hosting

Requires PHP 7.1+ with the curl extension (standard on virtually all shared hosts).

1. Upload `proxy.php` next to the HTML file, e.g. `public_html/rfp/proxy.php`.
2. Give it the key — either:
   - set `ANTHROPIC_API_KEY` as an environment variable in your hosting panel, **or**
   - edit the `$API_KEY` line at the top of the file.
3. Strongly recommended: set a team passphrase via the `COUNTERSIGN_TOKEN`
   env var or the `$TEAM_TOKEN` line.
4. In the app: **⚙ AI settings → Team server proxy**, URL: `proxy.php`,
   team token: your passphrase. Save.

Because the proxy sits in the same directory as the page, there is no CORS to
configure and the relative URL `proxy.php` just works.

### Option B — Node (`proxy.js`), for a VPS or app platform

Requires Node 18+ (uses the built-in `fetch`). Zero npm dependencies.

```bash
ANTHROPIC_API_KEY=sk-ant-...   \
COUNTERSIGN_TOKEN=your-team-passphrase \
PORT=8787 \
node proxy.js
```

Then in the app: **Team server proxy**, URL: `http://yourhost:8787/proxy`.

> **`proxy.js` speaks plain HTTP — it has no TLS of its own.** For anything other
> than a localhost trial, put it behind a reverse proxy that terminates HTTPS. This
> is a requirement, not a nicety: if the page itself is served over HTTPS (and it
> should be), the browser blocks a plain `http://` request from it as mixed content,
> and an `https://yourhost:8787/proxy` URL fails the TLS handshake because nothing
> is listening for TLS on that port.

- **Recommended:** reverse-proxy it behind the same domain as the HTML
  (nginx: `location /rfp/proxy { proxy_pass http://127.0.0.1:8787/proxy; }`),
  then set the app's proxy URL to the relative path `proxy` — TLS is handled once
  and CORS never comes into play. `proxy.js` accepts `/proxy` at any mount point,
  so a subpath like `/rfp/proxy` works without extra configuration.
- If the HTML really is served from a *different* origin than the proxy, set
  `ALLOW_ORIGIN=https://your-site.example` (it defaults to `*`; tighten it).
- Keep it alive with `pm2 start proxy.js` or a systemd unit.

### What the proxies enforce

- **POST only**, body parsed as JSON and capped at ~400 KB. (The body must *be*
  JSON; neither proxy inspects the `Content-Type` header.)
- **Model allowlist** (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001` by
  default — edit the array to taste). Unknown models are silently replaced
  with the default rather than rejected, so the app keeps working.
- **`max_tokens` ceiling** of 8192 regardless of what the client sends. This has
  to stay above what the app asks for on its largest call — "Extract questions"
  returns a JSON array of up to 40 items, and a tighter ceiling truncates that
  JSON mid-array.
- **Team token** check via the `X-Team-Token` header when configured, compared
  in constant time.
- Unknown fields are stripped before forwarding; only `model`, `max_tokens`,
  `messages`, and `system` pass through.

## Security notes — read these

- **Never hard-code an API key into the HTML page.** Anyone can View Source.
  Use the proxy, or have each user paste their own key at runtime.
- **Always set a team token** on an internet-facing proxy. Without it, anyone
  who discovers the URL can bill your Anthropic account. For an internal tool,
  also consider IP-allowlisting the directory (`.htaccess` on Apache).
- **Serve over HTTPS.** The team token and all RFP content travel in requests.
  `proxy.js` and `engine.js` speak plain HTTP, so terminate TLS in front of them.
- **Treat `countersign-data.json` as trusted input.** The app loads it into the
  bucket and ledger; only publish files you produced yourself with
  **↓ Export workspace file**.
- **Rate limiting is on you.** These are sketch-grade proxies: they cap request
  size and tokens but do not throttle request *frequency*. On Apache, `mod_ratelimit`
  or fail2ban helps; on Node, put nginx `limit_req` in front for real traffic.
- The `countersign-data.json` directory file is **publicly readable** wherever
  you host it. Don't put anything in the bucket you wouldn't hand to whoever can
  reach that URL; password-protect the directory if the docs are sensitive.
- Rotate the API key if you ever suspect the proxy was abused; usage is visible
  in the Anthropic console.

## Troubleshooting

Provider errors now carry the provider's own explanation after the status code,
so the message itself usually names the fix.

| Symptom | Likely cause / fix |
|---|---|
| `Proxy (check the team token) 401 — …` | Token in AI settings doesn't match the server's `COUNTERSIGN_TOKEN`. |
| `Proxy 500 — Server not configured: set ANTHROPIC_API_KEY` | The key isn't set on the server. |
| `Claude API (check your API key) 401 — …` | Bad/expired key in "Claude (your API key)" mode. |
| `Gemini API (unknown model "…") 404 — …` | The model name in AI settings no longer exists. Clear the field to use the current default, or set a model from `GET https://generativelanguage.googleapis.com/v1beta/models`. |
| `Gemini API 429 — You exceeded your current quota` | Free-tier rate limit. Wait, switch model, or enable billing. The app already retries once automatically. |
| `Engine 401 / 404 / 500 — …` | Countersign Engine provider: check the URL, the team token, and that `engine.js` is running (**⟲ Check engine** on page 1 reports its status). |
| "The engine stream ended early" | The `/batch` connection dropped mid-stream. Unanswered rows are stamped **Failed** — regenerate those individually. |
| Requests fail only when self-hosted with the *built-in* Claude provider | The keyless built-in provider only works inside Claude.ai. Self-hosted deployments must use "Claude (your API key)", the team proxy, or the engine. |
| CORS error hitting the Node proxy | Set `ALLOW_ORIGIN` to your site's origin, or reverse-proxy onto the same domain. |
| Team token is empty after a page reload | Keys and tokens are held in memory for the session only and are never persisted. Re-enter it in **⚙ AI settings** after a reload. |
| Browser storage quota errors with a huge bucket | localStorage is ~5–10 MB in most browsers. Keep the master bucket in `countersign-data.json` and pull it with **⟳ Load from site directory** rather than relying on local persistence. |
| `413 Request too large` from the proxy | A single question pulled a very large context. Raise `MAX_BODY_BYTES` in the proxy if you've raised the app's retrieval budget. |
| "Some libraries didn't load" on open | A CDN is blocked. The app still runs; the affected formats (PDF/DOCX/XLSX parsing, DOCX export) are unavailable until the CDN is reachable. |

## Deployment layout (typical cPanel)

```
public_html/
└── rfp/
    ├── index.html              <- countersign-rfp-studio.html, renamed
    ├── proxy.php               <- holds the API key server-side
    └── countersign-data.json   <- shared team bucket (exported from the app)
```

That's the whole stack: one page, one proxy, one data file.

## Known limits

- **Round-trip export rewrites the issuer's workbook through SheetJS**, which models
  cell values, formulas and sheet structure but not every Excel feature. Data-validation
  dropdowns, conditional formatting, comments, images and charts in the original
  questionnaire are not carried into the completed copy. Cell values, the sheet layout
  and other tabs survive. If the issuer requires their exact template back, paste the
  answers into their file from the XLSX export instead.
- **Retrieval is lexical**, not semantic. A question worded with entirely different
  vocabulary than your documentation can score as a gap even when the material is there
  (the gap report lists the specific terms it could not find, so this is visible). It is
  tuned to over-flag rather than miss: reviewing a false gap costs a minute, shipping an
  unsubstantiated answer costs the bid.
- **Question extraction depends on the model.** It asks for at most 40 items and merges
  duplicates, so a very long RFP may come back consolidated. Check the ledger against the
  source document before generating; the app warns when a reply was cut off mid-list.

## Going further: the answer engine

`engine.js` (documented in `ENGINE.md`) is a superset of `proxy.js`: it also
loads your knowledge base server-side (from `countersign-data.json` and/or a
`kb/` folder) and exposes `POST /answer` — question in, documentation-grounded
answer with sources and a coverage score out. Use it to wire RFP answering into
anything beyond the web app: portals, bots, scripts. Its `/proxy` endpoint is
drop-in compatible with the app's Team server proxy setting, so one process
serves both.

The web app also has a native **Countersign Engine** provider (⚙ AI settings):
point it at the engine's URL and generation switches to server-side retrieval —
"Generate all answers" streams the RFP back into the ledger live through `/batch`
(sent in consecutive batches of 100, the engine's per-call limit), the gap report
scores questions against the *server's* knowledge base via `/search`, and page 1
gains "Check engine" / "Push bucket to engine" buttons to sync your local
documents up with one click.
