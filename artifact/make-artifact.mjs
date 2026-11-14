// Builds the Claude artifact edition of Countersign from the repository's index.html.
//
//   node artifact/make-artifact.mjs [path/to/index.html]
//
// Every patch must match its target exactly once, so an upstream change that moves the
// code stops the build instead of producing a half-patched page. The libraries the page
// needs are downloaded once, from the URLs index.html pins, into artifact/vendor, and
// must match the SRI hashes it pins. Output: artifact/dist, the page and its vendor/
// files (publish them together).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const srcPath = process.argv[2] || join(here, "..", "index.html");
let html = readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n");

const fail = (msg) => { console.error("make-artifact: " + msg); process.exit(1); };
const shown = (p) => relative(process.cwd(), p) || p;
function patch(name, find, replace, count = 1){
  const n = html.split(find).length - 1;
  if(n !== count) fail(`patch "${name}" matched ${n} times, expected ${count}`);
  html = html.split(find).join(replace);
}

/* The artifact publisher refuses text files that contain terminal control characters or
   the replacement character U+FFFD, and SheetJS and the pdf.js worker keep both (ESC, C1,
   U+FFFD for unmapped codepage slots) inside string literals for their codepage and font
   tables. Every control and non-ASCII character inside a literal or comment is rewritten
   as its \uXXXX escape, which JavaScript reads as the same character. A small lexer finds
   the literal each one sits in; a control character anywhere else stops the build, and
   every rewritten string literal must evaluate to exactly what the original did. */
const isCtrl = (c) => (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 || (c >= 0x80 && c <= 0x9f);
// characters a text check reads as damage or as hidden text: replacement char, BOM,
// zero-width and bidi controls, line and paragraph separators
const isSuspect = (c) => isCtrl(c) || c === 0xFFFD || c === 0xFEFF || (c >= 0x200B && c <= 0x200F) ||
  (c >= 0x2028 && c <= 0x202E) || c === 0x2060 || (c >= 0x2066 && c <= 0x2069);
function escapeControls(src, name){
  const esc = (c) => "\\u" + c.toString(16).padStart(4, "0");
  const escapeIt = (c) => isCtrl(c) || c > 0x7e;
  const KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
  const n = src.length, changed = [];
  let out = "", i = 0, prev = "start", depth = 0, replaced = 0;
  const stack = [];   // brace depth at each open template ${
  // copies one literal from `start` (a quote, a backtick, a template's closing } or a /),
  // escaping control characters; a template stops early at ${
  function literal(start, kind){
    const quote = src[start];
    let j = start + 1, text = quote, had = false, inClass = false;
    for(;;){
      if(j >= n) fail(`${name}: ${kind} at ${start} runs off the end`);
      const ch = src[j], c = src.charCodeAt(j);
      if(ch === "\\"){
        const nc = src.charCodeAt(j + 1);
        if(escapeIt(nc)){ text += esc(nc); had = true; replaced++; j += 2; continue; }   // identity escape
        text += ch + src[j + 1]; j += 2; continue;
      }
      if(escapeIt(c)){ text += esc(c); had = true; replaced++; j++; continue; }
      if(kind === "regex"){
        if(ch === "\n") fail(`${name}: line break in a regex at ${start}`);
        if(ch === "[") inClass = true;
        else if(ch === "]") inClass = false;
        else if(ch === "/" && !inClass){
          text += ch; j++;
          while(j < n && /[a-z]/i.test(src[j])) text += src[j++];
          break;
        }
      } else if(kind === "template"){
        if(ch === "`"){ text += ch; j++; break; }
        if(ch === "$" && src[j + 1] === "{"){ text += "${"; j += 2; return { end: j, text, had, open: true }; }
      } else {
        if(ch === quote){ text += ch; j++; break; }
        if(ch === "\n") fail(`${name}: line break in a string at ${start}`);
      }
      text += ch; j++;
    }
    return { end: j, text, had, open: false };
  }
  const take = (r, kind, start) => {
    if(r.had) changed.push({ kind, orig: src.slice(start, r.end), text: r.text, at: start });
    out += r.text; i = r.end;
  };
  const copyComment = (end) => {
    for(let k = i; k < end; k++){ const cc = src.charCodeAt(k); if(escapeIt(cc)){ out += esc(cc); replaced++; } else out += src[k]; }
    i = end;
  };
  while(i < n){
    const ch = src[i], c = src.charCodeAt(i);
    if(ch === "/" && src[i + 1] === "/"){ const e = src.indexOf("\n", i); copyComment(e < 0 ? n : e); continue; }
    if(ch === "/" && src[i + 1] === "*"){
      const e = src.indexOf("*/", i + 2);
      if(e < 0) fail(`${name}: unterminated comment at ${i}`);
      copyComment(e + 2); continue;
    }
    if(ch === '"' || ch === "'"){ const s = i; take(literal(i, "string"), "string", s); prev = "lit"; continue; }
    if(ch === "`"){
      // a tag (String.raw, a function call) reads the raw text, so only untagged templates may change
      const tagged = prev === "ident" || prev === "close" || prev === "lit";
      const s = i, r = literal(i, "template"); take(r, tagged ? "tagged" : "template", s);
      if(r.open) stack.push({ depth, tagged });
      prev = r.open ? "punct" : "lit"; continue;   // after ${ an expression starts
    }
    if(ch === "/"){
      if(prev === "start" || prev === "punct" || prev === "kw"){ const s = i; take(literal(i, "regex"), "regex", s); prev = "lit"; continue; }
      out += ch; i++; prev = "punct"; continue;   // division: an operand follows
    }
    if(ch === "{"){ depth++; out += ch; i++; prev = "punct"; continue; }
    if(ch === "}"){
      if(stack.length && stack[stack.length - 1].depth === depth){
        const { tagged } = stack.pop();
        const s = i, r = literal(i, "template"); take(r, tagged ? "tagged" : "template", s);
        if(r.open) stack.push({ depth, tagged });
        prev = r.open ? "punct" : "lit"; continue;
      }
      depth--; out += ch; i++; prev = "punct"; continue;
    }
    if(ch === ")" || ch === "]"){ out += ch; i++; prev = "close"; continue; }
    if(/[A-Za-z_$]/.test(ch) || c > 0x9f){
      let k = i; while(k < n && (/[A-Za-z0-9_$]/.test(src[k]) || src.charCodeAt(k) > 0x9f)) k++;
      const word = src.slice(i, k); out += word; i = k; prev = KW.has(word) ? "kw" : "ident"; continue;
    }
    if(/[0-9]/.test(ch)){
      let k = i; while(k < n && /[0-9A-Za-z_.]/.test(src[k])) k++;
      out += src.slice(i, k); i = k; prev = "num"; continue;
    }
    if(isCtrl(c)) fail(`${name}: control character U+${c.toString(16)} outside a literal at ${i}`);
    out += ch; i++;
    if(!/\s/.test(ch)) prev = "punct";
  }
  // every rewritten literal reads back as the original did
  for(const l of changed){
    if(l.kind === "tagged") fail(`${name}: escaped character in a tagged template at ${l.at}; check it by hand`);
    if(l.kind === "template"){
      // a chunk runs from ` or } to ${ or `: close it into a whole template and compare the strings
      const whole = (t) => "`" + t.replace(/^[`}]/, "").replace(/(\$\{|`)$/, "") + "`";
      if(vm.runInNewContext(whole(l.orig)) !== vm.runInNewContext(whole(l.text)))
        fail(`${name}: template at ${l.at} reads differently after escaping`);
    } else if(l.kind === "string"){
      const a = vm.runInNewContext("(" + l.orig + ")"), b = vm.runInNewContext("(" + l.text + ")");
      if(a !== b) fail(`${name}: string at ${l.at} reads differently after escaping`);
    } else {
      const a = vm.runInNewContext(l.orig), b = vm.runInNewContext(l.text);
      if(a.flags !== b.flags) fail(`${name}: regex at ${l.at} changed its flags`);
      // every BMP code unit, plus an astral character for patterns built from surrogates
      for(let cp = 0; cp <= 0xFFFF + 1; cp++){
        const t = cp > 0xFFFF ? String.fromCodePoint(0x1F600) : String.fromCharCode(cp);
        a.lastIndex = b.lastIndex = 0;
        if(a.test(t) !== b.test(t)) fail(`${name}: regex at ${l.at} matches U+${cp.toString(16)} differently after escaping`);
      }
    }
  }
  let left = 0; for(let k = 0; k < out.length; k++) if(isSuspect(out.charCodeAt(k))) left++;
  if(left) fail(`${name}: ${left} control or replacement characters left after escaping`);
  return { text: out, replaced, literals: changed.length };
}

// --- vendored libraries: the artifact frame loads scripts only from a few CDNs and blocks
// fetch() everywhere, so these are published next to the page, byte-identical to the pins
// apart from the control-character escapes above
const sri = (buf) => "sha384-" + createHash("sha384").update(buf).digest("base64");
const pinned = (re, what) => { const m = html.match(re); if(!m) fail("pin not found in index.html: " + what); return { url: m[1], want: m[2] }; };
const VENDOR = [
  ["vendor/xlsx/xlsx.full.min.js", pinned(/<script src="(https:\/\/cdn\.sheetjs\.com\/[^"]+\/xlsx\.full\.min\.js)" integrity="(sha384-[^"]+)"/, "SheetJS"), "script"],
  ["vendor/pdfjs/pdf.min.mjs", pinned(/lib: "(https:\/\/[^"]+\/pdf\.min\.mjs)",\s*libSri: "(sha384-[^"]+)"/, "pdf.js"), "module"],
  ["vendor/pdfjs/pdf.worker.min.mjs", pinned(/worker: "(https:\/\/[^"]+\/pdf\.worker\.min\.mjs)",\s*workerSri: "(sha384-[^"]+)"/, "pdf.js worker"), "module"],
];
// a copy already in artifact/vendor is used when it matches the pin; otherwise the pinned
// URL is fetched, and nothing is kept unless it matches
async function vendorBytes(file, { url, want }){
  const path = join(here, file);
  if(existsSync(path)){
    const bytes = readFileSync(path);
    if(sri(bytes) === want) return bytes;
    console.log(`make-artifact: ${shown(path)} does not match the pin, downloading it again`);
  }
  console.log("make-artifact: downloading " + url);
  let res;
  try{ res = await fetch(url, { signal: AbortSignal.timeout(120000) }); }
  catch(e){ fail(`couldn't download ${url} (${e.message}). Save it as ${shown(path)} and build again`); }
  if(!res.ok) fail(`${url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if(sri(bytes) !== want) fail(`${url} is ${sri(bytes)}, index.html pins ${want}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}
const shipped = {};
for(const [file, pin, type] of VENDOR){
  const bytes = await vendorBytes(file, pin);
  const text = bytes.toString("utf8");
  if(!Buffer.from(text, "utf8").equals(bytes)) fail(`${file} is not valid UTF-8`);
  const r = escapeControls(text, file);
  const out = join(dist, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.text);
  if(type === "script") new vm.Script(r.text, { filename: file });          // still parses
  else {
    const chk = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    if(chk.status !== 0) fail(`${file} no longer parses: ${chk.stderr}`);
  }
  shipped[file] = { sri: sri(Buffer.from(r.text, "utf8")), replaced: r.replaced, literals: r.literals, bytes: Buffer.byteLength(r.text) };
}

// --- page skeleton: the publisher wraps the page in its own <html>/<head>/<body>
patch("doctype and head open",
`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Countersign: RFP Response Studio</title>
`, `<title>Countersign</title>
`);
const libs = html.match(/(<script src="https:\/\/cdnjs[^\n]+\n<script src="https:\/\/cdn\.sheetjs[^\n]+\n<script src="https:\/\/cdn\.jsdelivr[^\n]+\n)<style>/);
if(!libs) fail("library script tags not found before <style>");
patch("library tags out of the head", libs[1] + "<style>", "<style>");
const libTags = libs[1].replace(
  /<script src="https:\/\/cdn\.sheetjs\.com\/xlsx-0\.20\.3\/package\/dist\/xlsx\.full\.min\.js" integrity="[^"]+" crossorigin="anonymous"><\/script>/,
  `<script src="vendor/xlsx/xlsx.full.min.js" integrity="${shipped["vendor/xlsx/xlsx.full.min.js"].sri}"></script>`);
if(libTags === libs[1]) fail("SheetJS tag not rewritten");
patch("head close, body open", "</style>\n</head>\n<body>\n", "</style>\n" + libTags);
patch("body and html close", "</script>\n</body>\n</html>", "</script>");

// --- styles: one-screen height inside the frame's safe-area padding; the in-page dialog
patch("shell height", ".shell{display:flex;height:100vh;height:100dvh}", ".shell{display:flex;height:100%}");
// the storage note can be longer than the original one-liner: let it wrap instead of squeezing the drop target
patch("drop note wraps", ".drop-note{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}",
  ".drop-note{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);max-width:280px}");
// and lets the row wrap, so a narrow drop zone puts the note under the target instead of squeezing it
patch("drop row wraps", ".drop{display:flex;align-items:center;gap:16px;", ".drop{display:flex;flex-wrap:wrap;align-items:center;gap:16px;");
patch("dialog styles", "@media (prefers-reduced-motion:reduce)", String.raw`/* ---------- in-page dialog (the frame shows no confirm or prompt dialogs) ---------- */
.dlg-back{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--scrim);animation:fade .2s ease}
.dlg{width:100%;max-width:440px;max-height:100%;overflow:auto;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:0 16px 40px rgba(0,0,0,.18)}
.dlg h2{font-size:16px;font-weight:600;letter-spacing:-.01em;margin-bottom:8px}
.dlg p{color:var(--muted);white-space:pre-line;margin-bottom:8px}
.dlg textarea{width:100%;margin-top:2px}
.dlg-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}
.btn.primary.danger{background:var(--danger);color:var(--bg)}
@media (min-width:768px){.drop-main{flex-basis:240px}}   /* row layouts only: phones stack the drop zone */
@media (prefers-reduced-motion:reduce)`);

// --- markup: one provider, no engine, no directory file, storage copy set at boot
for(const v of ["claude-key", "gemini", "openai", "proxy", "engine"]){
  const re = new RegExp(`\\n *<label class="chip"><input type="radio" name="provider" value="${v}"><span>[^<]*</span></label>`);
  const m = html.match(re);
  if(!m) fail("provider chip not found: " + v);
  patch("provider chip " + v, m[0], "");
}
patch("engine section hidden", `<section class="set-sec">
        <div class="set-head">
          <h3>Answer engine</h3>`, `<section class="set-sec" hidden>
        <div class="set-head">
          <h3>Answer engine</h3>`);
patch("workspace file copy",
  `<p class="set-desc">Share one knowledge base with your team. Place countersign-data.json next to index.html and it loads automatically for new visitors. To share one API key too, deploy proxy.php or proxy.js and choose Team proxy.</p>`,
  `<p class="set-desc">Save your sources and questions as countersign-data.json, or load one exported from another copy of Countersign. Loading replaces this workspace.</p>`);
patch("load from site hidden", `id="ws-fetch">`, `id="ws-fetch" hidden>`);
patch("drop note id", `<i data-ic="lock" class="sm"></i>Parsed in your browser. Nothing is uploaded.</p>`,
  `<i data-ic="lock" class="sm"></i><span id="drop-note-text">Parsed in your browser. Nothing is uploaded.</span></p>`);
patch("kb note id", `<p class="note">Sources persist between sessions on this device.</p>`,
  `<p class="note" id="kb-note">Sources persist between sessions on this device.</p>`);

// --- script: language (the publisher's <html> carries none)
patch("lang", "const MISSING_LIBS = [];", `document.documentElement.lang = "en";
const MISSING_LIBS = [];`);

// --- pdf.js from the artifact's own files
const pdfStart = html.indexOf("/* pdf.js has shipped only as ES modules since v4");
const pdfEnd = html.indexOf("  return pdfjsPromise;\n}\n", pdfStart);
if(pdfStart < 0 || pdfEnd < 0) fail("pdf.js loader not found");
html = html.slice(0, pdfStart) + String.raw`/* pdf.js has shipped only as ES modules since v4, so it is imported on first use. The
   artifact frame blocks fetch(), so both files are published next to this page, checked
   against the repository's SRI pins when the edition is built (make-artifact.mjs).
   The legacy build is the one that supports the browsers procurement teams actually run. */
const PDFJS = { lib: "vendor/pdfjs/pdf.min.mjs", worker: "vendor/pdfjs/pdf.worker.min.mjs" };
let pdfjsPromise = null;
function loadPdfjs(){
  if(!pdfjsPromise){
    pdfjsPromise = (async () => {
      const lib = await import(new URL(PDFJS.lib, document.baseURI).href);
      lib.GlobalWorkerOptions.workerSrc = new URL(PDFJS.worker, document.baseURI).href;
      return lib;
    })().catch(err => { pdfjsPromise = null; throw err; });
  }
` + html.slice(pdfEnd);

// --- persistence: the viewer's private store in Claude, then this browser, then memory
patch("backend is replaceable", "const backend = (() => {", "let backend = (() => {");
patch("claude storage backend", `    del: async k => { delete mem[k]; } };
})();
const store = {`, String.raw`    del: async k => { delete mem[k]; } };
})();
/* Inside Claude, work is saved to the artifact's own store under the viewer's private
   data/users/<id>/ path, which nobody else who opens the artifact can read, the owner
   included. A stored document holds at most 256 KB, so a long value is split into parts
   written under a fresh version, then published by writing the key's head document; a
   reader never sees half a value. This browser's storage is the fallback when the store
   is unavailable here (signed out, outside Claude) or refuses a write. */
const browserBackend = backend;
const DB_PART_BYTES = 240000;
const _utf8 = new TextEncoder();
function splitForDb(v){
  const parts = [];
  let i = 0;
  while(i < v.length){
    let n = Math.min(180000, v.length - i);
    for(;;){
      let end = i + n;
      const c = v.charCodeAt(end - 1);
      if(end < v.length && c >= 0xD800 && c <= 0xDBFF) end--;   // keep surrogate pairs whole
      const part = v.slice(i, end);
      if(n <= 1000 || _utf8.encode(JSON.stringify({ v: part })).length <= DB_PART_BYTES){ parts.push(part); i = end; break; }
      n = Math.floor(n / 2);
    }
  }
  return parts.length ? parts : [""];
}
async function dbTry(fn){
  try{ return await fn(); }
  catch(e){
    if(!e || e.code !== "unavailable") throw e;
    await new Promise(r => setTimeout(r, 300 + Math.random() * 700));   // once, as the store asks
    return fn();
  }
}
function dbBackend(col){
  const head = k => col.doc(k);
  const part = (k, ver, i) => col.doc(k + "~" + ver + "~" + i);
  async function dropParts(k, snap, keepVer){
    const d = snap && snap.exists ? snap.data() : null;
    if(!d || typeof d.n !== "number" || typeof d.ver !== "string" || d.ver === keepVer) return;
    for(let i = 0; i < d.n; i++){ try{ await part(k, d.ver, i).delete(); }catch(e){} }
  }
  return {
    name: "account", label: "your Claude account",
    async get(k){
      for(let attempt = 0; attempt < 2; attempt++){
        const snap = await dbTry(() => head(k).get());
        if(!snap.exists) return null;
        const d = snap.data();
        if(typeof d.v === "string") return d.v;
        if(typeof d.n !== "number" || typeof d.ver !== "string") return null;
        const parts = await Promise.all(Array.from({ length: d.n }, (_, i) => dbTry(() => part(k, d.ver, i).get())));
        if(parts.every(p => p.exists && typeof p.data().v === "string")) return parts.map(p => p.data().v).join("");
        // replaced by another tab or device while this read was in flight: read the new head
      }
      throw new Error("Couldn't read " + k + " from your Claude account");
    },
    async set(k, v){
      const before = await dbTry(() => head(k).get());
      const parts = splitForDb(String(v));
      let ver = "";
      if(parts.length === 1){
        await dbTry(() => head(k).set({ v: parts[0] }));
      } else {
        ver = uid();
        let written = 0;
        try{
          for(const p of parts){ const i = written; await dbTry(() => part(k, ver, i).set({ v: p })); written++; }
          await dbTry(() => head(k).set({ n: parts.length, ver }));
        }catch(e){
          for(let i = 0; i < written; i++){ try{ await part(k, ver, i).delete(); }catch(e2){} }
          throw e;
        }
      }
      await dropParts(k, before, ver);
    },
    async del(k){
      const before = await dbTry(() => head(k).get());
      await dbTry(() => head(k).delete());
      await dropParts(k, before, "");
    }
  };
}
function storeFlag(v){ try{ if(v) localStorage.setItem("cs-store-mode", v); return localStorage.getItem("cs-store-mode"); }catch(e){ return null; } }
const backendReady = (async () => {
  if(!(window.claude && typeof window.claude.use === "function")) return;
  if(storeFlag() === "browser") return;   // this account could not save here on an earlier visit
  try{
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    if(!db || !user) return;
    // the private subtree inherits the shared write level, so a view-only member cannot save
    if((await user.can("data.write")) === false) return;
    const id = await user.id();
    if(id) backend = dbBackend(db.collection("data/users/" + id));
  }catch(e){ console.warn("Claude storage unavailable", e); }
})();
const STORE_COPY = {
  account: { desc: "Work is saved privately to your Claude account. Each person who opens Countersign has their own workspace.",
             drop: "Parsed in your browser. The text is saved to your Claude account.",
             kb: "Sources are saved to your Claude account." },
  local: { desc: "Claude storage isn't available in this view, so work is saved in this browser only. Export the workspace file to keep a copy.",
           drop: "Parsed in your browser. Nothing is uploaded.",
           kb: "Sources persist between sessions on this device." },
  memory: { desc: "Browser storage is blocked, so work lasts only while this tab is open. Export the workspace file to keep it.",
            drop: "Parsed in your browser. Nothing is uploaded.",
            kb: "Sources last only while this tab is open." }
};
function showStorageMode(){
  const copy = STORE_COPY[backend.name] || STORE_COPY.local;
  $("store-label").textContent = "storage: " + backend.label;
  $("store-sub").textContent = backend.name === "memory" ? "Memory only, not saved" : "Stored in " + backend.label;
  $("store-sub").classList.toggle("warn", backend.name === "memory");
  $("store-desc").textContent = copy.desc;
  $("drop-note-text").textContent = copy.drop;
  $("kb-note").textContent = copy.kb;
}
/* A refused write ends saving to the account for this visit, and the flag keeps later
   visits on this browser so they open the work saved here. */
function accountRefused(e){
  const code = e && e.code;
  if(code === "quota_exceeded"){
    toast("Your Claude storage for Countersign is full. Export the workspace file (Settings), then remove sources you no longer need", true);
    return false;
  }
  if(!["invalid_argument", "not_granted", "revoked", "capability_disabled", "capability_removed"].includes(code)) return false;
  backend = browserBackend; storeFlag("browser"); showStorageMode();
  toast("Your Claude account isn't saving for this page, so work is kept in this browser", true);
  return true;
}
const store = {`);
patch("save falls back from the account", `    try{ await backend.set(key, json); return true; }
    catch(e){
      console.warn("persist failed", e);`, `    try{ await backend.set(key, json); return true; }
    catch(e){
      console.warn("persist failed", e);
      if(backend.name === "account" && accountRefused(e)){
        try{ await backend.set(key, json); return true; }catch(e2){ console.warn("persist failed", e2); }
      }`);
patch("knowledge base save copy", "Couldn't save the whole knowledge base to browser storage. Export the workspace file (Settings) to keep it",
  "Couldn't save the whole knowledge base. Export the workspace file (Settings) to keep it");
patch("boot waits for storage", `  $("store-label").textContent = "storage: " + backend.label;
  $("store-sub").textContent = backend.name === "memory" ? "Memory only, not saved" : "Stored in " + backend.label;
  $("store-sub").classList.toggle("warn", backend.name === "memory");
  if(backend.name === "claude") $("store-desc").textContent = "Work is saved to your Claude storage.";
  if(backend.name === "memory") $("store-desc").textContent = "Browser storage is blocked, so work lasts only while this tab is open. Export the workspace file to keep it.";
`, `  await backendReady;
  showStorageMode();
`);
patch("only the built-in provider", `    if(typeof S.settings.model !== "string") S.settings.model = "";
  }
`, `    if(typeof S.settings.model !== "string") S.settings.model = "";
  }
  // the frame blocks every outbound request, so Claude through the viewer's account is the one provider
  S.settings.provider = "claude"; S.settings.base = ""; S.settings.model = "";
`);
patch("no directory file on a first visit", "  else await fetchDirectoryFile(false);   // fresh visitor on self-hosted copy \u2192 try the directory file\n",
  "  // the artifact publishes no countersign-data.json, so a first visit starts empty\n");

// --- AI: the viewer's own Claude account through the sample capability
patch("provider hint", `claude: "Built into Claude.ai, where no key is needed",`,
  `claude: "Runs on your Claude account, so no API key is needed. Claude asks for your permission before the first draft.",`);
patch("sample provider", "async function askAI(prompt, opts){", String.raw`/* The frame blocks every outbound request, so Claude answers through the viewer's own
   account (the sample capability). Nothing is retried automatically: a failure that will
   repeat (permission, account, usage limit) stops a batch, the rest are drafted again by hand. */
const sampleCap = (window.claude && typeof window.claude.use === "function")
  ? window.claude.use("sample").catch(() => null) : Promise.resolve(null);
const SAMPLE_STOP = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed", "session_expired", "rate_limited"]);
let aiStopReason = "";
function sampleMessage(code){
  switch(code){
    case "not_granted": return "Claude isn't allowed for this page. Allow it from the page's Permissions menu, then draft again";
    case "sampling_disabled": return "Claude isn't available for this account";
    case "session_expired": return "Your Claude session expired. Sign in again, then draft again";
    case "rate_limited": return "Claude's usage limit has been reached for now. Wait a while, then draft again";
    case "prompt_too_large": return "This request is too long for Claude. Shorten the RFP text or split it";
    case "refused": return "Claude declined this request. Rephrase the question";
    case "empty_completion": return "Claude returned no text. Try again, or ask for less";
    case "upstream_error": return "Claude didn't finish answering. Try again";
    default: return "Claude couldn't answer (" + (code || "unknown error") + ")";
  }
}
async function askClaudeSample(prompt){
  const sample = await sampleCap;
  if(!sample) throw new Error("Claude isn't available here. Open Countersign in Claude to draft answers");
  try{
    const { text } = await sample(prompt, { modelTier: "default" });
    return text;
  }catch(e){
    const code = e && e.code;
    const msg = sampleMessage(code);
    if(SAMPLE_STOP.has(code)) aiStopReason = msg;
    throw new Error(msg);
  }
}

async function askAI(prompt, opts){`);
patch("route the claude provider", `  if(p.provider === "claude" || p.provider === "claude-key"){
    const headers`, `  if(p.provider === "claude") return askClaudeSample(prompt);
  if(p.provider === "claude" || p.provider === "claude-key"){
    const headers`);
patch("batch stops on a repeating failure", `        await generateOne(todo[i]);
      }
`, `        await generateOne(todo[i]);
        if(aiStopReason) break;
      }
      if(aiStopReason) throw new Error(aiStopReason);
`);
patch("batch clears the stop", `      if(!S.docs.length) toast("Your knowledge base is empty, so answers will be generic. Add sources for grounded answers.");
`, `      if(!S.docs.length) toast("Your knowledge base is empty, so answers will be generic. Add sources for grounded answers.");
      aiStopReason = "";
`);

// --- files: the frame ignores download links, so saves go through the viewer's prompt
patch("save through downloads", `function downloadBlob(blob, name){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}`, String.raw`/* The frame ignores download links, so a file goes through the viewer's save prompt
   (the downloads capability). Outside Claude a plain link still works. */
const downloadsCap = (window.claude && typeof window.claude.use === "function")
  ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);
let _lastSaveOk = false;
async function downloadBlob(blob, name){
  _lastSaveOk = false;
  const downloads = await downloadsCap;
  if(!downloads){
    if(window.claude) return toast("Saving files isn't available in this view", true);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    _lastSaveOk = true;
    return;
  }
  try{ await downloads.save({ filename: name, data: blob }); _lastSaveOk = true; }
  catch(e){
    const code = e && e.code;
    if(code === "declined") toast("Export cancelled");
    else if(code === "rate_limited") toast("A save prompt is already open. Finish it, then export again", true);
    else toast("Couldn't save " + name + (code ? " (" + code + ")" : ""), true);
  }
}
const xlsxBlob = wb => new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
  { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });`);
patch("csv save", `    downloadBlob(new Blob(["`, `    await downloadBlob(new Blob(["`);
patch("xlsx save", `    XLSX.writeFile(wb, safe + ".xlsx");`, `    await downloadBlob(xlsxBlob(wb), safe + ".xlsx");`);
patch("round-trip save", `    XLSX.writeFile({ ...rfpWorkbook, Sheets: { ...rfpWorkbook.Sheets, [rfpMapping.sheet]: ws } }, safe + "_completed.xlsx");`,
  `    await downloadBlob(xlsxBlob({ ...rfpWorkbook, Sheets: { ...rfpWorkbook.Sheets, [rfpMapping.sheet]: ws } }), safe + "_completed.xlsx");
    if(!_lastSaveOk) return;`);
patch("docx save", `    downloadBlob(await D.Packer.toBlob(doc), safe + ".docx");`, `    await downloadBlob(await D.Packer.toBlob(doc), safe + ".docx");`);
patch("export toast only when saved", `  toast("Downloaded " + safe + "." + S.exportFmt);`, `  if(_lastSaveOk) toast("Downloaded " + safe + "." + S.exportFmt);`);
patch("workspace export", `$("ws-export").onclick = () => {
  downloadBlob(new Blob([JSON.stringify(workspaceSnapshot())], { type: "application/json" }), "countersign-data.json");
  toast("Exported. Upload countersign-data.json to the same directory as this HTML file");
};`, `$("ws-export").onclick = async () => {
  await downloadBlob(new Blob([JSON.stringify(workspaceSnapshot())], { type: "application/json" }), "countersign-data.json");
  if(_lastSaveOk) toast("Exported countersign-data.json");
};`);

// --- dialogs: the frame returns false from confirm() and null from prompt() without showing them
patch("in-page dialog", "/* ---------- persistence:", String.raw`/* The frame never shows the browser's confirm and prompt dialogs, so questions to the
   viewer are asked in the page. Escape, the backdrop and Cancel all mean no. Resolves true, the typed text, or null. */
function openDialog({ title, body = [], input = null, ok = "OK", cancel = "Cancel", danger = false }){
  return new Promise(resolve => {
    const opener = document.activeElement;
    const back = document.createElement("div");
    back.className = "dlg-back";
    const box = document.createElement("div");
    box.className = "dlg";
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "dlg-title");
    const h = document.createElement("h2");
    h.id = "dlg-title"; h.textContent = title;
    box.append(h);
    for(const text of body){ const p = document.createElement("p"); p.textContent = text; box.append(p); }
    let field = null;
    if(input){
      const label = document.createElement("label");
      label.className = "field-label"; label.htmlFor = "dlg-input"; label.textContent = input.label;
      field = document.createElement("textarea");
      field.id = "dlg-input"; field.className = "plain"; field.rows = 3;
      box.append(label, field);
    }
    const foot = document.createElement("div");
    foot.className = "dlg-foot";
    const no = document.createElement("button");
    no.type = "button"; no.className = "btn ghost"; no.textContent = cancel;
    const yes = document.createElement("button");
    yes.type = "button"; yes.className = "btn primary" + (danger ? " danger" : ""); yes.textContent = ok;
    foot.append(no, yes); box.append(foot); back.append(box); document.body.append(back);
    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if(opener && opener.focus) opener.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(null); }
      else if(e.key === "Enter" && field && e.target === field && !e.shiftKey){ e.preventDefault(); yes.click(); }
      else if(e.key === "Tab"){
        const stops = [...box.querySelectorAll("textarea, button")];
        const at = stops.indexOf(document.activeElement);
        if(e.shiftKey && at <= 0){ e.preventDefault(); stops[stops.length - 1].focus(); }
        else if(!e.shiftKey && at === stops.length - 1){ e.preventDefault(); stops[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", e => { if(e.target === back) close(null); });
    no.onclick = () => close(null);
    yes.onclick = () => close(field ? field.value : true);
    (field || no).focus();
  });
}
/* Takes a message written for the browser's confirm dialog as it was: its first
   paragraph becomes the title unless one is given. */
async function confirmIn(message, opts = {}){
  const paras = String(message).split("\n\n");
  const title = opts.title || paras.shift();
  return (await openDialog({ ...opts, title, body: paras })) === true;
}
async function askText(opts){
  const v = await openDialog({ ...opts, input: { label: opts.label } });
  return typeof v === "string" ? v : null;
}

/* ---------- persistence:`);
patch("add question by hand", `$("add-q-btn").onclick = () => {
  const q = prompt("Question text:");`, `$("add-q-btn").onclick = async () => {
  const q = await askText({ title: "Add a question", label: "Question text", ok: "Add question" });`);
patch("other copy confirm open", "    if(otherCopy.length && confirm(", "    if(otherCopy.length && await confirmIn(");
patch("other copy confirm close", " imported from this copy.`))",
  " imported from this copy.`, { title: \"Include answers from another copy?\", ok: \"Write them too\" }))");
patch("filled cells confirm open", "      if(!confirm(", "      if(!(await confirmIn(");
patch("filled cells confirm close", " and fills only the empty ones.`)){",
  " and fills only the empty ones.`, { title: \"Replace filled answer cells?\", ok: \"Replace\" }))){");
patch("import confirm open", "    const ok = confirm(", "    const ok = await confirmIn(");
patch("import confirm close", "Export your workspace first if you want to keep it.`);",
  "Export your workspace first if you want to keep it.`, { ok: \"Replace workspace\", danger: true });");

// --- theme: the viewer can set data-theme on this page; its choice wins over the OS setting
patch("theme from the viewer", `let theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";`,
  `const hostTheme = () => { const t = document.documentElement.dataset.theme; return t === "dark" || t === "light" ? t : null; };
let theme = hostTheme() || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");`);
patch("theme follows the viewer", `applyTheme();
$("theme-toggle").onclick`, `applyTheme();
new MutationObserver(() => { const t = hostTheme(); if(t && t !== theme){ theme = t; applyTheme(); } })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
$("theme-toggle").onclick`);

// --- nothing the frame blocks may remain
const leftovers = [
  ["cdn.sheetjs.com", /cdn\.sheetjs\.com/], ["blob module loader", /blobModule/], ["XLSX.writeFile", /XLSX\.writeFile/],
  ["prompt()", /[^.\w]prompt\(/], ["100vh", /100vh/], ["document tags", /<\/?(html|head|body)[\s>]|<!DOCTYPE/i],
];
for(const [what, re] of leftovers) if(re.test(html)) fail("left in the page: " + what);
// the one confirm() left is the engine prompt, unreachable here (no engine provider)
const confirms = html.match(/[^.\w]confirm\(/g) || [];
if(confirms.length !== 1 || !html.includes("engineMode() && confirm(")) fail("unexpected confirm() calls: " + confirms.length);
for(let k = 0; k < html.length; k++) if(isSuspect(html.charCodeAt(k))) fail("control or replacement character in the page at " + k);

mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), html);
console.log("make-artifact: wrote " + shown(join(dist, "index.html")) + ", " + Buffer.byteLength(html) + " bytes");
for(const [file, s] of Object.entries(shipped))
  console.log(`  ${shown(join(dist, file))}: ${s.bytes} bytes, ${s.replaced} characters escaped in ${s.literals} literals, ${s.sri}`);
