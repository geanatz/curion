# Memory Decision Engine — Balanced-Score Comparison Methodology

This document defines how to determine whether the Memory Decision Engine is
"better than production" using a **Balanced Score** — a weighted composite of
Safety, Cleaner Memory, and Recall Quality. It describes the shadow-comparison
methodology, the conservative gate logic that governs promotion readiness, the
expected artifact shape, and the data-sensitivity principles that keep the
process outside production traffic.

This is a methodology document only. It does not change code behaviour, activate
any mode, or commit any system to production traffic.

---

## What "Better Than Production" Means

"Better than production" does not mean "the engine is always right" or "higher
action rate is better." It means the engine, when promoted to active mode, would
produce a net improvement across three independent dimensions:

1. **Safety** — no regressions in dangerous or privacy-violating outputs.
2. **Cleaner Memory** — meaningful reduction in storage noise (superseded,
   invalidated, redundant records) without losing useful context.
3. **Recall Quality** — equal or better retrieval accuracy, particularly on
   temporal, adversarial, and no-answer queries.

A production controller that is slightly more aggressive on cleanup but
introduces a single safety regression is not "better." A controller that
improves recall but silently pollutes memory is not "better." The Balanced
Score makes this trade-off explicit and the gate logic enforces it.

---

## The Balanced Score

The Balanced Score is a three-pillar composite. Each pillar has a defined
metric set and an independent pass/fail gate. The composite is not a single
scalar that can be averaged away — a failure in any pillar blocks promotion
regardless of the other two scores.

| Pillar | Weight in composite | Gate |
|---|---|---|
| Safety | **Blocking** — failure blocks promotion unconditionally | 100 % of safety assertions must pass |
| Cleaner Memory | Informational until Safety passes; then weighted | Treated as a positive signal, not a requirement |
| Recall Quality | Informational until Safety passes; then weighted | Treated as a positive signal, not a requirement |

Safety is not weighted against the other two. It is a **veto**: if Safety
fails, the engine cannot be promoted regardless of how well it scores on
Cleanup or Recall.

---

## Metric Groups

### Safety

Safety assertions are non-negotiable gate conditions. They verify that the
engine never produces a decision that could expose dangerous, private, or
misleading content.

| Metric | Description | Gate |
|---|---|---|
| `safetyDecisionRate` | Fraction of engine decisions flagged as `safety` class (any subclass) | Must be ≤ production baseline rate |
| `dangerousContentPassRate` | Fraction of known-dangerous prompt scenarios where engine outputs `skip` or equivalent safe action | Must be 100 % |
| `privacyViolationRate` | Fraction of scenarios where engine decision would expose a private-record relationship in the wire output | Must be 0 % |
| `confabulationRate` | Fraction of no-answer queries where engine decision would have surfaced a confabulated memory | Must be ≤ production baseline rate |
| `safetyAdapterFailureRate` | Fraction of calls where the safety pre-check or adapter returned an error | Must be 0 % in shadow mode |

**Implementation note:** Safety pre-checks run before the engine is called and
are deterministic (no LLM call). They catch known-dangerous input patterns,
credential-adjacent content, and private-record access attempts. The engine's
structured decision is compared against the pre-check outcome to detect
divergence.

**Gate:** Safety passes only when every safety assertion is green. A single
`dangerousContentPassRate < 1.0` or `privacyViolationRate > 0` is a hard stop.

---

### Cleaner Memory

Cleaner Memory measures whether the engine reduces storage noise relative to
the production deterministic path. The production path is the baseline; the
engine in shadow mode is the challenger.

| Metric | Description | Signal |
|---|---|---|
| `superfluousRecordRate` | Fraction of `remember` calls where the engine would suppress a record the production path would store | Lower is cleaner |
| `redundantActionRate` | Fraction of `remember` calls where the engine flags a new record as redundant with an existing active record | Positive signal — engine is deduplicating |
| `supersededActionRate` | Fraction of `remember` calls where the engine would mark an existing record as superseded by a new one | Positive signal — engine is managing lifecycle |
| `invalidationActionRate` | Fraction of `remember` calls where the engine would retract a previously stored record | Positive signal — engine is correcting errors |
| `conflictFlagRate` | Fraction of `remember` calls where the engine would link two active records as conflicting without auto-inactivating either | Positive signal — engine is flagging, not auto-deleting |
| `memorySizeDelta` | Estimated byte-delta in storage after a representative operation sequence | Negative is better (smaller, cleaner store) |

**Gate:** Cleaner Memory has no independent pass/fail gate. It is treated as
an informational signal. However, a large negative delta in `memorySizeDelta`
or an unexpectedly high `superfluousRecordRate` (engine suppressing records
production would keep) should trigger investigation before promotion is
considered.

---

### Recall Quality

Recall Quality measures whether the engine's decisions preserve or improve the
accuracy of the retrieval system. The engine acts on the memory store; the
recall system reads it. If engine-driven state transitions degrade retrieval,
the composite score must reflect that.

| Metric | Description | Signal |
|---|---|---|
| `recallHitRate` | Fraction of recall queries where the expected memory id appears in top-K | Must be ≥ production baseline |
| `recallCurrentTruthRate` | Fraction of temporal queries where the current fact ranks first | Must be ≥ production baseline |
| `recallNoAnswerTnr` | True-negative rate on no-answer queries (abstention accuracy) | Must be ≥ production baseline |
| `recallRank1MatchRate` | Fraction of queries where the engine-driven store produces the same top-1 as the production store | Must be ≥ 0.95 (informational) |
| `adaptiveDepthPassRate` | Fraction of adaptive-depth scenarios where the engine-store preserves correct multi-hop recall | Must be 100 % |

**Gate:** Recall Quality has no independent pass/fail gate. It is informational
until Safety passes. If `recallHitRate` or `recallCurrentTruthRate` regresses
below the production baseline, the engine cannot be considered "better" even if
Safety and Cleaner Memory scores are excellent. The Recall Quality signal is
the tiebreaker in close promotion decisions.

---

## Conservative Gate Logic

The promotion gate is a strict conjunction:

```
PROMOTION_GATE = Safety_Pass AND (Cleaner_Memory_Signal IS NOT strongly_negative) AND (Recall_Quality_Signal IS NOT regressed)
```

Concretely:

1. **Safety fails → blocked.** Any safety assertion failure (even 1 of 1000)
   blocks promotion. There is no averaging or threshold tolerance.

2. **Safety passes, but Cleaner Memory shows large regressions → investigate
   before proceeding.** A `superfluousRecordRate` significantly above zero or a
   `memorySizeDelta` that grows the store substantially must be explained. The
   engine may be suppressing too many records.

3. **Safety passes, but Recall Quality regresses → blocked.** If the engine's
   memory management degrades retrieval accuracy below the production baseline,
   promotion cannot proceed.

4. **All three green → eligible for promotion review.** The composite signal
   is positive, but promotion still requires explicit project-owner approval.
   The gate proves the engine is safe to activate; it does not grant
   permission.

---

## Replay / Shadow Methodology

The comparison is performed via **shadow-mode replay**: the engine processes
the same inputs as the production controller but its decisions are logged
without being applied to persistent state. No live production traffic is
captured or routed through the engine for comparison purposes.

### Step 1 — Baseline Capture (Production Path)

Run the production controller (`CURION_REMEMBER_DECISION_MODE=off`) against a
representative synthetic scenario set. Record the production memory state and
retrieval outcomes for each scenario. This produces the **production baseline**
artifact.

### Step 2 — Engine Shadow Run

Run the same scenario set with `CURION_REMEMBER_DECISION_MODE=shadow`. The
engine processes each input and emits a structured decision. The decision is
logged but **never applied**: no memory state is mutated, no public output is
changed, no MCP tool schema is altered. This produces the **shadow comparison**
artifact.

### Step 3 — Comparative Evaluation

Pair each scenario's production baseline with its shadow decision. Compute the
Balanced Score metrics by comparing the two outcomes per scenario. Produce a
**shadow comparison report** that shows the per-scenario and aggregate delta.

### Step 4 — Gate Evaluation

Apply the Conservative Gate Logic to the shadow comparison report. If the
gate fails, document the failure reason and return to shadow-mode observation.
If the gate passes, the report is evidence that the engine is eligible for
promotion review.

### Constraints

- **No live production traffic.** The replay uses synthetic scenarios only.
- **No credential exposure.** The scenario set contains no raw user inputs,
  no secrets, and no PII.
- **No persistent mutation in shadow mode.** The engine's shadow decisions are
  never applied to the memory store.
- **No auto-promotion.** A passing gate does not activate the engine. It
  produces evidence for a human review and approval.

---

## Artifact Shape

The shadow comparison report is written to `.curion/benchmark/` following the
existing `writeTimestampedJsonArtifact` convention. Artifact prefix:
`shadow-comparison-<timestamp>.json`.

```json
{
  "generatedAt": "<ISO timestamp>",
  "evaluationMode": "shadow-comparison",
  "scenarioSetVersion": "<version string>",
  "productionBaseline": {
    "totalScenarios": 0,
    "safetyAssertionsPassed": 0,
    "safetyAssertionsFailed": 0,
    "superfluousRecordRate": 0.0,
    "recallHitRate": 0.0,
    "recallCurrentTruthRate": 0.0
  },
  "engineShadow": {
    "totalScenarios": 0,
    "safetyAssertionsPassed": 0,
    "safetyAssertionsFailed": 0,
    "superfluousRecordRate": 0.0,
    "redundantActionRate": 0.0,
    "supersededActionRate": 0.0,
    "invalidationActionRate": 0.0,
    "conflictFlagRate": 0.0,
    "recallHitRate": 0.0,
    "recallCurrentTruthRate": 0.0
  },
  "delta": {
    "status": "counterfactual",
    "memorySizeDelta": 0,
    "decisionDivergenceRate": 0.0,
    "counterfactualClassification": "inconclusive",
    "projectedMemoryDeltaPerScenario": [
      {
        "scenarioId": "string",
        "action": "reject",
        "projectedDelta": -1,
        "rationale": "engine recommends reject; production stored — projected memory count -1 if applied (memory would not be stored)"
      }
    ],
    "recallHitRateDelta": null,
    "recallCurrentTruthRateDelta": null,
    "note": "Phase 2 counterfactual projection: ... (see Phase 2 definition)"
  },
  "gate": {
    "safetyPassed": false,
    "cleanerMemorySignal": "positive|neutral|negative",
    "recallQualitySignal": "positive|neutral|regressed",
    "promotionEligible": false
  },
  "balancedScore": {
    "safety": { "passed": false, "details": {} },
    "cleanerMemory": { "signal": "neutral", "details": {} },
    "recallQuality": {
      "signal": "neutral",
      "coverageComplete": false,
      "details": {}
    }
  },
  "limitations": [
    "Shadow comparison uses synthetic scenarios, not live production traffic.",
    "The engine's shadow decisions are not applied to persistent storage.",
    "No auto-promotion: project-owner approval is required regardless of gate result.",
    "Delta is synthetic-only and projection-only (status: counterfactual); measured quality impact remains future pending Phase 3 applied simulation.",
    "Recall Quality denominators are synthetic (9 adaptive-depth scenarios); they do not represent live production traffic distribution."
  ]
}
```

**Note on `delta.status`:** `"counterfactual"` means Phase 2 counterfactual projection
fields are populated — `memorySizeDelta`, `decisionDivergenceRate`,
`counterfactualClassification`, and `projectedMemoryDeltaPerScenario`. This is
**projection only**, not measured production quality improvement. Phase 2 derives
these fields from comparing production outcome vs shadow decision without applying
engine decisions to any store. `"future"` (delta fields not yet available) is a
legacy/Phase-1 empty state — the current implementation only emits `"counterfactual"`
when Phase 2 delta fields are populated. A true measured delta requires Phase 3
applied simulation.

**Note on `coverageComplete`:** The Recall Quality pillar sets
`coverageComplete: true` only when all three labelled coverage metrics
(`rank1`, `currentTruth`, `noAnswer` TNR) are non-null across the 9
adaptive-depth scenarios. A `coverageComplete: false` signal indicates
incomplete metric capture and should be investigated before the report is
used for promotion review.

**Note on `promotionEligible`:** When `gate.promotionEligible: true`, the
engine is eligible for project-owner review. It is **not** approved,
activated, or authorised to mutate memory. Explicit owner approval covering
the specific target stage is always required.

---

## Relationship to Existing Benchmarks

### Why Adapter-Only Benchmark Is Insufficient

The existing `benchmark:decision-policy-evaluation` harness is a critical
quality tool, but it exercises only the **decision adapter in isolation** against
a curated synthetic scenario set. It does not:

- Exercise the full production controller path (`remember(text)` → evidence
  building → adapter call → decision application → storage mutation).
- Capture the downstream effect of engine decisions on the memory store.
- Measure the impact on recall accuracy (the engine changes memory state;
  the retrieval system reads that state).
- Detect regressions in `recallHitRate` or `recallCurrentTruthRate` that would
  result from incorrect state transitions.
- Produce a comparative baseline against the production deterministic path.

The adapter-only benchmark proves the engine's decision vocabulary is stable
and the adapter is wired correctly. It does not prove the engine produces
better outcomes end-to-end.

### Complementary Role of Existing Benchmarks

| Benchmark | Role in Balanced Score methodology |
|---|---|
| `decision-policy-evaluation` | Proves adapter decision vocabulary stability before shadow comparison begins |
| `recall-policy-evaluation` | Proves recall-side decision vocabulary is stable; baseline for recall quality |
| `retrieval:adaptive-depth` | Proves adaptive-depth retrieval is preserved; must not regress before promotion |
| `long-horizon-memory-evaluation` | Proves storage lifecycle seams are correct; pre-requisite for any active mutation |

All four must pass before a shadow comparison report is generated. The
shadow comparison report does not replace these benchmarks; it adds the
comparative dimension that the adapter-only and storage-only harnesses
cannot provide.

---

## Data Sensitivity and Redaction Principles

### No Secrets

Benchmark scenarios must not contain raw API keys, tokens, credentials, or
connection strings. Use safe placeholder values and ensure corpus hygiene
tests catch any accidental inclusion.

### Hash or Sanitize Raw User Inputs

If real user inputs from trace logs are used to construct replay scenarios:

1. **Hash before storage.** Apply a stable one-way hash to any raw input text
   before it enters the scenario corpus.
2. **Strip sensitive keys.** Redact fields that contain credentials, tokens,
   personal identifiers, or payment information from any captured trace payload.
3. **Manual approval required.** Using real user traffic for replay scenarios
   requires explicit project-owner approval and a documented redaction review.

### No Live Production Traffic Collection

The comparison methodology does not capture, route, or analyse live production
traffic for the purpose of shadow comparison. This is explicit out-of-scope.
If production traffic analysis is desired in the future, it requires a separate
process, a separate approval, and separate data-handling documentation.

### Shadow Decision Logging

Shadow decisions are logged at `debug` level to the process stderr. They contain:

- `action`, `reason`, `confidence`, `supersededIds`, `conflictsWithIds`,
  `redundantWithIds`
- Provider and fallback metadata
- HTTP call counts

They do **not** contain raw input text, credentials, or PII. The debug log
sink is controlled by the operator; Curion does not transmit shadow decisions
to any external service.

---

## Out of Scope

This document does **not** include or authorize:

- **Active mode activation.** The engine remains in `off` or `shadow`.
- **Code behaviour changes.** No mutation logic, no controller wiring, no
  engine-driven state transitions.
- **Live production traffic capture.** No real user inputs are used in the
  comparison methodology without explicit additional approval.
- **Auto-promotion.** A passing Balanced Score gate does not activate the
  engine. Project-owner approval is always required.
- **Recall-quality scoring via LLM judge.** No provider call is made to judge
  recall quality. All metrics are deterministic or storage-verified.
- **FROZEN_TRANSFER_BASELINES externalization.** Benchmark hygiene is a
  separate concern and does not gate the shadow comparison methodology.
- **Changes to the MCP tool surface.** Exactly two tools (`remember`,
  `recall`) remain on the wire.

---

## Document Relationship

| Document | Role |
|---|---|
| [comparison-methodology.md](./comparison-methodology.md) | Defines the Balanced Score methodology and what "better than production" means |
| [delta-criteria.md](./delta-criteria.md) | Defines the delta classification criteria (better/same/worse/inconclusive) and the required gates before Phase 2 counterfactual fields and Phase 3 applied simulation can produce a quality verdict |
| [promotion-readiness.md](./promotion-readiness.md) | Summarises current evidence gaps and owner decision options |
| [activation-plan.md](../activation-plan.md) | Describes the staged rollout path from `off` → `shadow` → `active` |

This document establishes the Balanced Score framework. The delta-criteria
document defines the classification rules within that framework. The
promotion-readiness document applies those criteria to the current evidence and
identifies the owner's decision choices.

---

## Quick Reference

| Question | Answer |
|---|---|
| What is the Balanced Score? | A three-pillar composite: Safety (blocking), Cleaner Memory (signal), Recall Quality (signal) |
| Can the engine be promoted if Safety fails? | No. Safety is a veto. |
| Does Cleaner Memory have an independent gate? | No. It is informational until Safety passes. |
| Does Recall Quality have an independent gate? | No. A regression blocks promotion, but the gate is part of the composite logic. |
| Does a passing gate auto-activate the engine? | No. Project-owner approval is always required. |
| Does this use live production traffic? | No. Shadow comparison uses synthetic scenarios only. |
| What is the expected artifact? | `shadow-comparison-<timestamp>.json` in `.curion/benchmark/` — implemented; `delta.status` is `"counterfactual"` for Phase 2 projection; `delta.status="measured"` requires Phase 3 applied simulation. |
| Does this replace existing benchmarks? | No. It complements them. All four existing benchmarks must pass before shadow comparison. |
| What does `coverageComplete` mean? | Recall Quality metrics are fully captured (all three labelled coverage metrics non-null). Incomplete coverage should be investigated before promotion review. |
| What does `delta.status=counterfactual` mean? | Phase 2 counterfactual projection is populated — `memorySizeDelta`, `decisionDivergenceRate`, `counterfactualClassification`, and `projectedMemoryDeltaPerScenario` are derived from comparing production outcome vs. engine decision without applying engine decisions. Measured recall quality delta (recallHitRateDelta, recallCurrentTruthRateDelta) remains null until Phase 3 applied simulation. |
| What is the adapter-only benchmark insufficient? | It exercises only the adapter in isolation; it does not measure end-to-end outcomes or downstream recall impact. |
