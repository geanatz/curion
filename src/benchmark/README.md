# Retrieval Benchmark

A self-contained measurement harness for the lexical baseline and its variants. Loads a hand-curated fixture corpus and query set into memory, runs the production `rankLexical` function against every query, and emits a sanitized JSON report under `.curion/benchmark/` (gitignored).

**Scope:** The harness does NOT open the database, does NOT call any provider, and does NOT touch the network. The fixture corpus contains only sanitized memory summaries (no raw input, no credentials); corpus hygiene is regression-checked by `tests/retrieval-benchmark.test.ts`.

---

## Quick start

```sh
# Default run (production threshold 0.2, top-K 5, all families)
npm run benchmark:retrieval

# Restrict to one family
npm run benchmark:retrieval -- --only-family paraphrase

# Override threshold or top-K
npm run benchmark:retrieval -- --threshold 0.5 --top-k 10

# Run the abstention-policy evaluation
npm run benchmark:retrieval:abstention-policy

# Run the abstention-signal audit
npm run benchmark:retrieval:abstention-audit

# Run the calibration experiment
npm run benchmark:retrieval:calibrate
```

---

## What it measures

The benchmark reports three notions of "correctness" for positive queries, kept separate so the ranker's failure modes are visible:

- **hit@1 / hit@3 / hit@5** — did the expected memory id appear in the ranker's top-K? This is the **generous** retrieval-coverage contract: a relevant id in top-5 is "retrievable" even if not the top hit.
- **rank1 (top-hit)** — was the TOP result one of the expected ids? This is the **stricter** contract: the candidate the controller hands to the synthesizer is the one at rank 1, not rank 3. By construction `rank1 == hit@1`.
- **current-truth@1** — was the TOP result one of the `currentTruthIds`? For non-temporal families this equals `rank1` by construction. For the `temporal` family the old fact can be in top-K (so hit@K passes) but still rank above the current fact (so current-truth@1 fails). The gap between hit@K and current-truth@1 is the temporal failure mode.
- **no-answer TNR** — for queries with no relevant memory, did the ranker return zero hits?

The current baseline is intentionally a token-overlap ranker with a small exact-phrase boost. The benchmark is the reference point for later A/B comparisons against future variants.

---

## Metrics explained

### Headline metrics (all variants)

| Metric | What it measures |
|---|---|
| `rank1` / `hit@1` | Strict top-hit: the candidate the user sees first. |
| `hit@3` / `hit@5` | Retrieval coverage: at least one expected id in top-K. |
| `currentTruth@1` | For temporal queries: was the *current* fact ranked first? |
| `noAnswerTnr` | True negative rate: fraction of no-answer queries where the ranker abstained. |

### Derived IR metrics (positive queries)

- **precision@5** — `TP / (TP + FP)` across positive queries.
- **recall@5** — `TP / (TP + FN)` across positive queries.
- **F1@5** — harmonic mean of precision@5 and recall@5.
- **MRR@5** — mean reciprocal rank of the first expected id in top-K, clipped at 5.

### No-answer confusion matrix

From the `TP / FN / TN / FP` counts we derive: specificity (TNR), confabulation (FPR), answer coverage, and abstention precision.

### Score diagnostics

- `meanTopScore` broken down by outcome (all / pass / fail / no-answer).
- `meanScoreGap1To2` — average score difference between rank-1 and rank-2.
- `meanReturnedCount` — average number of candidates returned per query.

### Orientation / project-status sub-aggregate

- `recall@1 / @3 / @5` scoped to orientation queries.
- `slotCoverage@5` — fraction of expected slots covered in top-K for multi-slot queries.
- `noisyReturnRate` — fraction of orientation queries whose top-K contains a known distractor (records 13..16 or 21..24).
- `meanNoisePerQuery` — mean distractor count in top-K.

### Bootstrap CI

A deterministic `bootstrapCi` helper is exported from `src/benchmark/metrics.ts`. The runner does **not** include bootstrap CIs in the headline number; the helper is available for any future reporter that wants them.

---

## Benchmark variants

Implemented variants (all benchmark-only; NOT wired into the production `recall(text)` controller):

| Variant | Description | CLI |
|---|---|---|
| `lexical` | Production `rankLexical` baseline (token overlap + exact-phrase boost). | `benchmark:retrieval` |
| `fts5` | In-memory SQLite FTS5 with BM25. | `benchmark:retrieval:fts5` |
| `vector` | Cosine similarity over a deterministic hashed-bag-of-words embedding. | `benchmark:retrieval:vector` |
| `hybrid` | Reciprocal Rank Fusion over lexical / FTS5 / vector. | `benchmark:retrieval:hybrid` |
| `vector-dense` | Cosine similarity over a real local dense embedding. Async. | `benchmark:retrieval:vector-dense` |
| `hybrid-dense` | RRF over lexical / FTS5 / `vector-dense`. Async. | `benchmark:retrieval:hybrid-dense` |

Not yet implemented (placeholders): `hybrid-rerank`, `hybrid-entity-temporal`.

### Dense embedder implementations

| Embedder | Flag | Notes |
|---|---|---|
| `StubDeterministicDenseEmbedder` | `stub-dense` | Default. Deterministic, no model download. |
| `TransformersJsEmbedder` | `transformersjs` | Real local ONNX (`Xenova/all-MiniLM-L6-v2`, 384-dim). |
| `Qwen3Embedder` | `qwen3` | Experimental. 1024-dim, instruction-tuned, last-token pooling. |
| `EmbeddingGemmaEmbedder` | `embeddinggemma` | Experimental. 768-dim, Gemma license (research-only). |
| `BgeM3Embedder` | `bge-m3` | Experimental. 1024-dim, MIT license, kind-agnostic. |

See [`docs/dense-embedder-reference.md`](docs/dense-embedder-reference.md) for CLI flags, metadata shapes, and prompt templates.

---

## Generated reports / artifacts

All artifacts are written under `.curion/benchmark/` (gitignored). Each report contains: generated timestamp, variant, config, per-query evals (top ids, top scores, pass/fail, reason), aggregate metrics, and a failures list. No API keys, no Authorization headers, no network artifacts.

| Artifact prefix | Runner |
|---|---|
| `retrieval-lexical-*.json` | Default lexical run |
| `retrieval-fts5-*.json` | FTS5 variant |
| `retrieval-vector-*.json` | Hashed-BoW vector variant |
| `retrieval-hybrid-*.json` | Hybrid RRF variant |
| `retrieval-vector-dense-*.json` | Dense vector variant |
| `retrieval-hybrid-dense-*.json` | Dense hybrid variant |
| `retrieval-compare-*.json` | Cross-variant comparison |
| `retrieval-calibration-*.json` | Calibration experiment (sync variants) |
| `retrieval-calibration-dense-*.json` | Dense calibration experiment |
| `retrieval-abstention-audit-*.json` | Abstention-signal audit |
| `retrieval-abstention-policy-*.json` | Multi-signal policy evaluation |
| `retrieval-no-answer-abstention-*.json` | No-answer calibration experiment |

The `formatRetrievalReport` helper in `src/benchmark/retrieval-runner.ts` produces a human-readable summary for each artifact.

---

## Corpus and query set summary

**132 records / 176 queries** across 6 families. Tests in `tests/retrieval-benchmark.test.ts` pin the minimums (≥ 132 records, ≥ 176 queries, ≥ 6 queries per family) and the per-family distribution.

### Per-family distribution

| Family | Queries | What it tests |
|---|---|---|
| `exact` | 20 | Direct technical-term recall (verbatim-ish token overlap). |
| `paraphrase` | 32 | Same idea, different vocabulary. |
| `temporal` | 26 | Current fact expected; old fact is a distractor. |
| `multi-hop` | 26 | Answer requires joining multiple memories. |
| `no-answer` | 46 | No relevant memory in the corpus. |
| `orientation` | 26 | Project-status lookups. |

### Adversarial-property labels

A subset of queries carry optional `labels?: string[]` (hand-curated fixture truth, not derived from the query-shape detector):

| Label | Meaning |
|---|---|
| `hardNegative` | No-answer query expected to confabulate (shares tokens with a real record). |
| `falsePremise` | Query asserts a premise the corpus does not name. |
| `negation` | Query contains a negation token. |
| `adversarialParaphrase` | Paraphrase with deliberately low lexical overlap. |
| `divergentTemporal` | Temporal query where `expectedIds` and `currentTruthIds` are deliberately diverged. |
| `nearMissCurrentCluster` | Query whose top-1 is expected to be a near-miss distractor. |

Counts: 15 `hardNegative`, 7 `falsePremise`, 4 `adversarialParaphrase`, 7 `divergentTemporal`, 7 `nearMissCurrentCluster` (some queries carry multiple labels).

The 132 records span 33 topical clusters of 4 records each. The 8 new adversarial-expansion clusters surface conflict/superseded records, paraphrase-twins with low lexical overlap, near-miss distractors, current-vs-previous anchors, false-premise anchors, orientation extensions, and multi-hop bridges.

---

## Calibration and abstention tools

The benchmark ships with three complementary research tools that are **not wired into the production controller**:

### 1. Calibration experiment (`benchmark:retrieval:calibrate`)

Studies abstention gate trade-offs (`threshold / margin / ratio`) across variants. Output: a Pareto-style policy frontier of TNR vs. positive regressions. The dense calibration adds a hybrid-aware diagnostic (`contributorAgreementCount`, `contributorSupport` per source).

See [`docs/experiments.md`](docs/experiments.md) for measured trade-offs on the 100-record corpus.

### 2. Abstention-signal audit (`benchmark:retrieval:abstention-audit`)

Measures how well individual retrieval signals (score, gap, ratio, agreement count, query-shape flags) separate answerable from no-answer queries. Output: per-signal AUROC and risk-coverage curves. Most informative on `hybrid-dense` runs.

### 3. Multi-signal policy evaluator (`benchmark:retrieval:abstention-policy`)

Tests a grid of rule-based policies (combinations of score gate, agreement-count gate, and query-shape flags). Reports per-policy TNR, positive abstention rate, per-family damage, and per-query FP/FN lists. The recommended policy is `moderate-score-0.40`.

See [`docs/experiments.md`](docs/experiments.md) for the full policy grid, per-family breakdown, and FP/FN lists.

### 4. No-answer abstention / calibration experiment (`benchmark:retrieval:calibrate:no-answer`)

Studies deterministic abstention rules using the candidate-set sufficiency diagnostic. Ships 23 built-in policies (production-like, fixture-shaped, oracle). The genuine production-like candidate is `score-or-sufficiency-insufficient`.

---

## Experiment index

Deep experimental results, measured data, and methodology live in:

- [`docs/experiments.md`](docs/experiments.md) — corpus/query set details, dense embedder measured results, calibration experiment data, abstention-signal audit results, multi-signal policy evaluator results, and no-answer abstention experiment data.
- [`docs/dense-embedder-reference.md`](docs/dense-embedder-reference.md) — `DenseEmbedder` interface, embedder implementations summary, CLI flags, metadata shapes, and prompt templates.

---

## Development notes

### Source-tree guards

Production code must NOT import benchmark-only modules. Source-tree guards in the test surface enforce this:
- `tests/retrieval-vector.test.ts` — `vector` variant is benchmark-only.
- `tests/retrieval-dense.test.ts` — `vector-dense` / `hybrid-dense` are benchmark-only.
- `tests/abstention-policy.test.ts` — `recall` controller does NOT import policy modules.

The MCP server still exposes exactly two tools (`remember`, `recall`).

### Answer-quality scaffold (disabled)

The report carries an `answerQuality` block that is **always `enabled: false`** in this phase. The scaffold is exported; a future phase can flip the flag and populate `evaluations` without changing the report shape. **No provider is invoked and no LLM judge is called.** Scoring generated answers is out of scope for the retrieval-only benchmark phase.

### Candidate-set sufficiency diagnostic

A deterministic helper in `src/benchmark/sufficiency-diagnostic.ts` classifies a ranker's candidate set as one of seven stable labels: `sufficient`, `partial`, `insufficient`, `wrong-current-truth`, `near-miss`, `confabulation`, `no-answer-correct`. A production import guard test asserts the `recall` controller and MCP server do NOT import this module — it is benchmark-only by construction.

### Bootstrap CI

The `bootstrapCi` helper in `src/benchmark/metrics.ts` computes 95% confidence intervals for binary metrics via resampling with replacement and a fixed seed. Determinism is regression-tested. The runner does not include CIs in the headline number.

### Adding a new benchmark variant

1. Add the ranker to `src/benchmark/variants/`.
2. Register it in `src/benchmark/retrieval-runner.ts` CLI parsing and `runRetrievalBenchmark` / `runDenseRetrievalBenchmark`.
3. Add source-tree guards in the appropriate test file.
4. Do NOT import it from production code (`src/controller/`, `src/server.ts`).
