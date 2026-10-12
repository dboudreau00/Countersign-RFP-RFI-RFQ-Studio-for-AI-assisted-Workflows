'use strict';
/* Persistence across reloads, workspace export/import, the site-directory file. */
const { DOCS, Q_COVERED, Q_ARCH, Q_GAP, q, doc, randKey } = require('../lib/common');
const { defaultAnswerText } = require('../lib/mocks');
const { file } = require('../lib/util');

module.exports = (test) => {
  test('persist.reload-restores-everything', async (t) => {
    const KEY = randKey('k-');
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH(), Q_GAP()] });
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: KEY, model: 'claude-persist-e2e', lengths: { technical: 350 } });
    await app.generateAll();
    await app.approve(0);
    await app.editAnswer(1, 'Edited by a person before the reload.');
    await app.page.click('#theme-toggle');
    await app.page.waitForTimeout(700);
    const before = await app.ledger();
    const docsBefore = await app.docRows();
    const themeBefore = await app.page.evaluate(() => document.documentElement.dataset.theme);
    await app.reload();
    const after = await app.ledger();
    t.eq('bucket rows are restored', (await app.docRows()).map((d) => d.name), docsBefore.map((d) => d.name));
    t.eq('ledger refs restored', after.map((r) => r.ref), before.map((r) => r.ref));
    t.eq('answers restored (including the hand edit)', after.map((r) => r.answer), before.map((r) => r.answer));
    t.eq('stamps restored (Approved, Generated, ...)', after.map((r) => r.stamp), before.map((r) => r.stamp));
    t.eq('coverage restored', after.map((r) => r.covPct), before.map((r) => r.covPct));
    t.eq('citations restored', after.map((r) => r.src), before.map((r) => r.src));
    t.eq('theme restored', await app.page.evaluate(() => document.documentElement.dataset.theme), themeBefore);
    t.match('"restored your previous session" toast', (await app.waitToast(/restored/i)).text, /restored/i);
    t.match('provider chip reflects the saved provider', await app.page.textContent('#prov-label'), /your key/i);
    await app.page.click('#open-settings');
    t.eq('settings: provider', await app.page.inputValue('#set-provider'), 'claude-key');
    t.eq('settings: model', await app.page.inputValue('#set-model'), 'claude-persist-e2e');
    t.eq('settings: length target', await app.page.inputValue('#len-technical'), '350');
    t.eq('settings: key is NOT restored', await app.page.inputValue('#set-key'), '');
    await app.page.click('#settings-close');
    // generation after a reload needs the key again, and then uses the saved model
    await app.goPage('workspace');
    await app.clearToasts();
    await app.generateRow(2);
    t.match('without the key the provider refuses with a clear message', (await app.toasts()).map((x) => x.text).join(' | '), /add your anthropic api key/i);
    await app.configure({ provider: 'claude-key', key: KEY });
    await app.generateRow(2);
    const last = app.calls.anthropic[app.calls.anthropic.length - 1];
    t.eq('the saved model is used once the key is re-entered', last.json.model, 'claude-persist-e2e');
    t.eq('the regenerated row is Generated', (await app.ledger())[2].stamp, 'Generated');
  });

  test('persist.two-tabs-merge', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: [doc('alpha.txt', 'Alpha policy text about encryption at rest.')], questions: [q('Q1', 'Do you encrypt customer data at rest?')] });
    // a second tab on the same browser profile
    const b = await app.ctx.newPage();
    await b.goto(app.h.origin + '/index.html', { waitUntil: 'load' });
    await b.waitForFunction(() => document.querySelectorAll('#ledger .q-row').length === 1 && document.querySelectorAll('#doc-list tbody tr').length === 1);
    const refs = (p) => p.$$eval('#ledger .q-row .clause', (c) => c.map((x) => x.textContent.trim()));
    const answers = (p) => p.$$eval('#ledger textarea[data-ans]', (c) => c.map((x) => x.value));
    const docNames = (p) => p.$$eval('#doc-list tbody tr td:first-child', (c) => c.map((x) => x.textContent.trim()));
    const counted = (p, nq, nd) => p.waitForFunction(([a, c]) => document.querySelectorAll('#ledger .q-row').length === a &&
      document.querySelectorAll('#doc-list tbody tr').length === c, [nq, nd], { timeout: 8000 }).then(() => true, () => false);

    // tab A adds a question and a document; tab B shows both without a reload
    await app.goPage('workspace');
    await b.click('#nav-workspace');
    await app.addQuestion('Do you support SAML single sign-on?');
    await app.uploadKb([file('beta.txt', 'text/plain', Buffer.from('Beta policy text about single sign-on.'))]);
    await app.waitDocs(2);
    const caught = await counted(b, 2, 2);
    t.check('the other tab shows the new question and document without a reload', caught, JSON.stringify({ refs: await refs(b), docs: await docNames(b) }));
    t.check('the other tab says why its view changed', await b.evaluate(() => window.__toasts.some((x) => /another tab/i.test(x.text))));

    // tab B writes an answer; tab A shows it, and A's own next save keeps it
    const rowB = b.locator('#ledger .q-row').nth(0);
    await rowB.locator('.q-head').click();
    await rowB.locator('textarea[data-ans]').fill('Answer written in the second tab.');
    await rowB.locator('textarea[data-ans]').blur();
    const shown = await app.page.waitForFunction(() => (document.querySelector('#ledger textarea[data-ans]') || {}).value === 'Answer written in the second tab.', null, { timeout: 8000 }).then(() => true, () => false);
    t.check('the first tab shows the answer written in the second', shown, JSON.stringify(await answers(app.page)));
    await app.editAnswer(1, 'Answer written in the first tab.');
    await app.page.waitForTimeout(300);
    t.eq('storage keeps both tabs\' answers', (await app.storedQuestions()).map((x) => x.answer), ['Answer written in the second tab.', 'Answer written in the first tab.']);

    // changes the first tab never heard about (it wrote them itself, so no storage event
    // reached it): its next save merges them instead of overwriting them
    await app.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('cs-questions'));
      list.push({ id: 'q-sideways', ref: 'Q9', text: 'Describe your backup schedule.', type: 'technical', answer: '', status: 'draft', sources: [], coverage: null });
      localStorage.setItem('cs-questions', JSON.stringify(list));
      const meta = JSON.parse(localStorage.getItem('cs-docs-meta'));
      const docs = [];
      for (let i = 0; i < meta.shards; i++) docs.push(...JSON.parse(localStorage.getItem(`cs-docs-g${meta.gen}-${i}`)));
      docs.push({ id: 'd-sideways', name: 'gamma.txt', type: 'txt', size: 32, chars: 32, text: 'Gamma policy text about backups.' });
      const gen = (meta.gen + 1) % 1000;
      localStorage.setItem(`cs-docs-g${gen}-0`, JSON.stringify(docs));
      localStorage.setItem('cs-docs-meta', JSON.stringify({ gen, shards: 1, count: docs.length, at: Date.now() }));
    });
    t.eq('the first tab has not seen them yet', [(await refs(app.page)).length, (await docNames(app.page)).length], [2, 2]);
    await app.openRow(1);
    await app.page.locator('#ledger .q-row').nth(1).locator('[data-delq]').click();
    await app.page.click('#nav-bucket');
    await app.page.click('#doc-list [aria-label="Remove alpha.txt"]');
    await app.page.waitForTimeout(900);                      // the bucket save is debounced
    t.eq('the stored ledger has the unseen question and not the deleted one', (await app.storedQuestions()).map((x) => x.ref), ['Q1', 'Q9']);
    t.eq('the first tab now shows the merged ledger', await refs(app.page), ['Q1', 'Q9']);
    t.eq('the first tab now shows the merged bucket', (await docNames(app.page)).sort(), ['beta.txt', 'gamma.txt']);

    // the second tab follows, and a reload of it reads the same
    const followed = await counted(b, 2, 2);
    t.check('the second tab follows the merge', followed && (await refs(b)).join() === 'Q1,Q9', JSON.stringify({ refs: await refs(b), docs: await docNames(b) }));
    await b.reload({ waitUntil: 'load' });
    await counted(b, 2, 2);
    t.eq('after a reload: questions', await refs(b), ['Q1', 'Q9']);
    t.eq('after a reload: documents', (await docNames(b)).sort(), ['beta.txt', 'gamma.txt']);
    t.eq('after a reload: the second tab\'s answer survived', (await answers(b))[0], 'Answer written in the second tab.');
    await b.close();
  });

  test('persist.two-tabs-during-generation', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [q('G1', 'Do you encrypt customer data at rest?'), q('G2', 'Describe your disaster recovery architecture.'), q('G3', 'Describe your onboarding process.')] });
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    const b = await app.ctx.newPage();
    await b.goto(app.h.origin + '/index.html', { waitUntil: 'load' });
    await b.waitForFunction(() => document.querySelectorAll('#ledger .q-row').length === 3);
    await b.click('#nav-workspace');
    const base = app.mock.anthropic;
    app.mock.anthropic = async (req, a) => ({ ...(await base(req, a)), delay: 1200 });
    // tab A generates all three; while G1 is in flight, tab B changes the type of G3,
    // which tab A has queued but not started
    await app.page.click('#generate-all');
    await app.page.waitForTimeout(300);
    const rowB = b.locator('#ledger .q-row').nth(2);
    await rowB.locator('.q-head').click();
    await rowB.locator('select[data-type]').selectOption('commercial');
    await app.settled(20000);
    await app.page.waitForTimeout(400);
    const stored = await app.storedQuestions();
    t.eq('every answer tab A generated is stored', stored.map((x) => x.answer), ['G1', 'G2', 'G3'].map(defaultAnswerText));
    t.eq('tab B\'s type change is kept', stored[2].type, 'commercial');
    t.check('tab A asked for G3 as a commercial question', app.calls.anthropic.some((c) => /COMMERCIAL question/.test(c.text) && /RFP QUESTION \(G3\)/.test(c.text)), String(app.calls.anthropic.length));
    const followed = await b.waitForFunction(() => [...document.querySelectorAll('#ledger textarea[data-ans]')].every((x) => x.value), null, { timeout: 8000 }).then(() => true, () => false);
    t.check('tab B shows all three answers', followed);
    await b.close();
  });

  test('persist.workspace-export-import-roundtrip', async (t) => {
    const KEY = randKey('k-');
    const A = await t.app({ name: 'A' });
    await A.goto();
    await A.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH(), Q_GAP()] });
    await A.goPage('workspace');
    await A.configure({ provider: 'claude-key', key: KEY, lengths: { commercial: 250 } });
    await A.generateAll();
    await A.approve(1);
    const ex = await A.exportWorkspace();
    const w = ex.json;
    t.eq('downloaded as countersign-data.json', ex.name, 'countersign-data.json');
    t.eq('app marker', w.app, 'countersign');
    t.check('version fields present', Number.isFinite(w.version) && typeof w.appVersion === 'string', `version=${w.version} appVersion=${w.appVersion}`);
    t.check('exportedAt is an ISO timestamp', !Number.isNaN(Date.parse(w.exportedAt)) && /T/.test(w.exportedAt), w.exportedAt);
    t.eq('docs exported with their text', w.docs.map((d) => [d.name, d.text.length > 20]), [['kb-security.txt', true], ['kb-architecture.md', true]]);
    t.eq('every doc has id, name, type, size, chars, text', w.docs.every((d) => ['id', 'name', 'type', 'size', 'chars', 'text'].every((k) => k in d)), true);
    t.eq('questions exported with answers and statuses', w.questions.map((x) => [x.ref, x.status, x.answer.length > 0]), [['A1', 'generated', true], ['B1', 'approved', true], ['C1', 'generated', true]]);
    t.check('coverage and sources exported', typeof w.questions[0].coverage === 'number' && Array.isArray(w.questions[0].sources));
    t.eq('settings.key is blanked', w.settings.key, '');
    t.eq('settings.lengths exported', w.settings.lengths.commercial, 250);
    t.check('the API key appears nowhere in the file', !ex.buffer.toString('utf8').includes(KEY));

    const B = await t.app({ name: 'B' });
    await B.goto();
    await B.importWorkspace(w);       // fresh browser: no confirmation expected
    await B.waitLedger(3);
    await B.waitDocs(2);
    t.eq('a fresh browser imports without a confirmation prompt', B.dialogs.length, 0);
    const a = await A.ledger(), b = await B.ledger();
    t.eq('imported ledger matches: refs, answers, stamps, coverage, citations',
      b.map((r) => [r.ref, r.answer, r.stamp, r.covPct, r.src]), a.map((r) => [r.ref, r.answer, r.stamp, r.covPct, r.src]));
    t.match('import toast reports counts', (await B.waitToast(/workspace loaded/i)).text, /2 sources, 3 questions/);
    await B.page.click('#open-settings');
    t.eq('imported length target is applied to the running app', await B.page.inputValue('#len-commercial'), '250');
    t.eq('the local provider is not overwritten by the file', await B.page.inputValue('#set-provider'), 'claude');
    await B.page.click('#settings-close');
    await B.page.waitForTimeout(700);
    await B.reload();
    t.eq('the imported bucket and ledger were persisted (survive a reload)', [(await B.docRows()).length, (await B.ledger()).length], [2, 3]);
    await B.page.click('#open-settings');
    t.eq('the imported length targets also survive a reload (they are saved with the workspace)', await B.page.inputValue('#len-commercial'), '250');
    await B.page.click('#settings-close');

    // importing over existing work asks first
    const small = B.workspaceJson({ docs: [doc('only.txt', 'just one document')], questions: [q('Z1', 'The single question in the replacement.')] });
    await B.importWorkspace(small, { confirm: false });
    await B.page.waitForFunction(() => window.__toasts.some((x) => /cancel/i.test(x.text)), null, { timeout: 8000 });
    const dlg = B.dialogs[B.dialogs.length - 1];
    t.eq('over existing work a confirm dialog is shown', dlg.type, 'confirm');
    t.match('the dialog quotes both the current and incoming counts', dlg.message, /2 sources, 3 questions[\s\S]*1 sources?, 1 questions?/);
    t.eq('declining leaves the workspace unchanged', [(await B.docRows()).length, (await B.ledger()).length], [2, 3]);
    await B.importWorkspace(small, { confirm: true });
    await B.waitLedger(1);
    await B.waitDocs(1);
    t.eq('accepting replaces the bucket and the ledger', [(await B.docRows())[0].name, (await B.ledger())[0].ref], ['only.txt', 'Z1']);
  });

  test('persist.import-rejects-bad-files', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [Q_COVERED()] });
    const still = async () => [(await app.docRows()).length, (await app.ledger()).length];
    await app.clearToasts();
    await app.importWorkspace(null, { raw: '{this is not json', confirm: null });
    await app.waitToast(/invalid workspace file/i);
    t.eq('malformed JSON is rejected with an error toast and changes nothing', await still(), [2, 1]);
    await app.importWorkspace(null, { raw: JSON.stringify({ app: 'somebody-else', docs: [] }), confirm: null });
    await app.waitToast(/not a countersign workspace/i);
    t.eq('a JSON file from another app is rejected', await still(), [2, 1]);
    await app.importWorkspace(null, { raw: JSON.stringify({ app: 'countersign', docs: 'nope' }), confirm: null });
    await app.page.waitForTimeout(300);
    t.eq('docs that are not an array are rejected', await still(), [2, 1]);
    t.check('all three rejections were error toasts', (await app.toasts()).filter((x) => x.err).length >= 3);
    t.check('no dialog was left hanging and no page error occurred', (await app.pageIssues()).length === 0);
  });

  test('persist.import-normalises-sloppy-records', async (t) => {
    const app = await t.app();
    await app.goto();
    const sloppy = {
      app: 'countersign', version: 2,
      docs: [{ name: 'noid.txt', text: 'document with no id and no type' }, { name: 'skipme', text: 12345 }, null],
      questions: [
        { text: 'A question with nothing else at all' },
        { id: 'w1', ref: 'W1', text: 'Was mid-generation when exported', status: 'working', answer: '' },
        { id: 'n1', ref: 'N1', text: 'Numeric junk everywhere', coverage: 'lots', sources: 'not-an-array', type: 'nonsense', answer: 42 },
      ],
    };
    await app.importWorkspace(sloppy);
    await app.waitLedger(3);
    const rows = await app.ledger();
    t.check('records without id or ref are still rendered with defaults', rows[0].ref.length > 0 && rows[0].text === 'A question with nothing else at all', JSON.stringify(rows[0]));
    t.eq('a row exported mid-generation comes back as Generated, not stuck on Working', rows[1].stamp, 'Generated');
    t.check('junk coverage/sources/type/answer are coerced safely', rows[2].covPct === null && rows[2].answer === '' && /^(Compliance|Technical|Commercial|Narrative)/.test(rows[2].type), JSON.stringify(rows[2]));
    t.eq('non-object and text-less docs are dropped, the valid one kept', (await app.docRows()).map((d) => d.name), ['noid.txt']);
    t.check('no uncaught errors while importing sloppy data', (await app.pageIssues()).length === 0);
    await app.goPage('workspace');
    await app.page.click('#run-gaps');
    await app.goPage('export');
    t.check('gap analysis and export preview still render', (await app.pageIssues()).length === 0);
  });

  test('persist.directory-file', async (t) => {
    const ws = (name) => ({ app: 'countersign', version: 2, docs: [doc(name, 'Directory workspace document about encryption and backups.')], questions: [q('D1', 'Do you encrypt backups?')], settings: { lengths: { compliance: 50, technical: 250, narrative: 220, commercial: 150 } } });
    const app = await t.app();
    app.directoryFile = () => ({ body: ws('from-directory.txt'), contentType: 'text/plain' });   // wrong content type on purpose
    await app.goto();
    await app.waitLedger(1);
    t.eq('a fresh visitor auto-loads countersign-data.json from the page directory (even served as text/plain)', [(await app.docRows()).map((d) => d.name), (await app.ledger())[0].ref], [['from-directory.txt'], 'D1']);
    t.match('the workspace note says where it came from', await app.page.textContent('#ws-note'), /countersign-data\.json/);
    await app.page.waitForTimeout(700);
    // local work wins over the directory file on the next visit
    app.directoryFile = () => ({ body: ws('newer-directory.txt') });
    const before = app.directoryFetches;
    await app.reload();
    t.eq('a returning visitor keeps the local workspace', (await app.docRows()).map((d) => d.name), ['from-directory.txt']);
    t.eq('and does not even fetch the directory file', app.directoryFetches, before);
    // the manual button loads it on demand (asks before replacing)
    app.dialogQueue.push({ accept: true });
    await app.page.click('#ws-fetch');
    await app.waitDocs(1);
    await app.page.waitForFunction(() => document.querySelector('#doc-list tbody td').textContent.includes('newer-directory.txt'), null, { timeout: 8000 });
    t.pass('"Load from site directory" replaces the workspace after confirmation');

    const app2 = await t.app();
    await app2.goto();
    t.check('no directory file: fresh visitor just gets an empty app, no error toast', !(await app2.toasts()).some((x) => x.err));
    await app2.page.click('#ws-fetch');
    const toast = await app2.waitToast(/no countersign-data\.json/i);
    t.check('manual load with no file explains what is missing (error toast)', toast.err, toast.text);
  });
};
