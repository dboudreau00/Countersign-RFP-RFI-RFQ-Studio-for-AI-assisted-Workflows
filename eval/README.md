# Answer-engine evaluation

Measures whether `engine.js` retrieves the right material and whether the answers drafted
from it are grounded in that material. Zero dependencies, one command, and a CI canary that
fails when quality regresses.

```bash
node eval/run.js                    # retrieval metrics, scorer self-tests, recorded-answer
                                    # groundedness; compared against baseline.json. Exit 1 on
                                    # regression. This is what CI runs.
node eval/run.js --live             # also draft fresh answers and score them
node eval/run.js --record           # --live, then save answers to answers.json
node eval/run.js --update-baseline  # accept the current numbers as the new floor
node eval/run.js --json             # full report as JSON
```

`--live` needs `ANTHROPIC_API_KEY` (uses the engine's own generation path, so it tests
production behaviour) or `GEMINI_API_KEY` (a small shim in `run.js`; set `GEMINI_MODEL` to
override `gemini-flash-lite-latest`).

## What is in here

| Path | Purpose |
|---|---|
| `corpus/` | A fictional vendor's documentation: security policy, architecture and SLA, API, pricing, support, data protection, plus a deliberately vague company overview that shares vocabulary with everything and states no facts. The overview is there so precision means something. |
| `cases.json` | The held-out set: 28 questions the corpus answers and 7 it does not. |
| `groundedness.js` | The groundedness scorer and its self-tests. |
| `run.js` | The runner. |
| `baseline.json` | The accepted numbers. Committed. |
| `answers.json` | Drafted answers recorded with `--record`, so groundedness can be scored deterministically in CI without an API key. The file names the model that produced them. |

## Metrics

Every case carries **anchors**: short phrases that identify a chunk as relevant to the
question (`"AES-256-GCM"`, `"Cure53"`, `"6 to 8 weeks"`). Labelling by phrase rather than by
chunk number keeps the labels valid when chunk size changes.

| Metric | Meaning |
|---|---|
| `p@k` | Share of the top-k retrieved chunks that contain at least one anchor. |
| `r@k` | Share of the case's anchors that appear somewhere in the top-k chunks. |
| `mrr` | Mean of 1 / rank of the first relevant chunk. |
| `gap_accuracy` | The engine's coverage score is meant to flag questions the documentation cannot answer. This is the share of cases where `coverage < gap_threshold` agrees with whether the case is a known gap. |
| `groundedness` | Share of an answer's specific claims (figures, durations, percentages, standards such as `ISO 27001`, acronyms, proper nouns) that appear in the context the model was given. An unsupported specific is the signature of an invented SLA, certification or partner. |
| `mention_rate` | Share of each case's `must_mention` facts that the answer states. |
| `answers_ok` | Share of answers that mention everything required, mention nothing forbidden, and (for gap compliance questions) do not open with `Yes`. |
| `forbidden_hits` | Count of `must_not_mention` phrases found across all answers. Lower is better. |

The retrieval metrics and gap accuracy are fully deterministic. Groundedness over
`answers.json` is deterministic too (fixed answers, fixed corpus, fixed scorer), which is why
recorded answers are what CI checks. Live answers vary between runs and are reported but
never compared against the baseline.

## The canary

`run.js` compares every aggregate against `baseline.json` with a tolerance of 0.001 and exits
non-zero if any is worse. `.github/workflows/eval.yml` runs it on every push and pull
request that touches `engine.js` or `eval/`. When a change legitimately improves a number
the run passes and marks it `up`; run `--update-baseline` to raise the floor.

To see the canary trip, break retrieval on purpose (for example, add `saml` to `STOP` in
`engine.js`) and run it.

## Adding cases

Add an object to `cases.json`. For a covered question give `anchors` (phrases that exist
verbatim in the corpus, case-insensitive) and `must_mention`; add `must_not_mention` for
things a hallucinating model tends to invent for that question. For a gap, set `gap: true`
and, for compliance questions, `verdict_not: "Yes"`. `run.js` refuses to start if an anchor
appears nowhere in the corpus, so a typo in a label cannot masquerade as a retrieval miss.

## What this does not measure

- The browser-side retrieval in `index.html` is a separate implementation with the same
  design. Only `engine.js` is exercised here.
- Groundedness is lexical. A paraphrased false claim with no specifics in it passes.
  Semantic judgement would need a model call, which is the thing this harness avoids in CI.
- Recorded answers reflect whichever model produced them; check the `model` field in
  `answers.json` before reading too much into a groundedness delta.
