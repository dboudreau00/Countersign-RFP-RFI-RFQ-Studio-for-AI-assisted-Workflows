#!/usr/bin/env node
'use strict';
/*
  Countersign headless end-to-end harness.

    node run.js [--root <dir-containing-index.html>] [--only <substring>] [--jobs N] [--list]
                [--expect-model <id>] [--strict-model] [--min-answer-tokens N] [--min-extract-tokens N]
                [--no-cdn-cache] [--headed] [--port N]

  --root defaults to the folder above this one (the repository).

  Output: one line per check (PASS / FAIL / INFO), then a SUMMARY line. Exit 0 only if every
  check passed. INFO lines record values (model, max_tokens, ...) and are not counted.

  What is real and what is mocked
    - The page, its scripts, and the four parsing/export libraries (pdf.js, mammoth, SheetJS
      from cdnjs; docx from jsDelivr) are REAL. The first request for each CDN URL goes to the
      real network and its bytes are replayed from memory for later contexts (--no-cdn-cache
      sends every request to the network).
    - Every LLM endpoint (Anthropic, Gemini, OpenAI-compatible, team proxy, engine) is mocked
      with page.route. Google Fonts are stubbed (cosmetic).
    - Fixtures (PDF, DOCX, XLSX, CSV, text) are generated at run time; nothing binary is committed.
*/
const path = require('path');
const fs = require('fs');

/* ===================== configurable constants (edit, or override on the CLI) ===================== */
const CONFIG = {
  PORT: 18842,
  // What the app is expected to send as `model` for the built-in / claude-key providers when the
  // user has not typed a model. The edit under test is expected to change this: update it, or
  // pass --expect-model. The value actually sent is always reported as an INFO line.
  EXPECTED_DEFAULT_MODEL: 'claude-sonnet-5-5',
  // Floors for max_tokens. An answer call and the question-extraction call. Current Sonnet
  // models can spend part of the budget thinking, so a low cap can starve the visible text.
  MIN_ANSWER_MAX_TOKENS: 1000,
  MIN_EXTRACT_MAX_TOKENS: 8000,
  TEST_TIMEOUT_MS: 150000,
  JOBS: 3,
};
// an existing install elsewhere can be used with PLAYWRIGHT_DIR=<path to node_modules/playwright>
const PLAYWRIGHT_DIR = process.env.PLAYWRIGHT_DIR || 'playwright';

const pwVersion = () => { try { return require(PLAYWRIGHT_DIR + '/package.json').version; } catch (e) { return '?'; } };

/* ===================== CLI ===================== */
function parseArgs(argv) {
  const a = { only: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => argv[++i];
    if (k === '--root') a.root = val();
    else if (k === '--only') a.only.push(...String(val()).split(',').map((s) => s.trim()).filter(Boolean));
    else if (k === '--jobs') a.jobs = +val();
    else if (k === '--port') a.port = +val();
    else if (k === '--expect-model') a.expectModel = val();
    else if (k === '--min-answer-tokens') a.minAnswer = +val();
    else if (k === '--min-extract-tokens') a.minExtract = +val();
    else if (k.startsWith('--')) a.flags.add(k.slice(2));
    else { console.error('unknown argument: ' + k); process.exit(2); }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args.root) args.root = path.join(__dirname, '..');
const cfg = {
  ...CONFIG,
  PORT: args.port || CONFIG.PORT,
  JOBS: args.jobs || CONFIG.JOBS,
  EXPECTED_DEFAULT_MODEL: args.expectModel || CONFIG.EXPECTED_DEFAULT_MODEL,
  MIN_ANSWER_MAX_TOKENS: args.minAnswer || CONFIG.MIN_ANSWER_MAX_TOKENS,
  MIN_EXTRACT_MAX_TOKENS: args.minExtract || CONFIG.MIN_EXTRACT_MAX_TOKENS,
  strictModel: args.flags.has('strict-model'),
  realToasts: false,           // only the toast.* tests use real timers (per-app option)
  noCdnCache: args.flags.has('no-cdn-cache'),
  headed: args.flags.has('headed'),
};
if (!(cfg.PORT >= 18840 && cfg.PORT <= 18859)) { console.error('port must be within 18840-18859'); process.exit(2); }

/* ===================== test registry ===================== */
const registry = [];
const test = (name, fn, opts = {}) => registry.push({ name, fn, opts });

const HARNESS_DIR = __dirname;
const OUT_DIR = path.join(HARNESS_DIR, 'out');

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v, n = 160) => {
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) s = 'undefined';
  s = s.replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '...' : s;
};

class T {
  constructor(entry, h) {
    this.name = entry.name; this.h = h; this.cfg = cfg; this.F = h.F; this.apps = []; this.lines = [];
    this.origin = h.origin; this.serverHits = h.serverHits; this.lib = h.lib; this.readers = h.readers;
  }
  _push(status, label, detail) {
    this.lines.push({ status, name: label ? `${this.name} / ${label}` : this.name, detail: detail || '' });
  }
  check(label, ok, detail) { this._push(ok ? 'PASS' : 'FAIL', label, detail); return !!ok; }
  pass(label, detail) { this._push('PASS', label, detail); }
  fail(label, detail) { this._push('FAIL', label, detail); }
  info(label, detail) { this._push('INFO', label, detail); }
  eq(label, actual, expected, extra) {
    const ok = deepEq(actual, expected);
    return this.check(label, ok, ok ? short(actual) + (extra ? ' ' + extra : '') : `expected ${short(expected)}, got ${short(actual)}`);
  }
  has(label, hay, needle, extra) {
    const ok = typeof hay === 'string' ? hay.includes(needle) : Array.isArray(hay) && hay.includes(needle);
    return this.check(label, ok, ok ? `found ${short(needle, 80)}` + (extra ? ' ' + extra : '') : `missing ${short(needle, 120)} in ${short(hay, 200)}`);
  }
  lacks(label, hay, needle) {
    const ok = !(typeof hay === 'string' ? hay.includes(needle) : Array.isArray(hay) && hay.includes(needle));
    return this.check(label, ok, ok ? `absent ${short(needle, 80)}` : `unexpectedly present ${short(needle, 120)} in ${short(hay, 200)}`);
  }
  match(label, str, re) {
    const ok = re.test(String(str));
    return this.check(label, ok, ok ? `matched ${re}: ${short(String(str).match(re)[0], 100)}` : `${re} did not match ${short(str, 200)}`);
  }
  async app(opts) {
    const { App } = require('./lib/app');
    const a = new App(this.h, this, opts);
    await a.init();
    this.apps.push(a);
    return a;
  }
  /* reads a file the app exported, using the real libraries in the helper page */
  async readXlsx(buf) { return this.lib.evaluate((b) => window.E2E.readXlsx(b), buf.toString('base64')); }
  async mammoth(buf) { return this.lib.evaluate((b) => window.E2E.mammothText(b), buf.toString('base64')); }
}

/* ===================== main ===================== */
async function main() {
  // tests register themselves
  const testDir = path.join(HARNESS_DIR, 'tests');
  const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) require(path.join(testDir, f))(test, cfg);

  if (args.flags.has('list')) { registry.forEach((e) => console.log(e.name)); return 0; }

  const root = path.resolve(args.root);
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('no index.html in ' + root); return 2; }

  const selected = registry.filter((e) => !args.only.length || args.only.some((s) => e.name.includes(s)));
  if (!selected.length) { console.error('no tests match --only ' + args.only.join(',')); return 2; }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { startServer } = require('./lib/server');
  const srv = await startServer({ root, harnessDir: HARNESS_DIR, port: cfg.PORT });
  const { chromium } = require(PLAYWRIGHT_DIR);
  const browser = await chromium.launch({ headless: !cfg.headed });

  const h = { browser, cfg, origin: srv.origin, serverHits: srv.hits, cdn: new Map(), F: null, lib: null };
  console.log(`# root=${root}`);
  console.log(`# server=${srv.origin} playwright=${pwVersion()} browser=${browser.version()}`);
  console.log(`# expected default model=${cfg.EXPECTED_DEFAULT_MODEL} min answer max_tokens=${cfg.MIN_ANSWER_MAX_TOKENS} min extract max_tokens=${cfg.MIN_EXTRACT_MAX_TOKENS}`);

  // helper page: builds fixtures and reads exports back with the real libraries
  const libCtx = await browser.newContext({ acceptDownloads: true });
  const libApp = new (require('./lib/app').App)(h, { name: 'lib' }, { name: 'lib' });
  libApp.ctx = libCtx;
  await libCtx.route('**/*', (route) => libApp._route(route).catch(() => route.abort('failed')));
  h.lib = await libCtx.newPage();
  await h.lib.goto(srv.origin + '/__e2e/lib.html', { waitUntil: 'load' });
  const libs = await h.lib.evaluate(() => window.E2E.libs());
  if (libs.docx !== 'object' || libs.XLSX !== 'object' || libs.mammoth !== 'object') {
    console.log('FAIL harness / helper libraries: the CDN libraries did not load in the helper page: ' + JSON.stringify(libs) + ' (is the network reachable?)');
    await browser.close(); srv.server.close();
    return 1;
  }
  h.F = await require('./lib/fixtures').build(h.lib);

  let firstFailShots = 0;
  const results = new Array(selected.length);
  let next = 0, printed = 0;
  const counts = { pass: 0, fail: 0, info: 0 };
  const flush = () => {
    while (printed < selected.length && results[printed]) {
      for (const l of results[printed]) {
        if (l.status === 'PASS') counts.pass++; else if (l.status === 'FAIL') counts.fail++; else counts.info++;
        console.log(`${l.status} ${l.name}${l.detail ? ': ' + l.detail : ''}`);
      }
      printed++;
    }
  };

  async function runOne(idx) {
    const entry = selected[idx];
    const t = new T(entry, h);
    const started = Date.now();
    let timer;
    try {
      await Promise.race([
        entry.fn(t),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${cfg.TEST_TIMEOUT_MS}ms`)), cfg.TEST_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      t.fail('test ran to completion', 'exception: ' + short(String((e && e.message) || e), 400));
    } finally { clearTimeout(timer); }
    // automatic guards: only reported when violated
    for (const a of t.apps) {
      const issues = a.opts.allowPageErrors ? [] : await a.pageIssues();
      if (issues.length) t.fail('guard: no uncaught errors or unhandled promise rejections', short(issues[0], 300));
      if (a.routeErrors && a.routeErrors.length) t.fail('guard: harness routing', short(a.routeErrors[0], 300));
      if (!a.opts.allowUnexpectedHosts && a.unexpected.length && !a.opts.expectUnexpected)
        t.fail('guard: no requests to unexpected hosts', short(a.unexpected.map((u) => u.url), 300));
    }
    const failed = t.lines.some((l) => l.status === 'FAIL');
    if (failed) {
      for (let i = 0; i < t.apps.length; i++) {
        const a = t.apps[i];
        const slug = t.name.replace(/[^a-z0-9]+/gi, '_');
        await a.shot(path.join(OUT_DIR, `${slug}_${i}.png`));
        fs.writeFileSync(path.join(OUT_DIR, `${slug}_${i}.log.json`), JSON.stringify({
          console: a.consoleMsgs, pageErrors: a.pageErrors, unexpected: a.unexpected, dialogs: a.dialogs,
          toasts: await a.toasts().catch(() => []),
          calls: Object.fromEntries(Object.entries(a.calls).map(([k, v]) => [k, v.map((c) => ({ url: c.url, method: c.method, headers: c.headers, body: c.json || c.text }))])),
        }, null, 1));
      }
    }
    for (const a of t.apps) await a.close();
    results[idx] = t.lines;
    if (process.env.E2E_TIMING) console.error(`# ${entry.name} ${Date.now() - started}ms`);
    flush();
  }

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= selected.length) return;
      await runOne(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.JOBS, selected.length) }, worker));
  flush();

  await browser.close();
  srv.server.close();
  const total = counts.pass + counts.fail;
  console.log(`SUMMARY: ${total} checks, ${counts.pass} passed, ${counts.fail} failed (${selected.length} tests, ${counts.info} info lines)`);
  if (counts.fail) console.log(`RESULT: FAIL`); else console.log(`RESULT: OK`);
  return counts.fail || !total ? 1 : 0;
}

process.on('unhandledRejection', (e) => { console.error('unhandled rejection: ' + (e && e.stack || e)); });
main().then((code) => process.exit(code), (e) => { console.error('harness crashed: ' + (e && e.stack || e)); process.exit(2); });
