# Countersign Engine

A standalone RAG (retrieval-augmented generation) server, zero dependencies,
Node 18+. It holds your Anthropic API key and your documentation knowledge
base, and turns any question into a documentation-grounded answer over HTTP.
The Countersign web app can use it, but so can a CRM, a Slack bot, a portal
autofill script, or plain `curl`.

## How it works

```
question ──> tokenize + expand acronyms (SSO → single sign-on, …)
         ──> TF-IDF score every chunk in the knowledge base
         ──> pack the best chunks (≤ ~11 KB) into a grounded prompt
         ──> Claude drafts the answer under anti-hallucination rules
         <── { answer, sources, coverage, missing_terms }
```

The prompt forbids inventing certifications, SLAs, customers, or figures not
present in the retrieved material, and question `type` switches in specialised
rules (compliance answers open with a hard Yes/No/Partially verdict, etc).

## Run it

```bash
ANTHROPIC_API_KEY=sk-ant-...        \
COUNTERSIGN_TOKEN=your-passphrase   \
node engine.js
# -> Countersign Engine on http://0.0.0.0:8790 · 42 docs / 1187 chunks · token required
```

| Env var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required for /answer, /proxy) | Your Anthropic key, server-side only |
| `COUNTERSIGN_TOKEN` | *(off)* | Shared secret; all POSTs must send `X-Team-Token` |
| `PORT` | `8790` | Listen port |
| `KB_DIR` | `./kb` | Directory of `.txt/.md/.csv/.json` sources |
| `DATA_FILE` | `./countersign-data.json` | Workspace exported from the web app |
| `MODEL` | `claude-sonnet-4-6` | Generation model |
| `ALLOW_ORIGIN` | `*` | CORS origin for browser callers — tighten in production |
| `CONCURRENCY` | `2` | Parallel upstream calls for `/batch` (max 4) |

## Feeding the knowledge base

Three ways, freely combined; everything is indexed together at boot:

1. **Web-app export (recommended for PDFs/DOCX/XLSX).** Build the bucket in the
   Countersign app — it parses binary formats in the browser — then
   *Export workspace file* and place `countersign-data.json` next to `engine.js`.
2. **`kb/` directory.** Drop plain `.txt`, `.md`, `.csv`, or `.json` files in it.
3. **`POST /ingest` at runtime.** Pushed documents are persisted into `kb/`
   so they survive restarts.

## API

All POST bodies are JSON. When a team token is configured, send it as the
`X-Team-Token` header on every POST.

### `GET /health`
```json
{ "ok": true, "docs": 42, "chunks": 1187, "model": "claude-sonnet-4-6", "token_required": true }
```

### `POST /answer` — the main event
Request:
```json
{
  "question": "Do you support SAML SSO with Okta?",
  "type": "compliance",          // optional: compliance | technical | commercial | narrative
  "tone": "formal, suitable for public-sector procurement",   // optional
  "max_words": 120               // optional, capped at 500
}
```
Response:
```json
{
  "answer": "Yes. Our platform supports SAML 2.0 and OIDC single sign-on, with first-class integrations for Okta, ...",
  "sources": ["sso-guide.pdf"],
  "coverage": 0.82,
  "chunks_used": 4,
  "missing_terms": [],
  "model": "claude-sonnet-4-6"
}
```
`coverage` (0–1) estimates how well the knowledge base substantiates the
question; `missing_terms` lists query concepts found nowhere in the KB — a
low-coverage answer with many missing terms is your cue to add documentation
rather than trust the output.

### `POST /search` — retrieval only, no AI call
```json
{ "query": "encryption key rotation", "k": 5 }
```
Returns the top chunks with sources, coverage and missing terms. Free and
instant — useful for debugging the KB or wiring "related docs" features.

### `POST /batch` — a whole RFP in one call
Send an array of questions; answers **stream back as NDJSON** (one JSON object
per line) the moment each completes, processed by a small worker pool
(`CONCURRENCY` env, default 2, max 4) with one automatic retry on rate-limit
or overload responses. Up to 100 questions per call.

Request:
```json
{
  "questions": [
    { "ref": "3.1", "question": "Do you support SAML SSO?", "type": "compliance" },
    { "ref": "3.2", "question": "Describe encryption at rest.", "type": "technical" },
    { "ref": "7.4", "question": "Outline your pricing model.", "type": "commercial" }
  ],
  "tone": "formal, suitable for public-sector procurement",
  "max_words": 180
}
```
Per-item `type`/`tone`/`max_words` override the batch-level values. Optional
`id`/`ref` fields are echoed back so you can match answers to your rows.

Stream (`Content-Type: application/x-ndjson`), one line per event:
```
{"kind":"start","total":3,"model":"claude-sonnet-4-6","concurrency":2}
{"kind":"answer","index":1,"ref":"3.2","answer":"All customer data is encrypted at rest...","sources":["security.txt"],"coverage":0.81,"chunks_used":4,"missing_terms":[],"ms":2140}
{"kind":"answer","index":0,"ref":"3.1","answer":"Yes. Our platform supports SAML 2.0...","sources":["sso-guide.pdf"],"coverage":0.77,"chunks_used":3,"missing_terms":[],"ms":2610}
{"kind":"error","index":2,"ref":"7.4","status":429,"message":"Upstream 429 — rate limited"}
{"kind":"done","total":3,"succeeded":2,"failed":1,"elapsed_ms":5320}
```
Answers arrive in **completion order**, not input order — use `index`/`ref` to
place them. Failed items don't abort the batch. If the client disconnects
mid-stream, the engine stops launching further upstream calls.

Prefer one plain JSON response instead of a stream? Add `"stream": false` and
you'll get `{ ...done-summary, results: [...] }` with results sorted by index —
handy for PHP or anything that dislikes chunked reads.

**curl** (`-N` disables buffering so lines print live):
```bash
curl -N -s http://localhost:8790/batch \
  -H 'Content-Type: application/json' -H 'X-Team-Token: your-passphrase' \
  -d @questions.json
```

**JavaScript** stream reader:
```js
const res = await fetch(url + "/batch", { method: "POST", headers, body });
const reader = res.body.getReader(), dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.trim()) handleEvent(JSON.parse(line));   // kind: start | answer | error | done
  }
}
```

### `POST /ingest` / `POST /forget`
```json
{ "name": "sla-policy.txt", "text": "We guarantee 99.95% uptime..." }
{ "name": "sla-policy.txt" }
```
Plain text only — parse binary formats client-side or via the web app.

### `POST /proxy`
Raw Anthropic `/v1/messages` pass-through (model allowlisted, tokens capped).
This makes the engine a drop-in replacement for `proxy.js`: point the web
app's **Team server proxy** at `http://host:8790/proxy` and you only run one
server for both the app and the engine.

## Client examples

**curl**
```bash
curl -s http://localhost:8790/answer \
  -H 'Content-Type: application/json' \
  -H 'X-Team-Token: your-passphrase' \
  -d '{"question":"What is your disaster recovery RPO and RTO?","type":"technical"}'
```

**JavaScript**
```js
const r = await fetch("http://localhost:8790/answer", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Team-Token": TOKEN },
  body: JSON.stringify({ question, type: "technical" }),
});
const { answer, sources, coverage } = await r.json();
```

**PHP**
```php
$ch = curl_init('http://localhost:8790/answer');
curl_setopt_array($ch, [
  CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Team-Token: your-passphrase'],
  CURLOPT_POSTFIELDS => json_encode(['question' => 'Do you offer volume discounts?', 'type' => 'commercial']),
]);
$result = json_decode(curl_exec($ch), true);
```

## Production notes

- Set `COUNTERSIGN_TOKEN` and a specific `ALLOW_ORIGIN`; serve behind HTTPS
  (reverse-proxy with nginx/Caddy — the engine itself speaks plain HTTP).
- The engine holds the whole index in memory: a full 60 MB knowledge base is
  roughly 55k chunks and retrieval stays well under 100 ms, but budget RAM
  accordingly (~3–4× the raw text size).
- No request-frequency throttling is built in — add nginx `limit_req` for
  internet-facing deployments; every `/answer` call costs API credits.
- Retrieval is lexical (TF-IDF + an acronym alias table), which is transparent
  and dependency-free but not semantic: a question phrased with entirely
  different vocabulary than your docs can miss. The `missing_terms` field
  tells you exactly when that happened. Swapping in embeddings later only
  requires replacing the `retrieve()` function — the API contract stays the same.
