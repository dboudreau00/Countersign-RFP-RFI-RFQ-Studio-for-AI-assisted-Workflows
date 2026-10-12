'use strict';
/* App driver: one browser context + page per App, with every outside host routed. */
const fs = require('fs');
const path = require('path');
const { makeDefaults } = require('./mocks');
const { sleep } = require('./util');

const ALLOWED_CDN = /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|cdn\.sheetjs\.com)$/;
const FONT_HOSTS = /^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

const CORS = (reqHeaders) => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': reqHeaders || '*',   // echoed: "*" does not cover Authorization
  'access-control-expose-headers': '*',
});

/* Records every text the toast element shows (the app queues toasts, one at a time).
   Optionally shortens the display time so a chain of toasts does not stall a test. */
const INIT_SCRIPT = (fast) => `(() => {
  window.__toasts = [];
  window.__rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    window.__rejections.push(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });
  window.addEventListener('error', (e) => {
    if (e instanceof ErrorEvent) window.__rejections.push('uncaught: ' + e.message + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  }, true);
  const st = window.setTimeout;
  if (${fast ? 'true' : 'false'}) window.setTimeout = function (fn, ms, ...a) {
    if (ms === 3200 || ms === 5200) ms = 30;
    return st.call(this, fn, ms, ...a);
  };
  const attach = () => {
    const t = document.getElementById('toast');
    if (!t || t.__rec) return !!t;
    t.__rec = true;
    new MutationObserver(() => {
      const txt = t.textContent;
      if (txt) window.__toasts.push({ text: txt, err: /\\berr\\b/.test(t.className), at: Date.now() });
    }).observe(t, { childList: true, characterData: true, subtree: true });
    return true;
  };
  if (!attach()) {
    const mo = new MutationObserver(() => { if (attach()) mo.disconnect(); });
    mo.observe(document, { childList: true, subtree: true });
  }
})();`;

class App {
  constructor(h, t, opts = {}) {
    this.h = h; this.t = t; this.opts = opts;
    this.name = opts.name || 'app';
    this.consoleMsgs = []; this.pageErrors = []; this.requests = [];
    this.calls = { anthropic: [], gemini: [], openai: [], proxy: [], engine: [] };
    this.unexpected = []; this.blocked = [];
    this.dialogs = []; this.dialogQueue = [];
    this.hosts = { openai: [], proxy: [], engine: ['http://127.0.0.1:18851'] };
    this.block = opts.block || [];                 // regexes of URLs to abort
    this.mock = makeDefaults(this);
    this.mock.proxyFile = null;                    // set to 'passthrough' to let proxy.php hit the server
    this.extractReply = undefined;
    this.answerText = undefined;
  }

  async init() {
    const { browser } = this.h;
    this.ctx = await browser.newContext({
      acceptDownloads: true, viewport: { width: 1280, height: 900 },
      colorScheme: 'light', serviceWorkers: 'block', ...(this.opts.context || {}),
    });
    await this.ctx.addInitScript(INIT_SCRIPT(this.opts.realToasts ? false : !this.h.cfg.realToasts));
    if (this.opts.initScript) await this.ctx.addInitScript(this.opts.initScript.fn, this.opts.initScript.arg);
    this.page = await this.ctx.newPage();
    this.page.setDefaultTimeout(20000);
    this.page.on('console', (m) => {
      const loc = m.location() || {};
      this.consoleMsgs.push({ type: m.type(), text: m.text(), url: loc.url || '' });
    });
    this.page.on('pageerror', (e) => this.pageErrors.push(String((e && e.stack) || e)));
    this.page.on('request', (r) => this.requests.push({ url: r.url(), method: r.method(), type: r.resourceType() }));
    this.page.on('dialog', async (d) => {
      const next = this.dialogQueue.shift();
      this.dialogs.push({ type: d.type(), message: d.message() });
      if (!next || next.accept === false) return d.dismiss().catch(() => {});
      return d.accept(next.text).catch(() => {});
    });
    await this.ctx.route('**/*', (route) => this._route(route).catch((e) => {
      try { route.abort('failed'); } catch (_) { /* already handled */ }
      this.routeErrors = (this.routeErrors || []).concat(String(e));
    }));
    return this;
  }

  /* ------------------------------------------------------------------ routing */
  async _route(route) {
    const req = route.request();
    const u = new URL(req.url());
    const h = this.h;
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    if (this.block.some((re) => re.test(req.url()))) { this.blocked.push(req.url()); return route.abort('blockedbyclient'); }
    if (u.origin === h.origin) {
      if (u.pathname === '/proxy.php' && this.mock.proxyFile !== 'passthrough') return this._serve('proxy', route, this.mock.proxy);
      if (u.pathname === '/countersign-data.json' && this.directoryFile) {
        const d = typeof this.directoryFile === 'function' ? this.directoryFile() : this.directoryFile;
        if (d) {
          this.directoryFetches = (this.directoryFetches || 0) + 1;
          return route.fulfill({ status: 200, headers: { 'content-type': d.contentType || 'application/json', 'cache-control': 'no-store' }, body: typeof d.body === 'string' ? d.body : JSON.stringify(d.body) });
        }
      }
      return route.continue();
    }
    if (ALLOWED_CDN.test(u.hostname)) return this._cdn(route, req.url());
    if (FONT_HOSTS.test(u.hostname)) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts stubbed by the e2e harness */' });
    }
    if (u.hostname === 'api.anthropic.com') return this._serve('anthropic', route, this.mock.anthropic);
    if (u.hostname === 'generativelanguage.googleapis.com') return this._serve('gemini', route, this.mock.gemini);
    if (u.hostname === 'api.openai.com' || this.hosts.openai.includes(u.origin)) return this._serve('openai', route, this.mock.openai);
    if (this.hosts.proxy.includes(u.origin)) return this._serve('proxy', route, this.mock.proxy);
    if (this.hosts.engine.includes(u.origin)) return this._serve('engine', route, this.mock.engine);
    this.unexpected.push({ url: req.url(), method: req.method(), headers: req.headers() });
    return route.abort('blockedbyclient');
  }

  async _cdn(route, url) {
    if (this.h.cfg.noCdnCache) return route.continue();
    const cache = this.h.cdn;
    let p = cache.get(url);
    if (!p) {
      p = (async () => {
        const r = await route.fetch();
        return { status: r.status(), type: r.headers()['content-type'] || 'application/javascript', body: await r.body() };
      })();
      cache.set(url, p);
      p.catch(() => cache.delete(url));
    }
    let got;
    try { got = await p; } catch (e) { return route.abort('failed'); }
    return route.fulfill({ status: got.status, headers: { 'content-type': got.type, 'access-control-allow-origin': '*' }, body: got.body });
  }

  async _serve(kind, route, handler) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS(req.headers()['access-control-request-headers']) });
    const text = req.postData() || '';
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    const list = this.calls[kind];
    const rec = { kind, url: req.url(), path: new URL(req.url()).pathname, method: req.method(), headers: req.headers(), text, json, index: list.length, t: Date.now() };
    list.push(rec);
    const spec = (await handler(rec, this)) || {};
    if (spec.abort) return route.abort(spec.abort);
    if (spec.delay) await sleep(spec.delay);
    return route.fulfill({
      status: spec.status || 200,
      headers: { ...CORS(), 'content-type': spec.contentType || 'application/json', ...(spec.headers || {}) },
      body: spec.text !== undefined ? spec.text : JSON.stringify(spec.json === undefined ? {} : spec.json),
    });
  }

  /* ------------------------------------------------------------------ navigation */
  async goto(p = '/index.html') {
    await this.page.goto(this.h.origin + p, { waitUntil: 'load' });
    await this.booted();
    return this;
  }
  async booted() {
    await this.page.waitForFunction(() => {
      const el = document.getElementById('doc-count');
      return el && !/^\s*0 files\s*$/.test(el.textContent);
    }, null, { timeout: 6000 }).catch(() => {});
    await this.page.waitForTimeout(200);
  }
  async reload() {
    await this.page.reload({ waitUntil: 'load' });
    await this.booted();
  }
  async goPage(name) { await this.page.click('#nav-' + name); }

  /* ------------------------------------------------------------------ toasts */
  toasts() { return this.page.evaluate(() => (window.__toasts || []).slice()); }
  async toastSeen(re) { return (await this.toasts()).find((x) => re.test(x.text)) || null; }
  async waitToast(re, timeout = 15000) {
    const end = Date.now() + timeout;
    for (;;) {
      const hit = await this.toastSeen(re);
      if (hit) return hit;
      if (Date.now() > end) {
        const seen = (await this.toasts()).map((x) => x.text);
        throw new Error(`toast ${re} not shown within ${timeout}ms; toasts so far: ${JSON.stringify(seen)}`);
      }
      await sleep(80);
    }
  }
  async clearToasts() { await this.page.evaluate(() => { window.__toasts.length = 0; }); }

  /* ------------------------------------------------------------------ bucket */
  async uploadKb(files) {
    await this.page.setInputFiles('#file-input', files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })));
  }
  async docRows() {
    return this.page.evaluate(() => [...document.querySelectorAll('#doc-list tbody tr')].map((tr) => {
      const c = tr.querySelectorAll('td');
      return { name: c[0].textContent.trim(), type: c[1].textContent.trim(), size: c[2].textContent.trim(), chars: c[3].textContent.trim() };
    }));
  }
  async waitDocs(n, timeout = 30000) {
    await this.page.waitForFunction((n) => {
      const rows = document.querySelectorAll('#doc-list tbody tr');
      return rows.length === n && !/parsing/i.test(document.getElementById('doc-list').textContent);
    }, n, { timeout });
  }

  /* ------------------------------------------------------------------ settings */
  async configure({ provider, key, base, model, lengths } = {}) {
    const p = this.page;
    await p.click('#open-settings');
    if (provider) await p.selectOption('#set-provider', provider);
    const setIf = async (sel, val) => {
      if (val === undefined) return;
      if (await p.isVisible(sel)) await p.fill(sel, val);
      else if (val !== '') throw new Error(`settings field ${sel} is not visible for provider ${provider}`);
    };
    await setIf('#set-key', key);
    await setIf('#set-base', base);
    await setIf('#set-model', model);
    for (const [k, v] of Object.entries(lengths || {})) await p.selectOption('#len-' + k, String(v));
    await p.click('#settings-save');
    await p.waitForFunction(() => !document.getElementById('settings-modal').classList.contains('show'));
  }

  /* ------------------------------------------------------------------ workspace */
  workspaceJson({ docs = [], questions = [], settings } = {}) {
    return { app: 'countersign', version: 2, appVersion: 'e2e', exportedAt: new Date().toISOString(), docs, questions, ...(settings ? { settings } : {}) };
  }
  async hasWork() {
    return this.page.evaluate(() => document.querySelectorAll('#doc-list tbody tr').length + document.querySelectorAll('#ledger .q-row').length > 0);
  }
  /* The app only asks "replace your workspace?" when there is work to replace, so a reply is
     queued only in that case (an unused reply would be eaten by the next, unrelated dialog).
     confirm: true/false forces the reply; undefined means "accept if asked". */
  async importWorkspace(obj, { confirm, raw } = {}) {
    if ((await this.hasWork()) && confirm !== null) this.dialogQueue.push({ accept: confirm === undefined ? true : confirm });
    const buffer = Buffer.from(raw !== undefined ? raw : JSON.stringify(obj));
    await this.page.setInputFiles('#ws-import-input', { name: 'countersign-data.json', mimeType: 'application/json', buffer });
  }
  /* Seed docs + questions through the real import control, then wait for the UI to reflect it. */
  async seed({ docs = [], questions = [], settings } = {}) {
    await this.importWorkspace(this.workspaceJson({ docs, questions, settings }));
    await this.page.waitForFunction(([nd, nq]) => {
      const dn = document.querySelectorAll('#doc-list tbody tr').length;
      const q = document.querySelectorAll('#ledger .q-row').length;
      return dn === nd && q === nq;
    }, [docs.length, questions.length], { timeout: 15000 });
    await this.page.waitForTimeout(500);   // let the debounced persist land
  }

  /* ------------------------------------------------------------------ ledger */
  async ledger() {
    return this.page.evaluate(() => [...document.querySelectorAll('#ledger .q-row')].map((r) => {
      const qt = r.querySelector('.q-text');
      const ta = r.querySelector('textarea[data-ans]');
      const cov = r.querySelector('.coverage span');
      return {
        id: r.dataset.id,
        ref: (r.querySelector('.clause') || {}).textContent,
        text: qt && qt.childNodes[0] ? qt.childNodes[0].textContent.trim() : '',
        type: (r.querySelector('.qtype') || {}).textContent || '',
        stamp: (r.querySelector('.stamp') || {}).textContent || '',
        cov: cov ? cov.textContent : null,
        covPct: cov ? parseInt(cov.textContent, 10) : null,
        answer: ta ? ta.value : '',
        src: (r.querySelector('.src-note') || {}).textContent || '',
        open: r.classList.contains('open'),
      };
    }));
  }
  async waitLedger(n, timeout = 15000) {
    await this.page.waitForFunction((n) => document.querySelectorAll('#ledger .q-row').length === n, n, { timeout });
  }
  async openRow(i) {
    const row = this.page.locator('#ledger .q-row').nth(i);
    if (!(await row.evaluate((r) => r.classList.contains('open')))) await row.locator('.q-head').click();
    return row;
  }
  async addQuestion(text) {
    const before = (await this.ledger()).length;
    this.dialogQueue.push({ accept: true, text });
    await this.page.click('#add-q-btn');
    await this.waitLedger(before + 1);
  }
  /* Settled means no row is mid-generation and nothing is left for the debounced persist. */
  async settled(timeout = 40000) {
    await this.page.waitForFunction(() => ![...document.querySelectorAll('#ledger .stamp')].some((s) => /working/i.test(s.textContent)),
      null, { timeout, polling: 100 });
    await this.page.waitForTimeout(250);
  }
  async generateAll() {
    await this.page.click('#generate-all');
    await this.settled();
  }
  async generateRow(i) {
    const row = await this.openRow(i);
    await row.locator('[data-gen]').click();
    await this.settled();
  }
  async editAnswer(i, text) {
    const row = await this.openRow(i);
    const ta = row.locator('textarea[data-ans]');
    await ta.fill(text);
    await ta.blur();
    await this.page.waitForTimeout(150);
  }
  async approve(i) {
    const row = await this.openRow(i);
    await row.locator('[data-approve]').click();
  }

  /* ------------------------------------------------------------------ rfp intake */
  async rfpFile(f) {
    await this.page.setInputFiles('#rfp-file-input', { name: f.name, mimeType: f.mimeType, buffer: f.buffer });
    // the label reads "Parsing <name>..." while working and "<name> · N KB" when done
    await this.page.waitForFunction((n) => {
      const s = document.getElementById('rfp-file-label').textContent;
      return s.includes(n) && !/^\s*parsing/i.test(s);
    }, f.name, { timeout: 30000 });
  }
  async extract() {
    await this.page.click('#extract-btn');
    await this.page.waitForFunction(() => {
      const b = document.getElementById('extract-btn');
      return !b.disabled && !b.querySelector('.spin');
    }, null, { timeout: 30000 });
    await this.page.waitForTimeout(150);
  }

  /* ------------------------------------------------------------------ export */
  async exportOptions({ title, company, approvedOnly, sources, gaps, fmt } = {}) {
    const p = this.page;
    if (title !== undefined) await p.fill('#exp-title', title);
    if (company !== undefined) await p.fill('#exp-company', company);
    if (approvedOnly !== undefined) await p.setChecked('#exp-approved-only', approvedOnly);
    if (sources !== undefined) await p.setChecked('#exp-sources', sources);
    if (gaps !== undefined) await p.setChecked('#exp-gaps', gaps);
    if (fmt) await p.click(`.fmt-card[data-fmt="${fmt}"]`);
  }
  async download(trigger, timeout = 30000) {
    const [dl] = await Promise.all([this.page.waitForEvent('download', { timeout }), trigger()]);
    const file = await dl.path();
    return { name: dl.suggestedFilename(), buffer: fs.readFileSync(file) };
  }
  async downloadExport() { return this.download(() => this.page.click('#download-btn')); }
  async exportWorkspace() {
    await this.goPage('bucket');
    const d = await this.download(() => this.page.click('#ws-export'));
    return { ...d, json: JSON.parse(d.buffer.toString('utf8')) };
  }

  /* ------------------------------------------------------------------ diagnostics */
  consoleErrors({ ignore = [] } = {}) {
    return this.consoleMsgs.filter((m) => m.type === 'error').filter((m) => {
      // a fresh visitor asks for the optional site-directory workspace file; a 404 is the normal answer
      if (/countersign-data\.json/.test(m.url)) return false;
      if (/favicon\.ico/.test(m.url)) return false;
      return !ignore.some((re) => re.test(m.text) || re.test(m.url));
    });
  }
  async storageDump() {
    return this.page.evaluate(() => {
      const out = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); } } catch (e) { /* ignore */ }
      return out;
    });
  }
  /* The saved ledger, found by shape rather than by storage key name: the first JSON array in
     localStorage whose items look like questions ({ref, text}). */
  async storedQuestions() {
    const dump = await this.storageDump();
    for (const v of Object.values(dump)) {
      try {
        const a = JSON.parse(v);
        if (Array.isArray(a) && a.length && a[0] && typeof a[0] === 'object' && 'ref' in a[0] && 'text' in a[0]) return a;
      } catch (e) { /* not json */ }
    }
    return null;
  }
  /* Uncaught exceptions plus unhandled promise rejections (an async click handler that throws
     is a rejection, which Playwright's pageerror event can report late). */
  async pageIssues() {
    const rej = await this.page.evaluate(() => window.__rejections || []).catch(() => []);
    return [...new Set([...this.pageErrors, ...rej])];
  }
  async close() {
    try { await this.ctx.close(); } catch (e) { /* already closed */ }
  }
  async shot(file) {
    try { await this.page.screenshot({ path: file, fullPage: false }); } catch (e) { /* page gone */ }
  }
}

module.exports = { App, ALLOWED_CDN };
