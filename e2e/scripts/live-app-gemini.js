/* Runs index.html's own provider, retrieval, prompt and parsing code (the real inline
   script, in a vm with a stand-in DOM) against the live Gemini API with the app's default
   model. The key comes from GEMINI_API_KEY and never touches a file or a page field. */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = process.argv[2];
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error("GEMINI_API_KEY not set"); process.exit(2); }
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const code = scripts[scripts.length - 1];

const stub = new Proxy(function () {}, {
  get: (t, p) => (p === Symbol.toPrimitive ? () => "" : p === "then" ? undefined : p === Symbol.iterator ? function* () {} : stub),
  set: () => true, apply: () => stub, construct: () => stub, has: () => true,
});
const ctx = vm.createContext({
  window: stub, document: stub, localStorage: stub, sessionStorage: stub, navigator: stub, location: stub,
  CSS: stub, MutationObserver: stub, alert: () => {}, confirm: () => true, prompt: () => null,
  console, fetch, setTimeout, clearTimeout, URL, Blob, TextDecoder, TextEncoder, structuredClone,
  Promise, JSON, Math, Date, Object, Array, Map, Set, RegExp, Error, TypeError, Number, String, Boolean, Symbol, parseInt, parseFloat, isNaN, isFinite,
  __KEY: KEY,
});
vm.runInContext(code, ctx, { filename: "index.html#inline" });

const extractTemplate = html.match(/const raw = await askAI\(\n`([\s\S]*?)`, \{ maxTokens: EXTRACT_TOKENS \}\);/);
if (!extractTemplate) throw new Error("extraction prompt not found in index.html");
const G = require(path.join(ROOT, "eval/groundedness.js"));
const corpus = fs.readFileSync(path.join(ROOT, "eval/corpus/security-policy.md"), "utf8");
const rfp = `Section 3 Security
3.1 Do you support SAML single sign-on, and with which identity providers?
3.2 Describe how customer data is encrypted at rest and how keys are managed.
3.3 Confirm that MFA is enforced for administrative accounts.
3.4 Which TLS versions do you support?
Section 7 Commercial
7.1 Describe your pricing model and minimum commitment.`;

(async () => {
  const run = (src) => vm.runInContext(src, ctx);
  ctx.__MODEL = process.env.GEMINI_MODEL || "";
  run(`S.settings.provider = "gemini"; S.settings.key = __KEY; S.settings.model = __MODEL;`);
  console.log("model in AI settings:", ctx.__MODEL || "(blank, app default)");
  console.log("default Gemini model:", run("DEFAULT_GEMINI_MODEL"));
  const ok = [];

  const prompt = extractTemplate[1].replace("${source.slice(0, 55000)}", rfp);
  const t0 = Date.now();
  const raw = await run(`askAI(${JSON.stringify(prompt)}, { maxTokens: EXTRACT_TOKENS })`);
  ctx.__raw = raw;
  const parsed = run("parseJSONish(__raw)");
  const items = parsed.items || [];
  console.log(`extraction: ${items.length} items in ${Date.now() - t0} ms, truncated=${parsed.truncated}`);
  for (const it of items) console.log(`   ${it.ref} [${it.type}] ${String(it.q).slice(0, 80)}`);
  ok.push(items.length >= 4 && items.every((it) => typeof it.q === "string" && it.q.length > 8));

  run(`S.docs = [{ id: "d1", name: "security-policy.md", type: "md", size: ${corpus.length}, chars: ${corpus.length}, text: ${JSON.stringify(corpus)} }];`);
  for (const [ref, text] of [["3.2", "Describe how customer data is encrypted at rest and how keys are managed."],
                             ["3.3", "Confirm that MFA is enforced for administrative accounts and state the supported factors."]]) {
    ctx.__q = { id: "q" + ref, ref, text, type: run(`classify(${JSON.stringify(text)})`), answer: "", status: "draft", sources: [], coverage: null };
    const retrieval = run("retrieve(__q.text)");
    ctx.__r = retrieval;
    const t = Date.now();
    const answer = (await run("askAI(answerPrompt(__q, __r))")).trim();
    const g = G.score(answer, retrieval.context, text);
    console.log(`\nanswer ${ref} (${ctx.__q.type}, coverage ${Math.round(retrieval.coverage * 100)}%, ${Date.now() - t} ms, groundedness ${g.score.toFixed(2)}${g.unsupported.length ? ", unsupported: " + g.unsupported.join(", ") : ""}):`);
    console.log("   " + answer.replace(/\n+/g, " ").slice(0, 400));
    ok.push(answer.length > 40 && g.score >= 0.8);
  }
  const pass = ok.every(Boolean);
  console.log(`\nLIVE ${pass ? "PASS" : "FAIL"} (${ok.filter(Boolean).length}/${ok.length})`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("LIVE ERROR:", e.message); process.exit(1); });
