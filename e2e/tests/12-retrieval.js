'use strict';
/* Local (in-browser) retrieval: versions, percentages, accented words and CJK text. */
const { doc, q } = require('../lib/common');

module.exports = (test) => {
  test('retrieval.versions-scripts-and-figures', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({
      docs: [
        doc('trust.txt', 'We hold a SOC 2 Type II report, support TLS 1.3 and OAuth 2.0, and commit to 99.95% uptime.'),
        doc('editor.txt', 'The editor supports rich text formatting.'),
        doc('jp.txt', 'お客様のデータは保存時に暗号化されています。'),
      ],
      questions: [
        q('V1', 'Do you hold a SOC 2 Type II report and support TLS 1.3?'),
        q('V2', 'Do you hold a SOC 1 Type I report and support TLS 1.0?'),
        q('Z1', 'Is data hosted in Zürich?'),
        q('J1', 'データは暗号化されていますか'),
      ],
    });
    await app.goPage('workspace');
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    const flagged = await app.page.$$eval('#gap-list .gap-item .clause', (e) => e.map((x) => x.textContent.trim()));
    t.check('the documented versions are not a gap', !flagged.includes('V1'), flagged.join(','));
    t.check('undocumented versions are a gap', flagged.includes('V2'), flagged.join(','));
    const kws = await app.page.$$eval('#gap-list .gap-kw', (e) => e.map((x) => x.textContent.trim()));
    t.check('the missing versions are named', ['soc1', 'type1', 'tls1'].every((k) => kws.includes(k)), JSON.stringify(kws));
    t.check('an accented word is a whole word (Zürich does not match "rich text")', flagged.includes('Z1') && kws.includes('zürich'), JSON.stringify(kws));
    t.check('Japanese text is matched', !flagged.includes('J1'), flagged.join(','));
    const rows = await app.ledger();
    t.check('the Japanese question cites the Japanese document', /jp\.txt/.test(rows[3].src), rows[3].src);
  });
};
