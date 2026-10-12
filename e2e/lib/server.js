'use strict';
/* Tiny static server for the directory under test. Correct content types, no caching.
   `/__e2e/*` is served from the harness directory (the lib page), everything else from
   --root. Every request is recorded so tests can assert on what the page asked for. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv; charset=utf-8',
};

function startServer({ root, harnessDir, port }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch (e) { res.writeHead(400); return res.end('bad url'); }
    hits.push({ method: req.method, path: rel, t: Date.now() });
    const base = rel.startsWith('/__e2e/') ? harnessDir : root;
    const sub = rel.startsWith('/__e2e/') ? rel.slice('/__e2e/'.length) : rel.slice(1);
    let file = path.resolve(base, sub === '' ? 'index.html' : sub);
    const inside = file === path.resolve(base) || file.startsWith(path.resolve(base) + path.sep);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (rel === '/favicon.ico' && !fs.existsSync(file)) { res.writeHead(204, headers); return res.end(); }
    if (!inside) { res.writeHead(403, headers); return res.end('forbidden'); }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); }
      fs.readFile(file, (err2, data) => {
        if (err2) { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); return res.end('not found'); }
        res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    });
  });
  /* Prefer the requested port; if another process already holds it (other jobs share this
     range), fall back to the next free port in 18840-18859 rather than failing. */
  const candidates = [port, ...Array.from({ length: 20 }, (_, i) => 18840 + i).filter((p) => p !== port)];
  const tryListen = (i) => new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.removeListener('listening', onOk);
      if (e.code === 'EADDRINUSE' && i + 1 < candidates.length) resolve(tryListen(i + 1));
      else reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve({ server, hits, port: candidates[i], origin: `http://127.0.0.1:${candidates[i]}` });
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(candidates[i], '127.0.0.1');
  });
  return tryListen(0);
}

module.exports = { startServer };
