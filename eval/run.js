/**
 * Countersign evaluation harness (Node 18+, zero dependencies).
 *
 *   node eval/run.js                   retrieval metrics + scorer self-tests + recorded-answer
 *                                      groundedness, compared against eval/baseline.json.
 *                                      Exits 1 on any regression. This is the CI drift canary.
 *   node eval/run.js --live            also draft fresh answers with ANTHROPIC_API_KEY (the
 *                                      engine's own path) or GEMINI_API_KEY, and score them
 *   node eval/run.js --record          --live, then save the answers to eval/answers.json so
 *                                      groundedness can be scored deterministically in CI
 *   node eval/run.js --update-baseline accept the current numbers as the new floor
 *   node eval/run.js --json            print the full report as JSON
 *
 * What is measured:
 *   precision@k   share of the top-k retrieved chunks that contain one of the case's anchors
 *   recall@k      share of the case's anchors that appear somewhere in the top-k chunks
 *   mrr           1 / rank of the first relevant chunk
 *   gap_accuracy  does coverage < gap_threshold agree with whether the case is a known gap
 *   groundedness  share of the answer's specific claims (figures, standards, names) that the
 *                 retrieved context or the question actually contains (see eval/groundedness.js)
 *   must_mention / must_not_mention / verdict_not   answer correctness checks from cases.json
 */
"use strict";

const fs = require("fs");
const path = require("path");
const engine = require("../engine.js");
const G = require("./groundedness.js");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ROOT = __dirname;
const CASES_FILE = path.resolve(ROOT, opt("--cases", "cases.json"));
const CORPUS_DIR = path.resolve(ROOT, opt("--corpus", "corpus"));
const BASELINE_FILE = path.resolve(ROOT, "baseline.json");
const ANSWERS_FILE = path.resolve(ROOT, "answers.json");
const EPS = 0.001;
const LIVE = flag("--live") || flag("--record");
const DELAY_MS = parseInt(opt("--delay", "1500"), 10);
const JSON_OUT = flag("--json");
const say = (...a) => (JSON_OUT ? console.error : console.log)(...a);   // keep stdout pure JSON under --json

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ corpus + cases */
/* Line endings are normalised before indexing. Chunks are cut every CHUNK_SIZE characters,
   so a CRLF checkout has a different chunk layout from an LF checkout of the same corpus
   and the ranking metrics move by a few thousandths. The numbers must not depend on which
   operating system ran the checkout. */
const normaliseText = (t) => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t).replace(/\r\n?/g, "\n");

function loadCorpus() {
  engine.KB.docs.clear();
  const files = fs.readdirSync(CORPUS_DIR).filter((f) => /\.(txt|md|csv|json)$/i.test(f)).sort();
  for (const f of files) engine.addDoc(f, normaliseText(fs.readFileSync(path.join(CORPUS_DIR, f), "utf8")), false);
  const log = console.log;
  if (JSON_OUT) console.log = console.error;   // the engine logs its index summary to stdout
  try { engine.reindex(); } finally { console.log = log; }
  return files;
}

function loadCases() {
  const spec = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
  const problems = [];
  const ids = new Set();
  const corpusText = norm([...engine.KB.docs.values()].join("\n"));
  for (const c of spec.cases) {
    if (!c.id || !c.question) problems.push(`case without id/question: ${JSON.stringify(c).slice(0, 80)}`);
    if (ids.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (!c.gap) {
      if (!Array.isArray(c.anchors) || !c.anchors.length) problems.push(`${c.id}: non-gap case needs anchors`);
      // a label that matches nothing in the corpus is a bug in the test set, not in retrieval
      for (const a of c.anchors || []) if (!corpusText.includes(norm(a))) problems.push(`${c.id}: anchor "${a}" appears nowhere in the corpus`);
    }
  }
  if (problems.length) { console.error("cases.json problems:\n  " + problems.join("\n  ")); process.exit(2); }
  return spec;
}

/* ------------------------------------------------------------------ retrieval metrics */
function evalRetrieval(c, ks, gapThreshold) {
  const r = engine.retrieve(c.question);
  const out = { id: c.id, gap: !!c.gap, coverage: r3(r.coverage), missing_terms: r.missing_terms,
    predicted_gap: r.coverage < gapThreshold, retrieval: r };
  out.gap_correct = out.predicted_gap === out.gap;
  if (!c.gap) {
    const anchors = c.anchors.map(norm);
    const hits = r.ranked.map((h) => anchors.filter((a) => norm(h.text).includes(a)));
    out.precision = {}; out.recall = {};
    for (const k of ks) {
      const top = hits.slice(0, k);
      out.precision[k] = r3(top.filter((h) => h.length).length / k);
      out.recall[k] = r3(new Set(top.flat()).size / anchors.length);
    }
    const first = hits.findIndex((h) => h.length);
    out.rr = r3(first < 0 ? 0 : 1 / (first + 1));
  }
  return out;
}

/* ------------------------------------------------------------------ answer checks */
function evalAnswer(c, answer, retrieval) {
  const a = norm(answer);
  const g = G.score(answer, retrieval.context, c.question);
  const mention = (c.must_mention || []).map((m) => ({ phrase: m, ok: a.includes(norm(m)) }));
  const forbidden = (c.must_not_mention || []).filter((m) => a.includes(norm(m)));
  const verdictOk = !c.verdict_not || !new RegExp("^\\s*" + c.verdict_not + "\\b", "i").test(answer);
  return {
    groundedness: r3(g.score), unsupported: g.unsupported, flagged_sentences: g.flagged_sentences, sentences: g.sentences,
    mention_rate: mention.length ? r3(mention.filter((m) => m.ok).length / mention.length) : 1,
    missing_mentions: mention.filter((m) => !m.ok).map((m) => m.phrase),
    forbidden, verdict_ok: verdictOk,
    ok: !forbidden.length && verdictOk && mention.every((m) => m.ok),
  };
}

/* ------------------------------------------------------------------ live drafting */
async function draft(c, retrieval) {
  const prompt = engine.buildPrompt(c.question, retrieval, { type: c.type, max_words: 150 });
  const once = async () => {
    if (process.env.ANTHROPIC_API_KEY) {
      const up = await engine.callClaude({ model: engine.MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] });
      if (up.status !== 200) throw Object.assign(new Error("Anthropic " + up.status + ": " + up.text.slice(0, 160)), { status: up.status });
      const d = JSON.parse(up.text);
      return { model: engine.MODEL, text: (d.content || []).map((b) => (b.type === "text" ? b.text : "")).join("").trim() };
    }
    if (process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8192 } }),
      });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error("Gemini " + res.status + ": " + text.slice(0, 160)), { status: res.status });
      const d = JSON.parse(text);
      return { model, text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim() };
    }
    throw new Error("--live needs ANTHROPIC_API_KEY or GEMINI_API_KEY in the environment");
  };
  try { return await once(); }
  catch (e) {
    if (e.status === 429 || e.status >= 500) { await sleep(12000); return await once(); }   // one retry on rate limit / overload
    throw e;
  }
}

/* ------------------------------------------------------------------ baseline */
const METRICS = [
  { key: "p@1", higher: true }, { key: "p@3", higher: true }, { key: "p@5", higher: true },
  { key: "r@3", higher: true }, { key: "r@5", higher: true }, { key: "mrr", higher: true },
  { key: "gap_accuracy", higher: true },
  { key: "groundedness", higher: true }, { key: "mention_rate", higher: true },
  { key: "answers_ok", higher: true }, { key: "forbidden_hits", higher: false },
];

function compare(current, baseline) {
  const rows = [];
  let regressed = false;
  for (const m of METRICS) {
    if (!(m.key in current)) continue;
    const cur = current[m.key], base = baseline ? baseline[m.key] : undefined;
    let status = "  ";
    if (base !== undefined) {
      const worse = m.higher ? cur < base - EPS : cur > base + EPS;
      const better = m.higher ? cur > base + EPS : cur < base - EPS;
      status = worse ? "FAIL" : better ? "up" : "ok";
      if (worse) regressed = true;
    }
    rows.push({ key: m.key, cur, base, status });
  }
  return { rows, regressed };
}

/* ------------------------------------------------------------------ main */
(async () => {
  const files = loadCorpus();
  const spec = loadCases();
  const ks = spec.k || [1, 3, 5];
  const gapThreshold = spec.gap_threshold ?? 0.4;
  const report = { corpus: files, cases: spec.cases.length, k: ks, gap_threshold: gapThreshold, results: [], aggregates: {} };

  // 1. retrieval tier (deterministic)
  const results = spec.cases.map((c) => evalRetrieval(c, ks, gapThreshold));
  const covered = results.filter((r) => !r.gap);
  const agg = {};
  for (const k of ks) { agg["p@" + k] = r3(mean(covered.map((r) => r.precision[k]))); agg["r@" + k] = r3(mean(covered.map((r) => r.recall[k]))); }
  agg.mrr = r3(mean(covered.map((r) => r.rr)));
  agg.gap_accuracy = r3(mean(results.map((r) => (r.gap_correct ? 1 : 0))));

  // 2. scorer self-tests (deterministic)
  const selfTests = G.selfTest();
  const selfFail = selfTests.filter((t) => !t.pass);

  // 3. answers: recorded (deterministic) and/or live
  let answers = null, answersMeta = null;
  if (LIVE) {
    answers = {};
    const byId = new Map(results.map((r) => [r.id, r]));
    let model = null;
    for (const c of spec.cases) {
      try {
        const d = await draft(c, byId.get(c.id).retrieval);
        answers[c.id] = d.text; model = d.model;
        process.stdout.write(`  drafted ${c.id}\n`);
      } catch (e) { process.stdout.write(`  FAILED ${c.id}: ${e.message}\n`); }
      await sleep(DELAY_MS);
    }
    answersMeta = { model, recorded_at: new Date().toISOString(), source: "live" };
    const drafted = Object.keys(answers).length;
    if (flag("--record") && drafted) {
      fs.writeFileSync(ANSWERS_FILE, JSON.stringify({ model, recorded_at: answersMeta.recorded_at, answers }, null, 2) + "\n");
      console.log(`\nrecorded ${drafted} of ${spec.cases.length} answers from ${model} to ${path.basename(ANSWERS_FILE)}`);
    } else if (flag("--record")) {
      console.log("\nnothing recorded: every draft failed (check the API key and quota above)");
    }
    if (!drafted) answers = null;   // no answers means no answer metrics, not a set of zeros
  } else if (fs.existsSync(ANSWERS_FILE)) {
    const rec = JSON.parse(fs.readFileSync(ANSWERS_FILE, "utf8"));
    answers = rec.answers || {}; answersMeta = { model: rec.model, recorded_at: rec.recorded_at, source: "recorded" };
  }

  if (answers) {
    const byId = new Map(spec.cases.map((c) => [c.id, c]));
    const scored = [];
    for (const r of results) {
      if (!(r.id in answers)) continue;
      r.answer = evalAnswer(byId.get(r.id), answers[r.id], r.retrieval);
      scored.push(r.answer);
    }
    if (scored.length) {
      agg.groundedness = r3(mean(scored.map((a) => a.groundedness)));
      agg.mention_rate = r3(mean(scored.map((a) => a.mention_rate)));
      agg.answers_ok = r3(mean(scored.map((a) => (a.ok ? 1 : 0))));
      agg.forbidden_hits = scored.reduce((n, a) => n + a.forbidden.length, 0);
      agg.answers_scored = scored.length;
    }
    // mutation check: an invention appended to a real answer must be flagged on that answer's
    // real context. A scorer loosened until every answer passes fails here.
    const TAMPER = " We also hold ISO 99999 certification and our uptime commitment is 99.999%.";
    report.tamper_missed = results
      .filter((r) => r.id in answers && G.score(answers[r.id] + TAMPER, r.retrieval.context, byId.get(r.id).question).unsupported.length < 2)
      .map((r) => r.id);
    report.tamper_checked = scored.length;
  }
  report.aggregates = agg;
  report.results = results.map(({ retrieval, ...rest }) => rest);   // drop the bulky context from the report
  report.self_tests = selfTests;
  report.answers = answersMeta;

  // 4. baseline
  const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : null;
  const cmp = compare(agg, baseline && baseline.aggregates);

  if (JSON_OUT) { console.log(JSON.stringify({ ...report, comparison: cmp.rows }, null, 2)); }
  else {
    console.log(`\ncorpus: ${files.length} docs, ${engine.KB.chunks.length} chunks   cases: ${spec.cases.length} (${covered.length} covered, ${results.length - covered.length} gaps)\n`);
    const hdr = ["case".padEnd(20), "cov", "gap", ...ks.map((k) => "P@" + k), ...ks.map((k) => "R@" + k), "RR", answers ? "ground mention ok" : ""].join("  ");
    console.log(hdr);
    for (const r of results) {
      const cells = [r.id.padEnd(20), pct(r.coverage), (r.gap ? "gap" : "   ") + (r.gap_correct ? " " : "!")];
      if (r.gap) cells.push(...ks.map(() => "   -"), ...ks.map(() => "   -"), "   -");
      else cells.push(...ks.map((k) => pct(r.precision[k])), ...ks.map((k) => pct(r.recall[k])), r.rr.toFixed(2).padStart(4));
      if (answers) cells.push(r.answer ? `${pct(r.answer.groundedness)}   ${pct(r.answer.mention_rate)}  ${r.answer.ok ? "ok" : "NO"}` : "  (no answer)");
      console.log(cells.join("  "));
      if (r.answer && (r.answer.unsupported.length || r.answer.forbidden.length || !r.answer.verdict_ok || r.answer.missing_mentions.length)) {
        const notes = [];
        if (r.answer.unsupported.length) notes.push("unsupported: " + r.answer.unsupported.join(", "));
        if (r.answer.missing_mentions.length) notes.push("missing: " + r.answer.missing_mentions.join(", "));
        if (r.answer.forbidden.length) notes.push("FORBIDDEN: " + r.answer.forbidden.join(", "));
        if (!r.answer.verdict_ok) notes.push("verdict opened with " + byIdVerdict(spec, r.id));
        console.log("    " + notes.join(" | "));
      }
    }
    console.log(`\nscorer self-tests: ${selfTests.length - selfFail.length}/${selfTests.length} pass` +
      (selfFail.length ? "\n  " + selfFail.map((t) => `FAIL ${t.name}: ${t.detail}`).join("\n  ") : ""));
    if (answersMeta) console.log(`answers: ${answersMeta.source} from ${answersMeta.model} (${answersMeta.recorded_at})`);
    if (report.tamper_checked) console.log(`tamper check: ${report.tamper_checked - report.tamper_missed.length}/${report.tamper_checked} answers flag an appended invention` +
      (report.tamper_missed.length ? " (missed: " + report.tamper_missed.join(", ") + ")" : ""));

    console.log("\nmetric          current   baseline");
    for (const row of cmp.rows)
      console.log(`${row.key.padEnd(15)} ${String(row.cur).padStart(7)}   ${row.base === undefined ? "   (none)" : String(row.base).padStart(8)}   ${row.status}`);
  }

  if (flag("--update-baseline")) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ updated_at: new Date().toISOString(), cases: spec.cases.length, aggregates: agg }, null, 2) + "\n");
    say(`\nbaseline written to ${path.basename(BASELINE_FILE)}`);
  }

  const problems = [];
  if (selfFail.length) problems.push(`${selfFail.length} scorer self-test(s) failed`);
  if (report.tamper_missed && report.tamper_missed.length) problems.push(`scorer missed an appended invention in ${report.tamper_missed.length} answer(s)`);
  if (cmp.regressed) problems.push("quality regressed against baseline");
  if (!baseline && !flag("--update-baseline")) say("\nno baseline yet: run with --update-baseline to set one");
  if (problems.length) { say("\nRESULT: FAIL (" + problems.join("; ") + ")"); process.exit(1); }
  say("\nRESULT: PASS");
})().catch((e) => { console.error(e); process.exit(2); });

function byIdVerdict(spec, id) { const c = spec.cases.find((x) => x.id === id); return c && c.verdict_not; }
