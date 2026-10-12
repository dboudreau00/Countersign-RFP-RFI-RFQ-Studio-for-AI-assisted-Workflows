'use strict';
/* Page load, navigation, theme. */
const REQUIRED_IDS = [
  'dropzone', 'file-input', 'doc-list', 'doc-count', 'to-workspace', 'ws-export', 'ws-import', 'ws-import-input', 'ws-fetch',
  'engine-check', 'engine-push', 'rfp-upload-btn', 'rfp-file-input', 'rfp-paste', 'extract-btn', 'add-q-btn', 'sheet-map',
  'map-sheet', 'map-ref', 'map-q', 'map-ans', 'map-header', 'map-import', 'tone-select', 'generate-all', 'ledger',
  'run-gaps', 'gap-list', 'download-btn', 'exp-title', 'exp-company', 'exp-approved-only', 'exp-sources', 'exp-gaps',
  'exp-preview', 'fmt-roundtrip', 'open-settings', 'settings-modal', 'set-provider', 'set-key', 'set-base', 'set-model',
  'settings-save', 'settings-close', 'theme-toggle', 'toast',
];

module.exports = (test) => {
  test('load.boot', async (t) => {
    const app = await t.app();
    await app.goto();
    const title = await app.page.title();
    t.match('page title names the product', title, /countersign/i);
    const ignored = app.consoleMsgs.filter((m) => m.type === 'error' && !app.consoleErrors().includes(m));
    if (ignored.length) t.info('console errors ignored as expected', ignored.map((m) => `${m.text} [${m.url.split('/').pop()}]`).join(' ; '));
    const errs = app.consoleErrors();
    t.check('zero console errors', errs.length === 0, errs.length ? JSON.stringify(errs.slice(0, 3)) : 'no console.error output');
    const warns = app.consoleMsgs.filter((m) => m.type === 'warning');
    t.check('zero console warnings', warns.length === 0, warns.length ? JSON.stringify(warns.slice(0, 3)) : 'none');
    const issues = await app.pageIssues();
    t.check('zero page errors (uncaught exceptions and unhandled promise rejections)', issues.length === 0, issues.length ? issues[0].slice(0, 300) : 'none');
    const missing = await app.page.evaluate((ids) => ids.filter((id) => !document.getElementById(id)), REQUIRED_IDS);
    t.check('all DOM hooks the harness drives exist', missing.length === 0, missing.length ? 'missing ids: ' + missing.join(',') : `${REQUIRED_IDS.length} ids present`);
    const ver = await app.page.textContent('#ver');
    t.match('version label is rendered', ver, /^v?\d+\.\d+/);
    const store = await app.page.textContent('#store-label');
    t.match('storage backend is reported (browser localStorage here)', store, /this browser/i);
    t.check('bucket page visible first, other pages hidden', await app.page.evaluate(() => {
      const vis = (id) => document.getElementById(id).classList.contains('visible');
      return vis('page-bucket') && !vis('page-workspace') && !vis('page-export');
    }));
    t.check('continue button disabled while bucket is empty', await app.page.isDisabled('#to-workspace'));
    const libToast = await app.toastSeen(/didn.t load|libraries/i);
    t.check('no "library did not load" warning when CDNs are reachable', !libToast, libToast ? libToast.text : 'no warning');
    const hosts = [...new Set(app.requests.map((r) => new URL(r.url).host))].sort();
    t.info('hosts contacted during load', hosts.join(', '));
    const bad = hosts.filter((x) => !/^(127\.0\.0\.1:\d+|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(x));
    t.check('load contacts only the origin, the library CDNs and Google Fonts', bad.length === 0, bad.length ? 'unexpected: ' + bad.join(',') : 'allowlist respected');
    t.check('fresh visitor with no workspace file gets an empty app (no restore toast)', !(await app.toastSeen(/restored/i)));
  });

  test('load.navigation-and-theme', async (t) => {
    const app = await t.app();
    await app.goto();
    const vis = () => app.page.evaluate(() => ['bucket', 'workspace', 'export'].filter((n) => document.getElementById('page-' + n).classList.contains('visible')));
    await app.goPage('workspace');
    t.eq('step 2 shows only the workspace page', await vis(), ['workspace']);
    await app.goPage('export');
    t.eq('step 3 shows only the export page', await vis(), ['export']);
    await app.page.click('#page-export button[data-page="workspace"]');
    t.eq('"Back to workspace" returns to workspace', await vis(), ['workspace']);
    await app.goPage('bucket');
    t.eq('step 1 returns to the bucket', await vis(), ['bucket']);
    const before = await app.page.evaluate(() => document.documentElement.dataset.theme);
    await app.page.click('#theme-toggle');
    const after = await app.page.evaluate(() => document.documentElement.dataset.theme);
    t.check('theme toggle flips data-theme', before !== after && /^(dark|light)$/.test(after), `${before} -> ${after}`);
    await app.page.waitForTimeout(200);
    await app.reload();
    const again = await app.page.evaluate(() => document.documentElement.dataset.theme);
    t.eq('chosen theme survives a reload', again, after);
  });

  test('load.settings-dialog', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.page.click('#open-settings');
    t.check('settings modal opens', await app.page.evaluate(() => document.getElementById('settings-modal').classList.contains('show')));
    const opts = await app.page.$$eval('#set-provider option', (o) => o.map((x) => x.value));
    t.eq('provider choices', opts, ['claude', 'claude-key', 'gemini', 'openai', 'proxy', 'engine']);
    await app.page.selectOption('#set-provider', 'gemini');
    t.check('key row shows for gemini', await app.page.isVisible('#key-row'));
    t.check('base url row hidden for gemini', !(await app.page.isVisible('#base-row')));
    await app.page.selectOption('#set-provider', 'engine');
    t.check('base url row shows for engine', await app.page.isVisible('#base-row'));
    await app.page.selectOption('#set-provider', 'claude');
    t.check('key row hidden for built-in claude', !(await app.page.isVisible('#key-row')));
    await app.page.click('#settings-close');
    t.check('cancel closes the modal', !(await app.page.evaluate(() => document.getElementById('settings-modal').classList.contains('show'))));
  });
};
