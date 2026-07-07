# Memory Decision Engine — Delta Criteria

This document defines the classification criteria for the comparative delta between
the production `decisionMode=off` path and the smart-librarian shadow decision
path. It establishes when the delta supports a "better / same / worse /
inconclusive" classification, what evidence is required for each phase, and why
the current `delta.status="counterfactual"` is the correct Phase 2 standing until those gates are
passed.

This is a criteria document only. It does not change code behaviour, activate any
mode, or authorize production traffic analysis.

---

## Comparison Purpose

The comparative delta answers a single question: **when the smart librarian
processes the same input as the production controller, does it make a different
—and objectively better — memory decision?**

The comparison is:

- **Production path** (`decisionMode=off`): the existing deterministic controller
  that stores, skips, or supersedes based on fixed rules.
- **Shadow path** (`decisionMode=shadow`): the smart-librarian engine that emits
  a structured decision (store, no_op, supersede, invalidate,
  flag_redundant, flag_conflict, reject, redact/clarify) from an LLM-backed
  adapter.

The delta is the pairwise difference between what production would have done and
what the engine recommends. It is not a measurement of absolute quality — it is
a measurement of relative decision quality against a known baseline.

---

## Decision-Divergence vs Quality-Impact

These two concepts are frequently conflated but are independent.

### Decision-Divergence

Decision-divergence measures **whether the engine's action differs from the
production action** on the same input. Divergence is a necessary precondition
for a classification of "better" or "worse," but divergence alone proves nothing
about quality.

Example: production stores a record; engine emits `supersede`. That is a
divergence. Whether it is better, worse, or inconclusive depends on the
downstream memory state, not the divergence itself.

### Quality-Impact

Quality-impact measures **whether the divergence produces a meaningfully better
or worse memory state** from the perspective of the recall system. A divergence
with no measurable impact on recall is neutral. A divergence that demonstrably
improves or degrades recall accuracy is quality-relevant.

### The Distinction in Practice

| Scenario | Divergence? | Quality-Impact? | Classification |
|---|---|---|---|
| Production stores; engine supersedes; recall unchanged | Yes | None | Inconclusive until impact measured |
| Production stores; engine supersedes; recall improves | Yes | Positive | Better |
| Production stores; engine supersedes; recall degrades | Yes | Negative | Worse |
| Production stores; engine stores same content | No | None | Same |
| Production supersedes; engine stores; recall unchanged | Yes | None | Inconclusive |

**Disagreement is not proof.** Divergence without measured quality-impact
cannot support any classification beyond "inconclusive."

---

## Classification Rules

The delta classification applies only after Safety gates pass. The four
classification states are:

### 1. Better

The engine's decision is **better** than production when all of the following
hold:

1. The engine's action differs from the production action (divergence exists).
2. The divergence produces a **measurable positive quality-impact** on the
   memory store — either cleaner memory, preserved/improved recall accuracy, or
   both.
3. No Safety assertion is violated by the engine's decision.
4. The positive impact is reproducible and consistent across a representative
   scenario set, not a single edge case.

### 2. Same

The engine's decision is **the same** as production when either:

1. The engine emits the same action as the production controller for the same
   input (no divergence), OR
2. The engine emits a different action but the resulting memory state is
   functionally identical for recall purposes (equivalent downstream impact).

### 3. Worse

The engine's decision is **worse** than production when any of the following
hold:

1. The engine's action causes a **measurable negative quality-impact** on the
   memory store — degraded recall accuracy, loss of useful context, or
   privacy/ safety regression.
2. The engine suppresses a record production would store and that record is
   subsequently needed for a recall query (false-negative on useful memory).
3. Any Safety assertion that passes for production fails for the engine.

### 4. Inconclusive

The delta is **inconclusive** when:

1. Divergence exists but **no measured quality-impact** can be established — the
   downstream effect on the memory store or recall system is unknown or
   unmeasurable with available evidence.
2. The scenario is an edge case where neither path has a clearly superior
   outcome and the quality-impact cannot be determined without applied
   simulation.
3. The production baseline for the scenario is itself ambiguous or undefined.

---

## Action-Level Classification Examples

The smart-librarian engine emits decisions from this vocabulary:

`store`, `no_op`, `supersede`, `invalidate`, `flag_redundant`, `flag_conflict`,
`reject`, `redact/clarify`

The production controller path makes decisions from a narrower vocabulary:
`store` or `skip` (with supersede semantics in some cases).

### Example 1 — Divergence with Positive Impact → Better

> **Input:** User provides updated installation instructions that supersede a
> previously stored version.
>
> **Production path:** Stores the new record independently, leaving the old
> record active. Both exist. Recall on "installation instructions" may return
> either.
>
> **Engine path:** Emits `supersede`, marking the old record inactive and
> storing the new one as current.
>
> **Delta classification: Better.** Divergence is present. Quality-impact is
> positive: the engine produces a cleaner memory state with a single authoritative
> current fact. Recall returns the correct answer without ambiguity.

### Example 2 — Divergence with Negative Impact → Worse

> **Input:** User provides detailed context for a project.
>
> **Production path:** Stores the record.
>
> **Engine path:** Emits `no_op` because the adapter confidence is low and it
> treats the input as low-value. The record is not stored.
>
> **Recall query:** Later, user asks about the project. The fact is not in
> memory.
>
> **Delta classification: Worse.** Divergence is present. Quality-impact is
> negative: useful context was lost. The engine suppressed a record production
> would have kept, and that suppression is measurable at recall time.

### Example 3 — Divergence with No Measured Impact → Inconclusive

> **Input:** User mentions a meeting time that was already recorded.
>
> **Production path:** Stores a duplicate record.
>
> **Engine path:** Emits `flag_redundant`, linking the new record to the existing
> one but not suppressing storage.
>
> **Recall query:** "What time was the meeting?" Both records are present;
> recall returns the correct time from either.
>
> **Delta classification: Inconclusive.** Divergence is present, but the
> quality-impact on recall is zero — both paths produce a recallable answer. The
> engine's flagging behaviour may be preferable for observability, but it cannot
> be classified as better without a measurable recall advantage. Applied
> simulation of long-horizon recall patterns would be needed to reclassify.

### Example 4 — No Divergence → Same

> **Input:** User provides a straightforward fact.
>
> **Production path:** Stores the record.
>
> **Engine path:** Emits `store` for the same content.
>
> **Delta classification: Same.** No divergence. The engine and production reach
> the same decision and produce the same memory state.

### Example 5 — Conflict Flagging → Inconclusive Without Applied Simulation

> **Input:** Two active records contain contradictory configuration values.
>
> **Production path:** Both records are stored; no conflict detection occurs.
> Recall may return either value depending on ranking.
>
> **Engine path:** Emits `flag_conflict`, linking the two records as contradictory
> without auto-inactivating either.
>
> **Recall query:** "What is the configuration value?" Recall still returns either
> value — the conflict is flagged but not resolved.
>
> **Delta classification: Inconclusive.** The engine detects a real problem
> production misses, but the quality-impact is not yet measurable without applied
> simulation showing whether conflict flagging produces better downstream recall
> outcomes. The flag may be better for human review but is not yet demonstrably
> better at recall time.

### Example 6 — Reject Action → Safety Gate, Not Delta Classification

> **Input:** User input that triggers a dangerous-content or credential-adjacent
> pattern.
>
> **Production path:** Stores the record.
>
> **Engine path:** Emits `reject`.
>
> **Classification:** This does not enter the delta classification at all. It is
> caught by the Safety gate. If `reject` is the correct action and production
> would have stored, this is a **Safety pass** — the engine is demonstrating a
> safety improvement, which is measured in the Safety pillar, not the delta.

### Example 7 — Redact/Clarify → Inconclusive Without Downstream Verification

> **Input:** User provides a query that matches a record containing
> privacy-sensitive content.
>
> **Production path:** Returns the raw record.
>
> **Engine path:** Emits `redact/clarify`, producing a redacted response with a
> clarification note.
>
> **Recall query:** N/A — this decision affects wire output, not storage.
>
> **Delta classification: Inconclusive for storage delta.** The `redact/clarify`
> decision is not a storage mutation and does not affect `balancedScore.delta`
> which measures memory state changes. Its quality-impact would need to be
> measured in a separate wire-output quality evaluation, not the storage delta.
> This action is out of scope for the delta classification as defined here.

---

## What Can Be Measured Now

At the time of writing, the following can be measured directly from the
shadow-comparison harness without additional infrastructure:

| Evidence | Source | What it shows |
|---|---|---|
| Decision-divergence rate | Shadow-comparison artifact | What fraction of inputs produce a different engine action |
| Action distribution delta | Shadow-comparison artifact | How engine action rates differ from production rates |
| Synthetic recall accuracy (shadow-side) | Shadow-comparison artifact | Whether engine-storage produces the same top-K recall as production storage in synthetic scenarios |
| Safety assertion divergence | Shadow-comparison artifact | Whether engine and production diverge on safety-relevant decisions |
| Adapter decision vocabulary stability | `benchmark:decision-policy-evaluation` | Whether the engine emits valid, stable action vocabulary |

**What this does NOT measure:** The downstream quality-impact of each divergence
on real recall patterns. The synthetic scenarios produce a same-top-K result,
but this is a synthetic proxy, not a production-quality measurement.

---

## What Is Phase 2 Counterfactual Projection

Phase 2 is the **counterfactual projection** currently implemented in the
shadow-comparison harness. It derives delta fields by comparing production
outcome vs. engine shadow decision for each scenario in the existing
`runs[]` — without applying engine decisions to any store.

Phase 2 populates:

- `memorySizeDelta` — projected net memory count change if engine decisions were applied.
- `decisionDivergenceRate` — rate at which engine decisions diverge from production outcomes.
- `counterfactualClassification` — conservative "same" (no divergence) or "inconclusive" (any divergence); "better"/"worse" are never emitted in Phase 2.
- `projectedMemoryDeltaPerScenario` — per-scenario projected memory deltas.

**Phase 2 does NOT require:**

- Applied simulation or cloned production storage snapshots — those belong to Phase 3.
- A separate production baseline capture beyond the production outcome already captured per scenario in the shadow-comparison `runs[]`.
- Recall side-by-side measurement — `recallHitRateDelta` and `recallCurrentTruthRateDelta` remain null in Phase 2; measured recall quality impact requires Phase 3.

Phase 2 is complete when the shadow-comparison harness has run and produced
delta fields. `delta.status` is `"counterfactual"` (Phase 2 standing, not a placeholder).

---

## What Requires Applied Simulation (Phase 3)

Applied simulation actually applies engine decisions to a representative memory
store and measures the resulting recall accuracy over a full scenario horizon.
Phase 3 gates:

1. **A cloned production storage snapshot** — a non-production copy of a
   representative memory state, handled under appropriate data controls.
2. **Engine decisions applied to the clone** — running the shadow engine against
   the cloned store and applying its decisions (with rollback logging).
3. **Full recall benchmark against the mutated clone** — measuring `recallHitRate`,
   `recallCurrentTruthRate`, and `recallNoAnswerTnr` on the mutated store.
4. **Comparative readout** — delta between production baseline recall and
   engine-mutated clone recall.

Phase 3 produces a **true comparative delta** with measured quality-impact, not
a projection. This is the only phase that can support a "better" or "worse"
classification with evidence sufficient for a promotion decision.

---

## Why `delta.status="counterfactual"` Is the Correct Phase 2 Standing

`delta.status="counterfactual"` is the correct Phase 2 standing because:

1. **Phase 2 is projection-only.** It derives delta fields from comparing
   production outcome vs. engine shadow decision in the existing `runs[]`
   without applying engine decisions to any store. This is a counterfactual
   projection — it estimates what *would* change if engine decisions were
   applied — not a measured production quality impact.

2. **Recall deltas remain null.** `recallHitRateDelta` and
   `recallCurrentTruthRateDelta` are null in Phase 2. Measured recall quality
   impact requires Phase 3 applied simulation with a cloned production storage
   snapshot.

3. **Decision-divergence without quality-impact is not a verdict.** Divergence
   rates and projected memory deltas show what the engine *would* do differently,
   but not whether different is better or worse. That determination requires
   Phase 3 measured quality impact.

4. **Phase 2 conservative classification.** `counterfactualClassification`
   emits only "same" (no divergence) or "inconclusive" (any divergence). It
   never emits "better" or "worse" — those require Phase 3 measured evidence.

Setting `delta.status` to anything other than `"counterfactual"` (Phase 2) would
misrepresent the nature of the delta as measured rather than projected. That
would violate the conservative gate logic governing the promotion framework.

---

## Required Gates Before Each Phase

### Before Phase 2 — Counterfactual Fields Populated

Phase 2 delta fields are populated when the shadow-comparison harness has run
and produced `runs[]` for a representative scenario set. The following are
required for Phase 2 to be complete:

- [x] Shadow-comparison harness has run and produced per-scenario `runs[]` with
  production outcome and shadow decision for each scenario.
- [x] `memorySizeDelta`, `decisionDivergenceRate`,
  `counterfactualClassification`, and `projectedMemoryDeltaPerScenario` are
  computed from the `runs[]` without applying engine decisions.
- [x] Recall deltas (`recallHitRateDelta`, `recallCurrentTruthRateDelta`) are
  null — measured recall quality impact requires Phase 3.
- [x] `counterfactualClassification` is conservative: "same" when no
  divergence, "inconclusive" when any divergence; "better"/"worse" are never
  emitted in Phase 2.
- [x] Safety gates remain passing on the production outcome run.

### Before Phase 3 — Applied Simulation Authorised and Executed

Phase 2 (counterfactual projection) must be complete, plus:

- [ ] Explicit project-owner approval for applied simulation, covering data
    handling and redaction controls for the cloned storage snapshot.
- [ ] Rollback procedure documented and tested.
- [ ] Telemetry and review process defined for the simulation window.
- [ ] No unresolved Safety regressions in Phase 2 evidence.

### Before "Better" Classification Is Claimed

All Phase 3 gates, plus:

- [ ] Recall Quality delta is positive (engine store recall ≥ production store
    recall, with no regression in any Recall Quality metric).
- [ ] Cleaner Memory signal is positive (measurable reduction in storage noise
    without loss of useful context).
- [ ] The positive classification is consistent across a representative scenario
    set — not a single favourable edge case.

---

## Out of Scope

This document does not include and does not authorise:

- **Activation or mode flip.** The engine remains in `off` or `shadow`. No
  mutation is applied as a result of this document.
- **Auto-routing.** No automatic traffic routing to the engine is described or
  authorised.
- **Production traffic capture or analysis.** No live user inputs are used in
  any comparison described here.
- **Treating disagreement as proof.** Decision-divergence alone is not evidence
  of quality improvement or regression. Quality-impact must be measured.
- **Wire-output quality evaluation.** Actions that affect output (`redact/clarify`)
  are not measured in the storage delta and require separate evaluation
  methodology.
- **LLM-judged recall quality.** All recall metrics are deterministic or
  storage-verified.

---

## Relationship to Other Documents

| Document | Role |
|---|---|
| [comparison-methodology.md](./comparison-methodology.md) | Defines the Balanced Score methodology and the three-pillar composite. This document defines the delta classification criteria within that methodology. |
| [promotion-readiness.md](./promotion-readiness.md) | Summarises current evidence gaps and owner decision options. References this document for the criteria that must be satisfied before the delta can move from `"counterfactual"` (Phase 2 projection) to measured (Phase 3). |

This document is the **delta classification criteria** within the Balanced Score
framework established by comparison-methodology. It answers: "given a measured
delta, how should it be classified?" The promotion-readiness document answers:
"given the current evidence, what should the owner decide next?"

---

## Quick Reference

| Question | Answer |
|---|---|
| What is the delta? | Pairwise difference between production action and engine action for the same input. |
| Divergence = better? | No. Disagreement is necessary but not sufficient. Quality-impact must be measured. |
| When is delta "better"? | Divergence present + measurable positive recall/memory impact + no Safety regression + consistent across scenario set. |
| When is delta "same"? | No divergence, or divergence with no measurable quality-impact. |
| When is delta "worse"? | Any measurable negative recall/memory impact, or Safety regression. |
| When is delta "inconclusive"? | Divergence present but no measurable quality-impact can be established. |
| Why is `delta.status="counterfactual"`? | Phase 2 counterfactual projection is populated (comparing production outcome vs engine decision without applying changes). No production baseline or measured quality-impact yet — that requires Phase 3. |
| When does delta become "measured"? | Phase 3 applied simulation with a cloned production storage snapshot and measured recall delta. |
| Can a "better" classification be claimed in Phase 2? | No. Phase 2 counterfactual projection is projection only, not measured quality-impact. Phase 3 applied simulation is required before any quality verdict is supported. |
| What is in scope for this document? | Delta classification criteria only. No activation, no traffic capture, no auto-routing. |
