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
    const gap = await app.gaps();
    const flagged = gap.refs;
    t.check('the documented versions are not a gap', !flagged.includes('V1'), flagged.join(','));
    t.check('undocumented versions are a gap', flagged.includes('V2'), flagged.join(','));
    const kws = gap.topics;
    t.check('the missing versions are named', ['soc1', 'type1', 'tls1'].every((k) => kws.includes(k)), JSON.stringify(kws));
    t.check('an accented word is a whole word (Zürich does not match "rich text")', flagged.includes('Z1') && kws.includes('zürich'), JSON.stringify(kws));
    t.check('Japanese text is matched', !flagged.includes('J1'), flagged.join(','));
    const rows = await app.ledger();
    t.check('the Japanese question cites the Japanese document', /jp\.txt/.test(rows[3].src), rows[3].src);
  });

  test('retrieval.acronyms-find-spelled-out-documents', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({
      docs: [
        doc('bcdr.txt', 'Disaster recovery runs from a warm standby, tested twice a year.'),
        doc('identity.txt', 'Single sign-on uses SAML 2.0. Multi-factor authentication is enforced for every account.'),
        doc('network.txt', 'The edge firewall will drop packets from unknown networks.'),
      ],
      questions: [q('A1', 'Describe your DR approach.'), q('A2', 'Is SSO enforced?'), q('A3', 'Is MFA enforced?'), q('A4', 'Describe your SBOM process.')],
    });
    await app.goPage('workspace');
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    const gap = await app.gaps();
    t.check('"SSO" is covered by a document that says "single sign-on"', !gap.refs.includes('A2'), gap.refs.join(','));
    t.check('"MFA" is covered by a document that says "multi-factor authentication"', !gap.refs.includes('A3'), gap.refs.join(','));
    t.check('an acronym nobody wrote down is still a gap', gap.refs.includes('A4'), gap.refs.join(','));
    const rows = await app.ledger();
    t.match('a two-letter acronym ("DR") finds the disaster recovery document', rows[0].src, /bcdr\.txt/);
    t.check('"dr" is a whole word: it does not cite a document about dropping packets', !/network\.txt/.test(rows[0].src), rows[0].src);
    t.match('the SSO question cites the identity document', rows[1].src, /identity\.txt/);
  });
};
