# Benchmark experiments

This directory contains the benchmark-only
experiments that study the retrieval / abstention
trade-off on the 132-record / 176-query adversarial
expansion corpus. None of these experiments
modify the production `recall(text)` controller,
the public MCP API, or the storage schema. They
are research artifacts, additive on top of the
production code.

The experiments are layered. Each is a
follow-on to the previous one:

1. **Sufficiency diagnostic**
   (`sufficiency-diagnostic.ts`,
   `experiment/sufficiency-diagnostic`). The
   first follow-on. Adds a per-query
   "candidate-set sufficiency" label so a
   reviewer can audit whether the ranker
   returned the right candidate set.

2. **No-answer abstention / calibration**
   (`no-answer-abstention.ts`,
   `experiment/no-answer-abstention-calibration`).
   The second follow-on. Adds a small set of
   deterministic abstention policies and
   reports the trade-off between no-answer
   TNR and positive abstention rate. The
   recommended production-like policy
   (`score-or-sufficiency-insufficient`) is
   the reference row for the next two
   experiments.

3. **False-abstention damage analysis**
   (`false-abstention-damage.ts`,
   `experiment/false-abstention-damage-analysis`).
   The third follow-on. Classifies each
   false-positive (a positive query the
   recommended policy wrongly abstained on)
   into an actionable damage category. The
   findings are:
     - paraphrase damage: 8/32 = 25%, with
       4/8 recoverable (`score-threshold-on-recoverable`)
       and 4/8 in the
       `multi-gate-conjunction-honest` bucket.
     - orientation damage: 8/26 = 30.8%,
       mostly honest (7/8).
     - EmbeddingGemma hybrid-dense dense
       ranker rank-1-missed 20/24 of these
       FPs; a dense reranker is not a silver
       bullet.

4. **Paraphrase-specific recovery / refined
   threshold** (`paraphrase-recovery.ts`,
   `paraphrase-recovery-runner.ts`,
   `experiment/paraphrase-recovery-threshold`).
   The fourth follow-on. Tests whether a
   NARROW paraphrase-aware escape hatch can
   reduce the recoverable paraphrase damage
   WITHOUT regressing the baseline's no-answer
   TNR. See below for the headline findings.

5. **Temporal / current-truth diagnostic**
   (`temporal-truth-diagnostic.ts`,
   `temporal-truth-diagnostic-runner.ts`,
   `experiment/temporal-current-truth-diagnostic`).
   The fifth follow-on. Classifies each
   temporal query's `currentTruthAt1`
   failure into a mutually-exclusive,
   actionable category so a reviewer can
   decide which fix to apply (temporal
   metadata, current-truth ranking
   preference, supersession / invalidation
   semantics, candidate generation, or
   fixture cleanup). The diagnostic is
   read-only and is the research basis for
   the "next fix" decision on the temporal
   gap. See the "Temporal truth diagnostic"
   section below for the headline findings.

6. **Temporal ranking-preference re-ranker
   diagnostic** (`temporal-ranking-preference.ts`,
   `temporal-ranking-preference-runner.ts`,
   `experiment/temporal-ranking-preference`).
   The sixth follow-on.
   Tests whether a lightweight
   temporal / current-truth preference
   re-ranker can promote current truth
   above stale truth when both are present
   in the top-K. The re-ranker is
   benchmark-only: a pure deterministic
   re-ordering of the existing top-K
   candidate list, with NO change to
   candidate generation. The variant table
   is honest about which variants use
   fixture truth (`currentTruthIds` or
   `STALE_TEMPORAL_IDS`) and which are
   production-like runtime signals. See
   the "Temporal ranking-preference
   re-ranker" section below for the
   headline findings.

7. **Supersession / metadata edge simulation**
   (`supersession-edge-simulation.ts`,
   `supersession-edge-simulation-runner.ts`,
   `experiment/supersession-edge-simulation`).
   The seventh follow-on (this experiment).
   Tests whether SIMULATED production-style
   candidate metadata (`supersedes`,
   `supersededBy`, `versionGroup`,
   `validFrom`, `validUntil`,
   `isSuperseded`, `currentInGroup`) can
   reproduce enough temporal ranking gain
   without consulting `currentTruthIds`
   directly. The edge map is
   hand-curated from fixture / corpus
   knowledge (the same supersession
   patterns the prior diagnostic
   documents); the re-rank rules do NOT
   consult `currentTruthIds`. The variant
   table is honest about which variants
   are `production-like`, `oracle`, or
   `metadata-simulation`. See the
   "Supersession edge simulation"
   section below for the headline
   findings.

8. **Multi-anchor / current-vs-previous
   handling** (`multi-anchor-current-previous.ts`,
   `multi-anchor-current-previous-runner.ts`,
   `experiment/multi-anchor-current-previous`).
   The eighth follow-on. Tests whether
   explicitly modeling the
   `current-vs-previous` anchor records
   (117..120) as PROTECTED FROM
   PROMOTION DISPLACEMENT can close the
   regression Experiment 7's combined
   rule introduced, while still
   recovering the +5 on the safe
   metadata-simulation baseline. The
   multi-anchor treatment is a NEW
   metadata dimension (the
   `currentVsPreviousAnchor` /
   `preferAnchorWhenQueryNeedsComparison`
   flags) that Experiment 7 did NOT
   consider. The variant table is
   honest about which variants are
   `production-like`, `oracle`,
   `metadata-simulation` (Experiment 7
   reference), or `multi-anchor-simulation`
   (Experiment 8 primary deliverable).
   See the "Multi-anchor / current-vs-
   previous handling" section below for
   the headline findings.

9. **Temporal candidate-generation probe**
   (`temporal-candidate-generation-probe.ts`,
   `temporal-candidate-generation-probe-runner.ts`,
   `experiment/temporal-candidate-generation-probe`).
   The ninth follow-on. Tests whether
   the remaining +4 gap (the
   `current-truth-missing-*` queries the
   Experiment 8 re-ranker cannot close)
   can be closed by getting the current
   records into the candidate set BEFORE
   the downstream re-ranker. The
   experiment composes Experiment 8's
   `multi-anchor-aware-combined` as the
   fixed downstream re-ranker and
   explores four honest candidate-
   generation variants: no-expansion
   larger-K (sanity row), linked-candidate
   expansion (the `supersededBy`
   projection), multi-anchor linked-
   expansion (the union of the
   `supersededBy` projection and the
   multi-anchor `currentTruthId`
   projection; PRIMARY DELIVERABLE),
   and an oracle candidate-injection
   ceiling. The variant table is honest
   about which variants are
   `production-like`, `reranker-control`,
   `metadata-simulation`,
   `multi-anchor-simulation`, or `oracle`.
   See the "Temporal candidate-generation
   probe" section below for the headline
   findings.

10. **Supersedes-promote guard probe**
    (`supersedes-promote-guard.ts`,
    `supersedes-promote-guard-runner.ts`,
    `experiment/supersedes-promote-guard`).
    The tenth follow-on. Tests whether
    a NARROW non-oracle `supersedes-
    promote` guard — "do not promote an
    INJECTED candidate (a candidate the
    candidate-expansion step added)
    above a NON-INJECTED rank-1
    candidate" — can ELIMINATE the
    `temp-rate-limit` regression
    Experiment 9's multi-anchor linked-
    expansion introduced, while
    preserving the multi-anchor-aware-
    combined's +6 recovery. The guard
    is a STRUCTURAL rule: it reads ONLY
    the post-expansion top-K + the
    injected-id set + the simulated
    supersession edge map; the rule
    does NOT consult `currentTruthIds`.
    The guard integrates the multi-
    anchor protection (a multi-anchor
    record at rank 1 is protected from
    being displaced) AND the
    `supersededBy` demote step. The
    variant table is honest about
    which variants are
    `production-like`,
    `reranker-control`,
    `metadata-simulation`,
    `multi-anchor-simulation`,
    `oracle`, or `oracle-diagnostic`
    (the IDEAL PROTECTION CEILING;
    clearly labeled diagnostic, NOT
    production-like). See the
    "Supersedes-promote guard probe"
    section below for the headline
    findings.

## Paraphrase recovery experiment

The question the experiment answers: "If we
add a narrow paraphrase-aware escape hatch to
the accepted `score-or-sufficiency-insufficient`
policy, how much of the recoverable paraphrase
damage can we recover, and at what safety
cost?".

The escape is a one-way suppression: it can
RETAIN a positive query the baseline would
have abstained on, but it can NEVER cause the
variant to ABSTAIN on a query the baseline
would have retained. This is the structural
safety property: the only way the variant's
positive abstention rate is LOWER than the
baseline's is by recovering FPs the baseline
made.

The variants tested:

- **Baseline** (`baseline-score-or-sufficiency-insufficient`).
  The accepted production-like policy with no
  escape. The reference row.
- **`paraphrase-detector-rank1-or-hit5`**
  (production-like). Suppress iff the query
  is flagged by the heuristic paraphrase
  detector (`isParaphraseTrap` OR
  `isAdversarialParaphrase`) AND
  `rank1 || hit@5`.
- **`paraphrase-detector-rank1-only`**
  (production-like). Stricter version: only
  `rank1` (not just `hit@5`).
- **`paraphrase-detector-loose-threshold-0.20`**
  (production-like). Narrow threshold
  refinement: the global threshold stays at
  0.30; the escape suppresses iff the query
  is flagged AND `0.20 <= topScore < 0.30`.
- **`paraphrase-detector-loose-threshold-0.25`**
  (production-like). Same as above with a
  tighter lower bound (0.25).
- **`paraphrase-family-rank1-or-hit5`**
  (fixture-shaped, NOT production). Suppress
  iff `family === "paraphrase"` AND
  `rank1 || hit@5`. The benchmark's `family`
  field is fixture truth; a real production
  ranker has no such label on incoming
  queries. This is the research / oracle-like
  ceiling.
- **`paraphrase-fixture-label-rank1-or-hit5`**
  (oracle, NOT production). Suppress iff the
  query carries the explicit
  `adversarialParaphrase` /
  `nearMissCurrentCluster` label AND
  `rank1 || hit@5`. The true ceiling.

### Headline findings (lexical baseline, 132 records / 176 queries)

| variant                                       | TNR%   | posAbst% | recoveredFps | F1   | verdict |
| --------------------------------------------- | ------ | -------- | ------------ | ---- | ------- |
| baseline-score-or-sufficiency-insufficient    | 100.0  | 18.5     | 0            | 0.79 | neutral |
| paraphrase-detector-rank1-or-hit5             | 100.0  | 16.2     | 3            | 0.81 | safe    |
| paraphrase-detector-rank1-only                | 100.0  | 16.2     | 3            | 0.81 | safe    |
| paraphrase-detector-loose-threshold-0.20      | 100.0  | 13.1     | 7            | 0.84 | safe    |
| paraphrase-detector-loose-threshold-0.25      | 100.0  | 13.8     | 6            | 0.84 | safe    |
| paraphrase-family-rank1-or-hit5               | 100.0  | 16.2     | 3            | 0.81 | safe    |
| paraphrase-fixture-label-rank1-or-hit5        | 100.0  | 18.5     | 0            | 0.79 | neutral |

Honest reading:

- The narrow paraphrase detector +
  rank-1-or-hit-5 escape recovers 3/24
  FPs (12.5%) at TNR=100%. The recovered
  FPs are all `score-threshold-on-recoverable`
  (the actionable policy damage category
  from the prior experiment). This is the
  most defensible production-like variant.
- The loose-threshold variant (0.20-0.30
  band) recovers 7/24 FPs (29.2%) at
  TNR=100%. The recovered FPs include 4 in
  the `multi-gate-conjunction-honest`
  category. The 4 in that category are
  `also-miss` on the EmbeddingGemma
  hybrid-dense dense ranker; a dense
  reranker is not a silver bullet for
  these.
- The fixture-shaped family-gated variant
  recovers the same 3 FPs as the detector
  variant (because the detector is
  family-agnostic and the corpus's
  paraphrase family is the same set the
  detector flags). This is a research /
  oracle-like ceiling only.
- The oracle-label variant recovers 0
  FPs. The labeled subset of the corpus is
  not the same as the recoverable set:
  the recoverable FPs are not labeled as
  `adversarialParaphrase` or
  `nearMissCurrentCluster`. The label-based
  oracle shows that a deployment that
  relied on the explicit label would miss
  the recovery.
- The variant table is honest about
  deployability: the family-gated and
  oracle-label variants are clearly marked
  `fixture-shaped` / `oracle` and are NOT
  a recommended deployable rule. A
  reviewer who wants to reason about a
  deployable rule reads the
  `production-like` rows.

The variant table's `safe` verdict is the
headline: a variant that preserves the
baseline's no-answer TNR AND recovers at
least one FP is the only kind of variant a
reviewer should consider for deployment.

### Limitations

- The paraphrase detector
  (`isParaphraseTrap` / `isAdversarialParaphrase`)
  is a HEURISTIC. The flag is NOT a
  production-grade signal; the experiment
  uses it as a research-only stand-in for
  "is this a paraphrase-shaped query?". A
  deployment would need a corresponding
  production-side paraphrase detector with
  documented precision / recall on the
  production corpus.
- The variant set is hand-curated, not
  learned. A future variant that the
  experiment surfaces as the right call is
  added to `BUILTIN_PARAPHRASE_RECOVERY_VARIANTS`
  by hand; the test pins the variant table
  so a future addition is a deliberate edit.
- The semantic evidence, when supplied, is
  a pre-computed set of `queryId ->
  "hit"|"miss"` from a separate dense
  benchmark. The variant does NOT re-derive
  the dense ranker's behavior. A reviewer
  who wants to audit the evidence reads the
  `evidenceSource` string.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:paraphrase-recovery

# Run without writing the artifact.
npm run benchmark:retrieval:paraphrase-recovery:no-write

# Run with the pre-computed semantic
# evidence (annotates each recovered FP
# with `semantic=also-miss` or
# `semantic=recoverable`).
npm run benchmark:retrieval:paraphrase-recovery:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:paraphrase-recovery
```

### Files

- `paraphrase-recovery.ts` — the pure
  functions: variant table, escape
  evaluation, per-variant metrics, safety
  verdict, report builder, human-readable
  formatter.
- `paraphrase-recovery-runner.ts` — the
  CLI orchestrator. Reads the no-answer
  artifact (and optionally the semantic
  evidence file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`ParaphraseRecoveryReport` (see the JSDoc
on the type). The shape is intentionally
distinct from the audit / calibration /
benchmark / diagnostic / policy /
no-answer / damage report shapes: the
experiment is a study of trade-offs across
a curated variant set, not a single chosen
rule. The file prefix is
`retrieval-paraphrase-recovery-*.json`.

## Temporal truth diagnostic (this experiment)

The question the experiment answers: "Of the
12 temporal queries the lexical baseline
wrongly surfaces (currentTruthAt1 = 12/26 =
46.2%; wrong-current-truth = 12/26 = 46.2%),
how many are caused by a stale anchor
outranking the current fact, how many by
the current fact not being in the candidate
set at all, how many by an unrelated
distractor, and how many by the fixture's
own ambiguity (the divergentTemporal label)?"

The diagnostic classifies every temporal
query's `currentTruthAt1` failure into a
mutually-exclusive, actionable category. The
category is the action-class for the gap; a
reviewer who wants to decide "is this a
metadata fix, a ranking fix, a candidate-
generation fix, or a fixture fix?" reads the
category.

### Category set (priority order)

| category                                       | meaning | action |
| ---------------------------------------------- | ------- | ------ |
| `abstained-or-empty`                           | ranker returned zero candidates | candidate generation |
| `fixture-ambiguous`                            | query carries the `divergentTemporal` label; `expectedIds` deliberately includes both old and new; `currentTruthAt1` is uninterpretable | fixture audit |
| `current-truth-top1`                           | top-1 IS the current truth | no fix needed |
| `current-truth-in-topk-stale-top1`             | top-1 IS a known stale / superseded / legacy / conflict record; current truth IS in the top-K; the OLD fact was ranked above the current one | temporal metadata / current-truth ranking preference |
| `current-truth-in-topk-no-stale-top1`          | top-1 is NOT current and is NOT a known stale candidate; current truth IS in the top-K; an unrelated distractor outranked the current fact | generic current-truth preference re-ranker |
| `current-truth-missing-stale-present`          | current truth is NOT in the top-K; a known stale record IS in the top-K; the stale fact shadows the current fact | candidate generation (or a current-truth-aware re-ranker) |
| `current-truth-missing-no-stale`               | current truth is NOT in the top-K and no stale candidate is either; the top-K is populated with unrelated records | candidate generation |
| `mixed-current-and-stale`                      | top-K contains BOTH the current truth and at least one known stale candidate; the gap is shape-dependent (temporal multi-hop or supersession pattern) | fixture audit |

The "known stale record" set is the union of
the legacy cluster (records 21..24), the
original temporal-old cluster (57..60), the
legacy no-validation cluster (93..96), the
conflict cluster (101..104), the
superseded-anchor cluster (105..108), the
temporal-old / no-validation cluster (96..100),
and the docs-team release record (112). The
set is exported as `STALE_TEMPORAL_IDS` so a
reviewer can audit it.

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| metric                                    | count | rate   |
| ----------------------------------------- | ----- | ------ |
| temporal queries                          | 26    | 100.0% |
| `currentTruthAt1`                         | 12    | 46.2%  |
| `currentTruthInTopK` (current-truth@5)    | 22    | 84.6%  |
| `staleTop1`                               | 8     | 30.8%  |
| `staleOverCurrent` (stale at rank-1 AND current in top-K) | 7 | 26.9% |
| `currentMissing` (current NOT in top-K)   | 4     | 15.4%  |
| `divergentTemporal` labeled               | 7     |        |
| `divergentLabeled` @1 miss                | 6     |        |
| `divergentLabeled` staleTop1              | 3     |        |

Per-category (temporal slice, n=26):

| category                                       | count | rate   |
| ---------------------------------------------- | ----- | ------ |
| `abstained-or-empty`                           | 0     | 0.0%   |
| `fixture-ambiguous`                            | 7     | 26.9%  |
| `current-truth-top1`                           | 11    | 42.3%  |
| `current-truth-in-topk-stale-top1`             | 5     | 19.2%  |
| `current-truth-in-topk-no-stale-top1`          | 1     | 3.8%   |
| `current-truth-missing-stale-present`          | 2     | 7.7%   |
| `current-truth-missing-no-stale`               | 0     | 0.0%   |
| `mixed-current-and-stale`                      | 0     | 0.0%   |

Honest reading of the per-category distribution:

- **The single largest action-class is
  `current-truth-in-topk-stale-top1` (5/26 =
  19.2%):** the candidate set IS sufficient
  (the current fact is in the top-K) but the
  ranker ranked a known stale /
  superseded / legacy / conflict anchor
  above the current fact. The right fix is
  a temporal-metadata or current-truth
  ranking preference re-ranker, NOT a
  candidate-generation change. The 5
  queries in this bucket are the
  "recoverable with a metadata fix" subset.
- **The second largest action-class is
  `current-truth-missing-stale-present`
  (2/26 = 7.7%):** the current fact is NOT
  in the top-K but a stale anchor IS. The
  candidate set is insufficient for current
  truth, and the stale fact shadows the
  current fact. The right fix is candidate
  generation (or a current-truth-aware
  re-ranker that swaps the stale anchor
  out).
- **The `fixture-ambiguous` bucket is
  large (7/26 = 26.9%):** this is the
  divergentTemporal-labeled set, where
  `expectedIds` deliberately includes both
  old and new so `currentTruthAt1` is
  uninterpretable. The fixture is the
  "what would a current-vs-stale metric
  even mean here?" anchor. A reviewer who
  wants the strict `currentTruthAt1` metric
  to be interpretable on the full
  temporal slice would need to either
  re-label these queries or split them
  into a separate "current vs previous
  disambiguation" sub-family.
- **`mixed-current-and-stale` is empty on
  the temporal slice (0/26):** the
  corpus's current/superseded pair
  patterns do not produce a "top-K has
  both, ambiguous which is the right
  answer" case. The category is
  reserved for future fixtures.
- **`current-truth-in-topk-no-stale-top1`
  is small (1/26 = 3.8%):** an unrelated
  distractor outranked the current fact.
  The right fix is a generic
  current-truth preference re-ranker; a
  stale-aware supersession rule alone is
  not enough.
- **The EmbeddingGemma hybrid-dense dense
  ranker rank-1-missed 11/11 of the
  temporal queries in the pre-computed
  semantic evidence (all 11 are `miss`):**
  the dense ranker is not a silver bullet
  for the temporal gap. A dense reranker
  does not help on the
  `current-truth-in-topk-stale-top1`
  bucket (the dense ranker also surfaces
  the stale anchor at rank-1) and it does
  not help on the
  `current-truth-missing-stale-present`
  bucket (the dense ranker also fails to
  surface the current fact at all).

### What the next fix should be

Reading the per-category distribution, the
recommended next step is a NARROW
temporal-metadata / current-truth-ranking-
preference re-ranker applied to the
`current-truth-in-topk-stale-top1` bucket
(5/26 queries). The re-ranker is
production-deployable because:

- It does NOT change the candidate
  generation: the current fact is already
  in the top-K; the re-ranker only
  re-orders the existing candidates.
- It does NOT change the no-answer TNR:
  the re-ranker does not introduce a
  confabulation on no-answer queries.
- It does NOT change the public API.
- It does NOT run a new dense embedding
  benchmark at retrieval time; the
  re-ranker is a deterministic, signal-
  only operation on the ranker's existing
  output.

A separate candidate-generation fix
should target the
`current-truth-missing-stale-present`
bucket (2/26 queries). The two fixes are
independent; a future experiment
(`experiment/temporal-ranking-preference`
or similar) can study the candidate-
generation fix in isolation.

### Limitations

- The diagnostic is benchmark-only; the
  production `recall(text)` controller is
  unchanged. The category table is a
  research artifact, not a deployment
  policy.
- The stale-detection set is hand-curated.
  A future revision of the corpus (new
  superseded / conflict records) requires
  updating `STALE_TEMPORAL_IDS`; the
  diagnostic does NOT auto-derive the set.
- The fixture-ambiguous category keys on
  the `divergentTemporal` label. Queries
  that are "ambiguous" in a way the
  fixture did NOT label fall into the
  normal temporal categories; a future
  expansion of the label set is the
  right way to surface them.
- The semantic overlay is a passed-in
  `queryId -> "hit"|"miss"` map derived
  from a separate dense benchmark run
  (`src/benchmark/data/false-abstention-damage-semantic-evidence.json`).
  The diagnostic does NOT re-derive the
  dense ranker's behavior and does NOT
  run a new dense benchmark. The
  pre-computed map covers 11/26 temporal
  queries; a reviewer who wants fresh
  dense evidence re-runs the
  `embeddinggemma` benchmark separately
  and re-runs the diagnostic with the
  updated evidence file.
- The category `mixed-current-and-stale`
  is reserved for a future fixture; the
  current corpus does not produce a
  "top-K has both current and stale, with
  no clear right answer" case. The
  category is in the table so a future
  corpus revision does not silently
  change the category set.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:temporal-truth-diagnostic

# Run without writing the artifact.
npm run benchmark:retrieval:temporal-truth-diagnostic:no-write

# Run with the pre-computed semantic
# evidence (annotates each temporal
# query with the dense ranker's
# rank-1 outcome, when known).
npm run benchmark:retrieval:temporal-truth-diagnostic:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:temporal-truth-diagnostic
```

### Files

- `temporal-truth-diagnostic.ts` — the
  pure functions: category table,
  classifier, aggregator, report
  builder, human-readable formatter,
  stale-record set.
- `temporal-truth-diagnostic-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence file),
  runs the experiment, and writes the
  JSON artifact.

### Artifact shape

The on-disk artifact is a
`TemporalTruthDiagnosticReport` (see the
JSDoc on the type). The shape is
intentionally distinct from the audit /
calibration / benchmark / sufficiency /
policy / no-answer / damage / paraphrase-
recovery report shapes: the experiment is
a per-category classifier, not a study
of trade-offs across a variant set. The
file prefix is
`retrieval-temporal-truth-diagnostic-*.json`.

## Temporal ranking-preference re-ranker diagnostic (this experiment)

The question the experiment answers: "If
we add a lightweight temporal / current-
truth preference re-ranker to the
baseline ranker's existing top-K, can we
recover the
`current-truth-in-topk-stale-top1` bucket
(5/26 on the lexical baseline) WITHOUT
regressing cases that are already
`currentTruthAt1`?".

The re-ranker is benchmark-only: a PURE
DETERMINISTIC re-ordering of the
existing top-K candidate list. It does
NOT change candidate generation. It does
NOT call any provider, any ranker, or
any external service. It does NOT modify
the production `recall(text)` controller,
the public MCP API, or the storage
schema. The production code is unchanged.

### Variant table (6 variants, lexicographic order)

| id | category | re-rank rule | runtime signal |
| -- | -------- | ------------ | -------------- |
| `baseline-no-rerank` | `production-like` | none (reference) | n/a |
| `oracle-current-truth-promote-all` | `oracle` | promote every `currentTruthIds` id to the top | fixture truth |
| `oracle-current-truth-promote-first-only` | `oracle` | promote only the first `currentTruthIds` id | fixture truth |
| `fixture-shaped-stale-demote` | `fixture-shaped` | demote every `STALE_TEMPORAL_IDS` id to the bottom | fixture truth |
| `fixture-shaped-stale-demote-current-promote` | `fixture-shaped` | demote stale + promote current (combined) | fixture truth |
| `mild-heuristic-temporal-current` | `production-like` | demote the embedded narrow stale-like set (legacy 21..24 + docs-team 112) iff the query is flagged `isTemporalCurrent` by the runtime detector | `isTemporalCurrent` flag |

Honest reading: the `oracle` and
`fixture-shaped` variants use fixture
truth (`currentTruthIds` /
`STALE_TEMPORAL_IDS`) and are research /
oracle-like ceilings. The
`mild-heuristic-temporal-current` variant
is the only production-like variant that
performs a non-trivial re-rank; the
heuristic is the runtime
`isTemporalCurrent` flag (a token-
presence detector for "current" / "now"
/ "today") and the embedded stale-like
set is a NARROW hand-curated subset. A
reviewer who wants to reason about a
deployable rule reads ONLY the
`production-like` rows.

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| variant | n | baseline@1 | after@1 | delta | staleTop1 baseline->after | staleOverCurrent baseline->after | currentMissing baseline->after | regressions | unchanged-missing | verdict |
| ------- | -- | ---------- | ------- | ----- | -------------------------- | ------------------------------- | ----------------------------- | ----------- | ----------------- | ------- |
| `baseline-no-rerank`                          | 26 | 12 | 12 |   0 |  8-> 8 ( 0) |  7-> 7 ( 0) |  2-> 2 ( 0) | 0 | 4 | neutral |
| `oracle-current-truth-promote-all`            | 26 | 12 | 22 | +10 |  8-> 1 (-7) |  7-> 0 (-7) |  2-> 2 ( 0) | 0 | 4 | safe |
| `oracle-current-truth-promote-first-only`     | 26 | 12 | 22 | +10 |  8-> 1 (-7) |  7-> 0 (-7) |  2-> 2 ( 0) | 0 | 4 | safe |
| `fixture-shaped-stale-demote`                 | 26 | 12 | 18 |  +6 |  8-> 0 (-8) |  7-> 0 (-7) |  2-> 2 ( 0) | 0 | 4 | safe |
| `fixture-shaped-stale-demote-current-promote` | 26 | 12 | 22 | +10 |  8-> 0 (-8) |  7-> 0 (-7) |  2-> 2 ( 0) | 0 | 4 | safe |
| `mild-heuristic-temporal-current`             | 26 | 12 | 12 |   0 |  8-> 8 ( 0) |  7-> 7 ( 0) |  2-> 2 ( 0) | 0 | 4 | safe |

Where:

- `baseline@1` / `after@1` — `currentTruthAt1`
  count before / after the re-rank. The
  baseline row preserves the prior
  diagnostic's 12/26 number.
- `staleTop1` — number of queries whose
  top-1 is in `STALE_TEMPORAL_IDS`.
- `staleOverCurrent` — number of queries
  with BOTH `staleTop1` AND a
  `currentTruthId` in the top-K.
- `currentMissing` — number of queries
  with NO `currentTruthId` in the top-K.
- `regressions` — number of queries that
  were `currentTruthAt1` on the baseline
  and are NOT `currentTruthAt1` after
  the re-rank. **Zero on every variant.**
- `unchanged-missing` — number of queries
  with `currentMissing` both before and
  after. **The re-ranker's ceiling**: a
  re-ranker that does not change
  candidate generation cannot help
  these queries.

Honest reading of the variant table:

- **The oracle / fixture-shaped variants
  recover 6-10 of the 10 recoverable
  queries** (the 22-12=10 current-truth
  queries that are in the top-K but not
  at the top). The combined
  `fixture-shaped-stale-demote-current-promote`
  variant matches the oracle at +10, with
  zero regressions. The ceiling is the
  `currentTruthInTopK` number from the
  prior diagnostic (22/26 = 84.6%).
- **The fixture-shaped-stale-demote
  variant alone recovers +6** (10 minus
  4, because demoting a stale anchor out
  of the top-1 position does not always
  bring the current truth to the top-1
  position: in 4 of the 10 cases, the
  rank-1 after the demote is a different
  unrelated distractor). Promoting the
  current truth explicitly is the
  necessary complement.
- **The production-like
  `mild-heuristic-temporal-current`
  variant is a no-op on the lexical
  baseline** because the upstream
  baseline artifact does not populate
  the `abstentionSignals.isTemporalCurrent`
  flag (the flag is only populated by the
  abstention-audit runner, not the
  regular retrieval runner). The variant
  is included as a research probe for
  the question "if a production-side
  temporal-current detector existed and
  was conservative, would a mild
  current-truth preference recover any
  of the gap?". The honest answer on
  the lexical baseline is "we cannot
  tell; the runtime signal is absent on
  the input".
- **The re-ranker's ceiling is 4** (the
  `currentMissing` count from the prior
  diagnostic). The
  `current-truth-missing-stale-present`
  (2/26) and `current-truth-missing-no-stale`
  (0/26) buckets are out of reach for
  the re-ranker: the current fact is not
  in the candidate set, so no in-list
  re-ordering can surface it. A separate
  candidate-generation fix is needed for
  those queries.
- **Zero regressions on every variant.**
  The verdict is `safe` on every
  *re-ranker* row. The `baseline-no-rerank`
  row is the no-op reference, so its
  verdict is `neutral` (it preserved the
  baseline's `currentTruthAt1` count
  without recovering anything). This is
  the headline safety signal: a re-ranker
  that does not introduce regressions
  can be considered for further study
  even if it does not recover much.

### Per-category change table (temporal slice, n=26)

The per-variant perCategoryChange block
maps `(baseline-category -> after-category)
-> count`. The dominant `X -> X` diagonal
is the unchanged count; the off-diagonal
rows are the per-variant recoveries.

For `oracle-current-truth-promote-all`
and `oracle-current-truth-promote-first-only`:

| baseline category | after category | count |
| ----------------- | -------------- | ----- |
| `current-truth-top1` | `current-truth-top1` | 11 |
| `fixture-ambiguous` | `fixture-ambiguous` | 7 |
| `current-truth-in-topk-stale-top1` | `current-truth-top1` | 5 |
| `current-truth-missing-stale-present` | `current-truth-missing-stale-present` | 2 |
| `current-truth-in-topk-no-stale-top1` | `current-truth-top1` | 1 |

The combined
`fixture-shaped-stale-demote-current-promote`
variant has the same per-category shape.
The `fixture-shaped-stale-demote` variant
alone moves 4 of 5 from
`current-truth-in-topk-stale-top1` to
`current-truth-top1`; 1 stays in
`current-truth-in-topk-no-stale-top1`
(the demoted stale anchor's slot was
filled by an unrelated distractor at
rank-1, not the current truth).

The `mild-heuristic-temporal-current`
variant is a no-op on the lexical
baseline: the per-category change table
matches the baseline's distribution
exactly (the diagonal is the entire
table).

### Clean / fixture-ambiguous split

The prior diagnostic's `fixture-ambiguous`
category is the `divergentTemporal`-
labeled set (7/26). The split surfaces
the clean slice (19/26, the labeled
non-divergent temporal queries) vs the
fixture-ambiguous slice (7/26, where
`currentTruthAt1` is uninterpretable
per fixture design).

| variant | cleanN | cleanBaseline@1 | cleanAfter@1 | cleanDelta | ambigN | ambigBaseline@1 | ambigAfter@1 | ambigDelta |
| ------- | ------ | --------------- | ------------ | ---------- | ------ | --------------- | ------------ | ---------- |
| `baseline-no-rerank`                          | 19 | 11 | 11 |  0 | 7 | 1 | 1 |  0 |
| `oracle-current-truth-promote-all`            | 19 | 11 | 17 | +6 | 7 | 1 | 5 | +4 |
| `oracle-current-truth-promote-first-only`     | 19 | 11 | 17 | +6 | 7 | 1 | 5 | +4 |
| `fixture-shaped-stale-demote`                 | 19 | 11 | 15 | +4 | 7 | 1 | 3 | +2 |
| `fixture-shaped-stale-demote-current-promote` | 19 | 11 | 17 | +6 | 7 | 1 | 5 | +4 |
| `mild-heuristic-temporal-current`             | 19 | 11 | 11 |  0 | 7 | 1 | 1 |  0 |

Honest reading: the oracle and combined
variants recover +6 on the clean slice
and +4 on the fixture-ambiguous slice.
The `fixture-shaped-stale-demote` variant
recovers +4 on the clean slice (the
4 queries whose demoted stale anchor's
slot was filled by the current truth)
and +2 on the fixture-ambiguous slice.
The production-like `mild-heuristic`
variant is a no-op on both slices.

### Semantic evidence overlay (cross-reference)

When the optional semantic-evidence file
is supplied (the same file the prior
diagnostic accepts:
`src/benchmark/data/false-abstention-damage-semantic-evidence.json`),
the report surfaces a per-variant
`recoveredByVariant` rollup: for each
variant, the count of baseline-`miss`
queries whose after-re-rank top-1 IS a
`currentTruthId`. The rollup is a CROSS-
REFERENCE, not a re-ranker input.

On the lexical baseline artifact:

- EmbeddingGemma hybrid-dense dense
  ranker rank-1-missed 11/11 of the
  covered temporal queries (the same
  finding as the prior diagnostic).
- Of those 11 baseline-`miss` queries,
  the oracle / combined variants could
  have recovered 10 (the current truth
  was in the top-K; the re-ranker would
  have promoted it). The `mild-heuristic`
  variant recovers 0 (the runtime signal
  is absent on the lexical baseline
  artifact).

The overlay's "could have recovered"
count is the strongest single signal in
the report: a re-ranker based on the
prior diagnostic's `STALE_TEMPORAL_IDS`
set + the `currentTruthIds` fixture
truth would close nearly the entire
`current-truth-in-topk-stale-top1` +
`current-truth-in-topk-no-stale-top1`
gap on the temporal slice. The
production-like variant does not have
this ceiling because no production-side
runtime signal distinguishes a stale
anchor from an unrelated distractor.

### What the next fix should be

Reading the variant table and the
per-category change rollup:

- The **fixture-shaped** variant set
  (especially the combined
  `fixture-shaped-stale-demote-current-promote`)
  shows the full ceiling of a
  re-ranker-based fix on the temporal
  gap: it recovers 10 of the 10
  recoverable queries and introduces
  0 regressions.
- The **production-like** variant set
  shows that a deployable rule on the
  current `QueryEval` is ESSENTIALLY A
  NO-OP for the temporal gap, because
  no runtime signal distinguishes a
  stale anchor from an unrelated
  distractor. A production deployment
  that wants the +10 recovery needs
  EITHER:
    1. a runtime metadata signal (e.g.
       a `supersededBy` edge on the
       record schema, derived from the
       corpus's supersession / conflict
       anchors); OR
    2. a candidate-generation fix that
       surfaces the current fact
       alongside the stale anchor (or
       surfaces only the current fact).
- The `current-truth-missing-stale-present`
  (2/26) and `current-truth-missing-no-stale`
  (0/26) buckets are out of reach for
  the re-ranker. A separate
  candidate-generation fix is the right
  next step for those queries.
- The `fixture-ambiguous` (7/26)
  divergentTemporal-labeled queries are
  out of reach for the metric: a
  re-ranker can move them to a
  different category, but
  `currentTruthAt1` is uninterpretable
  on them per fixture design.

### Limitations

- The re-ranker does NOT change
  candidate generation. The
  `current-truth-missing-*` categories
  are out of reach: the current fact is
  not in the top-K, so no in-list
  re-ordering can surface it. The
  report surfaces the
  `unchangedBecauseCurrentMissing`
  count (= 4 on the lexical baseline)
  so the ceiling is honest.
- The `STALE_TEMPORAL_IDS` set is
  hand-curated and is the same set the
  prior diagnostic uses. A future
  corpus revision (new superseded /
  conflict records) requires updating
  the set; the experiment does NOT
  auto-derive the set.
- The `mild-heuristic-temporal-current`
  variant uses the runtime
  `isTemporalCurrent` flag, which is a
  token-presence detector for "current"
  / "now" / "today". The flag is a
  HEURISTIC and is NOT a production-grade
  "is this a current-vs-previous query?"
  signal. The variant is a research
  probe; a deployment would need a
  corresponding production-side
  temporal-current detector with
  documented precision / recall.
- The semantic overlay is a passed-in
  `queryId -> "hit"|"miss"` map; the
  experiment does NOT re-derive the
  dense ranker's behavior. The overlay
  is a cross-reference, not a
  production signal.
- The variant set is hand-curated, not
  learned. A future variant that the
  experiment surfaces as the right call
  is added to
  `BUILTIN_TEMPORAL_RERANK_VARIANTS` by
  hand; the test pins the variant
  table so a future addition is a
  deliberate edit.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:temporal-ranking-preference

# Run without writing the artifact.
npm run benchmark:retrieval:temporal-ranking-preference:no-write

# Run with the pre-computed semantic
# evidence (annotates each baseline-miss
# query with the dense ranker's
# rank-1 outcome, when known).
npm run benchmark:retrieval:temporal-ranking-preference:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:temporal-ranking-preference
```

### Files

- `temporal-ranking-preference.ts` —
  the pure functions: variant table,
  re-rank rule application helper,
  per-variant evaluator, per-variant
  report builder, human-readable
  formatter, verdict function,
  per-query rollup.
- `temporal-ranking-preference-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence
  file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`TemporalRerankReport` (see the JSDoc
on the type). The shape is
intentionally distinct from the audit /
calibration / benchmark / sufficiency /
policy / no-answer / damage / paraphrase-
recovery / temporal-truth-diagnostic
report shapes: the experiment is a
study of trade-offs across a variant
set, not a single chosen rule. The
file prefix is
`retrieval-temporal-ranking-preference-*.json`.

## Supersession edge simulation (this experiment)

The question the experiment answers: "If
the production schema carried a
per-record supersession / version-group
edge (`supersedes`, `supersededBy`,
`versionGroup`, `validFrom`,
`validUntil`, `isSuperseded`,
`currentInGroup`) at `remember` time,
and a runtime re-ranker consumed it, how
much of the temporal-current-truth gap
could the re-ranker close WITHOUT
consulting `currentTruthIds`?".

The edge map is SIMULATED: it is
hand-curated from the same fixture /
corpus knowledge the prior experiments
use. A reviewer who reads the edge map
sees a hand-curated supersession graph;
a reviewer who reads the variant
`category` field sees the honest
"this is metadata-simulation, not
production-like" framing. The
`metadata-simulation` category is
INTENTIONALLY distinct from the
Experiment 6 `fixture-shaped` category:
Experiment 6's `fixture-shaped` variants
key on a flat `STALE_TEMPORAL_IDS` set
(an id list); this experiment's
`metadata-simulation` variants key on
an EDGE MAP (a structured record with
`supersedes`, `supersededBy`,
`versionGroup`, etc.). The
`metadata-simulation` re-rank rules do
NOT consult `currentTruthIds`; the rules
read ONLY the simulated edge map.

### Edge-map contract

The simulated edge map is exported as
`SIMULATED_SUPERSESSION_EDGES` (a
`Map<number, SupersessionEdge>`). The
fields are:

- `recordId` — the corpus record id.
- `supersedes` — the record id this
  record REPLACES (the OLDER fact).
- `supersededBy` — the record id this
  record IS REPLACED BY (the NEWER
  fact).
- `versionGroup` — the version chain
  label (e.g. `g-postgres-v16`).
- `validFrom`, `validUntil` — the
  timestamp the record became / stopped
  being current. Both fields are `null`
  for every simulated edge (the fixture
  corpus does not carry anchor dates).
- `isSuperseded` — convenience
  boolean equivalent to
  `supersededBy !== null`.
- `currentInGroup` — convenience
  boolean `true` iff the record is the
  current member of its `versionGroup`.

The `current-vs-previous` anchor records
(117..120) are EXPLICITLY EXCLUDED from
the edge map (exported as
`EXCLUDED_FROM_EDGE_MAP`). They encode
BOTH the current and the previous fact
in their summary; marking them as
`supersededBy` would be a misread of
their semantic content. The exclusion
is documented in the map and is flagged
in the report's "gap the metadata cannot
fix" block.

The map covers the documented
supersession patterns the prior
diagnostic surfaces (Postgres 14 → 15
→ 16, Thursday release-branch →
Tuesday main, single-pass retrieval →
re-rank, hard-coded blocklist → regex
classifier, raw-input column → summaries
only, single self-hosted runner → managed
CI, single primary endpoint → primary +
fallback, polled → pushed events, Node
20 → Node 22, no-validation → Zod). On
the 132-record corpus, the map has 27
edges, 17 superseded ids, 10
current-in-group ids, and 4 explicitly
excluded ids.

### Variant table (7 variants, lexicographic order)

| id | category | re-rank rule | fixture-derived? |
| -- | -------- | ------------ | ---------------- |
| `baseline-no-rerank` | `production-like` | none (reference) | n/a |
| `oracle-current-truth-promote-all` | `oracle` | promote every `currentTruthIds` id to the top | uses `currentTruthIds` |
| `metadata-simulation-supersededBy-demote` | `metadata-simulation` | demote every `supersededBy` edge target to the bottom | uses edge map |
| `metadata-simulation-supersedes-promote` | `metadata-simulation` | promote candidates that `supersedes` another candidate in the same top-K to the top | uses edge map |
| `metadata-simulation-version-group-current` | `metadata-simulation` | within a `versionGroup`, prefer the `currentInGroup` member | uses edge map |
| `metadata-simulation-combined` | `metadata-simulation` | demote `supersededBy` + promote `supersedes` (the strongest edge-driven rule) | uses edge map |
| `metadata-simulation-stale-id-derived` | `metadata-simulation` | project the `supersededBy` map to a flat `staleLikeIds` set and demote (the cross-experiment bridge to Experiment 6) | uses edge map projection |

Honest reading: the `metadata-simulation`
category is HONEST about the source of
the edge data (fixture-derived from the
corpus summaries the prior diagnostic
audits, NOT a runtime signal on the
production `QueryEval`). The category is
NOT `production-like` (no runtime signal
exists today); it is NOT `oracle` (the
re-rank rules never consult
`currentTruthIds`); it is NOT
`fixture-shaped` (the
`STALE_TEMPORAL_IDS` set is a flat id
list; the `metadata-simulation` variants
key on a structured edge map). The
honest reading is: "a production-side
schema that carries the edges at
`remember` time would let a runtime
re-ranker reach the metadata-simulation
ceiling WITHOUT depending on the fixture
truth at all".

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| variant | n | baseline@1 | after@1 | delta | staleTop1 baseline->after | staleOverCurrent baseline->after | regressions | unchanged-missing | excluded-anchor | verdict |
| ------- | -- | ---------- | ------- | ----- | -------------------------- | ------------------------------- | ----------- | ----------------- | --------------- | ------- |
| `baseline-no-rerank` | 26 | 12 | 12 | 0 | 8->8 | 7->7 | 0 | 4 | 4 | neutral |
| `oracle-current-truth-promote-all` | 26 | 12 | 22 | +10 | 8->1 | 7->0 | 0 | 4 | 4 | safe |
| `metadata-simulation-supersededBy-demote` | 26 | 12 | 17 | +5 | 8->2 | 7->2 | 0 | 4 | 4 | safe |
| `metadata-simulation-supersedes-promote` | 26 | 12 | 17 | +5 | 8->2 | 7->1 | 1 | 4 | 4 | unsafe |
| `metadata-simulation-version-group-current` | 26 | 12 | 17 | +5 | 8->3 | 7->2 | 0 | 4 | 4 | safe |
| `metadata-simulation-combined` | 26 | 12 | 17 | +5 | 8->1 | 7->1 | 1 | 4 | 4 | unsafe |
| `metadata-simulation-stale-id-derived` | 26 | 12 | 17 | +5 | 8->2 | 7->2 | 0 | 4 | 4 | safe |

Where:

- `baseline@1` / `after@1` — `currentTruthAt1`
  count before / after the re-rank.
- `staleTop1` — number of queries whose
  top-1 is in `STALE_TEMPORAL_IDS`.
- `staleOverCurrent` — number of queries
  with BOTH `staleTop1` AND a
  `currentTruthId` in the top-K.
- `regressions` — number of queries that
  were `currentTruthAt1` on the baseline
  and are NOT `currentTruthAt1` after
  the re-rank. **Non-zero on the
  `supersedes-promote` and
  `combined` variants** — see
  "Honest findings" below.
- `unchanged-missing` — number of queries
  with `currentMissing` both before and
  after. **The re-ranker's ceiling**:
  a re-ranker that does not change
  candidate generation cannot help
  these queries.
- `excluded-anchor` — number of queries
  whose `currentTruthIds` intersects
  `EXCLUDED_FROM_EDGE_MAP` (the
  `current-vs-previous` anchor queries).

### Honest findings

- **The metadata-simulation variants
  close HALF the gap (5 of 10
  recoverable queries; +5 from
  baseline 12 to 17).** The
  `metadata-simulation-supersededBy-demote`
  variant alone (no supersedes
  promotion) recovers +5; the combined
  variant (demote + promote) does not
  recover more on this corpus because
  the demote rule is the binding
  constraint (every query the
  supersedes-promote rule recovers is
  also recovered by the demote rule on
  this corpus's candidate sets).
- **The combined and
  supersedes-promote variants
  introduce 1 regression on the
  lexical baseline.** The regression
  is on the
  `temp-current-vs-previous-release`
  query: the baseline returns the
  `current-vs-previous` anchor (118)
  at rank-1; the combined rule
  promotes the `currentInGroup`
  member of the release-cut version
  group (7) above 118. The query's
  fixture-truth `currentTruthIds` is
  `[118]`, but the edge map's notion
  of "current" is the `currentInGroup`
  flag (which 118 does not carry
  because 118 is explicitly EXCLUDED
  from the edge map as a
  current-vs-previous anchor). The
  regression is HONEST and DOCUMENTED:
  a runtime metadata schema that uses
  the `currentInGroup` flag as its
  "is current" signal would NOT be a
  drop-in replacement for the
  fixture's `currentTruthIds` on the
  multi-anchor queries. The demote-only
  and version-group-only variants do
  NOT introduce regressions on this
  corpus.
- **The simulated `supersededBy` set
  is a NARROWER subset of
  `STALE_TEMPORAL_IDS`.** The 17
  simulatedSupersededIds are all
  in `STALE_TEMPORAL_IDS`; the
  remaining STALE_TEMPORAL_IDS
  records (101, 102, 109-112) are
  either conflict anchors (101, 102,
  104 — 104 is in the edge map; 101
  and 102 are not), near-miss records
  (109-112), or otherwise outside an
  explicit supersession chain. The
  `metadata-simulation-stale-id-derived`
  variant is the bridge: a reviewer
  who wants the same denylist
  behavior as Experiment 6's
  `fixture-shaped-stale-demote` rule
  reads the variant with an override
  `staleLikeIds: STALE_TEMPORAL_IDS`.
- **The re-ranker's ceiling is
  unchanged at 4 (the
  `current-truth-missing-*`
  categories).** The 2
  `current-truth-missing-stale-present`
  queries and the 0
  `current-truth-missing-no-stale`
  queries are out of reach for the
  re-ranker: the current fact is not
  in the candidate set, so no in-list
  re-ordering can surface it. A
  separate candidate-generation fix
  is needed for those queries.
- **The "gap the metadata cannot fix"
  block surfaces 4 queries (the
  `temp-current-vs-previous-*`
  queries).** These queries name the
  `current-vs-previous` anchor records
  (117..120) as the current truth;
  the records are EXPLICITLY excluded
  from the edge map because they
  encode BOTH the current and the
  previous fact in their summary.
  The edge-driven re-ranker is
  correct to NOT promote them (the
  records are themselves the current
  answer); the regression on the
  `temp-current-vs-previous-release`
  query under the combined variant
  is caused by the rule promoting a
  DIFFERENT record (7) above the
  anchor (118), not by the rule
  mis-treating the anchor as
  superseded.

### Per-category change table (temporal slice, n=26)

For `metadata-simulation-supersededBy-demote`
and `metadata-simulation-stale-id-derived`:

| baseline category | after category | count |
| ----------------- | -------------- | ----- |
| `current-truth-top1` | `current-truth-top1` | 11 |
| `fixture-ambiguous` | `fixture-ambiguous` | 7 |
| `current-truth-in-topk-stale-top1` | `current-truth-top1` | 4 |
| `current-truth-in-topk-stale-top1` | `current-truth-in-topk-stale-top1` | 1 |
| `current-truth-missing-stale-present` | `current-truth-missing-stale-present` | 2 |
| `current-truth-in-topk-no-stale-top1` | `current-truth-in-topk-no-stale-top1` | 1 |

The `metadata-simulation-combined` variant
has a similar per-category shape but moves
1 query from `current-truth-top1` to
`current-truth-in-topk-no-stale-top1` (the
`temp-current-vs-previous-release`
regression discussed above).

### Cross-experiment sanity (vs STALE_TEMPORAL_IDS)

The simulated edge map is a NARROWER
subset of the prior diagnostic's
`STALE_TEMPORAL_IDS` set. The 17
simulatedSupersededIds are all in
`STALE_TEMPORAL_IDS`; the additional
STALE_TEMPORAL_IDS records (101, 102,
109-112) are not part of an explicit
supersession edge. The
`metadata-simulation-stale-id-derived`
variant is the explicit cross-experiment
bridge: it projects the
`supersededBy` map to a flat
`staleLikeIds` set and applies
Experiment 6's `fixture-shaped-stale-demote`
rule. On the lexical baseline, the
stale-id-derived variant recovers the
same +5 as the `metadata-simulation-supersededBy-demote`
variant, confirming that the edge map
is a CORRECT superset of the explicit
supersession patterns the prior
diagnostic surfaces.

### Semantic evidence overlay (cross-reference)

When the optional semantic-evidence
file is supplied (the same file the
prior diagnostic accepts:
`src/benchmark/data/false-abstention-damage-semantic-evidence.json`),
the report surfaces a per-variant
`recoveredByVariant` rollup. On the
lexical baseline:

- EmbeddingGemma hybrid-dense dense
  ranker rank-1-missed 11/11 of the
  covered temporal queries.
- Of those 11 baseline-`miss` queries,
  the oracle variant could have
  recovered 10; the
  `metadata-simulation-combined`
  variant could have recovered 5.
  The combined variant's
  recovered-by-variant count is the
  edge-driven ceiling without
  consulting `currentTruthIds`.

### Limitations

- The edge map is hand-curated from
  the corpus summaries. A future
  corpus revision (new superseded /
  conflict / version-group records)
  requires updating the map; the
  experiment does NOT auto-derive the
  edges from the corpus. The map is
  exported as
  `SIMULATED_SUPERSESSION_EDGES` so
  the contract is visible at the
  call site.
- The `validFrom` / `validUntil`
  fields are `null` for every edge
  (the fixture corpus does not carry
  anchor dates). A future
  production-side supersession schema
  would populate them; the re-rank
  rules in this module do NOT consult
  the date fields.
- The `metadata-simulation` category
  is honest about NOT being
  production-like. The re-rank rules
  would be a runtime re-ranker IF
  the edge map were production-side;
  today the edge map is fixture-
  derived, so the re-rank rules
  require a production-side schema
  change (a `supersedes` /
  `supersededBy` / `versionGroup`
  column on the storage schema)
  before they can be wired into the
  production `recall(text)`
  controller.
- The `current-vs-previous` anchor
  records (117..120) are explicitly
  excluded from the edge map. A
  production-side schema that wants
  to use the edge map as a drop-in
  replacement for `currentTruthIds`
  would need to handle these
  multi-anchor records explicitly
  (e.g. by carrying an
  `isCurrentVsPrevious` flag and
  excluding them from the
  `currentInGroup` projection).
- The re-ranker does NOT change
  candidate generation. The
  `current-truth-missing-*`
  categories are out of reach.
- The semantic overlay is a
  passed-in `queryId -> "hit"|"miss"`
  map; the experiment does NOT
  re-derive the dense ranker's
  behavior. The overlay is a
  cross-reference, not a production
  signal.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:supersession-edge-simulation

# Run without writing the artifact.
npm run benchmark:retrieval:supersession-edge-simulation:no-write

# Run with the pre-computed semantic
# evidence.
npm run benchmark:retrieval:supersession-edge-simulation:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:supersession-edge-simulation
```

### Files

- `supersession-edge-simulation.ts` —
  the pure functions: edge type,
  simulated edge map, variant table,
  re-rank rule application helper,
  per-variant evaluator, per-variant
  report builder, human-readable
  formatter, verdict function,
  per-query rollup, gap breakdown.
- `supersession-edge-simulation-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence
  file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`SupersessionRerankReport` (see the
JSDoc on the type). The shape is
intentionally distinct from the
audit / calibration / benchmark /
sufficiency / policy / no-answer /
damage / paraphrase-recovery /
temporal-truth-diagnostic /
temporal-ranking-preference report
shapes: the experiment is a study of
trade-offs across a simulated
metadata edge map, not a single
chosen rule. The file prefix is
`retrieval-supersession-edge-simulation-*.json`.

## Multi-anchor / current-vs-previous handling (Experiment 8)

The question the experiment answers:
"Could a runtime re-ranker that
PROTECTS the `current-vs-previous`
anchor records (117..120) from being
displaced by a `supersedes` promotion
close the regression Experiment 7's
combined rule introduced, while still
recovering the +5 on the safe
metadata-simulation baseline?".

Experiment 7 surfaced two findings on
the lexical baseline's temporal slice:

- The `metadata-simulation-supersededBy-demote`
  variant recovers +5 (17/26) with 0
  regressions.
- The `metadata-simulation-combined`
  variant (demote `supersededBy` +
  promote `supersedes`) recovers the
  same +5 BUT introduces 1 regression
  on `temp-current-vs-previous-release`
  (the rule promotes record 7 above
  record 118, the multi-anchor, when
  both are in the top-K).

This experiment tests whether
explicitly modeling the multi-anchor
records as PROTECTED FROM PROMOTION
DISPLACEMENT (a new metadata dimension
beyond the supersession edge map) can
recover the regression while keeping
the +5.

The multi-anchor treatment is
SIMULATED: a hand-curated per-record
flag (`currentVsPreviousAnchor` /
`preferAnchorWhenQueryNeedsComparison`)
on the 4 anchor records (117..120).
The re-rank rules do NOT consult
`currentTruthIds`; the rules read
ONLY the simulated edge map + the
simulated multi-anchor treatment. The
category `multi-anchor-simulation` is
INTENTIONALLY distinct from
Experiment 7's `metadata-simulation`
(the new metadata dimension is a
separate production-side schema
column).

### Multi-anchor treatment contract

The simulated treatment is exported
as `SIMULATED_MULTI_ANCHOR_TREATMENT`
(a `Map<number, MultiAnchorTreatment>`)
and projections
`SIMULATED_MULTI_ANCHOR_IDS` /
`SIMULATED_PROTECTED_ANCHOR_IDS`. The
fields are:

- `recordId` — the corpus record id.
- `isMultiAnchor` — convenience
  boolean equivalent to
  `currentVsPreviousAnchor === true`.
- `currentVsPreviousAnchor` — `true`
  iff the record explicitly pairs a
  CURRENT fact with a NEAR-MISS /
  PREVIOUS fact in the same summary.
  The fixture corpus labels records
  117..120 with this flag (the
  `current-vs-previous` anchor
  cluster).
- `preferAnchorWhenQueryNeedsComparison`
  — convenience boolean `true` iff a
  runtime re-ranker that sees the
  record at rank 1 should PROTECT it
  from being displaced by a promotion.
  The flag is the experiment's policy
  knob: a production-side schema that
  sets this flag on a record is saying
  "if this record is the user's
  anchor, do not demote it".
- `validFrom`, `validUntil` — the
  timestamp the record became /
  stopped being current. Both fields
  are `null` for every simulated entry
  (the fixture corpus does not carry
  anchor dates). The fields are in
  the type contract so a future
  production-side schema revision can
  populate them without a new module.

The protection rule is INTENTIONAL
NARROW: a multi-anchor record at
rank 1 is protected from being
displaced; a multi-anchor record NOT
at rank 1 is treated like any other
candidate. The narrow rule mirrors
the "do not demote the user's anchor"
policy a production-side schema would
encode.

### Variant table (6 variants, declaration order)

| id | category | re-rank rule | fixture-derived? |
| -- | -------- | ------------ | ---------------- |
| `baseline-no-rerank` | `production-like` | none (reference) | n/a |
| `metadata-simulation-supersededBy-demote` | `metadata-simulation` | demote every `supersededBy` edge target to the bottom (Experiment 7 safe baseline) | uses edge map |
| `metadata-simulation-combined-unsafe` | `metadata-simulation` | demote `supersededBy` + promote `supersedes` (Experiment 7 unsafe baseline) | uses edge map |
| `multi-anchor-protected-supersedes-promote` | `multi-anchor-simulation` | the `supersedes` rule, but a multi-anchor record at rank 1 is PROTECTED | uses edge map + treatment |
| `multi-anchor-aware-combined` | `multi-anchor-simulation` | the combined rule, but a multi-anchor record at rank 1 is PROTECTED (PRIMARY DELIVERABLE) | uses edge map + treatment |
| `oracle-current-truth-promote-all` | `oracle` | promote every `currentTruthIds` id to the top | uses `currentTruthIds` |

Honest reading: the
`multi-anchor-simulation` category is
HONEST about the source of the
metadata: the multi-anchor treatment
is fixture-derived from the corpus
summaries the prior diagnostic audits,
NOT a runtime signal on the production
`QueryEval`. The category is NOT
`production-like` (no runtime signal
exists today); it is NOT `oracle`
(the re-rank rules never consult
`currentTruthIds`); it is NOT
`metadata-simulation` (the
multi-anchor treatment is a separate
metadata dimension from the
supersession edge map). The honest
reading is: "a production-side schema
that carries BOTH the supersession
edge map AND the multi-anchor
treatment at `remember` time would let
a runtime re-ranker reach the
multi-anchor-aware ceiling WITHOUT
depending on the fixture truth at
all".

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| variant | n | baseline@1 | after@1 | delta | regressions | multiAnchorReg | multiAnchorProt | verdict |
| ------- | -- | ---------- | ------- | ----- | ----------- | -------------- | ---------------- | ------- |
| `baseline-no-rerank`                          | 26 | 12 | 12 |   0 | 0 | 0 | 0 | neutral |
| `metadata-simulation-supersededBy-demote`     | 26 | 12 | 17 |  +5 | 0 | 0 | 0 | safe |
| `metadata-simulation-combined-unsafe`         | 26 | 12 | 17 |  +5 | 1 | 1 | 0 | unsafe |
| `multi-anchor-protected-supersedes-promote`   | 26 | 12 | 18 |  +6 | 0 | 0 | 4 | safe |
| `multi-anchor-aware-combined`                 | 26 | 12 | 18 |  +6 | 0 | 0 | 4 | safe |
| `oracle-current-truth-promote-all`            | 26 | 12 | 22 | +10 | 0 | 0 | 0 | safe |

Where:

- `multiAnchorReg` — regression count
  on the 4-query multi-anchor subset
  (the queries whose `currentTruthIds`
  intersects `SIMULATED_MULTI_ANCHOR_IDS`).
- `multiAnchorProt` — protected count
  on the multi-anchor subset
  (queries where the rank-1 record
  was a multi-anchor AND the rule
  kind is a protection rule).

### Honest findings

- **The multi-anchor-aware combined
  variant recovers +1 over the safe
  metadata baseline** (18/26 vs 17/26),
  with 0 regressions. The variant
  prevents the
  `temp-current-vs-previous-release`
  regression Experiment 7's combined
  rule introduced, while still
  promoting 7 above 112 on
  `temp-release-process` (the
  non-anchor release query, where
  promotion is helpful).
- **The +1 is the maximum a
  multi-anchor-aware re-ranker can
  recover on this corpus** without
  changing candidate generation. The
  multi-anchor subset (4 queries:
  postgres, release, safety, oncall)
  already passes on the baseline (the
  anchors are at rank-1 by baseline
  ranker behavior). The protection
  step protects these 4 from being
  REGRESSED by the combined
  promotion; it does not surface
  additional `currentTruthAt1`
  queries on the multi-anchor
  subset.
- **The remaining +4 to the oracle
  ceiling (22/26) is out of reach
  for any in-list re-rank.** The 4
  missing queries are the
  `current-truth-missing-*` queries
  where the current fact is not in
  the top-K at all (records like
  73 for runtime, 105/107 for
  superseded controllers, etc.). A
  re-ranker that does not change
  candidate generation cannot help
  these queries. The gap is
  candidate-generation territory.
- **The protection step is
  INTENTIONAL NARROW.** A multi-anchor
  record at rank 1 is protected from
  being displaced; a multi-anchor
  record NOT at rank 1 is treated
  like any other candidate. The
  narrow rule is the honest reading:
  a runtime re-ranker that protects
  the rank-1 anchor but does not
  anchor-promote a lower-ranked
  multi-anchor record mirrors the
  "do not demote the user's anchor"
  policy a production-side schema
  would encode. The narrow rule
  closes the regression WITHOUT
  introducing new failures on the
  non-anchor queries.
- **Both `multi-anchor-protected-supersedes-promote`
  and `multi-anchor-aware-combined`
  produce the same +6 with 0
  regressions on the lexical
  baseline.** The protected-promote
  variant is the simpler rule
  (promotion only, no demote); the
  aware-combined variant is the
  full-featured rule (demote +
  promote + protection). On this
  corpus the demote step does not
  change the `currentTruthAt1`
  count further (every query the
  demote step helps is already
  recovered by the protected
  promotion); the aware-combined
  variant's value is the additional
  `staleTop1` reduction (8->1 vs
  8->2 for protected-promote).
- **The `multi-anchor-aware-combined`
  variant is the experiment's
  PRIMARY DELIVERABLE.** It is the
  closest a non-oracle rule can
  come to the oracle ceiling on
  this corpus. The honest reading
  is: a production-side schema
  that carries BOTH the supersession
  edge map AND the multi-anchor
  treatment at `remember` time
  would let a runtime re-ranker
  reach +6 of the +10 oracle gain
  without consulting
  `currentTruthIds`. The remaining
  +4 is a candidate-generation
  problem, not a re-ranking
  problem.

### Multi-anchor subset per-query breakdown

The 4 multi-anchor queries (one per
record id 117..120):

| query | family | currentTruth | baseline@1 | after@1 (unsafe combined) | after@1 (multi-anchor-aware) |
| ----- | ------ | ------------ | ---------- | ------------------------- | ---------------------------- |
| `temp-current-vs-previous-postgres`   | temporal | 117 | 117 | 117 | 117 |
| `temp-current-vs-previous-release`    | temporal | 118 | 118 | **7** (regression) | **118** (protected) |
| `temp-current-vs-previous-safety`     | temporal | 119 | 119 | 119 | 119 |
| `temp-current-vs-previous-oncall`     | temporal | 120 | 120 | 120 | 120 |

The 4 queries already pass on the
baseline (the anchors are at rank-1
by baseline ranker behavior). The
multi-anchor-aware combined variant
protects 118 from being demoted by
the promotion of 7 (the regression
the unsafe combined rule
introduces). The other 3 are
unaffected (the unsafe combined rule
does not introduce regressions on
them because the relevant
`supersedes` chain does not
intersect the multi-anchor rank-1
position).

### Cross-experiment sanity (vs STALE_TEMPORAL_IDS)

The simulated edge map (Experiment 7)
and the simulated multi-anchor
treatment (Experiment 8) are
INDEPENDENT metadata dimensions.
The edge map is the documented
supersession / version-group
chains; the multi-anchor treatment
is the `current-vs-previous` anchor
cluster. On the fixture corpus, the
two are correlated: the 4 records
in the multi-anchor treatment
(117..120) are EXPLICITLY excluded
from the edge map. The cross-
experiment sanity block surfaces
this correlation: a reviewer who
wants to understand "is the
multi-anchor treatment a separate
column or a subset of the edge
map?" reads the block.

### Limitations

- The multi-anchor treatment is
  hand-curated from the corpus
  summaries. A future corpus
  revision (new `current-vs-previous`
  anchor records) requires updating
  the map; the experiment does NOT
  auto-derive the treatment from the
  corpus. The map is exported as
  `SIMULATED_MULTI_ANCHOR_TREATMENT`
  so the contract is visible at the
  call site.
- The `validFrom` / `validUntil`
  fields are `null` for every entry
  (the fixture corpus does not carry
  anchor dates). A future
  production-side multi-anchor schema
  would populate them; the re-rank
  rules in this module do NOT consult
  the date fields.
- The protection rule is intentional
  narrow. A multi-anchor record at
  rank 1 is protected from being
  displaced; a multi-anchor record
  NOT at rank 1 is treated like any
  other candidate. A broader rule
  (e.g., "promote the multi-anchor
  record to rank 1 whenever it is in
  the top-K") would close more of
  the gap but is a different
  research question (and a more
  aggressive production-side
  policy).
- The multi-anchor subset is exactly
  the 4 queries whose `currentTruthIds`
  intersects the simulated treatment.
  A future corpus revision that
  adds more `current-vs-previous`
  anchor records would expand the
  subset.
- The semantic overlay is a
  passed-in `queryId -> "hit"|"miss"`
  map; the experiment does NOT
  re-derive the dense ranker's
  behavior. The overlay is a cross-
  reference, not a production signal.
- The re-ranker does NOT change
  candidate generation. The
  `current-truth-missing-*`
  categories are out of reach: the
  current fact is not in the top-K,
  so no in-list re-ordering can
  surface it. The report surfaces
  the `unchangedBecauseCurrentMissing`
  count (= 4 on the lexical baseline)
  so the ceiling is honest.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:multi-anchor-current-previous

# Run without writing the artifact.
npm run benchmark:retrieval:multi-anchor-current-previous:no-write

# Run with the pre-computed semantic
# evidence.
npm run benchmark:retrieval:multi-anchor-current-previous:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:multi-anchor-current-previous
```

### Files

- `multi-anchor-current-previous.ts`
  — the pure functions: multi-anchor
  treatment type, simulated
  treatment, variant table, re-rank
  rule application helper, per-
  variant evaluator, per-variant
  report builder, human-readable
  formatter, verdict function,
  per-query rollup, multi-anchor
  subset block, gap breakdown.
- `multi-anchor-current-previous-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence
  file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`MultiAnchorRerankReport` (see the
JSDoc on the type). The shape is
intentionally distinct from the
prior report shapes; the experiment
introduces a new
`multiAnchorSubset` block (per-
variant metrics on the 4-query
multi-anchor subset) and a new
`gapBreakdown` block (per-variant
regression / protected counts on
the multi-anchor subset). The file
prefix is
`retrieval-multi-anchor-current-previous-*.json`.

## Temporal candidate-generation probe (Experiment 9)

The question the experiment answers:
"Can the remaining +4 gap
(Experiment 8's `current-truth-missing-*`
queries the multi-anchor-aware
re-ranker cannot close) be closed
by getting the current records into
the candidate set BEFORE the
downstream re-ranker?". The Architect
interpretation of Experiment 8's
remaining +4 gap was: "the +4 gap is
candidate-generation / current-
missing. In-list reranking cannot fix
missing candidates. Candidate-
generation probe is next.".

The experiment composes Experiment
8's `multi-anchor-aware-combined`
re-ranker as the FIXED DOWNSTREAM
CONTROL. The candidate-expansion
variants ONLY change the candidate
set BEFORE the re-ranker; the
re-ranker itself is unchanged. A
reviewer who wants to swap the
downstream re-ranker reads the
`evaluateCandidateGenerationVariant`
helper: the `downstreamVariant`
parameter is intentionally guarded
with a runtime check (a future
caller that swaps the downstream
re-ranker is forced to read the
contract).

The candidate-expansion rules are
NARROW: a candidate is injected
ONLY when the rule explicitly maps
a top-K record to a `currentTruthId`
(via the linked-expansion map).
The rules do NOT consult
`currentTruthIds`; the injection is
driven by the simulated supersession
edge map (Experiment 7) and the
simulated multi-anchor treatment
(Experiment 8). The `currentTruthIds`
is consumed ONLY by the
`oracle-candidate-injection-ceiling`
variant (explicitly marked `oracle`
in the `category` field) and by the
downstream `classifyTemporalTruthFailure`
classifier that measures the
`currentTruthAt1` outcome.

### Linked-expansion map contract

The simulated linked-expansion map
is exported as
`SIMULATED_LINKED_EXPANSION` (a
`Map<number, ReadonlyArray<number>>`)
and projection
`SIMULATED_LINKED_EXPANSION_INJECTED_IDS`.
The map is the union of two
fixture-derived projections:

1. The `supersededBy` projection of
   the simulated supersession edge
   map (the "stale -> current" links).
   For every record in
   `SIMULATED_SUPERSESSION_EDGES` whose
   `supersededBy` is a non-null id, the
   map records the (recordId,
   supersededBy) link.
2. The multi-anchor "anchor -> current"
   projection. For every record in
   `SIMULATED_MULTI_ANCHOR_TREATMENT`,
   the map records the (recordId,
   currentTruthId) link. The mapping
   is hand-curated: 117 -> [1] (postgres
   current), 118 -> [7] (release
   current), 119 -> [69] (safety
   current), 120 -> [11] (oncall
   current).

The `SIMULATED_LINKED_EXPANSION_INJECTED_IDS`
set is the union of the map's values
(chain winners like 1, 2, 3, 6, 7,
11, 50, 69, 90, 95; the multi-anchor
anchors' current truths are a
subset).

### Variant table (6 variants, declaration order)

| id | category | candidate-expansion rule | downstream reranker | fixture-derived? |
| -- | -------- | ------------------------ | ------------------- | ---------------- |
| `baseline-no-rerank` | `production-like` | none | none (reference) | n/a |
| `reranker-control-multi-anchor-aware-combined` | `reranker-control` | none | `multi-anchor-aware-combined` (Experiment 8) | uses edge map + treatment |
| `candidate-expansion-topk10-no-expansion` | `metadata-simulation` | append `supersededBy` of records in top-K | `multi-anchor-aware-combined` | uses edge map |
| `metadata-simulation-linked-candidate-expansion` | `metadata-simulation` | inject `supersededBy` of stale records in top-K | `multi-anchor-aware-combined` | uses edge map |
| `metadata-simulation-multi-anchor-linked-expansion` | `multi-anchor-simulation` | inject linked ids (union of `supersededBy` + multi-anchor `currentTruthId`) | `multi-anchor-aware-combined` (PRIMARY DELIVERABLE) | uses edge map + treatment + linked map |
| `oracle-candidate-injection-ceiling` | `oracle` | inject every `currentTruthIds` not in top-K | `multi-anchor-aware-combined` | uses `currentTruthIds` |

Honest reading: the
`metadata-simulation` /
`multi-anchor-simulation` categories
are HONEST about the source of the
metadata. The linked-expansion map
is fixture-derived from the corpus
summaries the prior diagnostic
audits, NOT a runtime signal on the
production `QueryEval`. A reviewer
who reads the `category` field sees
the framing: `metadata-simulation`
is NOT `production-like` (no runtime
signal exists today); it is NOT
`oracle` (the candidate-expansion
rules never consult
`currentTruthIds`); it is NOT
`reranker-control` (the candidate-
expansion step is additive, BEFORE
the downstream reranker). The
honest reading is: "a production-side
schema that carries BOTH the
supersession edge map AND the
multi-anchor treatment AND the
linked-expansion map at `remember`
time would let a runtime candidate
generator + the downstream
multi-anchor-aware reranker reach the
oracle-candidate-injection ceiling
WITHOUT depending on the fixture
truth at all".

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| variant | n | baseline@1 | after@1 | delta | recoveredByExpansion | currentMissing baseline->afterExpansion->afterRerank | regressions | verdict |
| ------- | -- | ---------- | ------- | ----- | --------------------- | ----------------------------------------------------- | ----------- | ------- |
| `baseline-no-rerank`                                     | 26 | 12 | 12 |   0 |  0 | 4->4->4 | 0 | neutral |
| `reranker-control-multi-anchor-aware-combined`           | 26 | 12 | 18 |  +6 |  0 | 4->4->4 | 0 | safe    |
| `candidate-expansion-topk10-no-expansion`                | 26 | 12 | 20 |  +8 |  4 | 4->0->0 | 1 | unsafe  |
| `metadata-simulation-linked-candidate-expansion`         | 26 | 12 | 20 |  +8 |  4 | 4->0->0 | 1 | unsafe  |
| `metadata-simulation-multi-anchor-linked-expansion`      | 26 | 12 | 20 |  +8 |  4 | 4->0->0 | 1 | unsafe  |
| `oracle-candidate-injection-ceiling`                     | 26 | 12 | 21 |  +9 |  4 | 4->0->0 | 0 | safe    |

Where:

- `recoveredByExpansion` — the count
  of queries whose baseline
  `currentMissing` flipped to
  `currentTruthInTopK` because of the
  candidate-expansion step. The metric
  is the candidate-generation analog
  of the reranker's recovery.
- `currentMissing baseline->afterExpansion->afterRerank`
  — the per-stage missing counts. The
  three columns are the baseline's
  `currentMissing` (the queries whose
  current truth is not in the top-K),
  the after-expansion step's
  `currentMissing`, and the after-
  rerank step's `currentMissing`. A
  well-formed candidate-expansion step
  that surfaces the current fact in
  the top-K produces a `4->0->0`
  triple; a buggy step would produce
  a non-zero after-expansion
  `currentMissing`.

### Honest findings

- **The candidate-expansion variants
  recover the +4 gap the
  multi-anchor-aware reranker cannot
  close.** The 4 baseline-missing
  queries (`temp-schema-migrations`,
  `temp-stale-fact-trap-safety`,
  plus 2 of the divergent labeled
  cases the prior diagnostic flags)
  are recovered by the candidate-
  expansion step. The
  `recoveredByExpansion` count is 4
  on every candidate-expansion
  variant; the baseline's 4
  `currentMissing` flips to 0 after
  the expansion step. The
  candidate-expansion step alone
  closes the +4 gap.
- **HOWEVER, the candidate-expansion
  variants introduce 1 regression
  on `temp-rate-limit`.** The query's
  baseline top-K is `[70, 130, 20, 23,
  45]`. The candidate-expansion rule
  injects the linked `supersededBy`
  of record 23 (single-pass retrieval)
  — record 3 (re-rank-before-
  synthesis). The downstream
  `multi-anchor-aware-combined`
  reranker sees 3 in the top-K
  (record 3 `supersedes` record 23,
  which is still in the top-K) and
  promotes 3 above 70 (the actual
  current fact). The regression is
  the documented EXPERIMENT 7
  pattern: the `supersedes` promotion
  rule promotes a chain winner above
  the actual current fact when the
  current fact is in the same top-K.
  The candidate expansion makes the
  pattern more frequent (it injects
  chain winners into more top-Ks).
- **The variant's verdict is
  therefore `unsafe` per the
  documented deterministic rule
  (regressionCount > 0).** The
  honest reading: a candidate-
  expansion rule composed with a
  `supersedes`-promote reranker is
  UNSAFE on the `temp-rate-limit`
  case (and similar patterns). The
  candidate-generation step is
  additive, not destructive; the
  reranker's `supersedes` promotion
  is the source of the regression.
- **The `larger-topk-no-expansion`
  and `linked-candidate-expansion`
  variants are FUNCTIONALLY EQUIVALENT
  on this corpus.** Both rules
  implement the same `supersededBy`-
  projection math (the only
  difference is the
  `category`-honest label). The
  multi-anchor-linked-expansion rule
  ALSO produces the same recovery
  count (4) on this corpus, because
  the +4 gap queries' stale records
  are all in the `supersededBy`
  projection (NOT in the multi-anchor
  `currentTruthId` projection). The
  multi-anchor linked-expansion rule
  is the experiment's PRIMARY
  DELIVERABLE because it is the
  closest a non-oracle candidate-
  generation rule can come to the
  oracle candidate-injection ceiling;
  on this corpus the two rules
  produce the same outcome.
- **The oracle candidate-injection
  ceiling reaches 21/26 (not 22/26).**
  The previous Experiment 8
  `oracle-current-truth-promote`
  reaches 22/26. The +1 gap is
  because the candidate-injection
  oracle composes the multi-anchor-
  aware reranker; the reranker's
  protection logic still applies
  (the protection prevents promoting
  a current truth over a rank-1
  multi-anchor record, even when the
  current truth is the actual
  answer). The previous Experiment 8
  oracle re-orders the top-K
  without composing the reranker.
  The two oracles are different
  research questions:
    - Experiment 8 oracle
      (22/26): the re-ranking
      ceiling, "if a runtime
      reranker promoted every
      current-truth id in the
      top-K to rank-1".
    - Experiment 9 candidate-
      injection oracle (21/26):
      the candidate-generation
      ceiling, "if a runtime
      candidate generator injected
      every missing current-truth
      id and a runtime reranker
      then promoted them". The
      candidate-injection ceiling
      is the more honest reading
      of "if we had full candidate-
      generation metadata, what
      would the after-rerank look
      like?".
- **The candidate-expansion step
  has a fixture-shaped bias.** The
  `supersededBy` projection is the
  same metadata dimension the
  Experiment 7 supersession edge
  map records; the multi-anchor
  `currentTruthId` projection is
  the same metadata dimension
  Experiment 8 documents. The
  candidate-expansion rules do NOT
  add a NEW metadata dimension; they
  re-use the same fixtures the prior
  experiments consume. The honest
  reading: the candidate-expansion
  step is a "what if the candidate
  generator had access to the same
  metadata the reranker already
  consumes?" simulation. A more
  aggressive candidate-generation
  rule (e.g., "inject the entire
  `versionGroup`'s `currentInGroup`
  member") would surface more
  candidates; the experiment does
  NOT implement that rule (it would
  be a future experiment if the
  honest reading is "the narrow
  rule is too narrow").
- **The verdict on the multi-anchor-
  linked-expansion variant is
  `unsafe` per the documented
  deterministic rule.** The honest
  answer to the Architect's question
  ("can candidate-generation close
  the +4 gap?") is: "YES, the
  candidate-expansion step alone
  closes the +4 gap (the
  `recoveredByExpansion` count is 4);
  BUT composing the expansion with
  the multi-aware reranker introduces
  1 regression on `temp-rate-limit`.
  The +4 recovery is NET POSITIVE on
  this corpus (20/26 with 1 regression
  vs 18/26 with 0 regressions), but
  the regression is a real failure
  that the production-side schema
  would need to guard against (e.g.,
  by NOT promoting a chain winner
  above an actual current truth
  in the top-K, or by gating the
  promotion on a `currentTruthIds`
  lookup that the production-side
  schema does NOT have access to
  unless the write-path records
  the current-truth flag).".

### Honest framing: is the gain fixture-shaped?

The candidate-expansion step's
recovery (4) is INTENTIONALLY
fixture-shaped: the +4 gap queries'
stale records are all in the
`supersededBy` projection, and the
candidate-expansion rule injects the
chain winners the simulated edge
map points to. The chain winners
are 50 (for the `temp-schema-migrations`
case), 69 (for the `temp-stale-fact-trap-safety`
case), and the multi-anchor anchors'
current truths (the divergent labeled
cases).

The gain is FIXTURE-SHAPED in the
sense that:
- The chain winners (50, 69) are
  EXPLICITLY documented in the
  simulated edge map.
- The multi-anchor anchors' current
  truths (1, 7, 11, 69) are
  EXPLICITLY documented in the
  multi-anchor treatment.
- The candidate-expansion rules do
  NOT introduce a NEW metadata
  dimension; they re-use the same
  fixtures the prior experiments
  consume.

The gain is NOT fixture-shaped in
the sense that:
- The expansion is a pure
  mathematical transformation of
  the top-K that ANY production-side
  candidate generator could implement
  given access to the same metadata
  (a per-record `supersededBy` column
  + a per-record multi-anchor
  `currentTruthId` column).
- A production-side write-path that
  records the per-record metadata at
  `remember` time would let a runtime
  candidate generator apply the
  exact same expansion.

The honest reading: a production-
side schema that records BOTH the
supersession edge map AND the
multi-anchor `currentTruthId` column
AND the linked-expansion map at
`remember` time would let a runtime
candidate generator close the +4
gap. The candidate-expansion step
is "what if the candidate generator
had access to the same metadata the
reranker already consumes?". The
experiment does NOT propose a
deployment policy; the
`recommendedVerdict` field is
research-only.

### Limitations

- The linked-expansion map is
  hand-curated from the corpus
  summaries the prior diagnostic
  audits. A future corpus revision
  (new stale / superseded / multi-
  anchor records) requires updating
  the map; the experiment does NOT
  auto-derive the map from the
  corpus.
- The candidate-expansion rules are
  NARROW: a candidate is injected
  ONLY when the rule explicitly maps
  the top-K record to a
  `currentTruthId`. A more aggressive
  rule (e.g. "inject the entire
  `versionGroup`'s `currentInGroup`
  member") would surface more
  candidates; the experiment does
  NOT implement that rule.
- The downstream reranker is fixed
  at Experiment 8's
  `multi-anchor-aware-combined`. The
  `downstreamVariant` parameter is
  intentionally guarded with a runtime
  check so a future caller that swaps
  the downstream reranker is forced
  to read the contract.
- The `recommendedVerdict` field on
  each variant row is a research-only
  reading aid. The verdict is
  computed deterministically from the
  variant's metric block (regressions
  > 0 -> unsafe; `currentTruthAt1Delta`
  > 0 -> safe; otherwise neutral).
  The verdict is NOT a deployment
  recommendation.
- The `unchangedBecauseCurrentMissing`
  count is the candidate-generation
  analog of the reranker's ceiling.
  The metric exposes "how many
  queries are STILL `currentMissing`
  after BOTH the candidate expansion
  step and the downstream reranker?".
  On the candidate-expansion variants
  (and the oracle), the count is 0:
  every baseline-missing query was
  recovered. On the baseline and the
  reranker-control, the count is 4:
  the reranker cannot conjure
  candidates.

### How to run

```bash
# Run the experiment (writes the JSON
# artifact to .curion/benchmark/).
npm run benchmark:retrieval:temporal-candidate-generation-probe

# Run without writing the artifact.
npm run benchmark:retrieval:temporal-candidate-generation-probe:no-write

# Run with the pre-computed semantic
# evidence.
npm run benchmark:retrieval:temporal-candidate-generation-probe:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:temporal-candidate-generation-probe
```

### Files

- `temporal-candidate-generation-probe.ts`
  — the pure functions: linked-
  expansion map type, simulated
  linked-expansion map, variant
  table, candidate-expansion rule
  application helper, per-variant
  evaluator, per-variant report
  builder, human-readable formatter,
  verdict function, per-query
  rollup, gap breakdown, multi-anchor
  subset block.
- `temporal-candidate-generation-probe-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence
  file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`CandidateGenerationReport` (see the
JSDoc on the type). The shape is
intentionally distinct from the
prior report shapes; the experiment
introduces a new
`linkedExpansionMapSize` /
`linkedExpansionInjectedIds` block
(the simulated linked-expansion map
summary), a new
`downstreamRerankerId` field (the
fixed downstream reranker), a new
`gapBreakdown` block (per-variant
`unchangedBecauseCurrentMissing` /
`recoveredByExpansion` /
`recoveredByReranker` /
`expansionInjectedCurrentCount`),
and a per-query `recoveredByExpansion`
flag. The file prefix is
`retrieval-temporal-candidate-generation-probe-*.json`.

## Supersedes-promote guard probe (Experiment 10)

The question the experiment answers:
"Can a NARROW non-oracle
`supersedes-promote` guard
ELIMINATE Experiment 9's single
regression (`temp-rate-limit`) while
preserving Experiment 9's
candidate-expansion gain, and how
close does the guard come to the
oracle diagnostic ceiling?". The
Architect's question framed the
trade-off: the guard is a STRUCTURAL
rule (no `currentTruthIds` lookup)
that protects a non-injected rank-1
candidate from being displaced by a
`supersedes-promote` of an injected
candidate.

The guard composes ON TOP of
Experiment 9's candidate-expansion
rules. The candidate-expansion step
is unchanged (the same four variants
Experiment 9 ships); the guard is
applied BETWEEN the
candidate-expansion step and the
downstream `multi-anchor-aware-
combined` re-ranker. The guard
integrates the multi-anchor
protection (a multi-anchor record at
rank 1 is protected from being
displaced) AND the `supersededBy`
demote step (superseded records are
demoted to the bottom) AND the
`supersedes-promote` step (a
`supersedes` candidate is promoted
to the top, EXCEPT when the guard's
protection condition fires). For
guarded variants, the multi-anchor-
aware-combined re-ranker is NOT
applied on top of the guard's
output; the guard is the FINAL re-
rank step.

The guard's protection logic: an
injected `supersedes` candidate is
demoted to the bottom (alongside
superseded records) when the rank-1
candidate is non-injected. The rule
is a pure function of the post-
expansion top-K + the injected-id
set + the simulated supersession
edge map + (for the diagnostic
oracle variant) the query's
`currentTruthIds`. The rule does
NOT consult `currentTruthIds` for
the primary guarded variants; the
`currentTruthIds` is consumed ONLY
by the `oracle-candidate-injection-
ceiling` variant (mirrors
Experiment 9's oracle) and by the
`oracle-guarded-candidate-injection-
ceiling` diagnostic variant (the
IDEAL PROTECTION CEILING).

### Variant table (7 variants, declaration order)

| id | category | candidate-expansion rule | guard rule | downstream reranker | fixture-derived? |
| -- | -------- | ------------------------ | ---------- | ------------------- | ---------------- |
| `baseline-no-rerank` | `production-like` | none | none | none (reference) | n/a |
| `reranker-control-multi-anchor-aware-combined` | `reranker-control` | none | none | `multi-anchor-aware-combined` (Exp 8) | uses edge map + treatment |
| `oracle-candidate-injection-ceiling` | `oracle` | inject every `currentTruthIds` not in top-K | none | `multi-anchor-aware-combined` (Exp 8) | uses `currentTruthIds` |
| `guarded-multi-anchor-linked-expansion` | `multi-anchor-simulation` | inject linked ids (union of `supersededBy` + multi-anchor `currentTruthId`) | `supersedes-promote-guard` (PRIMARY DELIVERABLE) | guard is the final re-rank | uses edge map + treatment + linked map |
| `guarded-linked-candidate-expansion` | `metadata-simulation` | inject `supersededBy` of stale records in top-K | `supersedes-promote-guard` | guard is the final re-rank | uses edge map |
| `guarded-no-op` | `reranker-control` | none | `supersedes-promote-guard` (sanity row: no expansion) | guard is the final re-rank | n/a |
| `oracle-guarded-candidate-injection-ceiling` | `oracle-diagnostic` | inject every `currentTruthIds` not in top-K | `oracle-supersedes-promote-guard` (consults `currentTruthIds` as a hint) | guard is the final re-rank | uses `currentTruthIds` |

Honest reading: the `multi-anchor-
simulation` / `metadata-simulation`
/ `oracle-diagnostic` categories in
this report are HONEST about the
source of the metadata and the use
of `currentTruthIds`. The guarded
primary does NOT consult
`currentTruthIds`; the guard is a
STRUCTURAL rule on the candidate-
expansion's provenance (injected vs
non-injected), not a current-truth
lookup. The honest reading is: "a
production-side schema that carries
BOTH the supersession edge map AND
the multi-anchor treatment AND the
linked-expansion map AND a per-
candidate `injected` provenance
flag at `remember` time would let
a runtime candidate generator + a
runtime guarded re-ranker reach the
guarded primary's ceiling WITHOUT
depending on the fixture truth at
all".

### Headline findings (lexical baseline, 132 records / 176 queries, 26 temporal)

| variant | n | baseline@1 | after@1 | delta | recoveredByExpansion | currentMissing baseline->afterExpansion->afterRerank | regressions | tempRateLimit | promotionsBlocked | verdict |
| ------- | -- | ---------- | ------- | ----- | --------------------- | ----------------------------------------------------- | ----------- | ------------- | ----------------- | ------- |
| `baseline-no-rerank` | 26 | 12 | 12 |   0 |  0 | 2-> 4-> 2 | 0 | 0 |  0 | neutral |
| `reranker-control-multi-anchor-aware-combined` | 26 | 12 | 18 |  +6 |  0 | 2-> 4-> 2 | 0 | 0 |  0 | safe    |
| `oracle-candidate-injection-ceiling` | 26 | 12 | 21 |  +9 |  4 | 2-> 0-> 0 | 0 | 0 |  0 | safe    |
| `guarded-multi-anchor-linked-expansion` | 26 | 12 | 18 |  +6 |  4 | 2-> 0-> 0 | 0 | 0 |  8 | safe    |
| `guarded-linked-candidate-expansion` | 26 | 12 | 18 |  +6 |  4 | 2-> 0-> 0 | 0 | 0 |  8 | safe    |
| `guarded-no-op` | 26 | 12 | 18 |  +6 |  0 | 2-> 4-> 2 | 0 | 0 |  0 | safe    |
| `oracle-guarded-candidate-injection-ceiling` | 26 | 12 | 18 |  +6 |  4 | 2-> 0-> 0 | 0 | 0 |  3 | safe    |

### Honest findings

- **The guarded primary ELIMINATES
  the `temp-rate-limit` regression.**
  The `tempRateLimitRegressionCount`
  is 0 for the guarded primary; the
  `regressionCount` is 0; the
  `promotionsBlockedByGuard` is 8
  (the guard fired on 8
  `supersedes` promotions across the
  slice). The specific `temp-rate-
  limit` regression — the candidate-
  expansion rule injects record 3,
  the unguarded multi-anchor-aware-
  combined re-ranker promotes 3
  above 70 (the current fact at rank
  1) — is eliminated because the
  guard blocks the promotion of
  injected record 3 (record 3 is
  injected AND the rank-1 70 is
  non-injected, the guard's primary
  protection condition).

- **HOWEVER, the guarded primary's
  `currentTruthAt1` is 18/26, not
  20/26 (the +2 of Experiment 9's
  candidate-expansion step is LOST).**
  The honest trade-off: the guard's
  structural rule cannot distinguish
  "rank-1 is a current-truth
  candidate" from "rank-1 is a stale
  candidate". Both look identical to
  the guard. The guard's protection
  is therefore a TRADE-OFF: it
  ELIMINATES the `temp-rate-limit`
  regression (where the rank-1 is a
  current-truth candidate and the
  injected `supersedes` candidate is
  not) AT THE COST of losing the +2
  recoveries of Experiment 9's
  candidate-expansion step (where
  the rank-1 is a STALE candidate
  and the injected `supersedes`
  candidate IS the current truth —
  the multi-anchor re-ranker
  promotes the injected current truth
  above the stale rank-1, and the
  guard blocks that promotion too).
  The +2 recoveries are on
  `temp-schema-migrations` (rank-1
  is 1, stale; injected 50 is the
  current truth) and `temp-stale-
  fact-trap-safety` (rank-1 is 6,
  stale; injected 69 is the current
  truth). In both cases, the
  injected `supersedes` candidate IS
  the current truth, but the guard
  blocks the promotion because the
  rank-1 is non-injected. The
  structural guard cannot preserve
  these legitimate recoveries.

- **The guarded primary's
  `recoveredByExpansion` is 4** (the
  same as Experiment 9's multi-anchor
  linked-expansion). The candidate-
  expansion step surfaces the current
  fact in the top-K for 4 baseline-
  missing queries. The guarded
  primary's after-rerank `current-
  Missing` is 0 (the 4 missing
  queries' current facts are in the
  top-K after expansion). The +6
  recovery (the multi-anchor re-
  ranker's `supersedes` promotion of
  non-injected candidates like 7
  above 22 on `temp-stale-fact-trap-
  release`) is preserved by the
  guard (the guard blocks ONLY
  injected `supersedes` candidates).

- **The guarded primary's `verdict`
  is `safe` per the documented
  deterministic rule** (regressionCount
  = 0, currentTruthAt1Delta = +6).
  The `recommendedVerdict` field is
  a research-only reading aid.

- **The diagnostic oracle ceiling
  (`oracle-guarded-candidate-
  injection-ceiling`) also lands at
  18/26, not 20/26.** The oracle
  guard's STRONGER protection
  (consulting `currentTruthIds` as a
  HINT for which candidates to
  protect) does NOT recover the +2.
  The +2 recoveries require the
  multi-anchor re-ranker's
  `supersedes` promotion of INJECTED
  `supersedes` candidates; the oracle
  guard's hint (`supersedes` target
  is current truth) does not fire
  for these cases (the `supersedes`
  targets — 57 for the
  `temp-schema-migrations` case, 24
  for the `temp-stale-fact-trap-
  safety` case — are NOT current
  truth). The oracle guard's primary
  protection (injected + non-
  injected rank-1) fires, blocking
  the +2 recoveries. The honest
  answer: a `supersedes-promote`
  guard that blocks `supersedes`
  promotions of injected candidates
  above non-injected rank-1 lands at
  18/26 with 0 regressions,
  regardless of whether the guard
  consults `currentTruthIds` or not.
  The +2 of Experiment 9's candidate-
  expansion step cannot be preserved
  by such a guard.

- **The `guarded-no-op` sanity row
  is functionally identical to the
  `reranker-control-multi-anchor-
  aware-combined` row** (both at
  18/26 with 0 regressions, 0
  promotions blocked by the guard).
  The row surfaces "the guard alone,
  with no expansion, is a no-op" —
  the guard's `promotionsBlockedByGuard`
  is 0 (no candidate was injected
  for the guard to block). The row
  is the honest "the guard is a
  structural rule, not a semantic
  re-ranker" framing.

- **The `oracle-candidate-injection-
  ceiling` (no guard) reaches
  21/26 with 0 regressions.** The
  variant mirrors Experiment 9's
  oracle; the candidate-injection
  step surfaces every current-truth
  id in the top-K, the multi-anchor
  re-ranker's `supersedes` promotion
  promotes the injected current
  truths above stale rank-1
  candidates, and the +3 recovery
  (vs the guarded primary's 18) is
  the `supersedes` promotion of
  injected current truths above
  stale rank-1 candidates. The
  variant is the BEFORE-state
  reference for the guard's
  diagnostic ceiling.

### Honest framing: can a structural guard preserve the +2?

NO. A `supersedes-promote` guard
that blocks `supersedes` promotions
of injected candidates above non-
injected rank-1 cannot preserve the
+2 recoveries of Experiment 9's
candidate-expansion step. The +2
recoveries ARE the multi-anchor
re-ranker's `supersedes` promotion
of INJECTED current truths above
stale rank-1 candidates; the guard
blocks exactly these promotions. A
guard that distinguishes "rank-1 is
current truth" from "rank-1 is
stale" — a SEMANTIC guard — could
preserve the +2. The semantic guard
would consult `currentTruthIds` as
a hint; the guard would block an
injected `supersedes` promotion
ONLY if the rank-1 is current truth.
The semantic guard's implementation
requires a production-side schema
change (a `currentTruthIds` column
at `remember` time) that is OUT OF
SCOPE for this experiment. The
honest reading: a structural guard
(currentTruthIds-free) lands at
18/26 with 0 regressions; a
semantic guard (currentTruthIds-
consulting) COULD land at 20/26
with 0 regressions, but that
requires a schema change that the
production-side does NOT have today.

### Limitations

- The guard rule is INTENTIONALLY
  NARROW: it only protects the non-
  injected rank-1 candidate from
  being displaced by a `supersedes-
  promote` of an injected candidate.
  A more aggressive guard (e.g.,
  "do not promote an injected
  candidate above ANY non-injected
  candidate") would be a future
  experiment.
- The injected-id set is the
  candidate-expansion step's output.
  The guard does NOT decide which
  candidates are injected; the
  candidate-expansion rule decides.
  The guard is a LATE step.
- The diagnostic oracle variant
  (`oracle-guarded-candidate-
  injection-ceiling`) consults
  `currentTruthIds` as a HINT for
  which candidates to protect. The
  variant is the IDEAL PROTECTION
  CEILING: a re-ranker that knows
  which candidates are current AND
  protects them. The variant is
  clearly labeled `oracle-
  diagnostic`; it is NOT production-
  like; a production-side schema
  would need a `currentTruthIds`
  column on the storage schema to
  wire this variant in. The variant
  ALSO lands at 18/26 (not 20/26);
  see "Honest framing" above.
- The guard is parameterized with
  the Experiment 8
  `multi-anchor-aware-combined`
  rerank rule as the downstream
  reranker. The `downstreamVariant`
  parameter is intentionally guarded
  with a runtime check so a future
  caller that swaps the downstream
  reranker is forced to read the
  contract.
- The semantic overlay is a passed-
  in `queryId -> "hit"|"miss"` map;
  the experiment does NOT re-derive
  the dense ranker's behavior. The
  overlay is a cross-reference, not
  a production signal.
- The `promotionsBlockedByGuard`
  counter is the guard's "fire"
  signal: a guarded variant that
  blocked 0 promotions is
  functionally identical to the
  unguarded re-ranker; a guarded
  variant that blocked ≥1 promotion
  is the one that eliminated the
  `temp-rate-limit` regression the
  guard was designed to eliminate.
  The count surfaces the guard's
  cost (a guarded variant that
  blocked 8 promotions blocked 8
  legitimate `supersedes` promotions
  that the multi-anchor re-ranker
  was going to make; 2 of those 8
  were on queries where the
  promotion would have been a
  recovery, and the guard
  sacrificed those recoveries for
  the regression elimination).

### How to run

```bash
# Run the experiment (writes the
# JSON artifact to
# .curion/benchmark/).
npm run benchmark:retrieval:supersedes-promote-guard

# Run without writing the artifact.
npm run benchmark:retrieval:supersedes-promote-guard:no-write

# Run with the pre-computed
# semantic evidence.
npm run benchmark:retrieval:supersedes-promote-guard:with-evidence
```

### Tests

```bash
# Run the unit + end-to-end tests.
npm run test:supersedes-promote-guard
```

### Files

- `supersedes-promote-guard.ts` —
  the pure functions: guard rule
  type, simulated guard rule
  application helper, per-variant
  evaluator, per-variant report
  builder, human-readable formatter,
  verdict function, per-query
  rollup, gap breakdown, multi-
  anchor subset block, temp-rate-
  limit pin block.
- `supersedes-promote-guard-runner.ts`
  — the CLI orchestrator. Reads the
  baseline benchmark artifact (and
  optionally the semantic evidence
  file), runs the experiment, and
  writes the JSON artifact.

### Artifact shape

The on-disk artifact is a
`GuardedRerankReport` (see the
JSDoc on the type). The shape is
intentionally distinct from the
prior report shapes; the experiment
introduces a new
`tempRateLimitRegressionCount` /
`promotionsBlockedByGuard` block
(the per-variant guard metrics), a
new `cleanTempRateLimitRegressionCount`
field (the per-variant clean-slice
temp-rate-limit pin), and a per-
query `tempRateLimitRegression` /
`promotionBlockedByGuard` /
`injectedIds` / `afterGuardTopIds`
/ `afterGuardTopScores` block (the
per-query guard decision
provenance). The file prefix is
`retrieval-supersedes-promote-guard-*.json`.
