# Memory Decision Engine — Production Replay Corpus Design

This document defines the design for the production replay corpus: its purpose,
scope, data governance rules, schema, methodology, and required evidence
outputs. It is a **design and governance document only**. It does not implement
any replay harness, does not add corpus data, does not authorise any production
data to enter the evaluation pipeline, and does not change code behaviour.

The Memory Decision Engine remains in `off` or `shadow` mode. Replay corpus
work produces offline evidence only; it does not constitute activation proof.

---

## Purpose

The production replay corpus is a curated set of inputs representative of
real production traffic, intended to evaluate the Memory Decision Engine
against authentic user behaviour patterns that synthetic scenario sets cannot
fully capture.

Synthetic scenario sets (Phase 3 applied simulation scenarios) exercise known
recall paths and adapter decision vocabulary under controlled conditions. They
do not capture:

- The distribution shape of real user inputs (query length, topic frequency,
  temporal clustering).
- Adversarial or unusual input patterns that production traffic surfaces.
- Edge cases in multi-turn memory state that synthetic scenarios design around
  rather than discover.
- Real-world redaction and privacy patterns that only appear in genuine user
  content.

The replay corpus provides a higher-fidelity evaluation surface without
touching production state or live traffic. Its evidence supplements,
rather than replaces, the synthetic scenario set.

---

## How Replay Differs from Synthetic Phase 3 Scenarios

| Dimension | Synthetic Phase 3 Scenarios | Production Replay Corpus |
|---|---|---|
| **Source** | Manually authored; designed to exercise known recall paths | Derived from production traffic (after sanitisation); captures authentic distribution |
| **Coverage** | Targeted — fills known scenario gaps | Statistical — reflects real traffic distribution |
| **Ground truth** | Pre-labelled by scenario author | Labelled via ground-truth process (see Ground-Truth Labelling) |
| **Privacy risk** | None — no real user content | Requires sanitisation and redaction before ingestion |
| **Approval required** | None beyond scenario authorship | Explicit project-owner approval before sanitised production data enters |
| **Status in evidence chain** | Validated; used in Phase 3 applied simulation | Deferred — pending privacy approval and redaction review |
| **Engine activation proof** | No — offline simulation only | No — offline evidence only regardless of source |

Phase 3 applied simulation using synthetic scenarios can proceed independently.
The production replay corpus does not gate or replace Phase 3. Both are
parallel evidence tracks that together provide higher confidence than either
alone.

---

## Allowed Corpus Sources

### 1. Synthetic-Proxy

Synthetic-proxy items are manually authored inputs that approximate the
structure and distribution of production inputs without containing any real
user content. They are authored by the evaluation team with knowledge of the
production input domain.

**Status:** Allowed from project start. No approval required.

**Examples:**
- A remembered fact that resembles a typical user-provided installation
  instruction, authored by the team to match the observed format of such
  inputs.
- A query that resembles a typical user recall request, authored to match
  the distribution of production query shapes.

### 2. Manual-Curated

Manual-curated items are real production inputs (or close derivatives) that
have been manually reviewed, redacted, and approved by a human before being
added to the corpus. They carry a documented approval trail.

**Status:** Allowed from project start with documented review and approval
by the evaluation team.

**Requirements:**
- A human reviewer has verified the item contains no secrets, credentials,
  personal identifiers, or private user text.
- The approval is documented in the corpus metadata.
- The item is labelled with its review status and reviewer identity.

### 3. Sanitised-Production (Deferred — Requires Explicit Approval)

Sanitised-production items are real production inputs that have been
processed through a redaction pipeline and reviewed through the privacy
approval process before being added to the corpus.

**Status:** Not permitted until a formal privacy/redaction approval process
exists and explicit project-owner approval is issued covering the specific
data handling and redaction controls.

**When this source becomes available:** This document defines the required
approval gates (see Approval Gates). Until those gates are passed, no
sanitised-production items may enter the corpus under any circumstances.
This is not a time limitation — it is a governance requirement that remains
in force until the approval process is established.

---

## Forbidden Data

The following data types are prohibited from the replay corpus under all
circumstances, regardless of apparent anonymisation or redaction:

- **Raw private user text** — unredacted text from real user interactions,
  including memory content, queries, or recall inputs.
- **Secrets** — API keys, tokens, connection strings, encryption keys, or
  any credential that grants access to external systems.
- **Credentials** — usernames, passwords, API tokens, session tokens, or
  authentication artefacts of any kind.
- **Personal identifiers** — names, email addresses, phone numbers, user IDs,
  or any information that identifies or could be used to identify a specific
  individual.
- **Unreviewed production dumps** — snapshots of production memory state,
  trace logs, or traffic captures that have not been reviewed and approved
  through the privacy/redaction process.
- **Any data containing PII** — any item that has not passed the redaction
  and review requirements, regardless of source.

If any forbidden data is discovered in the corpus, it must be removed
immediately and the discovery documented. The corpus must not be used for
any replay evaluation until the item is removed and the scope of exposure
is assessed.

---

## Corpus Item Schema

Each corpus item is a JSON object with a stable, content-independent label
set. Production database identifiers are never used as primary keys.

```json
{
  "corpusItemId": "string",
  "corpusItemVersion": "string",
  "source": "synthetic-proxy | manual-curated | sanitized-production",
  "addedAt": "ISO timestamp",
  "addedBy": "string (reviewer identity or 'synthetic-author')",
  "reviewStatus": "approved | pending | rejected",
  "reviewer": "string | null",
  "input": {
    "type": "remember | recall-query",
    "textHash": "string (stable one-way hash of raw input text)",
    "textRedacted": "string (redacted input text, or null if synthetic-proxy)"
  },
  "groundTruth": {
    "labeler": "string",
    "labeledAt": "ISO timestamp",
    "expectedAction": "store | no_op | supersede | invalidate | flag_redundant | flag_conflict | reject",
    "expectedRationale": "string",
    "safetyRelevant": "boolean",
    "privacyRelevant": "boolean",
    "confidence": "high | medium | low"
  },
  "replayStatus": "pending | completed | skipped",
  "replayResult": {
    "runAt": "ISO timestamp | null",
    "engineAction": "string | null",
    "engineRationale": "string | null",
    "actionMatchesGroundTruth": "boolean | null",
    "safetyAssertionPassed": "boolean | null"
  }
}
```

**Stability guarantee:** `corpusItemId` is a content-derived identifier
(generated from the redacted text hash and item type). It does not contain
any production database ID, user identifier, or timestamp that could link
the item to a specific production session or user.

**`textHash` vs `textRedacted`:** For synthetic-proxy items, `textRedacted`
contains the authored input text and `textHash` is derived from it. For
sanitised-production items, `textRedacted` contains the redacted text and
`textHash` is derived from the original raw text before redaction. This
ensures the hash is stable across redaction versions while the redacted text
is safe to log.

---

## Privacy and Redaction Rules

### Core Principles

1. **No raw production data enters the corpus without review.** Every item
   added from production traffic requires a documented privacy review.
2. **Redaction is irreversible for corpus purposes.** Redacted text stored in
   the corpus is the only form used for replay. The original raw text is not
   retained alongside the corpus item.
3. **Hash traceability requires separate infrastructure.** If hash
   traceability back to production logs is needed for audit purposes, it
   must be handled by a separate, access-controlled system outside the
   corpus pipeline. The corpus itself never stores the mapping from hash to
   raw text.
4. **Sanitised-production items require a separate approval event.** The
   existence of a redaction pipeline does not authorise production data to
   enter the corpus. A formal project-owner approval covering the specific
   data handling controls is required separately.

### Redaction Procedure

For any production-derived input:

1. **Strip personal identifiers** — names, email addresses, phone numbers,
   user IDs, session IDs, IP addresses.
2. **Strip secrets and credentials** — any value that could authenticate or
   authorise access to an external system.
3. **Strip precise timestamps** — replace with relative time or generic
   temporal anchor ("recently", "last week").
4. **Generalise specific facts** — replace specific project names, system
   identifiers, or unique values with generic equivalents while preserving
   the structural and semantic properties relevant to the replay scenario.
5. **Verify no residual PII** — a human reviewer confirms the redacted text
   contains no information that could identify a specific individual or
   expose a private relationship.
6. **Log the review** — reviewer identity and timestamp recorded in the
   corpus item metadata.

---

## Ground-Truth Labelling Process

Ground-truth labels define the expected engine behaviour for each corpus
item. They are produced by a human labeler with knowledge of the Memory
Decision Engine's goals and the specific scenario.

### Labelling Requirements

- **Labeler qualifications:** The labeler understands the engine's decision
  vocabulary, recall goals, and safety requirements. Labelers are members
  of the evaluation team, not external contributors.
- **Independence:** The labeler producing ground truth is independent of
  the engine implementation team where possible.
- **Documentation:** The labeler's rationale is recorded in
  `groundTruth.expectedRationale` for each item. This supports later
  review of labelling quality.
- **Confidence rating:** Each label carries a confidence rating
  (`high | medium | low`). Items with `low` confidence are flagged for
  secondary review before entering the corpus.

### Labelling Criteria

| Criterion | Question |
|---|---|
| Expected action | What action should the engine emit for this input? |
| Safety relevance | Does this input have safety implications the engine should handle? |
| Privacy relevance | Does this input contain or imply private information the engine should protect? |
| Rationale | Why is the expected action correct given the engine's goals? |

### Secondary Review for Low-Confidence Labels

Items with `groundTruth.confidence: "low"` require a second independent
labeler to review and either confirm or correct the label. Disagreements
are resolved by discussion; the final label is recorded with both
reviewer identities.

---

## Minimum Initial Corpus Size and Diversity Targets

The initial corpus is a **proof-of-feasibility set**, not a statistically
representative production sample. The targets below are minimums to
establish the pipeline and validate the methodology.

| Dimension | Minimum Target |
|---|---|
| Total corpus items | 20 |
| `remember` items | ≥ 10 |
| `recall-query` items | ≥ 10 |
| Synthetic-proxy items | ≥ 10 |
| Manual-curated items | ≥ 5 |
| Sanitised-production items | 0 (deferred) |
| Items with ground truth | 100 % |
| Items with secondary review (low-confidence) | 100 % of low-confidence items |
| Safety-relevant items (ground truth) | ≥ 3 |
| Diversity of input topics | ≥ 5 distinct topic categories |

**Diversity target rationale:** The corpus must cover enough variety to
validate that the replay pipeline operates correctly across different
input types, not just the most common cases. Topic diversity ensures
the replay is not overfit to a single category of user input.

**Sanitised-production deferred:** No sanitised-production items count
toward the minimum initial size. The initial corpus uses only
synthetic-proxy and manual-curated items. This ensures the pipeline is
validated before any production data is introduced.

---

## Offline Replay Methodology

### What Offline Means

Offline replay processes corpus items through the engine in an isolated
environment. The engine processes each item and emits a structured decision.
That decision is compared against the ground-truth label to produce a
per-item result. No engine decision is applied to persistent memory state,
no MCP tool schema is altered, and no production system is contacted.

### Replay Pipeline

1. **Corpus load** — Load the current corpus item set. Verify each item has
   a complete schema (all required fields present, all required approvals
   documented).
2. **Run engine in replay mode** — For each item, run the engine against the
   `input.textRedacted` value in replay mode. Record the engine's emitted
   action, rationale, and confidence.
3. **Safety assertion check** — Run the safety pre-checks against the input.
   Record whether the safety assertion passes or fails.
4. **Compare to ground truth** — Compare `replayResult.engineAction` against
   `groundTruth.expectedAction`. Record whether they match.
5. **Aggregate metrics** — Compute the required metrics (see Required
   Metrics).
6. **Produce replay report** — Write the replay report artifact (see
   Artifact and Report Expectations).
7. **No production mutation** — The replay run leaves all production systems
   untouched. It operates entirely in isolated temp storage or read-only.

### Replay vs Shadow-Comparison Harness

The replay pipeline is **not** the same as the shadow-comparison harness:

- The shadow-comparison harness runs the production path and engine path
  side-by-side on the same scenario set and produces a comparative delta.
- The replay pipeline runs the engine against the corpus item set and
  produces a ground-truth comparison against pre-labelled expected
  behaviour.

Both produce evidence. The replay pipeline adds corpus-based coverage
to the synthetic-scenario coverage already produced by the
shadow-comparison harness.

---

## Required Metrics

Replay evaluation produces metrics across four independent dimensions.
All metrics are computed from the replay run against the corpus.

### Safety Metrics

| Metric | Description | Gate |
|---|---|---|
| `safetyAssertionPassRate` | Fraction of corpus items where the safety pre-check outcome matches the engine's safety-relevant decision | Must be 100 % |
| `dangerousContentHandledRate` | Fraction of safety-relevant items where engine emits `skip` or equivalent safe action | Must be 100 % |
| `privacyViolationRate` | Fraction of privacy-relevant items where engine does not expose a private-record relationship | Must be 0 % |
| `rejectedItemCount` | Count of items where engine emits `reject` | Monitor only |
| `safetyAdapterFailureRate` | Fraction of replay runs where the safety adapter returned an error | Must be 0 % |

### Memory Lifecycle Metrics

| Metric | Description | Signal |
|---|---|---|
| `actionDistribution` | Count and fraction of each engine action in the replay run | Monitors decision diversity and balance |
| `actionMatchesGroundTruthRate` | Fraction of items where `engineAction === expectedAction` | Higher is better; informational only |
| `lowConfidenceActionRate` | Fraction of items where engine confidence is `low` | Investigate if > 20 % |
| `noOpRate` | Fraction of `remember` items where engine emits `no_op` | Monitor — high rate may indicate over-suppression |

### Recall-Quality Metrics

| Metric | Description | Signal |
|---|---|---|
| `topKMatchRate` | Fraction of recall-query items where the engine-processed memory produces the same top-K result as the ground-truth expected state | Must be ≥ production baseline (when baseline available) |
| `currentTruthMatchRate` | Fraction of temporal recall queries where current fact ranks first | Must be ≥ production baseline (when baseline available) |
| `noAnswerTnr` | True-negative rate on no-answer queries | Must be ≥ production baseline (when baseline available) |

**Recall-quality note:** Recall quality metrics (source match, rank-1 match,
current truth match, no-answer TNR) are computed from scripted engine responses
and labeled ground-truth in the replay pipeline. Metrics reflect measurement
infrastructure readiness; they do not constitute evidence of production quality.
Full quality measurement with live retrieval requires Phase 3 applied simulation.

### Delta Comparison Metrics

| Metric | Description | Signal |
|---|---|---|
| `decisionDivergenceRate` | Fraction of items where engine action differs from ground-truth expected action | Informational — divergence alone is not a verdict |
| `deltaClassificationRate` | Distribution of `matches | diverges` across corpus | Shows how often engine aligns with labeler expectation |
| `inconclusiveRate` | Fraction of items where no clear match or divergence can be determined | Monitor — high rate may indicate labelling quality issues |

**Delta comparison note:** These metrics compare the engine to ground-truth
labels, not to a production baseline. They do not constitute evidence of
production superiority. They validate that the engine behaves as expected
on representative inputs.

---

## Artifact and Report Expectations

### Replay Report Artifact

Replay output is written to `.curion/benchmark/` following the existing
`writeTimestampedJsonArtifact` convention. Artifact prefix:
`replay-corpus-<timestamp>.json`.

```json
{
  "generatedAt": "<ISO timestamp>",
  "corpusVersion": "<version string>",
  "evaluationMode": "replay-corpus",
  "corpusSize": 0,
  "corpusBreakdown": {
    "syntheticProxy": 0,
    "manualCurated": 0,
    "sanitizedProduction": 0
  },
  "safety": {
    "safetyAssertionPassRate": 0.0,
    "dangerousContentHandledRate": 0.0,
    "privacyViolationRate": 0.0,
    "rejectedItemCount": 0,
    "safetyAdapterFailureRate": 0.0
  },
  "memoryLifecycle": {
    "actionDistribution": {},
    "actionMatchesGroundTruthRate": 0.0,
    "lowConfidenceActionRate": 0.0,
    "noOpRate": 0.0
  },
  "recallQuality": {
    "sourceMatchRate": 1.0,
    "rank1MatchRate": 1.0,
    "currentTruthMatchRate": 1.0,
    "noAnswerTnr": 1.0,
    "usefulMemoryLossRate": 0.0,
    "staleMemoryExposureRate": 0.0,
    "labeledRecallQueryCount": 16,
    "noAnswerExpectedCount": 6,
    "note": "Recall quality metrics computed from labeled recall-query items. Scripted engine returns expected labels deterministically. Metrics reflect measurement infrastructure readiness, not engine quality."
  },
  "deltaComparison": {
    "decisionDivergenceRate": 0.0,
    "deltaClassificationRate": { "matches": 0, "diverges": 0 },
    "inconclusiveRate": 0.0
  },
  "limitations": [
    "Replay corpus uses a proof-of-feasibility set only. Minimum diversity targets are met but this is not a statistically representative production sample.",
    "Recall quality metrics are computed from scripted engine responses and labeled ground-truth. Metrics reflect measurement infrastructure readiness, not engine quality. Full quality measurement with live retrieval requires Phase 3 applied simulation.",
    "Replaying synthetic-proxy and manual-curated items only. Sanitised-production items are deferred until privacy/redaction approval process exists.",
    "Replay remains offline evidence only. It does not constitute proof of production activation fitness."
  ]
}
```

### Report Expectations

A replay report must accompany any corpus-based evidence submitted for
promotion review. The report must include:

1. **Corpus provenance table** — item count by source type, review status,
   and labelling completeness.
2. **Safety summary** — pass/fail against each safety gate, with any
   failures itemised.
3. **Action distribution** — breakdown of engine actions across the corpus,
   with ground-truth comparison.
4. **Divergence log** — for each item where `actionMatchesGroundTruth` is
   `false`, a one-line reason for the divergence and the labeler's
   expected action.
5. **Limitations statement** — explicit confirmation that the corpus is
   proof-of-feasibility only, not statistically representative, and that
   recall quality metrics are computed as offline scripted measurement infrastructure; production-quality/live retrieval conclusions remain out of scope.

---

## Approval Gates Before Production Data Is Used

No sanitised-production data may enter the corpus until all of the following
gates have been passed. These are governance gates, not technical gates.
They require documented evidence of completion.

### Gate 1 — Privacy/Redaction Process Defined

A written redaction process exists covering:

- How production inputs are captured and isolated from production systems.
- What fields are stripped and how.
- How the redacted text is verified to be free of PII, secrets, and
  credentials.
- Who is authorised to perform and approve redaction.
- How the mapping from raw text to redacted text is controlled and
  audited.

**Evidence required:** The written process document, reviewed and approved
by a project owner.

### Gate 2 — Replay Pipeline Validated

The replay pipeline has been validated using synthetic-proxy and
manual-curated items. The pipeline produces consistent results with no
errors on a corpus of at least the minimum initial size.

**Evidence required:** A replay report covering the minimum initial corpus
with all metrics populated and no safety failures.

### Gate 3 — Project-Owner Approval for Production Data

A project owner has issued explicit, documented approval for production
data to be processed through the redaction pipeline and added to the
corpus. The approval covers:

- The specific data handling controls described in the redaction process.
- The scope of production data permitted (which system, which time period,
  which data types).
- Any restrictions on the use of the resulting corpus items.
- The review and audit requirements that continue to apply.

**Evidence required:** The approval document, signed by a project owner,
stored alongside the corpus.

### Gate 4 — Ongoing Compliance Check

Before any replay run that includes sanitised-production items, a
compliance check confirms:

- The redaction pipeline has not been modified since the last approved run.
- All sanitised-production items in the corpus have a current approval on
  file.
- No forbidden data has been discovered in the corpus since the last check.

**Evidence required:** A signed compliance check record for each replay
run that includes sanitised-production items.

---

## Limitations

The production replay corpus has the following known limitations. These
are accepted constraints, not implementation gaps.

### Replay Is Offline Evidence, Not Activation Proof

Replay corpus evaluation produces evidence about how the engine behaves on
representative inputs. It does not prove that activating the engine in
production will produce the same outcomes. Activation requires a separate
approval process with separate evidence requirements.

### Proof-of-Feasibility Set, Not Production Representative

The initial corpus meets minimum diversity targets but is not a
statistically representative sample of production traffic. Conclusions
drawn from corpus-based evidence are constrained to the corpus items
themselves and do not generalise to the full production traffic
distribution.

### Synthetic-Proxy and Manual-Curated Items Only Initially

The initial corpus contains only synthetic-proxy and manual-curated items.
Sanitised-production items are deferred. Evidence from the initial corpus
does not include the distribution shape or adversarial patterns that only
appear in real production traffic.

### Recall Quality Metrics in Replay

The replay pipeline computes recall quality metrics from scripted engine
responses and labeled ground-truth. Metrics include source match rate,
rank-1 match rate, current truth match rate, and no-answer TNR. These
reflect measurement infrastructure readiness. Full quality measurement
with live retrieval requires Phase 3 applied simulation.

### No Live Production Baseline Comparison

The replay corpus compares engine behaviour against ground-truth labels,
not against a live production baseline. The delta between engine behaviour
and production behaviour on the same inputs is not measured in the replay
pipeline. That comparison requires the shadow-comparison harness with a
production storage snapshot.

### Sanitised-Production Deferred Pending Approval

No timeline exists for the sanitised-production corpus source. It remains
deferred until the privacy/redaction approval process is established and
project-owner approval is issued. This is a governance constraint, not a
technical constraint.

---

## Out of Scope

This document does not include and does not authorise:

- **Replay harness implementation.** The pipeline described here is a design
  specification, not an implementation.
- **Production data ingestion.** No production data, sanitised or otherwise,
  is authorised to enter any evaluation pipeline by this document.
- **Activation of the Memory Decision Engine.** The engine remains in
  `off` or `shadow` mode. Replay evidence does not change this state.
- **Corpus data.** The minimum initial corpus is a size/diversity target
  only. No corpus data is created by this document.
- **Modification of `evidence/`.** The `evidence/` directory is not modified
  by any corpus work described here.
- **MCP tool changes.** The tool surface (`remember`, `recall`) is unchanged.
- **Memory Decision Engine activation.** No mutation wiring, rollback
  design, or active-mode controller design is included.
- **Live traffic capture.** No live production traffic is captured, routed,
  or analysed for corpus purposes.
- **Changes to production database or state.** No production system is
  modified by any corpus work described here.

---

## Document Relationship

| Document | Role |
|---|---|
| [comparison-methodology.md](./comparison-methodology.md) | Defines the Balanced Score methodology and the three-pillar composite. Replay corpus provides higher-fidelity evidence within that methodology. |
| [delta-criteria.md](./delta-criteria.md) | Defines delta classification criteria (better/same/worse/inconclusive). Replay delta comparison uses the same classification but against ground-truth labels, not production baselines. |
| [promotion-readiness.md](./promotion-readiness.md) | Summarises current evidence gaps and owner decision options. Identifies the production replay corpus as an open evidence gap (Gap 3: no live/shadow production replay). |
| [activation-plan.md](../activation-plan.md) | Describes the staged rollout path. Replay corpus evidence is part of the pre-shadow and pre-active evidence requirements. |

This document establishes the production replay corpus as a defined
evidence track parallel to synthetic Phase 3 scenarios. It provides the
governance framework that must be satisfied before sanitised-production
data can enter any evaluation.

---

## Quick Reference

| Question | Answer |
|---|---|
| What is the production replay corpus? | A curated set of inputs representative of real production traffic, used to evaluate the Memory Decision Engine against authentic user behaviour. |
| What sources are allowed? | Synthetic-proxy and manual-curated now. Sanitised-production only after explicit privacy/redaction approval. |
| What sources are forbidden? | Raw private user text, secrets, credentials, personal identifiers, unreviewed production dumps, any PII. |
| Is production data allowed initially? | No. The initial corpus uses only synthetic-proxy and manual-curated items. Sanitised-production is deferred. |
| Does replay replace Phase 3 synthetic scenarios? | No. Replay is a parallel evidence track that supplements synthetic scenario coverage. |
| What metrics does replay produce? | Safety metrics, memory lifecycle metrics, recall quality metrics (computed from labeled ground-truth), delta comparison metrics. |
| Does replay prove activation fitness? | No. Replay remains offline evidence. It does not constitute proof of production activation fitness. |
| What is required before sanitised-production data can be used? | Four governance gates: privacy/redaction process defined, replay pipeline validated, project-owner approval issued, ongoing compliance check defined. |
| Are corpus item IDs stable? | Yes. `corpusItemId` is content-derived and does not contain production database IDs or user identifiers. |
| What is the minimum initial corpus size? | 20 items total: ≥ 10 `remember`, ≥ 10 `recall-query`, ≥ 10 synthetic-proxy, ≥ 5 manual-curated, 0 sanitised-production. |
| Does this document implement a replay harness? | No. This is a design and governance document only. |
| Does replay use live production traffic? | No. Live production traffic capture is out of scope and is not authorised. |
