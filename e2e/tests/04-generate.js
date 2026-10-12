'use strict';
/* Answer generation per provider: request shape, credentials, retries, error messages,
   empty completions, retrieval citations and coverage. */
const { anthropicMessage, defaultAnswerText } = require('../lib/mocks');
const { checkAnthropicBody, DOCS, Q_COVERED, Q_ARCH, Q_GAP, q, PROVIDERS, EMPTY_VARIANTS, randKey } = require('../lib/common');

const lastPrompt = (call) => {
  const j = call.json || {};
  if (j.messages) return typeof j.messages[0].content === 'string' ? j.messages[0].content : JSON.stringify(j.messages[0].content);
  if (j.contents) return j.contents[0].parts.map((p) => p.text).join('');
  return '';
};

module.exports = (test, cfg) => {
  async function ready(t, { provider = 'claude', key, base, model, docs = DOCS(), questions = [Q_COVERED()], lengths } = {}) {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs, questions });
    await app.goPage('workspace');
    if (provider !== 'claude' || key || base || model || lengths) await app.configure({ provider, key, base, model, lengths });
    return app;
  }

  /* ---------------- request shape per provider ---------------- */
  test('gen.claude-key.request-shape', async (t) => {
    const KEY = randKey('test-anthropic-');
    const app = await ready(t, { provider: 'claude-key', key: KEY });
    await app.generateAll();
    t.eq('one request per answer', app.calls.anthropic.length, 1);
    const c = app.calls.anthropic[0];
    t.eq('endpoint', c.url, 'https://api.anthropic.com/v1/messages');
    t.eq('method', c.method, 'POST');
    t.eq('x-api-key header carries the key', c.headers['x-api-key'], KEY);
    t.match('anthropic-version header is a dated version', c.headers['anthropic-version'] || '', /^\d{4}-\d{2}-\d{2}$/);
    t.eq('anthropic-dangerous-direct-browser-access header', c.headers['anthropic-dangerous-direct-browser-access'], 'true');
    t.match('json content type', c.headers['content-type'] || '', /application\/json/);
    t.eq('the key never appears in the URL or the body', [c.url.includes(KEY), c.text.includes(KEY)], [false, false]);
    const b = c.json;
    checkAnthropicBody(t, cfg, c, 'answer call', 'answer');
    t.check('prompt is a string user message', typeof b.messages[0].content === 'string');
    const row = (await app.ledger())[0];
    t.eq('row is stamped Generated', row.stamp, 'Generated');
    t.eq('answer text is the text block (thinking block skipped)', row.answer, defaultAnswerText('A1'));
    t.lacks('thinking signature is not leaked into the answer', row.answer, 'sig');
    // custom model is honoured on the next request
    await app.configure({ provider: 'claude-key', key: KEY, model: 'claude-custom-e2e' });
    await app.generateRow(0);
    t.eq('a model typed in settings is sent', app.calls.anthropic[1].json.model, 'claude-custom-e2e');
  });

  test('gen.claude-builtin.keyless', async (t) => {
    const app = await ready(t, { provider: 'claude' });
    await app.generateAll();
    const c = app.calls.anthropic[0];
    t.eq('built-in provider posts to the Anthropic endpoint', c.url, 'https://api.anthropic.com/v1/messages');
    t.check('no x-api-key header is sent for the built-in provider', !('x-api-key' in c.headers));
    t.check('no anthropic-dangerous-direct-browser-access header either', !('anthropic-dangerous-direct-browser-access' in c.headers));
    t.eq('row generated', (await app.ledger())[0].stamp, 'Generated');
    t.check('no provider API key field is needed (chip shows built-in)', /built-in/i.test(await app.page.textContent('#prov-label')), await app.page.textContent('#prov-label'));
  });

  test('gen.claude-key.missing-key-message', async (t) => {
    const app = await ready(t, { provider: 'claude-key', key: '' });
    await app.generateAll();
    t.eq('no request is made without a key', app.calls.anthropic.length, 0);
    t.eq('row fails', (await app.ledger())[0].stamp, 'Failed');
    t.match('toast tells the user to add a key', (await app.toasts()).map((x) => x.text).join(' | '), /add your anthropic api key/i);
  });

  test('gen.gemini', async (t) => {
    const KEY = randKey('test-gemini-');
    const app = await ready(t, { provider: 'gemini', key: KEY });
    await app.generateAll();
    const c = app.calls.gemini[0];
    t.match('endpoint is the generateContent method of the default model', c.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/:?]+:generateContent$/);
    t.eq('key is sent in the X-goog-api-key header', c.headers['x-goog-api-key'], KEY);
    t.check('key is not in the URL (no ?key=, no key value)', !c.url.includes(KEY) && !/[?&]key=/.test(c.url), c.url);
    t.check('key is not in the request body', !c.text.includes(KEY));
    t.check('no Authorization header', !('authorization' in c.headers));
    t.info('gemini request', `url=${c.url} maxOutputTokens=${c.json.generationConfig && c.json.generationConfig.maxOutputTokens}`);
    t.check('prompt is sent as contents[0].parts[0].text', /senior proposal writer/.test(c.json.contents[0].parts[0].text));
    t.check('maxOutputTokens leaves headroom for thinking (>= 8192)', (c.json.generationConfig || {}).maxOutputTokens >= 8192, String((c.json.generationConfig || {}).maxOutputTokens));
    const row = (await app.ledger())[0];
    t.eq('generated from candidates[0].content.parts', [row.stamp, row.answer], ['Generated', defaultAnswerText('A1')]);
    await app.configure({ provider: 'gemini', key: KEY, model: 'gemini-2.5-pro' });
    await app.generateRow(0);
    t.match('typed model is URL-encoded into the path', app.calls.gemini[1].url, /models\/gemini-2\.5-pro:generateContent$/);
    // the 404 hint
    app.mock.gemini = () => ({ status: 404, json: { error: { code: 404, message: 'models/nope is not found', status: 'NOT_FOUND' } } });
    await app.generateRow(0);
    t.match('404 explains the model name is wrong', (await app.toasts()).map((x) => x.text).join(' | '), /unknown model/i);
  });

  test('gen.openai-compatible', async (t) => {
    const KEY = randKey('test-openai-');
    const app = await ready(t, { provider: 'openai', key: KEY });
    await app.generateAll();
    let c = app.calls.openai[0];
    t.eq('default endpoint', c.url, 'https://api.openai.com/v1/chat/completions');
    t.eq('Authorization: Bearer <key>', c.headers['authorization'], 'Bearer ' + KEY);
    t.check('key not in URL or body', !c.url.includes(KEY) && !c.text.includes(KEY));
    t.info('openai request', `model=${c.json.model} max_tokens=${c.json.max_tokens}`);
    t.check('messages[0] is the user prompt', c.json.messages[0].role === 'user' && /senior proposal writer/.test(c.json.messages[0].content));
    t.eq('answer read from choices[0].message.content', [(await app.ledger())[0].stamp, (await app.ledger())[0].answer], ['Generated', defaultAnswerText('A1')]);
    // custom base with trailing slash, custom model
    app.hosts.openai = ['https://llm.e2e.test'];
    await app.configure({ provider: 'openai', key: KEY, base: 'https://llm.e2e.test/v1/', model: 'my-model' });
    await app.generateRow(0);
    c = app.calls.openai[1];
    t.eq('custom base is used and the trailing slash trimmed', c.url, 'https://llm.e2e.test/v1/chat/completions');
    t.eq('custom model is sent', c.json.model, 'my-model');
    t.eq('bearer token follows the custom endpoint', c.headers['authorization'], 'Bearer ' + KEY);
  });

  test('gen.proxy.default-url-and-token', async (t) => {
    const app = await ready(t, { provider: 'proxy' });
    await app.generateAll();
    let c = app.calls.proxy[0];
    t.eq('default proxy URL is proxy.php relative to the page', c.url, app.h.origin + '/proxy.php');
    t.check('no Anthropic key header; nothing from the browser but the body', !('x-api-key' in c.headers) && !('authorization' in c.headers));
    t.check('no team token header when none is set', !('x-team-token' in c.headers));
    t.info('proxy request', `model=${c.json.model} max_tokens=${c.json.max_tokens}`);
    t.eq('answer read from the Anthropic-shaped reply', [(await app.ledger())[0].stamp, (await app.ledger())[0].answer], ['Generated', defaultAnswerText('A1')]);
    t.eq('no direct call to api.anthropic.com in proxy mode', app.calls.anthropic.length, 0);
    const TOKEN = randKey('team-');
    await app.configure({ provider: 'proxy', key: TOKEN });
    await app.generateRow(0);
    c = app.calls.proxy[1];
    t.eq('team token goes in X-Team-Token', c.headers['x-team-token'], TOKEN);
    app.hosts.proxy = ['https://team.e2e.test'];
    await app.configure({ provider: 'proxy', key: TOKEN, base: 'https://team.e2e.test/ai/proxy' });
    await app.generateRow(0);
    t.eq('custom proxy URL is used as typed', app.calls.proxy[2].url, 'https://team.e2e.test/ai/proxy');
    app.mock.proxy = () => ({ status: 401, json: { error: { type: 'auth', message: 'bad team token' } } });
    await app.generateRow(0);
    const texts = (await app.toasts()).map((x) => x.text).join(' | ');
    t.match('401 from the proxy points at the team token', texts, /check the team token/i);
    t.match('and relays the proxy\'s own message', texts, /bad team token/);
  });

  /* ---------------- errors, retry ---------------- */
  test('gen.retry-on-429-then-success', async (t) => {
    const app = await ready(t, { provider: 'claude-key', key: randKey('k-') });
    app.mock.anthropic = (req, a) => (req.index === 0
      ? { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited, slow down' } } }
      : { json: anthropicMessage(defaultAnswerText('A1')) });
    const t0 = Date.now();
    await app.generateAll();
    const ms = Date.now() - t0;
    t.eq('the request is retried exactly once', app.calls.anthropic.length, 2);
    const row = (await app.ledger())[0];
    t.eq('the answer ends Generated with text', [row.stamp, row.answer.length > 0], ['Generated', true]);
    t.info('retry wait', `${ms}ms from click to settled`);
    t.check('no failure toast for a recovered 429', !(await app.toasts()).some((x) => x.err), JSON.stringify((await app.toasts()).map((x) => x.text)));
  });

  test('gen.401-message', async (t) => {
    const app = await ready(t, { provider: 'claude-key', key: randKey('k-') });
    app.mock.anthropic = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    await app.generateAll();
    t.eq('401 is not retried', app.calls.anthropic.length, 1);
    t.eq('row is stamped Failed', (await app.ledger())[0].stamp, 'Failed');
    const errs = (await app.toasts()).filter((x) => x.err).map((x) => x.text);
    t.match('error names the status and points at the API key', errs.join(' | '), /401.*|api key/i);
    t.check('error toast contains "check your API key" guidance and the provider message', /api key/i.test(errs.join(' ')) && /invalid x-api-key/.test(errs.join(' ')), errs.join(' | '));
    t.match('summary toast says every answer failed', errs.join(' | '), /all 1 answers failed/i);
    t.eq('failed row has no answer text', (await app.ledger())[0].answer, '');
  });

  test('gen.server-errors', async (t) => {
    const app = await ready(t, { provider: 'claude-key', key: randKey('k-') });
    app.mock.anthropic = () => ({ status: 500, json: { type: 'error', error: { type: 'api_error', message: 'upstream exploded' } } });
    await app.generateAll();
    t.eq('a persistent 500 is retried once, then given up', app.calls.anthropic.length, 2);
    t.eq('row Failed', (await app.ledger())[0].stamp, 'Failed');
    t.match('message carries status and provider text', (await app.toasts()).map((x) => x.text).join(' | '), /500.*upstream exploded/);
    app.mock.anthropic = () => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad request shape' } } });
    const before = app.calls.anthropic.length;
    await app.generateRow(0);
    t.eq('a 400 is not retried', app.calls.anthropic.length - before, 1);
    app.mock.anthropic = () => ({ abort: 'failed' });
    const before2 = app.calls.anthropic.length;
    await app.generateRow(0);
    t.eq('a network failure ends Failed after one attempt', [(await app.ledger())[0].stamp, app.calls.anthropic.length - before2], ['Failed', 1]);
    app.mock.anthropic = () => ({ status: 200, text: '<html>gateway</html>', contentType: 'text/html' });
    await app.generateRow(0);
    t.eq('a 200 with a non-JSON body ends Failed (no crash)', (await app.ledger())[0].stamp, 'Failed');
    t.check('no uncaught page errors after all of that', (await app.pageIssues()).length === 0);
  });

  /* ---------------- empty / blocked completions, every provider ---------------- */
  for (const [pname, P] of Object.entries(PROVIDERS)) {
    const variants = EMPTY_VARIANTS[P.kind === 'proxy' ? 'anthropic' : P.kind];
    test(`gen.empty-response.${pname}`, async (t) => {
      const names = Object.keys(variants);
      const questions = names.map((_, i) => q('E' + (i + 1), `Empty variant question number ${i + 1} about ${['alpha', 'bravo', 'charlie', 'delta'][i]} controls.`));
      const app = await ready(t, { ...P.cfg(randKey('k-')), questions });
      const pick = (req) => {
        let ref;
        const body = req.json || {};
        if (P.kind === 'engine') ref = /Empty variant question number (\d+)/.exec(body.question || '');
        else ref = /Empty variant question number (\d+)/.exec(lastPrompt(req));
        const idx = ref ? +ref[1] - 1 : 0;
        return { json: variants[names[idx]] };
      };
      app.mock[P.kind] = pick;
      if (P.kind === 'engine') { for (let i = 0; i < names.length; i++) await app.generateRow(i); }
      else await app.generateAll();
      const rows = await app.ledger();
      const allToasts = (await app.toasts()).map((x) => x.text);
      names.forEach((n, i) => {
        const r = rows[i];
        t.info(`${n}: what the app does`, `stamp=${r.stamp} answer=${JSON.stringify(r.answer)} toast=${JSON.stringify(allToasts.find((x) => x.startsWith(`(E${i + 1})`)) || null)}`);
        const neverEmptyGenerated = !(r.stamp === 'Generated' && r.answer.trim() === '');
        t.check(`${n}: does not end Generated with empty text`, neverEmptyGenerated, `stamp=${r.stamp} answer=${JSON.stringify(r.answer)}`);
        t.check(`${n}: ends as a failed answer`, r.stamp === 'Failed' && r.answer === '', `stamp=${r.stamp} answer=${JSON.stringify(r.answer)}`);
      });
      const errToasts = (await app.toasts()).filter((x) => x.err);
      t.check('each failure is reported to the user (error toast per row)', errToasts.length >= names.length, `${errToasts.length} error toasts for ${names.length} rows`);
      // and the failures never leak into the deliverable
      await app.goPage('export');
      t.match('export preview has no rows for failed answers', await app.page.textContent('#exp-count'), /^0 rows/);
    });
  }

  /* ---------------- retrieval, citations, coverage ---------------- */
  test('gen.retrieval-citations-and-coverage', async (t) => {
    const app = await ready(t, { provider: 'claude', questions: [Q_COVERED(), Q_ARCH(), Q_GAP()] });
    await app.generateAll();
    t.eq('three model calls', app.calls.anthropic.length, 3);
    const byRef = Object.fromEntries(app.calls.anthropic.map((c) => [/RFP QUESTION \(([^)]*)\)/.exec(lastPrompt(c))[1], lastPrompt(c)]));
    t.has('A1 prompt carries the matching security document chunk', byRef.A1, '[Source: kb-security.txt]');
    t.has('A1 prompt carries its sentinel text', byRef.A1, 'KBTXT-SENTINEL');
    t.lacks('A1 prompt does not drag in the unrelated architecture document', byRef.A1, 'KBMD-SENTINEL');
    t.has('B1 prompt carries the architecture document', byRef.B1, '[Source: kb-architecture.md]');
    t.match('C1 (no documentation) is told there is no matching documentation and must hedge', byRef.C1, /no matching documentation/i);
    const rows = await app.ledger();
    t.eq('all three Generated', rows.map((r) => r.stamp), ['Generated', 'Generated', 'Generated']);
    t.match('A1 cites kb-security.txt', rows[0].src, /kb-security\.txt/);
    t.match('B1 cites kb-architecture.md', rows[1].src, /kb-architecture\.md/);
    t.check('C1 cites nothing', !/kb-/.test(rows[2].src), rows[2].src);
    t.check('A1 coverage meter is high (>= 60%)', rows[0].covPct >= 60, rows[0].cov);
    t.check('B1 coverage meter is high (>= 60%)', rows[1].covPct >= 60, rows[1].cov);
    t.check('C1 coverage meter is 0% (nothing in the bucket)', rows[2].covPct === 0, rows[2].cov);
    const cls = await app.page.$$eval('#ledger .q-row .coverage .meter', (els) => els.map((e) => e.className));
    t.check('meters are colour-coded (green/warn/bad)', /bad/.test(cls[2]) && !/bad|warn/.test(cls[0]), JSON.stringify(cls));
    t.match('progress label reports completion', await app.page.textContent('#gen-label'), /3\s*\/\s*3/);
    // gap analysis (local, no AI calls)
    const calls = app.calls.anthropic.length;
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    t.eq('gap analysis makes no model calls', app.calls.anthropic.length, calls);
    t.match('gap counter flags 1 of 3', await app.page.textContent('#gap-count'), /1 of 3/);
    const gap = await app.page.textContent('#gap-list');
    t.has('the uncovered question is listed', gap, 'C1');
    const kws = await app.page.$$eval('#gap-list .gap-kw', (e) => e.map((x) => x.textContent));
    t.check('missing topics are named (helicopter, maintenance)', kws.includes('helicopter') && kws.includes('maintenance'), JSON.stringify(kws));
    t.check('covered questions are not in the gap list', !/A1|B1/.test(await app.page.$$eval('#gap-list .gap-item .clause', (e) => e.map((x) => x.textContent).join(','))));
    // answered rows keep the citations that grounded their answer
    const after = await app.ledger();
    t.match('citations survive the gap run', after[0].src, /kb-security\.txt/);
  });

  test('gen.gap-run-drops-citations-of-deleted-documents', async (t) => {
    const app = await ready(t, { provider: 'claude', questions: [Q_COVERED()] });
    await app.generateAll();
    t.match('the answer cites kb-security.txt', (await app.ledger())[0].src, /kb-security\.txt/);
    await app.goPage('bucket');
    await app.page.click('#doc-list tbody tr:first-child [data-del]');
    await app.waitDocs(1);
    await app.goPage('workspace');
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    const row = (await app.ledger())[0];
    t.check('after the document is deleted, a gap run no longer cites it (no phantom source)', !/kb-security\.txt/.test(row.src), row.src);
    t.eq('the answer text itself is untouched', row.answer, defaultAnswerText('A1'));
    t.check('coverage was re-scored against the remaining bucket (now lower)', row.covPct !== null && row.covPct < 60, row.cov);
  });

  test('gen.prompt-carries-tone-and-length', async (t) => {
    const app = await ready(t, { provider: 'claude', questions: [q('L1', 'Do you support SSO?')], lengths: { compliance: 140 } });
    await app.page.selectOption('#tone-select', { index: 3 });
    await app.generateAll();
    let p = lastPrompt(app.calls.anthropic[0]);
    t.has('configured compliance length reaches the prompt', p, 'Target about 140 words');
    t.has('tone option reaches the prompt', p, 'formal, suitable for public-sector procurement');
    t.has('compliance questions get the verdict rule', p, 'COMPLIANCE question');
    t.match('row label shows the configured length', (await app.ledger())[0].type, /Compliance\b.{0,6}140w/);
    const row = await app.openRow(0);
    await row.locator('[data-type]').selectOption('commercial');
    await app.generateRow(0);
    p = lastPrompt(app.calls.anthropic[1]);
    t.has('reassigned type changes the instructions', p, 'COMMERCIAL question');
    t.has('and the length target', p, 'Target about 150 words');
    await app.goPage('export');
    await app.goPage('workspace');
  });

  test('gen.empty-bucket-warning', async (t) => {
    const app = await ready(t, { provider: 'claude', docs: [], questions: [Q_COVERED()] });
    await app.generateAll();
    const warn = await app.waitToast(/bucket is empty/i);
    t.check('empty bucket warns that answers will be generic', !!warn);
    t.match('prompt says no documentation matched', lastPrompt(app.calls.anthropic[0]), /no matching documentation/i);
    t.eq('the answer is still produced', (await app.ledger())[0].stamp, 'Generated');
  });

  /* ---------------- generate-all behaviour ---------------- */
  test('gen.generate-all-partial-failure-and-rerun', async (t) => {
    const qs = [q('P1', 'Explain Zyphron attestation scope.'), q('P2', 'Explain Quillfeather replication scope.'), q('P3', 'Explain onboarding scope for helicopters.')];
    const app = await ready(t, { provider: 'claude', questions: qs });
    app.mock.anthropic = (req) => (/RFP QUESTION \(P2\)/.test(lastPrompt(req))
      ? { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } } }
      : { json: anthropicMessage(defaultAnswerText(/RFP QUESTION \(([^)]*)\)/.exec(lastPrompt(req))[1])) });
    await app.generateAll();
    let rows = await app.ledger();
    t.eq('stamps show which answers failed', rows.map((r) => r.stamp), ['Generated', 'Failed', 'Generated']);
    t.match('progress label reports the failure count', await app.page.textContent('#gen-label'), /1 failed/i);
    t.match('summary toast is an error that says 2 generated and 1 failed', (await app.toasts()).filter((x) => x.err).map((x) => x.text).join(' | '), /2 answers generated.*1 failed/i);
    await app.page.waitForTimeout(100);
    // mark P1 approved; re-run generates only what is missing
    await app.approve(0);
    app.mock.anthropic = (req) => ({ json: anthropicMessage(defaultAnswerText(/RFP QUESTION \(([^)]*)\)/.exec(lastPrompt(req))[1])) });
    const before = app.calls.anthropic.length;
    await app.generateAll();
    t.eq('second run only calls the model for the row that failed', app.calls.anthropic.length - before, 1);
    rows = await app.ledger();
    t.eq('all rows now have answers; the approved one is still approved', rows.map((r) => r.stamp), ['Approved', 'Generated', 'Generated']);
    await app.clearToasts();
    await app.page.click('#generate-all');
    await app.waitToast(/every question already has an answer/i);
    t.pass('a third run says every question already has an answer');
    t.eq('and makes no call', app.calls.anthropic.length - before, 1);
  });

  test('gen.edit-approve-persist', async (t) => {
    const app = await ready(t, { provider: 'claude', questions: [Q_COVERED(), Q_ARCH()] });
    await app.generateAll();
    await app.editAnswer(0, 'Hand-edited answer with "quotes" and <angle> brackets & ampersands.');
    let rows = await app.ledger();
    t.eq('edit is kept in the textarea', rows[0].answer, 'Hand-edited answer with "quotes" and <angle> brackets & ampersands.');
    await app.approve(0);
    rows = await app.ledger();
    t.eq('approve stamps the row', rows[0].stamp, 'Approved');
    t.match('the button flips to Unapprove', await (await app.openRow(0)).locator('[data-approve]').textContent(), /unapprove/i);
    await app.page.waitForTimeout(300);
    const stored = await app.storedQuestions();
    t.eq('edit and approval are persisted', [stored[0].answer, stored[0].status], ['Hand-edited answer with "quotes" and <angle> brackets & ampersands.', 'approved']);
    await app.approve(0);
    t.eq('unapprove returns the row to Generated', (await app.ledger())[0].stamp, 'Generated');
    // typing into an empty draft promotes it from Draft
    const app2 = await ready(t, { provider: 'claude', questions: [q('M1', 'A question answered by hand entirely.')] });
    await app2.editAnswer(0, 'Written by a human.');
    await app2.page.waitForTimeout(300);
    t.eq('a hand-written answer promotes Draft to Generated in the saved state', (await app2.storedQuestions())[0].status, 'generated');
    t.eq('and the visible stamp reflects it straight away (not left saying Draft)', (await app2.ledger())[0].stamp, 'Generated');
  });

  /* ---------------- secrets ---------------- */
  test('sec.api-key-is-session-only', async (t) => {
    const KEY = randKey('test-secret-');
    const app = await ready(t, { provider: 'claude-key', key: KEY });
    await app.generateAll();
    await app.page.waitForTimeout(700);
    const dump = JSON.stringify(await app.storageDump());
    t.check('key is not in localStorage', !dump.includes(KEY));
    const ws = await app.exportWorkspace();
    t.check('key is not in the exported workspace file', !ws.buffer.toString('utf8').includes(KEY));
    t.eq('exported settings.key is empty', ws.json.settings.key, '');
    t.check('key is not in any request URL', !app.requests.some((r) => r.url.includes(KEY)));
    const leaked = app.calls.anthropic.filter((c) => c.headers['x-api-key'] === KEY).length;
    t.eq('key only ever goes to the provider it belongs to', [leaked, app.unexpected.length], [app.calls.anthropic.length, 0]);
    t.check('key is not written to the console', !app.consoleMsgs.some((m) => m.text.includes(KEY)));
    t.check('key is not in sessionStorage or cookies', await app.page.evaluate((k) => !JSON.stringify(sessionStorage).includes(k) && !document.cookie.includes(k), KEY));
    await app.reload();
    await app.page.click('#open-settings');
    t.eq('after a reload the key field is empty (session only)', await app.page.inputValue('#set-key'), '');
    t.eq('but the provider choice was remembered', await app.page.inputValue('#set-provider'), 'claude-key');
  });
};
