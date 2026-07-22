/**
 * Countersign Engine — standalone RAG server (Node 18+, zero dependencies)
 * -------------------------------------------------------------------------
 * A self-contained answer engine: holds your API key, holds your knowledge
 * base, and turns questions into documentation-grounded answers over HTTP.
 * Anything can call it — the Countersign web app, a CRM, a Slack bot, curl.
 *
 * Knowledge base sources (all optional, combined):
 *   1. countersign-data.json  — a workspace exported from the web app
 *                               (the app parses PDF/DOCX/XLSX in-browser,
 *                               so this is how binary formats get in)
 *   2. kb/ directory          — plain .txt / .md / .csv files
 *   3. POST /ingest           — push documents at runtime (persisted to kb/)
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... COUNTERSIGN_TOKEN=secret node engine.js
 *
 * Env:
 *   PORT=8790                 listen port
 *   KB_DIR=./kb               directory of plain-text sources
 *   DATA_FILE=./countersign-data.json
 *   MODEL=claude-sonnet-4-6   generation model
 *   ALLOW_ORIGIN=*            CORS origin for browser callers
 *   COUNTERSIGN_TOKEN=...     shared secret; required on every POST when set
 *
 * Endpoints (JSON in, JSON out; X-Team-Token header when token is set):
 *   GET  /health   -> { ok, docs, chunks, model }
 *   POST /search   -> { query, k? }            => top chunks, no AI call
 *   POST /answer   -> { question, tone?, type?, max_words? }
 *                                              => grounded answer + sources
 *   POST /ingest   -> { name, text }           => add/replace a document
 *   POST /forget   -> { name }                 => remove a document
 *   POST /proxy    -> raw Anthropic /v1/messages pass-through (web-app compat)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

/* ---------------- config ---------------- */
const API_KEY      = process.env.ANTHROPIC_API_KEY || "";
const TEAM_TOKEN   = process.env.COUNTERSIGN_TOKEN || "";
const PORT         = parseInt(process.env.PORT || "8790", 10);
const KB_DIR       = process.env.KB_DIR || path.join(__dirname, "kb");
const DATA_FILE    = process.env.DATA_FILE || path.join(__dirname, "countersign-data.json");
const MODEL        = process.env.MODEL || "claude-sonnet-4-6";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const CHUNK_SIZE     = 1100;   // chars per retrieval chunk
const CONTEXT_BUDGET = 11000;  // chars of retrieved context per answer
const MAX_BODY_BYTES = 1_500_000; // /ingest can carry a whole document
const MAX_DOC_CHARS  = 220000;
const CONCURRENCY    = Math.min(Math.max(parseInt(process.env.CONCURRENCY || "2", 10) || 2, 1), 4);
const MAX_BATCH      = 100;

/* ================================================================
   Knowledge base: load, chunk, TF-IDF index
================================================================ */
const STOP = new Set(("the a an and or of to in for with on is are does do your our you we can how what which " +
  "will be by as at from that this it its any all provide describe please detail").split(" "));
const tokenize = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ")
  .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)))];
const termFreqs = (s) => {
  const tf = Object.create(null);
  for (const w of String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
    if (w.length > 2 && !STOP.has(w)) tf[w] = (tf[w] || 0) + 1;
  }
  return tf;
};

const KB = { docs: new Map(), chunks: [], df: Object.create(null), idf: Object.create(null) };

function reindex() {
  KB.chunks = [];
  KB.df = Object.create(null);
  for (const [name, text] of KB.docs) {
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const t = text.slice(i, i + CHUNK_SIZE + 200);
      const tf = termFreqs(t);
      KB.chunks.push({ doc: name, text: t, tf });
      for (const term in tf) KB.df[term] = (KB.df[term] || 0) + 1;
    }
  }
  const N = Math.max(1, KB.chunks.length);
  KB.idf = Object.create(null);
  for (const term in KB.df) KB.idf[term] = Math.log(1 + N / KB.df[term]);
  console.log(`[kb] indexed ${KB.docs.size} docs -> ${KB.chunks.length} chunks`);
}

const canonicalName = (name) => {
  const safe = String(name).replace(/[^a-zA-Z0-9 ._-]/g, "_").slice(0, 120) || "doc";
  return /\.(txt|md|csv|json)$/i.test(safe) ? safe : safe + ".txt";
};
function addDoc(name, text, persist) {
  text = String(text).replace(/\u0000/g, "").trim().slice(0, MAX_DOC_CHARS);
  if (!text) return false;
  // persisted docs are stored under their canonical filename, so use the same
  // key in memory — /forget and re-ingest then behave identically across restarts
  const key = persist ? canonicalName(name) : name;
  KB.docs.set(key, text);
  if (persist) {
    try {
      fs.mkdirSync(KB_DIR, { recursive: true });
      fs.writeFileSync(path.join(KB_DIR, key), text);
    } catch (e) { console.warn("[kb] persist failed:", e.message); }
  }
  return key;
}

function loadKnowledgeBase() {
  // 1. workspace export from the web app
  try {
    const ws = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (ws && Array.isArray(ws.docs)) {
      for (const d of ws.docs) if (d.name && d.text) addDoc(d.name, d.text, false);
      console.log(`[kb] loaded ${ws.docs.length} docs from ${path.basename(DATA_FILE)}`);
    }
  } catch (e) { /* file absent is fine */ }
  // 2. plain-text directory
  try {
    for (const f of fs.readdirSync(KB_DIR)) {
      if (!/\.(txt|md|csv|json)$/i.test(f)) continue;
      if (/^countersign-data\.json$/i.test(f) || /^README\.txt$/i.test(f)) continue; // workspace exports & folder docs aren't KB sources
      addDoc(f, fs.readFileSync(path.join(KB_DIR, f), "utf8"), false);
    }
  } catch (e) { /* dir absent is fine */ }
  reindex();
}

/* Small alias table so acronym-heavy RFP questions still hit spelled-out docs */
const ALIASES = {
  sso: ["single", "sign"], mfa: ["multi", "factor", "authentication"],
  dr: ["disaster", "recovery"], sla: ["service", "level", "uptime"],
  bcp: ["business", "continuity"], iam: ["identity", "access"],
  pii: ["personal", "data"], dpa: ["data", "processing"],
  uptime: ["availability"], pricing: ["price", "cost", "licensing"],
};
const expandTerms = (terms) => {
  const out = new Set(terms);
  for (const t of terms) if (ALIASES[t]) for (const a of ALIASES[t]) out.add(a);
  return [...out];
};

function retrieve(question, budget = CONTEXT_BUDGET) {
  const qTerms = expandTerms(tokenize(question));
  const scored = [];
  for (const ch of KB.chunks) {
    let score = 0;
    for (const t of qTerms) if (ch.tf[t]) score += ch.tf[t] * (KB.idf[t] || 1);
    if (score > 0) scored.push({ score, ch });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [], sources = new Set();
  let used = 0;
  for (const s of scored) {
    if (used + s.ch.text.length > budget) continue;
    picked.push(s); sources.add(s.ch.doc); used += s.ch.text.length;
    if (picked.length >= 12) break;
  }
  const inKB = (t) => !!KB.df[t] || (ALIASES[t] || []).some(a => KB.df[a]);
  const termsCovered = qTerms.filter(inKB).length;
  const coverage = qTerms.length
    ? Math.min(1, (termsCovered / qTerms.length) * 0.6 + Math.min(picked.length, 6) / 6 * 0.4)
    : 0;
  return {
    context: picked.map(s => `[Source: ${s.ch.doc}]\n${s.ch.text}`).join("\n\n---\n\n"),
    sources: [...sources],
    coverage,
    chunks_used: picked.length,
    missing_terms: qTerms.filter(t => !inKB(t)),
  };
}

/* ================================================================
   Generation
================================================================ */
const TYPE_RULES = {
  compliance: 'This is a COMPLIANCE question: open with a one-word verdict — "Yes.", "No." or "Partially." — then substantiate briefly. Only answer "Yes" if the reference material supports it.',
  technical:  "This is a TECHNICAL question: be concrete about architecture, standards and mechanisms; evaluators are engineers. Avoid marketing language.",
  commercial: "This is a COMMERCIAL question: describe the pricing/licensing model and flexibility without quoting exact figures unless they appear in the reference material.",
  narrative:  "This is a NARRATIVE question: tell a credible, client-focused story about capability and approach.",
};

function buildPrompt(question, retrieval, opts) {
  const tone = opts.tone || "professional and precise";
  const words = Math.min(parseInt(opts.max_words, 10) || 220, 500);
  const typeRule = TYPE_RULES[opts.type] || "";
  return `You are a senior proposal writer for a SaaS vendor, drafting an answer to one RFP question.

Write in first-person plural ("we", "our platform"), tone: ${tone}. Target about ${words} words. ${typeRule} Be specific and confident; never invent certifications, customers, SLAs or numbers that are not in the reference material. If the reference material doesn't cover something, answer at the level it supports and note what can be confirmed on request. Respond with the answer text only — no headings, no preamble.

REFERENCE MATERIAL FROM OUR DOCUMENTATION:
${retrieval.context || "(No matching documentation found — write a competent generic SaaS response and clearly hedge specifics.)"}

RFP QUESTION: ${question}`;
}

async function callClaude(body) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await r.text();
    return { status: r.status, text };
  } catch (err) {
    return { status: 504, text: JSON.stringify({ error: { type: "timeout", message: "Upstream timed out or aborted: " + err.message } }) };
  }
}

/* ================================================================
   HTTP server
================================================================ */
function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
const fail = (res, code, message) => send(res, code, { error: { type: "engine_error", message } });

const routes = {
  "/answer": async (res, body) => {
    if (typeof body.question !== "string" || body.question.trim().length < 3)
      return fail(res, 400, "Provide { question: string }");
    const retrieval = retrieve(body.question);
    const up = await callClaude({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: buildPrompt(body.question, retrieval, body) }],
    });
    if (up.status !== 200) return send(res, up.status, up.text);
    let answer = "";
    try {
      const data = JSON.parse(up.text);
      answer = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("").trim();
    } catch (e) { return fail(res, 502, "Bad upstream response"); }
    send(res, 200, {
      answer,
      sources: retrieval.sources,
      coverage: Math.round(retrieval.coverage * 100) / 100,
      chunks_used: retrieval.chunks_used,
      missing_terms: retrieval.missing_terms,
      model: MODEL,
    });
  },

  "/search": async (res, body) => {
    if (typeof body.query !== "string") return fail(res, 400, "Provide { query: string }");
    const k = Math.min(parseInt(body.k, 10) || 5, 20);
    const r = retrieve(body.query, CHUNK_SIZE * (k + 1));
    send(res, 200, {
      query: body.query,
      coverage: Math.round(r.coverage * 100) / 100,
      sources: r.sources,
      missing_terms: r.missing_terms,
      chunks: r.context ? r.context.split("\n\n---\n\n").slice(0, k) : [],
    });
  },

  "/ingest": async (res, body) => {
    if (typeof body.name !== "string" || typeof body.text !== "string")
      return fail(res, 400, "Provide { name: string, text: string } (parse binary formats client-side or via the web app)");
    const stored = addDoc(body.name, body.text, true);
    if (!stored) return fail(res, 400, "Document text is empty");
    reindex();
    send(res, 200, { ok: true, name: stored, docs: KB.docs.size, chunks: KB.chunks.length });
  },

  "/forget": async (res, body) => {
    const gone = KB.docs.delete(body.name) || KB.docs.delete(canonicalName(body.name || ""));
    if (!gone) return fail(res, 404, "No such document");
    let removedFile = false;
    try { fs.unlinkSync(path.join(KB_DIR, canonicalName(body.name || ""))); removedFile = true; } catch (e) {}
    reindex();
    send(res, 200, { ok: true, docs: KB.docs.size, file_removed: removedFile });
  },

  "/batch": async (res, body) => {
    const items = Array.isArray(body.questions) ? body.questions : null;
    if (!items || !items.length)
      return fail(res, 400, "Provide { questions: [{ question, ref?, id?, type?, tone?, max_words? }] }");
    if (items.length > MAX_BATCH) return fail(res, 400, `Max ${MAX_BATCH} questions per batch`);
    for (const [i, it] of items.entries())
      if (typeof (it && it.question) !== "string" || it.question.trim().length < 3)
        return fail(res, 400, `questions[${i}].question must be a non-empty string`);

    const streaming = body.stream !== false;   // default: stream NDJSON lines as answers complete
    const t0 = Date.now();
    let closed = false;
    res.on("close", () => { closed = true; });

    const results = [];
    const emit = (obj) => {
      if (streaming) { if (!closed) res.write(JSON.stringify(obj) + "\n"); }
      else if (obj.kind === "answer" || obj.kind === "error") results.push(obj);
    };

    if (streaming) {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Access-Control-Allow-Origin": ALLOW_ORIGIN,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      emit({ kind: "start", total: items.length, model: MODEL, concurrency: CONCURRENCY });
    }

    let cursor = 0, ok = 0, failed = 0;

    async function processItem(i) {
      const it = items[i];
      const t = Date.now();
      const retrieval = retrieve(it.question);
      const opts = { type: it.type, tone: it.tone ?? body.tone, max_words: it.max_words ?? body.max_words };
      const payload = () => ({
        model: MODEL, max_tokens: 1000,
        messages: [{ role: "user", content: buildPrompt(it.question, retrieval, opts) }],
      });
      let up = await callClaude(payload());
      if ((up.status === 429 || up.status >= 500) && !closed) {   // one retry on rate-limit/overload
        await new Promise(r => setTimeout(r, 2000));
        up = await callClaude(payload());
      }
      if (up.status !== 200) {
        failed++;
        let message = "Upstream " + up.status;
        try { message += " — " + JSON.parse(up.text).error.message; } catch (e) {}
        return emit({ kind: "error", index: i, id: it.id, ref: it.ref, question: it.question, status: up.status, message });
      }
      let answer = "";
      try {
        const d = JSON.parse(up.text);
        answer = (d.content || []).map(b => (b.type === "text" ? b.text : "")).join("").trim();
      } catch (e) {
        failed++;
        return emit({ kind: "error", index: i, id: it.id, ref: it.ref, question: it.question, status: 502, message: "Bad upstream response" });
      }
      ok++;
      emit({
        kind: "answer", index: i, id: it.id, ref: it.ref, question: it.question, answer,
        sources: retrieval.sources,
        coverage: Math.round(retrieval.coverage * 100) / 100,
        chunks_used: retrieval.chunks_used,
        missing_terms: retrieval.missing_terms,
        ms: Date.now() - t,
      });
    }

    async function worker() {
      while (!closed) {
        const i = cursor++;
        if (i >= items.length) return;
        await processItem(i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

    const done = { kind: "done", total: items.length, succeeded: ok, failed, elapsed_ms: Date.now() - t0 };
    if (streaming) { if (!closed) { res.write(JSON.stringify(done) + "\n"); res.end(); } }
    else send(res, 200, { ...done, results: results.sort((a, b) => a.index - b.index) });
  },

  "/proxy": async (res, body) => {  // web-app compatibility: raw pass-through
    if (!Array.isArray(body.messages)) return fail(res, 400, "Body must be Anthropic /v1/messages JSON");
    const up = await callClaude({
      model: MODEL,
      max_tokens: Math.min(parseInt(body.max_tokens, 10) || 1024, 1024),
      messages: body.messages,
      ...(typeof body.system === "string" ? { system: body.system } : {}),
    });
    send(res, up.status, up.text);
  },
};

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Team-Token",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }
  if (req.method === "GET" && url === "/health")
    return send(res, 200, { ok: true, docs: KB.docs.size, chunks: KB.chunks.length, model: MODEL, token_required: !!TEAM_TOKEN });
  if (req.method !== "POST" || !routes[url]) return fail(res, 404, "Unknown endpoint");
  if (!API_KEY && url !== "/ingest" && url !== "/forget" && url !== "/search")
    return fail(res, 500, "Server not configured: set ANTHROPIC_API_KEY");
  if (TEAM_TOKEN && req.headers["x-team-token"] !== TEAM_TOKEN)
    return fail(res, 401, "Missing or wrong team token");

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { fail(res, 413, "Request too large"); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { return fail(res, 400, "Invalid JSON"); }
    try { await routes[url](res, body); }
    catch (err) {
      if (res.headersSent) { try { res.end(); } catch (e) {} }
      else if (!res.writableEnded) fail(res, 502, "Engine error: " + err.message);
    }
  });
});

loadKnowledgeBase();
server.listen(PORT, () =>
  console.log(
    `Countersign Engine on http://0.0.0.0:${PORT}  ·  ${KB.docs.size} docs / ${KB.chunks.length} chunks` +
    (TEAM_TOKEN ? "  ·  token required" : "  ·  WARNING: no team token set")
  )
);
