# Cortex MCP v2 (Phase 1 Prototype)

Project-local memory layer for AI agents, exposed as a Model Context Protocol (MCP)
stdio server. This is **Phase 1 prototype infrastructure** — scaffolding only,
not final product behavior.

## Status

Skeleton / prototype. `recall` returns `No relevant memory found.` Retrieval,
storage of raw text, and the embedding-only `Provider` interface in
`src/providers/{minimax,nvidia-nim}.ts` are stubbed behind explicit seams so
experiments can be run later.

`remember` is wired to a narrow real pipeline: a local safety pre-check
(`secret`, `mixed-safe-sensitive`, `raw-dump`, `vague-junk`,
`prompt-injection`, `unsafe-preference`, `self-conflict` classification),
a related-memory lookup seam (placeholder for now), the real provider
adapter (`src/providers/memory-analysis.ts`), controller validation +
normalization, and persistence of the controller-normalized summary +
metadata in the project-local SQLite store. Raw input is **never**
persisted. Outcomes are `saved`, `rejected`, `clarification_needed`, or
`provider_error`.

The **provider adapter** in `src/providers/memory-analysis.ts` is **not** a
skeleton: it is a real, tested adapter that performs chat-completion calls
against MiniMax (primary) and NVIDIA NIM (fallback) with a typed
primary→fallback policy, a same-provider LLM repair attempt on parse
failure, and a structured-output parser. It is consumed by the
prototype runner (not the MCP stdio server).

A separate **provider prototype runner** is wired up to exercise MiniMax
(primary), NVIDIA NIM (fallback), and **Groq** (prototype-only comparison
candidate) against a small set of P1..P6 memory-analysis fixtures through
the real adapter. The runner is **not** the MCP stdio server; it is a CLI
in `src/prototype/`. Groq is included so the operator can compare
`openai/gpt-oss-120b` across NIM and Groq before the retrieval work; the
production provider adapter is unchanged and does not read Groq config.
See "Provider prototype runner" below.

## Public API (stable for Phase 1)

Exactly two tools, each with exactly one public `text` parameter:

- `remember(text: string)` — store a piece of project memory.
- `recall(text: string)` — retrieve relevant project memory.

No kinds, states, filters, providers, debug, or storage arguments are accepted.

## Runtime

- Node >= 20 (developed against Node 22).
- TypeScript, ES modules.
- MCP transport: stdio. **All log output goes to stderr.** The stdio runtime
  must not write to stdout outside of the MCP protocol frames.

## Storage

Project-local hidden directory `.cortex/` at the project root. Contents are
gitignored. The skeleton initializes a local SQLite database. The `memories`
table stores controller-normalized summaries and metadata (id, kind, state,
summary, provider_id, model_id, confidence, safety_flags, metadata,
created_at, updated_at). **Raw original text is never persisted.** Schema
migrations are additive and idempotent.

## Providers

The provider layer is split into two parts:

- **Real adapter** — `src/providers/memory-analysis.ts`. A tested
  adapter that calls the chat-completions endpoint for MiniMax
  (primary) and NVIDIA NIM (fallback), with a primary→fallback
  policy, a same-provider LLM repair attempt on parse failure, and
  typed `AdapterSuccess` / `AdapterFailure` results. The HTTP
  client that backs the adapter (`src/providers/http-client.ts`)
  scrubs API keys and `Bearer ...` tokens from any error message
  it returns.
- **Embedding skeletons** — `src/providers/{minimax,nvidia-nim}.ts`
  implement the embedding-only `Provider` interface defined in
  `src/providers/types.ts`. These still return stub results and
  are intentionally placeholders for the embedding path; the
  memory-analysis path does not go through them.

Provider configuration is read from environment variables. No API keys are
hardcoded. See `docs/env.md`.

## Retrieval benchmark (current baseline)

A small, self-contained measurement harness for the current
lexical baseline lives in `src/benchmark/`. It loads a hand-curated
fixture corpus and a hand-curated query set into memory, runs the
production `rankLexical` function against every query, and emits a
sanitized JSON report under `.cortex/benchmark/` (gitignored).
The harness does NOT open the database, does NOT call any
provider, and does NOT touch the network. The fixture corpus
contains only sanitized memory summaries (no raw input, no
credentials); corpus hygiene is regression-checked by
`tests/retrieval-benchmark.test.ts`.

### Corpus + query set (adversarial-expansion checkpoint)

The fixture corpus and query set are the **adversarial-expansion**
checkpoint of 132 records and 176 queries, with the 6 documented
query families. The expansion is a deliberate step between
the original 24-record / 24-query starter set, the 60-record /
54-query intermediate set, the 100-record / 96-query expanded
set, and a future larger checkpoint. The per-family distribution
is:

| Family        | Queries | Notes                                                              |
|---------------|---------|--------------------------------------------------------------------|
| `exact`       | 20      | Direct technical-term recall; 6 added in the expansion.          |
| `paraphrase`  | 32      | Paraphrased vocabulary; 20 added, 4 with the `adversarialParaphrase` label and 4 with the `nearMissCurrentCluster` label. |
| `temporal`    | 26      | Current vs old; 14 added, 5 of them labeled divergent (raising total divergent from 2 to 7). |
| `multi-hop`   | 26      | Multi-slot / list queries; 10 added, including 2 with the `nearMissCurrentCluster` label. |
| `no-answer`   | 46      | No relevant memory; 22 added, 15 labeled `hardNegative`, 4 with the `negation` label, 4 with the `falsePremise` label. |
| `orientation` | 26      | Project-status; 8 added, 2 with the `nearMissCurrentCluster` label. |
| **total**     | **176** | 132 records across 33 topical clusters of 4 records each.        |

The per-family growth (added in the adversarial-expansion phase)
is: exact +6, paraphrase +20, temporal +14, multi-hop +10,
no-answer +22, orientation +8 (= 80 added queries on top of
the 96-query expanded-checkpoint set, which is preserved
unchanged as the baseline).

Tests in `tests/retrieval-benchmark.test.ts` pin the
adversarial-expansion minimums (≥ 132 records, ≥ 176 queries,
≥ 6 queries per family) and the per-family distribution. The
6 families are documented and stable; adding a new family
requires a schema-level review.

The 132 records span 33 topical clusters of 4 records each:
the original 12 clusters (stack, deploy, people, office, docs,
temporal-old, testing, security, dependencies, monitoring,
team-process, entity-domain), the 3 intermediate clusters
(stack-extensions, testing-extensions, historical-extensions),
the 10 expanded-set clusters (ci-extensions, observability-
extensions, security-extensions, agent-runtime, data-pipeline,
client-sdk, feature-flags, provider-routing, legacy-extensions,
testing-extensions-2), and **8 new adversarial-expansion
clusters** (adversarial-conflict, adversarial-superseded,
adversarial-near-miss, adversarial-paraphrase-twin,
adversarial-temporal-current-vs-previous, adversarial-false-
premise-anchor, adversarial-orientation-extension,
adversarial-multi-hop-bridge). The new clusters are designed
to surface adversarial shape pressure: conflict / supersession
records that the ranker can mis-rank as the current fact;
near-miss records that are close to a current cluster but
name a different specific fact; paraphrase-twins that
paraphrase a current record with deliberately low lexical-
overlap vocabulary; current-vs-previous anchors that pair a
CURRENT fact with a NEAR-MISS / PREVIOUS fact in the same
cluster; false-premise-anchors that mention NEAR-MISS tools
the project does NOT officially use (and are NOT in the
existing `FALSE_PREMISE_TOKENS` / `OOD_ENTITY_TOKENS` lists);
orientation-extension records that exercise the "newer record"
while still having the older record as a near-miss; and
multi-hop-bridge records that are the MISSING BRIDGE in a
multi-hop query.

The orientation distractor set stays `{13..16, 21..24}`; the
new historical-extensions and legacy-extensions clusters
(57..60 and 93..96) are the legacy record sets used for
the temporal current-truth divergence cases and as
token-overlap distractors for the new temporal queries. The
no-answer family is exercised by 22 new queries, including
15 labeled `hardNegative` queries (the original
`nonexistent-load-balancer` plus 14 new ones on the
cluster-31 false-premise-anchor surface and the cluster-26
conflict / cluster-27 superseded surfaces), 4 labeled
`negation` queries, and 4 labeled `falsePremise` queries.

#### Adversarial-property labels (fixture truth)

A subset of the new queries carry an OPTIONAL
`labels?: string[]` field on the `BenchmarkQuery` object
(see `src/benchmark/queries.ts` for the type definition).
The field is purely additive: existing queries do NOT
have it, and tests that key on the absence of a label
are still well-formed when the field is missing. The
recognized label values are:

- `"hardNegative"` — a no-answer query that shares strong
  tokens with a real record and is expected to confabulate.
  Detector side: `isNoAnswerHardNegative`.
- `"falsePremise"` — a query that asserts a premise the
  corpus does not name (matches the `isFalsePremiseLike`
  detector intent at the fixture level).
- `"negation"` — the query contains a negation token
  (a sub-label of `falsePremise` / `hardNegative` /
  answerable depending on the family).
- `"adversarialParaphrase"` — a paraphrase query
  deliberately chosen for low lexical overlap with the
  expected record (the hardest case for the token-overlap
  ranker). Detector side: `isAdversarialParaphrase`.
- `"divergentTemporal"` — a temporal query with
  `expectedIds` and `currentTruthIds` deliberately
  diverged (the labeled "current-truth@1" gap cases;
  see the `DIVERGENT_TEMPORAL_IDS` set in
  `abstention-audit-runner.ts`). Detector side:
  `isDivergentTemporal`.
- `"nearMissCurrentCluster"` — a query whose top-1 is
  expected to be a near-miss distractor (a record in
  the same topical cluster as the expected record but
  with the wrong specific fact). Detector side:
  `isNearMissCurrentCluster`.

The labels are NOT derived from the query-shape detector;
they are the fixture's hand-curated truth. The detector
is the heuristic that approximates the labels at runtime;
a labeled query is the anchor the detector can be
checked against. The query-shape detector adds three
new boolean flag fields to the per-query `AbstentionSignals`
block: `isAdversarialParaphrase`, `isDivergentTemporal`,
`isNearMissCurrentCluster` (each additive, backward-
compatible — existing query-shape flags are unchanged).

The adversarial-expansion query set has 15 `hardNegative`
queries, 7 `falsePremise` queries (4 of which are also
`negation`), 4 `adversarialParaphrase` queries, 7
`divergentTemporal` queries, and 7 `nearMissCurrentCluster`
queries (some queries carry multiple labels; the union
covers ~80 distinct queries out of the 80 new queries
added in the expansion).

### What it measures

The benchmark reports three distinct notions of "correctness"
for positive queries, and they are kept separate on purpose so
the ranker's failure modes are visible in the headline number:

- **hit@1 / hit@3 / hit@5** for positive queries — did the
  expected memory id appear anywhere in the ranker's top-K?
  This is the **generous** contract: a relevant id in the top-5
  is "retrievable" even if it is not the top hit. The lexical
  baseline is a candidate retriever, not a synthesizer, so
  hit@K is the right contract for retrieval-only coverage.
- **rank1 (top-hit)** for positive queries — was the TOP
  result one of the expected ids? This is the **stricter**
  contract: the candidate the controller will hand to the
  synthesizer / surface to the user is the one at rank 1, not
  the one at rank 3. By construction, `rank1 == hit@1`.
- **current-truth@1** for positive queries — was the TOP
  result one of the `currentTruthIds`? For non-temporal
  families this is the same as `rank1` by construction (the
  "right" answer is always the current one). For the
  `temporal` family this is the metric the reviewer flagged:
  the old fact can be in the top-K (so hit@K passes) but
  still rank above the current fact (so current-truth@1
  fails). The gap between hit@K and current-truth@1 is the
  temporal failure mode, surfaced in the headline number.
  A small labeled set of `temporal` queries (two in the
  expanded set: `temp-storage-raw-text` and
  `temp-controller-validation`) deliberately has
  `expectedIds` containing both the old and the new fact,
  with `currentTruthIds` containing only the new fact; this
  makes the divergence between hit@K and current-truth@1
  explicit in the data, not implicit in the family name.
- **no-answer TNR** — for queries with no relevant memory in
  the corpus, did the ranker return zero hits?
- **per-family breakdown** — the queries are split into six
  families so the failure modes of the lexical baseline are
  visible:
  - `exact` — verbatim-ish token overlap (easy case)
  - `paraphrase` — same idea, different vocabulary
  - `temporal` — current fact expected; old fact is a distractor
  - `multi-hop` — answer requires joining multiple memories
  - `no-answer` — no relevant memory in the corpus
  - `orientation` — project-status queries; expected ids
    cover the current state and the noisyReturnRate metric
    surfaces distractor bleed.
  Each family row shows `rank1`, `curTruth@1`, `hit@1`,
  `hit@3`, `hit@5` side by side.
- **rank-1 misses list** — every positive query whose TOP
  result is wrong, regardless of whether hit@K passed. This
  is what makes the temporal wrong-rank1 case visible at a
  glance: a query can be in this list (and a temporal query
  IS expected to be) while still being removed from the
  hit@K failure list.
- **failure list (hit@K)** — query id, family, expected ids,
  actual top ids, and a short reason for every miss under
  the hit@K contract.

The current baseline is intentionally a token-overlap ranker
with a small exact-phrase boost. The benchmark is the reference
point for later A/B comparisons against future variants
(`fts5`, `vector`, `hybrid-rrf`, `hybrid-rerank`,
`hybrid-entity-temporal`).

### How to run

```sh
# Default run (production threshold 0.2, top-K 5, all families)
npm run benchmark:retrieval

# Restrict to one family (useful for A/B on a single failure mode)
npm run benchmark:retrieval -- --only-family paraphrase

# Override threshold or top-K
npm run benchmark:retrieval -- --threshold 0.5 --top-k 10

# Override the artifact directory
npm run benchmark:retrieval -- --artifacts /tmp/my-bench
```

A JSON report is written under `.cortex/benchmark/`. Each report
contains: generated timestamp, variant, config, per-query evals
(top ids, top scores, pass/fail, reason), aggregate metrics,
and a failures list. No API keys, no Authorization headers, no
network artifacts.

### How to interpret the report

Three numbers to look at for any future A/B comparison:

1. **rank1 / current-truth@1** — the strict top-hit metric.
   This is what a user actually sees first; if it is low,
   the ranker is putting the right answer somewhere in the
   list but burying it. For the current lexical baseline, the
   reviewer noted that `temporal` rank1 is well below
   `temporal` hit@5, and the gap is the temporal failure
   mode made visible.
2. **hit@1 / hit@3 / hit@5** — the retrieval-coverage
   contract. A passing query under hit@K means "at least one
   expected id appeared in the top-K". A positive query can
   still be useful even if it misses rank-1 — the lexical
   baseline is a candidate retriever, not a synthesizer, so
   retrieval-only coverage is the right metric for the
   "is the right id in the candidate set?" question.
3. **no-answer TNR** — the abstention contract. A high TNR
   means the ranker is not over-triggering on tokens that
   have no relevant memory.

A query in the **rank-1 misses** list is one where the top
result is wrong even if hit@K passed. A query in the
**failures** list is one where hit@K also failed. The
temporal family is expected to show up in the rank-1 misses
list but NOT in the hit@K failures list: the old fact is
above the new one, but both are in the top-K. The gap
between the two lists is the temporal failure mode.

## Benchmark metrics and reporting foundation

In addition to the headline `hit@K` / `rank1` /
`currentTruth@1` / `no-answer TNR` numbers, the runner
emits a small set of derived IR metrics, no-answer
confusion-matrix counts, current-truth diagnostics,
multi-hop coverage, score diagnostics, and an
orientation sub-aggregate, alongside a deliberately
disabled answer-quality scaffold. The goal of these
extras is to make the ranker's failure modes visible
without changing the headline contract: every
existing report consumer and test assertion that
references the headline numbers still works
unchanged. The new sections appear as labeled
blocks in both the JSON report and the human
report.

### Derived IR metrics (positive queries)

Computed over the ranker's actual top-K (whatever
size it returned), then micro-averaged across
positive queries:

- **precision@5** — `TP / (TP + FP)` across the
  positive queries. A relevant id in the candidate
  set AND not overwhelmed by distractors.
- **recall@5** — `TP / (TP + FN)` across the
  positive queries. A relevant id in the candidate
  set at all.
- **F1@5** — harmonic mean of precision@5 and
  recall@5. The single-number retrieval-quality
  summary, useful for A/B comparisons.
- **MRR@5** — mean reciprocal rank of the FIRST
  expected id in the top-K, clipped at 5. 0 for
  positive queries whose top-K contains no
  expected id.

The raw TP / FP / FN counts that drive these
percentages are also reported so a reviewer can
re-derive anything by hand. The numbers are
intentionally the micro-average of per-query
precision / recall, not the macro-average, so
they match the `hit@K` headline at the corpus
level.

### No-answer confusion matrix

The "did the system answer this query at all"
binary classification, reported as a confusion
matrix in the symmetric direction so the
abstention and confabulation signals are both
visible:

- **TP** — positive query with non-empty top-K
  (the ranker found something).
- **FN** — positive query with empty top-K
  (the ranker failed to find anything).
- **TN** — no-answer query with empty top-K
  (the ranker correctly abstained).
- **FP** — no-answer query with non-empty top-K
  (the ranker confabulated).

From these we derive:

- **specificity (TNR)** — `TN / (TN + FP)`. The
  abstention rate: when the ranker abstains, is
  it right?
- **confabulation (FPR)** — `FP / (FP + TN)`. The
  inverse: when the ranker SHOULD abstain, does it
  sometimes surface candidates anyway?
- **answer coverage** — `TP / positiveTotal`. The
  headline "did the ranker find anything" rate
  (numerically identical to the existing
  `hit@K / positiveTotal`).
- **abstention precision** — `TN / (TN + FN)`. The
  probability that, given the system abstained, the
  abstention was correct.

The TNR number is a direct measure of the ranker's
existing abstention behavior. A separate opt-in
**calibration experiment** studies how to set
abstention gates that improve TNR at the cost of some
positive-query regressions. See
[Calibration experiment](#calibration-experiment-benchmark-only-abstention-gates)
below for the trade-off curves and per-query
diagnostics.

### currentTruth diagnostics (positive queries)

The headline `currentTruth@1` count is the
reviewer-flagged metric for the temporal family:
the old fact can be in the top-K (so `hit@K`
passes) but still rank above the current fact
(so `currentTruth@1` fails). The derived block
adds:

- **currentTruth@1 / @3 / @5** — counts of positive
  queries whose top-K contains a `currentTruthId`
  at rank 1 / within the top 3 / within the top 5.
  For non-temporal families these equal
  `rank1` / `hit@3` / `hit@5` by construction (the
  expected id IS the current fact). For the
  `temporal` family the @3 / @5 numbers let a
  reviewer see whether the current fact appears
  anywhere in the top-K vs only at the top.
- **currentTruthRecall@5** —
  `currentTruthAt5 / positiveTotal`. The
  current-fact coverage rate.

### Multi-hop coverage

For the `multi-hop` family, a query may declare
multiple expected ids (the answer requires joining
multiple memories). The derived block reports:

- **partial coverage** — fraction of multi-hop
  queries whose top-K contained AT LEAST ONE
  expected id. Numerically identical to the
  `hit@K` rate for the family.
- **complete coverage** — fraction of multi-hop
  queries whose top-K contained EVERY expected id.
  The "list-coverage" view: did the ranker pull
  the whole list?

### Score diagnostics

The runner is a candidate retriever, but the
ranker also emits a per-candidate score. The
derived block surfaces a small set of score
diagnostics so a future re-ranker stage can be
A/B'd against the baseline without re-deriving
the numbers by hand:

- **meanTopScore (all / pass / fail / no-answer)** —
  the average top-1 score broken down by outcome.
  A high `meanTopScoreNoAnswer` is a confabulation
  signal: the ranker is returning confidently-wrong
  candidates for queries that should return nothing.
- **meanScoreGap1To2** — average score difference
  between rank-1 and rank-2 across positive queries
  that have at least two candidates. A small gap
  means the ranker is barely confident; a large
  gap means the rank-1 is clearly the best.
- **meanReturnedCount** — average number of
  candidates the ranker returned per query
  (the ranker may return fewer than top-K for a
  no-match query).

The score sample counts (`n=...`) are reported
alongside the means so a small sample size is
visible in the report.

### Orientation / project-status family

The `orientation` family is its own
sub-aggregate, scoped to project-status queries.
The block reports:

- **recall@1 / @3 / @5** — at-least-one-expected
  in the top-K, scoped to orientation queries.
- **slotCoverage@5** — a query may declare
  multiple "slots" (e.g. "current Postgres
  version AND current release schedule"). The
  slot coverage is `sum(slots_hit) /
  sum(slots_expected)`: the fraction of all
  expected slots that the top-K covers, not the
  fraction of queries that covered all of their
  slots. This is more informative for multi-slot
  queries than the binary `recall@K`.
- **noisyReturnRate** — fraction of orientation
  queries whose top-K contains a known distractor
  (an `office` record in 13..16 or a historical
  record in 21..24). The distractor set is
  hand-rolled in `getKnownDistractorIds()` so a
  reviewer can see the rule; the distractor ids
  are regression-tested.
- **meanNoisePerQuery** — mean number of
  distractor candidates in the top-K across
  orientation queries. Complements
  `noisyReturnRate`: a query can be "noisy"
  (binary yes) but mostly-signal (a single
  distractor tucked at the end) or mostly-noise
  (every candidate is a distractor).
- **currentTruthCoverage@5** — fraction of
  orientation queries whose top-5 contains a
  `currentTruthId`. For the current corpus (no
  orientation temporal gap) this equals
  `recallAt5`; the field is kept separate so a
  future corpus revision that introduces an
  orientation temporal gap can be scored without
  a metrics schema change.

### Answer-quality scaffold (disabled)

The report carries an `answerQuality` block that
is **always `enabled: false` in this phase**. The
scaffold is exported, the runner always emits
`enabled: false` with `null` provider and `null`
evaluations, and the human report labels the
block with the stable string
`answer-quality: disabled (scaffold only, no LLM judge)`.
A future phase can flip the flag and populate
`evaluations` with per-query faithfulness labels
without changing the report shape. **No provider
is invoked and no LLM judge is called in this
phase.** The retrieval benchmark is intentionally
retrieval-only: scoring generated answers is
explicitly out of scope.

### Bootstrap CI (available, not reported)

A deterministic `bootstrapCi` helper is exported
from `src/benchmark/metrics.ts` for a binary
metric's 95% confidence interval. The helper
resamples pass/fail outcomes with replacement
using a fixed seed, sorts the resampled
proportions, and returns the 2.5 / 97.5
percentile bounds. Determinism is important
because the benchmark report is checked in as a
regression artifact; a non-deterministic CI
would make byte-equal comparisons noisy.

The runner does **not** include bootstrap CIs
in the headline number; the human report shows
the raw count + percentage, and any future
reporter that wants a CI can call
`bootstrapCi(outcomes)` directly. The helper
is regression-tested for determinism, the
`low <= high` invariant, the all-pass /
all-fail collapse cases, and the empty-input
edge case.

### Limitations of the new foundation

- **The new metrics are adversarial-shaped.** The
  adversarial-expansion fixture corpus and
  query set (132 records / 176 queries) add
  8 new topical clusters focused on
  adversarial shape pressure: conflict /
  superseded records, paraphrase-twins with
  low lexical overlap, near-miss distractors,
  current-vs-previous anchors, false-premise
  anchors, orientation extensions, and
  multi-hop bridges. The expansion adds 5
  more labeled divergent current-truth
  temporal cases (raising the total from
  2 to 7), 15 labeled hard-negative queries
  (the labeled confabulation-pressure set),
  4 labeled negation-shaped queries, 4
  labeled adversarial paraphrases, and 7
  labeled near-miss queries. The labels are
  fixture truth (not derived from the
  query-shape detector), and the detector
  surfaces them as additive boolean flags
  on the per-query `AbstentionSignals` block.
- **The new metrics do not change the
  headline contract.** Existing report
  consumers and test assertions that
  reference `hit@1 / hit@3 / hit@5 / rank1 /
  currentTruthAt1 / no-answer TNR` still work
  unchanged. The new blocks are additive.
  The one contract update is the divergent
  `currentTruthIds` for the labeled temporal
  cases: the strict-mirror test in
  `tests/retrieval-benchmark.test.ts` was
  updated to a subset invariant (every
  `currentTruthId` is also an `expectedId`)
  and a labeled divergent-queries set
  containing 7 query ids (the original 2
  plus 5 new in the expansion). The headline
  numbers shift (the lexical baseline rank1
  moves from 43/72=59.7% on the
  expanded-checkpoint to 82/130=63.1% on
  the adversarial-expansion checkpoint, and
  the noAnswerCorrect moves from 5 to 3)
  because the new corpus adds 32 candidate
  records AND 80 new queries; the
  headline-reading contract is unchanged.
- **No-answer family exercises
  confabulation pressure.** The expansion
  adds 22 no-answer queries, including
  15 labeled `hardNegative` queries
  (the original `nonexistent-load-balancer`
  plus 14 new ones on the cluster-31
  false-premise-anchor surface and the
  cluster-26 conflict / cluster-27
  superseded surfaces). The lexical baseline
  confabulates on most of the new
  hard-negatives at the production default
  threshold of 0.2, so the no-answer TNR
  is exercised against confabulation
  pressure, not only against zero-overlap
  queries. The current 132-record /
  176-query baseline produces no-answer TNR
  ≈ 6.5% on the lexical variant (down from
  ≈ 21% on the prior 100-record / 96-query
  set); this is the calibration experiment's
  input, not a regression.
- **The lexical baseline numbers shift
  between checkpoints.** The new corpus
  adds 32 candidate records that the
  lexical ranker can now surface, AND 80
  new queries (54 positive, 22 no-answer
  + 4 negation-shaped no-answer). The
  aggregate shifts in expected ways:
  rank-1 rises (43 → 82) because the new
  positive queries mostly find their
  target in the new clusters; noAnswerCorrect
  drops (5 → 3) because the new
  false-premise-anchor records share tokens
  with several existing no-answer queries
  and turn some "easy" no-answer queries
  into hard-negatives. The shape of the
  shift is honest research evidence, not a
  regression.
- **Bootstrap CIs are available but not
  reported.** With ~96 queries per run the
  resampled intervals are still wide for
  per-family percentages; surfacing them
  in the headline number would invite
  over-interpretation. The helper is exported
  for any future reporter that wants them.
- **Answer-quality evaluation is disabled.**
  Scoring generated answers requires an LLM
  judge (or a heuristic) and is explicitly
  out of scope for the retrieval-only
  benchmark phase. The scaffold is the
  placeholder; flipping `enabled` to `true`
  is a deliberate, visible change.

## Retrieval benchmarks (current state)

The benchmark harness supports six retrieval variants. The
lexical variant is the production baseline; the FTS5,
vector, hybrid (RRF), vector-dense, and hybrid-dense
variants are **benchmark-only comparison points** — they
are not wired into the production `recall(text)` controller
and the public MCP API is unchanged.

Implemented variants:

- `lexical` — the production `rankLexical` baseline
  (token overlap + exact-phrase boost).
- `fts5` — benchmark-only `rankFts5` (in-memory SQLite FTS5
  with BM25). See `src/benchmark/variants/fts5.ts`.
- `vector` — benchmark-only `rankVector` (cosine similarity
  over a deterministic local hashed-bag-of-words embedding).
  See `src/benchmark/variants/vector.ts`. The variant
  exposes a `VectorEmbedder` interface so a real local
  embedder (ONNX, sentence-transformers, etc.) can be
  plugged in by passing a custom `embedder` to
  `rankVector` or the runner; the default embedder is
  dependency-free and CI-stable. The `vector` variant is
  preserved as a deterministic control for the
  `vector-dense` variant below.
- `hybrid` — benchmark-only `rankHybrid` (Reciprocal Rank
  Fusion over lexical / FTS5 / vector). See
  `src/benchmark/variants/hybrid.ts`. RRF fuses the three
  contributing rankings by rank — not by raw score — using
  the conventional `score = Σ weight / (k + rank)` formula.
  Default `k = 60`; the benchmark sweep covers
  `k ∈ {20, 60, 100}`. The variant is **rank-only** and does
  not introduce an abstention gate of its own; calibration
  of the fusion is a future phase.
- `vector-dense` — benchmark-only `rankDenseVectorAsync`
  (cosine similarity over a real local dense embedding
  via a pluggable `DenseEmbedder`). The default
  embedder is a deterministic stub
  (`StubDeterministicDenseEmbedder`); the
  `transformersjs` backend runs a real local ONNX model
  (`Xenova/all-MiniLM-L6-v2`, quantized, 384-dim) via
  `@xenova/transformers`. See
  `src/benchmark/variants/dense-embedder.ts` and
  `src/benchmark/variants/dense-vector.ts`.
- `hybrid-dense` — benchmark-only `rankHybridAsync`
  (RRF over lexical / FTS5 / `vector-dense`).
  Asynchronous, async-only entry point. The
  contributor's source label on the diagnostic is
  `vector-dense` so a reviewer can see which embedder
  produced each rank-1 hit.

Not yet implemented (placeholders):

- `hybrid-rerank` — hybrid with a cross-encoder rerank stage.
- `hybrid-entity-temporal` — hybrid with entity/temporal reweighting.

### Vector variant: scope, determinism, and limitations

- **Scope.** The vector variant is benchmark-only. It runs
  entirely in memory, never opens the project
  `.cortex/cortex.sqlite`, and does not change the public
  `recall(text)` API. Source-tree guards in
  `tests/retrieval-vector.test.ts` enforce this with the
  same shape as the FTS5 guards.
- **Default embedder.** `HashedBagOfWordsEmbedder` uses the
  FNV-1a hashing trick with the sign trick, sub-linear TF
  (`log(1 + tf)`), optional TF-IDF weighting fitted on the
  benchmark corpus, and L2 normalization. There is no model
  download, no native dependency, no network, and no GPU.
  The same input text produces the same vector on every
  machine, every run. Determinism is regression-tested.
- **Extension point.** The `VectorEmbedder` interface is the
  stable contract for plugging in a real local embedder.
  Future work can add an ONNX-backed implementation without
  touching the ranker or the benchmark runner.
- **Default threshold is `0` (no filter).** Mirroring the
  FTS5 default, the ranker does not impose a hard cosine
  cut. Cosine similarity of unit-normalized non-negative
  vectors is in `[0, 1]`, so the default threshold passes
  every candidate with any non-zero overlap. Callers that
  want a stricter no-answer TNR can pass `--threshold
  <n>` (e.g. `0.99` for the strictest filter) or extend
  the runner with a relative-threshold helper in a later
  phase.
- **What the default config produces.** On the 100-record
  sanitized expanded-checkpoint fixture corpus + 96
  queries the vector variant reaches the headline numbers
  reported by the `benchmark:retrieval:all` run (the
  artifact under `.cortex/benchmark/` is the source of
  truth; the README does not pin specific percentages so a
  corpus / query set change does not require a doc
  update). The vector variant's `no-answer TNR = 0%` at
  the default threshold of 0 is a known limitation of the
  default; callers that need abstention should pass a
  positive threshold or extend the runner.

### Dense embedding variant (`vector-dense` / `hybrid-dense`)

The dense phase adds a **pluggable real local
semantic-embedding backend** behind the existing
`VectorEmbedder` seam. The architecture is the same as
the existing four sync variants: a benchmark-only
comparison point, no production path or MCP API change,
source-tree guards pin the whitelist, and the existing
`vector` (hashed-BoW) variant is preserved as a control.

#### Why a real local embedder

The hashed-BoW control is a useful, CI-stable baseline
but it is fundamentally a token-overlap ranker in dense
disguise: two texts that share tokens share vector
components, two texts that don't share tokens
decorrelate. A real semantic embedder captures
paraphrase / synonym / topic-level similarity that
token overlap misses. The benchmark uses
[`@xenova/transformers`](https://github.com/xenova/transformers.js)
(v2.17+) for the local ONNX forward pass:

- The library runs ONNX models entirely on the local
  machine (CPU; no GPU required). The model is
  downloaded once from the Hugging Face CDN and cached
  on disk.
- The default pinned model is
  `Xenova/all-MiniLM-L6-v2` (quantized, 384-dim,
  ~25MB cached, ~700ms first-load on a modern CPU).
  The model is a sentence-transformers MiniLM; the
  quantized form is bit-deterministic for a fixed
  input and a fixed runtime.
- The architecture is **local-only**: no external API,
  no key, no remote inference. The first-run model
  download is the only network call and it is to the
  Hugging Face CDN, the same fetch any first-run user
  of the library would do.

#### Embedder interface and metadata

The `DenseEmbedder` interface in
`src/benchmark/variants/dense-embedder.ts` is the
stable contract. Every embedder carries a
`metadata` block on the report:

```json
"config": {
  "embeddingBackend": {
    "backend":   "transformersjs",
    "modelId":   "Xenova/all-MiniLM-L6-v2",
    "dim":       384,
    "quantized": true,
    "runtimeVersion": "2.17.2",
    "status":    "ready",
    "loadMs":    898,
    "embedMs":   20702,
    "embedCount": 3294,
    "cacheDir":  "<cwd>/.cortex/transformers-cache"
  }
}
```

`status` distinguishes:
- `"ready"` — the embedder actually executed the
  queries / corpus during the benchmark.
- `"skipped"` — the runner was configured with
  `--dense-skip` and the embedder was not invoked.
- `"error"` — the embedder failed at construction or
  first use; the runner falls back to the deterministic
  stub so the report shape is preserved. The error
  message is captured on `errorMessage`.

The same metadata is on the `--variant all-dense`
comparison report and on each per-variant artifact
(`retrieval-vector-dense-*.json` /
`retrieval-hybrid-dense-*.json` /
`retrieval-compare-dense-*.json`).

#### Implementations

- `StubDeterministicDenseEmbedder` — dependency-free
  deterministic projection (feature hashing + L2
  normalization). Default. CI-friendly, no model
  download. Dim is configurable (`stub-dense:dim=128`).
- `TransformersJsEmbedder` — the real local ONNX
  embedder. Async `init()` builds the pipeline once;
  sync `embed()` / async `embedBatch()` calls are
  the hot path. Falls back to the stub when
  `init()` fails or `--dense-skip` is set, so a
  transient network failure does not break the
  benchmark.
- A custom embedder can be plugged in by implementing
  the `DenseEmbedder` interface and passing it to
  `runDenseRetrievalBenchmark({ denseEmbedder })`.
  The benchmark does NOT take ownership of the
  embedder's lifecycle.

#### CLI flags

| Flag | Default | Notes |
|---|---|---|
| `--variant vector-dense` / `hybrid-dense` / `all-dense` | `lexical` | Async dense variants. The sync `runRetrievalBenchmark` throws on them. |
| `--embedder stub-dense` | `stub-dense` | Deterministic, no model download. |
| `--embedder stub-dense:dim=N` | `dim=64` | Stub with a custom dim. |
| `--embedder transformersjs` | `Xenova/all-MiniLM-L6-v2` (quantized) | Real local ONNX embedder. |
| `--embedder transformersjs:model=<id>,quantized=true\|false` | — | Custom model id / quantization. |
| `--dense-cache-dir <path>` | `<cwd>/.cortex/transformers-cache/` | Local model cache directory. |
| `--dense-skip` | off | Skip live model execution; use the stub. Useful for CI without network. |

#### How to run

```sh
# Deterministic stub (default; no model download; CI-friendly)
npm run benchmark:retrieval:vector-dense
npm run benchmark:retrieval:hybrid-dense
npm run benchmark:retrieval:all-dense

# Real local model (first run downloads ~25MB to .cortex/transformers-cache)
npm run benchmark:retrieval:vector-dense:real
npm run benchmark:retrieval:hybrid-dense:real
npm run benchmark:retrieval:all-dense:real

# Skip the model execution explicitly (deterministic-only)
npm run benchmark:retrieval:vector-dense:skip
```

The first real run downloads the ONNX model to
`<cwd>/.cortex/transformers-cache/` (override via
`--dense-cache-dir <path>`). Subsequent runs use the
local cache. No external API is called; the model is
100% on-device.

#### Measured results (132-record corpus, 176 queries)

The adversarial-expansion fixture corpus and query set
is the third step between the 60-record / 54-query
intermediate set, the 100-record / 96-query expanded
set, and a future larger checkpoint. The benchmark
harness is unchanged (the real `transformersjs` MiniLM
embedder is the same `Xenova/all-MiniLM-L6-v2` model,
the stub is the same deterministic projection); only
the fixture data grew. Headline numbers from a real
`benchmark:retrieval:all-dense:real` run on the
adversarial-expansion set (the artifact under
`.cortex/benchmark/` is the source of truth; the prior
100-record / 96-query numbers are listed for comparison):

| Metric | vector-dense (real, 132rec) | hybrid-dense (RRF, real, 132rec) |
|---|---|---|
| rank1 (positive) | 82 / 130 = 63.1% | **90 / 130 = 69.2%** |
| currentTruth@1 (positive) | 78 / 130 = 60.0% | **87 / 130 = 66.9%** |
| hit@1 (positive) | 82 / 130 = 63.1% | **90 / 130 = 69.2%** |
| hit@3 (positive) | **113 / 130 = 86.9%** | 110 / 130 = 84.6% |
| hit@5 (positive) | **123 / 130 = 94.6%** | 116 / 130 = 89.2% |
| no-answer TNR | 0 / 46 = 0.0% | 0 / 46 = 0.0% |

For comparison, the prior 100-record / 96-query
expanded set on the real `transformersjs` MiniLM
embedder (the source of truth is the prior
`.cortex/benchmark/` artifact):

| Metric | vector-dense (real, 100rec) | hybrid-dense (RRF, real, 100rec) |
|---|---|---|
| rank1 (positive) | **52 / 72 = 72.2%** | 48 / 72 = 66.7% |
| hit@5 (positive) | 69 / 72 = 95.8% | **70 / 72 = 97.2%** |
| no-answer TNR | 0 / 24 = 0.0% | 0 / 24 = 0.0% |

The adversarial-expansion-corpus reading: the real
dense vector holds rank-1 at **63.1%** and `hit@5` at
**94.6%**; the real hybrid-dense hits **69.2% rank-1**
(the hybrid RRF benefits from the new multi-hop /
orientation clusters' better rank-1 surface) but
loses 7 hit-5 to the lexical / FTS5 contributor
noise. Compared to the 100-record / 96-query expanded
set, the rank-1 percentage drops (72.2% → 63.1% on
the dense vector) because the new query set is
**heavier on adversarial shapes** — paraphrase-twins
with low lexical overlap, hard-negatives overlapping
current clusters, near-miss disambiguation, and
multi-hop with a near-miss distractor on one hop.
The hit-5 percentage also drops (95.8% → 94.6%) for
the same reason. The headline shift is honest
research evidence: the adversarial shapes are
designed to test rank-1 quality, not just hit-5
coverage, and the dense vector is more sensitive
to the per-cluster rank-1 trade-off than the RRF.

The expanded corpus *tighter* no-answer TNR (0%
across both dense variants) is the calibration
experiment's input, not a regression: the 15 labeled
hard-negatives (the original `nonexistent-load-
balancer` plus 14 new ones on the cluster-31
false-premise-anchor surface and the cluster-26
conflict / cluster-27 superseded surfaces) and the
broader no-answer set (46 queries, up from 24)
make the no-answer TNR a harder contract to clear
at the default threshold. The "no-answer TNR = 0%"
is also the same limitation the hashed-BoW control
has: cosine similarity of a unit vector to a random
unrelated unit vector is near 0, and the default
threshold passes every candidate with a non-zero
overlap. A future calibration pass against the
dense vector (or a positive `--threshold`) is the
path to a meaningful TNR.

#### Limitations

- The dense variant is **retrieval-only**. No
  answer-quality / LLM judging is performed. The
  scaffold stays at `enabled: false`.
- No production `sqlite-vec` migration or
  persistent dense embedding storage. The dense
  index is built in-memory for the lifetime of a
  single benchmark run.
- No external API embedding providers. The
  transformers.js backend is local-only; the
  first-run model download is the only network
  call and it is to the Hugging Face CDN.
- The CLI is opt-in: existing benchmark commands
  (`benchmark:retrieval:fts5`, `vector`, `hybrid`,
  `all`, `calibrate*`) keep working unchanged. The
  dense variants are reached only via the
  `vector-dense` / `hybrid-dense` / `all-dense`
  variant names.
- The CLI flag `--calibrate` DOES support the
  dense variants. See the
  [Dense abstention calibration](#dense-abstention-calibration-benchmark-only)
  section below for the trade-off curves and
  commands.
- The `vector-dense` (and `hybrid-dense`) variants
  are **async-only**; the sync `runRetrievalBenchmark`
  throws on them. The async entry point is
  `runDenseRetrievalBenchmark`.
- The transformers.js model is bit-deterministic
  for a fixed input and a fixed runtime, so the
  benchmark artifact is reproducible across runs
  on the same machine. Different ONNX Runtime
  thread counts or different quantization
  variants will produce different (but still
  semantically meaningful) vectors.

#### Dense abstention calibration (benchmark-only)

A separate opt-in calibration experiment studies how
to set abstention gates on the **dense** variants
(`vector-dense` / `hybrid-dense`). The motivation is
the empirical observation above: the dense embedder
has strong positive recall and a natural `0%` no-answer
TNR at the default threshold of 0, so the calibration
question for the dense variants is **how to recover
TNR while keeping positive regressions in check**.

The dense calibration experiment reuses the existing
`threshold / margin / ratio` gate families
(documented in the
[Calibration experiment](#calibration-experiment-benchmark-only-abstention-gates)
section above) and adds:

- A **per-variant default sweep grid** that spans the
  dense variant's natural score range. The cosine
  scale (`vector-dense`) is in [0, 1] and uses a
  `threshold` grid of `[0.1, 0.2, 0.3, 0.4, 0.5, 0.6,
  0.7]`. The RRF scale (`hybrid-dense`) is in
  `(0, N/(k+1)]` and uses a `threshold` grid of
  `[0.01, 0.02, 0.025, 0.03, 0.04]` so the sweep
  explores the natural match / confabulation gap on
  the dense RRF scale.
- A **hybrid-aware abstention diagnostic** on the
  `hybrid-dense` per-query trace: the per-source RRF
  rank/score/contribution for the top-1 candidate
  (`contributorSupport`) and the contributor-agreement
  count (`contributorAgreementCount`). The agreement
  count is the number of contributors that surfaced
  the candidate; a "1 of 3" agreement is a stronger
  abstention signal than a "3 of 3" agreement.

The dense calibration report is a **strict superset**
of the existing `CalibrationReport` shape. The additive
fields are:

- `embeddingBackend` — the dense embedder metadata.
- `bestByVariant.vectorDense` / `bestByVariant.hybridDense`
  — the dense best rows.
- Per-query `contributorSupport` /
  `contributorAgreementCount` on the `hybrid-dense`
  rows (single-variant dense rows do NOT carry these
  fields, so a reviewer can distinguish the
  single-variant from hybrid-aware traces).

The artifact is written under the file prefix
`retrieval-calibration-dense-*.json` (distinct from
the sync `retrieval-calibration-*.json` prefix) so the
existing sync calibration consumers do not pick the
dense artifact up accidentally. The sync calibration
report is unchanged.

```sh
# All dense variants, default sweep grid (stub embedder).
npm run benchmark:retrieval:calibrate:dense

# One dense variant at a time.
npm run benchmark:retrieval:calibrate:vector-dense
npm run benchmark:retrieval:calibrate:hybrid-dense

# Real local model (first run downloads ~25MB).
npm run benchmark:retrieval:calibrate:dense:real
```

##### Measured trade-offs (100-record corpus, 96 queries, stub-dense)

The dense calibration experiment was run against the
100-record fixture corpus with the deterministic stub
embedder (`stub-dense:dim=64`). Headline numbers from
the artifact (the on-disk JSON is the source of truth):

| Variant | Gate (best row) | TNR | ΔTNR | positive regressions | hit@5 (positive) | no-answer FPs fixed / remaining |
|---|---|---|---|---|---|---|
| `vector-dense` | `threshold@0.7` | 100.0% | +100.0pp | 71 / 72 (98.6%) | 1 / 72 (1.4%) | 24 / 0 |
| `vector-dense` | `margin@0.3` | 100.0% | +100.0pp | 70 / 72 (97.2%) | 1 / 72 (1.4%) | 24 / 0 |
| `vector-dense` | `ratio@2` | 100.0% | +100.0pp | 70 / 72 (97.2%) | 1 / 72 (1.4%) | 24 / 0 |
| `vector-dense` | `threshold@0.4` | 50.0% | +50.0pp | 33 / 72 (45.8%) | 32 / 72 (44.4%) | 12 / 12 |
| `vector-dense` | `ratio@1.25` | 70.8% | +70.8pp | 47 / 72 (65.3%) | 17 / 72 (23.6%) | 17 / 7 |
| `hybrid-dense` | `ratio@2` | 95.8% | +95.8pp | 71 / 72 (98.6%) | 0 / 72 (0.0%) | 23 / 1 |
| `hybrid-dense` | `threshold@0.04` | 45.8% | +45.8pp | 15 / 72 (20.8%) | 52 / 72 (72.2%) | 11 / 13 |
| `hybrid-dense` | `ratio@1.5` | 79.2% | +79.2pp | 55 / 72 (76.4%) | 14 / 72 (19.4%) | 19 / 5 |

The headline reading: **the dense vector exhibits a
sharp threshold gap** at `threshold@0.4` (TNR +50pp
with 33 regressions and `hit@5` dropping from
`68.1%` to `44.4%`) and **the dense hybrid exhibits
a sharp RRF ratio gap** at `ratio@1.5` (TNR +79.2pp
with 55 regressions). The "all TNR at any cost"
configurations (`vector-dense threshold@0.7` and
`hybrid-dense ratio@2`) are not honest trade-offs:
the `hit@5` of `1.4%` / `0.0%` and the
`>97%` regression rate mean the ranker is now
mostly refusing to answer.

The most honest trade-off points on the new corpus are:

- `vector-dense` `threshold@0.4` — TNR 50.0% with
  hit@5 44.4% (a 23.7pp hit@5 regression). A
  reviewer who weights TNR heavily could pick this.
- `vector-dense` `ratio@1.25` — TNR 70.8% with
  hit@5 23.6% (a 44.5pp hit@5 regression). A
  heavier TNR bet.
- `hybrid-dense` `threshold@0.04` — TNR 45.8% with
  hit@5 72.2% (a 9.7pp hit@5 regression). The
  balanced point on the dense hybrid; preserves
  most of the strong-double rank-1=42/72=58.3%
  baseline at the cost of 11 no-answer FPs fixed.

A reviewer who wants a Pareto frontier of TNR vs.
hit@5 vs. regressions can extend
`pickBestRow` to a multi-objective rule; the v1
calibration experiment is intentionally a
single-rule, auditable pick. The default
"best" rows surfaced in the human report follow
the same rule as the sync calibration: maximize TNR
delta, tie-break on smallest positive-regression
count, then on largest hit@5.

##### How to interpret a dense calibration report

Each dense sweep row reports the same numbers as the
sync calibration report (TNR, hit@5, rank1, currentTruth@1,
regressions, noAnsFixed, noAnsRemain). The two
dense-specific additions are:

- The **contributor agreement** sub-block on the
  `hybrid-dense` per-query diagnostics. For every
  no-answer query the ranker still confabulates on
  (i.e. the abstention gate did not trigger), the
  report lists:
  - `agreement=N/3` — how many of the three
    contributors surfaced the candidate.
  - `contributors=[lexical=rankK(contribution)
    fts5=rankK(contribution) vector-dense=rankK(contribution)]`
    — the per-source RRF rank and contribution for
    the top-1 candidate.
  The sub-block is the diagnostic a reviewer most
  needs to interpret a hybrid-dense abstention
  decision. A high agreement count on a no-answer
  query means the fusion was confident, so the
  abstention is harder; a low agreement count means
  the fusion was already uncertain, so the abstention
  is more defensible.
- The **embedding backend** block at the top of the
  human report (and as `embeddingBackend` on the JSON
  artifact) so a reviewer can audit which dense
  embedder produced the calibration numbers. The
  block is the same `EmbedderMetadata` shape the
  dense benchmark reports carry.

##### Limitations

- The dense calibration default sweep grid is small
  (5..7 values per gate family). A reviewer who wants
  a finer grid can call
  `runDenseCalibration({ variant: "vector-dense",
  calibrationConfig: { gatesByVariant: {}, sweep: {
  threshold: [...], margin: [...], ratio: [...] } } })`
  directly from a Node script.
- The dense calibration experiment is **benchmark-only**.
  The abstention gates it computes are a research
  artifact, not a deployment policy. They are NOT
  wired into the production `recall(text)` controller.
  Wiring the gates in is a separate, later phase that
  would require a production-impact analysis the
  benchmark-only pass intentionally does not perform.
- The "best" pick is a single rule, not a Pareto
  frontier. A future phase can add a multi-objective
  report (Pareto frontier of TNR vs. regressions vs.
  hit@5 vs. F1@5).
- The dense calibration report carries **only the
  dense variants** — `vector-dense` and / or
  `hybrid-dense`. The sync `lexical / fts5 / vector`
  calibration experiment is unchanged and is run by
  `npm run benchmark:retrieval:calibrate` /
  `calibrate:lexical` / `calibrate:fts5` /
  `calibrate:vector`.
- The dense hybrid RRF uses three contributors
  (lexical, FTS5, vector-dense). The contributor
  support diagnostic therefore reports `agreement=N/3`,
  not `N/4` or `N/2`. A future dense fusion with a
  different contributor set would need to update the
  cap accordingly.
- The `vector-dense` and `hybrid-dense` calibration
  report's per-query hybrid-aware fields
  (`contributorSupport` / `contributorAgreementCount`)
  are populated only on the `hybrid-dense` rows. A
  reviewer who wants the same diagnostic on a
  single-variant dense row would need to extend the
  runner; the v1 contract is "hybrid-aware only on
  hybrid runs".
- Answer-quality evaluation is still disabled. The
  dense calibration report does not score generated
  answers; the abstention decision is purely a
  retrieval signal.

### Abstention-signal audit (benchmark-only)

A separate opt-in **abstention-signal audit** studies
how well simple retrieval-derived signals separate
answerable from no-answer queries. It is a different
tool from the calibration experiment: the calibration
experiment picks the best (gate, variant) trade-off
under a fixed rule; the audit measures how much
*separability* the underlying signals carry at all.

**Scope (benchmark-only):**
- The audit does NOT modify the production
  `recall(text)` behavior, the public MCP API, or
  the existing benchmark / calibration report shapes.
- It is a research artifact: a study of what
  retrieval-derived signals could carry
  abstention-decision information. The brief asks for
  an honest answer, not a sale — if a signal is weak
  on real data, the report says so.
- The audit does NOT add a learned classifier or a
  trained model. The signals are pure retrieval
  diagnostics.

**Why this is separate from calibration:**
The calibration experiment is a *gate* study: given a
candidate abstention gate (threshold / margin /
ratio), what is the trade-off? The audit is a
*signal* study: how well does each candidate signal
distinguish answerable from no-answer queries in the
first place? The audit's output feeds the
calibration experiment's input: a signal that
separates well is a candidate for the calibration
sweep's gate family.

**What the audit measures:**

For each query, the audit attaches an
`AbstentionSignals` block to the per-query eval. The
block carries:

- *Retrieval signals* — `topScore`, `top1Top2Gap`,
  `top1Top2Ratio`, `returnedCount`.
- *Hybrid contributor signals* (hybrid / hybrid-dense
  only) — `agreementCount`, `minContributorRank`,
  `maxContributorRank`, `meanContributorRank`,
  `minContributorScore`, `maxContributorScore`,
  `meanContributorScore`, `sourcePresence` (e.g.
  `"LFV"` = all three contributors surfaced the
  top-1, `"_V_"` = only the vector surfaced).
- *Query-shape flags* (benchmark-only diagnostics,
  NOT hardcoded to specific query ids) —
  `isNoAnswerHardNegative` (no-answer query that
  shares tokens with real records),
  `isTemporalCurrent` (contains "current" / "now" /
  "today"), `isNegationLike` (contains "not" / "no" /
  "never"), `isOodEntityLike` (mentions a tool the
  corpus does not have, sharing tokens with a legacy
  record), `isParaphraseTrap` (family = paraphrase),
  `isFalsePremiseLike` (no-answer query that mentions
  a missing tool).

For each signal, the audit computes:

- **AUROC** for the "answerable vs no-answer" binary
  task. AUROC 0.5 = uninformative; 1.0 = perfect
  separation. The audit reports the AUROC in the
  better of the two directions (raw signal or
  negated signal); the `scoreIsHigherIsMorePositive`
  flag tells the reviewer which direction won. A
  signal that is HIGH for answerable (e.g. `topScore`)
  has `scoreIsHigherIsMorePositive = false` because
  the audit has to invert to detect no-answer.
- **Risk-coverage curve data** — the
  (coverage, confabulation rate) trade-off at every
  candidate signal threshold.
- **Coverage at fixed risk** (5%, 10%, 20%) — "at
  most X% confabulation, how much of the corpus can
  we keep?".
- **Risk at fixed coverage** (50%, 80%, 95%) —
  "at least Y% coverage, what is the minimum
  confabulation?".
- **Slice summaries** — the same per-signal metrics
  scoped to a slice: "all", per-family
  ("exact" / "paraphrase" / "temporal" / "multi-hop" /
  "no-answer" / "orientation"), and per-shape
  ("no-answer-easy" / "no-answer-hard" /
  "temporal-divergent" / "temporal-non-divergent" /
  "temporal-current" / "negation-like" /
  "ood-entity-like" / "paraphrase-trap" /
  "false-premise-like").
- **Honest per-query examples** — the most / least
  confident no-answer / positive queries, with their
  full per-query signal block, so a reviewer can see
  the most informative cases (the confabulations
  that look like answers, the abstentions that look
  like refusers).

**How to run:**

```sh
# Default: hybrid (RRF) abstention audit, hashed-BoW control.
npm run benchmark:retrieval:abstention-audit

# Per-variant audits (sync, hashed-BoW control).
npm run benchmark:retrieval:abstention-audit:lexical
npm run benchmark:retrieval:abstention-audit:fts5
npm run benchmark:retrieval:abstention-audit:vector

# Dense audits, stub embedder (no model download).
npm run benchmark:retrieval:abstention-audit:vector-dense

# Real local MiniLM (first run downloads ~25MB).
npm run benchmark:retrieval:abstention-audit:real
npm run benchmark:retrieval:abstention-audit:hybrid-dense:real
```

**Headline reading on real data (132 records, 176
queries, real `Xenova/all-MiniLM-L6-v2` embedder,
hybrid-dense audit):**

| Signal | AUROC | Direction | Coverage @ 5% risk | Coverage @ 10% risk | Coverage @ 20% risk |
|---|---|---|---|---|---|
| `minContributorScore` | 0.751 | lower=positive | 32.4% | 68.2% | 80.7% |
| `meanContributorScore` | 0.743 | lower=positive | 32.4% | 67.6% | 80.7% |
| `maxContributorScore` | 0.713 | lower=positive | 30.7% | 67.0% | 80.7% |
| `agreementCount` | 0.605 | lower=positive | n/a | n/a | n/a |
| `top1Top2Ratio` | 0.594 | higher=positive | n/a | n/a | n/a |
| `topScore` | 0.594 | lower=positive | n/a | n/a | n/a |
| `top1Top2Gap` | 0.554 | higher=positive | n/a | n/a | n/a |
| `meanContributorRank` | 0.522 | lower=positive | n/a | n/a | n/a |
| `maxContributorRank` | 0.520 | lower=positive | n/a | n/a | n/a |
| `minContributorRank` | 0.507 | higher=positive | n/a | n/a | n/a |
| `returnedCount` | 0.500 | higher=positive | n/a | n/a | n/a |

**Honest reading:**

- The strongest single signal is `minContributorScore`
  (AUROC 0.751) on the adversarial-expansion corpus
  (was `meanContributorScore` at 0.831 on the prior
  100-record / 96-query set; the adversarial
  expansion reorders the top-3 by reducing the
  mean's advantage over the min). It is the
  smallest per-source raw score (lexical / FTS5 /
  vector-dense) the top-1 candidate received. A
  no-answer query that confabulates tends to have
  ALL three contributors return a candidate with a
  moderate-to-high raw score, but the MIN of those
  scores is LOWER than the min for an answerable
  query (because answerable queries have at least
  one contributor with a strong semantic match). The
  signal works in the `lower=positive` direction
  (lower min = more likely no-answer).
- `meanContributorScore` and `maxContributorScore`
  follow at 0.743 and 0.713. The per-source min is
  the strongest single separator on the
  adversarial-expansion corpus; the
  per-source mean is the second-strongest. The
  reordering from the prior set is honest: the
  adversarial-expansion corpus has more queries
  where the mean conflates the strongest contributor
  (a confabulation case that has one strong
  contributor + two weak) with a true answer
  (a query with all three contributors weak). The
  min is more robust to this confound.
- `topScore` (the fused RRF score) is meaningfully
  weaker (AUROC 0.594) on the adversarial-expansion
  corpus, down from 0.741 on the prior set. The
  drop is honest: the adversarial shapes (paraphrase
  twins, conflict records, near-miss distractors)
  pull `topScore` closer to the uninformative prior
  because the ranker is more often confident on
  confabulation cases.
- `top1Top2Gap` / `top1Top2Ratio` / `returnedCount`
  are essentially uninformative (AUROC ~0.5). The
  gap is small for both confabulating and matching
  candidates; a single candidate often dominates;
  the ranker always returns a non-empty top-K.
- At 5% confabulation, the strongest signal keeps
  ~32% of the corpus (down from ~46% on the prior
  set). At 10% it keeps ~68% (up from ~63%). At
  20% it keeps ~81% (down from ~94%). The
  trade-off is real but not strong: a real
  abstention gate would still let ~50% of
  no-answer queries through at 5% FPR, and the
  per-signal strength is lower than on the prior
  set because the adversarial shapes are
  deliberately designed to make the ranker
  confident on confabulation cases.
- The per-family and per-shape slice AUROCs (the
  numbers the brief asks for) are reported, but
  on a single-variant corpus most per-family and
  per-shape slices are single-class (e.g. the
  `exact` family contains only answerable
  queries; the `no-answer` family contains only
  no-answer queries; the `no-answer-easy` shape
  contains only no-answer queries). A single-class
  slice has no positive/negative pairs to rank
  against, so the AUROC is the uninformative
  prior (0.5) by definition; the human report
  renders `n/a` for those rows so a reviewer can
  tell the prior from a real reading. The
  on-disk JSON artifact still carries the
  documented `0.5` AUROC (so existing consumers
  that key on the value do not break) and adds a
  `singleClass: true` flag the formatter uses to
  decide between `0.500` and `n/a`. The headline
  AUROC is driven by the answerable-vs-no-answer
  split on the `all` slice (which IS mixed-class
  on the real corpus), NOT by intra-family
  differences.

**How to interpret the audit:**

```
AUROC 0.5  = uninformative (the signal does not
             separate answerable from no-answer).
AUROC 0.6  = weak (a useful marginal feature; not a
             reliable gate on its own).
AUROC 0.7  = moderate (a reasonable gate candidate;
             pair with another signal for production).
AUROC 0.8+ = strong (a good signal; still far from
             perfect — the residual FPR is non-zero).
```

The "coverage @ X% risk" number is the headline
trade-off: "at most X% confabulation rate, how much
of the corpus can we keep?". A low number means the
signal is weak at that risk target; a high number
(>= 80%) means the signal is useful at that target.

The "risk @ Y% coverage" number is the symmetric
reading: "at least Y% coverage, what is the minimum
confabulation?". A low number means the signal is
strong; a high number means the signal lets the
ranker be confident at the cost of confabulation.

A signal that works on the `no-answer-hard` slice
but NOT on the `all` slice is a hard-negative
detector, not a general abstention signal. The
audit's per-shape slice table makes this distinction
visible: if the strongest signal on `all` is
`topScore` but the strongest signal on
`no-answer-hard` is `meanContributorScore`, the
`meanContributorScore` is the more useful
hard-negative detector.

**Limitations:**

- The audit is benchmark-only. The abstention gates
  it surfaces are a research artifact, not a
  deployment policy. They are NOT wired into the
  production `recall(text)` controller. Wiring the
  gates in is a separate, later phase that would
  require a production-impact analysis the
  benchmark-only pass intentionally does not
  perform.
- The audit's per-query `AbstentionSignals` block is
  populated only by the abstention-audit runner. The
  regular single-variant / comparison / calibration
  reports leave the field `undefined` so a reviewer
  can distinguish "the audit ran on this row" from
  "this row was generated by the regular benchmark".
  This is the contract: a regular benchmark run
  produces the same artifact it produced before
  this phase, byte-for-byte.
- The hybrid contributor signals are populated only
  on the `hybrid` / `hybrid-dense` audits. On a
  single-variant audit the contributor signals are
  `null` and the agreement count is 0; the
  per-source rank / score signals are undefined for
  those signals.
- The query-shape flags are simple regex / set-
  membership heuristics. They WILL miss some cases
  (e.g. a paraphrase that uses a synonym the
  detector does not know) and WILL fire on a query
  that happens to share a token with a real record
  but is not actually a hard-negative. The audit
  reports the count of queries that fired each flag
  so a reviewer can see the detector's effective
  coverage.
- The audit reports the AUROC in the better of the
  two signal directions. A reviewer who wants the
  raw direction's AUROC reads the
  `aurocOtherDirection` field on the JSON artifact.
- The "best" signal per slice is sorted by AUROC
  descending; the sort is the same on every run.
  A future audit could add a Pareto-frontier view
  (TNR vs. regressions vs. hit@5 vs. F1@5).
- The default `riskTargets` are `[0.05, 0.1, 0.2]`
  and the default `coverageTargets` are
  `[0.5, 0.8, 0.95]`. A reviewer who wants a
  finer grid can pass an `AbstentionAuditConfig` to
  the `runAbstentionAudit` function directly from a
  Node script. The CLI does not currently expose
  per-target tuning because the defaults cover the
  common cases.

**Compared to the calibration experiment:**

| Aspect | Calibration | Audit |
|---|---|---|
| Question | "Which gate / variant is best?" | "Do any signals separate?" |
| Output | Trade-off curve at one fixed gate | Per-signal AUROC + risk-coverage |
| Pick rule | Maximize TNR delta, tie-break on smallest positive-regression count, then on largest hit@5 | None — every signal is reported |
| Per-query granularity | Per-query diagnostic for the chosen gate | Per-query signal block for every query |
| Slice granularity | Variant only | Variant + family + shape |
| Honest reading | "This is the best gate" | "This signal is strong / weak / uninformative" |
| Wired into controller? | No (research-only) | No (research-only) |

The two artifacts are complementary: the
calibration experiment tells a reviewer which gate
to pick IF they trust the underlying signals; the
audit tells a reviewer whether the underlying signals
are worth trusting.

### Multi-signal abstention policy evaluator (benchmark-only)

A separate opt-in **multi-signal abstention policy
evaluator** takes the per-query signal block the
abstention-signal audit produces and evaluates a
rule-based abstention policy grid against it. It is
a different tool from both the calibration
experiment and the abstention-signal audit: the
calibration experiment picks the best single-gate
trade-off; the audit measures per-signal
separability; **the policy evaluator tests a small
grid of rule-based policies (combinations of the
audit's score gate, the hybrid agreement gate, and
the query-shape flags) and reports the per-policy
trade-off on the full corpus, with the per-family
positive abstention damage and the per-query FP /
FN lists.** The evaluator is the closest
artifact to "what would the abstention policy look
like in production" — but it is still
benchmark-only and is NOT wired into the
controller.

**Scope (benchmark-only / research-only):**

- The evaluator does NOT modify the production
  `recall(text)` behavior, the public MCP API, or
  the existing benchmark / audit / calibration
  report shapes.
- The policies are pure rule-based functions (no
  learned classifier, no trained model). The brief
  is explicit: research-only, fixture-dependent.
- The recommended moderate policy's gains rely
  partly on the `isFalsePremiseLike` query-shape
  flag, which is **fixture-correlated**: it fires
  on queries that mention a missing tool, and the
  corpus of "missing tools" is fixed by the
  fixture. **Do not generalise the policy beyond
  the current fixture corpus without
  re-evaluating on a new corpus.** This is the
  single most important caveat the evaluator
  surfaces.
- The per-family damage on the recommended policy
  is concentrated on paraphrase (75.0% positive
  abstention rate) and orientation (27.8%) queries.
  This is honest research-only data: a
  production-grade abstention policy would have to
  address the paraphrase damage, either by
  improving the paraphrase detector or by relaxing
  the score gate on the paraphrase family.

**Why this is separate from the audit + calibration:**

- The audit measures "how well does each
  individual signal separate answerable from
  no-answer queries?" (per-signal AUROC + risk-
  coverage curve).
- The calibration experiment measures "given a
  candidate single-gate rule, what is the
  trade-off?" (sweep over threshold / margin /
  ratio gates per variant).
- **The policy evaluator measures "given a
  multi-signal rule (score gate AND/OR
  agreement-count gate AND/OR query-shape flags),
  what is the trade-off on the full corpus, and
  what is the per-family positive abstention
  damage?"** The three artifacts answer three
  different questions; a reviewer who wants the
  "should we ship an abstention gate?" answer reads
  all three.

**Primary policies evaluated (4):**

| ID | Rule |
|---|---|
| `flag-only-zero-hit-cost` | `isNoAnswerHardNegative OR isFalsePremiseLike` (no score gate) |
| `low-damage-score-0.30` | `meanContributorScore < 0.30 OR isNoAnswerHardNegative OR isFalsePremiseLike` |
| `moderate-score-0.40` | `meanContributorScore < 0.40 OR isNoAnswerHardNegative OR isFalsePremiseLike` (**recommended**) |
| `aggressive-score-0.50-no-fp` | `meanContributorScore < 0.50 OR isNoAnswerHardNegative` (drops the false-premise flag) |

**Ablations evaluated (11):**

- Score-only at thresholds {0.30, 0.35, 0.40, 0.45, 0.50}.
- `isNoAnswerHardNegative` alone.
- `isFalsePremiseLike` alone.
- `hardNeg OR falsePrem` (no score gate).
- `score < 0.40 OR hardNeg` (no false-premise).
- `agreementCount <= 1 OR score < 0.40` (weak-signal ablation).
- `agreementCount <= 2 AND score < 0.40` (AND-gate ablation; reported as a disjunction of the two conditions for
  transparency — the per-query `reason` field on the artifact tells the reviewer which gate fired).

**Metrics reported per policy:**

- **TNR (no-answer abstention rate)** — the headline `0%..100%` number. Higher = more no-answer queries caught.
- **Positive abstention rate** — the symmetric damage metric. Higher = more answerable queries wrongly abstained.
- **hit@5 / rank1 / currentTruthAt1 retained** — the un-gated baseline numbers are computed from the same per-query set, so the deltas are meaningful.
- **Precision / recall / F1** on the "should-abstain" binary task with `isNoAnswer` as the positive class. A `0 / 0` precision is reported as `0` by convention.
- **Per-family positive abstention breakdown** — e.g. "paraphrase 75.0% positive abstention rate on the recommended policy".
- **Per-query FP / FN lists** — the false-positives (positive queries wrongly abstained) and the false-negatives (no-answer queries wrongly retained) on the recommended policy, with the per-query reason (`score` / `hardNeg` / `falsePrem` / `agreement`).
- **Gate counts** — the number of queries that triggered each gate. A query that triggered two gates contributes to both buckets.

**How to run:**

```sh
# Default: hybrid (RRF) policy evaluation, hashed-BoW control.
npm run benchmark:retrieval:abstention-policy

# Per-variant policies (sync, hashed-BoW control).
npm run benchmark:retrieval:abstention-policy:fts5
npm run benchmark:retrieval:abstention-policy:vector

# Real local MiniLM (first run downloads ~25MB).
npm run benchmark:retrieval:abstention-policy:hybrid-dense:real
npm run benchmark:retrieval:abstention-policy:all-dense:real
```

The artifact file prefix is
`retrieval-abstention-policy-*.json` (distinct from
the existing `retrieval-abstention-audit-*`,
`retrieval-calibration*`, and `retrieval-hybrid-dense-*`
prefixes).

**Headline reading on real data (132 records, 176
queries, real `Xenova/all-MiniLM-L6-v2` embedder,
hybrid-dense policy evaluation):**

| Policy | TNR% | PosAbst% | hit@5 retained | rank1 retained | curT1 retained | P | R | F1 |
|---|---|---|---|---|---|---|---|---|
| `flag-only-zero-hit-cost` | 69.6 | 0.0 | 100.0 | 100.0 | 100.0 | 1.00 | 0.70 | 0.82 |
| `low-damage-score-0.30` | 71.7 | 1.5 | 99.1 | 98.9 | 98.9 | 0.94 | 0.72 | 0.81 |
| `moderate-score-0.40` (**recommended**) | 95.7 | 12.3 | 92.2 | 94.4 | 94.3 | 0.73 | 0.96 | 0.83 |
| `aggressive-score-0.50-no-fp` | 100.0 | 23.1 | 82.8 | 84.4 | 83.9 | 0.61 | 1.00 | 0.75 |
| `ablation-score-0.30-only` | 6.5 | 1.5 | 99.1 | 98.9 | 98.9 | 0.60 | 0.07 | 0.12 |
| `ablation-score-0.35-only` | 23.9 | 4.6 | 97.4 | 98.9 | 98.9 | 0.65 | 0.24 | 0.35 |
| `ablation-score-0.40-only` | 34.8 | 12.3 | 92.2 | 94.4 | 94.3 | 0.50 | 0.35 | 0.41 |
| `ablation-score-0.45-only` | 52.2 | 16.9 | 88.8 | 90.0 | 89.7 | 0.52 | 0.52 | 0.52 |
| `ablation-score-0.50-only` | 54.3 | 23.1 | 82.8 | 84.4 | 83.9 | 0.45 | 0.54 | 0.50 |
| `ablation-hardneg-only` | 60.9 | 0.0 | 100.0 | 100.0 | 100.0 | 1.00 | 0.61 | 0.76 |
| `ablation-false-premise-only` | 32.6 | 0.0 | 100.0 | 100.0 | 100.0 | 1.00 | 0.33 | 0.49 |
| `ablation-hardneg-or-fp` | 69.6 | 0.0 | 100.0 | 100.0 | 100.0 | 1.00 | 0.70 | 0.82 |
| `ablation-score-0.40-or-hardneg` | 93.5 | 12.3 | 92.2 | 94.4 | 94.3 | 0.73 | 0.93 | 0.82 |
| `ablation-agreement-le1-or-score-0.40` | 34.8 | 12.3 | 92.2 | 94.4 | 94.3 | 0.50 | 0.35 | 0.41 |
| `ablation-agreement-le2-and-score-0.40` | 47.8 | 21.5 | 84.5 | 90.0 | 89.7 | 0.44 | 0.48 | 0.46 |

**Per-family positive abstention on the recommended
moderate policy (real-MiniLM hybrid-dense, 132
records / 176 queries):**

| Family | Total | Abstained | Rate | Notes |
|---|---|---|---|---|
| `exact` | 20 | 0 | 0.0% | no positive abstentions on this family |
| `multi-hop` | 26 | 2 | 7.7% | multi-hop queries can have a low mean contributor score when no single contributor is strongly relevant |
| `temporal` | 26 | 1 | 3.8% | one temporal query (`temp-controller-validation`, labeled `divergentTemporal`) trips the score gate |
| `orientation` | 26 | 5 | 19.2% | project-status lookups with low per-source scores when the relevant memory is a multi-fact record |
| `paraphrase` | 32 | 8 | 25.0% | paraphrase queries can have a low vector-dense contributor score while the lexical / FTS5 score is high; the mean lands in the abstention band |

**Per-query false positives on the recommended
moderate policy (real-MiniLM hybrid-dense, 132
records / 176 queries):**

- 8 paraphrase queries: `para-deploy-strategy`, `para-review-style`, `para-storage-detail`, `para-architecture-decisions`, `para-secret-handling`, `para-upgrade-cadence`, `para-incident-comms`, `para-rate-limit`.
- 5 orientation queries: `orient-monitoring-status`, `orient-data-pipeline-status`, `orient-observability-extensions-status`, `orient-conflict-status`, `orient-superseded-status` (the last has the `nearMissCurrentCluster` label).
- 2 multi-hop queries: `multi-security-extensions`, `multi-observability-extensions`.
- 1 temporal query: `temp-controller-validation` (labeled `divergentTemporal`).

**Per-query false negatives on the recommended
moderate policy (real-MiniLM hybrid-dense, 132
records / 176 queries):**

- 2 no-answer queries: `nonexistent-staging-access` (no labels; a legacy confabulation that the ranker scores highly), `nonexistent-flink-pipeline` (labeled `hardNegative`; the ranker returns 5 hits with high mean contributor score, and the query is not flagged as a hard-negative or false-premise by the query-shape detector — a research-only finding the evaluator surfaces honestly).

**Honest reading:**

- The recommended moderate policy catches 95.7% of no-answer queries at a 12.3% positive abstention rate. The precision / recall / F1 numbers are honest: precision drops from 1.00 (flag-only) to 0.73 because the score gate is fired on paraphrase queries; recall jumps from 0.70 to 0.96. F1 peaks at the `moderate-score-0.40` and `ablation-score-0.40-or-hardneg` policies (both 0.83) and is the best F1 reading the policy grid has produced on any checkpoint.
- The flag-only baseline is the cheapest policy and the only one with 0% positive abstention. Its TNR (69.6%) is exactly the `isNoAnswerHardNegative OR isFalsePremiseLike` rate on the no-answer query set: 28 hard-negatives + 15 false-premise-like queries out of 46 no-answer queries (with overlap). The TNR rose from 62.5% (on the prior 96-query set) to 69.6% (on the 176-query set) because the adversarial-expansion added 15 labeled hard-negatives and 4 labeled false-premise queries.
- The aggressive policy (0.50 threshold, drops the false-premise flag) catches every no-answer query but inflicts 23.1% positive abstention (down from 34.7% on the prior set, because the new query set is heavier on hard-confabulation cases that the score gate catches at the moderate threshold). It is reported as a stress-test, not a recommendation.
- The per-family positive abstention damage is concentrated on paraphrase (25.0%, down from 75.0% on the prior set). The big drop is because the 4 `adversarialParaphrase` paraphrase-twin queries (113..116) are the hardest cases for the token-overlap ranker, but the 12 deep-positive paraphrases (which target the new cluster-29 paraphrase-twin records) are still partially recoverable. A reviewer who wants to ship the recommended policy in production would still have to either (a) improve the paraphrase detector so the score gate is more accurate on paraphrases, (b) exclude the paraphrase family from the score gate (and accept the missed no-answer catches on paraphrases), or (c) accept the 25.0% paraphrase abstention rate as a research-only finding and not generalise the policy.
- The agreement-count gate (the `agreement-le1-or-score-0.40` and `agreement-le2-and-score-0.40` ablations) is a weak-signal ablation: on a fixture where the ranker always populates the contributor block with all three sources (lexical / FTS5 / vector-dense), the agreement-count distribution is a much weaker separator than the score distribution. The `agreement-le1` policy abstains on the same 12.3% of positive queries as `score-0.40-only` (the agreement gate is dominated by the score gate on this fixture).
- The `false-premise-only` ablation catches 32.6% of no-answer queries with zero positive abstention damage. The flag is the single most useful single feature in the policy grid; the score gate is what pushes the recommended policy above the 95% TNR line.

**Limitations:**

- The recommended moderate policy's gains rely
  partly on the `isFalsePremiseLike` query-shape
  flag, which is **fixture-correlated**: it fires
  on queries that mention a missing tool, and the
  corpus of "missing tools" is fixed by the
  fixture. **Do not generalise the policy beyond
  the current fixture corpus without
  re-evaluating on a new corpus.** This is the
  single most important caveat.
- The per-family positive abstention damage is
  concentrated on paraphrase (25.0%) and
  orientation (19.2%) queries. The damage is
  honest: the score gate fires on the mean
  contributor score, and paraphrase queries
  naturally have a low mean (high lexical / FTS5,
  low vector-dense). The paraphrase damage is
  lower on the adversarial-expansion checkpoint
  (25.0% vs. 75.0% on the prior set) because the
  new paraphrase-twin records (113..116) and the
  deep-positive paraphrases give the ranker more
  surface to find the right answer; the labeled
  `adversarialParaphrase` queries (the 4 hardest
  cases) are still the dominant damage source.
  A production-grade abstention policy would
  still have to address the paraphrase damage
  separately.
- The two false-negatives on the recommended
  policy (`nonexistent-staging-access` and
  `nonexistent-flink-pipeline`) are a known
  limitation of the score gate: the ranker returns
  5 hits with a high mean contributor score, and
  the queries are not flagged by the query-shape
  detector. `nonexistent-flink-pipeline` is the
  labeled `hardNegative` case that escapes the
  flag-only baseline (the new cluster-31 anchor
  record 123 shares "pipeline" tokens with the
  query but does not match the false-premise
  detector's curated token list, so the flag
  doesn't fire on it; the score gate doesn't fire
  because the ranker is confident). A production-
  grade policy would have to add another signal
  (e.g. a "no-record-mentions" token-overlap
  detector) to catch this case.
- The adversarial-expansion query set has
  **explicit labels** on a subset of queries
  (the `labels?: string[]` field on
  `BenchmarkQuery`; see
  `src/benchmark/queries.ts` for the type
  definition). The labels are fixture truth,
  not derived from the query-shape detector.
  The detector surfaces three new boolean flag
  fields on the per-query `AbstentionSignals`
  block (`isAdversarialParaphrase`,
  `isDivergentTemporal`,
  `isNearMissCurrentCluster`) so a reviewer can
  audit the detector's approximation against
  the fixture truth. The policy evaluator's
  per-decision `queryLabels` field carries the
  explicit labels through to the FP / FN
  lists, so a reviewer can see "which labeled
  paraphrases / near-misses / divergent
  temporals the recommended policy abstained
  on" without re-deriving the detector's
  approximation.
- The score gate uses the
  `meanContributorScore` signal, which is a hybrid
  contributor signal. On a single-variant run
  (lexical / FTS5 / vector) the signal is `null`
  and the policy evaluator treats it as `0`, so
  the score gate abstains on every query. The
  evaluator is most informative on a
  `hybrid-dense` run (real local MiniLM).
- The policy grid is intentionally small. A
  reviewer who wants a finer grid (e.g. score
  thresholds at 0.32, 0.36, 0.42) can construct
  a custom `AbstentionPolicy` and pass it via the
  programmatic API; the CLI does not currently
  expose per-threshold tuning because the default
  grid covers the brief's primary policies +
  ablation set.
- The `agreementCount <= 2 AND score < 0.40`
  ablation is reported as a disjunction of the
  two gates (a query abstains iff EITHER gate
  fires). The AND-gate name is honest about this:
  the artifact's per-query `reason` field tells
  the reviewer which gate fired, and the human
  report's `gate counts` column reports the
  per-gate abstention count.
- The policies are pure rule-based functions. No
  learned classifier, no trained model. The
  evaluator is research-only / fixture-dependent
  and is NOT wired into the production controller.

**Compared to the calibration experiment + abstention-signal audit:**

| Aspect | Calibration | Audit | Policy evaluator |
|---|---|---|---|
| Question | "Which gate / variant is best?" | "Do any signals separate?" | "How does a multi-signal rule behave on the full corpus?" |
| Output | Trade-off curve at one fixed gate | Per-signal AUROC + risk-coverage | Per-policy TNR / positive abstention / per-family damage / per-query FP / FN |
| Pick rule | Maximize TNR delta, tie-break on smallest positive-regression count, then on largest hit@5 | None — every signal is reported | None — every policy in the grid is reported |
| Per-query granularity | Per-query diagnostic for the chosen gate | Per-query signal block for every query | Per-query decision + reason for every policy in the grid |
| Slice granularity | Variant only | Variant + family + shape | Family only (per-family positive abstention breakdown) |
| Honest reading | "This is the best gate" | "This signal is strong / weak / uninformative" | "This policy catches N% of no-answer queries at M% positive abstention cost" |
| Wired into controller? | No (research-only) | No (research-only) | No (research-only / fixture-dependent) |

The three artifacts are complementary: the
calibration experiment tells a reviewer which gate
to pick IF they trust the underlying signals; the
audit tells a reviewer whether the underlying signals
are worth trusting; the policy evaluator tells a
reviewer how a multi-signal rule would behave on
the full corpus, with the per-family damage and the
per-query FP / FN lists.

### Hybrid / RRF variant: scope, formula, and limitations

- **Scope.** The hybrid variant is benchmark-only. It runs
  entirely in memory (it composes the three contributing
  rankers' in-memory output) and does not change the public
  `recall(text)` API. Source-tree guards in
  `tests/retrieval-hybrid.test.ts` enforce this with the
  same shape as the FTS5 / vector guards, including a
  whitelist that allows only the benchmark runner, the
  hybrid module itself, and (for the per-module
  import-whitelist tests) the FTS5 and vector modules to
  cross-reference the underlying rankers.
- **Algorithm.** Reciprocal Rank Fusion
  (Cormack, Clarke, Buettcher 2009). For a candidate `c`
  and a set of variant rankings `R_1, R_2, ..., R_n`:
  ```
  rrf(c) = Σ_i  weight_i / (k + rank_i(c))
  ```
  where `rank_i(c)` is the 1-based rank of `c` in `R_i`
  (or `∞` / 0 contribution if `c` is not in `R_i`),
  `weight_i` is the per-variant weight (default 1.0), and
  `k` is a smoothing constant. Ties on the RRF score are
  broken by ascending id, the same stability contract the
  three single variants use.
- **Default `k = 60`.** This is the conventional value in
  the RRF paper and in most implementations. The benchmark
  sweep covers `k ∈ {20, 60, 100}`:
  - `k = 20` — rank-1 dominates the fusion; a candidate
    that is rank-1 in any contributor effectively wins.
  - `k = 60` — the conventional default; balanced.
  - `k = 100` — mid-list hits contribute more; rank-1's
    advantage is smaller.
  A reviewer can pin a specific k via `--hybrid-k <n>`.
  On the current 100-record fixture corpus the hybrid
  ranking is invariant under `k ∈ {20, 60, 100}` for
  every query — the candidate ordering, the per-family
  rank-1 counts, and the comparison table's `hybrid`
  column are byte-equal across the three k values. This
  is a corpus-size artifact, not a property of RRF: the
  contributing variants each return a short
  rank-aligned top-5 (lexical, FTS5, and vector agree
  on the top-1 for most positive queries) so the k
  smoothing constant does not change the winner on this
  corpus. The k sweep stays in the benchmark surface so
  a future corpus expansion or a new query family that
  disagrees on rank-1 will surface the trade-off.
- **Why rank-fusion, not score-fusion.** The three
  contributing variants return scores on incompatible
  scales (lexical 0..1+ Jaccard; FTS5 0..1 squashed BM25;
  vector 0..1 cosine). Naive score averaging would require
  per-corpus normalization and is brittle to per-variant
  threshold changes. RRF works on rank order, so it
  composes the three contributors without ever comparing
  their raw scores.
- **Weights.** Per-variant weights are exposed via the
  `weights: { lexical?, fts5?, vector? }` option. The
  default is `1.0` for every variant (uniform fusion).
  Weight `0` effectively removes a variant from the
  fusion. The benchmark CLI does not expose a weights
  flag in this phase; the public option is the extension
  point for a future ablation.
- **Score scale.** RRF scores are positive for any
  candidate with at least one contributing variant, and
  `0` for candidates absent from every contributor. With
  three variants and uniform weights the maximum RRF
  score for a candidate that is rank-1 in all three is
  `3 / (k + 1)`. We do not squash the RRF score; the
  ranker uses `threshold = 0` (passes anything that has
  at least one contribution), and the RRF scale is a
  fixed monotonic transform of the underlying ranks.
- **No abstention gate.** The hybrid is rank-only. It
  does NOT introduce an abstention gate of its own.
  Calibration of the fusion is a future phase; the v1
  contract is that the calibration experiment studies
  abstention gates on the single-variant rankers, and
  the hybrid composes them by RRF. The
  `--variant hybrid --calibrate` combination is a no-op
  for the calibration pass.
- **Richer diagnostics.** The hybrid report carries
  per-query `hybridContributors` (one entry per source
  for the top-1 candidate, with `rank`, `score`,
  `contribution`, `weight`) and a
  `hybridPerFamilyDelta` table that compares the hybrid
  to the best of `lexical / fts5 / vector` per family.
  These are the "richer-diagnostics" block the
  Architect's brief asks for.

### How to run the variants

```sh
# Default: lexical baseline.
npm run benchmark:retrieval

# Benchmark-only FTS5 variant.
npm run benchmark:retrieval:fts5

# Benchmark-only vector variant (hashed-BoW control).
npm run benchmark:retrieval:vector

# Benchmark-only hybrid / RRF variant (default k = 60).
npm run benchmark:retrieval:hybrid

# Hybrid at the explicit k values from the sweep.
npm run benchmark:retrieval:hybrid:k20
npm run benchmark:retrieval:hybrid:k60
npm run benchmark:retrieval:hybrid:k100

# Side-by-side comparison across the four sync variants.
# Writes one lexical, one fts5, one vector, one hybrid,
# and one combined comparison artifact under
# .cortex/benchmark/. The combined file includes a
# per-family "hybrid vs best baseline" delta table.
npm run benchmark:retrieval:all

# Dense (real local semantic embedding) variants.
# All three use the deterministic stub by default; the
# `:real` variants download + run the local ONNX model.
npm run benchmark:retrieval:vector-dense
npm run benchmark:retrieval:vector-dense:real
npm run benchmark:retrieval:hybrid-dense
npm run benchmark:retrieval:hybrid-dense:real
npm run benchmark:retrieval:all-dense
npm run benchmark:retrieval:all-dense:real

# Skip live model execution (deterministic-only CI path).
npm run benchmark:retrieval:vector-dense:skip
```

All four variants write their JSON reports under
`.cortex/benchmark/` (gitignored). The combined
`retrieval-compare-*.json` file nests the per-variant
reports plus a side-by-side metric table and the hybrid
per-family delta table.

### Calibration experiment (benchmark-only abstention gates)

A separate opt-in experiment studies how to set
abstention gates — the per-query decision of "should the
ranker surface a candidate or refuse to answer?" — across
the three retrieval variants. The calibration pass is
**benchmark-only**: it does not change the production
`recall(text)` behavior, the public MCP API, the
single-variant / comparison report shapes, or the
answer-quality scaffold. The gates it computes are a
research artifact, not a deployment policy.

```sh
# All three variants, default sweep grid.
npm run benchmark:retrieval:calibrate

# One variant at a time.
npm run benchmark:retrieval:calibrate:lexical
npm run benchmark:retrieval:calibrate:fts5
npm run benchmark:retrieval:calibrate:vector

# Underlying CLI flags: --calibrate enables the
# experiment; --calibrate-direction lower-is-better is
# supported for experiments against the raw FTS5 bm25
# value.
npx tsx src/benchmark/retrieval-runner.ts --variant all --calibrate
```

### Abstention-signal audit (benchmark-only)

A separate opt-in **abstention-signal audit** studies
how well simple retrieval-derived signals separate
answerable from no-answer queries. The audit's CLI
flag is `--abstention-audit`; it can be combined
with `--variant` to pick the ranker underneath.

```sh
# Default: hybrid (RRF) audit, hashed-BoW control.
npm run benchmark:retrieval:abstention-audit

# Per-variant sync audits.
npm run benchmark:retrieval:abstention-audit:lexical
npm run benchmark:retrieval:abstention-audit:fts5
npm run benchmark:retrieval:abstention-audit:vector

# Dense audit, stub embedder (no model download).
npm run benchmark:retrieval:abstention-audit:vector-dense

# Real local MiniLM (first run downloads ~25MB).
npm run benchmark:retrieval:abstention-audit:real
npm run benchmark:retrieval:abstention-audit:hybrid-dense:real

# Underlying CLI flag: --abstention-audit enables the
# experiment; the audit consumes the per-query evals
# of the chosen variant.
npx tsx src/benchmark/retrieval-runner.ts --variant hybrid --abstention-audit
```

The audit writes a single
`retrieval-abstention-audit-*.json` artifact under
`.cortex/benchmark/`. See the
[Abstention-signal audit (benchmark-only)](#abstention-signal-audit-benchmark-only)
section above for the interpretation guide.



The calibration report writes a single
`retrieval-calibration-*.json` artifact under
`.cortex/benchmark/`. The report contains:

- **Baseline row** per variant — the ranker's natural
  TNR / hit@5 / rank1 numbers at `threshold: 0` (no
  ranker-side filter). The baseline is intentionally
  different from the production single-variant report
  (which uses the production default threshold of
  0.2 for lexical). The calibration baseline is the
  unfiltered ranker, so the gate's effect is visible
  end-to-end.
- **Sweep rows** per variant — one row per
  `(gate-kind, candidate-value)` from the default
  sweep grid:
  - **threshold** — abstain if `topScore < t`. Tested
    values: 0.1, 0.2, 0.3, 0.4, 0.5.
  - **margin** — abstain if `topScore - secondScore < m`.
    Tested values: 0.0, 0.05, 0.1, 0.2, 0.3. Captures
    "the ranker is barely confident the top is better
    than the runner-up".
  - **ratio** — abstain if `topScore / secondScore < r`.
    Tested values: 1.0, 1.25, 1.5, 2.0, 3.0. Captures
    the same idea as margin in a relative form, robust
    to per-corpus score-scale shifts.
- **Best row per variant** — the sweep row picked by
  the rule "maximize no-answer TNR delta over baseline,
  tie-break on smallest positive-regression count, then
  on largest hit@5, then on smallest gate value". The
  rule is documented in the artifact so the choice is
  auditable.
- **Per-query diagnostics** — for every query, the
  top score, second score, score gap, score ratio, the
  gate decision, whether the abstention matched the gold
  label, the original (no-threshold) top-K ids, and the
  after-abstain top-K ids (empty if the gate triggered).
  The full trace is in the JSON artifact; the human
  report shows the most informative rows by default
  (positive queries forced to abstain; no-answer
  queries fixed by abstention; no-answer queries still
  confabulating).

#### Score direction and FTS5

All three variants return a "higher is better" score on
their public `LexicalScoredCandidate.score` field:

- **lexical** — Jaccard-style overlap in [0, 1+] (the
  exact-phrase boost can push it above 1).
- **fts5** — the squashed `1 / (1 + |bm25|)` form, in
  (0, 1]. The raw FTS5 `bm25()` value is negative
  (lower is better); the variant flips and squashes it
  to a positive score before the ranker compares
  candidates. The calibration gate uses the squashed
  score, so the default direction
  (`higher-is-better`) is correct. A future experiment
  can pass `--calibrate-direction lower-is-better` to
  test against the raw bm25 form; the comparison stays
  internally consistent.
- **vector** — cosine similarity in [0, 1] for the
  non-negative L2-normalized BoW vectors produced by the
  default embedder. The default `DEFAULT_VECTOR_THRESHOLD`
  of 0 means cosine=0 passes the filter; the calibration
  report's baseline row for vector therefore has TNR=0
  (every no-answer query returns a hit with score >= 0).
  The "0% TNR" is the artifact the calibration
  experiment is trying to fix.

#### How to interpret a calibration report

Each sweep row reports:

- **TNR** — `noAnswerCorrect / noAnswerTotal` under
  the gate.
- **hit@5 / rank1 / currentTruth@1** — positive-query
  metrics AFTER abstention. A positive query forced to
  abstain counts as a hit@5 = 0 and a rank1 = 0 for
  that query.
- **regressions** — number of positive queries forced
  to abstain. A regression is a known cost: we now
  refuse to answer a query we used to answer.
- **noAnsFixed** — number of no-answer queries that
  the ranker originally answered (returned hits) but
  the gate abstains on. This is the "we stopped
  confabulating" signal.
- **noAnsRemain** — number of no-answer queries that
  the ranker still answers under the gate. The
  residual confabulation rate.

The trade-off curve is monotone: a stricter gate fixes
more no-answer FPs but introduces more positive
regressions. The "best" row picks the strictest gate
that improves TNR the most with the fewest
regressions. The choice is a research artifact, not a
production policy.

#### Limitations

- The default sweep grid is small (3..5 values per gate
  family). A reviewer who wants a finer grid can call
  `runCalibration({ variant: "all", calibrationConfig: { gatesByVariant: {}, sweep: { threshold: [...], ... } } })`
  directly from a Node script.
- The "best" pick is a single rule, not a
  Pareto-front. A future phase can add a multi-objective
  report (Pareto frontier of TNR vs. regressions vs.
  hit@5).
- The calibration experiment is currently the ONLY
  place abstention gates are studied. They are NOT
  wired into the production `recall(text)` controller.
  Wiring the gates in is a separate, later phase that
  would require a production-impact analysis the
  benchmark-only pass intentionally does not perform.
- The variant scores are not on the same scale; the
  sweep grids are per-variant. A direct comparison
  between, say, lexical `threshold@0.4` and vector
  `threshold@0.3` is meaningful (TNR vs regressions)
  but the threshold values themselves are not
  comparable.
- Answer-quality evaluation is still disabled. The
  calibration report does not score generated answers;
  the abstention decision is purely a retrieval
  signal.

## Safety fixtures

A small fixture/test skeleton covers: secrets, prompt injection,
unsafe preferences, raw dumps, vague junk, self-conflicting project
facts, and mixed safe+sensitive inputs. The fixture text in
`src/safety/fixtures.ts` is regression-checked against the classifier
in `tests/safety-fixtures.test.ts` so the corpus cannot drift from
the actual `classifyInput` behavior.

## Build & test

```sh
npm install
npm run build
npm test              # default suite (562 tests); no network required
npm run test:contracts # contracts-only suite (15 tests)
npm run test:dense-live # opt-in real-model integration test
                        # (downloads the model on first run;
                        # ~25MB; ~700ms first-load)
```

## Provider prototype runner

The prototype runner is a small CLI in `src/prototype/runner.ts` that
exercises the two approved providers against the P1..P6 structured-output
fixtures. It is **not** the MCP stdio server (which remains exactly two
tools, unchanged). The runner writes sanitized JSON reports under
`.cortex/prototype/`. Artifacts never contain raw API keys.

### One-time setup

1. Copy the example env file:

   ```sh
   cp .env.example .env
   ```

2. Edit `.env` and fill in real keys for the runs you want. Do not
   commit `.env` — `.gitignore` excludes it. Only `.env.example` is
   safe to commit. No real keys should ever appear in `.env.example`,
   in chat transcripts, or in version control.

   ```ini
   # .env (local only; not committed)
   MINIMAX_API_KEY=<your-minimax-key>
   NVIDIA_NIM_API_KEY=<your-nvidia-nim-key>
   ```

3. Optional: override defaults in `.env`. The runner reads:

   | Variable | Default | Notes |
   |---|---|---|
   | `CORTEX_PROVIDER_PRIMARY_KEY` / `MINIMAX_API_KEY` | unset | Primary provider key. |
   | `CORTEX_PROVIDER_FALLBACK_KEY` / `NVIDIA_NIM_API_KEY` | unset | Fallback provider key. |
   | `CORTEX_MINIMAX_BASE_URL` | `https://api.minimax.io/v1` | Override only if proxying. |
   | `CORTEX_MINIMAX_MODEL` | `MiniMax-M3` | Primary model id. |
   | `CORTEX_NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Override only if proxying. |
   | `CORTEX_NIM_MODELS` | `openai/gpt-oss-120b,meta/llama-3.3-70b-instruct` | Comma-separated NIM candidates. Both are compared equally; the runner does not assume either wins. |
   | `CORTEX_PROTOTYPE_TIMEOUT_MS` | `30000` | Per-request timeout. |
   | `CORTEX_PROTOTYPE_MAX_TOKENS` | `1024` | Per-request max output tokens. Raise for models that hit `finish_reason=length` on the structured-output fixtures. CLI override: `--max-tokens <n>`. |
   | `GROQ_API_KEY` | unset | Groq prototype candidate key. **Prototype-only**; the production provider adapter does not read this. |
   | `CORTEX_GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq OpenAI-compatible base URL. Prototype runner only. |
   | `CORTEX_GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model id used by the prototype runner. |
   | `CORTEX_GROQ_REASONING_EFFORT` | `high` | Reasoning effort hint forwarded to Groq (e.g. `low`, `medium`, `high`). Prototype runner only. CLI override: `--groq-reasoning-effort <val>`. |

### Dry-run (no keys, no network)

```sh
npm run prototype:dry
```

This prints the planned experiment matrix and exits without making
any HTTP calls. It will report which keys are missing and which
providers will be exercised when you go live.

### Live run (requires keys)

```sh
npm run prototype:live
# or, with filters:
npx tsx src/prototype/runner.ts --live --only-provider minimax --only-fixture P1,P3
npx tsx src/prototype/runner.ts --live --only-provider nvidia-nim --only-nim-model openai/gpt-oss-120b
# Groq-only comparison run:
npx tsx src/prototype/runner.ts --live --only-provider groq
# Drop strict json_schema for Groq (use prompt-delimited JSON):
npx tsx src/prototype/runner.ts --live --only-provider groq --no-groq-strict-schema
# Override Groq reasoning effort for a single run:
npx tsx src/prototype/runner.ts --live --only-provider groq --groq-reasoning-effort low
```

The runner will:

- Call the MiniMax M3 primary endpoint with each fixture.
- Call the NVIDIA NIM endpoint with **both** candidate models
  (`openai/gpt-oss-120b` and `meta/llama-3.3-70b-instruct`) on every
  fixture, equally. It does not assume one model is better.
- Call the **Groq** endpoint with `openai/gpt-oss-120b` on every
  fixture. Groq is a **prototype comparison candidate only**; the
  production provider adapter does not use it. Groq requests use
  a strict `response_format: { type: "json_schema", json_schema:
  { schema, strict: true, name: "memory_analysis" } }` payload
  and forward `reasoning_effort` in the request body. MiniMax and
  NIM requests do NOT send `reasoning_effort`. Use
  `--no-groq-strict-schema` to fall back to prompt-delimited JSON
  for Groq (the schema is then not sent).
- Parse each model response against the structured-output schema.
- Apply one repair attempt if the JSON is malformed.
- Write a sanitized report under `.cortex/prototype/` containing parse
  success, schema errors, latency, model, provider, response format
  type, and (for Groq) the reasoning effort sent. **No API key values
  are written to the report.** For each attempt the human report
  prints `rf=<json_object|json_schema>` and (for Groq) `re=<effort>`.

If a key is missing, the affected provider is skipped with a clean
`missing-config` note and the rest of the matrix runs.

### Help

```sh
npx tsx src/prototype/runner.ts --help
```

## Layout

```
src/
  index.ts                # stdio entrypoint
  server.ts               # MCP server wiring
  tools/
    remember.ts           # remember(text) tool (MVP slice)
    recall.ts             # recall(text) tool (MVP slice)
  controller/
    remember-controller.ts  # safety pre-check, provider call, validation, persist
  logging/
    logger.ts             # stderr-only logger
  storage/
    storage.ts            # .cortex/ + SQLite skeleton + memories table + insert
  providers/
    types.ts              # embedding provider interface (skeleton)
    http-client.ts        # OpenAI-compatible chat-completions HTTP client
    memory-analysis.ts    # real provider adapter (primary + fallback + repair)
    minimax.ts            # embedding provider skeleton (primary)
    nvidia-nim.ts         # embedding provider skeleton (fallback)
    provider-registry.ts  # primary + fallback embedding selection
  safety/
    precheck.ts           # local secret / dump / junk classifier + summary redactor
    fixtures.ts           # safety fixture corpus
  retrieval/
    variants.ts           # benchmark variant registry (placeholders)
    seam.ts               # related-memory lookup seam (MVP placeholder)
    lexical.ts            # current lexical ranker (token overlap + phrase boost)
  benchmark/
    corpus.ts             # retrieval benchmark fixture records
    queries.ts            # retrieval benchmark query set
    metrics.ts            # pure metric functions (hit@K, TNR, per-family)
    retrieval-runner.ts   # retrieval benchmark CLI (no DB, no network)
                            # + async dense entry point
    abstention-audit.ts   # benchmark-only abstention-signal audit:
                            # AUROC + risk-coverage + slice summaries
    abstention-audit-runner.ts
                            # audit runner: per-query signal builder + artifact writer
                            # + human report formatter
    query-shapes.ts       # benchmark-only query-shape detector:
                            # isNoAnswerHardNegative / isTemporalCurrent /
                            # isNegationLike / isOodEntityLike /
                            # isParaphraseTrap / isFalsePremiseLike
    abstention-policy.ts  # benchmark-only multi-signal abstention policy
                            # evaluator: rule-based policies (score gate +
                            # agreement-count gate + query-shape flags)
    abstention-policy-runner.ts
                            # policy runner: builds per-query signal block,
                            # evaluates the policy grid, writes the artifact
                            # + human report
    variants/
      fts5.ts             # benchmark-only FTS5 (BM25) ranker
      vector.ts           # benchmark-only vector (cosine) ranker
                            # + VectorEmbedder interface + HashedBagOfWordsEmbedder
                            # (deterministic local baseline, no deps)
      dense-embedder.ts   # pluggable real local dense embedder:
                            # - StubDeterministicDenseEmbedder (default)
                            # - TransformersJsEmbedder (real ONNX via
                            #   @xenova/transformers; local-only)
                            # + EmbedderMetadata + createDenseEmbedder factory
      dense-vector.ts     # benchmark-only dense vector (cosine) ranker
                            # (async; uses DenseEmbedder from dense-embedder.ts)
      hybrid.ts           # benchmark-only hybrid (RRF) ranker
                            # over lexical / FTS5 / vector(-dense)
  config/
    env.ts                # env reading, no secrets in repo
tests/
  contracts.test.ts         # 2 tools, 1 param, stderr-only, .gitignore, schema
  provider-adapter.test.ts  # real adapter: primary, repair, fallback, sanitization
  http-client.test.ts       # auth header, error sanitization, network errors
  safety-fixtures.test.ts   # safety fixture placeholders
  retrieval-variants.test.ts
  remember-mvp.test.ts      # narrow MVP remember pipeline (saved/rejected/clarification/provider_error)
docs/
  env.md                  # config/env documentation
  architecture.md
```

## License

Private prototype. No license granted at this phase.
