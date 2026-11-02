'use strict';
/* The screens themselves: question filters and navigation, writing an answer by hand,
   source search, the RFP intake, the workspace name, the export summary, and the phone
   layout's list-then-answer flow. */
const { DOCS, Q_COVERED, Q_ARCH, Q_GAP, q } = require('../lib/common');

module.exports = (test) => {
  test('ui.filters-navigation-and-hand-written-answers', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH(), Q_GAP(), q('D1', 'Describe your onboarding plan for new customers.')] });
    await app.goPage('workspace');
    await app.generateRow(0);           // A1: well covered
    await app.generateRow(2);           // C1: nothing in the bucket, so a gap
    await app.approve(0);
    const counts = await app.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-filter]')].map((b) => [b.dataset.filter, +b.querySelector('.n').textContent])));
    t.eq('filter counts: all, to draft, review, gaps, approved', counts, { all: 4, todraft: 2, review: 0, gap: 1, approved: 1 });
    t.match('the header legend sums it up', await app.page.textContent('#seg-legend'), /^1 approved · 1 gap · 2 to draft$/);
    t.eq('"Draft remaining" counts the questions without an answer', await app.page.textContent('#todo-count'), '2');
    t.eq('the nav shows approved over total', await app.page.textContent('#nav-meta-workspace'), '1/4');
    await app.filter('todraft');
    t.eq('"To draft" lists only the unanswered questions', await app.page.$$eval('#ledger [data-qid] .q-num', (e) => e.map((x) => x.textContent)), ['B1', 'D1']);
    await app.filter('all');

    await app.openRow(1);
    await app.page.click('#answer-panel [data-step="1"]');
    t.eq('"Next question" moves to the following question', await app.page.textContent('#question-heading'), Q_GAP().text);
    await app.page.click('#answer-panel [data-step="-1"]');
    t.eq('"Previous question" moves back', await app.page.textContent('#question-heading'), Q_ARCH().text);
    await app.openRow(0);
    t.check('the first question has no previous one', await app.page.isDisabled('#answer-panel [data-step="-1"]'));

    const gap = await app.openRow(2);
    t.match('a gap explains itself in the answer panel and names what is missing', await gap.locator('.callout').textContent(), /don't fully answer this[\s\S]*helicopter/);

    const p = await app.openRow(3);
    t.eq('an unanswered question offers a draft or a hand-written answer', [await p.locator('[data-gen]').count(), await p.locator('[data-write]').count()], [1, 1]);
    await p.locator('[data-write]').click();
    t.check('"Write it yourself" opens an empty answer box with the cursor in it',
      await app.page.evaluate(() => !!document.activeElement && document.activeElement.dataset.ans !== undefined && document.activeElement.value === ''));
    await app.page.keyboard.type('Onboarding takes two weeks with a named manager.');
    t.match('the word count follows the typing', await app.page.textContent('#word-count'), /^8 \/ \d+ words$/);
    t.check('Approve appears once there is text', await p.locator('[data-approve]').isVisible());
    await p.locator('[data-approve]').click();
    const rows = await app.ledger();
    t.eq('the hand-written answer is kept and approved', [rows[3].answer, rows[3].status], ['Onboarding takes two weeks with a named manager.', 'approved']);
  });

  test('ui.source-search', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [] });
    await app.page.fill('#doc-search', 'ARCH');
    t.eq('search narrows the sources table by name, ignoring case', (await app.docRows()).map((r) => r.name), ['kb-architecture.md']);
    await app.page.fill('#doc-search', 'nothing-like-this');
    t.match('no match says so', await app.page.textContent('#doc-list'), /no sources match/i);
    await app.page.fill('#doc-search', '');
    t.eq('clearing the search shows every source again', (await app.docRows()).length, 2);
    t.match('the header counts sources and chunks', `${await app.page.textContent('#doc-count')} | ${await app.page.textContent('#storage-label')}`, /^2 of 500 sources \| \d+ chunks · \d+ KB$/);
  });

  test('ui.intake-flow-and-workspace-name', async (t) => {
    const app = await t.app();
    await app.goto();
    await app.goPage('workspace');
    t.check('with no questions, Responses opens on the RFP intake', await app.page.isVisible('#extract-btn') && !(await app.page.isVisible('#resp-view')));
    t.check('with nothing to go back to, there is no way back', !(await app.page.isVisible('#close-intake')));
    await app.page.fill('#rfp-paste', 'Section 1. 1.1 Do you encrypt customer data at rest? 1.2 Describe your disaster recovery architecture. 2.1 Provide your pricing model.');
    await app.extract();
    await app.waitLedger(3);
    t.check('after extraction the questions are shown, not the intake', await app.page.isVisible('#resp-view') && !(await app.page.isVisible('#extract-btn')));
    t.eq('pasted text is named as the source', await app.page.textContent('#rfp-title'), 'Pasted text');
    t.match('the header counts the questions and dates the extraction', await app.page.textContent('#q-count'), /^3 questions · extracted \S/);
    t.eq('numbered refs are grouped by section', await app.page.$$eval('#ledger .q-sec', (e) => e.map((x) => x.textContent)), ['Section 1', 'Section 2']);
    t.eq('the first new question is selected', await app.page.textContent('#question-heading'), 'Do you encrypt customer data at rest?');
    await app.page.click('#open-intake');
    t.check('"Add questions" reopens the intake, with a way back', await app.page.isVisible('#extract-btn') && await app.page.isVisible('#close-intake'));
    await app.page.click('#close-intake');
    t.check('"Back to responses" returns to the list', await app.page.isVisible('#resp-view'));
    t.eq('the workspace is named after its RFP until a title is set', await app.page.textContent('#ws-name'), 'Pasted text');

    await app.goPage('export');
    await app.page.fill('#exp-title', 'Brindle Logistics Response');
    t.eq('the proposal title names the workspace', await app.page.textContent('#ws-name'), 'Brindle Logistics Response');
    t.eq('and the export file', await app.page.textContent('#exp-file'), 'Brindle_Logistics_Response.docx');
    t.match('the export summary says what is left', await app.page.textContent('#exp-note'), /3 not drafted\. Review responses/);
    t.check('write-back is unavailable without a mapped spreadsheet', await app.page.isDisabled('#fmt-roundtrip input'));
    await app.page.click('.fmt-card[data-fmt="csv"]');
    t.eq('the button and the file name follow the format', [await app.page.textContent('#download-label'), await app.page.textContent('#exp-file')], ['Export CSV', 'Brindle_Logistics_Response.csv']);
    await app.page.waitForTimeout(500);
    await app.reload();
    t.eq('the title and the RFP name survive a reload', [await app.page.inputValue('#exp-title'), await app.page.textContent('#rfp-title')], ['Brindle Logistics Response', 'Pasted text']);
  });

  test('ui.phone-list-then-answer', async (t) => {
    const app = await t.app({ context: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } });
    await app.goto();
    await app.seed({ docs: DOCS(), questions: [Q_COVERED(), Q_ARCH()] });
    await app.goPage('workspace');
    t.check('on a phone the list shows first, without the answer panel', await app.page.isVisible('#ledger [data-qid]') && !(await app.page.isVisible('#answer-panel .a-q')));
    await app.page.locator('#ledger [data-qid]').nth(1).click();
    t.check('tapping a question shows its answer instead of the list', await app.page.isVisible('#answer-panel .a-q') && !(await app.page.isVisible('#ledger')));
    t.eq('the right question is open', await app.page.textContent('#question-heading'), Q_ARCH().text);
    await app.page.click('#answer-panel [data-back]');
    t.check('"Questions" goes back to the list', await app.page.isVisible('#ledger [data-qid]') && !(await app.page.isVisible('#answer-panel .a-q')));
  });
};
