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

# Run the long-horizon memory evaluation (scripted, no-network,
# temp-storage isolated; drives the storage lifecycle seams)
npm run benchmark:long-horizon-memory-evaluation
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
| `retrieval-adaptive-depth-evaluation-*.json` | Adaptive-depth evaluation |
| `decision-policy-evaluation-*.json` | Decision-policy evaluation (memory side) |
| `recall-policy-evaluation-*.json` | Recall-policy evaluation (recall side, scripted) |
| `long-horizon-memory-evaluation-*.json` | Long-horizon memory evaluation (storage lifecycle, scripted, temp storage) |
| `shadow-comparison-*.json` | Shadow-comparison evaluation (production vs shadow, scripted, temp storage, no activation) |

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

---

## Decision-policy evaluation (`benchmark:decision-policy-evaluation`)

A self-contained, deterministic, no-network harness that runs the real `decideRememberPolicyWithFallback` adapter against the curated v2 scenario set (26 scenarios across `normal-memory-decisions` / `safety-privacy` / `lifecycle-time` / `robustness-traps`) and writes a JSON artifact under `.curion/benchmark/` (prefix `decision-policy-evaluation-`).

The harness is benchmark-only / research-only:
- It does NOT touch the production storage, the public MCP API, the controller's behavior, or the `remember(text)` flow.
- It does NOT activate decision actions. The captured `DecisionAdapterSuccess.value` is recorded on the report but NEVER applied to persisted memory or any controller state.
- It does NOT use real credentials; the scripted fetch returns canned responses in-process and the harness wires fake API keys through the test-only `fetchImpl` seam.

### Quick start (scripted, default)

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:decision-policy-evaluation
```

### Live evaluation mode (manual opt-in, real provider)

Live mode is a **manual, opt-in, cost-bearing research probe** that invokes the real configured provider/model against the same curated scenario set. It is impossible to reach accidentally: it requires **BOTH** the env opt-in flag AND the `--live` CLI flag.

```sh
# Set your provider config (e.g. OpenAI-compatible, Anthropic, etc.) via the
# existing CURION_PRIMARY_* / CURION_FALLBACK_* env vars. Example:
export CURION_PRIMARY_BASE_URL="https://api.openai.com/v1"
export CURION_PRIMARY_MODEL="gpt-4o-mini"
export CURION_PRIMARY_API_KEY="sk-..."

# Then enable live mode. BOTH signals are required:
export CURION_DECISION_EVAL_LIVE=1
npm run benchmark:decision-policy-evaluation -- --live
```

The runner also ships a convenience script that wires both signals in one command:

```sh
npm run benchmark:decision-policy-evaluation:live
```

> ⚠️ **Live mode is a manual, opt-in research probe.** Each HTTP call is billed to the API key in your environment. The harness does **not** activate the production decision engine and the captured structured decision is **never** applied to persisted memory or any controller state. Inspect the live `report.live` metadata block on the artifact before trusting any pass rate.

### Misconfig gating

Live mode refuses to run unless BOTH signals are present. A user who passes `--live` without the env flag (or vice versa) gets a clear notice on stderr and the run stays in scripted mode:

```sh
# --live without env flag → scripted + notice.
npm run benchmark:decision-policy-evaluation -- --live

# env flag without --live → scripted + notice.
CURION_DECISION_EVAL_LIVE=1 npm run benchmark:decision-policy-evaluation
```

### Live-mode report shape

In live mode, the JSON artifact carries a top-level `live` metadata block in addition to the standard v2 metrics:

- `optInEnvPresent` — whether `CURION_DECISION_EVAL_LIVE=1` was set at run start.
- `optInCliArgs` — the `--live` CLI args the runner saw.
- `providerConfigSnapshot` — resolved base URL / model / apiFormat / timeoutMs / maxTokens, plus boolean `hasPrimaryApiKey` / `hasFallbackApiKey` presence flags. **API key values are never recorded.**
- `providerUsedCounts` / `modelUsedCounts` — aggregate counts over successful scenarios.
- `liveCallCount` — total HTTP calls across all live scenarios.
- `warnings` — reviewer-must-read-first caveats (cost, provider policy, latency, etc.).

In scripted mode, the `live` block is absent (the scripted artifact stays byte-equal to the v2 baseline apart from the new `evaluationMode` label).

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write              suppress the JSON artifact
--no-stdout             suppress the human report on stdout
--live                  opt in to live evaluation mode (requires CURION_DECISION_EVAL_LIVE=1)
```

Unknown flags are a hard error so a misspelled flag surfaces clearly.

---

## Recall-policy evaluation (`benchmark:recall-policy-evaluation`)

A self-contained, deterministic, **scripted / no-network** benchmark harness for the recall-side decision vocabulary — the recall-side counterpart of the decision-policy evaluation above. The benchmark runs a **benchmark-only** recall-policy adapter (NOT a production adapter — the production recall-policy decision engine does not yet exist) against a curated **v1 scenario set** of 16 scenarios across 5 categories (`answerable` / `no-memory-weak-match` / `ambiguity` / `lifecycle` / `robustness`) and writes a JSON artifact under `.curion/benchmark/` (prefix `recall-policy-evaluation-`).

The harness is benchmark-only / research-only:
- It does **not** touch production storage, the public MCP API, the production `recall(text)` controller, or any controller state.
- It does **not** install / activate a production recall-policy decision engine. The captured structured decision is recorded on the report but never applied to persisted memory, public output, public `structuredContent`, or any controller state.
- It does **not** use real credentials; the scripted fetch returns canned responses in-process and the harness wires fake API keys through the test-only `fetchImpl` seam.
- v1 ships **scripted mode only**; the `--live` flag is deliberately not exposed because there is no production recall-policy adapter to drive live.

### Quick start (scripted, default)

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:recall-policy-evaluation
```

### What the report carries

- `scenarioSetVersion: "v1"` stamp.
- `meta`: scenario count, passed / failed counts, adapter-ok / adapter-failed counts, total HTTP calls, abstention-critical and scope counters.
- `categories`: per-category summary table across the 5 recall-side categories; each row shows total / passed / failed and abstention-critical (p/total).
- `scopes`: per-scope summary (`model-quality` vs `provider-path`).
- `statusHistogram` + `reasonHistogram`: full vocabulary coverage, count of zero when not observed.
- `perStatusAccuracy` + `perReasonAccuracy`: per-vocabulary-slot accuracy over scenarios that set the expectation.
- `statusConfusionMatrix`: rows = expected status (or `<failed:kind>`), cols = actual status.
- `targetMemoryMatch`: aggregate Jaccard (= IoU over id sets) over scenarios that set an `expected*Ids` block.
- `providerCallStats`: total calls, repair / fallback attempt counts, adapter-failure count.
- `abstentionGate`: strict pass-100% gate on every `abstentionCritical` scenario.
- `safetyGate`: pass-only-safety-critical gate (informational in v1; no `safety` category scenarios in v1).
- `modelQualityGate` + `providerPathGate` + `gates.overallPassed`: full v1 gate stack.
- `runs`: per-scenario captured data (id / label / description / query / relatedCount / httpCalls / repairAttempted / fallbackAttempted / status / reason / confidence / sourceIds / conflictIds / supersededIds / olderVariantIds / capturedTargetIds / targetMemoryJaccard / assertions / pass / decisionQualityPass / providerPathPass / category / abstentionCritical / evaluationScope).
- `limitations`: the research-only disclosure block (no-network, benchmark-only adapter, frozen scenario set, public-API guards).

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write              suppress the JSON artifact
--no-stdout             suppress the human report on stdout
```

Unknown flags are a hard error so a misspelled flag surfaces clearly. The runner deliberately does **not** expose `--live` in v1 (the production recall-policy adapter does not yet exist).

### Limitations

The full limitations block lives on `report.limitations`. The headline items:

- **Synthetic-scenario evaluation** (v1 scenario set, 16 scenarios). The scenarios are hand-curated and exercise the benchmark-only adapter against small, deterministic evidence packets. A reviewer who reads a scenario-pass rate as "the recall-policy decision engine generalises to production traffic" is over-reading the result; the right reading is "the benchmark-only adapter produces the expected structured decision on the v1 scenario set".
- **No-network (scripted mode)** — the harness never makes a real provider call.
- **Benchmark-only adapter, not a production adapter** — the recall-policy decision vocabulary does not yet exist as a production code path; v1 ships a benchmark-only adapter that consumes canned JSON decisions via a scripted fetch. A future Phase that adds a production recall-policy adapter can lift these schemas into a server-internal module without changing the v1 scenario expectations.
- **Adapter-driven, not controller-driven** — the harness exercises a benchmark-only adapter directly with constructed evidence packets. The production recall controller's lexical ranker, adaptive-depth selector, and synthesis-validation reroute are NOT exercised by this harness. The companion adaptive-depth evaluation (`benchmark:retrieval:adaptive-depth`) and the recall-mvp controller test suite cover those paths.
- **Public MCP API unchanged** — exactly two tools (`remember`, `recall`); no MCP tool / resource / input schema change.
- **Frozen scenario set** (version `v1`). A future v2 that adds new categories, axes, or replaces existing scenarios is a deliberate, visible change.
- **Target-memory IDs** in `expectedSourceIds` / `sourceIdInAnswer` / `sourceIdNotInAnswer` are the stable storage ids the production recall controller would emit (NOT positional indices).
- **Safety gate is currently informational** — the v1 set does not exercise a `safety` category (the recall-policy adapter is benchmark-only and does not process user-supplied input through a safety pre-check). The `safetyGate` passes vacuously when 0 safety-critical scenarios are present; a future v2 that adds `secret` / `prompt-injection`-style recall scenarios can populate the gate.

---

## Long-horizon memory evaluation (`benchmark:long-horizon-memory-evaluation`)

A self-contained, deterministic, **scripted / no-network** benchmark harness that drives the production storage lifecycle seams (`insertMemoryRecord`, `transitionMemoryState`, `addSupersededByToMemory`, `updateMemoryMetadata`, `listActiveMemorySummaries`, `listMemoryTransitions`) against a curated v1 scenario set of **8 multi-step lifecycle stories** and emits a JSON artifact under `.curion/benchmark/` (prefix `long-horizon-memory-evaluation-`).

The benchmark is benchmark-only / research-only:
- It does NOT touch production storage (every scenario runs against a fresh temp `initStorage` handle in `os.tmpdir()`; the harness closes the DB and removes the temp dir at the end of every scenario).
- It does NOT call any provider, any network endpoint, or any external service.
- It does NOT mutate the public MCP `remember` / `recall` tool behavior, the public tool input schema, or the public `structuredContent` shape.
- It does NOT exercise the production `recall(text)` controller — the benchmark is a storage-lifecycle probe, not a controller probe.
- It does NOT activate decision engine actions or recall-controller behavior; it exercises the audit-backed storage seams directly.

### Quick start (scripted, default)

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:long-horizon-memory-evaluation
```

### What it measures

The benchmark evaluates whether the storage lifecycle seams preserve the correct **final state** and the correct **current truth** after a scripted multi-step evolution. The scenarios cover the brief's required multi-step lifecycle axes:

- **Supersession chain** — `A → B → C` (3-step chain); recall returns C.
- **Multi-update recall** — same shape with a different topic; recall returns the chain winner.
- **Invalidation / retraction** — `active → invalidated`; recall excludes the row.
- **Invalidate-after-supersede** — supersede then invalidate the new row; recall is empty (covers the "both paths can hide a memory" contract).
- **Conflict preserved active** — `conflictsWith` pointer added; BOTH memories remain `active` (the pointer is a soft relationship, NOT an auto-invalidation).
- **Redundancy linked** — `olderVariantsOf` pointer added; BOTH memories remain `active` (the pointer is a soft relationship, NOT a state transition).
- **False premise about a stale memory** — recall about a stale memory returns the CURRENT truth, NOT the stale record.
- **Multi-topic / project-like separation** — two parallel lifecycle chains in different domains; recall returns both current truths.

### Headline metrics

| Metric | What it measures |
|---|---|
| `lifecycleStateAccuracy` | Per-memory final state matches the expected state (active / superseded / invalidated) after the multi-step evolution. |
| `currentTruthAccuracy` | The final active-memory id set matches the expected current truth (set match; order-independent). |
| `staleExclusionAccuracy` | Every superseded / invalidated memory is excluded from the final active-memory id set. |
| `conflictPreservationAccuracy` | Every conflict-pointer scenario's two conflicting labels remain `active` after the pointer is added (no auto-invalidation). |
| `auditAccuracy` | Every scenario's `memory_transitions` audit-row count matches the expected count. |

### Gates

The benchmark reports five headline gates plus a top-level `overallPassed` verdict:

- `lifecycleStateGate` — every tracked memory's final state matches the expected state.
- `currentTruthGate` — every `currentTruthCritical` scenario's final active-memory set matches the expected current truth.
- `staleExclusionGate` — every `staleExclusionCritical` scenario's final active-memory set excludes every expected stale id.
- `conflictPreservationGate` — every `conflictCritical` scenario's two conflicting labels remain `active`.
- `auditGate` — every scenario's audit-row count matches.
- `gates.overallPassed` — conjunction of every gate.

### What the report carries

- `generatedAt` ISO timestamp.
- `scenarioSetVersion: "v1"` stamp.
- `evaluationMode: "scripted"` label.
- `meta`: scenario count, passed / failed counts, lifecycle-state check counters, current-truth / stale-exclusion / conflict-preservation / audit-critical counters, total audit rows.
- `categories`: per-category summary table (8 categories, one row each); each row shows total / passed / failed and the current-truth-critical + conflict-critical sub-counts.
- `aggregateMetrics`: the 5 headline metrics (lifecycleStateAccuracy, currentTruthAccuracy, staleExclusionAccuracy, conflictPreservationAccuracy, auditAccuracy).
- `lifecycleStateGate` + `currentTruthGate` + `staleExclusionGate` + `conflictPreservationGate` + `auditGate`: per-gate counts, pass/fail, and failed-scenario id lists.
- `gates`: structured overall-pass verdict plus a human-readable `summary` line.
- `runs`: per-scenario captured data — per-tracked-memory final states (label / id / state / relationship block / audit history), per-recall snapshots, per-expectation assertion rows, per-gate pass attribution.
- `limitations`: research-only disclosure block (12 items: synthetic-scenario evaluation, no-network, temp-storage isolated, public-API unchanged, controller-driven lifecycle out of scope, frozen scenario set, etc.).

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write              suppress the JSON artifact (the runner still prints the human report)
--no-stdout             suppress the human report on stdout (the runner still writes the artifact)
```

Unknown flags are a hard error. The runner deliberately does NOT expose `--live` in v1 (the benchmark is scripted / no-network by design; there is no live mode to opt into).

### Limitations

The full limitations block lives on `report.limitations`. The headline items:

- **Storage-lifecycle probe, not a controller probe.** The harness drives the internal storage seams directly. The production `remember(text)` controller's supersession-driven state transitions are NOT exercised by this benchmark; the recall controller's behavior is unchanged and is covered by the recall-mvp controller test surface. A reviewer who reads a scenario-pass rate as "the controller correctly handles multi-step lifecycle in production traffic" is over-reading the result.
- **Synthetic-scenario evaluation** (v1 scenario set, 8 scenarios). The scenarios are hand-curated and exercise the production storage seams against small, deterministic evidence packets.
- **No-network.** The harness never makes a real provider call.
- **Temp-storage isolated.** Each scenario creates a fresh storage handle in `os.tmpdir()` via `mkdtempSync` + `initStorage`. The harness closes the DB and removes the temp dir at the end of every scenario. Production `.curion/curion.sqlite` is NEVER touched.
- **Public MCP API unchanged.** The harness exercises the internal storage seams directly, NOT through the public `remember(text)` or `recall(text)` controller. The public MCP API, the public tool input schemas, and the public `structuredContent` shapes are unchanged. Exactly two tools (`remember`, `recall`) remain on the wire.
- **Frozen scenario set** (version `v1`). A future v2 that adds new categories, axes, or replaces existing scenarios is a deliberate, visible change.
- **Memory-content payloads are safe.** Every scenario's `memoryContent` is a short, safe English sentence (no secrets, no raw input fields, no PII).
- **Conflict pointer is a soft relationship, not an auto-invalidation.** A scenario that fails the `conflictPreservationGate` check indicates the conflict pointer accidentally triggered an auto-invalidation; the storage contract is that a `conflictsWith` pointer NEVER triggers a state transition.

---

## Shadow-comparison evaluation (`benchmark:shadow-comparison`)

A self-contained, deterministic, **scripted / no-network** benchmark harness that implements the shadow-comparison methodology defined in `docs/decision-engine/comparison-methodology.md`. It runs synthetic scenarios through BOTH the production controller path (`decisionMode=off`) and the shadow engine path (`decisionMode=shadow`), captures the structured shadow decision, and produces a comparison artifact.

This harness exercises the **full controller pipeline end-to-end** (via `runRememberController`) rather than calling the decision adapter directly (unlike `benchmark:decision-policy-evaluation`). This enables the production memory state and the shadow decision to be compared per scenario.

The harness is a **measurement tool, NOT a claim that the smart librarian is production-ready**. It does NOT activate engine actions, modify the public MCP API, or touch production storage.

### Quick start

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:shadow-comparison
```

### What it measures

The harness implements the Balanced Score methodology:

1. **Production baseline** — runs `runRememberController` with `decisionMode=off` on each scenario, capturing what the production controller actually stored.
2. **Shadow engine** — runs the same scenario with `decisionMode=shadow`, capturing the engine's structured decision via `setShadowRememberDecisionImpl`.
3. **Mutation confirmation** — verifies that shadow decisions do NOT mutate the production memory state (isolated temp DBs).
4. **Comparative evaluation** — pairs production and shadow outcomes per scenario and reports the delta.

The report covers three Balanced Score pillars:

- **Safety** — confirms that shadow decisions do not produce unsafe outcomes and that safety-classified inputs short-circuit before the engine runs.
- **Cleaner Memory** — captures the shadow engine's supersession / invalidation / redundancy / conflict-flag recommendations.
- **Recall Quality** — confirms production recall is unchanged (shadow does not mutate stored state).

### What the report carries

- `generatedAt` ISO timestamp.
- `scenarioSetVersion: "v1"` stamp.
- `evaluationMode: "shadow-comparison"` label.
- `meta`: total scenarios, production saved/rejected/provider-error counts, shadow engine reached/not-reached counts, mutation check pass/fail counts.
- `runs`: per-scenario captured data — production outcome, shadow decision (action/reason/confidence/id arrays), mutation check result, shadow decision matches script flag.
- `balancedScore`: v1 Balanced Score block (Safety / Cleaner Memory / Recall Quality pillars). Recall Quality is `available` — derived from 9 synthetic adaptive-depth scenarios (small-but-complete labeled subset). `coverageComplete=true` when all three labeled recall coverage metrics (rank-1 match, current-truth, no-answer TNR) are non-null. `promotionEligible` means eligible for owner review; no auto-promotion regardless of gate results.
- `limitations`: research-only disclosure block.

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write              suppress the JSON artifact
--no-stdout             suppress the human report on stdout
```

### Limitations

The full limitations block lives on `report.limitations`. The headline items:

- **Synthetic-scenario evaluation** (v1 scenario set, 8 scenarios). The scenarios are hand-curated and exercise the full controller pipeline with seeded temp storage.
- **No-network (scripted mode)** — the harness wires scripted fetch implementations for both the memory-analysis provider and the decision engine.
- **Temp-storage isolated** — each scenario uses a fresh temp storage handle; two isolated temp handles per scenario (one for production, one for shadow). Production `.curion/curion.sqlite` is NEVER touched.
- **Shadow decisions are NOT applied** — the engine's structured decision is captured via `setShadowRememberDecisionImpl` and recorded on the report. No engine-applied state transitions (supersession, invalidation, conflict-flag, redundant-flag) occur in shadow mode — both shadow and production paths store memories through the ordinary production storage path.
- **Benchmark-only / research-only** — the harness does NOT activate the production decision engine, modify the public MCP API, or mutate production storage.
- **No auto-promotion** — a passing gate does not activate the engine. Project-owner approval is always required.

---

## Applied-simulation evaluation (`benchmark:applied-simulation`)

A self-contained, deterministic, **scripted / no-network** Phase 3 benchmark harness that implements the applied-simulation methodology. Unlike Phase 2 (counterfactual projection), Phase 3 **applies** smart-librarian decisions to cloned temp storage and **measures** the actual recall quality impact against a production-baseline temp store.

This harness uses **Path A**: captures the smart-librarian decision, then applies storage/lifecycle-relevant effects inside the benchmark harness using storage lifecycle seams. It does **NOT** use production active-mode controller wiring.

### Quick start

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:applied-simulation
```

### What it measures

The harness implements the Phase 3 applied-simulation methodology:

1. **Production baseline** — for each scenario, seeds temp storage with related memories, runs `runRememberController` with `decisionMode=off` (production behavior), then runs `runRecallController` to capture baseline recall metrics.
2. **Applied simulation** — seeds an identical temp storage, runs with smart-librarian decisions captured via shadow seam, then **applies** storage/lifecycle effects via storage seams (`transitionMemoryState`, `addSupersededByToMemory`, `updateMemoryMetadata`).
3. **Measured delta** — runs `runRecallController` on the post-apply state and computes recall quality deltas.

The report covers:
- `delta.status: "applied"` — measured delta (NOT counterfactual projection)
- `memorySizeDelta` — measured change in active memory count
- `recallHitRateDelta` — measured change in recall hit rate
- `recallCurrentTruthRateDelta` — measured change in current-truth ranking rate
- `recallNoAnswerTnrDelta` — measured change in no-answer true-negative rate
- `recallRank1MatchRateDelta` — measured change in rank-1 match rate (if supported)

### Classification

Per-scenario classification as `better | same | worse | inconclusive`:
- `better` — safety passes, no recall metric regresses, at least one metric improves, useful memories not lost, minimum scenario coverage satisfied
- `worse` — any recall metric regresses, current-truth ranking regresses, no-answer TNR regresses, useful memory lost, or safety worsens
- `same` — recall outputs equivalent and memory-health impact neutral
- `inconclusive` — mixed results, metadata-only effects without measurable recall impact, or under-covered scenarios

### Minimum scenario gate

Classification as `better` or `worse` requires at least 12 scenarios with minimum coverage:
- ≥4 current-truth/supersession scenarios
- ≥2 no-answer scenarios
- ≥2 rank-1 current-truth scenarios
- ≥2 cleaner-memory improvement scenarios
- ≥2 safety scenarios

### Allowed applied storage actions (for scoring)

- `store` — no-op (memory already stored)
- `no_op` — no-op
- `supersede` — `active → superseded` transition + `addSupersededByToMemory`
- `invalidate` — `active → invalidated` transition
- `flag_redundant` — metadata update only (soft relationship)
- `flag_conflict` — metadata update only (soft relationship)
- `reject` — no storage mutation (production already rejected)

### Excluded from scoring

- `redact` — excluded (treated as metadata-only or inconclusive)
- `clarify` — excluded (treated as metadata-only or inconclusive)

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write              suppress the JSON artifact
--no-stdout             suppress the human report on stdout
```

### Limitations

The full limitations block lives on `report.limitations`. The headline items:

- **Phase 3 applied simulation (NOT Phase 2 counterfactual)** — delta fields are MEASURED from paired applied/baseline runs, NOT projections.
- **Synthetic-scenario evaluation** (v1 scenario set, 14 scenarios covering current-truth/supersession, no-answer, rank-1 current-truth, cleaner-memory improvement, safety, invalidation, and no-op/store-agreement categories).
- **No-network (scripted mode)** — the harness wires scripted fetch implementations. No live HTTP calls.
- **Temp-storage isolated** — each scenario uses fresh temp storage handles. Production `.curion/curion.sqlite` is NEVER touched.
- **Path A (storage lifecycle seams)** — smart-librarian decisions are captured via shadow seam and applied using `transitionMemoryState`, `addSupersededByToMemory`, `updateMemoryMetadata`. This is NOT production active-mode wiring.
- **Benchmark-only / research-only** — the harness does NOT activate the production decision engine in active mode, modify the public MCP API, or mutate production storage.
- **Minimum scenario gate required** — classification as `better`/`worse` requires minimum 12 scenarios with full category coverage.

---

## Production Replay Corpus Evaluation (`benchmark:replay-corpus`)

A self-contained, deterministic, **no-network** evaluation harness that processes corpus items through the Memory Decision Engine in replay mode and produces a JSON artifact + human-readable report.

Design source: `docs/decision-engine/production-replay-corpus.md`

### Quick start

```sh
# Default scripted run — no network, no cost, deterministic.
npm run benchmark:replay-corpus

# Dry-run (no artifact write)
npm run benchmark:replay-corpus -- --no-write

# Override artifact directory
npm run benchmark:replay-corpus -- --artifacts /tmp/my-artifacts
```

### What the report carries

- `generatedAt` ISO timestamp
- `corpusVersion` stamp
- `evaluationMode: "replay-corpus"` label
- `corpusSize` and `corpusBreakdown` (synthetic-proxy / manual-curated / sanitized-production counts)
- **Safety metrics**: `safetyAssertionPassRate`, `dangerousContentHandledRate`, `privacyViolationRate`, `rejectedItemCount`, `safetyAdapterFailureRate`
- **Memory lifecycle metrics**: `actionDistribution`, `actionMatchesGroundTruthRate`, `lowConfidenceActionRate`, `noOpRate`
- **Recall quality metrics** (computed from labels where present): `sourceMatchRate`, `rank1MatchRate`, `currentTruthMatchRate`, `noAnswerTnr`, `usefulMemoryLossRate`, `staleMemoryExposureRate`, `labeledRecallQueryCount`, `noAnswerExpectedCount`
- **Delta comparison metrics**: `decisionDivergenceRate`, `deltaClassificationRate` (matches / diverges), `inconclusiveRate`
- Per-item replay results with schema validation, safety class, ground-truth comparison, recall quality labels, and replay status
- Limitations block (research-only disclosure)

### Minimum initial corpus (proof-of-feasibility set)

| Dimension | Target |
|---|---|
| Total items | 20 |
| `remember` items | ≥ 10 |
| `recall-query` items | ≥ 10 |
| Synthetic-proxy items | ≥ 10 |
| Manual-curated items | ≥ 5 |
| Sanitised-production items | 0 (deferred) |
| Items with ground truth | 100 % |
| Safety-relevant items | ≥ 3 |
| Topic categories | ≥ 5 |

### What the harness does NOT do

- No live network — scripted responses only
- No production storage access
- No engine activation — decisions are captured but NOT applied to persistent memory
- No MCP API changes
- No sanitised-production data (initial corpus uses synthetic-proxy and manual-curated only)

### CLI flags

```
--artifacts <path>      override the artifact directory (default: .curion/benchmark)
--no-write             suppress the JSON artifact
--no-stdout            suppress the human report on stdout
```

### Limitations

The full limitations block lives on `report.limitations`. The headline items:

- **Proof-of-feasibility set only** — minimum diversity targets are met but this is NOT a statistically representative production sample.
- **Recall quality metrics from scripted engine** — metrics are computed from scripted engine responses that return expected labels deterministically. They reflect measurement infrastructure readiness, not engine quality. Full quality measurement requires Phase 3 applied simulation with live retrieval.
- **Synthetic-proxy and manual-curated only** — sanitised-production is deferred until the privacy/redaction approval process exists.
- **Offline evidence only** — replay remains offline evidence; it does NOT constitute proof of production activation fitness.
- **Recall query privacy checks** — forbidden pattern and PII checks apply to recall query text but do not substitute for full privacy review.
