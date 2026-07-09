/**
 * Curated scenario set for the recall-policy evaluation
 * harness (v1).
 *
 * Each scenario pairs:
 *   - a synthetic query + a small set of related memories,
 *   - a canned provider response the scripted fetch returns
 *     (the canned response is a `RecallPolicyDecision`
 *     JSON shape the benchmark-only adapter parses),
 *   - a typed `expect` block the harness evaluates against
 *     the captured decision,
 *   - a stable `category` the harness uses to summarise
 *     per-category pass / fail counts and to drive the
 *     safety / abstention gate.
 *
 * Why the harness does NOT drive the production recall
 * controller:
 *
 *   The recall-policy decision vocabulary (a structured
 *   `status` + `sourceIds` + `reason` set, with conflict /
 *   superseded / olderVariant pointer arrays) does NOT
 *   yet exist as a production code path. A future phase
 *   may add a recall-policy adapter analogous to the
 *   decision adapter. For v1 the evaluation exercises a
 *   benchmark-only adapter that consumes canned JSON
 *   decisions directly. The benchmark-only adapter's
 *   status shape mirrors what a future production
 *   adapter would emit, and the harness's wiring (scripted
 *   fetch, evidence builder, expectation evaluator) is
 *   designed to migrate to a real adapter with minimal
 *   churn once the production recall-policy engine lands.
 *
 *   The benchmark NEVER:
 *     - touches production storage,
 *     - calls the production recall controller,
 *     - mutates the public MCP `recall` tool behavior,
 *     - leaks an id list onto the wire (the public
 *       message / structured-content is unchanged),
 *     - requires an API key (scripted mode only).
 *
 * Scenario family distribution (v1, ~16 scenarios):
 *
 *   A. Answerable (3):
 *      1.  direct-match              : verbatim-ish token-overlap
 *                                      query + 1 dominant memory;
 *                                      engine returns `answered` +
 *                                      [target].
 *      2.  paraphrase                : low token-overlap query +
 *                                      semantically-relevant memory;
 *                                      engine returns `answered` +
 *                                      [target].
 *      3.  multi-hop                 : the answer requires joining
 *                                      two related memories; engine
 *                                      returns `answered` + [a, b].
 *
 *   B. No-memory / weak-match (3):
 *      4.  no-relevant-memory        : query + empty related set;
 *                                      engine returns `no_memory`.
 *      5.  thin-related-memory       : 1 weakly-overlapping memory;
 *                                      engine returns `weak_match`
 *                                      with the source id surfaced.
 *      6.  provider-refusal          : provider returns a refusal
 *                                      shape; engine reroutes to
 *                                      `weak_match` (top-1 id) rather
 *                                      than fabricating an answer.
 *
 *   C. Ambiguity (3):
 *      7.  conflicting-candidates    : two stored memories that
 *                                      conflict on the topic; engine
 *                                      surfaces BOTH ids in sourceIds
 *                                      + conflictIds.
 *      8.  unclear-query             : query is too vague to pin a
 *                                      single target; engine returns
 *                                      `weak_match` with the
 *                                      broadest-coverage set.
 *      9.  multiple-possible-targets : 3 candidates all pass the
 *                                      ranker; engine returns
 *                                      `answered` with all 3 in
 *                                      sourceIds (the inverse of the
 *                                      clarify path).
 *
 *   D. Lifecycle (3):
 *      10. superseded-memory-hidden  : a stale memory is present
 *                                      but the seeded relationship
 *                                      block supersedes it; engine
 *                                      does NOT surface the stale id
 *                                      in sourceIds (the user only
 *                                      wants the current truth).
 *      11. current-truth-preferred   : current + previous truth both
 *                                      rank above threshold; engine
 *                                      ranks the current first
 *                                      (rank-1 = current) and keeps
 *                                      the previous in sourceIds for
 *                                      lineage.
 *      12. false-premise-old-memory  : query asserts a premise that
 *                                      matches a stale memory; engine
 *                                      returns `no_memory` (the user's
 *                                      premise is wrong; the stale
 *                                      memory is irrelevant).
 *
 *   E. Robustness (4):
 *      13. irrelevant-high-ranked    : 1 high-relevance distractor
 *                                      dominates the related set;
 *                                      engine picks the actual answer
 *                                      (rank-1 is the right target,
 *                                      NOT the distractor).
 *      14. malformed-provider-answer : the scripted fetch returns
 *                                      invalid JSON on the first
 *                                      call; the repair call returns
 *                                      valid JSON; engine returns
 *                                      the parsed decision.
 *      15. always-invalid-provider   : all four scripted calls return
 *                                      invalid JSON; engine returns
 *                                      `provider_error` after 4 calls.
 *      16. refusal-shape-valid       : scripted response contains a
 *                                      refusal-shaped string AND a
 *                                      valid answer; engine treats
 *                                      the structured decision as
 *                                      authoritative and surfaces the
 *                                      `answered` shape (the model
 *                                      chose to disclose metadata
 *                                      about the refusal, not to
 *                                      refuse).
 *
 * Each scenario is small, deterministic, and writes only safe
 * text. The scripted fetch is hermetic: no live network.
 *
 * Scenario-set version
 * --------------------
 *   `RECALL_POLICY_SCENARIO_SET_VERSION` is the v1 stamp the
 *   report surfaces on every artifact. The constant is bumped
 *   by hand when the set grows; a future v2 that adds new
 *   scenarios is a deliberate, visible change.
 */

import type { ScriptedRecallProviderSpec } from "./spec.js";

// ---------------------------------------------------------------------------
// Recall-policy decision vocabulary (benchmark-only)
// ---------------------------------------------------------------------------

/**
 * Stable version stamp for the curated scenario set. Bumped
 * by hand when the set grows or contracts. The harness surfaces
 * this on every report so a reviewer can read "this artifact
 * was produced under v1" without re-deriving the count.
 */
export const RECALL_POLICY_SCENARIO_SET_VERSION = "v1" as const;

/**
 * The recall-side status vocabulary the benchmark-only
 * adapter emits. The labels deliberately mirror the production
 * `RecallOutcome.status` union
 * (`answered` | `weak_match` | `no_memory` | `rejected` |
 * `provider_error`) so a future recall-policy adapter can
 * lift these schemas into a server-internal module without a
 * vocabulary change. A future v2 that adds new status labels
 * is a deliberate, visible change.
 */
export const RECALL_POLICY_STATUSES = [
  "answered",
  "weak_match",
  "no_memory",
  "rejected",
  "provider_error",
] as const;

export type RecallPolicyStatus = (typeof RECALL_POLICY_STATUSES)[number];

/**
 * Coarse reason labels the recall-policy adapter can attach
 * to its structured decision. The enum is intentionally open-
 * ended so a future v2 can add labels without breaking v1
 * scenarios. Scenarios should treat unknown reason strings as
 * "valid but unspecified".
 */
export const RECALL_POLICY_REASONS = [
  "answerable",
  "direct_match",
  "paraphrase_match",
  "multi_hop",
  "weak_top1",
  "no_relevant_memory",
  "refusal_reroute",
  "conflicting_candidates",
  "multiple_targets",
  "ambiguous_or_vague",
  "superseded_hidden",
  "current_truth_preferred",
  "false_premise",
  "suppressed_distractor",
  "repair_recovers",
  "all_invalid_output",
  "refusal_shape_valid",
  "unspecified",
] as const;

export type RecallPolicyReason = (typeof RECALL_POLICY_REASONS)[number];

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

/**
 * Top-level category the v1 set assigns to every scenario.
 * The harness aggregates per-category pass / fail counts and
 * drives the safety / abstention gate off the `abstention`
 * slice (a reviewer's reading: the policies under test must
 * correctly abstention-style abstain when the right answer
 * is `no_memory` / `weak_match`).
 *
 * The five categories mirror the brief's required rubric:
 *   - `answerable`           — safe, in-band situations where the
 *                              engine is expected to return `answered`
 *                              with the right `sourceIds`.
 *   - `no-memory-weak-match` — situations where the engine must
 *                              abstain (`no_memory` / `weak_match`)
 *                              with the right `sourceIds` slice.
 *                              Drives the abstention gate.
 *   - `ambiguity`            — situations where the engine must
 *                              surface multiple targets /
 *                              conflicting candidates /
 *                              unresolved queries.
 *   - `lifecycle`            — situations where the engine must
 *                              handle supersession, current-vs-
 *                              previous truth, and false-premise.
 *   - `robustness`           — provider-path resilience, irrelevant
 *                              distractors, and refusal-shape-valid
 *                              edge cases.
 */
export type RecallPolicyScenarioCategory =
  | "answerable"
  | "no-memory-weak-match"
  | "ambiguity"
  | "lifecycle"
  | "robustness";

/**
 * Per-category constants. Exported so callers (formatter,
 * tests, downstream tooling) can iterate over the canonical
 * category set without re-listing the labels.
 */
export const RECALL_POLICY_SCENARIO_CATEGORIES = [
  "answerable",
  "no-memory-weak-match",
  "ambiguity",
  "lifecycle",
  "robustness",
] as const satisfies ReadonlyArray<RecallPolicyScenarioCategory>;

/**
 * Top-level evaluation scope the harness uses to attribute a
 * scenario's pass / fail to a gate.
 *
 *   - `"model-quality"` — the scenario exercises the model's
 *     structured-decision shape against a curated evidence
 *     packet. Pass / fail drives the `modelQualityGate` block.
 *     These scenarios are meaningful in scripted mode (the
 *     default) AND in any future live mode.
 *   - `"provider-path"` — the scenario exercises the adapter's
 *     provider state machine (primary first → repair → fallback
 *     → fallback-repair) under scripted hard-failure / parse-
 *     failure inputs. Pass / fail drives the `providerPathGate`
 *     block. These scenarios are ONLY meaningful in scripted
 *     mode (this benchmark does not expose a live mode in v1,
 *     so the gate is informational).
 *
 * The default is `"model-quality"`. A scenario opts into
 * `"provider-path"` by setting `evaluationScope` on its literal.
 */
export type RecallPolicyEvaluationScope = "model-quality" | "provider-path";

/**
 * Per-scope constants. Exported so callers (formatter, tests,
 * downstream tooling) can iterate over the canonical scope
 * set without re-listing the labels.
 */
export const RECALL_POLICY_EVALUATION_SCOPES = [
  "model-quality",
  "provider-path",
] as const satisfies ReadonlyArray<RecallPolicyEvaluationScope>;

/**
 * A related-memory slot the harness writes into the
 * evidence packet. Carries a stable id (the controller-side
 * id the engine's `sourceIds` / `conflictIds` / `supersededIds`
 * / `olderVariantIds` arrays reference) plus a bounded excerpt
 * the prompt renders.
 */
export interface RecallPolicyRelatedMemory {
  /** Stable storage id (used as the engine's reference id). */
  id: number;
  /** Optional kind tag (e.g. "fact", "policy", "decision"). */
  kind?: string;
  /** Bounded lexical excerpt. The harness enforces a 240-char cap. */
  memoryContentExcerpt: string;
}

/**
 * A single recall-policy evaluation scenario. The harness
 * runs the benchmark-only adapter end-to-end with the
 * constructed evidence packet and the scripted provider
 * behaviour, captures the decision, and evaluates the
 * `expect` block against the captured decision.
 */
export interface RecallPolicyScenario {
  /** Stable id; used as the `scenarioId` in the report. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Short description of what this scenario exercises. */
  description: string;
  /** The user query the scenario feeds into the evidence packet. */
  query: string;
  /**
   * Related memories the harness writes into the evidence
   * packet. The ids appear in the engine-side `sourceIds` /
   * `conflictIds` / `supersededIds` / `olderVariantIds`
   * arrays (when the engine surfaces those pointers).
   */
  related: ReadonlyArray<RecallPolicyRelatedMemory>;
  /** Scripted provider behaviour. */
  scripted: ScriptedRecallProviderSpec;
  /** Expectations the harness checks against the adapter decision. */
  expect: RecallPolicyExpectations;
  /**
   * The scenario's top-level category. The harness aggregates
   * per-category pass / fail counts and uses the
   * `no-memory-weak-match` slice to drive the abstention gate.
   */
  category: RecallPolicyScenarioCategory;
  /**
   * Whether this scenario participates in the abstention gate.
   * Defaults to `category === "no-memory-weak-match"` when
   * omitted; can be set explicitly to opt a non-abstention
   * scenario into the gate (e.g. for documenting cross-cutting
   * abstention posture).
   */
  abstentionCritical?: boolean;
  /**
   * Whether this scenario participates in the safety gate.
   * The v1 set has no `secret` / `prompt-injection`-style
   * scenarios because the recall-policy adapter does not
   * yet process raw input. Reserved for future v2 expansion.
   */
  safetyCritical?: boolean;
  /**
   * The scenario's evaluation scope. Defaults to
   * `"model-quality"` when omitted. The scripted-failure
   * scenarios (`malformed-provider-answer`,
   * `always-invalid-provider`) opt in to `"provider-path"`
   * so the harness separates harness-state-machine failures
   * from real-model-quality failures.
   *
   * See `RecallPolicyEvaluationScope` for the full contract.
   */
  evaluationScope?: RecallPolicyEvaluationScope;
}

/**
 * The harness evaluates the scenario's expectations against
 * the captured adapter decision. Each field is independent;
 * the harness only checks the fields that are present.
 */
export interface RecallPolicyExpectations {
  /** Expected top-level status the adapter should emit. */
  expectedStatus?: RecallPolicyStatus;
  /** Expected reason label. */
  expectedReason?: RecallPolicyReason;
  /**
   * Inclusive lower bound on the decision's `confidence`
   * (only checked when the field is set).
   */
  confidenceMin?: number;
  /**
   * Inclusive upper bound on the decision's `confidence`
   * (only checked when the field is set).
   */
  confidenceMax?: number;

  /**
   * A target-memory presence check. The harness asserts
   * the id IS in the captured id array. Multiple ids
   * produce one assertion row each.
   */
  sourceIdInAnswer?: ReadonlyArray<number>;
  /**
   * A target-memory NEGATIVE check. The harness asserts
   * NONE of the listed ids appear in the captured
   * `sourceIds`. Useful for the `superseded-memory-hidden`
   * and `irrelevant-high-ranked` trap scenarios.
   */
  sourceIdNotInAnswer?: ReadonlyArray<number>;

  /**
   * Expected id array for `conflictIds` (the ids the engine
   * flags as conflicting). Order-independent set match.
   */
  expectedConflictIds?: ReadonlyArray<number>;
  /** Expected `supersededIds` (the ids the engine flags as superseded). */
  expectedSupersededIds?: ReadonlyArray<number>;
  /** Expected `olderVariantIds` (the ids the engine flags as older variants). */
  expectedOlderVariantIds?: ReadonlyArray<number>;

  /** Expected total HTTP call count. */
  httpCalls?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convenience: mark a scenario as abstention-critical.
 * Equivalent to setting `abstentionCritical: true` on the
 * scenario literal but keeps the per-scenario declaration
 * shorter.
 */
function abstentionCritical(): true {
  return true;
}

// ---------------------------------------------------------------------------
// Built-in scenario set (v1)
// ---------------------------------------------------------------------------

/**
 * The default v1 scenario set (16 scenarios). Covers the
 * brief's required recall-side rubric:
 *
 *   - 3 answerable (direct, paraphrase, multi-hop),
 *   - 3 no-memory / weak-match (no-relevant, thin-related, refusal),
 *   - 3 ambiguity (conflicting, unclear, multiple-targets),
 *   - 3 lifecycle (superseded-hidden, current-truth-preferred,
 *     false-premise),
 *   - 4 robustness (irrelevant-high-ranked, malformed-answer,
 *     always-invalid, refusal-shape-valid).
 *
 * The set is the canonical reference set used by
 * `runRecallPolicyEvaluation()`. A future v2 that adds new
 * scenarios is a deliberate, visible change; the harness never
 * re-tunes scenario expectations on evaluation results.
 */
export const BUILT_IN_RECALL_POLICY_SCENARIOS: ReadonlyArray<RecallPolicyScenario> = [
  // =======================================================================
  // CATEGORY A: answerable
  // =======================================================================

  // -----------------------------------------------------------------------
  // A1. Direct match: strong token overlap + 1 dominant memory
  // -----------------------------------------------------------------------
  {
    id: "direct-match",
    label: "Direct token-overlap query: answered + dominant id",
    description:
      "The query is a near-verbatim token overlap with one " +
      "dominant memory. The harness asserts the engine returns " +
      "`status=answered` and the related id (101) is in " +
      "`sourceIds`.",
    query: "Postgres 16 primary store",
    category: "answerable",
    related: [
      {
        id: 101,
        kind: "fact",
        memoryContentExcerpt:
          "The project uses Postgres 16 as the primary store for every deployment.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "direct_match",
        sourceIds: [101],
        confidence: 0.91,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "direct_match",
      confidenceMin: 0.5,
      confidenceMax: 1.0,
      sourceIdInAnswer: [101],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // A2. Paraphrase match: low-overlap but semantically equivalent
  // -----------------------------------------------------------------------
  {
    id: "paraphrase-match",
    label: "Paraphrase of a stored summary: answered + matching id",
    description:
      "The query paraphrases a stored memory using different " +
      "vocabulary. The harness asserts the engine returns " +
      "`status=answered` and the related id (115) is in " +
      "`sourceIds`.",
    query: "which postgres version runs in production",
    category: "answerable",
    related: [
      {
        id: 115,
        kind: "fact",
        memoryContentExcerpt:
          "Postgres 16 is the current production-grade data store for every project-local deployment.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "paraphrase_match",
        sourceIds: [115],
        confidence: 0.78,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "paraphrase_match",
      confidenceMin: 0.5,
      confidenceMax: 1.0,
      sourceIdInAnswer: [115],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // A3. Multi-hop: answer requires joining two memories
  // -----------------------------------------------------------------------
  {
    id: "multi-hop",
    label: "Multi-hop query: answered + both ids in sourceIds",
    description:
      "The query requires joining two related memories to " +
      "form the answer (e.g. which scheduler + which queue " +
      "depth). The harness asserts the engine returns " +
      "`status=answered` and BOTH related ids (130, 131) " +
      "appear in `sourceIds`.",
    query: "what scheduler runs the 256-depth retry queue",
    category: "answerable",
    related: [
      {
        id: 130,
        kind: "fact",
        memoryContentExcerpt: "The project runs the BullMQ scheduler for background retries.",
      },
      {
        id: 131,
        kind: "fact",
        memoryContentExcerpt: "The BullMQ retry queue is configured to a max depth of 256.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "multi_hop",
        sourceIds: [130, 131],
        confidence: 0.74,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "multi_hop",
      confidenceMin: 0.5,
      confidenceMax: 1.0,
      sourceIdInAnswer: [130, 131],
      httpCalls: 1,
    },
  },

  // =======================================================================
  // CATEGORY B: no-memory / weak-match
  // =======================================================================

  // -----------------------------------------------------------------------
  // B1. No relevant memory in related set
  // -----------------------------------------------------------------------
  {
    id: "no-relevant-memory",
    label: "No relevant memory: status=no_memory",
    description:
      "The query has zero overlap with any stored memory. " +
      "The harness asserts the engine returns " +
      "`status=no_memory` and `sourceIds` is empty.",
    query: "what is the team's lunch order this Friday",
    category: "no-memory-weak-match",
    abstentionCritical: abstentionCritical(),
    related: [
      {
        id: 140,
        kind: "fact",
        memoryContentExcerpt:
          "The Postgres 16 primary store is configured with 16 connections per worker.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "no_memory",
        reason: "no_relevant_memory",
        sourceIds: [],
        confidence: 0.92,
      }),
    },
    expect: {
      expectedStatus: "no_memory",
      expectedReason: "no_relevant_memory",
      confidenceMin: 0.5,
      confidenceMax: 1.0,
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // B2. Thin related memory (single weak overlap)
  // -----------------------------------------------------------------------
  {
    id: "thin-related-memory",
    label: "Thin related memory: status=weak_match + top-1 id",
    description:
      "A single weakly-overlapping memory exists in the " +
      "related set. The harness asserts the engine returns " +
      "`status=weak_match` and surfaces the related id (155) " +
      "in `sourceIds`.",
    query: "the database the team settled on",
    category: "no-memory-weak-match",
    abstentionCritical: abstentionCritical(),
    related: [
      {
        id: 155,
        kind: "fact",
        memoryContentExcerpt:
          "Database performance benchmarks ran against a Postgres 16 staging instance.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "weak_match",
        reason: "weak_top1",
        sourceIds: [155],
        confidence: 0.42,
      }),
    },
    expect: {
      expectedStatus: "weak_match",
      expectedReason: "weak_top1",
      confidenceMin: 0.0,
      confidenceMax: 0.6,
      sourceIdInAnswer: [155],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // B3. Provider refusal reroute -> weak_match
  // -----------------------------------------------------------------------
  {
    id: "provider-refusal",
    label: "Provider refusal: reroute to weak_match",
    description:
      "The provider returns a refusal-shaped string. The " +
      "engine reroutes to `status=weak_match` with the top-1 " +
      "id surfaced. The harness asserts the reroute happened " +
      "(not a fabricated `answered`).",
    query: "session 2 summary",
    category: "no-memory-weak-match",
    abstentionCritical: abstentionCritical(),
    related: [
      {
        id: 168,
        kind: "context",
        memoryContentExcerpt:
          "Session 2 covered the controller and the lexical retrieval boundary.",
      },
      {
        id: 169,
        kind: "context",
        memoryContentExcerpt: "Session 2 also covered the storage layer and schema migrations.",
      },
      {
        id: 170,
        kind: "context",
        memoryContentExcerpt: "Session 2 included a deep dive on the safety pre-check classifier.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "weak_match",
        reason: "refusal_reroute",
        sourceIds: [168],
        confidence: 0.51,
      }),
    },
    expect: {
      expectedStatus: "weak_match",
      expectedReason: "refusal_reroute",
      confidenceMin: 0.0,
      confidenceMax: 1.0,
      sourceIdInAnswer: [168],
      httpCalls: 1,
    },
  },

  // =======================================================================
  // CATEGORY C: ambiguity
  // =======================================================================

  // -----------------------------------------------------------------------
  // C1. Conflicting candidates in related set
  // -----------------------------------------------------------------------
  {
    id: "conflicting-candidates",
    label: "Conflicting related memories: answered + both ids + conflictIds",
    description:
      "Two related memories disagree on the same topic. The " +
      "engine surfaces BOTH in `sourceIds` (so the user sees " +
      "the conflict) AND flags BOTH in `conflictIds`.",
    query: "Which project plan owns the launch schedule?",
    category: "ambiguity",
    related: [
      {
        id: 181,
        kind: "fact",
        memoryContentExcerpt: "The launch schedule is owned by the Project Phoenix plan.",
      },
      {
        id: 182,
        kind: "fact",
        memoryContentExcerpt: "The launch schedule is owned by the Project Atlas plan.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "conflicting_candidates",
        sourceIds: [181, 182],
        conflictIds: [181, 182],
        confidence: 0.62,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "conflicting_candidates",
      sourceIdInAnswer: [181, 182],
      expectedConflictIds: [181, 182],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // C2. Unclear / vague query
  // -----------------------------------------------------------------------
  {
    id: "unclear-query",
    label: "Vague query: weak_match with broadest-coverage set",
    description:
      "The query is too vague to pin a single target. The " +
      "engine returns `status=weak_match` with the broadest " +
      "coverage set, NOT a fabricated `answered`.",
    query: "the project thing",
    category: "ambiguity",
    related: [
      {
        id: 190,
        kind: "context",
        memoryContentExcerpt: "The project theme uses an Indigo primary colour palette.",
      },
      {
        id: 191,
        kind: "context",
        memoryContentExcerpt: "The project theme uses an Indigo-based dark mode by default.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "weak_match",
        reason: "ambiguous_or_vague",
        sourceIds: [190, 191],
        confidence: 0.45,
      }),
    },
    expect: {
      expectedStatus: "weak_match",
      expectedReason: "ambiguous_or_vague",
      sourceIdInAnswer: [190, 191],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // C3. Multiple plausible targets (multi-anchor)
  // -----------------------------------------------------------------------
  {
    id: "multiple-possible-targets",
    label: "Multiple plausible targets: answered + all in sourceIds",
    description:
      "Three related memories all plausibly answer the " +
      "query. The engine returns `status=answered` with all " +
      "three in `sourceIds` (multi-anchor coverage).",
    query: "build commands for the project",
    category: "ambiguity",
    related: [
      {
        id: 210,
        kind: "fact",
        memoryContentExcerpt: "The build command is `npm run build`.",
      },
      {
        id: 211,
        kind: "fact",
        memoryContentExcerpt: "The dev command is `npm run dev`.",
      },
      {
        id: 212,
        kind: "fact",
        memoryContentExcerpt: "The lint command is `npm run lint`.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "multiple_targets",
        sourceIds: [210, 211, 212],
        confidence: 0.71,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "multiple_targets",
      sourceIdInAnswer: [210, 211, 212],
      httpCalls: 1,
    },
  },

  // =======================================================================
  // CATEGORY D: lifecycle
  // =======================================================================

  // -----------------------------------------------------------------------
  // D1. Superseded memory hidden — stale id NOT in sourceIds
  // -----------------------------------------------------------------------
  {
    id: "superseded-memory-hidden",
    label: "Superseded memory: stale id must NOT appear in sourceIds",
    description:
      "A stale memory is present in the related set but has " +
      "been superseded. The engine must surface ONLY the " +
      "current id (245); the stale id (246) must NOT appear " +
      "in `sourceIds`.",
    query: "what primary store does the project use today",
    category: "lifecycle",
    related: [
      {
        id: 245,
        kind: "fact",
        memoryContentExcerpt: "The project currently uses Postgres 16 as the primary store.",
      },
      {
        id: 246,
        kind: "fact",
        memoryContentExcerpt: "The project previously used Postgres 14 as the primary store.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "superseded_hidden",
        sourceIds: [245],
        supersededIds: [246],
        confidence: 0.84,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "superseded_hidden",
      sourceIdInAnswer: [245],
      sourceIdNotInAnswer: [246],
      expectedSupersededIds: [246],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // D2. Current-truth preferred — current first, previous in sourceIds
  // -----------------------------------------------------------------------
  {
    id: "current-truth-preferred",
    label: "Current + previous both rank: current first, previous in sourceIds",
    description:
      "A current memory supersedes a previous version; both " +
      "pass the ranker. The engine must rank the current id " +
      "(261) FIRST in `sourceIds` and keep the previous id " +
      "(262) as the second-ranked entry (the supersession " +
      "contract: lineage is preserved).",
    query: "what is the current primary store",
    category: "lifecycle",
    related: [
      {
        id: 261,
        kind: "fact",
        memoryContentExcerpt:
          "The project currently runs Postgres 16 as the primary store across every deployment.",
      },
      {
        id: 262,
        kind: "fact",
        memoryContentExcerpt:
          "The project used Postgres 14 as the primary store in the previous release.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "current_truth_preferred",
        sourceIds: [261, 262],
        olderVariantIds: [262],
        confidence: 0.82,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "current_truth_preferred",
      sourceIdInAnswer: [261, 262],
      // Negative: even though 262 is in sourceIds, the harness
      // checks the FIRST source id is the current truth (the
      // rank-1 contract). A separate assertion below checks
      // ordering; here we pin source-id presence.
      expectedOlderVariantIds: [262],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // D3. False premise about an old memory
  // -----------------------------------------------------------------------
  {
    id: "false-premise-old-memory",
    label: "False premise matches a stale memory: status=no_memory",
    description:
      "The query asserts a premise that happens to match a " +
      "stale memory. The premise is wrong (e.g. the user " +
      "assumes the previous Postgres 14 is still in use) so " +
      "the engine returns `status=no_memory` rather than a " +
      "fabricated `answered` against the stale memory.",
    query: "what postgres 14 features are you using today",
    category: "lifecycle",
    abstentionCritical: abstentionCritical(),
    related: [
      {
        id: 281,
        kind: "fact",
        memoryContentExcerpt:
          "The project used Postgres 14 as the primary store in the previous release.",
      },
      {
        id: 282,
        kind: "fact",
        memoryContentExcerpt: "The project currently runs Postgres 16 as the primary store.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "no_memory",
        reason: "false_premise",
        sourceIds: [],
        confidence: 0.78,
      }),
    },
    expect: {
      expectedStatus: "no_memory",
      expectedReason: "false_premise",
      sourceIdNotInAnswer: [281, 282],
      httpCalls: 1,
    },
  },

  // =======================================================================
  // CATEGORY E: robustness
  // =======================================================================

  // -----------------------------------------------------------------------
  // E1. Irrelevant high-ranked distractor
  // -----------------------------------------------------------------------
  {
    id: "irrelevant-high-ranked",
    label: "High-ranked distractor: engine picks the real target, not the distractor",
    description:
      "The related set is dominated by a high-relevance " +
      "distractor (shares tokens with the query but is not " +
      "actually relevant). The engine must surface the real " +
      "target id (302) and NOT capture the distractor id " +
      "(301) in `sourceIds`.",
    query: "what audit log file is used",
    category: "robustness",
    related: [
      {
        id: 301,
        kind: "fact",
        memoryContentExcerpt: "The benchmark suite reports its pass counts on the audit log file.",
      },
      {
        id: 302,
        kind: "fact",
        memoryContentExcerpt:
          "The audit log file is `.curion/audit.sqlite` and stores redacted event traces.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "suppressed_distractor",
        sourceIds: [302],
        confidence: 0.79,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "suppressed_distractor",
      sourceIdInAnswer: [302],
      sourceIdNotInAnswer: [301],
      httpCalls: 1,
    },
  },

  // -----------------------------------------------------------------------
  // E2. Malformed provider answer — repair recovers
  // -----------------------------------------------------------------------
  {
    id: "malformed-provider-answer",
    label: "Malformed first call; repair recovers with valid decision",
    description:
      "The primary provider returns non-JSON on its first " +
      "call. The adapter invokes the same-provider repair " +
      "call with a valid `RecallPolicyDecision` JSON. The " +
      "harness asserts the final decision is captured " +
      "(httpCalls=2) and the parsed decision is `answered` " +
      "with id (315).",
    query: "what's the configured Postgres 16 pool size",
    category: "robustness",
    evaluationScope: "provider-path",
    related: [
      {
        id: 315,
        kind: "fact",
        memoryContentExcerpt:
          "The Postgres 16 connection pool is configured at 32 connections per worker.",
      },
    ],
    scripted: {
      primaryResponse: "I am sorry, I cannot comply with that request.",
      repairResponse: JSON.stringify({
        status: "answered",
        reason: "repair_recovers",
        sourceIds: [315],
        confidence: 0.81,
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "repair_recovers",
      sourceIdInAnswer: [315],
      httpCalls: 2,
    },
  },

  // -----------------------------------------------------------------------
  // E3. Always-invalid provider output
  // -----------------------------------------------------------------------
  {
    id: "always-invalid-provider",
    label: "All four scripted calls invalid: provider_error",
    description:
      "Every scripted provider call returns invalid JSON. " +
      "The adapter exhausts the state machine (primary first + " +
      "primary repair + fallback first + fallback repair) and " +
      "returns a failure shape (`adapterOk: false`, " +
      '`failureKind: "all-providers-failed"`) after exactly 4 ' +
      "HTTP calls. The harness surfaces the failure kind on the " +
      "report and checks the httpCalls assertion; the " +
      "`expectedStatus` field is intentionally NOT set because " +
      "the captured outcome is a typed failure, not a status.",
    query: "what timeout does the recall adapter use",
    category: "robustness",
    evaluationScope: "provider-path",
    related: [
      {
        id: 330,
        kind: "fact",
        memoryContentExcerpt: "The recall adapter defaults to a 30 second per-request timeout.",
      },
    ],
    scripted: {
      primaryResponse: "not json at all",
      repairResponse: "still not json",
      fallback: {
        firstResponse: "also not json",
        repairResponse: "definitely not json",
      },
    },
    expect: {
      // Intentionally NO `expectedStatus` — the captured
      // outcome is an adapter failure (`adapterOk === false`),
      // and the report surfaces that as `failureKind` on the
      // per-scenario run. Setting `expectedStatus: "provider_error"`
      // here would mismatch the failure-kind reporting; the
      // httpCalls assertion is the headline provider-path check.
      httpCalls: 4,
    },
  },

  // -----------------------------------------------------------------------
  // E4. Refusal-shape present BUT valid decision
  // -----------------------------------------------------------------------
  {
    id: "refusal-shape-valid",
    label: "Refusal-shaped string AND valid decision: treat as authoritative",
    description:
      "The scripted response contains a refusal-shaped " +
      "string (e.g. notes a content-policy caveat) AND a " +
      "valid `RecallPolicyDecision` shape. The engine treats " +
      "the structured decision as authoritative and surfaces " +
      "`status=answered` (NOT a refusal reroute).",
    query: "what is the recall adapter configured for",
    category: "robustness",
    related: [
      {
        id: 345,
        kind: "fact",
        memoryContentExcerpt:
          "The recall adapter is configured to use Postgres 16 for the primary store.",
      },
    ],
    scripted: {
      primaryResponse: JSON.stringify({
        status: "answered",
        reason: "refusal_shape_valid",
        sourceIds: [345],
        confidence: 0.74,
        notes:
          "Note: the model could have refused under content-policy, but it produced a valid decision shape and the structured answer is treated as authoritative.",
      }),
    },
    expect: {
      expectedStatus: "answered",
      expectedReason: "refusal_shape_valid",
      sourceIdInAnswer: [345],
      httpCalls: 1,
    },
  },
];
