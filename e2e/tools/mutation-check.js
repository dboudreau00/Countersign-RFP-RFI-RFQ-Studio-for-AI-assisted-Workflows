#!/usr/bin/env node
'use strict';
/*
  Harness self-check: proves the e2e checks are not vacuous. For each mutation it copies
  --root to a temp directory, breaks index.html in one specific way, runs the relevant subset
  of the harness and requires that subset to FAIL. The original --root is never touched.

    node tools/mutation-check.js [--root <dir>]      (defaults to the repository)
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const at = process.argv.indexOf('--root');
const root = path.resolve(at > 1 && process.argv[at + 1] ? process.argv[at + 1] : path.join(__dirname, '..', '..'));
const run = path.join(__dirname, '..', 'run.js');

const MUTATIONS = [
  { name: 'empty completions are stamped Generated again', only: 'gen.empty-response.claude-key',
    from: 'if(!answer) throw new Error("the provider returned an empty response");', to: '' },
  { name: 'stored XSS: question id is no longer escaped', only: 'xss.imported-workspace',
    from: 'const id = esc(q.id), type = safeType(q.type)', to: 'const id = q.id, type = safeType(q.type)' },
  { name: 'stored XSS: question text is no longer escaped', only: 'xss.imported-workspace',
    from: '<div class="q-text">${esc(q.text)}', to: '<div class="q-text">${q.text}' },
  { name: 'round trip reads the sheet from its used range instead of A1', only: 'used-range-not-at-A1',
    from: "XLSX.utils.sheet_to_json(ws, { header: 1, defval: \"\", range: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: b.e }) })", to: "XLSX.utils.sheet_to_json(ws, { header: 1, defval: \"\" })" },
  { name: 'Gemini key goes back into the URL', only: 'gen.gemini',
    from: ':generateContent`, {', to: ':generateContent?key=${encodeURIComponent(p.key)}`, {' },
  { name: 'Anthropic body gains temperature', only: 'gen.claude-key.request-shape',
    from: "max_tokens: byKey ? claudeTokens(maxTokens) : maxTokens,\n        messages: [{ role: \"user\", content: prompt }]", to: "max_tokens: byKey ? claudeTokens(maxTokens) : maxTokens, temperature: 0.2,\n        messages: [{ role: \"user\", content: prompt }]" },
  { name: 'DOCX export keeps raw ** markers', only: 'export.docx',
    from: '.replace(/\\n/g, " ")\n    .replace(/[ \\t]{2,}/g, " ")\n    .trim();\n  const runs = [];', to: '.replace(/\\n/g, " ")\n    .trim();\n  return [new D.TextRun({ text: text })];\n  const runs = [];' },
  { name: 'DOCX-library-missing warning removed from boot', only: 'degrade.jsdelivr-blocked',
    from: 'if (typeof docx === "undefined") MISSING_LIBS.push("DOCX export (docx)");', to: '' },
  { name: 'CSV quoting broken (embedded quotes not doubled)', only: 'export.csv',
    from: ".replace(/\"/g,'\"\"') + '\"';", to: " + '\"';" },
  { name: 'gap sheet no longer written to the XLSX export', only: 'export.xlsx',
    from: 'if(withGaps && gaps.length){\n      const gws', to: 'if(false){\n      const gws' },
  { name: 'phantom citations kept after a document is deleted', only: 'gen.gap-run-drops',
    from: 'else q.sources = (q.sources || []).filter(s => inBucket.has(s));', to: '' },
  { name: 'workspace export leaks the API key', only: 'sec.api-key-is-session-only',
    from: 'settings: { ...S.settings, key: "" } };', to: 'settings: { ...S.settings } };' },
  { name: 'page throws on load (missing element)', only: 'load.boot',
    from: '$("ver").textContent = "v" + APP_VERSION;', to: '$("ver").textContent = "v" + APP_VERSION; nope.boom();' },
  { name: 'retry on 429 removed', only: 'gen.retry-on-429',
    from: 'if(!err || !err.retryable) throw err;', to: 'throw err;' },
  { name: 'CSV export drops the UTF-8 BOM', only: 'export.csv',
    from: 'new Blob(["\\uFEFF" + csv]', to: 'new Blob([csv]' },
];

const only = process.argv.includes('--mutation') ? process.argv[process.argv.indexOf('--mutation') + 1] : '';
let bad = 0;
for (const m of MUTATIONS.filter((x) => !only || x.name.includes(only))) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mut-'));
  // the harness itself (and its node_modules) stays where it is: only the app is copied
  const harness = path.resolve(__dirname, '..');
  fs.cpSync(root, tmp, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) && !path.resolve(s).startsWith(harness) });
  const file = path.join(tmp, 'index.html');
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(m.from)) { bad++; console.log(`STALE ${m.name}: pattern not found in index.html (the code changed; update the mutation)`); fs.rmSync(tmp, { recursive: true, force: true }); continue; }
  fs.writeFileSync(file, src.replace(m.from, m.to));
  const r = spawnSync(process.execPath, [run, '--root', tmp, '--only', m.only, '--jobs', '1'], { encoding: 'utf8', timeout: 240000 });
  const failed = /^FAIL /m.test(r.stdout || '');
  console.log(`${failed ? 'CAUGHT' : 'MISSED'} ${m.name}  [--only ${m.only}]`);
  if (!failed) { bad++; console.log((r.stdout || '').split('\n').slice(0, 12).join('\n')); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(bad ? `${bad} mutation(s) not caught or stale` : 'all mutations caught');
process.exit(bad ? 1 : 0);
