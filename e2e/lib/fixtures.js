'use strict';
/* Fixtures are generated at run time. PDF, CSV and text are written here; DOCX and XLSX are
   built inside the helper page with the real docx / SheetJS libraries. Nothing is
   committed as a binary. */
const { makePdf, file } = require('./util');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* Sentinels: a unique token per format, found in the parsed text if, and only if, that
   format's parser really ran. */
const SENT = {
  txt: 'KBTXT-SENTINEL Zyphron attestation is performed quarterly by Orbital Assurance Labs',
  md: 'KBMD-SENTINEL Quillfeather replication keeps three regional mirrors synchronized',
  pdf: 'KBPDF-SENTINEL Marlowe retention schedule keeps audit evidence for seven years',
  docx: 'KBDOCX-SENTINEL Tessellate onboarding completes within ten business days',
  xlsx: 'KBXLSX-SENTINEL Halcyon uptime commitment',
  csv: 'KBCSV-SENTINEL',
  unicode: 'Zürich',
};

/* RFP questions used by the spreadsheet fixtures. */
const XLSX_RFP_ROWS = [
  ['1.1', 'Do you encrypt customer data at rest?'],
  ['1.2', 'Describe your disaster recovery architecture and failover testing.'],
  ['TBD', 'N/A'],                                     // spacer row: too short to import
  ['2.1', 'Provide your pricing model for enterprise licences.'],
  ['2.2', 'Explain how Zyphron attestation is performed and by whom.'],
];

async function build(lib) {
  const F = {};
  F.kbTxt = file('kb-security.txt', 'text/plain',
    `${SENT.txt} using hardware-backed key ceremonies. Our ${SENT.unicode} data centre hosts the primary region. Access reviews for privileged accounts run monthly.\n`);
  F.kbMd = file('kb-architecture.md', 'text/markdown',
    `# Architecture\n\n${SENT.md} within ninety seconds. Disaster recovery uses warm standby with a four hour recovery time objective.\n`);
  F.kbPdf = file('kb-retention.pdf', 'application/pdf', makePdf([
    SENT.pdf + '.',
    'Backup encryption uses AES-256 with customer-managed keys.',
  ]));
  F.kbDocx = file('kb-onboarding.docx', DOCX_MIME, Buffer.from(await lib.evaluate(
    (p) => window.E2E.makeDocx(p),
    [SENT.docx + '.', 'Customer success managers run weekly check-ins during onboarding.']), 'base64'));
  F.kbXlsx = file('kb-sla.xlsx', XLSX_MIME, Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s),
    [
      { name: 'Overview', aoa: [['Metric', 'Value'], [SENT.xlsx, '99.95 percent']] },
      { name: 'Support', aoa: [['Tier', 'Response'], ['Gold', 'one hour']] },
    ]), 'base64'));
  F.kbCsv = file('kb-escalation.csv', 'text/csv',
    `${SENT.csv},Brindle escalation path,Tier 3\nsecond,row,here\n`);

  /* RFP fixtures ------------------------------------------------------------------ */
  F.rfpPdf = file('acme-rfp.pdf', 'application/pdf', makePdf([
    'PDFRFP-SENTINEL Acme Corp Request for Proposal 2026-014',
    '3.1 Do you encrypt customer data at rest and in transit?',
    '3.2 Describe your incident response process and notification times.',
    '3.3 Provide your pricing model and contract term options.',
  ]));
  F.rfpDocx = file('acme-rfp.docx', DOCX_MIME, Buffer.from(await lib.evaluate(
    (p) => window.E2E.makeDocx(p),
    ['DOCXRFP-SENTINEL Northwind Tender Reference 77',
      '4.1 Do you hold a current SOC 2 Type II report?',
      '4.2 Describe how tenant data is isolated.']), 'base64'));
  F.rfpCsv = file('security-questionnaire.csv', 'text/csv',
    'Ref,Question,Response\n' +
    '1,"Do you support SSO, SAML and SCIM provisioning?",\n' +
    '2,"Describe your backup and recovery procedures for customer data.",\n' +
    '3,"Provide your standard licence and pricing structure.",\n');

  /* Title block of three single-cell rows above the header, then a blank-ish spacer row
     inside the table. The table does NOT start at A1. A second sheet exists so sheet
     auto-selection is exercised. */
  const titleBlock = [
    ['Acme Corp Security Questionnaire 2026'],
    ['Issued 1 September 2026'],
    ['Return completed responses by 30 September 2026'],
  ];
  const table = [['Ref', 'Question', 'Response'], ...XLSX_RFP_ROWS.map((r) => [r[0], r[1], null])];
  F.rfpXlsxTitle = file('acme-questionnaire.xlsx', XLSX_MIME, Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s),
    [
      { name: 'Instructions', aoa: [['Read the instructions before answering.']] },
      { name: 'Questionnaire', aoa: [...titleBlock, ...table] },
    ]), 'base64'));
  /* Same questionnaire but the whole block (title, header, rows) sits at column C. */
  F.rfpXlsxOffset = file('offset-questionnaire.xlsx', XLSX_MIME, Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s),
    [{ name: 'Questionnaire', origin: 'C1', aoa: [...titleBlock, ...table] }]), 'base64'));
  /* Legacy binary .xls (BIFF8): the file pickers accept it, so both paths are exercised. */
  F.kbXls = file('kb-legacy.xls', 'application/vnd.ms-excel', Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s, 'xls'),
    [{ name: 'Ledger', aoa: [['Item', 'Note'], ['KBXLS-SENTINEL Pemberton legacy ledger', 'archived']] }]), 'base64'));
  F.rfpXls = file('legacy-questionnaire.xls', 'application/vnd.ms-excel', Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s, 'xls'),
    [{ name: 'Questionnaire', aoa: [...titleBlock, ...table] }]), 'base64'));
  /* The sheet's used range itself starts at C4 (no cells above the header, e.g. the title block
     is an image or header/footer): !ref is "C4:E9", so any code that re-bases rows and columns
     onto the used range is off by 3 rows and 2 columns. This is the layout a past bug broke. */
  F.rfpXlsxRefAtC4 = file('ref-at-c4.xlsx', XLSX_MIME, Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s),
    [{ name: 'Questionnaire', origin: 'C4', ref: 'C4:E9', aoa: table }]), 'base64'));
  /* An issuer's template that is already partly filled: the response column (C) holds last
     year's answer in row 4 and a formula in row 5, carries a note in C3, and sits beside an
     "Answered (Y/N)" flag column and a "Supplier comments" column of formulas, both of which
     a header-keyword guess would pick. A merged title, column widths and comments must
     survive the round trip. */
  F.rfpXlsxFilled = file('filled-template.xlsx', XLSX_MIME, Buffer.from(await lib.evaluate(
    (s) => window.E2E.makeXlsx(s),
    [{
      name: 'Questionnaire',
      aoa: [
        ['Globex vendor questionnaire'],
        ['Ref', 'Question', 'Response', 'Answered (Y/N)', 'Supplier comments'],
        ['1', 'Do you encrypt customer data at rest?', null, 'N'],
        ['2', 'Describe your incident response process.', 'Our 2025 answer: see the attached plan.', 'N'],
        ['3', 'Provide your pricing model and contract terms.', null, 'N'],
        ['4', 'Do you hold a current SOC 2 Type II report?', null, 'N'],
      ],
      formulas: { C5: 'IF(D5="Y","See price list","")', E3: 'IF(D3="Y","ok","")', E4: 'IF(D4="Y","ok","")', E5: 'IF(D5="Y","ok","")', E6: 'IF(D6="Y","ok","")' },
      comments: { C3: 'Max 200 words', B4: 'Include notification times' },
      merges: ['A1:E1'],
      cols: [6, 48, 60, 14, 24],
    }]), 'base64'));
  return F;
}

module.exports = { build, SENT, XLSX_RFP_ROWS, DOCX_MIME, XLSX_MIME };
