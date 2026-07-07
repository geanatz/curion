# Memory Decision Engine — Activation Plan

This document describes the safe activation path for Curion's Memory Decision
Engine, from the current default state through to a potential future
shadow→active transition. It is a living operational runbook, not a
feature announcement.

---

## Current State

**The engine is off by default.**

| `CURION_REMEMBER_DECISION_MODE` | Behaviour |
|---|---|
| _(unset)_ / `off` | Engine is skipped entirely. No evidence build, no HTTP call, no decision recorded. |
| `shadow` | Engine runs. Structured decision is logged at `debug` level. **No persisted memory, public output, `structuredContent`, or MCP tool schema is altered.** |
| `active` | **Phase 1: downgraded to `shadow` automatically.** The engine does not mutate anything. Active mode is reserved for a future phase. |

The default is `off`. Existing deployments, tests, and the contract test
continue to behave byte-for-byte identically to pre-engine releases.

---

## Purpose

The activation plan exists so that:

1. **The project owner retains explicit control** over any mode that could
   alter production behaviour — including future `active` mode.
2. **Evidence gates must be met** before any stage is considered passed.
3. **No mode flip happens accidentally** — every transition requires a
   deliberate, reviewed action.
4. **Shadow telemetry is observable** before any mutation is permitted.

This plan does **not** activate `active` mode. It describes the path that
would be followed if and when the project owner approves it.

---

## Staged Rollout

```
off ──────► shadow ──────► internal active canary ──────► broader use
(default)  (any operator)  (project owner approval)     (project owner approval)
```

### Stage 0 — off (current default)

No engine invocation. No HTTP calls. No decision telemetry.

**How to enable shadow:** set `CURION_REMEMBER_DECISION_MODE=shadow`.
The controller begins logging shadow decisions at `debug` level. No other
behaviour changes.

### Stage 1 — shadow

The engine runs on every `remember` call (after the deterministic safety
pre-check) and emits a structured decision. The decision is observed in
logs but **never applied to persisted memory or the public wire**.

**Gate before Stage 2:** Shadow mode has been running for a defined
observation window with:
- No unresolved safety regressions (shadow decisions are logged; any
  `action != skip` decision that would have caused a different outcome
  if applied must be investigated and resolved or formally accepted).
- Passing benchmark suite:
  - `npm run benchmark:decision-policy-evaluation` (scripted, no-network)
  - `npm run benchmark:recall-policy-evaluation` (scripted, no-network)
  - `npm run benchmark:retrieval:adaptive-depth` (scripted, no-network)
  - `npm run benchmark:long-horizon-memory-evaluation` (scripted, no-network)
- Shadow telemetry is being collected and reviewed periodically.

### Stage 2 — internal active canary

The engine output begins to be **applied selectively** in a
controlled internal environment (not production user-facing traffic).
This is the first stage where the engine can alter memory state.

**Additional gates before Stage 2:**
- Project owner explicitly approves the Stage 2 canary scope.
- Rollback procedure (see below) has been tested.
- Telemetry dashboards or log-review process is in place for the
  canary window.

**Kill switch is active.** At any signal of regression, `active` mode is
discontinued and the system returns to `shadow` or `off`.

### Stage 3 — broader use

`active` mode is enabled for broader use. This is a **project owner
decision only** and requires:
- Stage 2 canary passed all gates.
- All benchmarks passing on the target configuration.
- Rollback procedure documented and tested.
- User-facing impact understood and formally accepted.

---

## Telemetry and Metrics to Watch

Use the existing benchmark categories and debug-log vocabulary as
observability anchors.

### Shadow-mode observability

With `CURION_LOG_LEVEL=debug`, every `remember` call in shadow mode logs:

```
remember shadow decision: action=... reason=... confidence=...
supersededIds=... conflictsWithIds=... redundantWithIds=...
provider=... fallback=... httpCalls=...
```

Review for:
- **`action` distribution** — `skip`, `supersede`, `invalidate`,
  `conflict`, `redundant`, etc. A spike in non-`skip` actions in shadow
  mode is the leading indicator that active mode would change outcomes.
- **`confidence`** — low-confidence decisions warrant human review
  before active-mode application.
- **`supersededIds` / `conflictsWithIds` / `redundantWithIds`** — non-empty
  id lists indicate the engine found relationships the deterministic path
  did not act on. In shadow mode these are traces; in active mode they
  would become state transitions.
- **Error kinds** (`adapter failure kind=...`) — any spike in adapter
  failures should be investigated before advancing stages.

### Benchmark categories relevant to activation

| Benchmark | What it tells you |
|---|---|
| `decision-policy-evaluation` | Engine produces well-formed, expected decisions on curated scenarios. A pass means the adapter is stable and the vocabulary is understood. |
| `recall-policy-evaluation` | Recall-side decision vocabulary is stable. Passing means the recall controller is not disturbed by decision-engine changes. |
| `retrieval:adaptive-depth` | Adaptive-depth recall behaviour is preserved. Active-mode changes must not regress recall quality. |
| `long-horizon-memory-evaluation` | Storage lifecycle seams are correct. Critical before any active-mode mutation is applied. |

Run all benchmarks before any stage advance. A regression in any gate
is a hold point.

---

## Rollback and Kill Switch

### Returning to shadow or off

At any time, the operator can restore the safe state:

```sh
# Return to shadow (engine observes, does not mutate)
export CURION_REMEMBER_DECISION_MODE=shadow

# Return to off (engine fully disabled)
export CURION_REMEMBER_DECISION_MODE=off
```

A process restart is required for the env var change to take effect.

### What rollback preserves

- **Persisted memory** is not altered by rollback. Shadow mode never
  mutates, so returning from `active` → `shadow` or `active` → `off`
  does not undo any memory changes made during the active window.
- **Trace artifacts** in `.curion/trace.sqlite` are preserved.
- **Benchmark artifacts** in `.curion/benchmark/` are gitignored but
  preserved locally.
- **Debug logs** (if captured to a log sink) retain the full decision
  trace for the window.

### What rollback does not undo

If `active` mode made state transitions (e.g. superseded, invalidated,
conflict-linked memories), those transitions are persistent storage
changes. The rollback stops further mutations but does not revert the
store. Use the `memory_transitions` audit table to audit what changed
during an active window.

---

## Approval Boundary

**Only the project owner can approve any shadow→active transition.**

This is true regardless of benchmark pass rates, shadow telemetry
cleanliness, or internal canary success. The decision to move beyond
shadow mode — into a state where the engine can alter memory — is a
product-level choice that requires explicit, documented sign-off.

Approval should cover:
- Which stage is approved.
- What the acceptance criteria are for the window.
- Who can authorize rollback.
- How telemetry will be reviewed.

---

## Out of Scope

This activation plan does **not** include:

- **Code changes** — no behaviour is being changed by this document.
- **Mode flip** — no `active` mode is being enabled.
- **Production activation** — the engine remains in `off` or `shadow`.
- **Baseline externalization** — `FROZEN_TRANSFER_BASELINES` remains
  deferred benchmark-hygiene work. It is a separate concern and is not
  solved by or blocking this activation plan.
- **User-facing rollout** — Stage 3 broader use is documented for
  completeness but is not approved or imminent.

---

## Follow-Up Work

The following items are related to the activation path but are
separate workstreams:

1. **`FROZEN_TRANSFER_BASELINES` externalization design note** — benchmark
   hygiene work deferred. Keep this separate from the activation
   playbook; it does not gate any stage.

2. **Balanced-Score comparison methodology** — the shadow-comparison
   methodology that defines "better than production" is documented in
   [docs/decision-engine/comparison-methodology.md](decision-engine/comparison-methodology.md).
   It is complementary to this activation plan: the activation plan
   describes the staged rollout, while the comparison methodology
   describes how to evaluate whether the engine is safe and beneficial
   to promote. It does not activate any mode or change any code.

3. **Promotion readiness briefing** — before any Stage 2 approval, the
   project owner should review the current evidence state documented in
   [docs/decision-engine/promotion-readiness.md](decision-engine/promotion-readiness.md).
   Key open gaps for Stage 2 readiness: `delta.status="future"` (no
   production baseline comparative delta), `coverageComplete` requirements
   for Recall Quality, and the absence of active-mode controller wiring.
   The readiness briefing does not approve activation; it summarises what
   evidence exists and what choices the owner faces.

4. **Active-mode controller-side mutation wiring** — when `active` mode
   is approved, the controller must be extended to apply engine decisions
   as state transitions. This requires guardrails (rollback, audit table
   visibility, kill switch) and is not yet implemented. Additionally,
   `src/decision/policy.ts` must be updated to allow `mode: "active"`
   instead of downgrading to `shadow`. Both the policy gate and the
   engine-driven mutation wiring with guardrails are required before any
   active rollout.

5. **Fresh benchmark run before activation** — run the full benchmark
   suite (`decision-policy`, `recall-policy`, `adaptive-depth`,
   `long-horizon-memory`) in the target environment before any stage
   advance. Use the artifacts as evidence for the approval gate.

---

## Quick Reference

| Question | Answer |
|---|---|
| What is the current default mode? | `off` — engine is fully disabled. |
| How do I enable shadow mode? | `export CURION_REMEMBER_DECISION_MODE=shadow`; restart the process. |
| Does shadow mode change any memory? | No. It only logs a structured decision. |
| Can I accidentally enable active mode? | No. Phase 1 downgrades `active` to `shadow`. |
| Who approves shadow→active? | Project owner only, with documented evidence gates. |
| Does this document flip any mode? | No. |
| Does this document change code? | No. |
| What benchmarks are relevant? | `decision-policy-evaluation`, `recall-policy-evaluation`, `adaptive-depth`, `long-horizon-memory-evaluation`. |
| Where is shadow telemetry visible? | `CURION_LOG_LEVEL=debug` output; look for `remember shadow decision:` lines. |
| What is `FROZEN_TRANSFER_BASELINES`? | Deferred benchmark hygiene. Not solved here. Not a blocker for activation. |
