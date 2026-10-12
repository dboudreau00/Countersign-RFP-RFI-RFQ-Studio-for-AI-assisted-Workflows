'use strict';
/* Storage backends, theme preference, concurrency guards, limits. */
const { DOCS, Q_COVERED, Q_ARCH, Q_GAP, q, doc, randKey } = require('../lib/common');
const { anthropicMessage, defaultAnswerText } = require('../lib/mocks');
const { file } = require('../lib/util');

module.exports = (test) => {
  test('persist.backend-claude-cloud-storage', async (t) => {
    // the app prefers window.storage (Claude artifacts) when it exists
    // the stub keeps its data in sessionStorage so it survives a reload, and is invisible to the app's localStorage
    const app = await t.app({
      initScript: {
        fn: () => {
          const P = '__cloud:';
          window.storage = {
            get: async (k) => { const v = sessionStorage.getItem(P + k); return v === null ? null : { key: k, value: v }; },
            set: async (k, v) => { sessionStorage.setItem(P + k, v); return { key: k, value: v }; },
            delete: async (k) => { sessionStorage.removeItem(P + k); return { key: k, deleted: true }; },
          };
        },
      },
    });
    await app.goto();
    t.match('storage label names the cloud backend', await app.page.textContent('#store-label'), /claude cloud/i);
    await app.seed({ docs: DOCS(), questions: [Q_COVERED()] });
    const cloud = await app.page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith('__cloud:')).map(([k, v]) => [k.slice(8), v]));
    const all = cloud.map((x) => x[1]).join('\n');
    t.info('keys written through window.storage', cloud.map((x) => x[0]).join(','));
    t.check('bucket and ledger were written through window.storage', all.includes('KBTXT-SENTINEL') && all.includes('"ref":"A1"'), `${cloud.length} keys`);
    t.eq('localStorage stays untouched by the app', Object.keys(await app.storageDump()).length, 0);
    await app.reload();
    t.eq('state is restored from the cloud backend after a reload', [(await app.docRows()).length, (await app.ledger()).length], [2, 1]);
  });

  test('persist.backend-localStorage-blocked-falls-back-to-memory', async (t) => {
    const app = await t.app({
      initScript: {
        fn: () => {
          const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
          Storage.prototype.setItem = boom; Storage.prototype.getItem = boom; Storage.prototype.removeItem = boom;
        },
      },
    });
    await app.goto();
    t.match('the storage label says memory only', await app.page.textContent('#store-label'), /memory/i);
    t.check('the app still boots cleanly', (await app.pageIssues()).length === 0);
    await app.seed({ docs: DOCS(), questions: [Q_COVERED()] });
    await app.goPage('workspace');
    await app.generateAll();
    t.eq('everything still works in memory', (await app.ledger())[0].stamp, 'Generated');
    t.check('no uncaught errors while persistence is unavailable', (await app.pageIssues()).length === 0, (await app.pageIssues())[0] || '');
  });

  test('persist.quota-exceeded-is-reported', async (t) => {
    const app = await t.app({
      initScript: {
        fn: () => {
          const real = Storage.prototype.setItem;
          Storage.prototype.setItem = function (k, v) {
            if (String(v).length > 5000) throw new DOMException('quota', 'QuotaExceededError');   // only the bucket is this big
            return real.call(this, k, v);
          };
        },
      },
    });
    await app.goto();
    const big = file('big-doc.txt', 'text/plain', Buffer.from('Quota test sentence about retention and encryption. '.repeat(300)));
    await app.uploadKb([big]);
    await app.waitDocs(1);
    const warn = await app.waitToast(/couldn.t save|quota/i);
    t.check('a storage quota failure is reported to the user as an error, with the export-workspace remedy', warn.err && /export/i.test(warn.text), warn.text);
    t.eq('the document is still usable in the session', (await app.docRows()).length, 1);
    t.check('no uncaught page errors', (await app.pageIssues()).length === 0);
  });

  test('layout.phone-width-has-no-sideways-scroll', async (t) => {
    const app = await t.app({ context: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } });
    await app.goto();
    const longName = 'Information-Security-Policy-and-Acceptable-Use-Standard-for-All-Contractors-2026-final-v3.txt';
    await app.seed({
      docs: [doc(longName, 'Customer data is encrypted at rest with AES-256 and in transit with TLS 1.3.'), ...DOCS()],
      questions: [
        q('SEC-ACCESS-CONTROL-2026-01', 'Describe how your platform enforces least-privilege access: https://example.test/requirements/access-control/least-privilege-and-break-glass-accounts'),
        Q_COVERED(), Q_GAP(),
      ],
    });
    // what sticks out past the right edge, ignoring anything inside a box that scrolls sideways
    const overflow = () => app.page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const scrolls = (e) => { for (let p = e.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= w + 1) return true; return false; };
      const bad = [...document.querySelectorAll('body *')].filter((e) => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return r.width > 0 && r.right > w + 1 && cs.position !== 'fixed' && cs.visibility !== 'hidden' && !scrolls(e);
      }).slice(0, 5).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/)[0] : ''} right=${Math.round(e.getBoundingClientRect().right)}`);
      return { page: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), w, bad };
    });
    const check = async (where) => {
      if (process.env.PHONE_SHOTS) await app.page.screenshot({ path: require('path').join(process.env.PHONE_SHOTS, where.replace(/\W+/g, '-') + '.png'), fullPage: true });
      const o = await overflow();
      t.check(`${where}: nothing wider than the ${o.w}px screen`, o.page <= o.w && !o.bad.length, JSON.stringify(o));
    };
    await check('bucket');
    await app.goPage('workspace');
    await app.openRow(0);
    await check('workspace with a row open');
    await app.page.click('#run-gaps');
    await app.waitToast(/gap analysis complete/i);
    await check('gap report');
    await app.goPage('export');
    await check('export preview');
    await app.page.click('#open-settings');
    await check('settings dialog');
    await app.page.click('#settings-close');
    // a long name wraps instead of being cut off
    await app.goPage('bucket');
    const cell = await app.page.evaluate((n) => {
      const td = [...document.querySelectorAll('#doc-list td')].find((x) => x.textContent.trim() === n);
      if (!td) return null;
      const r = td.getBoundingClientRect();
      return { right: Math.round(r.right), w: document.documentElement.clientWidth, h: Math.round(r.height) };
    }, longName);
    t.check('the long document name is on screen, wrapped onto several lines', cell && cell.right <= cell.w && cell.h > 30, JSON.stringify(cell));
  });

  test('load.dark-colour-scheme-preference', async (t) => {
    const app = await t.app({ context: { colorScheme: 'dark' } });
    await app.goto();
    t.eq('prefers-color-scheme: dark starts in dark mode', await app.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    t.match('the toggle offers light mode', await app.page.textContent('#theme-toggle'), /light/i);
    const bg = await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    t.check('body background is actually dark', (bg.match(/\d+/g) || [255]).slice(0, 3).every((n) => +n < 80), bg);
  });

  test('gen.double-click-does-not-duplicate-work', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH()] });
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    app.mock.anthropic = async (req) => ({ delay: 500, json: anthropicMessage(defaultAnswerText(/RFP QUESTION \(([^)]*)\)/.exec(req.json.messages[0].content)[1])) });
    await app.page.dblclick('#generate-all');
    await app.settled();
    t.eq('a double click starts one run: one call per question', app.calls.anthropic.length, 2);
    t.eq('both rows generated', (await app.ledger()).map((r) => r.stamp), ['Generated', 'Generated']);
  });

  test('gen.typing-survives-a-background-render', async (t) => {
    const app = await t.app();
    await app.goto();
    const answered = q('K3', 'Already answered question about onboarding.', { answer: 'Existing text', status: 'generated' });
    await app.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH(), answered] });
    await app.goPage('workspace');
    await app.configure({ provider: 'claude-key', key: randKey('k-') });
    app.mock.anthropic = async (req) => ({ delay: 700, json: anthropicMessage(defaultAnswerText(/RFP QUESTION \(([^)]*)\)/.exec(req.json.messages[0].content)[1])) });
    await app.page.click('#generate-all');
    const row = await app.openRow(2);
    const ta = row.locator('textarea[data-ans]');
    await ta.click();
    await app.page.keyboard.press('End');
    await app.page.keyboard.type(' plus typed words');
    await app.settled();
    const info = await app.page.evaluate(() => {
      const a = document.activeElement;
      return { tag: a && a.tagName, ans: a && a.dataset && a.dataset.ans, val: a && a.value, start: a && a.selectionStart };
    });
    t.eq('the text typed while answers were being generated is kept', (await app.ledger())[2].answer, 'Existing text plus typed words');
    t.check('the textarea is still focused after the re-renders', info.tag === 'TEXTAREA' && !!info.ans, JSON.stringify(info));
    t.eq('and the caret is still at the end', info.start, 'Existing text plus typed words'.length);
    await app.page.waitForTimeout(300);
    t.eq('the edit was persisted', (await app.storedQuestions())[2].answer, 'Existing text plus typed words');
  });

  test('kb.large-document-is-capped', async (t) => {
    const app = await t.app();
    await app.goto();
    const sentence = 'Large document filler sentence about encryption key rotation and access reviews. ';
    const big = file('huge.txt', 'text/plain', Buffer.from(sentence.repeat(Math.ceil(300000 / sentence.length)) + 'TAIL-OF-THE-DOCUMENT'));
    await app.uploadKb([big]);
    await app.waitDocs(1, 30000);
    const ws = await app.exportWorkspace();
    const len = ws.json.docs[0].text.length;
    t.check('stored text is capped at a per-document limit (<= 220,000 characters)', len <= 220000 && len > 100000, `stored ${len} of ${big.buffer.length} characters`);
    const warned = (await app.toasts()).some((x) => /truncat|cap|limit|first .* characters|too (large|long)/i.test(x.text));
    t.info('user told the document was truncated?', warned ? 'yes' : 'no (silent truncation)');
  });

  test('intake.long-rfp-is-truncated-with-notice', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    await app.page.fill('#rfp-paste', 'Requirement line that is repeated to make the paste very long indeed. '.repeat(1000));   // ~70k chars
    await app.extract();
    const prompt = app.calls.anthropic[0].json.messages[0].content;
    const body = prompt.split('RFP TEXT:\n')[1] || '';
    t.check('only the first ~55k characters are sent to the model', body.length <= 55000 && body.length > 50000, `${body.length} characters`);
    const notice = await app.waitToast(/long rfp|first .*characters|scanned/i);
    t.pass('the user is told the tail was not scanned: ' + notice.text.slice(0, 70));
  });
};
