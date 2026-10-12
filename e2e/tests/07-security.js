'use strict';
/* Stored-XSS regression and credential-routing checks. */
const { doc, q, randKey } = require('../lib/common');
const { anthropicMessage } = require('../lib/mocks');

const P = '"><img src=x onerror="window.__xss=1">';
const LENGTHS_OK = { compliance: 80, technical: 250, narrative: 220, commercial: 150 };

module.exports = (test) => {
  test('xss.imported-workspace', async (t) => {
    const app = await t.app();
    await app.goto();
    const ws = {
      app: 'countersign', version: 2, appVersion: P,
      docs: [
        { id: P, name: P, type: P, size: P, chars: 3, text: 'hostile document about encryption and backups' },
        { id: 'd-ok', name: 'fine.txt', type: 'txt', size: 3, text: 'fine document about encryption' },
      ],
      questions: [
        { id: P, ref: P, text: P, type: P, status: P, answer: P, sources: [P], coverage: 0.1, missing: [P] },
        { id: 'q2', ref: 'Q2', text: 'Second ' + P, type: 'compliance', status: 'generated', answer: '<script>window.__xss=2</script><svg onload=window.__xss=3>',
          sources: ['fine.txt', P], coverage: 0.05, missing: ['a' + P] },
        { id: 'q3', ref: '<b>Q3</b>', text: '<u>Third</u>', type: '"><svg onload=window.__xss=4>', status: '"><svg onload=window.__xss=5>', answer: '', sources: [], coverage: null },
      ],
      settings: { lengths: { compliance: P, technical: '"><svg onload=window.__xss=6>', narrative: '1"><b>', commercial: {} }, provider: P, model: P, base: P },
    };
    await app.importWorkspace(ws);
    await app.waitLedger(3);
    await app.waitDocs(2);
    const exercise = async (phase) => {
      // render every surface that interpolates imported data
      await app.goPage('workspace');
      for (let i = 0; i < 3; i++) await app.openRow(i);
      await app.page.click('#run-gaps').catch(() => {});
      await app.page.waitForTimeout(150);
      await app.goPage('export');
      await app.page.check('#exp-sources');
      await app.page.click('#open-settings');
      await app.page.click('#settings-close');
      await app.goPage('bucket');
      await app.page.waitForTimeout(150);
      const r = await app.page.evaluate(() => ({
        xss: window.__xss,
        imgs: document.querySelectorAll('img').length,
        scripts: [...document.querySelectorAll('script')].filter((s) => s.textContent.includes('__xss')).length,
        injected: document.querySelectorAll('[onerror],[onload]').length,
      }));
      t.check(`${phase}: window.__xss was never set`, r.xss === undefined, `window.__xss=${r.xss}`);
      t.check(`${phase}: no <img> or event-handler attribute was injected into the DOM`, r.imgs === 0 && r.injected === 0, `imgs=${r.imgs} handlers=${r.injected}`);
      t.check(`${phase}: no <script> element carrying the payload appeared`, r.scripts === 0, `${r.scripts} script elements mention __xss`);
      const probes = app.requests.filter((x) => new URL(x.url).pathname === '/x');
      t.check(`${phase}: the broken-image probe (GET /x) was never requested`, probes.length === 0, JSON.stringify(probes));
    };
    await exercise('after import');
    const rows = await app.ledger();
    t.eq('hostile question text is displayed as literal text, not parsed as HTML', rows[0].text, P);
    t.eq('hostile ref is displayed as literal text', rows[0].ref, P);
    t.eq('hostile doc name is displayed as literal text', (await app.docRows())[0].name, P);
    t.eq('a hostile status falls back to Draft', rows[0].stamp, 'Draft');
    t.match('a hostile type falls back to a known type label', rows[0].type, /^(Compliance|Technical|Commercial|Narrative)\b.{0,6}\d+w$/);
    t.check('length targets from the file are numeric in the labels', rows.every((r) => /~\d+w$/.test(r.type)), JSON.stringify(rows.map((r) => r.type)));
    // the delete control must still work when an id is hostile
    await app.page.click('#doc-list [data-del]');
    await app.waitDocs(1);
    t.eq('deleting the hostile-id document removes exactly that one', (await app.docRows()).map((d) => d.name), ['fine.txt']);
    // and the state survives persistence and a reload
    await app.page.waitForTimeout(700);
    await app.reload();
    await exercise('after reload from storage');
    t.eq('hostile ledger still present and still literal after reload', (await app.ledger())[0].text, P);
  });

  test('xss.model-output-and-rfp-text', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: [doc('kb.txt', 'encryption backups policies')], questions: [] });
    await app.goPage('workspace');
    await app.page.fill('#rfp-paste', 'Some RFP text that is long enough to be sent to the extraction step. ' + P);
    app.extractReply = [{ ref: P, q: 'Do you encrypt backups? ' + P, type: P }, { ref: '<i>2</i>', q: '<script>window.__xss=7</script> encryption', type: 'technical' }];
    app.answerText = () => '<img src=x onerror=window.__xss=8> **bold** <script>window.__xss=9</script>';
    await app.extract();
    await app.waitLedger(2);
    await app.generateAll();
    await app.goPage('export');
    await app.page.waitForTimeout(150);
    await app.goPage('workspace');
    await app.openRow(0); await app.openRow(1);
    await app.page.click('#run-gaps');
    await app.page.waitForTimeout(150);
    const r = await app.page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('img').length, handlers: document.querySelectorAll('[onerror],[onload]').length }));
    t.check('extracted questions and generated answers are escaped everywhere they render', r.xss === undefined && r.imgs === 0 && r.handlers === 0, JSON.stringify(r));
    t.eq('the answer textarea carries the literal model text', (await app.ledger())[0].answer, '<img src=x onerror=window.__xss=8> **bold** <script>window.__xss=9</script>');
    t.check('no broken-image probe request', !app.requests.some((x) => new URL(x.url).pathname === '/x'));
  });

  /* The workspace file is untrusted input (the app says so itself). Its settings.base must
     not be able to redirect where the user's key, team token and document text are sent. */
  for (const [provider, field] of [['openai', 'Authorization bearer key'], ['proxy', 'X-Team-Token and the prompt (document excerpts)']]) {
    test(`security.import-cannot-redirect-${provider}-traffic`, async (t) => {
      const KEY = randKey('secret-');
      const app = await t.app({ expectUnexpected: true });
      await app.goto();
      await app.configure({ provider, key: KEY });          // no base: the default endpoint is in use
      const evilBase = 'https://evil.e2e.test/v1';
      await app.importWorkspace(app.workspaceJson({
        docs: [doc('secret-kb.txt', 'CONFIDENTIAL-DOC-TEXT about encryption policies')],
        questions: [q('S1', 'Describe your encryption policies.')],
        settings: { lengths: LENGTHS_OK, provider, model: 'x', base: evilBase },
      }));
      await app.waitLedger(1);
      await app.goPage('workspace');
      await app.page.click('#generate-all');
      await app.settled();
      await app.page.waitForTimeout(200);
      const toEvil = app.unexpected.filter((u) => /evil\.e2e\.test/.test(u.url));
      const leaked = toEvil.map((u) => ({ url: u.url, auth: u.headers.authorization, token: u.headers['x-team-token'] }));
      t.check(`a workspace file cannot point the app at another host (your ${field} would be sent there)`, toEvil.length === 0,
        toEvil.length ? `request(s) went to ${toEvil[0].url} carrying ${JSON.stringify(leaked[0])}` : 'no request left for an unexpected host');
      await app.page.click('#open-settings');
      const base = await app.page.inputValue('#set-base').catch(() => '');
      t.check('the endpoint field was not silently rewritten by the import', base !== evilBase, `base after import: ${JSON.stringify(base)}`);
    });
  }

  test('security.settings-key-fields-are-masked', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.page.click('#open-settings');
    await app.page.selectOption('#set-provider', 'claude-key');
    t.eq('API key input is type=password', await app.page.getAttribute('#set-key', 'type'), 'password');
    t.eq('autocomplete is off for the key field', await app.page.getAttribute('#set-key', 'autocomplete'), 'off');
    t.match('a warning about keys in public pages is shown', await app.page.textContent('#key-warning'), /session/i);
  });
};
