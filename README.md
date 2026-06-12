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

### Corpus + query set (intermediate checkpoint)

The fixture corpus and query set are the **intermediate**
checkpoint of 60 records and 54 queries, with the 6 documented
query families. The intermediate expansion is a deliberate step
between the original 24-record / 24-query starter set and a
future 132-record / 108-query adversarial set. The per-family
distribution is:

| Family        | Records (corpus) | Queries | Notes                                                |
|---------------|------------------|---------|------------------------------------------------------|
| `exact`       | 25 (across all topical clusters) | 10 | Direct technical-term recall.                        |
| `paraphrase`  | same             | 8       | Paraphrased vocabulary.                              |
| `temporal`    | 8 historical records in cluster 6 + cluster 15 | 6 | Current vs old; one labeled divergent case.         |
| `multi-hop`   | same             | 10      | Multi-slot / list queries.                           |
| `no-answer`   | same             | 10      | No relevant memory in the corpus.                    |
| `orientation` | same             | 10      | Project-status; multi-slot coverage + noise metric.  |
| **total**     | **60**           | **54**  | 15 topical clusters of 4 records each.               |

Tests in `tests/retrieval-benchmark.test.ts` pin the
intermediate minimums (≥ 60 records, ≥ 54 queries, ≥ 6 queries
per family) and the per-family distribution. The 6 families are
documented and stable; adding a new family requires a
schema-level review.

The 60 records span 15 topical clusters of 4 records each:
stack, deploy, people, office, docs, temporal-old, testing,
security, dependencies, monitoring, team-process, entity-domain,
stack-extensions, testing-extensions, and historical-extensions.
The office cluster (13..16) and the original historical cluster
(21..24) are the orientation distractor set; the new
historical-extensions cluster (57..60) is the legacy cluster
used for the temporal current-truth divergence case.

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
  A small labeled set of `temporal` queries (one in the
  intermediate set: `temp-storage-raw-text`) deliberately has
  `expectedIds` containing both the old and the new fact, with
  `currentTruthIds` containing only the new fact; this makes
  the divergence between hit@K and current-truth@1 explicit
  in the data, not implicit in the family name.
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

- **The new metrics are not adversarial.** The
  intermediate-checkpoint fixture corpus and
  query set (60 records / 54 queries) expand
  the family distribution and add a labeled
  temporal current-truth divergence case, but
  the broader 132-record / 108-query
  adversarial expansion is intentionally a
  later phase. The intermediate expansion
  reduces single-query volatility and adds
  more family coverage; it does not yet
  exercise near-miss / adversarial shapes.
- **The new metrics do not change the
  headline contract.** Existing report
  consumers and test assertions that reference
  `hit@1 / hit@3 / hit@5 / rank1 /
  currentTruth@1 / no-answer TNR` still work
  unchanged. The new blocks are additive. The
  one contract update is the divergent
  `currentTruthIds` for the labeled temporal
  case: the strict-mirror test in
  `tests/retrieval-benchmark.test.ts` was
  updated to a subset invariant (every
  `currentTruthId` is also an `expectedId`)
  and a labeled divergent-queries set.
- **Bootstrap CIs are available but not
  reported.** With ~50 queries per run the
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

The benchmark harness supports four retrieval variants. The
lexical variant is the production baseline; the FTS5, vector,
and hybrid (RRF) variants are **benchmark-only comparison
points** — they are not wired into the production `recall(text)`
controller and the public MCP API is unchanged.

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
  dependency-free and CI-stable.
- `hybrid` — benchmark-only `rankHybrid` (Reciprocal Rank
  Fusion over lexical / FTS5 / vector). See
  `src/benchmark/variants/hybrid.ts`. RRF fuses the three
  contributing rankings by rank — not by raw score — using
  the conventional `score = Σ weight / (k + rank)` formula.
  Default `k = 60`; the benchmark sweep covers
  `k ∈ {20, 60, 100}`. The variant is **rank-only** and does
  not introduce an abstention gate of its own; calibration
  of the fusion is a future phase.

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
- **What the default config produces.** On the 60-record
  sanitized intermediate-checkpoint fixture corpus + 54
  queries the vector variant reaches the headline numbers
  reported by the `benchmark:retrieval:all` run (the
  artifact under `.cortex/benchmark/` is the source of
  truth; the README does not pin specific percentages so a
  corpus / query set change does not require a doc
  update). The vector variant's `no-answer TNR = 0%` at
  the default threshold of 0 is a known limitation of the
  default; callers that need abstention should pass a
  positive threshold or extend the runner.

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
  On the current 60-record fixture corpus the hybrid
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

# Benchmark-only vector variant.
npm run benchmark:retrieval:vector

# Benchmark-only hybrid / RRF variant (default k = 60).
npm run benchmark:retrieval:hybrid

# Hybrid at the explicit k values from the sweep.
npm run benchmark:retrieval:hybrid:k20
npm run benchmark:retrieval:hybrid:k60
npm run benchmark:retrieval:hybrid:k100

# Side-by-side comparison across all four variants.
# Writes one lexical, one fts5, one vector, one hybrid,
# and one combined comparison artifact under
# .cortex/benchmark/. The combined file includes a
# per-family "hybrid vs best baseline" delta table.
npm run benchmark:retrieval:all
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
npm test
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
    variants/
      fts5.ts             # benchmark-only FTS5 (BM25) ranker
      vector.ts           # benchmark-only vector (cosine) ranker
                            # + VectorEmbedder interface + HashedBagOfWordsEmbedder
                            # (deterministic local baseline, no deps)
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
