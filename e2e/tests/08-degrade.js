'use strict';
/* Graceful degradation when a library CDN is blocked. */
const { DOCS, Q_COVERED, doc, q, randKey } = require('../lib/common');
const { parseCsv } = require('../lib/util');

const BLOCKED = /ERR_BLOCKED_BY_CLIENT|Failed to load resource|jsdelivr|cdnjs|pdf\.js|pdfjs/i;

module.exports = (test) => {
  test('degrade.jsdelivr-blocked', async (t) => {
    const F = t.F;
    const app = await t.app({ block: [/cdn\.jsdelivr\.net/] });
    await app.goto();
    t.check('requests to cdn.jsdelivr.net really were blocked', app.blocked.some((u) => /jsdelivr/.test(u)), app.blocked.join(','));
    t.eq('no uncaught page errors while booting without the docx library', (await app.pageIssues()).length, 0);
    const other = app.consoleErrors({ ignore: [BLOCKED] });
    t.check('no console errors other than the blocked resource itself', other.length === 0, JSON.stringify(other.slice(0, 2)));
    const warn = await app.waitToast(/librar/i);
    t.check('boot warns which capability is lost', /docx/i.test(warn.text) && warn.err, warn.text);
    t.check('the warning is an error-style toast', warn.err);
    // everything that does not need docx still works
    await app.uploadKb([F.kbTxt, F.kbMd, F.kbPdf, F.kbDocx, F.kbXlsx, F.kbCsv]);
    // pdf.js normally comes from cdnjs; if a build serves it from jsDelivr too, the PDF is expected to be the one casualty
    await app.page.waitForFunction(() => {
      const n = document.querySelectorAll('#doc-list tbody tr').length;
      return n >= 5 && !/parsing/i.test(document.getElementById('doc-list').textContent);
    }, null, { timeout: 45000 });
    await app.page.waitForTimeout(400);
    const nDocs = (await app.docRows()).length;
    const pdfBlocked = app.blocked.some((u) => /pdf/i.test(u));
    if (nDocs === 5 && pdfBlocked) {
      t.check('pdf.js is served from jsDelivr in this build, so only the PDF is refused (with a message)', !!(await app.toastSeen(/couldn.t parse kb-retention\.pdf/i)));
    } else {
      t.eq('all six KB formats still parse (pdf.js, mammoth and SheetJS come from cdnjs)', nDocs, 6);
    }
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    await app.rfpFile(F.rfpXlsxTitle);
    await app.page.click('#map-import');
    await app.waitLedger(4);
    await app.generateAll();
    t.eq('answers still generate', (await app.ledger()).map((r) => r.stamp), ['Generated', 'Generated', 'Generated', 'Generated']);
    await app.goPage('export');
    // DOCX needs the docx library: refuse with an explanation, no crash, no download
    await app.exportOptions({ fmt: 'docx' });
    await app.clearToasts();
    const dlWait = app.page.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
    await app.page.click('#download-btn');
    const msg = await app.waitToast(/docx|library|load/i);
    t.check('DOCX export is refused with a message naming the DOCX library and offering XLSX or CSV', /docx/i.test(msg.text) && /xlsx|csv/i.test(msg.text) && msg.err, msg.text);
    t.check('and no file was produced', !(await dlWait));
    // the other deliverables are unaffected
    await app.exportOptions({ fmt: 'xlsx' });
    const x = await app.downloadExport();
    t.eq('XLSX export still works', (await t.readXlsx(x.buffer)).sheetNames, ['Responses']);
    await app.exportOptions({ fmt: 'csv' });
    const c = await app.downloadExport();
    t.eq('CSV export still works', parseCsv(c.buffer.toString('utf8')).length, 5);
    await app.exportOptions({ fmt: 'roundtrip' });
    const r = await app.downloadExport();
    t.match('round-trip export still works', r.name, /_completed\.xlsx$/);
    t.check('no uncaught page errors through the whole session', (await app.pageIssues()).length === 0, (await app.pageIssues())[0] || '');
  });

  test('degrade.pdfjs-blocked', async (t) => {
    const F = t.F;
    const app = await t.app({ block: [/pdf\.js|pdfjs/i] });
    await app.goto();
    t.eq('no uncaught page errors on boot', (await app.pageIssues()).length, 0);
    await app.uploadKb([F.kbPdf, F.kbTxt, F.kbDocx]);
    await app.waitDocs(2, 30000);
    t.eq('the PDF is rejected, the other formats still ingest', (await app.docRows()).map((d) => d.name).sort(), ['kb-onboarding.docx', 'kb-security.txt']);
    const fail = await app.waitToast(/couldn.t parse kb-retention\.pdf/i);
    t.check('the PDF failure names the file and says the PDF library is unavailable', /pdf/i.test(fail.text) && fail.err, fail.text);
    await app.goPage('workspace');
    await app.clearToasts();
    await app.page.setInputFiles('#rfp-file-input', { name: F.rfpPdf.name, mimeType: F.rfpPdf.mimeType, buffer: F.rfpPdf.buffer });
    const rfp = await app.waitToast(/couldn.t parse rfp/i);
    t.check('an RFP in PDF form fails with an explanation too', rfp.err, rfp.text);
    t.match('the label recovers to "no file loaded"', await app.page.textContent('#rfp-file-label'), /no file/i);
    await app.page.fill('#rfp-paste', 'Pasted text still works when the PDF library is missing. 1. Do you encrypt data?');
    await app.extract();
    t.eq('pasted-text extraction still works', app.calls.anthropic.length, 1);
    t.check('no uncaught page errors', (await app.pageIssues()).length === 0, (await app.pageIssues())[0] || '');
  });

  test('degrade.every-cdn-blocked', async (t) => {
    const F = t.F;
    const app = await t.app({ block: [/cdn\.jsdelivr\.net/, /cdnjs\.cloudflare\.com/, /cdn\.sheetjs\.com/], allowPageErrors: true });
    await app.goto();
    t.eq('the app still boots (no uncaught errors)', (await app.pageIssues()).length, 0);
    const warn = await app.waitToast(/librar/i);
    t.check('the boot warning lists every missing eagerly loaded capability', ['docx', 'xlsx|spreadsheet'].every((k) => new RegExp(k, 'i').test(warn.text)), warn.text);
    await app.uploadKb([F.kbTxt, F.kbMd, F.kbPdf, F.kbDocx, F.kbXlsx]);
    await app.waitDocs(2, 30000);
    t.eq('plain-text formats still work with no library at all', (await app.docRows()).map((d) => d.name).sort(), ['kb-architecture.md', 'kb-security.txt']);
    await app.page.waitForFunction(() => window.__toasts.filter((x) => /couldn.t parse/i.test(x.text)).length >= 3, null, { timeout: 8000 }).catch(() => {});
    const fails = (await app.toasts()).filter((x) => /couldn.t parse/i.test(x.text));
    t.eq('each library-backed file gets its own explanation', fails.length, 3);
    await app.goPage('workspace');
    await app.addQuestion('Do you encrypt data at rest?');
    await app.generateAll();
    t.eq('manual questions still generate answers', (await app.ledger())[0].stamp, 'Generated');
    await app.goPage('export');
    await app.exportOptions({ fmt: 'csv' });
    t.eq('CSV export needs no library and works', parseCsv((await app.downloadExport()).buffer.toString('utf8')).length, 2);
    await app.exportOptions({ fmt: 'xlsx' });
    await app.clearToasts();
    await app.page.click('#download-btn');
    await app.page.waitForTimeout(800);
    const issues = await app.pageIssues();
    t.check('XLSX export without SheetJS does not throw an uncaught error', issues.length === 0, issues.length ? 'uncaught: ' + issues[0].split('\n')[0] : 'no uncaught error');
    t.check('XLSX export without SheetJS tells the user (toast) rather than failing silently', (await app.toasts()).some((x) => /xlsx|spreadsheet|librar/i.test(x.text)), JSON.stringify((await app.toasts()).map((x) => x.text)));
  });
};
