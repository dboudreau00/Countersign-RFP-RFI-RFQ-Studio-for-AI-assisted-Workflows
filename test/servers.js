/**
 * Behaviour checks for engine.js, proxy.js and (when `php` is installed) proxy.php,
 * run against a local fake of the Anthropic Messages API. Zero dependencies.
 *
 *   node test/servers.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "countersign-test-"));
const TOKEN = "test-token";
const NODE = process.execPath;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ": " + detail}`);
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(port, method, urlPath, payload, headers = {}) {
  return new Promise((resolve) => {
    const data = payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload);
    const r = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (e) {} resolve({ status: res.statusCode, text, json }); });
    });
    r.on("error", (e) => resolve({ status: 0, text: e.message, json: null }));
    if (data) r.write(data);
    r.end();
  });
}

function startProcess(cmd, args, env, readyPort) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore" });
  return new Promise((resolve) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const s = net.connect(readyPort, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(child); });
      s.on("error", () => (Date.now() > deadline ? resolve(child) : setTimeout(poll, 100)));
    };
    poll();
  });
}

function exitCode(args, env, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { env: { ...process.env, ...env }, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, ms);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

const seen = [];
let flaky = 0;
const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    seen.push({ headers: req.headers, body });
    const prompt = JSON.stringify(body.messages);
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const message = (content, stop_reason = "end_turn", extra = {}) =>
      reply(200, { id: "msg_test", type: "message", role: "assistant", model: body.model, content, stop_reason, ...extra });
    if (prompt.includes("REFUSEME")) return message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "" } });
    if (prompt.includes("EMPTYME")) return message([{ type: "thinking", thinking: "", signature: "s" }], "max_tokens");
    if (prompt.includes("FLAKYME") && flaky++ === 0) return reply(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    message([{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "We encrypt data at rest with AES-256-GCM." }]);
  });
});
const lastBody = () => seen[seen.length - 1].body;

async function main() {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/messages`;
  const copy = (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (!src.includes("https://api.anthropic.com/v1/messages")) throw new Error(`${file}: upstream URL not found`);
    fs.writeFileSync(path.join(WORK, file), src.split("https://api.anthropic.com/v1/messages").join(upstreamUrl));
  };
  ["engine.js", "proxy.js", "proxy.php"].forEach(copy);
  const ENGINE = path.join(WORK, "engine.js"), PROXY = path.join(WORK, "proxy.js");

  const kb = path.join(WORK, "kb");
  fs.mkdirSync(kb);
  const doc = "Encryption at rest uses AES-256-GCM with keys in AWS KMS. Single sign-on supports SAML 2.0 with Okta.\n".repeat(30);
  fs.writeFileSync(path.join(kb, "lf.txt"), doc);
  fs.writeFileSync(path.join(kb, "crlf.txt"), doc.replace(/\n/g, "\r\n"));

  const T = { "X-Team-Token": TOKEN };
  const enginePort = await freePort(), proxyPort = await freePort();
  const children = [];
  children.push(await startProcess(NODE, [ENGINE], {
    ANTHROPIC_API_KEY: "sk-test", COUNTERSIGN_TOKEN: TOKEN, PORT: String(enginePort), KB_DIR: kb,
    DATA_FILE: path.join(WORK, "absent.json"), MODEL: "", HOST: "",
  }, enginePort));
  children.push(await startProcess(NODE, [PROXY], {
    ANTHROPIC_API_KEY: "sk-test", COUNTERSIGN_TOKEN: TOKEN, PORT: String(proxyPort), HOST: "",
  }, proxyPort));

  try {
    const engine = require(ENGINE);
    engine.KB.docs.clear();
    engine.addDoc("lf", doc, false);
    engine.addDoc("crlf", doc.replace(/\n/g, "\r\n"), false);
    const log = console.log; console.log = () => {};
    engine.reindex();
    console.log = log;
    const chunksOf = (d) => engine.KB.chunks.filter((c) => c.doc === d).map((c) => c.text);
    const a = chunksOf("lf"), b = chunksOf("crlf");
    check("CRLF and LF copies of a document chunk identically", a.length === b.length && a.every((t, i) => t === b[i]), `${a.length} vs ${b.length}`);
    check("answerText keeps text blocks only", engine.answerText({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }], stop_reason: "end_turn" }) === "hi");
    let err = "";
    try { engine.answerText({ content: [{ type: "text", text: "partial" }], stop_reason: "refusal", stop_details: { category: "bio" } }); } catch (e) { err = e.message; }
    check("answerText rejects a refusal even with partial text", /declined.*bio/.test(err), err);
    err = "";
    try { engine.retrieve("Will the Constructor maintain insurance for constructors?"); } catch (e) { err = e.message; }
    check("a question containing \"constructor\" does not crash retrieval", !err, err);

    let r = await request(enginePort, "GET", "/health");
    check("engine default model is claude-sonnet-5-5", r.json && r.json.model === "claude-sonnet-5-5", r.text);
    r = await request(enginePort, "POST", "/answer", { question: "How is data encrypted at rest?" });
    check("engine requires the team token", r.status === 401, String(r.status));
    r = await request(enginePort, "POST", "/search", JSON.stringify({ query: "encryption" }), { ...T, "Content-Type": "text/plain" });
    check("engine refuses a non-JSON body (no preflight-free cross-site POSTs)", r.status === 415, String(r.status));
    r = await request(enginePort, "POST", "/answer", { question: "How is data encrypted at rest?" }, T);
    const sent = seen[seen.length - 1];
    check("/answer returns the text block only", r.status === 200 && r.json.answer === "We encrypt data at rest with AES-256-GCM.", r.text);
    check("/answer leaves room for thinking (max_tokens 8192)", sent.body.max_tokens === 8192, String(sent.body.max_tokens));
    check("/answer sends no sampling parameters", !["temperature", "top_p", "top_k"].some((k) => k in sent.body));
    check("/answer sends anthropic-version", sent.headers["anthropic-version"] === "2023-06-01");
    r = await request(enginePort, "POST", "/answer", { question: "REFUSEME describe encryption" }, T);
    check("/answer reports a refusal as a 502 with its category", r.status === 502 && /declined.*cyber/.test(r.json.error.message), r.text);
    r = await request(enginePort, "POST", "/answer", { question: "EMPTYME describe encryption" }, T);
    check("/answer never returns an empty answer", r.status === 502 && /output tokens/.test(r.json.error.message), r.text);

    r = await request(enginePort, "POST", "/batch", { stream: false, questions: [
      { question: "How is data encrypted at rest?", ref: "1" },
      { question: "REFUSEME describe SSO", ref: "2" },
      { question: "EMPTYME describe SSO", ref: "3" },
      { question: "FLAKYME describe SSO", ref: "4" },
    ] }, T);
    const byRef = Object.fromEntries(((r.json && r.json.results) || []).map((x) => [x.ref, x]));
    check("/batch counts refusals and empty answers as failures", r.json && r.json.succeeded === 2 && r.json.failed === 2, r.text.slice(0, 200));
    check("/batch error line carries the refusal reason", byRef["2"] && /declined/.test(byRef["2"].message), JSON.stringify(byRef["2"]));
    check("/batch retries a 429 once", byRef["4"] && byRef["4"].kind === "answer", JSON.stringify(byRef["4"]));
    r = await request(enginePort, "POST", "/batch", { questions: [{ question: "How is data encrypted?" }] }, T);
    const kinds = r.text.trim().split("\n").map((l) => JSON.parse(l).kind).join(",");
    check("/batch streams start, answer, done", kinds === "start,answer,done", kinds);
    r = await request(enginePort, "POST", "/batch", { stream: false, questions: [
      { question: "Will the Constructor keep insurance?" }, { question: "How is data encrypted?" },
    ] }, T);
    check("/batch survives a question containing \"constructor\"", r.json && r.json.succeeded === 2, r.text.slice(0, 200));

    await request(enginePort, "POST", "/proxy", { model: "claude-opus-5-5", max_tokens: 999999, messages: [{ role: "user", content: "hi" }] }, T);
    check("engine /proxy pins its own model and caps max_tokens at 16384", lastBody().model === "claude-sonnet-5-5" && lastBody().max_tokens === 16384, JSON.stringify(lastBody()));
    r = await request(enginePort, "POST", "/answer", "null", T);
    check("engine rejects a null body", r.status === 400, String(r.status));
    r = await request(enginePort, "POST", "/ingest", { name: "win.txt", text: "Line one\r\nLine two\r\n" }, T);
    check("/ingest stores normalised line endings", r.status === 200 && !fs.readFileSync(path.join(kb, "win.txt"), "utf8").includes("\r"));
    r = await request(enginePort, "POST", "/forget", {}, T);
    check("/forget without a name is rejected", r.status === 400, String(r.status));
    r = await request(enginePort, "POST", "/forget", { name: "win.txt" }, T);
    check("/forget removes the persisted file", r.status === 200 && !fs.existsSync(path.join(kb, "win.txt")), r.text);

    await documentChecks(T);
    await proxyChecks("proxy.js", proxyPort, "/rfp/proxy");
    await bindChecks();

    const php = spawnSync("php", ["-m"], { encoding: "utf8" });
    if (php.status !== 0) console.log("SKIP proxy.php: php is not installed");
    else {
      const lint = spawnSync("php", ["-l", path.join(ROOT, "proxy.php")], { encoding: "utf8" });
      check("proxy.php passes php -l", lint.status === 0, lint.stdout + lint.stderr);
      if (!/^curl$/im.test(php.stdout)) console.log("SKIP proxy.php behaviour: php has no curl extension");
      else {
        const phpPort = await freePort();
        children.push(await startProcess("php", ["-S", `127.0.0.1:${phpPort}`, "-t", WORK], {
          ANTHROPIC_API_KEY: "sk-test", COUNTERSIGN_TOKEN: TOKEN,
        }, phpPort));
        await proxyChecks("proxy.php", phpPort, "/proxy.php");
      }
    }
  } finally {
    children.forEach((c) => c.kill());
    upstream.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  async function documentChecks(T) {
    const kb2 = path.join(WORK, "kb2");
    fs.mkdirSync(kb2);
    fs.writeFileSync(path.join(kb2, "SLA Policy (v2).txt"), "Uptime commitment is 99.95 percent on the Enterprise plan.");
    const dataFile = path.join(WORK, "data.json");
    fs.writeFileSync(dataFile, JSON.stringify({ app: "countersign", docs: [
      { name: "Whitepaper.pdf", text: "Encryption uses AES-256-GCM and keys rotate yearly in AWS KMS." },
    ] }));
    const env = { ANTHROPIC_API_KEY: "sk-test", COUNTERSIGN_TOKEN: TOKEN, KB_DIR: kb2, DATA_FILE: dataFile, MODEL: "", HOST: "" };
    const boot = async () => { const port = await freePort(); return { port, child: await startProcess(NODE, [ENGINE], { ...env, PORT: String(port) }, port) }; };
    const search = async (port, query) => (await request(port, "POST", "/search", { query, k: 20 }, T)).json;

    let e = await boot();
    let r = await request(e.port, "POST", "/forget", { name: "SLA Policy (v2).txt" }, T);
    check("/forget removes a kb/ file whose name is not canonical", r.json && r.json.file_removed && !fs.existsSync(path.join(kb2, "SLA Policy (v2).txt")), r.text);
    await request(e.port, "POST", "/ingest", { name: "Whitepaper.pdf", text: "Encryption uses AES-256-GCM and keys rotate yearly in AWS KMS. Revised." }, T);
    let s = await search(e.port, "encryption keys rotate");
    check("pushing a DATA_FILE document replaces it rather than indexing it twice", s && s.sources.join() === "Whitepaper.pdf.txt", JSON.stringify(s && s.sources));

    await request(e.port, "POST", "/ingest", { name: "a.md", text: "Backups run hourly and are kept for 35 days. ".repeat(40) }, T);
    await request(e.port, "POST", "/ingest", { name: "b.md", text: "Support is available 24x7 with a one hour response. ".repeat(40) }, T);
    await request(e.port, "POST", "/ingest", { name: "c.md", text: "Backups are encrypted and restores are tested quarterly. ".repeat(30) }, T);
    await request(e.port, "POST", "/forget", { name: "b.md" }, T);
    await request(e.port, "POST", "/ingest", { name: "a.md", text: "Backups run hourly and are kept for 30 days. ".repeat(45) }, T);
    const queries = ["backup retention days", "encrypted restores tested", "support response", "keys rotate"];
    const shape = (x) => JSON.stringify({ coverage: x.coverage, missing: x.missing_terms, chunks: [...x.chunks].sort() });
    const incremental = [];
    for (const q of queries) incremental.push(shape(await search(e.port, q)));
    const health = (await request(e.port, "GET", "/health")).json;
    e.child.kill();

    e = await boot();
    const rebuilt = [];
    for (const q of queries) rebuilt.push(shape(await search(e.port, q)));
    const health2 = (await request(e.port, "GET", "/health")).json;
    check("the incremental index matches a full rebuild from disk", incremental.every((x, i) => x === rebuilt[i]) && health.chunks === health2.chunks,
      `chunks ${health.chunks} vs ${health2.chunks}`);
    s = await search(e.port, "encryption keys rotate");
    check("at boot a pushed kb/ copy supersedes its DATA_FILE document", s && s.sources.join() === "Whitepaper.pdf.txt", JSON.stringify(s && s.sources));
    e.child.kill();
  }

  async function proxyChecks(name, port, urlPath) {
    let r = await request(port, "POST", urlPath, { messages: [{ role: "user", content: "hi" }] });
    check(`${name} requires the team token`, r.status === 401, String(r.status));
    r = await request(port, "POST", urlPath, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), { ...T, "Content-Type": "text/plain" });
    check(`${name} refuses a non-JSON body`, r.status === 415, String(r.status));
    await request(port, "POST", urlPath, { model: "claude-opus-5-5", max_tokens: 999999, temperature: 2, messages: [{ role: "user", content: "hi" }] }, T);
    check(`${name} replaces an unlisted model with claude-sonnet-5-5`, lastBody().model === "claude-sonnet-5-5", lastBody().model);
    check(`${name} caps max_tokens at 16384`, lastBody().max_tokens === 16384, String(lastBody().max_tokens));
    check(`${name} forwards only model, max_tokens, messages and system`, Object.keys(lastBody()).every((k) => ["model", "max_tokens", "messages", "system"].includes(k)), JSON.stringify(Object.keys(lastBody())));
    for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
      await request(port, "POST", urlPath, { model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }, T);
      check(`${name} still allows ${model}`, lastBody().model === model, lastBody().model);
    }
  }

  async function bindChecks() {
    const base = { ANTHROPIC_API_KEY: "sk-test", COUNTERSIGN_TOKEN: "", HOST: "0.0.0.0", KB_DIR: path.join(WORK, "kb"), DATA_FILE: path.join(WORK, "absent.json") };
    for (const file of [ENGINE, PROXY]) {
      const code = await exitCode([file], { ...base, PORT: String(await freePort()) });
      check(`${path.basename(file)} will not listen on 0.0.0.0 without a team token`, code === 1, `exit code ${code}`);
    }
    const port = await freePort();
    const child = await startProcess(NODE, [PROXY], { ...base, ALLOW_NO_TOKEN: "1", PORT: String(port) }, port);
    const r = await request(port, "POST", "/proxy", { messages: [{ role: "user", content: "hi" }] });
    check("ALLOW_NO_TOKEN=1 lets proxy.js listen on 0.0.0.0 without a token", r.status === 200, String(r.status));
    child.kill();
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
