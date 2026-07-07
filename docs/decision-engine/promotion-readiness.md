# Memory Decision Engine — Promotion Readiness Briefing

This document is a **static evidence package for project-owner review only**. It
does not constitute approval to activate, does not change any code behaviour,
and does not authorize a mode flip.

---

## Status

**The Memory Decision Engine is not approved for activation. Activation remains blocked.**

This document summarises the current state of evidence from the Balanced Score
shadow-comparison benchmark run and states the remaining gaps that must be
resolved before an owner could reasonably approve a shadow→active transition.

`promotionEligible=true` in a shadow-comparison artifact means the engine is
**eligible for owner review only** — it does not mean approved, enabled, or
safe to activate. No auto-promotion exists.

---

## Current Evidence

### What the Balanced Score measures

The shadow-comparison harness (`npm run benchmark:shadow-comparison`) produces a
Balanced Score across three independent pillars:

| Pillar | Gate | Current signal |
|---|---|---|
| **Safety** | Blocking — any failure blocks promotion | See `balancedScore.safety.*` in the artifact |
| **Cleaner Memory** | Informational signal after Safety passes | See `balancedScore.cleanerMemory.*` in the artifact |
| **Recall Quality** | Informational signal after Safety passes; regression blocks | See `balancedScore.recallQuality.*` in the artifact |

A passing shadow-comparison report proves the engine is **safe to evaluate in
shadow mode**, not safe to activate. The gate is a precondition for owner
review, not a substitute for it.

### Current synthetic benchmark result

The Phase 2 counterfactual projection produces per-scenario classifications as
`better | same | worse | inconclusive`. These are **benchmark-internal
synthetic classifications only** — they do not represent real-world production
outcomes, do not measure live traffic, and do not constitute evidence of
production superiority.

**Current result: better: 8, same: 6, worse: 0**

The `recallHitRateDelta` field remains `null` in the Phase 2 artifact because
the counterfactual projection does not apply engine decisions to storage.
Measured recall quality delta requires Phase 3 applied simulation (offline, in
cloned temp storage), which has not yet produced a measured quality verdict.

### Gate benchmarks

Before a shadow-comparison report is generated, four prerequisite benchmarks
must all pass:

```sh
npm run benchmark:decision-policy-evaluation    # adapter decision vocabulary stability
npm run benchmark:recall-policy-evaluation      # recall-side vocabulary stability
npm run benchmark:retrieval:adaptive-depth      # adaptive-depth recall preserved
npm run benchmark:long-horizon-memory-evaluation # storage lifecycle seams correct
```

These are documented in [src/benchmark/README.md](../src/benchmark/README.md).
All four are scripted, deterministic, no-network runs.

### Recall Quality — synthetic coverage

Recall Quality is derived from **9 adaptive-depth scenarios** with denominators
≥ 2 for `rank1`, `currentTruth`, and `noAnswer` metrics. This is a labelled,
synthetic subset — it exercises the adaptive-depth recall path but does not
constitute live traffic replay.

The Recall Quality pillar carries `coverageComplete: true` in the artifact
when all three labelled coverage metrics (rank-1 match, current-truth,
no-answer TNR) are non-null. See `balancedScore.recallQuality.coverageComplete`
in the shadow-comparison artifact.

---

## What `promotionEligible` Means

`promotionEligible: true` is set when:

1. All Safety assertions pass.
2. Cleaner Memory signal is not strongly negative.
3. Recall Quality signal is not regressed.
4. `coverageComplete: true` for Recall Quality.

**It means**: the evidence package is complete and the engine is eligible for
a project owner to review the report and decide whether to approve a
shadow→active transition.

**It does not mean**: approved, enabled, activated, or ready to flip. The
engine remains in `shadow` or `off` until an explicit project-owner approval
covers the specific stage being advanced.

---

## Remaining Blockers and Gaps

The following gaps are open. Each is a precondition for a responsible
activation decision, not a criticism of current implementation quality.

### 1. No production baseline comparative delta

The `delta` block in the shadow-comparison artifact currently reports
`status: "counterfactual"` (Phase 2 projection only). A true comparative delta requires a production baseline
run — the same scenario set processed through the production `decisionMode=off`
path with production storage capturing the actual memory state. The current
delta is derived from comparing two shadow-side runs (production path vs.
engine path) against isolated temp storage, which is a synthetic proxy, not a
production measurement.

**Impact**: Without a production baseline delta, the comparative evidence
does not reflect what the engine would actually change in production memory.

### 2. Synthetic-only denominators

Recall Quality metrics use synthetic scenario denominators (9 adaptive-depth
scenarios). These are hand-curated, labelled, and deterministic. They do not
represent the distribution of live production traffic.

**Impact**: The recall quality signal is constrained to the scenario set. Real
traffic patterns may surface failure modes the synthetic set does not cover.

### 3. No live/shadow production replay

The shadow-comparison harness uses scripted synthetic scenarios only. There is
no mechanism to capture and replay live production traffic through the shadow
engine.

**Impact**: Real user inputs, edge-case temporal patterns, and adversarial
query shapes in production traffic have not been evaluated against the engine.

### 4. No active-mode controller wiring

The controller does not apply engine decisions as memory state transitions in
any mode. `active` mode is currently downgraded to `shadow` automatically
(`policy.ts` gates it). The mutation wiring with rollback, audit table
visibility, and a kill switch has not been implemented.

**Impact**: Even with owner approval, activating the engine requires
controller-side mutation wiring and guardrail implementation.

### 5. No owner approval for activation

No project owner has reviewed a shadow-comparison report and issued explicit,
documented approval for any stage beyond `shadow`.

### 6. `recallHitRateDelta` is null

The Phase 2 artifact does not populate `recallHitRateDelta` because the
counterfactual projection does not apply engine decisions to storage. The
measured recall quality delta requires Phase 3 applied simulation, which has
not yet been completed.

**Impact**: The Phase 2 projection cannot distinguish between scenarios where
the engine would improve recall from scenarios where it would degrade it.

---

## Next Evidence Gates

The following must be satisfied before any activation decision can be made:

1. **Production replay corpus** — a representative set of real production
   traffic scenarios captured, sanitised, and incorporated into the scenario
   set.
2. **Shadow telemetry review process** — a documented, periodic review
   process for shadow-mode decision telemetry (distribution, confidence,
   non-skip action rate).
3. **Rollback design** — a written, tested rollback procedure that covers
   the active-mode window and preserves audit visibility.
4. **Active-mode controller design** — a technical design for the controller
   mutation wiring including rollback, audit table visibility, and kill switch.
5. **Owner approval before any activation** — explicit, documented project-owner
   approval covering the specific target stage and acceptance criteria.

---

## Required Next Choices

The project owner must decide one of:

### Option A — Remain in shadow indefinitely (default)

Continue running the engine in `shadow` mode to accumulate telemetry and
observe shadow-decision patterns without any memory mutation. Run the full
benchmark suite periodically and refresh the shadow-comparison report.

**When this is appropriate**: when the evidence base is not yet strong enough
to justify the risk of a future active-mode canary, or when other product
priorities take precedence.

### Option B — Collect stronger evidence before planning activation

Pursue targeted improvements to the evidence package:

1. **Expand Recall Quality scenario set** beyond 9 adaptive-depth scenarios
   to increase synthetic coverage and denominator strength.
2. **Design and run a production baseline delta capture** against a
   representative production storage snapshot, with appropriate data
   handling and redaction controls.
3. **Instrument shadow-mode telemetry** for periodic owner review
   (decision distribution, confidence histograms, non-skip action rate).
4. **Scope the active-mode controller wiring** and write a technical plan
   covering rollback, audit table, and kill switch.

**When this is appropriate**: when the project owner wants a richer evidence
base before making any activation decision.

### Option C — Plan an internal active canary (Stage 2)

Initiate planning for a Stage 2 internal active canary. This requires:

- A written canary scope and acceptance criteria.
- A tested rollback procedure.
- A telemetry review process for the canary window.
- Explicit project-owner approval for the canary scope.

**When this is appropriate**: when the evidence is sufficient for the project
owner to take on the risk of a controlled, scoped mutation experiment in a
non-production environment.

---

## Out of Scope

This document does not include, and this work does not authorize:

- **Mode flip** — no `active` mode is being enabled or planned by this document.
- **Code activation** — no behaviour changes are being made.
- **Live provider evaluation** — no live provider calls for benchmark purposes.
- **Production traffic capture** — no real user inputs are being used in any
  evaluation methodology described here.
- **Auto-promotion** — no automatic activation regardless of benchmark results.
- **Recall-quality LLM judging** — all Recall Quality metrics are deterministic
  or storage-verified; no provider call is made to judge recall quality.

---

## Document Relationship

| Document | Role |
|---|---|
| [comparison-methodology.md](./comparison-methodology.md) | Defines the Balanced Score methodology and what "better than production" means |
| [delta-criteria.md](./delta-criteria.md) | Defines the delta classification criteria (better/same/worse/inconclusive) and why `delta.status="counterfactual"` is the correct Phase 2 standing until Phase 3 measured quality-impact gates are passed |
| [activation-plan.md](../activation-plan.md) | Describes the staged rollout path from `off` → `shadow` → `active` |
| This document | Current evidence summary and owner decision briefing |

The comparison methodology describes the methodology. The activation plan
describes the staged rollout. This document summarises what the evidence says
today and what choices the owner faces.

---

## Quick Reference

| Question | Answer |
|---|---|
| What does `promotionEligible=true` mean? | The evidence package is complete and the engine is eligible for owner review — not approved, not activated. |
| Does a passing shadow comparison activate the engine? | No. Active mode requires explicit project-owner approval. |
| What is the biggest evidence gap? | No production baseline comparative delta — `delta.status="counterfactual"` (Phase 2 projection only) — means the comparative evidence is synthetic-only. |
| Are Recall Quality denominators live traffic? | No. They are 9 hand-curated synthetic adaptive-depth scenarios. |
| Can the engine be activated today? | No. No owner approval has been issued. Active-mode controller wiring is not implemented. |
| What is the next owner decision? | Choose: remain in shadow, collect stronger evidence, or plan a Stage 2 canary. |
| What is the current Phase 2 benchmark result? | better: 8, same: 6, worse: 0 (benchmark-internal synthetic classifications only; not production evidence). |
| Is `recallHitRateDelta` populated? | No. It remains `null` in Phase 2. Measured recall quality delta requires Phase 3 applied simulation. |
| What is Phase 2? | Counterfactual projection — comparing production outcome vs. engine decision without applying engine decisions to any store. |
| What is Phase 3? | Offline applied simulation in cloned temp storage — engine decisions ARE applied to a cloned store and recall quality is measured against a baseline. |
