/**
 * Groundedness scorer for drafted RFP answers (zero dependencies, deterministic).
 *
 * The question it answers: does the drafted answer derive from the retrieved context, or
 * did the model invent it? It does this by pulling the SPECIFIC claims out of the answer
 * (figures, durations, percentages, standards like "ISO 27001" or "TLS 1.3", acronyms,
 * and proper nouns) and checking each one against the material the model was given: the
 * retrieved context plus the question itself. An unsupported specific is exactly the class
 * of hallucination that sinks an RFP response: a made-up SLA, a certification the vendor
 * does not hold, an integration partner that does not exist.
 *
 * Matching tolerates the ways one fact gets written: "AES-256-GCM" and "AES 256 GCM",
 * "1,000" and "1000" and "1k", "three regions" and "3 regions", "4 hours" and "4 business
 * hours", a full stop after "TLS 1.1", a cell under a "Minimum seats" column header, and a
 * spelled-out name whose acronym is in the context ("Consumer Price Index" for "CPI").
 * Restating the question is not invention either: an answer to "Do you hold ISO 14001?"
 * may say "ISO 14001". Whether it may say "Yes" is for verdict_not in cases.json.
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
const NUMBER_WORDS = Object.fromEntries(Object.entries(WORD_NUMBERS).map(([w, n]) => [String(n), w]));
/* Acronyms that are vocabulary rather than claims. "Our SLA is 99.999%" invents the figure,
   not the word SLA. Standards, products and controls (SAML, SCIM, KMS, TOTP, SIEM, ISO, SOC,
   TLS, AES, OIDC, WAF...) are deliberately NOT here: asserting one of those is a claim. */
const GENERIC_ACRONYMS = new Set(("SLA SLAS API APIS SAAS RFP RFI RFQ IT HR UI UX SDK SDKS URL HTTP HTTPS SSO MFA PDF CSV " +
  "DOCX XLSX NDA FAQ KPI KPIS QA UAT ROI TCO CI CD IAM PII DR BCP DPA DPO GDPR CRM ERP ETA TBC TBD OK AM PM").split(" "));

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = "[\\s-]*";               // "AES-256-GCM", "AES 256" and "AES256" are the same claim
const QUAL = "(?:[a-z]+[\\s-]+)?";   // one qualifier between figure and unit: "4 business hours"
const END = "(?!\\d|\\.\\d)";        // not the start of a longer number; "TLS 1.1." at a sentence end is fine

/* Every way a figure gets written: 10000 = 10,000 = 10 000 = 10k, 3 = three. */
function numAlt(n) {
  const [int, frac] = n.split(".");
  const grouped = int.replace(/\B(?=(?:\d{3})+$)/g, "[,\\s]?");
  const alts = [grouped + (frac ? "\\." + esc(frac) : "")];
  if (!frac && NUMBER_WORDS[int]) alts.push(NUMBER_WORDS[int]);
  if (!frac && /000$/.test(int) && int.length <= 6) alts.push(int.slice(0, -3) + "\\s?k(?![a-z])");
  if (!frac && /000000$/.test(int)) alts.push(int.slice(0, -6) + "\\s?m(?![a-z])");
  return alts.length > 1 ? "(?:" + alts.join("|") + ")" : alts[0];
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s*\n\s*(?:[-*]|\d+[.)])\s+/g, ". ")     // a list item is a sentence of its own
    .replace(/([^.!?:\s])[ \t]*\n\s*\n/g, "$1. ")      // so is a paragraph that ends without punctuation
    .replace(/[*_`]+/g, "")                            // markdown emphasis is not part of a claim
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).map((s) => s.trim()).filter(Boolean);
}

/* The material a claim may legitimately come from: the retrieved context and the question.
   Rows of a comma-separated table get each cell paired with its column header, so a "5" in
   the "Minimum seats" column supports the claim "5 seats". */
function supportText(context, question) {
  const pairs = [];
  let header = null;
  // a header has short cells with no sentence punctuation; a prose line with commas does not
  const looksLikeHeader = (cells) => cells.length >= 4 && cells.every((c) => c.trim().length <= 40 && !/[.!?] /.test(c));
  for (const line of String(context || "").split(/\r?\n/)) {
    const cells = line.split(",");
    if (header && cells.length === header.length) {
      cells.forEach((cell, i) => {
        const h = header[i].trim(), v = cell.trim();
        if (h && v) pairs.push(v + " " + h + ". " + h + " " + v + ".");
      });
    } else header = looksLikeHeader(cells) ? cells : null;
  }
  return [String(context || ""), String(question || ""), ...pairs].join("\n");
}

/* Each specific is { token, kind, re, alt } where `re` tests the normalised support text and
   the optional `alt` tests the raw text (an acronym must appear in capitals to count). */
function extractSpecifics(sentence) {
  const found = new Map();
  const add = (token, kind, re, alt) => { if (!found.has(token)) found.set(token, { token, kind, re, alt }); };

  // 1. name + number pairs: ISO 27001, SOC 2, TLS 1.3, AES-256, PostgreSQL 16, WCAG 2.1
  //    The number inside a pair belongs to the pair; rule 2 must not count it again as a
  //    bare figure, or "ISO 14001" would be reported twice.
  const consumed = [];
  for (const m of sentence.matchAll(/\b([A-Z][A-Za-z]{1,14})[ -](\d[\d.]*[A-Za-z]?)\b/g)) {
    const before = sentence.slice(0, m.index).trim();
    // "Requires 5 seats" at the start of a sentence is prose, not a standard; ISO, SOC and
    // TLS keep their capitals wherever they sit, so all-caps names count everywhere
    if ((!before || /[.!?:]$/.test(before)) && !/^[A-Z0-9]+$/.test(m[1])) continue;
    add(m[1] + " " + m[2], "standard", new RegExp("\\b" + esc(m[1].toLowerCase()) + SEP + esc(m[2].toLowerCase()) + END));
    consumed.push([m.index, m.index + m[0].length]);
  }
  // 2. numbers with a unit or percent ("24 hours", "15-minute", one qualifier allowed as in
  //    "24 business hours"), decimals, and any 3+ digit figure
  const numRe = new RegExp("(?<![A-Za-z\\d.-])(\\d[\\d,]*(?:\\.\\d+)?)(?:[\\s-]?(?:[a-z]+[\\s-])?(" + UNITS + "))?(?![\\d,.]*\\d)", "gi");
  for (const m of sentence.matchAll(numRe)) {
    if (consumed.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const n = m[1].replace(/,/g, "");
    const unit = m[2] ? m[2].toLowerCase() : "";
    const isPct = unit === "%" || unit === "percent";
    if (!unit && !n.includes(".") && n.length < 3) continue;   // "2 of", "three roles": too weak to be evidence
    if (isPct) add(n + "%", "figure", new RegExp("(?<![\\d.])" + numAlt(n) + "\\s?(?:%|percent)"));
    else if (unit) add(n + " " + unit, "figure", new RegExp("(?<![\\d.])" + numAlt(n) + SEP + QUAL + esc(unit.replace(/s$/, ""))));
    else add(n, "figure", new RegExp("(?<![\\d.])" + numAlt(n) + END));
  }
  // 3. word numbers with a unit: "four hours", "seven days", "three business days"
  const wordRe = new RegExp("\\b(" + Object.keys(WORD_NUMBERS).join("|") + ")\\s+(?:[a-z]+\\s+)?(" + UNITS + ")\\b", "gi");
  for (const m of sentence.matchAll(wordRe)) {
    const n = String(WORD_NUMBERS[m[1].toLowerCase()]);
    const unit = m[2].toLowerCase();
    add(n + " " + unit, "figure", new RegExp("(?<![\\d.])" + numAlt(n) + SEP + QUAL + esc(unit.replace(/s$/, ""))));
  }
  // 4. acronyms: SAML, SCIM, KMS, SIEM, BYOK, OIDC, TOTP, RBAC, S3, OAuth-style tokens with digits
  for (const m of sentence.matchAll(/\b([A-Z]{2,6}\d{0,2})\b/g)) {
    if (GENERIC_ACRONYMS.has(m[1])) continue;
    add(m[1], "acronym", new RegExp("\\b" + esc(m[1].toLowerCase()) + "\\b"));
  }
  // 5. proper nouns that are not at the start of the sentence: Okta, Cure53, BSI, Sydney,
  //    Microsoft Entra ID, Write-Ahead Log. Sentence-initial capitals ("Yes.", "Our platform")
  //    are skipped. A name of two or more capitalised words is also supported by its acronym
  //    appearing in capitals: "Consumer Price Index" by "CPI", "Amazon Web Services" by "AWS".
  for (const m of sentence.matchAll(/\b([A-Z][a-z]+(?:-[A-Za-z]+)*(?:\s(?:[A-Z][a-z]+(?:-[A-Za-z]+)*|[A-Z]{2,}))*)\b/g)) {
    const before = sentence.slice(0, m.index).trim();
    if (!before || /[.!?:]$/.test(before)) continue;             // sentence start
    if (/^(?:The|Our|We|Yes|No|Partially|This|These|It|All|Each|Every)$/.test(m[1])) continue;
    const phrase = "\\b" + esc(m[1].toLowerCase()).replace(/[ -]+/g, "[\\s-]+") + "\\b";
    const caps = m[1].split(/[\s-]+/).filter((w) => /^[A-Z]/.test(w));
    const initials = caps.length >= 3 ? caps.map((w) => w[0]).join("") : "";
    add(m[1], "name", new RegExp(phrase), initials ? new RegExp("\\b" + initials + "\\b") : null);
  }
  return [...found.values()];
}

/**
 * score(answer, context, question) -> {
 *   score:              supported specifics / all specifics (1 when the answer makes no specific claim)
 *   specifics:          [{ token, kind, supported }]
 *   unsupported:        tokens found neither in the context nor in the question (the candidates for invention)
 *   sentences:          number of sentences
 *   flagged_sentences:  sentences containing at least one unsupported specific
 * }
 */
function score(answer, context, question) {
  const support = supportText(context, question);
  const ctx = norm(support);
  const sentences = splitSentences(answer);
  const seen = new Map();
  let flagged = 0;
  for (const s of sentences) {
    let bad = false;
    for (const sp of extractSpecifics(s)) {
      if (!seen.has(sp.token)) {
        const supported = sp.re.test(ctx) || (sp.alt ? sp.alt.test(support) : false);
        seen.set(sp.token, { token: sp.token, kind: sp.kind, supported });
      }
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
    "within 7 days. ISO 27001:2022 certificate NW-27001-2024 was issued by BSI. Data in transit uses " +
    "TLS 1.3; we do not support SSLv3, TLS 1.0 or TLS 1.1. Rate limits are 1,000 requests per minute " +
    "and the API add-on is billed per 10k calls. Data is hosted in one of three regions. Support " +
    "responds within 4 business hours. TOTP and WebAuthn are supported, and renewal uplift is capped " +
    "at CPI.\n" +
    "Plan,Licensing model,Minimum seats,Contract term\nStarter,Named user,5,Annual\nProfessional,Named user,25,Annual or 3-year\n";
  const t = [];
  const check = (name, answer, expectUnsupported, question) => {
    const r = score(answer, ctx, question);
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
  check("invented figure with a qualifier is still flagged", "Critical issues are fixed within 24 business hours.", ["24 hours"]);
  check("hyphenated figure and unit is a claim", "We commit to a 15-minute first response and a 4-hour target.", ["15 minute"]);
  check("word-number duration is resolved", "Critical issues are fixed within seven days.", []);
  check("word number in the context supports a figure", "Data can be hosted in 3 regions.", []);
  check("separator variants are the same claim", "We use AES 256 GCM encryption at rest.", []);
  check("thousands separator and k suffix are the same figure", "The limit is 1000 requests per minute, billed per 10,000 calls.", []);
  check("version number at the end of a sentence is found", "We do not support SSLv3, TLS 1.0 or TLS 1.1.", []);
  check("qualifier between figure and unit is the same claim", "Support responds within 4 hours.", []);
  check("table cell supports the figure under its column header", "Starter needs a minimum of 5 seats and Professional needs 25 seats.", []);
  check("spelled-out name whose acronym is in the context is supported",
    "Uplift is capped at the Consumer Price Index and factors include TOTP (Time-based One-Time Password).", []);
  check("spelled-out name whose acronym is absent is flagged", "We run on Google Cloud Platform.", ["Google Cloud Platform"]);
  check("terms restated from the question are not inventions", "No. We do not hold ISO 14001 and cannot provide a WCAG 2.1 AA VPAT.", [],
    "Do you hold ISO 14001 and can you provide a WCAG 2.1 AA VPAT?");
  check("sentence-initial capitals are not claims", "Yes. Our platform supports this. Partially covered elsewhere.", []);
  check("list items start their own sentence", "Two tiers:\n- **Starter:** Requires 5 seats.\n- **Professional:** Requires 25 seats.", []);
  check("small bare integers are ignored", "There are 2 options and 3 tiers.", []);
  check("acronym absent from context is flagged", "Access is managed through our RBAC and SCIM connectors.", ["RBAC", "SCIM"]);
  check("certificate number present passes", "Our certificate NW-27001-2024 was issued by BSI.", []);
  check("score reflects the unsupported share", "Keys live in AWS KMS. Our SLA is 99.999%.", ["99.999%"]);
  const last = score("Keys live in AWS KMS. Our SLA is 99.999%.", ctx);
  t.push({ name: "flagged sentence count is per sentence", pass: last.flagged_sentences === 1 && last.sentences === 2,
    detail: `sentences=${last.sentences} flagged=${last.flagged_sentences}` });
  return t;
}

module.exports = { score, selfTest, extractSpecifics, splitSentences, supportText };
