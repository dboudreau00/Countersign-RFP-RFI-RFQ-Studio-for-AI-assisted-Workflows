// Countersign mark: an inked checkmark signed above a dotted signature line.
// Writes every logo file into OUT from code, so the mark can be rebuilt or adjusted:
//   node make-logo.js <brand dir> <scratch dir> <path to the playwright package>
const fs = require('fs');
const path = require('path');
const [, , OUT, SCRATCH, PW] = process.argv;
const { chromium } = require(PW);

const r2 = (v) => Math.round(v * 100) / 100;
const pt = (p) => `${r2(p[0])},${r2(p[1])}`;
const bez = (c, t) => { const u = 1 - t; return [0, 1].map((k) => u * u * u * c[0][k] + 3 * u * u * t * c[1][k] + 3 * u * t * t * c[2][k] + t * t * t * c[3][k]); };
const bezD = (c, t) => { const u = 1 - t; return [0, 1].map((k) => 3 * u * u * (c[1][k] - c[0][k]) + 6 * u * t * (c[2][k] - c[1][k]) + 3 * t * t * (c[3][k] - c[2][k])); };

// Catmull-Rom through pts as cubic segments; the start point is already current
function smooth(pts) {
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d;
}

// filled outline of one pen stroke whose width varies along its length; the rounded ends are
// sampled as points (an SVG half-circle arc is ambiguous about which way it bulges)
function stroke(ctrl, width, n, m) {
  const A = [], B = [], cap = (c, r, from) => {
    const out = [];
    for (let k = 1; k < m; k++) { const a = from - Math.PI * k / m; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    return out;
  };
  let first, last;
  for (let i = 0; i <= n; i++) {
    const t = i / n, p = bez(ctrl, t), d = bezD(ctrl, t), len = Math.hypot(d[0], d[1]);
    const nx = -d[1] / len, ny = d[0] / len, w = width(t) / 2;
    A.push([p[0] + nx * w, p[1] + ny * w]);
    B.push([p[0] - nx * w, p[1] - ny * w]);
    if (i === 0) first = { p, nx, ny, w };
    if (i === n) last = { p, nx, ny, w };
  }
  const pts = [...A, ...cap(last.p, last.w, Math.atan2(last.ny, last.nx)), ...B.reverse(),
    ...cap(first.p, first.w, Math.atan2(-first.ny, -first.nx))];
  const L = pts.length;
  let d = `M${pt(pts[0])}`;
  for (let i = 0; i < L; i++) {   // closed Catmull-Rom
    const p0 = pts[(i - 1 + L) % L], p1 = pts[i], p2 = pts[(i + 1) % L], p3 = pts[(i + 2) % L];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
  }
  return d + ' Z';
}
const wobble = (t, s) => 1 + 0.03 * Math.sin(6 * t + s);

const V = [50, 88], E = [111, 25];
function mark({ small = false } = {}) {
  const k = small ? 1.18 : 1;
  // short downstroke: the brush lands light and swells, then ink pools at the turn
  const ease = (s) => s * s * (3 - 2 * s);
  const down = stroke([[24, 60], [30, 66], [40, 77.5], V],
    (t) => k * (t < 0.45 ? 10 + 4 * ease(t / 0.45) : 14 - 0.8 * Math.sin(((t - 0.45) / 0.55) * Math.PI) + 1.8 * Math.pow((t - 0.45) / 0.55, 3)) * wobble(t, 0.4),
    small ? 20 : 44, small ? 6 : 12);
  // long upstroke: bows a little toward the upper left, as a flick from the wrist does, and tapers to a hairline
  const up = stroke([V, [66.5, 65], [86, 42.5], E],
    (t) => k * (1.1 + 14.3 * (1 - Math.pow(t, 1.8))) * wobble(t, 1.9), small ? 26 : 64, small ? 6 : 12);
  // ink flung off the tip, trailing on along the stroke's direction
  const u = [0.696, -0.718], p = [0.718, 0.696];
  const fling = (along, side, r) => [r2(E[0] + u[0] * along + p[0] * side), r2(E[1] + u[1] * along + p[1] * side), r];
  const drops = small ? [] : [fling(7, 0.8, 1.65), fling(12.5, -1.2, 1.0), fling(5, 4.6, 0.7)];
  const dots = [];
  if (small) for (let x = 16; x <= 112; x += 12) dots.push([x, 107, 2.9]);
  else for (let x = 14; x <= 116; x += 6) dots.push([x, 106, 1.4]);
  return { strokes: [down, up], drops, dots };
}

// heavy ink where it pools at the turn, lighter as the flick runs dry
const THEMES = {
  light: { id: 'l', paper: '#F6F5F1', edge: '#E3E1DA', ink: ['#103D2A', '#1C6848', '#3A9468'], line: '#181816', lineOpacity: 0.55 },
  dark: { id: 'd', paper: '#191917', edge: '#2E2E2A', ink: ['#3E9A6E', '#60BE90', '#93DBB6'], line: '#ECEAE4', lineOpacity: 0.5 },
  solid: { id: 's', paper: '#1C6848', edge: '#175A3D', ink: ['#FFFFFF', '#F6F5F1', '#DCEBE2'], line: '#F6F5F1', lineOpacity: 0.55 },
};
function markSvg(m, th, inner = false) {
  const grad = `cs-ink-${th.id}`;
  const g = `<defs><linearGradient id="${grad}" gradientUnits="userSpaceOnUse" x1="${V[0]}" y1="${V[1]}" x2="${E[0]}" y2="${E[1]}">`
    + `<stop offset="0" stop-color="${th.ink[0]}"/><stop offset=".4" stop-color="${th.ink[1]}"/><stop offset="1" stop-color="${th.ink[2]}"/></linearGradient></defs>`
    + `<g fill="url(#${grad})">${m.strokes.map((d) => `<path d="${d}"/>`).join('')}`
    + `${m.drops.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`
    + `<g fill="${th.line}" fill-opacity="${th.lineOpacity}">${m.dots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>`;
  return inner ? g : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${g}</svg>`;
}
function tileSvg(m, th) {
  const edge = th.id === 's' ? '' : ` stroke="${th.edge}" stroke-width="2"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">`
    + `<rect x="1" y="1" width="126" height="126" rx="28" fill="${th.paper}"${edge}/>`
    + `<g transform="translate(13 11) scale(.8)">${markSvg(m, th, true)}</g></svg>`;
}
function lockupSvg(m, th, text) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 128">${markSvg(m, th, true)}`
    + `<text x="146" y="86" font-family="'Segoe UI Variable Display','Segoe UI',Inter,sans-serif" font-weight="600" `
    + `font-size="60" letter-spacing="-1.2" fill="${text}">Countersign</text></svg>`;
}

const full = mark(), small = mark({ small: true });
const files = {
  'countersign-mark.svg': markSvg(full, THEMES.light),
  'countersign-mark-dark.svg': markSvg(full, THEMES.dark),
  'countersign-mark-small.svg': markSvg(small, THEMES.light),
  'countersign-icon.svg': tileSvg(full, THEMES.solid),
  'countersign-icon-paper.svg': tileSvg(full, THEMES.light),
  'countersign-icon-dark.svg': tileSvg(full, THEMES.dark),
  'countersign-icon-small.svg': tileSvg(small, THEMES.solid),
  'countersign-logo.svg': lockupSvg(full, THEMES.light, '#181816'),
  'countersign-logo-dark.svg': lockupSvg(full, THEMES.dark, '#ECEAE4'),
};
for (const [name, svg] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), svg + '\n');
fs.writeFileSync(path.join(SCRATCH, 'logo-paths.json'), JSON.stringify({ full, small }, null, 1));

const cell = (svg, bg, size, label) => `<figure style="background:${bg}"><div style="width:${size}px;height:${size}px">${svg}</div><figcaption>${label}</figcaption></figure>`;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:28px;background:#E9E7E1;font:13px 'Segoe UI',sans-serif;color:#66645D}
.row{display:flex;gap:18px;align-items:flex-end;margin-bottom:18px;flex-wrap:wrap}
figure{margin:0;padding:22px;border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:10px}
figure div svg{width:100%;height:100%;display:block} figcaption{font-size:11px;opacity:.7}
.wide div{width:420px!important;height:96px!important}
</style>
<div class="row">${cell(files['countersign-mark.svg'], '#F6F5F1', 300, 'mark')}${cell(files['countersign-mark-dark.svg'], '#111110', 300, 'mark, dark')}
${cell(files['countersign-icon.svg'], 'transparent', 160, 'app icon')}${cell(files['countersign-icon-paper.svg'], 'transparent', 160, 'paper')}${cell(files['countersign-icon-dark.svg'], 'transparent', 160, 'dark')}</div>
<div class="row"><figure class="wide" style="background:#F6F5F1"><div>${files['countersign-logo.svg']}</div><figcaption>logo</figcaption></figure>
<figure class="wide" style="background:#111110"><div>${files['countersign-logo-dark.svg']}</div><figcaption>logo, dark</figcaption></figure></div>
<div class="row">${[64, 48, 32, 24, 16].map((s) => cell(files[s <= 32 ? 'countersign-icon-small.svg' : 'countersign-icon.svg'], 'transparent', s, s + ' px')).join('')}
${[32, 16].map((s) => cell(files['countersign-mark-small.svg'], '#FFFFFF', s, s + ' px mark')).join('')}</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(SCRATCH, 'logo-preview.png'), fullPage: true });
  // PNG renders for the Windows icon and the docs
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of [...sizes, 512]) {
    const svg = files[s <= 32 ? 'countersign-icon-small.svg' : 'countersign-icon.svg'];
    const p = await browser.newPage({ viewport: { width: s, height: s }, deviceScaleFactor: 1 });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${svg}`);
    const buf = await p.screenshot({ omitBackground: true });
    await p.close();
    if (s === 512 || s === 256) fs.writeFileSync(path.join(OUT, `countersign-icon-${s}.png`), buf);
    if (sizes.includes(s)) pngs.push([s, buf]);
  }
  // logo PNGs for READMEs (the SVG lockups use live text, which depends on installed fonts)
  for (const [name, bg] of [['countersign-logo', '#F6F5F1'], ['countersign-logo-dark', '#111110']]) {
    const p = await browser.newPage({ viewport: { width: 560, height: 128 }, deviceScaleFactor: 2 });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:560px;height:128px;display:block}</style>${files[name + '.svg']}`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), await p.screenshot({ omitBackground: true }));
    await p.close();
  }
  await browser.close();
  // .ico with PNG frames, which Windows Vista and later read
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([s, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  fs.writeFileSync(path.join(OUT, 'countersign.ico'), Buffer.concat([head, ...pngs.map(([, b]) => b)]));
  console.log('wrote', Object.keys(files).length, 'svg, 2 png, 1 ico; preview in scratchpad');
})().catch((e) => { console.error(e); process.exit(1); });
