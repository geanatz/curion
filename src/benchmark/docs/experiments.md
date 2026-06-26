# Benchmark Experiments

Deep experimental results, measured data, and methodology. All headline numbers are research artifacts, not deployment recommendations. Source artifacts live under `.curion/benchmark/` (gitignored).

---

## Corpus and query set — adversarial-expansion checkpoint

**132 records / 176 queries** across 6 families. The expansion added 8 new topical clusters focused on adversarial shape pressure.

### Per-family distribution

| Family | Queries | Notes |
|---|---|---|
| `exact` | 20 | Direct technical-term recall; 6 added in the expansion. |
| `paraphrase` | 32 | Paraphrased vocabulary; 20 added, 4 with `adversarialParaphrase` label, 4 with `nearMissCurrentCluster` label. |
| `temporal` | 26 | Current vs old; 14 added, 5 labeled divergent (raising total divergent from 2 to 7). |
| `multi-hop` | 26 | Multi-slot / list queries; 10 added, including 2 with `nearMissCurrentCluster` label. |
| `no-answer` | 46 | No relevant memory; 22 added, 15 labeled `hardNegative`, 4 with `negation` label, 4 with `falsePremise` label. |
| `orientation` | 26 | Project-status; 8 added, 2 with `nearMissCurrentCluster` label. |
| **total** | **176** | 132 records across 33 topical clusters of 4 records each. |

### 33 topical clusters

**Original 12:** stack, deploy, people, office, docs, temporal-old, testing, security, dependencies, monitoring, team-process, entity-domain.

**3 intermediate:** stack-extensions, testing-extensions, historical-extensions.

**10 expanded-set:** ci-extensions, observability-extensions, security-extensions, agent-runtime, data-pipeline, client-sdk, feature-flags, provider-routing, legacy-extensions, testing-extensions-2.

**8 adversarial-expansion:** adversarial-conflict, adversarial-superseded, adversarial-near-miss, adversarial-paraphrase-twin, adversarial-temporal-current-vs-previous, adversarial-false-premise-anchor, adversarial-orientation-extension, adversarial-multi-hop-bridge.

### Adversarial-property labels (fixture truth)

A subset of queries carry an optional `labels?: string[]` field on `BenchmarkQuery` (see `src/benchmark/queries.ts`). Labels are fixture truth, not derived from the query-shape detector.

| Label | Meaning | Detector side |
|---|---|---|
| `hardNegative` | No-answer query that shares strong tokens with a real record; expected to confabulate. | `isNoAnswerHardNegative` |
| `falsePremise` | Query asserts a premise the corpus does not name. | `isFalsePremiseLike` |
| `negation` | Query contains a negation token. | sub-label |
| `adversarialParaphrase` | Paraphrase query with deliberately low lexical overlap (hardest case for token-overlap ranker). | `isAdversarialParaphrase` |
| `divergentTemporal` | Temporal query where `expectedIds` and `currentTruthIds` are deliberately diverged. | `isDivergentTemporal` |
| `nearMissCurrentCluster` | Query whose top-1 is expected to be a near-miss distractor. | `isNearMissCurrentCluster` |

Counts: 15 `hardNegative`, 7 `falsePremise` (4 also `negation`), 4 `adversarialParaphrase`, 7 `divergentTemporal`, 7 `nearMissCurrentCluster` (some queries carry multiple labels).

---

## Dense embedder candidates

All dense variants are **benchmark-only comparison points** — not wired into the production `recall(text)` controller and the public MCP API is unchanged.

### Vector variant: scope, determinism, and limitations

- **Scope.** The vector variant is benchmark-only. It runs entirely in memory, never opens the project `.curion/curion.sqlite`, and does not change the public `recall(text)` API.
- **Default embedder.** `HashedBagOfWordsEmbedder` uses FNV-1a hashing + sign trick, sub-linear TF, optional TF-IDF weighting, and L2 normalization. No model download, no native dependency, no network, no GPU. Determinism is regression-tested.
- **Extension point.** The `VectorEmbedder` interface is the stable contract for plugging in a real local embedder.
- **Default threshold is `0` (no filter).** Cosine similarity of unit-normalized non-negative vectors is in `[0, 1]`, so the default threshold passes every candidate.

### Dense phase: why a real local embedder

The hashed-BoW control is a CI-stable baseline but is fundamentally a token-overlap ranker in dense disguise. A real semantic embedder captures paraphrase / synonym / topic-level similarity that token overlap misses.

The benchmark uses [`@xenova/transformers`](https://github.com/xenova/transformers.js) (v2.17+) for the local ONNX forward pass:
- Runs ONNX models entirely on the local machine (CPU; no GPU required).
- Default pinned model: `Xenova/all-MiniLM-L6-v2` (quantized, 384-dim, ~25MB cached, ~700ms first-load on a modern CPU).
- Architecture is **local-only**: no external API, no key, no remote inference. The first-run model download is the only network call and it is to the Hugging Face CDN.

---

## Measured results: dense variants (132-record corpus, 176 queries)

**Provenance note:** The artifacts under `.curion/benchmark/` are the source of truth. The tables below are single-run snapshots.

### vector-dense / hybrid-dense headline (real `Xenova/all-MiniLM-L6-v2`, adversarial-expansion corpus)

| Metric | vector-dense (real, 132rec) | hybrid-dense (RRF, real, 132rec) |
|---|---|---|
| rank1 (positive) | 82 / 130 = 63.1% | **90 / 130 = 69.2%** |
| currentTruth@1 (positive) | 78 / 130 = 60.0% | **87 / 130 = 66.9%** |
| hit@1 (positive) | 82 / 130 = 63.1% | **90 / 130 = 69.2%** |
| hit@3 (positive) | **113 / 130 = 86.9%** | 110 / 130 = 84.6% |
| hit@5 (positive) | **123 / 130 = 94.6%** | 116 / 130 = 89.2% |
| no-answer TNR | 0 / 46 = 0.0% | 0 / 46 = 0.0% |

For comparison, the prior 100-record / 96-query expanded set:

| Metric | vector-dense (real, 100rec) | hybrid-dense (RRF, real, 100rec) |
|---|---|---|
| rank1 (positive) | **52 / 72 = 72.2%** | 48 / 72 = 66.7% |
| hit@5 (positive) | 69 / 72 = 95.8% | **70 / 72 = 97.2%** |
| no-answer TNR | 0 / 24 = 0.0% | 0 / 24 = 0.0% |

The adversarial-expansion-corpus reading: the real dense vector holds rank-1 at **63.1%** and `hit@5` at **94.6%**; the real hybrid-dense hits **69.2% rank-1** (RRF benefits from new multi-hop / orientation clusters) but loses 7 hit-5 to the lexical / FTS5 contributor noise. The rank-1 percentage drops (72.2% → 63.1%) because the new query set is heavier on adversarial shapes.

### Qwen3 candidate: what is different

| Knob | MiniLM | Qwen3 |
|---|---|---|
| Library | `@xenova/transformers@2.17.2` | `@huggingface/transformers@3.x` |
| Model id | `Xenova/all-MiniLM-L6-v2` | `onnx-community/Qwen3-Embedding-0.6B-ONNX` |
| Dtype | quantized (Xenova q8) | q8 ONNX |
| Dim | 384 | 1024 |
| Pooling | mean | last_token |
| Normalize | true | true |
| Query prompt | none | `Instruct: <task>\nQuery:<query>` (queries only) |
| Document prompt | none | unprefixed |
| Approx cached size | ~25MB | ~600MB |

### EmbeddingGemma candidate: what is different

| Knob | MiniLM | Qwen3 | EmbeddingGemma |
|---|---|---|---|
| Library | `@xenova/transformers@2.17.2` | `@huggingface/transformers@3.x` | `@huggingface/transformers@3.x` |
| Model id | `Xenova/all-MiniLM-L6-v2` | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | `onnx-community/embeddinggemma-300m-ONNX` |
| Dtype | quantized (Xenova q8) | q8 ONNX | q8 ONNX |
| Dim | 384 | 1024 | 768 |
| Pooling | mean | last_token | mean |
| Query prompt | none | `Instruct: <task>\nQuery:<query>` | `task: <task> \| query: <query>` (queries only) |
| Document prompt | none | unprefixed | `title: none \| text: <text>` |
| Approx cached size | ~25MB | ~600MB | ~309MB |
| License | Apache-2.0 | Apache-2.0 | **Gemma Terms of Use** |

### BGE-M3 candidate: what is different

| Knob | MiniLM | Qwen3 | EmbeddingGemma | BGE-M3 |
|---|---|---|---|---|
| Library | `@xenova/transformers@2.17.2` | `@huggingface/transformers@3.x` | `@huggingface/transformers@3.x` | `@huggingface/transformers@3.x` |
| Model id | `Xenova/all-MiniLM-L6-v2` | `onnx-community/Qwen3-Embedding-0.6B-ONNX` | `onnx-community/embeddinggemma-300m-ONNX` | `Xenova/bge-m3` |
| Dtype | quantized | q8 | q8 | q8 |
| Dim | 384 | 1024 | 768 | 1024 |
| Pooling | mean | last_token | mean | cls |
| Normalize | true | true | true | true |
| Query prompt | none | `Instruct: ...` | `task: ... \| query: ...` | none (kind-agnostic) |
| Document prompt | none | unprefixed | `title: none \| text: ...` | unprefixed |
| Context (tokens) | 128 | 32k | 2048 | 8192 |
| License | Apache-2.0 | Apache-2.0 | Gemma Terms of Use | **MIT** |

### EmbeddingGemma measured results (dev split, 132 records / 176 queries)

| Metric | MiniLM | Qwen3 | EmbeddingGemma |
|---|---|---|---|
| Rank@1 (positive) | 82 / 130 (63.1%) | 82 / 130 (63.1%) | **91 / 130 (70.0%)** |
| CurrentTruth@1 (positive) | 78 / 130 (60.0%) | — | **87 / 130 (66.9%)** |
| Hit@5 (positive) | 123 / 130 (94.6%) | 123 / 130 (94.6%) | **125 / 130 (96.2%)** |
| Raw no-answer TNR | 0 / 46 (0%) | 0 / 46 (0%) | 0 / 46 (0%) |

**hybrid-dense (RRF over lexical / FTS5 / dense):**

| Metric | MiniLM | Qwen3 | EmbeddingGemma |
|---|---|---|---|
| Rank@1 (positive) | 90 / 130 (69.2%) | 88 / 130 (67.7%) | 89 / 130 (68.5%) |
| Hit@5 (positive) | 116 / 130 (89.2%) | 118 / 130 (90.8%) | **120 / 130 (92.3%)** |
| Raw no-answer TNR | 0 / 46 (0%) | 0 / 46 (0%) | 0 / 46 (0%) |

### BGE-M3 measured results

Not yet measured at time of last commit. The candidate wiring is in place; honest-comparison evidence is deferred to a follow-up benchmark run.

---

## Calibration experiment (benchmark-only abstention gates)

A separate opt-in **no-answer abstention / calibration experiment** studies how to set abstention gates. The motivation: the dense embedder has strong positive recall and a natural `0%` no-answer TNR at the default threshold of 0. The calibration question is **how to recover TNR while keeping positive regressions in check**.

The experiment reuses the existing `threshold / margin / ratio` gate families and adds:

- A **per-variant default sweep grid** spanning the dense variant's natural score range.
- A **hybrid-aware abstention diagnostic** on `hybrid-dense` per-query traces: per-source RRF rank/score/contribution for the top-1 candidate (`contributorSupport`) and `contributorAgreementCount`.

### Measured trade-offs (100-record corpus, 96 queries, stub-dense)

| Variant | Gate (best row) | TNR | ΔTNR | positive regressions | hit@5 (positive) | no-answer FPs fixed / remaining |
|---|---|---|---|---|---|---|
| `vector-dense` | `threshold@0.7` | 100.0% | +100.0pp | 71 / 72 (98.6%) | 1 / 72 (1.4%) | 24 / 0 |
| `vector-dense` | `threshold@0.4` | 50.0% | +50.0pp | 33 / 72 (45.8%) | 32 / 72 (44.4%) | 12 / 12 |
| `hybrid-dense` | `ratio@2` | 95.8% | +95.8pp | 71 / 72 (98.6%) | 0 / 72 (0.0%) | 23 / 1 |
| `hybrid-dense` | `threshold@0.04` | 45.8% | +45.8pp | 15 / 72 (20.8%) | 52 / 72 (72.2%) | 11 / 13 |

Headline reading: **the dense vector exhibits a sharp threshold gap** at `threshold@0.4` and **the dense hybrid exhibits a sharp RRF ratio gap** at `ratio@1.5`. The "all TNR at any cost" configurations (`threshold@0.7` and `ratio@2`) are not honest trade-offs: `hit@5` of `1.4%` / `0.0%` and `>97%` regression rate mean the ranker is mostly refusing to answer.

---

## Abstention-signal audit (benchmark-only)

A separate opt-in **abstention-signal audit** studies how well simple retrieval-derived signals separate answerable from no-answer queries. It is a *signal* study (how well does each signal distinguish?), in contrast to the calibration experiment's *gate* study (given a candidate gate, what is the trade-off?).

### What the audit measures

For each query, the audit attaches an `AbstentionSignals` block:
- **Retrieval signals:** `topScore`, `top1Top2Gap`, `top1Top2Ratio`, `returnedCount`.
- **Hybrid contributor signals** (hybrid / hybrid-dense only): `agreementCount`, `minContributorRank`, `maxContributorRank`, `meanContributorRank`, `minContributorScore`, `maxContributorScore`, `meanContributorScore`, `sourcePresence` (e.g. `"LFV"` = all three contributors surfaced the top-1).
- **Query-shape flags:** `isNoAnswerHardNegative`, `isTemporalCurrent`, `isNegationLike`, `isOodEntityLike`, `isParaphraseTrap`, `isFalsePremiseLike`.

For each signal: AUROC, risk-coverage curve data, coverage at fixed risk (5%, 10%, 20%), risk at fixed coverage (50%, 80%, 95%).

### How to interpret AUROC

```
AUROC 0.5  = uninformative (signal does not separate answerable from no-answer).
AUROC 0.6  = weak (useful marginal feature; not reliable gate on its own).
AUROC 0.7  = moderate (reasonable gate candidate; pair with another for production).
AUROC 0.8+ = strong (good signal; still far from perfect).
```

### Headline reading on real data (132 records, 176 queries, real MiniLM embedder, hybrid-dense audit)

| Signal | AUROC | Direction | Coverage @ 5% risk | Coverage @ 10% risk | Coverage @ 20% risk |
|---|---|---|---|---|---|
| `minContributorScore` | 0.751 | lower=positive | 32.4% | 68.2% | 80.7% |
| `meanContributorScore` | 0.743 | lower=positive | 32.4% | 67.6% | 80.7% |
| `maxContributorScore` | 0.713 | lower=positive | 30.7% | 67.0% | 80.7% |
| `agreementCount` | 0.605 | lower=positive | n/a | n/a | n/a |
| `top1Top2Ratio` | 0.594 | higher=positive | n/a | n/a | n/a |
| `topScore` | 0.594 | lower=positive | n/a | n/a | n/a |

---

## Multi-signal abstention policy evaluator (benchmark-only)

A separate opt-in **multi-signal abstention policy evaluator** tests a grid of rule-based policies (combinations of the audit's score gate, hybrid agreement gate, and query-shape flags) and reports per-policy trade-off with per-family damage and per-query FP/FN lists.

### Primary policies evaluated (4)

| ID | Rule |
|---|---|
| `flag-only-zero-hit-cost` | `isNoAnswerHardNegative OR isFalsePremiseLike` (no score gate) |
| `low-damage-score-0.30` | `meanContributorScore < 0.30 OR isNoAnswerHardNegative OR isFalsePremiseLike` |
| `moderate-score-0.40` | `meanContributorScore < 0.40 OR isNoAnswerHardNegative OR isFalsePremiseLike` (**recommended**) |
| `aggressive-score-0.50-no-fp` | `meanContributorScore < 0.50 OR isNoAnswerHardNegative` (drops false-premise flag) |

### Ablations evaluated (11)

- Score-only at thresholds {0.30, 0.35, 0.40, 0.45, 0.50}.
- `isNoAnswerHardNegative` alone.
- `isFalsePremiseLike` alone.
- `hardNeg OR falsePrem` (no score gate).
- `score < 0.40 OR hardNeg` (no false-premise).
- `agreementCount <= 1 OR score < 0.40` (weak-signal ablation).
- `agreementCount <= 2 AND score < 0.40` (AND-gate ablation; reported as disjunction of the two conditions for transparency).

### Headline reading (132 records, 176 queries, real MiniLM embedder, hybrid-dense)

| Policy | TNR% | PosAbst% | hit@5 retained | rank1 retained | P | R | F1 |
|---|---|---|---|---|---|---|---|
| `flag-only-zero-hit-cost` | 69.6 | 0.0 | 100.0 | 100.0 | 1.00 | 0.70 | 0.82 |
| `low-damage-score-0.30` | 71.7 | 1.5 | 99.1 | 98.9 | 0.94 | 0.72 | 0.81 |
| `moderate-score-0.40` (**recommended**) | 95.7 | 12.3 | 92.2 | 94.4 | 0.73 | 0.96 | 0.83 |
| `aggressive-score-0.50-no-fp` | 100.0 | 23.1 | 82.8 | 84.4 | 0.61 | 1.00 | 0.75 |

### Per-family positive abstention on recommended moderate policy

| Family | Total | Abstained | Rate |
|---|---|---|---|
| `exact` | 20 | 0 | 0.0% |
| `multi-hop` | 26 | 2 | 7.7% |
| `temporal` | 26 | 1 | 3.8% |
| `orientation` | 26 | 5 | 19.2% |
| `paraphrase` | 32 | 8 | 25.0% |

### Per-query false positives on recommended moderate policy

The full FP list lives in the on-disk artifact at `.curion/benchmark/retrieval-abstention-policy-*.json`. The summary:

- 8 paraphrase queries: `para-deploy-strategy`, `para-review-style`, `para-storage-detail`, `para-architecture-decisions`, `para-secret-handling`, `para-upgrade-cadence`, `para-incident-comms`, `para-rate-limit`.
- 5 orientation queries: `orient-monitoring-status`, `orient-data-pipeline-status`, `orient-observability-extensions-status`, `orient-conflict-status`, `orient-superseded-status` (last has `nearMissCurrentCluster` label).
- **2 multi-hop queries:** `multi-security-extensions`, `multi-observability-extensions`.
- **1 temporal query:** `temp-controller-validation` (labeled `divergentTemporal`).

### Per-query false negatives on recommended moderate policy

- **2 no-answer queries:** `nonexistent-staging-access` (no labels; legacy confabulation), `nonexistent-flink-pipeline` (labeled `hardNegative`; ranker returns 5 hits with high mean contributor score, not flagged by query-shape detector).

### Compared to calibration + audit

| Aspect | Calibration | Audit | Policy evaluator |
|---|---|---|---|
| Question | "Which gate / variant is best?" | "Do any signals separate?" | "How does a multi-signal rule behave on the full corpus?" |
| Output | Trade-off curve at one fixed gate | Per-signal AUROC + risk-coverage | Per-policy TNR / positive abstention / per-family damage / per-query FP / FN |
| Pick rule | Maximize TNR delta, tie-break on smallest positive-regression count | None — every signal is reported | None — every policy is reported |
| Per-query granularity | Per-query diagnostic for chosen gate | Per-query signal block for every query | Per-query decision + reason for every policy |
| Slice granularity | Variant only | Variant + family + shape | Family only |

---

## No-answer abstention / calibration experiment (benchmark-only)

A separate opt-in **no-answer abstention / calibration experiment** asks: can a deterministic abstention rule remove no-answer confabulations on the fixture corpus, and at what cost on the answerable set? It is benchmark-only and NOT wired into the production `recall(text)` controller.

### Policy categories

- **production-like (14 policies).** Use only signals available at runtime without ground-truth family or labels. Gates: `topScoreBelow` (3 thresholds), `top1Top2GapBelow` (2), `top1Top2RatioBelow` (2), `returnedCountBelow`, `topKSizeEquals` / `topKSizeAtMost`, `sufficiencyLabelIn` (2 variants), and 2 disjunctions combining an absolute score gate with a sufficiency-label rule.
- **fixture-shaped (2 policies).** Key on the benchmark's `family` field (fixture truth, NOT a runtime signal). `family-no-answer` is the strongest ceiling at TNR=100% / 0% positive abstention — NOT deployable.
- **oracle (7 policies).** Key on either the detector's query-shape flags or the explicit fixture-truth `queryLabels` field.

### How to read the policy frontier

Columns: `TNR%` (no-answer queries abstained on), `posAbst%` (positive queries abstained on), `hit5Ret%` (hit@5 retained on positives vs un-gated baseline), `rank1Ret%`, `curT1Ret%`, `P / R / F1` (precision / recall / F1 on the "should-abstain" binary task with `isNoAnswer` as positive class).

### Measured trade-offs (132-record corpus, 176 queries, lexical baseline)

Strongest fixture-shaped reading: **`family=no-answer`** reaches **TNR=100%** at **0% positive abstention** and **F1=1.00**. NOT deployable — the `family` field is fixture truth, not available at runtime.

Genuine production-like candidate: **`score-or-sufficiency-insufficient`**. Uses only runtime signals (absolute score gate AND the candidate-set sufficiency label). Reaches **TNR=93.5%** at **13.8% positive abstention** (F1=0.80). Damage concentrated on `paraphrase` (25%) and `orientation` (19%) families.

---

## Limitations of the experimental content

- All dense variant numbers are **retrieval-only**. No answer-quality / LLM judging is performed. The scaffold stays at `enabled: false`.
- No production `sqlite-vec` migration or persistent dense embedding storage. The dense index is built in-memory for the lifetime of a single benchmark run.
- The dense variants are **async-only**; the sync `runRetrievalBenchmark` throws on them.
- The vector variant is **benchmark-only**. Source-tree guards enforce that the production `recall(text)` controller and MCP server do NOT import the variant modules.
- The `vector-dense` (and `hybrid-dense`) variants are **async-only**; the sync `runRetrievalBenchmark` throws on them.
- The transformers.js model is bit-deterministic for a fixed input and a fixed runtime, so the benchmark artifact is reproducible across runs on the same machine. Different ONNX Runtime thread counts or quantization variants produce different (but semantically meaningful) vectors.
- **Answer-quality evaluation is disabled.** Scoring generated answers requires an LLM judge and is out of scope for the retrieval-only benchmark phase.
- **All results are research artifacts, not deployment recommendations.** The "best embedder" / "best policy" decision is deferred until multiple candidates are measured on the same harness.
- The recommended moderate policy's gains partly rely on the `isFalsePremiseLike` query-shape flag, which is **fixture-correlated**. Do not generalise the policy beyond the current fixture corpus without re-evaluating on a new corpus.
- The calibration experiment is **benchmark-only**. The abstention gates it computes are research artifacts, not deployment policies. Wiring them in is a separate, later phase.
- Bootstrap CIs are available but not reported in the headline number. With ~96 queries per run the resampled intervals are wide for per-family percentages; the `bootstrapCi` helper is exported for any future reporter that wants them.
