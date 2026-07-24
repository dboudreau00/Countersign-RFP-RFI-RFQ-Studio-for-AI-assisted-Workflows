/**
 * Countersign — Anthropic API proxy (Node, zero dependencies, Node 18+)
 * ---------------------------------------------------------------------
 * Holds the API key server-side; the app's "Team server proxy" provider posts
 * Anthropic-format requests here and this forwards them.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... node proxy.js
 *
 * Optional env:
 *   PORT=8787                     listen port (default 8787)
 *   COUNTERSIGN_TOKEN=secret      shared team passphrase (recommended)
 *   ALLOW_ORIGIN=https://you.com  CORS origin if the HTML is served from a
 *                                 different host/port than this proxy
 *                                 (default: * — tighten this in production)
 *
 * In the app: AI settings -> "Team server proxy", URL: http://yourhost:8787/proxy
 * (If you reverse-proxy it behind the same domain as the HTML, CORS is a non-issue.)
 */

const http = require("http");

const API_KEY        = process.env.ANTHROPIC_API_KEY || "";
const TEAM_TOKEN     = process.env.COUNTERSIGN_TOKEN || "";
const PORT           = parseInt(process.env.PORT || "8787", 10);
const ALLOW_ORIGIN   = process.env.ALLOW_ORIGIN || "*";
const ALLOWED_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const DEFAULT_MODEL  = "claude-sonnet-4-6";
const MAX_TOKENS_CAP = 1024;
const MAX_BODY_BYTES = 400_000;

function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}
const fail = (res, code, message) =>
  send(res, code, { error: { type: "proxy_error", message } });

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Team-Token",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }
  if (req.method !== "POST" || !/^\/(proxy)?$/.test(req.url.split("?")[0]))
    return fail(res, req.method === "POST" ? 404 : 405, "POST /proxy only");
  if (!API_KEY) return fail(res, 500, "Server not configured: set ANTHROPIC_API_KEY");
  if (TEAM_TOKEN && req.headers["x-team-token"] !== TEAM_TOKEN)
    return fail(res, 401, "Missing or wrong team token");

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (res.writableEnded) {                     // 413 already sent — drain so the client can read it,
      if (size > MAX_BODY_BYTES * 8) req.destroy();  // but hard-stop a runaway upload
      return;
    }
    if (size > MAX_BODY_BYTES) {
      chunks.length = 0;
      fail(res, 413, "Request too large");       // destroying here would RST before the 413 arrives
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return fail(res, 400, "Invalid JSON"); }
    if (!Array.isArray(body?.messages))
      return fail(res, 400, "Body must be Anthropic /v1/messages JSON");

    const payload = {
      model: ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL,
      max_tokens: Math.min(parseInt(body.max_tokens, 10) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
      messages: body.messages,
    };
    if (typeof body.system === "string") payload.system = body.system;

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      send(res, upstream.status, await upstream.text());
    } catch (err) {
      fail(res, 502, "Upstream request failed: " + err.message);
    }
  });
});

server.listen(PORT, () =>
  console.log(
    `Countersign proxy on http://0.0.0.0:${PORT}/proxy` +
    (TEAM_TOKEN ? " (team token required)" : " (WARNING: no team token set)")
  )
);
