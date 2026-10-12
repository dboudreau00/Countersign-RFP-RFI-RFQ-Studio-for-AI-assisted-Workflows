'use strict';
/* RFP intake: PDF, DOCX, pasted text, spreadsheet column mapping, extraction parsing. */
const { anthropicMessage } = require('../lib/mocks');
const { checkAnthropicBody } = require('../lib/common');

const PDF_QS = [
  { ref: '3.1', q: 'Do you encrypt customer data at rest and in transit?', type: 'compliance' },
  { ref: '3.2', q: 'Describe your incident response process and notification times.', type: 'technical' },
  { ref: '3.3', q: 'Provide your pricing model and contract term options.', type: 'commercial' },
];
const promptOf = (call) => call.json.messages[0].content;

module.exports = (test, cfg) => {
  async function extractFrom(t, file, questions, sentinel, sentences) {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(file);
    t.match('file label names the loaded file', await app.page.textContent('#rfp-file-label'), new RegExp(file.name.replace('.', '\\.')));
    t.match('RFP text size is reported', await app.page.textContent('#rfp-chars'), /of RFP text loaded/i);
    t.check('no spreadsheet mapping panel for a non-spreadsheet RFP', !(await app.page.isVisible('#sheet-map')));
    app.extractReply = questions;
    await app.extract();
    t.eq('exactly one model call for extraction', app.calls.anthropic.length, 1);
    const call = app.calls.anthropic[0];
    const prompt = promptOf(call);
    t.has('prompt carries the parsed file text (sentinel)', prompt, sentinel);
    for (const s of sentences) t.has('prompt carries the RFP line: ' + s.slice(0, 40), prompt, s);
    checkAnthropicBody(t, cfg, call, 'extraction call', 'extract');
    await app.waitLedger(questions.length);
    const rows = await app.ledger();
    t.eq('ledger refs', rows.map((r) => r.ref), questions.map((q) => q.ref));
    t.eq('ledger question text', rows.map((r) => r.text), questions.map((q) => q.q));
    t.eq('ledger types come from the model', rows.map((r) => r.type.split(' ')[0]), questions.map((q) => q.type[0].toUpperCase() + q.type.slice(1)));
    t.check('rows start as drafts with no coverage yet', rows.every((r) => /draft/i.test(r.stamp) && r.covPct === null));
    t.match('question counter', await app.page.textContent('#q-count'), new RegExp(`${questions.length} questions`));
    await app.waitToast(new RegExp(`extracted ${questions.length}`, 'i'));
    return app;
  }

  test('intake.pdf', async (t) => {
    await extractFrom(t, t.F.rfpPdf, PDF_QS, 'PDFRFP-SENTINEL', [
      '3.1 Do you encrypt customer data at rest and in transit?', '3.3 Provide your pricing model and contract term options.']);
  });

  test('intake.docx', async (t) => {
    const qs = [
      { ref: '4.1', q: 'Do you hold a current SOC 2 Type II report?', type: 'compliance' },
      { ref: '4.2', q: 'Describe how tenant data is isolated.', type: 'technical' },
    ];
    await extractFrom(t, t.F.rfpDocx, qs, 'DOCXRFP-SENTINEL', ['4.1 Do you hold a current SOC 2 Type II report?', '4.2 Describe how tenant data is isolated.']);
  });

  test('intake.pasted-text', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.clearToasts();
    await app.page.click('#extract-btn');
    await app.waitToast(/load an rfp|paste/i);
    t.check('empty source is refused with an error toast and no model call', app.calls.anthropic.length === 0 && (await app.toasts()).some((x) => x.err));
    await app.page.fill('#rfp-paste', 'too short');
    await app.page.click('#extract-btn');
    await app.page.waitForTimeout(200);
    t.eq('a sub-40-character paste is also refused (still no model call)', app.calls.anthropic.length, 0);
    const text = 'PASTE-SENTINEL Section 9. 9.1 Do you support SAML single sign-on? 9.2 State your uptime commitment.';
    await app.page.fill('#rfp-paste', text);
    app.extractReply = [{ ref: '9.1', q: 'Do you support SAML single sign-on?', type: 'compliance' }, { ref: '9.2', q: 'State your uptime commitment.', type: 'technical' }];
    await app.extract();
    t.has('pasted text reaches the model', promptOf(app.calls.anthropic[0]), 'PASTE-SENTINEL');
    await app.waitLedger(2);
    t.eq('questions land in the ledger', (await app.ledger()).map((r) => r.ref), ['9.1', '9.2']);
    // a file and pasted text are both sent
    await app.rfpFile(t.F.rfpDocx);
    await app.extract();
    const p2 = promptOf(app.calls.anthropic[1]);
    t.check('file text and pasted text are combined in one prompt', p2.includes('DOCXRFP-SENTINEL') && p2.includes('PASTE-SENTINEL'));
    t.check('extract button is usable again', await app.page.isEnabled('#extract-btn'));
  });

  test('intake.extraction-parsing', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.page.fill('#rfp-paste', 'Source text for the extraction parser tests. '.repeat(3));
    let have = 0;
    const run = async (label, reply) => {
      app.extractReply = reply;
      await app.clearToasts();
      await app.extract();
      const rows = await app.ledger();
      const added = rows.slice(have);
      have = rows.length;
      return { added, toasts: (await app.toasts()) };
    };

    // A. plain array with awkward items
    let r = await run('plain', JSON.stringify([
      { ref: 'A1', q: 'Question one is long enough', type: 'technical' },
      { ref: 'A2', q: 'Second', type: 'bogus' },
      { ref: '', q: 'Do you support SSO?', type: 'nonsense' },
      { q: '' }, null, { ref: 'A5' },
    ]));
    t.eq('A: only items with a question are kept', r.added.length, 3);
    t.eq('A: missing ref is numbered, given refs kept', r.added.map((x) => x.ref), ['A1', 'A2', 'Q3']);
    t.eq('A: unknown type falls back to local classification', r.added.map((x) => x.type.split(' ')[0]), ['Technical', 'Narrative', 'Compliance']);

    // B. fenced JSON inside prose
    r = await run('fenced', 'Here is the list you asked for:\n```json\n[{"ref":"B1","q":"Fenced question number one","type":"compliance"},{"ref":"B2","q":"Fenced question number two","type":"commercial"}]\n```\nLet me know if you need more.');
    t.eq('B: fenced array with surrounding prose is parsed', r.added.map((x) => x.ref), ['B1', 'B2']);
    t.check('B: a clean parse raises no truncation warning', !r.toasts.some((x) => /cut off|truncat/i.test(x.text)));

    // C. truncated at the token ceiling: complete objects are salvaged and the user is warned
    r = await run('truncated', '```json\n[{"ref":"C1","q":"First complete question here","type":"compliance"},{"ref":"C2","q":"Second complete question there","type":"technical"},{"ref":"C3","q":"Third question that gets cu');
    t.eq('C: salvage keeps every object that closed cleanly', r.added.map((x) => x.ref), ['C1', 'C2']);
    const warn = r.toasts.find((x) => /cut off|truncat|incomplete/i.test(x.text));
    t.check('C: user is warned the reply was cut off (error toast)', !!warn && warn.err, warn ? warn.text : 'no warning toast seen: ' + JSON.stringify(r.toasts.map((x) => x.text)));

    // D. not JSON at all
    r = await run('prose', 'I am sorry, I cannot help with that request.');
    t.eq('D: prose reply adds nothing', r.added.length, 0);
    t.check('D: failure is reported and the button recovers', r.toasts.some((x) => x.err && /extraction failed/i.test(x.text)) && await app.page.isEnabled('#extract-btn'));

    // E. a bare object instead of an array
    r = await run('object', '{"ref":"E1","q":"A single object reply instead of an array","type":"narrative"}');
    t.eq('E: a single object is accepted as one item', r.added.map((x) => x.ref), ['E1']);

    // F. braces and brackets inside strings must not derail the salvage walker
    r = await run('tricky', '[{"ref":"F1","q":"What is your policy on {curly} and [square] text?","type":"narrative"},{"ref":"F2","q":"Second with a \\"quoted\\" word","type":"technical"},{"ref":"F3","q":"cut off');
    t.eq('F: delimiters inside strings do not break salvage', r.added.map((x) => x.ref), ['F1', 'F2']);
    t.has('F: string content preserved', r.added[0].text, '{curly} and [square]');

    // G. Anthropic refusal with empty content on the extraction call
    app.mock.anthropic = () => ({ json: anthropicMessage('', { content: [], stop_reason: 'refusal' }) });
    r = await run('refusal', undefined);
    t.eq('G: refusal/empty reply adds no questions', r.added.length, 0);
    t.check('G: refusal surfaces as an extraction failure toast', r.toasts.some((x) => x.err && /extraction failed/i.test(x.text)), JSON.stringify(r.toasts.map((x) => x.text)));
    t.check('G: ledger count unchanged and button re-enabled', (await app.ledger()).length === have && await app.page.isEnabled('#extract-btn'));
  });

  test('intake.manual-question-and-classification', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    const cases = [
      ['Do you support SSO?', 'Compliance'],
      ['What is your pricing for 500 seats?', 'Commercial'],
      ['Explain your API rate limit design', 'Technical'],
      ['Tell us about your founding team', 'Narrative'],
    ];
    for (const [q] of cases) await app.addQuestion(q);
    let rows = await app.ledger();
    t.eq('refs auto-number Q1..Q4', rows.map((r) => r.ref), ['Q1', 'Q2', 'Q3', 'Q4']);
    t.eq('questions are auto-classified', rows.map((r) => r.type.split(' ')[0]), cases.map((c) => c[1]));
    t.match('length target is shown per type', rows[0].type, /~80w/);
    app.dialogQueue.push({ accept: false });
    await app.page.click('#add-q-btn');
    app.dialogQueue.push({ accept: true, text: '   ' });
    await app.page.click('#add-q-btn');
    await app.page.waitForTimeout(150);
    t.eq('cancelled and blank prompts add nothing', (await app.ledger()).length, 4);
    const row = await app.openRow(3);
    await row.locator('[data-type]').selectOption('technical');
    rows = await app.ledger();
    t.match('reassigning a type updates the row label', rows[3].type, /^Technical\b.{0,6}250w/);
    await (await app.openRow(3)).locator('[data-delq]').click();
    t.eq('delete removes the question', (await app.ledger()).length, 3);
  });

  /* ---------------- spreadsheet RFPs ---------------- */
  async function mapPanel(app) {
    return app.page.evaluate(() => ({
      visible: getComputedStyle(document.getElementById('sheet-map')).display !== 'none',
      sheets: [...document.querySelectorAll('#map-sheet option')].map((o) => o.value),
      sheet: document.getElementById('map-sheet').value,
      ref: document.getElementById('map-ref').value, q: document.getElementById('map-q').value, ans: document.getElementById('map-ans').value,
      qLabel: document.getElementById('map-q').selectedOptions[0].textContent,
      ansLabel: document.getElementById('map-ans').selectedOptions[0].textContent,
      preview: document.getElementById('map-preview').textContent,
      roundtripDisabled: document.getElementById('fmt-roundtrip').classList.contains('disabled'),
    }));
  }

  test('intake.xlsx-with-title-block', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpXlsxTitle);
    let m = await mapPanel(app);
    t.check('column-mapping panel appears for a spreadsheet', m.visible);
    t.eq('both sheets are offered', m.sheets, ['Instructions', 'Questionnaire']);
    t.eq('the questionnaire sheet (most populated rows) is auto-selected', m.sheet, 'Questionnaire');
    t.eq('ref column guessed as A', m.ref, '0');
    t.eq('question column guessed as B despite the 3-row title block', m.q, '1');
    t.eq('response column guessed as C', m.ans, '2');
    t.match('dropdown labels come from the header row, not the title block', m.qLabel, /^B.*question/i);
    t.match('4 question rows detected below the header (spacer row skipped)', m.preview, /^4\b/);
    t.check('round-trip card starts disabled', m.roundtripDisabled);
    await app.page.uncheck('#map-header');
    t.match('unticking "first row is a header" counts the header row as data', await app.page.textContent('#map-preview'), /^5\b/);
    await app.page.check('#map-header');
    t.eq('no model call is needed for a mapped spreadsheet', app.calls.anthropic.length, 0);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    const rows = await app.ledger();
    t.eq('refs imported from column A', rows.map((r) => r.ref), ['1.1', '1.2', '2.1', '2.2']);
    t.eq('question text imported from column B', rows.map((r) => r.text), [
      'Do you encrypt customer data at rest?', 'Describe your disaster recovery architecture and failover testing.',
      'Provide your pricing model for enterprise licences.', 'Explain how Zyphron attestation is performed and by whom.']);
    t.check('title-block text is not imported as questions', !rows.some((r) => /Acme Corp Security|Issued 1|Return completed/.test(r.text)));
    await app.waitToast(/imported 4 questions/i);
    m = await mapPanel(app);
    t.check('round-trip card becomes available after import', !m.roundtripDisabled);
    t.match('round-trip hint names the response column and sheet', await app.page.textContent('#roundtrip-hint'), /column C.*Questionnaire.*acme-questionnaire\.xlsx/s);
    // changing the response column after import keeps the round trip in step
    await app.page.selectOption('#map-ans', '-1');
    t.check('choosing "skip" for the response column disables the round trip again', (await mapPanel(app)).roundtripDisabled);
    await app.page.selectOption('#map-ans', '2');
    t.check('choosing a response column re-enables it', !(await mapPanel(app)).roundtripDisabled);
    // a different RFP file invalidates the mapping
    await app.rfpFile(t.F.rfpPdf);
    m = await mapPanel(app);
    t.check('loading a non-spreadsheet RFP hides the map and disables the round trip', !m.visible && m.roundtripDisabled);
  });

  test('intake.xlsx-table-offset-to-column-C', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpXlsxOffset);
    const m = await mapPanel(app);
    t.eq('ref column is C (index 2)', m.ref, '2');
    t.eq('question column is D (index 3)', m.q, '3');
    t.eq('response column is E (index 4)', m.ans, '4');
    t.match('labels carry absolute column letters', m.qLabel, /^D.*question/i);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    t.eq('refs read from the offset ref column', (await app.ledger()).map((r) => r.ref), ['1.1', '1.2', '2.1', '2.2']);
  });

  test('intake.legacy-xls-with-title-block', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpXls);
    const m = await mapPanel(app);
    t.eq('the old binary format is read: columns guessed as A, B, C below the title block', [m.ref, m.q, m.ans], ['0', '1', '2']);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    t.eq('four questions imported from the .xls', (await app.ledger()).map((r) => r.ref), ['1.1', '1.2', '2.1', '2.2']);
    t.match('round trip is offered (it will save as .xlsx)', await app.page.textContent('#roundtrip-hint'), /column C/);
  });

  test('intake.xlsx-used-range-not-at-A1', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpXlsxRefAtC4);
    const m = await mapPanel(app);
    t.check('the mapping panel appears', m.visible);
    t.eq('ref, question and response columns are C, D, E (absolute, not re-based onto the used range)', [m.ref, m.q, m.ans], ['2', '3', '4']);
    t.match('dropdown labels show absolute column letters', m.qLabel, /^D.*question/i);
    t.match('4 question rows detected below the header at row 4', m.preview, /^4\b/);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    t.eq('the four questions are imported', (await app.ledger()).map((r) => r.ref), ['1.1', '1.2', '2.1', '2.2']);
  });

  test('intake.csv', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpCsv);
    const m = await mapPanel(app);
    t.check('mapping panel shown for CSV', m.visible);
    t.eq('single sheet', m.sheets.length, 1);
    t.eq('column guesses: ref A, question B, response C', [m.ref, m.q, m.ans], ['0', '1', '2']);
    t.match('three question rows detected', m.preview, /^3\b/);
    await app.page.click('#map-import');
    await app.waitLedger(3);
    const rows = await app.ledger();
    t.eq('refs', rows.map((r) => r.ref), ['1', '2', '3']);
    t.eq('a quoted field containing commas stays intact', rows[0].text, 'Do you support SSO, SAML and SCIM provisioning?');
    t.eq('classification applied to imported rows', rows.map((r) => r.type.split(' ')[0]), ['Compliance', 'Technical', 'Commercial']);
    t.check('round-trip available for a CSV source', !(await mapPanel(app)).roundtripDisabled);
  });
};
