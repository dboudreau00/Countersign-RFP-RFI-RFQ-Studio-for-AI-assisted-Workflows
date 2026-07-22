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
   - **Google Gemini** — paste a Gemini key
   - **OpenAI-compatible / Copilot endpoint** — base URL + key
4. Optional: toggle **◐ Dark mode** in the sidebar (follows OS preference by default).

> Keys entered this way live only in that browser session's memory and are sent
> only to the provider. They are never persisted or embedded in the page.

## Shipping a shared knowledge base (the directory file)

1. In the app, build your documentation bucket (page 1), then click
   **↓ Export workspace file**. This downloads `countersign-data.json`
   (bucket + question ledger + settings — never API keys).
2. Upload `countersign-data.json` to the **same directory** as the HTML file.
3. Any fresh visitor's copy auto-loads it on first open, so the whole team
   starts from the same source bucket. Users with existing local work are not
   overwritten — they can pull it manually with **⟳ Load from site directory**.

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

Then in the app: **Team server proxy**, URL: `https://yourhost:8787/proxy`.

- If the HTML is served from a *different* origin than the proxy, set
  `ALLOW_ORIGIN=https://your-site.example` (it defaults to `*`; tighten it).
- Best practice is to reverse-proxy it behind the same domain
  (nginx: `location /rfp/proxy { proxy_pass http://127.0.0.1:8787/proxy; }`)
  so CORS never comes into play and TLS is handled once.
- Keep it alive with `pm2 start proxy.js` or a systemd unit.

### What the proxies enforce

- **POST only**, JSON only, body capped at ~400 KB.
- **Model allowlist** (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001` by
  default — edit the array to taste). Unknown models are silently replaced
  with the default rather than rejected, so the app keeps working.
- **`max_tokens` ceiling** of 1024 regardless of what the client sends.
- **Team token** check via the `X-Team-Token` header when configured.
- Unknown fields are stripped before forwarding; only `model`, `max_tokens`,
  `messages`, and `system` pass through.

## Security notes — read these

- **Never hard-code an API key into the HTML page.** Anyone can View Source.
  Use the proxy, or have each user paste their own key at runtime.
- **Always set a team token** on an internet-facing proxy. Without it, anyone
  who discovers the URL can bill your Anthropic account. For an internal tool,
  also consider IP-allowlisting the directory (`.htaccess` on Apache).
- **Serve over HTTPS.** The team token and all RFP content travel in requests.
- **Rate limiting is on you.** These are sketch-grade proxies: they cap request
  size and tokens but do not throttle request *frequency*. On Apache, `mod_ratelimit`
  or fail2ban helps; on Node, put nginx `limit_req` in front for real traffic.
- The `countersign-data.json` directory file is **publicly readable** wherever
  you host it. Don't put anything in the bucket you wouldn't hand to whoever can
  reach that URL; password-protect the directory if the docs are sensitive.
- Rotate the API key if you ever suspect the proxy was abused; usage is visible
  in the Anthropic console.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Proxy 401 (check the team token)` | Token in AI settings doesn't match the server's `COUNTERSIGN_TOKEN`. |
| `Proxy 500 — Server not configured` | `ANTHROPIC_API_KEY` not set on the server. |
| `Claude API 401 — check your API key` | Bad/expired key in "Claude (your API key)" mode. |
| Requests fail only when self-hosted with the *built-in* Claude provider | The keyless built-in provider only works inside Claude.ai. Self-hosted deployments must use "Claude (your API key)" or the team proxy. |
| CORS error hitting the Node proxy | Set `ALLOW_ORIGIN` to your site's origin, or reverse-proxy onto the same domain. |
| Browser storage quota errors with a huge bucket | localStorage is ~5–10 MB in most browsers. Keep the master bucket in `countersign-data.json` (auto-loaded each visit) rather than relying on local persistence. |
| `413 Request too large` from the proxy | A single question pulled a very large context. Raise `MAX_BODY_BYTES` in the proxy if you've raised the app's retrieval budget. |

## Deployment layout (typical cPanel)

```
public_html/
└── rfp/
    ├── index.html              <- countersign-rfp-studio.html, renamed
    ├── proxy.php               <- holds the API key server-side
    └── countersign-data.json   <- shared team bucket (exported from the app)
```

That's the whole stack: one page, one proxy, one data file.

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
"Generate all answers" streams a whole-RFP `/batch` back into the ledger live,
the gap report scores questions against the *server's* knowledge base via
`/search`, and page 1 gains "Check engine" / "Push bucket to engine" buttons to
sync your local documents up with one click.
