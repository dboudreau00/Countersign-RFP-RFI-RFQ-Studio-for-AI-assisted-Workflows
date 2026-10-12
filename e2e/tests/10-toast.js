'use strict';
/* Toast queue with REAL timers (the other tests shorten toast display time). */
const { Q_COVERED } = require('../lib/common');

module.exports = (test) => {
  test('toast.queue-shows-every-message-in-order', async (t) => {
    const app = await t.app({ realToasts: true });
    await app.goto();
    // no bucket documents: generating raises a warning and then a success toast back to back
    await app.seed({ docs: [], questions: [Q_COVERED()] });
    await app.goPage('workspace');
    // let the "workspace loaded" toast from the seed drain so only this flow's toasts are timed
    await app.page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), null, { timeout: 8000 });
    await app.clearToasts();
    const seen = [];
    const start = Date.now();
    await app.page.click('#generate-all');
    while (Date.now() - start < 9000 && seen.length < 2) {
      const txt = await app.page.evaluate(() => {
        const el = document.getElementById('toast');
        return el.classList.contains('show') ? el.textContent : '';
      });
      if (txt && (!seen.length || seen[seen.length - 1].text !== txt)) seen.push({ text: txt, at: Date.now() - start });
      await new Promise((r) => setTimeout(r, 60));
    }
    t.eq('two distinct toasts were displayed', seen.length, 2);
    if (seen.length === 2) {
      t.match('the warning is shown first', seen[0].text, /bucket is empty/i);
      t.match('the success message follows it', seen[1].text, /draft answers generated|generated/i);
      t.check('the warning stays on screen long enough to read (>= 2s before the next one)', seen[1].at - seen[0].at >= 2000, `${seen[1].at - seen[0].at}ms between them`);
    }
    t.check('the warning was not overwritten within the same tick (both are in the recorded log)', (await app.toasts()).length >= 2);
    await app.page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), null, { timeout: 8000 });
    t.pass('the toast hides itself after the queue drains');
  });

  test('toast.errors-are-styled-and-held-longer', async (t) => {
    const app = await t.app({ realToasts: true });
    await app.goto();
    await app.goPage('export');
    await app.page.click('#download-btn');
    await app.page.waitForFunction(() => document.getElementById('toast').classList.contains('err'), null, { timeout: 3000 });
    t.pass('an error toast gets the err style');
    const t0 = Date.now();
    await app.page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'), null, { timeout: 9000 });
    const held = Date.now() - t0;
    t.check('error toasts stay up longer than 3.2s', held >= 3000, `${held}ms remaining after first seen`);
  });
};
