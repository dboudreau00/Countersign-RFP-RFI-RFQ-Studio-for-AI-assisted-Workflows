/* List em/en dashes that sit outside code comments, with line numbers.
   usage: node dashes.js <file> [--all]   (--all also lists the ones inside comments) */
const fs = require("fs");
const file = process.argv[2];
const all = process.argv.includes("--all");
const src = fs.readFileSync(file, "utf8");
const EM = String.fromCharCode(8212), EN = String.fromCharCode(8211);
const isCode = /\.(js|php|html)$/i.test(file);
const commentMask = new Uint8Array(src.length);
if (isCode) {
  // mark // line comments, /* */ block comments and <!-- --> in a simple scanner that
  // respects string and template literals and regex-ish contexts well enough for this file
  let i = 0, mode = null, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === "line") { commentMask[i] = 1; if (c === "\n") mode = null; i++; continue; }
    if (mode === "block") { commentMask[i] = 1; if (c === "*" && n === "/") { commentMask[i + 1] = 1; i += 2; mode = null; continue; } i++; continue; }
    if (mode === "html") { commentMask[i] = 1; if (src.startsWith("-->", i)) { commentMask[i + 1] = commentMask[i + 2] = 1; i += 3; mode = null; continue; } i++; continue; }
    if (mode === "str") { if (c === "\\") { i += 2; continue; } if (c === q) mode = null; else if (c === "\n" && q !== "`") mode = null; i++; continue; }
    if (src.startsWith("<!--", i)) { mode = "html"; continue; }
    if (c === "/" && n === "/" && src[i - 1] !== ":" && src[i - 1] !== "\\") { mode = "line"; continue; }
    if (c === "/" && n === "*") { mode = "block"; continue; }
    if (c === "#" && /\.php$/i.test(file) && (i === 0 || src[i - 1] === "\n" || src[i - 1] === " ")) { mode = "line"; continue; }
    if (c === '"' || c === "'" || c === "`") { mode = "str"; q = c; i++; continue; }
    i++;
  }
}
let lineNo = 1, lineStart = 0, count = 0, inComment = 0;
for (let i = 0; i < src.length; i++) {
  if (src[i] === "\n") { lineNo++; lineStart = i + 1; continue; }
  if (src[i] !== EM && src[i] !== EN) continue;
  if (commentMask[i]) { inComment++; if (!all) continue; }
  count++;
  const lineEnd = src.indexOf("\n", i);
  const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
  const col = i - lineStart;
  const ctx = line.slice(Math.max(0, col - 70), col + 70).replace(/\t/g, " ");
  console.log(`${lineNo}:${col}${commentMask[i] ? " [comment]" : ""} ${src[i] === EM ? "EM" : "EN"}  ${ctx}`);
}
console.log(`-- ${count} listed, ${inComment} inside comments${all ? "" : " (not listed)"}`);
