'use strict';
/* Shared test data and provider table. */
const { randKey } = require('./util');

const doc = (name, text) => ({
  id: 'doc-' + name.replace(/\W/g, '-'), name, type: name.split('.').pop(), size: text.length, chars: text.length, text,
});
const q = (ref, text, extra) => ({
  id: 'q-' + ref.replace(/\W/g, '_'), ref, text, answer: '', status: 'draft', sources: [], coverage: null, ...(extra || {}),
});

const KB_SECURITY = 'KBTXT-SENTINEL Zyphron attestation is performed quarterly by Orbital Assurance Labs using hardware-backed key ceremonies. Access reviews for privileged accounts run monthly.';
const KB_ARCH = '# Architecture\n\nKBMD-SENTINEL Quillfeather replication keeps three regional mirrors synchronized within ninety seconds. Disaster recovery uses warm standby.';
const DOCS = () => [doc('kb-security.txt', KB_SECURITY), doc('kb-architecture.md', KB_ARCH)];

const Q_COVERED = () => q('A1', 'Describe how Zyphron attestation is performed and by whom.');
const Q_ARCH = () => q('B1', 'Explain Quillfeather replication across regional mirrors.');
const Q_GAP = () => q('C1', 'Describe your helicopter maintenance scheduling process.');

const ENGINE_BASE = 'http://127.0.0.1:18851';

/* cfg: what to pass to app.configure(); kind: which mock list records its calls */
const PROVIDERS = {
  claude: { cfg: () => ({ provider: 'claude' }), kind: 'anthropic' },
  'claude-key': { cfg: (key) => ({ provider: 'claude-key', key }), kind: 'anthropic' },
  gemini: { cfg: (key) => ({ provider: 'gemini', key }), kind: 'gemini' },
  openai: { cfg: (key) => ({ provider: 'openai', key }), kind: 'openai' },
  proxy: { cfg: () => ({ provider: 'proxy' }), kind: 'proxy' },
  engine: { cfg: () => ({ provider: 'engine', base: ENGINE_BASE }), kind: 'engine' },
};

/* Empty / blocked completions in each provider's own shape. Each must end as a failed answer. */
const EMPTY_VARIANTS = {
  anthropic: {
    'refusal: stop_reason "refusal", content []': { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: 'refusal', usage: {} },
    'empty text block after a thinking block': { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '' }], stop_reason: 'end_turn', usage: {} },
    'whitespace-only text': { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '  \n \t ' }], stop_reason: 'end_turn', usage: {} },
    'thinking only, stop_reason max_tokens': { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'long reasoning', signature: 'sig' }], stop_reason: 'max_tokens', usage: {} },
  },
  gemini: {
    'no candidates, blocked by safety': { promptFeedback: { blockReason: 'SAFETY' } },
    'empty candidates array': { candidates: [] },
    'candidate with empty text': { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] },
    'candidate with no content (finishReason SAFETY)': { candidates: [{ finishReason: 'SAFETY' }] },
  },
  openai: {
    'empty string content': { choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
    'null content (content_filter)': { choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }] },
    'no choices': { choices: [] },
  },
  engine: {
    'answer is an empty string': { answer: '', sources: [], coverage: 0, missing_terms: [] },
    'answer is whitespace': { answer: '  \n ', sources: [], coverage: 0, missing_terms: [] },
  },
};

/* Request-body rules for Anthropic-shaped calls. The model and max_tokens values are
   REPORTED (INFO); the floor is enforced; a model that differs from EXPECTED_DEFAULT_MODEL is
   reported rather than failed unless --strict-model is given, because the default is expected
   to change. kind: 'answer' | 'extract' selects which max_tokens floor applies. */
function checkAnthropicBody(t, cfg, call, label, kind, { expectDefaultModel = true } = {}) {
  const b = call.json || {};
  const floor = kind === 'extract' ? cfg.MIN_EXTRACT_MAX_TOKENS : cfg.MIN_ANSWER_MAX_TOKENS;
  t.info(`${label} request body`, `model=${b.model} max_tokens=${b.max_tokens} keys=${Object.keys(b).join(',')}`);
  t.check(`${label}: model is a non-empty string`, typeof b.model === 'string' && b.model.length > 0, String(b.model));
  if (expectDefaultModel) {
    if (b.model === cfg.EXPECTED_DEFAULT_MODEL) t.pass(`${label}: default model equals EXPECTED_DEFAULT_MODEL`, b.model);
    else if (cfg.strictModel) t.fail(`${label}: default model equals EXPECTED_DEFAULT_MODEL`, `sent ${b.model}, expected ${cfg.EXPECTED_DEFAULT_MODEL}`);
    else t.info(`${label}: MODEL DIFFERS from EXPECTED_DEFAULT_MODEL`, `sent ${b.model}, expected ${cfg.EXPECTED_DEFAULT_MODEL} (update the constant or pass --expect-model if intended; --strict-model makes this a failure)`);
  }
  t.check(`${label}: max_tokens meets the configured floor`, Number.isFinite(b.max_tokens) && b.max_tokens >= floor, `sent ${b.max_tokens}, floor ${floor}`);
  for (const k of ['temperature', 'top_p', 'top_k']) t.check(`${label}: body has no ${k}`, !(k in b));
  t.check(`${label}: no assistant prefill (every message is role user, last message is user)`,
    Array.isArray(b.messages) && b.messages.length >= 1 && b.messages.every((m) => m.role === 'user'), JSON.stringify((b.messages || []).map((m) => m.role)));
  t.check(`${label}: no "prefill" or "assistant" field`, !('prefill' in b) && !('assistant' in b));
}

module.exports = { checkAnthropicBody, doc, q, DOCS, Q_COVERED, Q_ARCH, Q_GAP, KB_SECURITY, KB_ARCH, PROVIDERS, EMPTY_VARIANTS, ENGINE_BASE, randKey };
