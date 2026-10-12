'use strict';
/* Knowledge-base (documentation bucket) ingestion. */
const { SENT } = require('../lib/fixtures');
const { file } = require('../lib/util');

module.exports = (test) => {
  test('kb.ingest-all-formats', async (t) => {
    const F = t.F;
    const app = await t.app();
    await app.goto();
    const all = [F.kbTxt, F.kbMd, F.kbPdf, F.kbDocx, F.kbXlsx, F.kbCsv];
    // real UI path: click the dropzone, answer the file chooser
    const [fc] = await Promise.all([app.page.waitForEvent('filechooser'), app.page.click('#dropzone')]);
    await fc.setFiles(all.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })));
    await app.waitDocs(6, 45000);
    const rows = await app.docRows();
    t.eq('six rows in the bucket table', rows.map((r) => r.name).sort(), all.map((f) => f.name).sort());
    t.eq('file-type badges', rows.map((r) => r.type).sort(), ['CSV', 'DOCX', 'MD', 'PDF', 'TXT', 'XLSX']);
    t.match('document counter shows 6 of 500', await app.page.textContent('#doc-count'), /6\s*\/\s*500/);
    t.check('continue button enabled', await app.page.isEnabled('#to-workspace'));
    t.check('indexed-size label is non-zero', !/^0 KB/.test(await app.page.textContent('#storage-label')), await app.page.textContent('#storage-label'));
    t.check('no parse failure toast', !(await app.toastSeen(/couldn.t parse/i)));
    t.match('success toast', (await app.waitToast(/added 6/i)).text, /added 6/i);

    // stored text, read back through the real "export workspace" control
    const ws = await app.exportWorkspace();
    const byName = Object.fromEntries(ws.json.docs.map((d) => [d.name, d.text]));
    t.eq('workspace file lists all six docs', Object.keys(byName).sort(), all.map((f) => f.name).sort());
    t.has('txt sentinel in stored text', byName['kb-security.txt'] || '', SENT.txt);
    t.has('txt keeps non-ASCII (UTF-8 decoded)', byName['kb-security.txt'] || '', SENT.unicode);
    t.has('md sentinel in stored text', byName['kb-architecture.md'] || '', SENT.md);
    t.has('pdf sentinel in stored text (pdf.js parsed a real PDF)', byName['kb-retention.pdf'] || '', SENT.pdf);
    t.has('pdf second line also extracted', byName['kb-retention.pdf'] || '', 'Backup encryption uses AES-256');
    t.has('docx sentinel in stored text (mammoth)', byName['kb-onboarding.docx'] || '', SENT.docx);
    t.has('docx second paragraph extracted', byName['kb-onboarding.docx'] || '', 'Customer success managers run weekly check-ins');
    t.has('xlsx sentinel in stored text (SheetJS)', byName['kb-sla.xlsx'] || '', SENT.xlsx);
    t.has('xlsx text includes every sheet', byName['kb-sla.xlsx'] || '', '## Sheet: Support');
    t.has('xlsx second sheet content', byName['kb-sla.xlsx'] || '', 'Gold');
    t.has('csv sentinel in stored text', byName['kb-escalation.csv'] || '', SENT.csv);
    t.has('csv full row content', byName['kb-escalation.csv'] || '', 'Brindle escalation path');

    // persisted in browser storage
    await app.page.waitForTimeout(800);
    const dump = await app.storageDump();
    const blob = Object.values(dump).join('\n');           // whichever keys the app uses for the bucket
    t.info('localStorage keys after ingestion', Object.keys(dump).join(','));
    t.check('bucket persisted to localStorage', blob.includes(SENT.txt), 'the bucket text is present in browser storage');
    for (const [label, s] of Object.entries({ txt: SENT.txt, md: SENT.md, pdf: SENT.pdf, docx: SENT.docx, xlsx: SENT.xlsx, csv: SENT.csv })) {
      t.check(`${label} sentinel present in the persisted bucket`, blob.includes(s));
    }
    const writes = app.requests.filter((r) => r.method !== 'GET' && !r.url.startsWith('data:'));
    t.check('ingestion never uploads anything (no non-GET requests)', writes.length === 0, writes.length ? JSON.stringify(writes) : 'only GETs for scripts');
  });

  test('kb.keyboard-and-drag-drop', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.page.bringToFront();
    let fc = null;
    for (let attempt = 0; attempt < 3 && !fc; attempt++) {       // a chooser needs a real user gesture on a focused page
      await app.page.focus('#dropzone');
      fc = await Promise.all([app.page.waitForEvent('filechooser', { timeout: 4000 }), app.page.keyboard.press('Enter')]).then((r) => r[0], () => null);
    }
    t.check('Enter on the focused dropzone opens the file chooser', !!fc);
    await fc.setFiles([{ name: 'kb-keyboard.txt', mimeType: 'text/plain', buffer: Buffer.from('KEYBOARD-SENTINEL uploaded with the keyboard') }]);
    await app.waitDocs(1);
    t.pass('file chosen via the keyboard path is ingested');
    await app.page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['DROPPED-SENTINEL dragged in from the desktop'], 'dropped.txt', { type: 'text/plain' }));
      document.getElementById('dropzone').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.__overClass = document.getElementById('dropzone').classList.contains('over');
      document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    t.check('dragover highlights the dropzone', await app.page.evaluate(() => window.__overClass));
    await app.waitDocs(2);
    const names = (await app.docRows()).map((r) => r.name).sort();
    t.eq('dropped file is ingested alongside the first', names, ['dropped.txt', 'kb-keyboard.txt']);
    t.check('dropzone highlight cleared after the drop', !(await app.page.evaluate(() => document.getElementById('dropzone').classList.contains('over'))));
  });

  test('kb.duplicates-and-delete', async (t) => {
    const F = t.F;
    const app = await t.app();
    await app.goto();
    await app.uploadKb([F.kbTxt]);
    await app.waitDocs(1);
    await app.clearToasts();
    await app.uploadKb([F.kbTxt]);
    await app.waitToast(/duplicate/i);
    t.eq('same name and size is skipped, not added twice', (await app.docRows()).length, 1);
    await app.uploadKb([F.kbMd, F.kbTxt]);
    await app.waitDocs(2);
    t.eq('a new file in a batch with a duplicate is still added', (await app.docRows()).map((r) => r.name).sort(), ['kb-architecture.md', 'kb-security.txt']);
    await app.page.waitForTimeout(700);
    await app.page.click('#doc-list [data-del]');
    await app.waitDocs(1);
    t.pass('delete button removes a row');
    await app.page.waitForTimeout(800);
    await app.reload();
    const rows = await app.docRows();
    t.eq('deletion persisted across reload', rows.length, 1);
    const dump = await app.storageDump();
    const stale = Object.keys(dump).filter((k) => /^cs-docs-(g\d+-)?\d+$/.test(k));
    t.check('no orphaned document shards left in storage', stale.length <= 1, 'shard keys: ' + stale.join(','));
    await app.page.click('#doc-list [data-del]');
    await app.waitDocs(0);
    t.match('empty bucket shows the empty state', await app.page.textContent('#doc-list'), /nothing in the bucket/i);
    t.check('continue disabled again', await app.page.isDisabled('#to-workspace'));
    t.match('size label returns to 0 KB', await app.page.textContent('#storage-label'), /^0 KB/);
  });

  test('kb.legacy-xls-and-uppercase-extensions', async (t) => {
    const app = await t.app();
    await app.goto();
    const upper = file('SHOUTING-NOTES.TXT', 'text/plain', Buffer.from('UPPERCASE-EXT-SENTINEL handled regardless of case'));
    await app.uploadKb([t.F.kbXls, upper]);
    await app.waitDocs(2, 30000);
    const rows = await app.docRows();
    t.eq('both files ingest', rows.map((r) => r.name).sort(), ['SHOUTING-NOTES.TXT', 'kb-legacy.xls']);
    t.eq('the type badge is normalised to upper case', rows.map((r) => r.type).sort(), ['TXT', 'XLS']);
    const ws = await app.exportWorkspace();
    const by = Object.fromEntries(ws.json.docs.map((d) => [d.name, d.text]));
    t.has('binary .xls content is extracted (SheetJS BIFF8 reader)', by['kb-legacy.xls'] || '', 'KBXLS-SENTINEL Pemberton legacy ledger');
    t.has('an upper-case .TXT extension is still read as text', by['SHOUTING-NOTES.TXT'] || '', 'UPPERCASE-EXT-SENTINEL');
  });

  test('kb.bad-files-rejected-cleanly', async (t) => {
    const F = t.F;
    const { makePdf } = require('../lib/util');
    const app = await t.app();
    await app.goto();
    const bad = [
      file('corrupt.pdf', 'application/pdf', Buffer.from('%PDF-1.4\nthis is not really a pdf at all\n')),
      file('blank.pdf', 'application/pdf', makePdf([])),
      file('corrupt.docx', 'application/octet-stream', Buffer.from('definitely not a zip archive'.repeat(10))),
      file('empty.txt', 'text/plain', Buffer.alloc(0)),
    ];
    await app.uploadKb(bad);
    await app.page.waitForFunction(() => window.__toasts.filter((x) => /couldn.t parse/i.test(x.text)).length >= 4, null, { timeout: 30000 });
    const fails = (await app.toasts()).filter((x) => /couldn.t parse/i.test(x.text));
    t.eq('one error toast per bad file', fails.map((x) => x.text.match(/parse ([^:]+):/)[1]).sort(), ['blank.pdf', 'corrupt.docx', 'corrupt.pdf', 'empty.txt']);
    t.check('error toasts are flagged as errors', fails.every((x) => x.err));
    const blank = fails.find((x) => /blank\.pdf/.test(x.text));
    t.match('a PDF with no text layer explains itself', blank.text, /no extractable text|scanned/i);
    const empty = fails.find((x) => /empty\.txt/.test(x.text));
    t.check('an empty text file is not blamed on scanning', /no text found/i.test(empty.text) && !/scanned/i.test(empty.text), empty.text);
    t.eq('nothing bad was added to the bucket', (await app.docRows()).length, 0);
    await app.uploadKb([F.kbTxt]);
    await app.waitDocs(1);
    t.pass('a good file still ingests after the failures (no stuck state)');
  });

  test('kb.long-file-says-it-was-cut', async (t) => {
    const app = await t.app();
    await app.goto();
    const body = 'Retention policy line.\n'.repeat(10000);       // 230,000 characters, 229,999 once trimmed
    await app.uploadKb([file('long-policy.txt', 'text/plain', Buffer.from(body))]);
    await app.waitDocs(1);
    const hit = await app.waitToast(/long-policy\.txt has 229.999 characters/);
    t.check('the cut is announced as a warning', hit.err, JSON.stringify(hit));
    t.match('the toast names the limit', hit.text, /only the first 220.000 are kept/i);
    const ws = await app.exportWorkspace();
    t.eq('the stored text is the first 220,000 characters', ws.json.docs[0].text.length, 220000);
    await app.clearToasts();
    await app.uploadKb([file('short.txt', 'text/plain', Buffer.from('Short policy.'))]);
    await app.waitDocs(2);
    await app.waitToast(/added 1/i);
    t.check('a short file shows no cut warning', !(await app.toastSeen(/only the first/i)));
  });
};
