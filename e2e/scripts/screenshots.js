#!/usr/bin/env node
'use strict';
/*
  README screenshots. Drives the real index.html in headless Chromium through the same
  steps a person takes: a made-up vendor's knowledge base is imported, the issuer's
  questionnaire is loaded as a spreadsheet and mapped, eight answers are drafted and three
  approved. The model is mocked; retrieval, coverage and citations are the app's own.

    node scripts/screenshots.js [--out <dir>] [--root <dir>]

  --out defaults to docs/screenshots in the repository. Every name below is invented.
*/
const fs = require('fs');
const path = require('path');
const { startServer } = require('../lib/server');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 1 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('--root', path.join(__dirname, '..', '..')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs', 'screenshots')));
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const DOCS = [
  ['Information Security Policy v4.2.pdf', 831488, 5, `Ferrowyn Information Security Policy, version 4.2.
6.2 Encryption. Customer data at rest is encrypted with AES-256. Key material is held in a managed key service and rotated annually. Data in transit is protected with TLS 1.2 or higher on every public and internal endpoint; legacy protocols and weak cipher suites are disabled at the load balancer. Backups inherit the same encryption.
7.1 Access control. Production access requires multi-factor authentication and is reviewed every quarter. Privileged sessions are recorded.
9.4 External penetration testing is conducted annually by an accredited third party, and after any major architectural change. Executive summaries are shared with customers under NDA through the trust portal.
9.6 Vulnerability management. Findings are triaged within one business day. Patching targets: critical within 7 days, high within 30 days, medium within 90 days.
11.2 Incident response. A named incident commander runs every severity 1 event through detection, triage, containment, eradication and recovery. Affected customers are notified within 48 hours of confirming an incident that involves their data, followed by a written root-cause report.`],
  ['SOC 2 Type II Report 2026.pdf', 2411724, 5, `Independent service auditor's report on controls relevant to security, availability and confidentiality.
Ferrowyn's SOC 2 Type II examination covers the period 1 January 2025 to 31 December 2025. The report was issued with no exceptions noted.
The full report is available to customers and prospects under NDA. A bridge letter covering the period since the report end date is available on request.
Controls tested include logical access, change management, encryption of data at rest and in transit, vulnerability management, incident response and vendor management.`],
  ['Platform Architecture Overview.docx', 499712, 5, `Platform Architecture Overview.
Hosting and regions. The platform runs in two regions: United States (Virginia) and European Union (Frankfurt). Customers choose their data residency region at onboarding, on every plan. Customer data, backups and logs stay in the chosen region.
Identity. SAML 2.0 single sign-on works with any standards-compliant identity provider. SCIM 2.0 provisioning and de-provisioning is available for Enterprise tenants, including group-to-role mapping.
Network. All service-to-service traffic uses TLS 1.2 or higher. Tenants are isolated at the application and database layers.`],
  ['Data Processing Addendum.docx', 200704, 6, `Data Processing Addendum.
Ferrowyn processes customer personal data only on documented instructions from the customer, in line with GDPR Article 28.
Retention and deletion. At contract termination customers can export their data for 30 days. Customer data is then deleted from production systems within 30 days, and from backups within 90 days. A deletion certificate is available on request.
Sub-processors. Ferrowyn maintains a public list of sub-processors and gives customers 30 days' notice before adding one.`],
  ['Business Continuity and DR Plan.pdf', 655360, 6, `Business Continuity and Disaster Recovery Plan.
Recovery objectives: recovery point objective (RPO) of 1 hour and recovery time objective (RTO) of 4 hours.
The platform runs a warm standby in a second availability zone of each region. Disaster recovery tests run twice a year and results are reviewed by the security committee.`],
  ['Prior RFP - Larkspur Health 2025.xlsx', 350208, 9, `## Sheet: Responses
Ref,Question,Response
41,Can penetration test results be shared?,Pen test executive summary shared under mutual NDA on request.
52,Do you sign a Business Associate Agreement?,Yes. We sign Business Associate Agreements for HIPAA workloads on the Enterprise plan.
58,Where is customer data hosted?,United States (Virginia) or European Union (Frankfurt) at the customer's choice.`],
  ['Service Level Agreement.md', 38912, 9, `# Service Level Agreement
## Availability
Ferrowyn commits to 99.95% monthly uptime for the production service.
## Service credits
Below 99.95% the customer receives a 10% service credit; below 99.0% a 25% service credit.
## Support
Severity 1 issues receive a response within 1 hour, around the clock.`],
  ['Sub-processor List.csv', 9216, 11, `Sub-processor,Purpose,Location
Stratacore Cloud,Infrastructure hosting,United States and European Union
Mailvane,Transactional email delivery,United States
Helpwick,Customer support desk,European Union`],
].map(([name, size, age, text]) => ({ id: 'demo-' + name.replace(/\W+/g, '-'), name, type: name.split('.').pop(), size, chars: text.length, text, added: daysAgo(age) }));

const RFP = [
  ['1.1', 'Describe how customer data is encrypted at rest and in transit.'],
  ['1.2', 'Do you support SAML 2.0 single sign-on and SCIM user provisioning?'],
  ['1.3', 'How frequently are third-party penetration tests performed, and can results be shared under NDA?'],
  ['1.4', 'Describe your vulnerability management and patching SLAs by severity.'],
  ['2.1', 'Provide your current SOC 2 Type II report or bridge letter.'],
  ['2.2', 'Are you FedRAMP authorized? If not, describe your roadmap.'],
  ['2.3', 'Do you sign Business Associate Agreements (BAAs) for HIPAA-covered data?'],
  ['3.1', 'In which regions is customer data stored, and can customers choose data residency?'],
  ['3.2', 'Describe your data retention and deletion process at contract termination.'],
  ['3.3', 'Describe your controls for processing payment card data under PCI DSS.'],
  ['4.1', 'Describe your incident response process and customer notification timelines.'],
  ['4.2', 'What uptime do you commit to, and what service credits apply?'],
];
const ANSWERS = {
  '1.1': 'All customer data is encrypted at rest with AES-256, using keys held in a managed key service and rotated every year. Data in transit is protected with TLS 1.2 or higher on every public and internal endpoint, and legacy protocols and weak cipher suites are disabled. Backups inherit the same encryption.',
  '1.2': 'Yes. Ferrowyn supports SAML 2.0 single sign-on with any standards-compliant identity provider. SCIM 2.0 provisioning and de-provisioning is available on the Enterprise plan, including group-to-role mapping.',
  '1.3': 'An independent CREST-accredited firm performs a full application and infrastructure penetration test at least once a year and after any major architectural change. An executive summary of the most recent test is available to customers and prospects under NDA through our trust portal.',
  '2.1': 'Yes. Our SOC 2 Type II report covers 1 January to 31 December 2025 and was issued with no exceptions. We share the full report under NDA, and a bridge letter covering the period since is available on request.',
  '2.2': 'Ferrowyn is not FedRAMP authorized today. We can confirm our plans for US public-sector hosting on request.',
  '3.1': 'Customer data is stored in the region the customer selects at onboarding: United States (Virginia) or European Union (Frankfurt). Data, backups and logs stay in that region, and customers on every plan can choose their residency.',
  '3.3': 'Ferrowyn does not store, process or transmit payment card data, so PCI DSS does not apply to the platform. Subscription payments are handled by our billing provider.',
  '4.1': 'A named incident commander runs every severity 1 event through detection, triage, containment, eradication and recovery. We notify affected customers within 48 hours of confirming an incident that involves their data, followed by a written root-cause report.',
};
const DRAFT = ['1.1', '1.2', '1.3', '2.1', '2.2', '3.1', '3.3', '4.1'];
const APPROVE = ['1.1', '2.1', '4.1'];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await startServer({ root: ROOT, harnessDir: path.join(__dirname, '..'), port: 18849 });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await ctx.route('https://api.anthropic.com/**', (route) => {
    const prompt = (JSON.parse(route.request().postData() || '{}').messages || [{}])[0].content || '';
    const ref = (/RFP QUESTION \(([^)]*)\)/.exec(prompt) || [])[1];
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: ANSWERS[ref] || 'Answer.' }], stop_reason: 'end_turn' }) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(srv.origin + '/index.html', { waitUntil: 'load' });
  await page.addStyleTag({ content: '#toast{display:none!important}' });
  await page.waitForFunction(() => /of \d+ sources/.test(document.getElementById('doc-count').textContent));

  // the knowledge base, through the real import control
  const ws = { app: 'countersign', version: 2, docs: DOCS, questions: [], meta: { title: 'Halvorsen Freight Security Review' } };
  await page.setInputFiles('#ws-import-input', { name: 'countersign-data.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(ws)) });
  await page.waitForFunction((n) => document.querySelectorAll('#doc-list tbody tr').length === n, DOCS.length);

  // the issuer's questionnaire, built as a real workbook and mapped through the intake
  await page.click('#nav-workspace');
  const b64 = await page.evaluate((rows) => {
    const aoa = [['Halvorsen Freight · Vendor Security Questionnaire 2026'], [], ['Ref', 'Question', 'Vendor Response'], ...rows.map((r) => [r[0], r[1], ''])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Questionnaire');
    return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  }, RFP);
  await page.setInputFiles('#rfp-file-input', { name: 'Halvorsen_Vendor_Security_Questionnaire.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(b64, 'base64') });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('sheet-map')).display !== 'none');
  await page.click('#map-import');
  await page.waitForFunction((n) => document.querySelectorAll('#ledger [data-qid]').length === n, RFP.length);

  const item = (ref) => page.locator('#ledger .q-item', { has: page.locator('.q-num', { hasText: new RegExp('^' + ref.replace('.', '\\.') + '$') }) });
  for (const ref of DRAFT) {
    await item(ref).click();
    await page.click('#answer-panel [data-gen]');
    await page.waitForFunction(() => document.getElementById('ledger').getAttribute('aria-busy') !== 'true' && !!document.querySelector('#answer-panel [data-ans]'));
  }
  for (const ref of APPROVE) {
    await item(ref).click();
    await page.click('#answer-panel [data-approve]');
  }
  await item('1.3').click();
  await page.evaluate(() => { document.getElementById('q-scroll').scrollTop = 0; document.activeElement.blur(); });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'responses.png') });

  await page.click('#nav-bucket');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'knowledge-base.png') });

  await page.click('#nav-export');
  await page.click('.fmt-card[data-fmt="roundtrip"]');
  await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'export.png') });

  // exactly as tall as the sheet's content, so the shot shows every section and no more
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  const sheetHeight = await page.evaluate(() => Math.ceil(document.querySelector('.sheet-head').offsetHeight +
    [...document.querySelector('.sheet-body').children].reduce((a, c) => a + c.offsetHeight, 0)));
  await page.setViewportSize({ width: 1280, height: sheetHeight });
  await page.waitForTimeout(200);
  await page.locator('#settings-dialog').screenshot({ path: path.join(OUT, 'settings.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 832 });

  await page.click('#theme-toggle');
  await page.click('#nav-workspace');
  await item('1.3').click();
  await page.evaluate(() => { document.getElementById('q-scroll').scrollTop = 0; document.activeElement.blur(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'responses-dark.png') });

  await browser.close();
  srv.server.close();
  for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.png'))) console.log(path.join(OUT, f), fs.statSync(path.join(OUT, f)).size, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
