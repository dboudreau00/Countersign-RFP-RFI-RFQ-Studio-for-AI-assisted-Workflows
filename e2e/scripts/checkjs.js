/* Compile every inline <script> in an HTML file with vm.Script, and report raw control
   characters (a literal NUL or similar written by an editor kills the whole script). */
const fs = require("fs");
const vm = require("vm");
const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
let bad = 0, n = 0;
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html))) {
  n++;
  const attrs = m[1], code = m[2];
  const line = html.slice(0, m.index).split("\n").length;
  if (/type\s*=\s*["']?module/i.test(attrs)) {
    try { new vm.SourceTextModule ? new vm.SourceTextModule(code) : null; console.log(`module script at line ${line}: not compiled (needs --experimental-vm-modules)`); }
    catch (e) { console.log(`module script at line ${line}: ${e.message}`); }
    continue;
  }
  if (/type\s*=\s*["']?(importmap|application\/json)/i.test(attrs)) {
    try { JSON.parse(code); console.log(`json script at line ${line}: ok`); } catch (e) { bad++; console.log(`json script at line ${line}: ${e.message}`); }
    continue;
  }
  try { new vm.Script(code, { filename: `inline@${line}` }); console.log(`script at line ${line}: ok (${code.length} chars)`); }
  catch (e) { bad++; console.log(`script at line ${line}: SYNTAX ERROR ${e.message}`); }
}
let ctrl = 0;
for (let i = 0; i < html.length; i++) { const c = html.charCodeAt(i); if (c < 32 && c !== 9 && c !== 10 && c !== 13) ctrl++; }
if (ctrl) { bad++; console.log(`raw control characters: ${ctrl}`); }
console.log(bad ? `FAIL (${bad})` : `ok: ${n} script blocks`);
process.exit(bad ? 1 : 0);
