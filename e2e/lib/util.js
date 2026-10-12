'use strict';
/* Small node-side helpers: a hand-written PDF builder, a minimal ZIP reader (used to
   inspect the DOCX/XLSX the app exports without trusting the app's own libraries), an
   RFC 4180 CSV parser and a few odds and ends. No dependencies. */
const zlib = require('zlib');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- PDF ---------- */
/* One US-Letter page, Helvetica 12pt, one Tj per line so each line is a single text item
   for pdf.js. The xref table is computed from real byte offsets (ASCII only, so string
   length equals byte length). */
function makePdf(lines) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let stream = '';
  if (lines.length) {
    stream = 'BT\n/F1 12 Tf\n14 TL\n72 720 Td\n' + lines.map((l) => `(${esc(l)}) Tj\nT*`).join('\n') + '\nET';
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objs.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ---------- ZIP (read only) ---------- */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    files.set(name, method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nlen + elen + clen;
  }
  return files;
}

/* ---------- CSV (RFC 4180) ---------- */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* swallowed, LF ends the row */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const randKey = (prefix) => prefix + crypto.randomBytes(9).toString('hex');

function file(name, mimeType, buffer) {
  return { name, mimeType, buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) };
}

module.exports = { sleep, makePdf, unzip, parseCsv, randKey, file };
