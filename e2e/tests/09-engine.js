'use strict';
/* Countersign Engine provider (mocked server) and the team-proxy extraction path. */
const { DOCS, Q_COVERED, Q_ARCH, Q_GAP, q, ENGINE_BASE, randKey } = require('../lib/common');
const { makeDefaults } = require('../lib/mocks');

const engineCalls = (app, p) => app.calls.engine.filter((c) => c.path === p);

module.exports = (test) => {
  async function ready(t, { questions = [Q_COVERED(), Q_ARCH(), Q_GAP()], docs = DOCS(), key } = {}) {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs, questions });
    await app.configure({ provider: 'engine', base: ENGINE_BASE + '/', key });
    return app;
  }

  test('engine.check-and-push', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [] });
    await app.page.click('#engine-check');
    await app.waitToast(/pick .*engine/i);
    t.pass('checking the engine before choosing it explains what to do');
    const TOKEN = randKey('tok-');
    await app.configure({ provider: 'engine', base: ENGINE_BASE + '/', key: TOKEN });
    await app.page.click('#engine-check');
    await app.waitToast(/engine online/i);
    t.eq('health check hits <base>/health (trailing slash trimmed)', engineCalls(app, '/health')[0].url, ENGINE_BASE + '/health');
    t.eq('pill says online', await app.page.textContent('#engine-pill'), 'online');
    t.match('status line shows docs, chunks and model from the health payload', await app.page.textContent('#engine-status'), /3 docs.*9 chunks.*claude-engine-e2e/);
    await app.clearToasts();
    await app.page.click('#engine-push');
    await app.waitToast(/pushed all 2 docs/i);
    const ingests = engineCalls(app, '/ingest');
    t.eq('one /ingest per bucket document', ingests.map((c) => c.json.name).sort(), ['kb-architecture.md', 'kb-security.txt']);
    t.check('each ingest carries the full parsed text', ingests.every((c) => typeof c.json.text === 'string' && c.json.text.length > 40));
    t.check('team token is sent as X-Team-Token on engine calls', ingests.every((c) => c.headers['x-team-token'] === TOKEN));
    t.check('the token never appears in a URL or body', !app.requests.some((r) => r.url.includes(TOKEN)) && ingests.every((c) => !c.text.includes(TOKEN)));
    // partial ingest failure
    app.mock.engine = (req, a) => (new URL(req.url).pathname === '/ingest' && req.json.name === 'kb-architecture.md'
      ? { status: 400, json: { error: { message: 'Document text is empty' } } }
      : makeDefaults(a).engine(req));
    await app.clearToasts();
    await app.page.click('#engine-push');
    const partial = await app.waitToast(/pushed 1\/2 docs/i);
    t.check('a failed ingest is reported as an error with the counts', partial.err && /1 failed/i.test(partial.text), partial.text);
    // unreachable engine
    app.mock.engine = () => ({ abort: 'failed' });
    await app.page.click('#engine-check');
    await app.waitToast(/engine unreachable/i);
    t.eq('unreachable engine shows offline', await app.page.textContent('#engine-pill'), 'offline');
  });

  test('engine.single-answer', async (t) => {
    const TOKEN = randKey('tok-');
    const app = await ready(t, { questions: [q('E1', 'Do you support SSO?')], key: TOKEN });
    await app.goPage('workspace');
    await app.page.selectOption('#tone-select', { index: 2 });
    await app.generateRow(0);
    const c = engineCalls(app, '/answer')[0];
    t.eq('POST <base>/answer', [c.method, c.url], ['POST', ENGINE_BASE + '/answer']);
    t.eq('body: question, type, tone, max_words', [c.json.question, c.json.type, c.json.tone, c.json.max_words], ['Do you support SSO?', 'compliance', 'concise and technical, for engineering evaluators', 80]);
    t.eq('X-Team-Token header', c.headers['x-team-token'], TOKEN);
    const row = (await app.ledger())[0];
    t.eq('row generated from the engine answer', [row.stamp, row.answer], ['Generated', 'ENGINE-ANSWER for: Do you support SSO?']);
    t.check('engine-supplied citations and coverage are displayed', /engine-kb\.txt/.test(row.src) && row.covPct === 85, `${row.src} / ${row.cov}`);
    t.eq('no direct call to a model provider (the key stays on the server)', [app.calls.anthropic.length, app.calls.openai.length, app.calls.gemini.length], [0, 0, 0]);
    t.eq('retrieval is server-side: nothing local was sent in a prompt', c.text.includes('REFERENCE MATERIAL'), false);
  });

  test('engine.batch-stream', async (t) => {
    const app = await ready(t);
    await app.goPage('workspace');
    await app.generateAll();
    const b = engineCalls(app, '/batch');
    t.eq('one /batch call for the whole ledger', b.length, 1);
    const body = b[0].json;
    t.eq('streaming requested', body.stream, true);
    t.eq('every question is sent with id, ref, question, type and max_words', body.questions.map((x) => [x.ref, typeof x.id, typeof x.question, typeof x.type, typeof x.max_words]), [['A1', 'string', 'string', 'string', 'number'], ['B1', 'string', 'string', 'string', 'number'], ['C1', 'string', 'string', 'string', 'number']]);
    t.eq('tone travels at batch level', typeof body.tone, 'string');
    const rows = await app.ledger();
    t.eq('answers from the stream land on the right rows', rows.map((r) => [r.stamp, r.answer]), [['Generated', 'ENGINE-BATCH A1'], ['Generated', 'ENGINE-BATCH B1'], ['Generated', 'ENGINE-BATCH C1']]);
    t.match('progress label reports the batch', await app.page.textContent('#gen-label'), /3\s*\/\s*3/);
    t.check('success toast', !!(await app.toastSeen(/batch complete/i)));
  });

  test('engine.batch-partial-failure-and-truncated-stream', async (t) => {
    const app = await ready(t);
    await app.goPage('workspace');
    const ids = (await app.ledger()).map((r) => r.id);
    // A1 ok, B1 error event, C1 "answer" with no text, and no terminal done event
    app.mock.engine = (req) => {
      if (new URL(req.url).pathname !== '/batch') return makeDefaults(app).engine(req);
      const lines = [
        { kind: 'start', total: 3 },
        { kind: 'answer', index: 0, id: ids[0], ref: 'A1', answer: 'fine answer', sources: ['x.txt'], coverage: 0.7, missing_terms: [] },
        { kind: 'error', index: 1, id: ids[1], ref: 'B1', message: 'Upstream 500' },
        { kind: 'answer', index: 2, id: ids[2], ref: 'C1', answer: '   ', sources: [], coverage: 0.1 },
      ];
      return { contentType: 'application/x-ndjson', text: lines.map((l) => JSON.stringify(l)).join('\n') };   // no trailing newline, no done
    };
    await app.generateAll();
    const rows = await app.ledger();
    t.eq('the good answer is kept; the error event and the empty answer are Failed', rows.map((r) => r.stamp), ['Generated', 'Failed', 'Failed']);
    t.eq('the empty answer was not stored as text', rows[2].answer, '');
    const texts = (await app.toasts()).map((x) => x.text).join(' | ');
    t.match('a stream that ends without a done event is called out', texts, /ended early|cut short|incomplete/i);
    t.match('the summary says how many failed', texts, /2 failed/i);
  });

  test('engine.batch-fails-refused-questions-alone', async (t) => {
    // the engine refuses a whole /batch if one question is under 3 or over 4000 characters
    const long = 'Describe how data is encrypted in transit. ' + 'x'.repeat(4000);
    const app = await ready(t, { questions: [q('A1', 'Do you encrypt data at rest with AES-256?'), q('L1', long), q('S1', 'ab'), q('B1', 'Describe your backup retention policy.')] });
    await app.goPage('workspace');
    await app.generateAll();
    const b = engineCalls(app, '/batch');
    t.eq('one /batch call that carries only the questions the engine accepts', b.map((c) => c.json.questions.map((x) => x.ref)), [['A1', 'B1']]);
    const rows = await app.ledger();
    t.eq('accepted questions are answered and the two refused ones fail on their own', rows.map((r) => r.stamp), ['Generated', 'Failed', 'Failed', 'Generated']);
    t.eq('the answers landed on the right rows', [rows[0].answer, rows[3].answer], ['ENGINE-BATCH A1', 'ENGINE-BATCH B1']);
    const texts = (await app.toasts()).map((x) => x.text).join(' | ');
    t.match('a toast names the refused questions and the limits', texts, /2 questions can't go to the engine.*L1.*S1.*3 to 4000/i);
    t.match('the run reports the two failures instead of claiming success', texts, /2 failed/i);
  });

  test('a11y.keyboard-ledger-and-dialog', async (t) => {
    const app = await ready(t);
    await app.goPage('workspace');
    await app.page.focus('#ledger .q-head');
    await app.page.keyboard.press('Enter');
    t.check('Enter opens a ledger row', await app.page.$eval('#ledger .q-row', (r) => r.classList.contains('open')));
    t.eq('aria-expanded follows', await app.page.$eval('#ledger .q-head', (h) => h.getAttribute('aria-expanded')), 'true');
    await app.page.click('#open-settings');
    t.check('the settings dialog takes focus', await app.page.evaluate(() => document.activeElement && document.activeElement.id === 'settings-dialog'));
    await app.page.keyboard.press('Escape');
    t.check('Escape closes it', !(await app.page.$eval('#settings-modal', (m) => m.classList.contains('show'))));
  });

  test('engine.batch-all-questions-refused', async (t) => {
    const app = await ready(t, { questions: [q('S1', 'ab')] });
    await app.goPage('workspace');
    await app.generateAll();
    t.eq('no /batch call is made', engineCalls(app, '/batch').length, 0);
    t.eq('the row is Failed', (await app.ledger()).map((r) => r.stamp), ['Failed']);
    const texts = (await app.toasts()).map((x) => x.text).join(' | ');
    t.check('the engine and its key are not blamed', !/check the engine/i.test(texts), texts);
  });

  test('engine.batch-splits-over-100-questions', async (t) => {
    const qs = Array.from({ length: 101 }, (_, i) => q('R' + (i + 1), `Bulk question number ${i + 1} about encryption policies.`));
    const app = await ready(t, { questions: qs });
    await app.goPage('workspace');
    await app.generateAll();
    const b = engineCalls(app, '/batch');
    t.eq('101 questions become two batches of 100 and 1', b.map((c) => c.json.questions.length), [100, 1]);
    const rows = await app.ledger();
    t.eq('all 101 rows generated', rows.filter((r) => r.stamp === 'Generated').length, 101);
  });

  test('engine.gap-analysis-uses-search', async (t) => {
    const app = await ready(t, { questions: [Q_COVERED(), Q_GAP()] });
    await app.goPage('workspace');
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    const s = engineCalls(app, '/search');
    t.eq('one /search per question (no model call)', [s.length, app.calls.anthropic.length], [2, 0]);
    t.eq('search body carries the question text and k', [s[0].json.query, s[0].json.k], ['Describe how Zyphron attestation is performed and by whom.', 6]);
    t.match('coverage from the engine is displayed and flagged', await app.page.textContent('#gap-count'), /2 of 2/);
    t.has('engine missing_terms are shown in the gap report', await app.page.textContent('#gap-list'), 'helicopter');
  });

  test('engine.extraction-and-misconfiguration', async (t) => {
    const app = await ready(t, { questions: [] });
    await app.goPage('workspace');
    await app.page.fill('#rfp-paste', 'RFP text to extract through the engine pass-through route. 1. Do you back up customer data?');
    await app.extract();
    const c = engineCalls(app, '/proxy')[0];
    t.eq('extraction goes through <engine>/proxy', c.url, ENGINE_BASE + '/proxy');
    t.check('the pass-through body is an Anthropic messages payload', Array.isArray(c.json.messages) && c.json.messages[0].role === 'user' && c.json.max_tokens >= 8000, `max_tokens=${c.json.max_tokens}`);
    t.eq('no direct api.anthropic.com call from the browser', app.calls.anthropic.length, 0);
    await app.waitLedger(3);
    t.pass('extracted questions appear in the ledger');
    // engine chosen but no URL set
    const app2 = await t.app();
    await app2.goto();
    await app2.seed({ docs: DOCS(), questions: [Q_COVERED()] });
    await app2.configure({ provider: 'engine' });
    await app2.goPage('workspace');
    await app2.clearToasts();
    await app2.page.click('#generate-all');
    await app2.page.waitForTimeout(400);
    t.match('engine without a URL is reported, not silently ignored', (await app2.toasts()).map((x) => x.text).join(' | '), /engine url/i);
    t.eq('and no request is made', app2.calls.engine.length + app2.calls.anthropic.length, 0);
    t.check('the row is not left stuck on Working', (await app2.ledger())[0].stamp !== 'Working…' && !/working/i.test((await app2.ledger())[0].stamp));
  });
};
