/**
 * Groundedness scorer for drafted RFP answers (zero dependencies, deterministic).
 *
 * The question it answers: does the drafted answer derive from the retrieved context, or
 * did the model invent it? It does this by pulling the SPECIFIC claims out of the answer
 * (figures, durations, percentages, standards like "ISO 27001" or "TLS 1.3", acronyms,
 * and proper nouns) and checking each one against the context the model was given.
 * An unsupported specific is exactly the class of hallucination that sinks an RFP
 * response: a made-up SLA, a certification the vendor does not hold, an integration
 * partner that does not exist.
 *
 * It is deliberately lexical. It will not catch a paraphrased false claim that contains
 * no specifics ("we are fully compliant"), and it cannot judge nuance. What it can do is
 * run in CI in milliseconds with no API key and no randomness, which is what a drift
 * canary needs. Pair it with the must_mention / must_not_mention checks in cases.json.
 */
"use strict";

const UNITS = "(?:%|percent|ms|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|" +
  "characters?|chars?|users?|seats?|requests?|events?|roles?|regions?|zones?|replicas?|bit|gb|tb|mb|x)";
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, sixty: 60, ninety: 90 };
/* Acronyms that are vocabulary rather than claims. "Our SLA is 99.999%" invents the figure,
   not the word SLA. Standards, products and controls (SAML, SCIM, KMS, TOTP, SIEM, ISO, SOC,
   TLS, AES, OIDC, WAF...) are deliberately NOT here: asserting one of those is a claim. */
const GENERIC_ACRONYMS = new Set(("SLA SLAS API APIS SAAS RFP RFI RFQ IT HR UI UX SDK SDKS URL HTTP HTTPS SSO MFA PDF CSV " +
  "DOCX XLSX NDA FAQ KPI KPIS QA UAT ROI TCO CI CD IAM PII DR BCP DPA DPO GDPR CRM ERP ETA TBC TBD OK AM PM").split(" "));

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\s-]*";   // "AES-256-GCM", "AES 256" and "AES256" are the same claim

function splitSentences(text) {
  return String(text || "").replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).map((s) => s.trim()).filter(Boolean);
}

/* Each specific is { token, kind, re } where `re` tests the normalised context. */
function extractSpecifics(sentence) {
  const found = new Map();
  const add = (token, kind, re) => { if (!found.has(token)) found.set(token, { token, kind, re }); };

  // 1. name + number pairs: ISO 27001, SOC 2, TLS 1.3, AES-256, PostgreSQL 16, WCAG 2.1
  //    The number inside a pair belongs to the pair; rule 2 must not count it again as a
  //    bare figure, or "ISO 14001" would be reported twice.
  const consumed = [];
  for (const m of sentence.matchAll(/\b([A-Z][A-Za-z]{1,14})[ -](\d[\d.]*[A-Za-z]?)\b/g)) {
    add(m[1] + " " + m[2], "standard", new RegExp("\\b" + esc(m[1].toLowerCase()) + SEP + esc(m[2].toLowerCase()) + "(?![\\d.])"));
    consumed.push([m.index, m.index + m[0].length]);
  }
  // 2. numbers with a unit or percent, decimals, and any 3+ digit figure
  const numRe = new RegExp("(?<![A-Za-z\\d.-])(\\d[\\d,]*(?:\\.\\d+)?)\\s?(" + UNITS + ")?(?![\\d,.]*\\d)", "gi");
  for (const m of sentence.matchAll(numRe)) {
    if (consumed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const n = m[1].replace(/,/g, "");
    const unit = m[2] ? m[2].toLowerCase() : "";
    const isPct = unit === "%" || unit === "percent";
    if (!unit && !n.includes(".") && n.length < 3) continue;   // "2 of", "three roles": too weak to be evidence
    if (isPct) add(n + "%", "figure", new RegExp("(?<![\\d.])" + esc(n) + "\\s?(?:%|percent)"));
    else if (unit) add(n + " " + unit, "figure", new RegExp("(?<![\\d.])" + esc(n) + SEP + esc(unit.replace(/s$/, "")) ));
    else add(n, "figure", new RegExp("(?<![\\d.])" + esc(n) + "(?![\\d.])"));
  }
  // 3. word numbers with a unit: "four hours", "seven days"
  const wordRe = new RegExp("\\b(" + Object.keys(WORD_NUMBERS).join("|") + ")\\s+(" + UNITS + ")\\b", "gi");
  for (const m of sentence.matchAll(wordRe)) {
    const n = String(WORD_NUMBERS[m[1].toLowerCase()]);
    const unit = m[2].toLowerCase().replace(/s$/, "");
    add(n + " " + unit, "figure", new RegExp("(?<![\\d.])" + esc(n) + SEP + esc(unit)));
  }
  // 4. acronyms: SAML, SCIM, KMS, SIEM, BYOK, OIDC, TOTP, RBAC, S3, OAuth-style tokens with digits
  for (const m of sentence.matchAll(/\b([A-Z]{2,6}\d{0,2})\b/g)) {
    if (GENERIC_ACRONYMS.has(m[1])) continue;
    add(m[1], "acronym", new RegExp("\\b" + esc(m[1].toLowerCase()) + "\\b"));
  }
  // 5. proper nouns that are not at the start of the sentence: Okta, Cure53, BSI, Sydney,
  //    Microsoft Entra ID. Sentence-initial capitals ("Yes.", "Our platform") are skipped.
  for (const m of sentence.matchAll(/\b([A-Z][a-z]+(?:\s(?:[A-Z][a-z]+|[A-Z]{2,}))*)\b/g)) {
    const before = sentence.slice(0, m.index).trim();
    if (!before || /[.!?:]$/.test(before)) continue;             // sentence start
    if (/^(?:The|Our|We|Yes|No|Partially|This|These|It|All|Each|Every)$/.test(m[1])) continue;
    add(m[1], "name", new RegExp("\\b" + esc(m[1].toLowerCase()).replace(/ /g, "\\s+") + "\\b"));
  }
  return [...found.values()];
}

/**
 * score(answer, context) -> {
 *   score:              supported specifics / all specifics (1 when the answer makes no specific claim)
 *   specifics:          [{ token, kind, supported }]
 *   unsupported:        tokens not found in the context (the candidates for invention)
 *   sentences:          number of sentences
 *   flagged_sentences:  sentences containing at least one unsupported specific
 * }
 */
function score(answer, context) {
  const ctx = norm(context);
  const sentences = splitSentences(answer);
  const seen = new Map();
  let flagged = 0;
  for (const s of sentences) {
    let bad = false;
    for (const sp of extractSpecifics(s)) {
      if (!seen.has(sp.token)) seen.set(sp.token, { token: sp.token, kind: sp.kind, supported: sp.re.test(ctx) });
      if (!seen.get(sp.token).supported) bad = true;
    }
    if (bad) flagged++;
  }
  const specifics = [...seen.values()];
  const supported = specifics.filter((s) => s.supported).length;
  return {
    score: specifics.length ? supported / specifics.length : 1,
    specifics,
    unsupported: specifics.filter((s) => !s.supported).map((s) => s.token),
    sentences: sentences.length,
    flagged_sentences: flagged,
  };
}

/* Fixed checks that pin down what the scorer catches and what it ignores. Run in CI. */
function selfTest() {
  const ctx = "All customer data is encrypted at rest using AES-256-GCM. Keys are managed in AWS KMS with " +
    "automatic annual rotation. The platform supports SAML 2.0 single sign-on with Okta and OneLogin. " +
    "The uptime commitment is 99.95% on the Enterprise plan. Critical vulnerabilities are remediated " +
    "within 7 days. ISO 27001:2022 certificate NW-27001-2024 was issued by BSI.";
  const t = [];
  const check = (name, answer, expectUnsupported) => {
    const r = score(answer, ctx);
    const got = r.unsupported.slice().sort().join("|");
    const want = expectUnsupported.slice().sort().join("|");
    t.push({ name, pass: got === want, detail: got === want ? "" : `expected [${want}] got [${got}]` });
  };
  check("faithful answer has no unsupported specifics",
    "Yes. Data at rest is encrypted with AES-256-GCM and keys live in AWS KMS. We support SAML 2.0 with Okta.", []);
  check("invented percentage is flagged", "Our uptime commitment is 99.999% on every plan.", ["99.999%"]);
  check("invented standard is flagged", "We also hold ISO 14001 certification.", ["ISO 14001"]);
  check("invented vendor is flagged", "We integrate with Okta and Ping Identity.", ["Ping Identity"]);
  check("invented duration is flagged", "Critical issues are fixed within 24 hours.", ["24 hours"]);
  check("word-number duration is resolved", "Critical issues are fixed within seven days.", []);
  check("separator variants are the same claim", "We use AES 256 GCM encryption at rest.", []);
  check("sentence-initial capitals are not claims", "Yes. Our platform supports this. Partially covered elsewhere.", []);
  check("small bare integers are ignored", "There are 2 options and 3 tiers.", []);
  check("acronym absent from context is flagged", "Access is managed through our RBAC and SCIM connectors.", ["RBAC", "SCIM"]);
  check("certificate number present passes", "Our certificate NW-27001-2024 was issued by BSI.", []);
  check("score reflects the unsupported share", "Keys live in AWS KMS. Our SLA is 99.999%.", ["99.999%"]);
  const last = score("Keys live in AWS KMS. Our SLA is 99.999%.", ctx);
  t.push({ name: "flagged sentence count is per sentence", pass: last.flagged_sentences === 1 && last.sentences === 2,
    detail: `sentences=${last.sentences} flagged=${last.flagged_sentences}` });
  return t;
}

module.exports = { score, selfTest, extractSpecifics, splitSentences };
