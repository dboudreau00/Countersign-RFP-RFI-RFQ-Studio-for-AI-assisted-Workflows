'use strict';
/* Default provider mocks. Each handler receives the recorded request
   { kind, url, method, headers, text, json, index } and returns a reply spec
   { status?, json?, text?, headers?, delay?, abort? }. Tests replace handlers on
   app.mock.<name> to inject failures. */

const DEFAULT_EXTRACT = [
  { ref: '1.1', q: 'Do you encrypt customer data at rest?', type: 'compliance' },
  { ref: '1.2', q: 'Describe your disaster recovery architecture.', type: 'technical' },
  { ref: '2.1', q: 'Provide your pricing model for enterprise licences.', type: 'commercial' },
];

/* Current Sonnet 5.5 response shape: an (empty) thinking block first, then the text block. */
function anthropicMessage(text, extra) {
  return {
    id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-e2e',
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 13 },
    ...(extra || {}),
  };
}

function parseAnswerPrompt(prompt) {
  const m = /RFP QUESTION \(([^)]*)\): ([\s\S]*)$/.exec(prompt);
  const ctx = (prompt.split('REFERENCE MATERIAL FROM OUR DOCUMENTATION:')[1] || '').split('RFP QUESTION (')[0];
  return {
    ref: m ? m[1] : '?',
    question: m ? m[2] : '',
    words: +((/Target about (\d+) words/.exec(prompt) || [])[1] || 0),
    tone: ((/tone: ([^]*?)\. Target about/.exec(prompt)) || [])[1] || '',
    sources: [...ctx.matchAll(/\[Source: ([^\]]+)\]/g)].map((x) => x[1]),
    context: ctx,
  };
}

/* The answer carries a per-question marker (ANSMARK-<ref>), Markdown emphasis, an
   identifier with underscores and a bullet list, so exports can be checked for all of it. */
function defaultAnswerText(ref) {
  return `Yes. **Bold claim** for ${ref}. ANSMARK-${ref}\n\nSecond paragraph mentions max_tokens_limit and *italic note*.\n\n- item one\n- item two`;
}

function extractReply(app, prompt) {
  let r = app.extractReply;
  if (typeof r === 'function') r = r(prompt);
  if (r === undefined || r === null) r = DEFAULT_EXTRACT;
  return typeof r === 'string' ? r : JSON.stringify(r);
}

function smartText(app, prompt) {
  if (/You are an RFP analyst/.test(prompt)) return extractReply(app, prompt);
  if (/You are a senior proposal writer/.test(prompt)) {
    const a = parseAnswerPrompt(prompt);
    return typeof app.answerText === 'function' ? app.answerText(a, prompt) : defaultAnswerText(a.ref);
  }
  return 'OK';
}

const promptOf = (req) => {
  const m = req.json && req.json.messages && req.json.messages[0];
  if (m && typeof m.content === 'string') return m.content;
  if (m && Array.isArray(m.content)) return m.content.map((b) => b.text || '').join('');
  const g = req.json && req.json.contents && req.json.contents[0];
  if (g && g.parts) return g.parts.map((p) => p.text || '').join('');
  return '';
};

function makeDefaults(app) {
  return {
    anthropic: (req) => ({ json: anthropicMessage(smartText(app, promptOf(req))) }),
    proxy: (req) => ({ json: anthropicMessage(smartText(app, promptOf(req))) }),
    gemini: (req) => ({
      json: { candidates: [{ content: { role: 'model', parts: [{ text: smartText(app, promptOf(req)) }] }, finishReason: 'STOP' }] },
    }),
    openai: (req) => ({
      json: { id: 'cmpl-e2e', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: smartText(app, promptOf(req)) }, finish_reason: 'stop' }] },
    }),
    engine: (req) => {
      const p = new URL(req.url).pathname;
      if (p === '/health') return { json: { ok: true, docs: 3, chunks: 9, model: 'claude-engine-e2e', token_required: false } };
      if (p === '/ingest') return { json: { ok: true, name: (req.json || {}).name, chars: ((req.json || {}).text || '').length, truncated: false, persisted: true, docs: 1, chunks: 1 } };
      if (p === '/search') return { json: { query: (req.json || {}).query, coverage: 0.2, sources: [], missing_terms: ['helicopter'], chunks: [] } };
      if (p === '/proxy') return { json: anthropicMessage(smartText(app, promptOf(req))) };
      if (p === '/answer') {
        const b = req.json || {};
        return { json: { answer: `ENGINE-ANSWER for: ${b.question}`, sources: ['engine-kb.txt'], coverage: 0.85, chunks_used: 2, missing_terms: [], model: 'claude-engine-e2e' } };
      }
      if (p === '/batch') {
        const qs = (req.json || {}).questions || [];
        const lines = [{ kind: 'start', total: qs.length }];
        qs.forEach((q, i) => lines.push({ kind: 'answer', index: i, id: q.id, ref: q.ref, question: q.question, answer: `ENGINE-BATCH ${q.ref}`, sources: ['engine-kb.txt'], coverage: 0.9, missing_terms: [] }));
        lines.push({ kind: 'done', total: qs.length, succeeded: qs.length, failed: 0 });
        return { contentType: 'application/x-ndjson', text: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' };
      }
      return { status: 404, json: { error: { message: 'no such route ' + p } } };
    },
  };
}

module.exports = { DEFAULT_EXTRACT, anthropicMessage, parseAnswerPrompt, defaultAnswerText, makeDefaults, promptOf };
