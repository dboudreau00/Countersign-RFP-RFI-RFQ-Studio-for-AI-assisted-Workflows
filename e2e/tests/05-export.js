'use strict';
/* Exports: DOCX, XLSX, CSV and the round-trip workbook, each read back with real libraries. */
const { defaultAnswerText } = require('../lib/mocks');
const { DOCS, Q_COVERED, Q_ARCH, Q_GAP, q, randKey } = require('../lib/common');
const { unzip, parseCsv } = require('../lib/util');

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = (test) => {
  async function generated(t, { questions = [Q_COVERED(), Q_ARCH(), Q_GAP()], docs = DOCS(), answerText } = {}) {
    const app = await t.app();
    if (answerText) app.answerText = answerText;
    await app.goto();
    await app.seed({ docs, questions });
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    await app.generateAll();
    await app.goPage('export');
    return app;
  }

  /* ---------------- DOCX ---------------- */
  test('export.docx', async (t) => {
    const answerText = (a) => (a.ref === 'B1'
      ? 'Control\u000bchars\u000cin one answer with entity &amp; <tag> kept literal.'
      : defaultAnswerText(a.ref));
    const app = await generated(t, { answerText });
    await app.exportOptions({ title: 'E2E Proposal 2026', company: 'Northwind E2E Ltd', gaps: true, sources: true, fmt: 'docx' });
    t.match('preview lists all three answers', await app.page.textContent('#exp-count'), /^3 rows/);
    t.check('docx is the selected format', await app.page.evaluate(() => document.querySelector('.fmt-card[data-fmt="docx"]').classList.contains('sel')));
    const dl = await app.downloadExport();
    t.eq('file name comes from the proposal title', dl.name, 'E2E_Proposal_2026.docx');
    t.eq('a real ZIP container (PK header)', dl.buffer.slice(0, 2).toString(), 'PK');
    const { text, messages } = await t.mammoth(dl.buffer);
    t.info('mammoth warnings', JSON.stringify(messages));
    t.has('title is in the document', text, 'E2E Proposal 2026');
    t.has('company name is in the document', text, 'Northwind E2E Ltd');
    for (const [ref, qtext] of [['A1', 'Describe how Zyphron attestation is performed and by whom.'], ['B1', 'Explain Quillfeather replication across regional mirrors.'], ['C1', 'Describe your helicopter maintenance scheduling process.']]) {
      t.check(`question ${ref} appears as a heading line "ref <separator> text"`, new RegExp(`${ref}.{1,6}${reEsc(qtext)}`).test(text));
    }
    t.has('answer text present (marker for A1)', text, 'ANSMARK-A1');
    t.has('bold markdown content kept', text, 'Bold claim');
    t.lacks('markdown ** markers are not left in the document', text, '**');
    t.lacks('markdown *italic* markers are not left in the document', text, '*italic note*');
    t.has('underscore identifiers survive (max_tokens_limit is not turned into italics)', text, 'max_tokens_limit');
    t.has('list markers become bullets', text, '• item one');
    t.has('ampersand and angle brackets kept literally', text, 'entity &amp; <tag> kept literal');
    t.check('control characters were replaced by spaces', /Control chars in one answer/.test(text), JSON.stringify((text.match(/Control.{0,20}/) || [''])[0]));
    t.has('source references are included', text, 'Sources: kb-security.txt');
    t.match('gap appendix is appended when ticked', text, /coverage gap report/i);
    t.has('gap appendix lists the uncovered question', text.slice(text.search(/coverage gap report/i)), 'helicopter maintenance scheduling');
    t.match('gap appendix names the missing topics', text, /No source material on: .*helicopter/);
    // structure, read straight from the zip (independent of mammoth)
    const zip = unzip(dl.buffer);
    t.check('zip has the OOXML parts Word needs', ['[Content_Types].xml', 'word/document.xml', '_rels/.rels'].every((n) => zip.has(n)), [...zip.keys()].join(','));
    const xml = zip.get('word/document.xml').toString('utf8');
    t.check('document.xml contains no forbidden C0 control characters', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml));
    t.match('questions are real Heading 2 paragraphs', xml, /w:pStyle w:val="Heading2"/);
    t.match('the title uses the Title style', xml, /w:pStyle w:val="Title"/);
    t.match('a bold run exists for the **bold** markdown', xml, /<w:b\/>|<w:b w:val/);
    // option toggles: approved only, no sources, no gaps
    await app.goPage('workspace');
    await app.approve(0);
    await app.goPage('export');
    await app.exportOptions({ approvedOnly: true, sources: false, gaps: false });
    t.match('approved-only preview shows 1 row', await app.page.textContent('#exp-count'), /^1 rows/);
    const dl2 = await app.downloadExport();
    const t2 = (await t.mammoth(dl2.buffer)).text;
    t.check('approved-only: A1 present, B1 and C1 absent', t2.includes('ANSMARK-A1') && !t2.includes('ANSMARK-B1') && !t2.includes('ANSMARK-C1'));
    t.lacks('sources unticked: no Sources line', t2, 'Sources:');
    t.check('gaps unticked: no appendix', !/coverage gap report/i.test(t2));
  });

  /* ---------------- XLSX ---------------- */
  test('export.xlsx', async (t) => {
    const app = await generated(t);
    await app.exportOptions({ title: 'Matrix Out', gaps: true, sources: true, fmt: 'xlsx' });
    const dl = await app.downloadExport();
    t.eq('file name', dl.name, 'Matrix_Out.xlsx');
    const wb = await t.readXlsx(dl.buffer);
    t.eq('sheets: Responses then Coverage gaps', wb.sheetNames, ['Responses', 'Coverage gaps']);
    const r = wb.sheets.Responses.aoa;
    t.eq('Responses header row', r[0], ['Ref', 'Type', 'Question', 'Response', 'Status', 'Sources']);
    t.eq('one row per answered question', r.length - 1, 3);
    t.eq('A1 row: ref, type, question', [r[1][0], r[1][1], r[1][2]], ['A1', 'Narrative', 'Describe how Zyphron attestation is performed and by whom.']);
    t.eq('A1 row: response is the full answer text', r[1][3], defaultAnswerText('A1'));
    t.eq('A1 row: status and sources', [r[1][4], r[1][5]], ['Generated', 'kb-security.txt']);
    t.eq('C1 row (no sources) has an empty Sources cell', r[3][5], '');
    const g = wb.sheets['Coverage gaps'].aoa;
    t.eq('Coverage gaps header', g[0], ['Ref', 'Question', 'Coverage %', 'Missing topics']);
    t.eq('only the uncovered question is a gap', g.length - 1, 1);
    t.eq('gap row: ref and coverage 0', [g[1][0], g[1][2]], ['C1', 0]);
    t.match('gap row names the missing topics', String(g[1][3]), /helicopter/);
    await app.exportOptions({ gaps: false, sources: false });
    const wb2 = await t.readXlsx((await app.downloadExport()).buffer);
    t.eq('gaps unticked: only the Responses sheet', wb2.sheetNames, ['Responses']);
    t.eq('sources unticked: no Sources column', wb2.sheets.Responses.aoa[0], ['Ref', 'Type', 'Question', 'Response', 'Status']);
  });

  /* ---------------- CSV ---------------- */
  test('export.csv', async (t) => {
    const app = await generated(t, { questions: [Q_COVERED(), Q_ARCH()] });
    const tricky = 'He said "hello", then\nleft; 100% done, ok?';
    await app.goPage('workspace');
    await app.editAnswer(1, tricky);
    await app.goPage('export');
    await app.exportOptions({ title: '../../Evil name?*:|<>"\\', sources: true, fmt: 'csv' });
    const dl = await app.downloadExport();
    t.match('file name is sanitised (no path separators or reserved characters)', dl.name, /^[A-Za-z0-9_-]+\.csv$/);
    t.eq('UTF-8 byte order mark first', [...dl.buffer.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = dl.buffer.toString('utf8');
    t.check('records are CRLF separated', text.split('\r\n').length >= 3 && text.split('\r\n')[0].startsWith('﻿"Ref"'), JSON.stringify(text.slice(0, 60)));
    const rows = parseCsv(text);
    t.eq('header row', rows[0], ['Ref', 'Type', 'Question', 'Response', 'Status', 'Sources']);
    t.eq('data rows', rows.length - 1, 2);
    t.eq('first row fields', [rows[1][0], rows[1][2], rows[1][3], rows[1][4], rows[1][5]], ['A1', 'Describe how Zyphron attestation is performed and by whom.', defaultAnswerText('A1'), 'Generated', 'kb-security.txt']);
    t.eq('quotes, commas and newlines in an answer survive the round trip exactly', rows[2][3], tricky);
    await app.exportOptions({ sources: false });
    const rows2 = parseCsv((await app.downloadExport()).buffer.toString('utf8'));
    t.eq('sources unticked drops the column', rows2[0], ['Ref', 'Type', 'Question', 'Response', 'Status']);
  });

  test('export.csv-formula-injection', async (t) => {
    const payloads = ['=HYPERLINK("http://e2e.test/steal","click")', '+1+1', '-2+3', '@SUM(1+1)'];
    const qs = payloads.map((p, i) => q('F' + (i + 1), p + ' question number ' + (i + 1)));
    const app = await generated(t, { questions: qs, answerText: (a) => payloads[+a.ref.slice(1) - 1] + ' is my answer' });
    await app.exportOptions({ fmt: 'csv' });
    const rows = parseCsv((await app.downloadExport()).buffer.toString('utf8'));
    const live = [];
    rows.slice(1).forEach((r) => r.forEach((c, i) => { if (/^[=+\-@\t\r]/.test(c)) live.push(`${rows[0][i]}:${c.slice(0, 24)}`); }));
    t.check('cells starting with = + - @ are neutralised so a spreadsheet will not evaluate them', live.length === 0, live.length ? `live formula cells: ${live.join(' | ')}` : 'none');
  });

  test('export.unicode-and-line-breaks-survive-every-format', async (t) => {
    const qText = 'Wie sichert Zürich den Zugriff? 日本語 😀';
    const ans = 'Antwort mit Umlauten äöü, 日本語, emoji 😀 und “curly quotes”.\n\nZweiter Absatz\nmit Zeilenumbruch.';
    const app = await generated(t, { questions: [q('U1', qText)], answerText: () => ans });
    await app.exportOptions({ title: 'Unicode', sources: false, gaps: false });
    // XLSX
    await app.exportOptions({ fmt: 'xlsx' });
    const x = (await t.readXlsx((await app.downloadExport()).buffer)).sheets.Responses.aoa[1];
    t.eq('XLSX keeps the question text', x[2], qText);
    t.eq('XLSX keeps the answer exactly, including blank lines and line breaks', x[3], ans);
    // CSV
    await app.exportOptions({ fmt: 'csv' });
    const c = parseCsv((await app.downloadExport()).buffer.toString('utf8'))[1];
    t.eq('CSV keeps the question text (UTF-8 with BOM)', c[2], qText);
    t.eq('CSV keeps the answer exactly', c[3], ans);
    // DOCX
    await app.exportOptions({ fmt: 'docx' });
    const d = (await t.mammoth((await app.downloadExport()).buffer)).text;
    t.has('DOCX keeps the question text', d, qText);
    t.has('DOCX keeps non-Latin text, emoji and curly quotes', d, 'Umlauten äöü, 日本語, emoji 😀 und “curly quotes”.');
    t.has('DOCX keeps the second paragraph', d, 'Zweiter Absatz');
  });

  /* ---------------- round trip ---------------- */
  async function roundtrip(t, file, { sheet, count, title }) {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    await app.rfpFile(file);
    await app.page.click('#map-import');
    await app.waitLedger(count);
    await app.generateAll();
    await app.goPage('export');
    await app.exportOptions({ title, fmt: 'roundtrip' });
    t.check('round-trip card is selected and usable', await app.page.evaluate(() => {
      const c = document.getElementById('fmt-roundtrip'); return c.classList.contains('sel') && !c.classList.contains('disabled');
    }));
    const dl = await app.downloadExport();
    t.eq('downloaded as <title>_completed.xlsx', dl.name, title.replace(/\s+/g, '_') + '_completed.xlsx');
    const wb = await t.readXlsx(dl.buffer);
    return { app, wb, ws: wb.sheets[sheet], dl };
  }

  test('export.roundtrip.xlsx-with-title-block', async (t) => {
    const { app, wb, ws } = await roundtrip(t, t.F.rfpXlsxTitle, { sheet: 'Questionnaire', count: 4, title: 'Acme Round Trip' });
    t.eq('both original sheets are preserved', wb.sheetNames, ['Instructions', 'Questionnaire']);
    const c = ws.cells;
    // header is row 4; data rows are 5, 6, [7 = spacer], 8, 9
    const expect = { C5: '1.1', C6: '1.2', C8: '2.1', C9: '2.2' };
    let written = 0;
    for (const [addr, ref] of Object.entries(expect)) {
      t.eq(`answer for ${ref} is at the absolute cell ${addr}`, c[addr], defaultAnswerText(ref));
      if (c[addr]) written++;
    }
    t.eq('four answers written (a past bug wrote zero when the table did not start at A1)', written, 4);
    t.check('spacer row 7 received no answer', c.C7 === undefined || c.C7 === '', String(c.C7));
    t.check('nothing written above the data rows (C1..C3 empty, C4 still the header)', c.C1 === undefined && c.C2 === undefined && c.C3 === undefined && c.C4 === 'Response', JSON.stringify([c.C1, c.C2, c.C3, c.C4]));
    t.eq('title block cell A1 unchanged', c.A1, 'Acme Corp Security Questionnaire 2026');
    t.eq('title block cell A2 unchanged', c.A2, 'Issued 1 September 2026');
    t.eq('title block cell A3 unchanged', c.A3, 'Return completed responses by 30 September 2026');
    t.eq('header row unchanged', [c.A4, c.B4, c.C4], ['Ref', 'Question', 'Response']);
    t.eq('question and ref cells unchanged', [c.A5, c.B5, c.A9, c.B9], ['1.1', 'Do you encrypt customer data at rest?', '2.2', 'Explain how Zyphron attestation is performed and by whom.']);
    t.eq('spacer row cells unchanged', [c.A7, c.B7], ['TBD', 'N/A']);
    t.eq('used range covers the answers', ws.ref, 'A1:C9');
    t.eq('the other sheet is untouched', wb.sheets.Instructions.cells.A1, 'Read the instructions before answering.');
    await app.waitToast(/wrote 4 answers/i);
    t.pass('confirmation toast reports 4 answers written');
  });

  test('export.roundtrip.xlsx-table-offset-to-column-C', async (t) => {
    const { ws } = await roundtrip(t, t.F.rfpXlsxOffset, { sheet: 'Questionnaire', count: 4, title: 'Offset Trip' });
    const c = ws.cells;
    // the block starts at C1: title C1:C3, header row 4 = C4:E4, data rows 5..9, response column is E
    const expect = { E5: '1.1', E6: '1.2', E8: '2.1', E9: '2.2' };
    for (const [addr, ref] of Object.entries(expect)) t.eq(`answer for ${ref} at ${addr}`, c[addr], defaultAnswerText(ref));
    t.eq('title block in column C unchanged', [c.C1, c.C2, c.C3], ['Acme Corp Security Questionnaire 2026', 'Issued 1 September 2026', 'Return completed responses by 30 September 2026']);
    t.eq('header cells unchanged', [c.C4, c.D4, c.E4], ['Ref', 'Question', 'Response']);
    t.check('columns A and B stay empty', !Object.keys(c).some((k) => /^[AB]\d+$/.test(k)), Object.keys(c).filter((k) => /^[AB]\d+$/.test(k)).join(','));
  });

  test('export.roundtrip.xlsx-used-range-not-at-A1', async (t) => {
    const { ws } = await roundtrip(t, t.F.rfpXlsxRefAtC4, { sheet: 'Questionnaire', count: 4, title: 'Range Trip' });
    const c = ws.cells;
    const expect = { E5: '1.1', E6: '1.2', E8: '2.1', E9: '2.2' };
    let written = 0;
    for (const [addr, ref] of Object.entries(expect)) {
      t.eq(`answer for ${ref} at the absolute cell ${addr} (sheet used range starts at C4)`, c[addr], defaultAnswerText(ref));
      if (c[addr]) written++;
    }
    t.eq('four answers written, none lost', written, 4);
    t.eq('header cells unchanged', [c.C4, c.D4, c.E4], ['Ref', 'Question', 'Response']);
    t.check('nothing was written in rows 1 to 3 or in columns A and B', !Object.keys(c).some((k) => /^[AB]\d+$/.test(k) || /^[A-Z]+[123]$/.test(k)), Object.keys(c).filter((k) => /^[AB]\d+$/.test(k) || /^[A-Z]+[123]$/.test(k)).join(','));
    t.eq('used range still C4:E9', ws.ref, 'C4:E9');
  });

  test('export.roundtrip.csv-source', async (t) => {
    const { wb, ws } = await roundtrip(t, t.F.rfpCsv, { sheet: 'Sheet1', count: 3, title: 'Csv Trip' });
    const c = ws.cells;
    t.eq('answers land in column C beside their questions (rows 2 to 4)', [c.C2, c.C3, c.C4], [defaultAnswerText('1'), defaultAnswerText('2'), defaultAnswerText('3')]);
    t.eq('header and questions unchanged', [c.A1, c.B1, c.C1, c.B2], ['Ref', 'Question', 'Response', 'Do you support SSO, SAML and SCIM provisioning?']);
    t.eq('the CSV source was converted to a real workbook', wb.sheetNames, ['Sheet1']);
  });

  test('export.roundtrip.only-answered-rows', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.rfpFile(t.F.rfpXlsxTitle);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    await app.goPage('export');
    await app.exportOptions({ fmt: 'roundtrip' });
    await app.page.click('#download-btn');
    await app.waitToast(/nothing to export/i);
    t.pass('with no answers the round-trip export refuses with a toast');
    await app.goPage('workspace');
    await app.editAnswer(2, 'Hand answer for the pricing row.');
    await app.goPage('export');
    await app.exportOptions({ title: 'Partial', fmt: 'roundtrip' });
    const dl = await app.downloadExport();
    const c = (await t.readXlsx(dl.buffer)).sheets.Questionnaire.cells;
    t.eq('only the answered row (2.1, row 8) is written', [c.C5, c.C6, c.C8, c.C9], [undefined, undefined, 'Hand answer for the pricing row.', undefined]);
  });

  test('export.roundtrip.filled-template', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    await app.rfpFile(t.F.rfpXlsxFilled);
    t.eq('the guessed response column is C, not the "Answered (Y/N)" flag or the formula column', await app.page.inputValue('#map-ans'), '2');
    const scores = await app.page.evaluate(() => Object.fromEntries(['Vendor Response', 'Vendor comments', 'Response', 'Your answer',
      'Response (required)', 'Supplier', 'Response date', 'Compliance (Y/N)', 'Supplier name', 'Answered', 'Status', 'Preferred approach']
      .map((h) => [h, answerHeaderScore(h)])));
    t.check('a response header outranks a comments header', scores['Vendor Response'] > scores['Vendor comments'] && scores['Vendor comments'] > 0, JSON.stringify(scores));
    t.check('plain response headers are candidates', ['Response', 'Your answer', 'Response (required)', 'Supplier'].every((h) => scores[h] > 0), JSON.stringify(scores));
    t.check('flag and name headers are never candidates', ['Response date', 'Compliance (Y/N)', 'Supplier name', 'Answered', 'Status', 'Preferred approach'].every((h) => scores[h] === 0), JSON.stringify(scores));
    await app.page.click('#map-import');
    await app.waitLedger(4);
    await app.generateAll();
    await app.goPage('export');

    // decline: the filled cells stay as the issuer left them
    await app.exportOptions({ title: 'Kept', fmt: 'roundtrip' });
    let asked = app.dialogs.length;
    app.dialogQueue.push({ accept: false });
    let s = (await t.readXlsx((await app.downloadExport()).buffer)).sheets.Questionnaire;
    t.eq('one question before replacing filled cells', app.dialogs.length - asked, 1);
    t.match('it names the two filled cells and shows one', (app.dialogs[asked] || {}).message || '', /^2 answer cells in column C already hold text or a formula, for example C4: .Our 2025 answer/);
    t.eq('declining keeps last year\'s text', s.cells.C4, 'Our 2025 answer: see the attached plan.');
    t.eq('declining keeps the formula', s.formulas.C5, 'IF(D5="Y","See price list","")');
    t.eq('the empty answer cells are still filled', [s.cells.C3, s.cells.C6], [defaultAnswerText('1'), defaultAnswerText('4')]);
    await app.waitToast(/wrote 2 answers.*2 filled cells kept/i);
    t.pass('the toast counts the kept cells');

    // edit one answer, export again and accept: the loaded workbook was not changed by the
    // first export, so the edited row is not reported as a filled cell
    await app.goPage('workspace');
    await app.editAnswer(0, 'Edited answer for row one.');
    await app.goPage('export');
    await app.exportOptions({ title: 'Replaced', fmt: 'roundtrip' });
    asked = app.dialogs.length;
    app.dialogQueue.push({ accept: true });
    s = (await t.readXlsx((await app.downloadExport()).buffer)).sheets.Questionnaire;
    t.match('the second export asks about the same two cells only', (app.dialogs[asked] || {}).message || '', /^2 answer cells/);
    t.eq('accepting replaces both', [s.cells.C3, s.cells.C4, s.cells.C5, s.cells.C6], ['Edited answer for row one.', defaultAnswerText('2'), defaultAnswerText('3'), defaultAnswerText('4')]);
    t.check('the replaced formula is gone', !s.formulas.C5, JSON.stringify(s.formulas));
    t.eq('the flag column is untouched', [s.cells.D2, s.cells.D3, s.cells.D6], ['Answered (Y/N)', 'N', 'N']);
    t.eq('the formula column is untouched', Object.keys(s.formulas).filter((k) => k[0] === 'E').sort(), ['E3', 'E4', 'E5', 'E6']);
    t.eq('a comment on a replaced answer cell survives', s.comments.C3, 'Max 200 words');
    t.eq('a comment on a question cell survives', s.comments.B4, 'Include notification times');
    t.eq('the merged title survives', s.merges, ['A1:E1']);
    t.info('column widths after the round trip', JSON.stringify(s.cols));
    t.check('column widths survive', s.cols.length >= 5 && Math.abs(s.cols[1] - 48) <= 1 && Math.abs(s.cols[2] - 60) <= 1, JSON.stringify(s.cols));
    await app.waitToast(/wrote 4 answers/i);
  });

  /* ---------------- misc export behaviour ---------------- */
  test('export.nothing-to-export', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('export');
    t.match('preview shows the empty state', await app.page.textContent('#exp-preview'), /nothing to export/i);
    await app.page.click('#download-btn');
    await app.waitToast(/nothing to export/i);
    const dl = await app.page.waitForEvent('download', { timeout: 600 }).then(() => true, () => false);
    t.check('no file is downloaded', !dl);
    t.check('the toast is an error', (await app.toasts()).some((x) => x.err && /nothing to export/i.test(x.text)));
  });

  test('export.preview-follows-options', async (t) => {
    const app = await generated(t, { questions: [Q_COVERED(), Q_ARCH()] });
    t.match('two rows', await app.page.textContent('#exp-count'), /^2 rows/);
    t.has('sources column shown by default', await app.page.textContent('#exp-preview thead'), 'Sources');
    await app.page.uncheck('#exp-sources');
    t.lacks('sources column hidden when unticked', await app.page.textContent('#exp-preview thead'), 'Sources');
    await app.goPage('workspace');
    await app.approve(1);
    await app.goPage('export');
    await app.page.check('#exp-approved-only');
    t.match('approved-only narrows the preview to 1 row', await app.page.textContent('#exp-count'), /^1 rows/);
    await app.goPage('workspace');
    await app.approve(1);        // un-approve: nothing approved any more
    await app.goPage('export');
    t.match('approved-only with nothing approved explains itself', await app.page.textContent('#exp-preview'), /approved/i);
  });
};
