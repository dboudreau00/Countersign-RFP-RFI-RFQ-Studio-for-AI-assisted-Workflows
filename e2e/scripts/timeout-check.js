/* Loads index.html's inline script in a vm (stand-in DOM) with the provider timeout cut to
   1.5 s, points the OpenAI-compatible provider at a local server that accepts requests and
   never answers, and checks that askAI gives up with a clear message after one retry. */
const fs = require("fs");
const vm = require("vm");
const http = require("http");
const path = require("path");
const ROOT = process.argv[2];
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
let code = scripts[scripts.length - 1];
if (!code.includes("const PROVIDER_TIMEOUT_MS = 180000;")) throw new Error("timeout constant not found");
code = code.replace("const PROVIDER_TIMEOUT_MS = 180000;", "const PROVIDER_TIMEOUT_MS = 1500;");

let hits = 0;
const hang = http.createServer((req) => { hits++; req.resume(); }).listen(0, "127.0.0.1", async () => {
  const stub = new Proxy(function () {}, {
    get: (t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : p === Symbol.iterator ? function* () {} : stub),
    set: () => true, apply: () => stub, construct: () => stub, has: () => true,
  });
  const ctx = vm.createContext({
    window: stub, document: stub, localStorage: stub, sessionStorage: stub, navigator: stub, location: stub,
    CSS: stub, MutationObserver: stub, alert: () => {}, confirm: () => true, prompt: () => null,
    console, fetch, setTimeout, clearTimeout, URL, Blob, TextDecoder, TextEncoder, AbortSignal,
    Promise, JSON, Math, Date, Object, Array, Map, Set, RegExp, Error, TypeError, Number, String, Boolean, Symbol, parseInt, parseFloat, isNaN, isFinite,
  });
  vm.runInContext(code, ctx, { filename: "index.html#inline" });
  vm.runInContext(`S.settings.provider = "openai"; S.settings.key = "test"; S.settings.base = "http://127.0.0.1:${hang.address().port}/v1";`, ctx);
  const t = Date.now();
  let msg = "";
  try { await vm.runInContext(`askAI("hello")`, ctx); } catch (e) { msg = e.message; }
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const ok = /did not answer within 1\.5 seconds/.test(msg) && hits === 2;
  console.log(`${ok ? "PASS" : "FAIL"} hung provider: "${msg}" after ${secs}s, ${hits} attempts`);
  process.exit(ok ? 0 : 1);
});
