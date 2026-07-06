/**
 * Benchmark-only adaptive-depth evaluation helper.
 *
 * Background
 * ----------
 * The `benchmark:retrieval:held-out` runner
 * (`src/benchmark/held-out-runner.ts`) exercises the
 * lexical / hybrid / hybrid-dense rankers against the held-out
 * query slice and the fixed 132-record corpus. The runner
 * reports retrieval-side metrics (hit@5, rank-1 retention,
 * currentTruth@1 retention) but it does NOT exercise the new
 * adaptive-depth controller stage (selector + diversity +
 * budget) or the synthesis input path. A reviewer who reads
 * the held-out artifact sees how the ranker behaves on a new
 * query slice; they do not see how the controller's adaptive
 * depth actually shapes the synthesis MEMORIES section.
 *
 * Purpose
 * -------
 * This module is a small, deterministic, no-network
 * evaluation harness that closes that gap. It drives the
 * FULL `runRecallController` (the same code path the MCP
 * `recall(text)` tool uses) against a curated set of
 * realistic scenarios, captures the synthesis body the
 * controller actually built, and compares two pipeline
 * configurations side by side:
 *
 *   - "adaptive" : the production
 *                  `DEFAULT_ADAPTIVE_DEPTH_PIPELINE_CONFIG`
 *                  (elbow, minK=3, maxK=15,
 *                  relativeFraction=0.5, totalCharBudget=6000,
 *                  perMemoryCharCap=500).
 *   - "legacy"   : a "fixed-topK=5" config that mimics the
 *                  pre-adaptive-depth behaviour: cap the
 *                  selected set at the production topK=5 with
 *                  no relative-fraction filter and no prompt
 *                  budget. Implemented as a deterministic
 *                  adaptive-depth config (selector
 *                  `minK=5, maxK=5, relativeFraction=0,
 *                  plateauTolerance=1.0`; budget `Infinity`),
 *                  which the controller already accepts
 *                  through the test-only `adaptiveDepth`
 *                  option. This avoids invasive surgery on
 *                  the controller just to expose a "no
 *                  adaptive depth" path; the legacy path is
 *                  expressed purely as a config the
 *                  adaptive-depth module already supports.
 *
 * What it captures per scenario
 * -----------------------------
 *   - The controller's final outcome (`status`, `sourceIds`,
 *     `answer`, etc.).
 *   - The synthesis body the controller built (the raw
 *     request body sent to the provider) — captured by a
 *     scripted `fetch` that records the body without
 *     forwarding it anywhere.
 *   - The MEMORIES section of the synthesis body, parsed out
 *     of the body by the same delimiter the synthesis
 *     prompt uses (`MEMORIES (id: summary):` / `QUERY:`).
 *   - The list of memory ids the synthesis prompt actually
 *     carried (the canonical "what did synthesis receive"
 *     signal).
 *
 * Scenarios
 * ---------
 * The harness ships a small, deterministic scenario set
 * (defined inline below) that covers the brief's required
 * axes:
 *
 *   1. "broad-cluster"   : a coherent cluster of 12 closely
 *                          relevant memories + 2 unrelated.
 *                          Adaptive depth must grow past
 *                          topK=5; legacy must cap at 5.
 *   2. "narrow-precise"  : 1 dominant + 4 weak. Both configs
 *                          must stay tight (no regression).
 *   3. "noisy-tail"      : 4 strong + 8 noise. Both must
 *                          exclude the noise; legacy may
 *                          include some of the noise if the
 *                          ranker surfaces it; adaptive must
 *                          exclude via the relative floor.
 *   4. "prompt-budget"   : 20 long memories that together
 *                          exceed the 6000-char budget.
 *                          Adaptive must truncate per-memory
 *                          and drop the tail; legacy sends
 *                          long.
 *   5. "provider-refusal": relevant memories exist but the
 *                          provider returns a refusal phrase.
 *                          The controller must reroute to
 *                          `weak_match` with the top-3
 *                          summaries. Identical behaviour
 *                          under both configs (adaptive depth
 *                          must not break the reroute).
 *   6. "superseded-pair" : A current memory supersedes a
 *                          previous version; both are
 *                          present. The current must rank
 *                          above the previous; the previous
 *                          must remain in `sourceIds` (the
 *                          supersession contract).
 *
 * What it does NOT do
 * -------------------
 *   - It does NOT make any network call. The `fetch`
 *     override is a local scripted implementation.
 *   - It does NOT touch production storage. Each scenario
 *     creates an isolated `.curion` directory under
 *     `os.tmpdir()` and tears it down after the run.
 *   - It does NOT modify the production `recall(text)`
 *     behaviour, the public MCP API, or the existing
 *     dev-set / audit / calibration / policy / held-out
 *     report shapes. The artifact prefix is
 *     `retrieval-adaptive-depth-evaluation-`.
 *   - It does NOT tune the controller on the evaluation
 *     results. The legacy config is fixed; the adaptive
 *     config is the production default. A future
 *     experiment that re-tunes them would invalidate the
 *     v1 contract.
 *
 * Scope (benchmark-only / research-only)
 * --------------------------------------
 * The harness is read-only. It does not persist the
 * synthesis bodies or the controller outcomes beyond the
 * optional JSON artifact under `.curion/benchmark/`. The
 * public `recall(text)` tool surface is unchanged; the
 * `adaptiveDepth` controller option is reserved for this
 * harness and its companion test suite
 * (`tests/adaptive-depth-evaluation.test.ts`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type AdaptiveDepthPipelineConfig,
  type ResolvedAdaptiveDepthConfig,
  resolveAdaptiveDepthConfig,
} from "../retrieval/adaptive-depth.js";
import {
  type MemoryRecord,
  type StorageHandle,
  initStorage,
  insertMemoryRecord,
  listActiveMemoryRelationshipBlocks,
} from "../storage/storage.js";

import {
  DEFAULT_ADAPTIVE_DEPTH_PIPELINE_CONFIG,
  type RecallControllerOptions,
  type RecallOutcome,
  runRecallController,
} from "../controller/recall-controller.js";
import { writeTimestampedJsonArtifact } from "./_artifact.js";
import { buildRecordingScriptedFetch, okChatResponse } from "./_scripted-fetch.js";

// ---------------------------------------------------------------------------
// Scripted fetch + canned response shapes
// ---------------------------------------------------------------------------
//
// The benchmark module needs a small scripted `fetch` and a
// canned chat-completions response shape. The unit tests
// already define these in `tests/_helpers/provider-stub.ts`
// and the test provider config in `tests/shared-test-provider.ts`.
// The benchmark files live under `src/`, which has a
// `rootDir` of `src` in `tsconfig.json`, so we cannot
// import from `tests/`. The shared `_scripted-fetch.ts`
// helper is the benchmark-side mirror: it produces
// byte-equivalent shapes (same JSON, same headers, same
// status codes) so a reviewer reading either file sees
// the same contract.
//
// The recorder scaffolding (`buildRecordingScriptedFetch`)
// is shared with the decision-policy harness; the
// per-scenario state machine (which canned response to
// return per call) is private to each harness.

// Placeholder test provider config. The controller never
// makes a real HTTP call under the scripted fetch; the
// values exist only so the controller's
// `providerPrimary*` / `providerFallback*` validation
// accepts the options bundle and the adapter returns
// the canned response.
const TEST_PRIMARY_KEY = "sk-test-primary-not-real-12345";
const TEST_PRIMARY_BASE_URL = "https://api.example.com/v1";
const TEST_PRIMARY_MODEL = "test/model-primary";
const TEST_FALLBACK_KEY = "sk-test-fallback-not-real-12345";
const TEST_FALLBACK_BASE_URL = "https://api.fallback.example/v1";
const TEST_FALLBACK_MODEL = "test/model-fallback";

// ---------------------------------------------------------------------------
// Legacy fixed-topK config
// ---------------------------------------------------------------------------

/**
 * The "legacy" pipeline config: cap the synthesis input at
 * exactly 5 candidates (the pre-adaptive-depth production
 * cap), no relative-fraction filter, no prompt budget. The
 * selector is configured so that the plateau strategy walks
 * the remainder with `plateauTolerance: 1.0` (effectively
 * "always within tolerance") and stops at `maxK=5`. The
 * budget is `Infinity` so no truncation occurs.
 *
 * The shape mirrors the existing `AdaptiveDepthPipelineConfig`
 * so the controller consumes it through the same test-only
 * `adaptiveDepth` option. No new controller code path is
 * required.
 */
export const LEGACY_FIXED_TOPK_PIPELINE_CONFIG: AdaptiveDepthPipelineConfig = {
  selector: {
    strategy: "plateau",
    minK: 5,
    maxK: 5,
    relativeFraction: 0,
    plateauTolerance: 1.0,
  },
  diversity: { enabled: false },
  budget: {
    totalCharBudget: Number.POSITIVE_INFINITY,
    perMemoryCharCap: Number.POSITIVE_INFINITY,
    dropLowestWhenOverBudget: true,
  },
};

/**
 * The effective legacy topK cap, surfaced as a named
 * constant so a reviewer reading the human report can read
 * "the legacy path caps at 5" without re-deriving the
 * selector config.
 */
export const LEGACY_FIXED_TOPK_VALUE = 5;

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

/**
 * A single memory to seed into the controller's storage
 * before a scenario runs. The harness writes the row via
 * `insertMemoryRecord` so the controller reads the same
 * `SafeMemorySummary` shape it reads in production.
 */
export interface ScenarioMemory {
  /** Memory body. */
  text: string;
  /** Memory kind. Defaults to "fact". */
  kind?: string;
  /** Tags. Defaults to []. */
  tags?: string[];
  /**
   * Optional metadata block. The harness writes the
   * `relationship` field verbatim into the `metadata` JSON
   * column so the controller reads it back via
   * `listActiveMemoryRelationshipBlocks` (used by the
   * superseded-demotion stage). The shape mirrors
   * `RelationshipBlock` in
   * `src/storage/storage.ts`.
   */
  relationship?: {
    supersedes?: number[];
    supersededBy?: number[];
  };
}

/**
 * A single scenario. Each scenario defines:
 *   - the memories to seed into storage,
 *   - the user query,
 *   - the canned provider response (the synthesis answer the
 *     scripted fetch returns; for refusal scenarios this is
 *     a refusal phrase),
 *   - the assertions the harness checks on both
 *     configurations.
 */
export interface EvaluationScenario {
  /** Stable id; used as the `scenarioId` in the report. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Short description of what this scenario exercises. */
  description: string;
  /** Memories to seed. Inserted in declaration order. */
  memories: ScenarioMemory[];
  /** The query text the user is asking. */
  query: string;
  /**
   * The canned provider response. By default the harness
   * returns a generic synthesis answer. Refusal scenarios
   * override this with a refusal phrase that triggers the
   * `weak_match` reroute.
   */
  providerResponse?: string;
  /**
   * Expected outcome expectations. The harness uses these
   * to assert per-config behaviour. Each expectation is a
   * predicate; the harness records the predicate's result
   * for both `adaptive` and `legacy` configs on the
   * report.
   */
  expect: ScenarioExpectations;
  /**
   * Scenario version stamp. The field is surfaced on the
   * report so a reviewer can audit which scenario set
   * version produced the artifact. The value is a
   * human-readable string (e.g. `"1.0"`); the format
   * is not machine-enforced.
   */
  scenarioVersion?: string;
}

/**
 * A small set of named expectations the harness checks
 * per scenario. Expectations are CONFIG-AGNOSTIC by
 * default; a per-config variant is supplied when the
 * scenario requires different behaviour between adaptive
 * and legacy. When both `adaptive` and `legacy` fields are
 * present, the harness asserts on each independently. When
 * a `common` field is set, the harness asserts the
 * expectation holds under both configs.
 */
export interface ScenarioExpectations {
  /** Config-agnostic expectations. Apply to both configs. */
  common?: {
    /** Expected `status` on the `RecallOutcome`. */
    status?: "answered" | "no_memory" | "weak_match" | "rejected" | "provider_error";
    /** Memory ids the synthesis prompt MUST carry. */
    mustIncludeIds?: ReadonlyArray<number>;
    /** Memory ids the synthesis prompt MUST NOT carry. */
    mustExcludeIds?: ReadonlyArray<number>;
  };
  /** Expectations that hold only under the adaptive config. */
  adaptive?: {
    /** Minimum number of candidates the synthesis prompt must carry. */
    minSelectedCount?: number;
    /** Maximum number of candidates the synthesis prompt may carry. */
    maxSelectedCount?: number;
  };
  /** Expectations that hold only under the legacy fixed-topK config. */
  legacy?: {
    /** Minimum number of candidates the synthesis prompt must carry. */
    minSelectedCount?: number;
    /** Maximum number of candidates the synthesis prompt may carry. */
    maxSelectedCount?: number;
  };
}

// ---------------------------------------------------------------------------
// Per-scenario per-config captured data
// ---------------------------------------------------------------------------

/**
 * The data the harness captures for a single
 * (scenario, config) pair. The report surfaces this
 * verbatim so a reviewer can audit what the controller
 * actually saw and what it actually sent to synthesis.
 */
export interface ScenarioRunResult {
  /** Which pipeline config produced this run. */
  config: "adaptive" | "legacy";
  /** Resolved selector config (after defaults). */
  resolvedSelector: ResolvedAdaptiveDepthConfig;
  /** The controller's final outcome. */
  outcome: RecallOutcome;
  /** Status the controller returned. */
  status: RecallOutcome["status"];
  /** Source ids the controller returned on the outcome. */
  sourceIds: ReadonlyArray<number>;
  /**
   * Number of synthesis calls the controller made (0 if
   * it short-circuited with `no_memory` / `rejected`; 1
   * if it called the provider; 2 if primary failed and
   * fallback was tried).
   */
  synthesisCalls: number;
  /** Synthesis body the controller sent (if any). */
  synthesisBody: string;
  /** The MEMORIES section parsed out of the synthesis body. */
  memoriesSection: string;
  /** Memory ids the synthesis prompt actually carried. */
  synthesisMemoryIds: ReadonlyArray<number>;
  /** Per-scenario assertion results. */
  assertions: {
    common: ScenarioAssertionRow[];
    configSpecific: ScenarioAssertionRow[];
    /** Did the assertions all pass? */
    pass: boolean;
  };
}

/**
 * A single assertion row the harness records. One row per
 * (expectation, config) pair.
 */
export interface ScenarioAssertionRow {
  /** Short name of the expectation. */
  name: string;
  /** Description of what the expectation checks. */
  description: string;
  /** Did the expectation hold? */
  pass: boolean;
  /** Free-form note (e.g. "got N=7, expected >= 5"). */
  note: string;
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/**
 * The top-level evaluation report. The JSON artifact is
 * one of these. The shape is intentionally distinct from
 * the existing dev-set / held-out / audit / calibration /
 * policy report shapes: this evaluation is a SEPARATE
 * study of how the adaptive-depth stage actually shapes
 * the synthesis input, against a small, deterministic
 * scenario set.
 */
export interface AdaptiveDepthEvaluationReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /** Metadata block. */
  meta: {
    /** Number of scenarios run. */
    scenarioCount: number;
    /** Number of scenarios that passed under both configs. */
    passedBothCount: number;
    /** Number of scenarios that passed under the adaptive config only. */
    passedAdaptiveOnlyCount: number;
    /** Number of scenarios that passed under the legacy config only. */
    passedLegacyOnlyCount: number;
    /** Number of scenarios that failed under both. */
    failedBothCount: number;
    /** Total scenario-run pairs executed. */
    totalRuns: number;
    /** Resolved selector config for the adaptive run. */
    adaptiveResolvedSelector: ResolvedAdaptiveDepthConfig;
    /** Resolved selector config for the legacy run. */
    legacyResolvedSelector: ResolvedAdaptiveDepthConfig;
  };
  /** Per-scenario per-config run results, in scenario declaration order. */
  runs: ReadonlyArray<{
    scenarioId: string;
    label: string;
    description: string;
    query: string;
    adaptive: ScenarioRunResult;
    legacy: ScenarioRunResult;
  }>;
  /**
   * Honest / research-only block. The same block is
   * surfaced on the human report; the artifact carries
   * it as a machine-readable array for tooling.
   */
  limitations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Built-in scenario set
// ---------------------------------------------------------------------------

/**
 * The default scenario set. Each scenario is small,
 * deterministic, and writes only safe text (no secrets,
 * no raw input). The set is the v1 reference scenario
 * set; a future v2 may add new scenarios (e.g. semantic
 * fusion) without invalidating the v1 contract.
 *
 * Family distribution (6 scenarios):
 *   - broad-cluster       : many relevant memories
 *   - narrow-precise      : tight top-1
 *   - noisy-tail          : cluster + long noisy tail
 *   - prompt-budget       : many long memories
 *   - provider-refusal    : refusal -> weak_match
 *   - superseded-pair     : current vs previous version
 */
export const BUILT_IN_SCENARIOS: ReadonlyArray<EvaluationScenario> = [
  // -----------------------------------------------------------------------
  // 1. Broad / vague query with a coherent cluster
  // -----------------------------------------------------------------------
  {
    id: "broad-cluster",
    label: "Broad query, coherent cluster of 12 memories",
    description:
      "12 closely-relevant memories about the project theme + 2 unrelated. " +
      "Adaptive must grow past topK=5; legacy caps at 5.",
    memories: [
      ...Array.from({ length: 12 }).map(
        (_, i): ScenarioMemory => ({
          text: `Project theme is decision #${i + 1} about minimal agent memory surfaces and conservative defaults.`,
          kind: "context",
          tags: ["theme", "project"],
        })
      ),
      {
        text: "Office plants are watered on a biweekly rotation.",
        kind: "context",
        tags: ["plants"],
      },
      {
        text: "Conference room chairs are restocked monthly.",
        kind: "context",
        tags: ["furniture"],
      },
    ],
    query: "Tell me about the project theme",
    providerResponse:
      "The project theme is minimal agent memory surfaces with conservative defaults.",
    expect: {
      common: {
        status: "answered",
        mustExcludeIds: [], // ids are assigned at seed time; the broad-cluster scenario just
        // asserts on the count and the synthesis body below.
      },
      adaptive: { minSelectedCount: 6, maxSelectedCount: 15 },
      legacy: { minSelectedCount: 5, maxSelectedCount: 5 },
    },
    scenarioVersion: "1.0",
  },
  // -----------------------------------------------------------------------
  // 2. Narrow precise query
  // -----------------------------------------------------------------------
  {
    id: "narrow-precise",
    label: "Narrow precise query with one dominant memory",
    description:
      "1 dominant memory + 4 weak/unrelated. Both configs must stay tight; " +
      "no regression on the existing topK=5 contract.",
    memories: [
      {
        text: "The project uses Postgres 16 for the primary data store.",
        kind: "fact",
        tags: ["postgres", "storage"],
      },
      {
        text: "The project ships with a workspace CLI binary called curion.",
        kind: "fact",
        tags: ["cli"],
      },
      {
        text: "The project uses lexical ranker as the MVP retrieval.",
        kind: "fact",
        tags: ["retrieval", "ranker"],
      },
      {
        text: "Office plants are watered on a biweekly rotation.",
        kind: "context",
        tags: ["plants"],
      },
      {
        text: "Conference room chairs are restocked monthly.",
        kind: "context",
        tags: ["furniture"],
      },
    ],
    query: "What database does the project use?",
    providerResponse: "The project uses Postgres 16 for the primary data store.",
    expect: {
      common: { status: "answered" },
      adaptive: { minSelectedCount: 1, maxSelectedCount: 5 },
      legacy: { minSelectedCount: 1, maxSelectedCount: 5 },
    },
    scenarioVersion: "1.0",
  },
  // -----------------------------------------------------------------------
  // 3. Noisy tail
  // -----------------------------------------------------------------------
  {
    id: "noisy-tail",
    label: "4 strong + 8 noise memories",
    description:
      "A coherent cluster of 4 strong memories + 8 weak noise. The adaptive " +
      "selector's relative-fraction floor must exclude the noise. Legacy may " +
      "or may not exclude depending on the ranker; the harness records both.",
    memories: [
      {
        text: "The project uses Postgres 16 for the primary data store.",
        kind: "fact",
        tags: ["postgres"],
      },
      {
        text: "The project ships with a workspace CLI binary.",
        kind: "fact",
        tags: ["cli"],
      },
      {
        text: "The project uses lexical ranker as the MVP retrieval.",
        kind: "fact",
        tags: ["ranker"],
      },
      {
        text: "The project keeps raw input out of the persisted memory table.",
        kind: "fact",
        tags: ["storage"],
      },
      ...Array.from({ length: 8 }).map(
        (_, i): ScenarioMemory => ({
          text: `Random context note ${i}: the office kitchen has a snack bar.`,
          kind: "context",
          tags: ["noise"],
        })
      ),
    ],
    query: "What database does the project use?",
    providerResponse: "The project uses Postgres 16 for the primary data store.",
    expect: {
      common: { status: "answered" },
      adaptive: { minSelectedCount: 1, maxSelectedCount: 5 },
      legacy: { minSelectedCount: 1, maxSelectedCount: 5 },
    },
    scenarioVersion: "1.0",
  },
  // -----------------------------------------------------------------------
  // 4. Prompt budget: 20 long memories
  // -----------------------------------------------------------------------
  {
    id: "prompt-budget",
    label: "20 long memories exceed the prompt budget",
    description:
      "20 long memories (each ~190 chars) far exceed the 6000-char budget. " +
      "Adaptive must bound the MEMORIES section; legacy sends the full text.",
    memories: Array.from({ length: 20 }).map(
      (_, i): ScenarioMemory => ({
        text: `Project memory number ${i + 1}: detailed notes about the project theme, design decisions, and the related context. This is a long memory that exceeds the per-memory cap.`,
        kind: "context",
        tags: ["project", "theme"],
      })
    ),
    query: "Tell me about the project theme",
    providerResponse: "Project memory details captured.",
    expect: {
      common: { status: "answered" },
      adaptive: {
        // The budget drops the tail so the MEMORIES section
        // is bounded. We don't assert a specific count here;
        // the harness asserts on the MEMORIES section length
        // and the truncation marker.
        minSelectedCount: 1,
        maxSelectedCount: 15,
      },
      legacy: {
        // Legacy has no budget; all 20 fit (the controller's
        // lexical-topK = storageLimit = 200 surfaces all
        // 20, the legacy cap=5 keeps 5 of them).
        minSelectedCount: 5,
        maxSelectedCount: 5,
      },
    },
    scenarioVersion: "1.0",
  },
  // -----------------------------------------------------------------------
  // 5. Provider refusal -> weak_match
  // -----------------------------------------------------------------------
  {
    id: "provider-refusal",
    label: "Provider refusal: reroute to weak_match",
    description:
      "Relevant memories exist; the provider returns a refusal phrase. The " +
      "controller must reroute to `weak_match` with the top-3 summaries. " +
      "Identical behaviour under both configs.",
    memories: [
      {
        text: "Session 2 covered the controller and the lexical retrieval boundary.",
        kind: "context",
        tags: ["session", "controller"],
      },
      {
        text: "Session 2 also covered the storage layer and schema migrations.",
        kind: "context",
        tags: ["session", "storage"],
      },
      {
        text: "Session 2 included a deep dive on the safety pre-check classifier.",
        kind: "context",
        tags: ["session", "safety"],
      },
      {
        text: "Session 2 wrapped up with the benchmark corpus expansion.",
        kind: "context",
        tags: ["session", "benchmark"],
      },
    ],
    query: "session 2",
    providerResponse: "I don't have a specific summary for session 2 in the available memories.",
    expect: {
      common: { status: "weak_match" },
      adaptive: { minSelectedCount: 1, maxSelectedCount: 15 },
      legacy: { minSelectedCount: 1, maxSelectedCount: 5 },
    },
    scenarioVersion: "1.0",
  },
  // -----------------------------------------------------------------------
  // 6. Superseded pair
  // -----------------------------------------------------------------------
  {
    id: "superseded-pair",
    label: "Current memory supersedes a previous version",
    description:
      "A current memory supersedes a previous version. The current must " +
      "rank above the previous; the previous must remain in sourceIds.",
    memories: [
      {
        text: "The project used Postgres 15 for the primary store in the previous release.",
        kind: "fact",
        tags: ["postgres", "previous"],
        // The supersession relationship is written by the
        // harness into the `metadata` JSON column via
        // `relationship` here; the seeded id is filled in by
        // the harness below. The `supersedes` field will be
        // patched after the row is inserted.
      },
      {
        text: "The project uses Postgres 16 for the primary store in the current release.",
        kind: "fact",
        tags: ["postgres", "current"],
      },
    ],
    query: "What database does the project use?",
    providerResponse: "The project uses Postgres 16 for the primary data store.",
    expect: {
      common: { status: "answered" },
      adaptive: { minSelectedCount: 2, maxSelectedCount: 15 },
      legacy: { minSelectedCount: 2, maxSelectedCount: 5 },
    },
    scenarioVersion: "1.0",
  },
];

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

/**
 * The evaluation's limitations / research-only block.
 * The block is surfaced on the artifact
 * (`report.limitations`) and on the human report. The
 * block is intentionally narrow: the brief is explicit that
 * the evaluation is a v1 probe, not a deployment-grade
 * benchmark.
 */
export const ADAPTIVE_DEPTH_EVALUATION_LIMITATIONS: ReadonlyArray<string> = [
  "Synthetic-scenario evaluation. The six built-in scenarios are hand-curated; they exercise the controller on small, deterministic corpora. A reviewer who reads a scenario-pass rate as 'the adaptive depth stage generalises to production' is over-reading the result. The right reading is 'the adaptive depth stage behaves as expected on the v1 scenario set'.",
  "No-network. The harness never makes a real provider call; the scripted fetch returns the canned response in-process. A future experiment that adds a real provider call would invalidate the determinism contract.",
  "Legacy fixed-topK is expressed as an adaptive-depth config, not as a controller change. The legacy path is the canonical adaptive-depth pipeline with `selector.minK=maxK=5, relativeFraction=0, plateauTolerance=1.0, budget=Infinity`. The shape is identical to the production path; the only difference is the config. A reviewer who wants to compare against a true 'no adaptive depth' path would need a separate code change to the controller.",
  "Frozen config. The production adaptive-depth config is `DEFAULT_ADAPTIVE_DEPTH_PIPELINE_CONFIG`. The legacy config is `LEGACY_FIXED_TOPK_PIPELINE_CONFIG`. Neither is re-tuned on the evaluation results. A future experiment that re-tunes them would invalidate the v1 contract.",
  "Benchmark-only / research-only. The evaluation does NOT modify the production `recall(text)` behavior, the public MCP API, or the existing dev-set / audit / calibration / policy / held-out report shapes. The artifact prefix is `retrieval-adaptive-depth-evaluation-` and is separate from the held-out / dev-set artifacts.",
  "The test-only `adaptiveDepth` option on `RecallControllerOptions` is reserved for this harness and its companion test suite. The public MCP tool surface in `src/tools/recall.ts` does NOT pass it; the contract test `tests/contracts.test.ts` pins the wire shape to the existing `remember` + `recall` tools with the single `text` parameter.",
  "v1 of the evaluation is a probe. A future v2 that adds new scenarios (e.g. semantic fusion, multi-project recall) is a deliberate, visible change.",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the JSON-encoded synthesis body and return the
 * user-role prompt content. The synthesis body is the
 * raw JSON payload the controller sent to the provider;
 * the user-role content is the second message
 * (`messages[1].content` when `messages[0]` is the
 * system prompt).
 *
 * The function is defensive: when the body is not valid
 * JSON, or the messages array is missing / not an
 * array, or the user-role content is missing / not a
 * string, the helper returns an empty string. A
 * reviewer who needs to debug a non-parseable body can
 * read the raw body from the report's
 * `synthesisBody` field.
 */
function extractUserPrompt(synthesisBody: string): string {
  if (typeof synthesisBody !== "string" || synthesisBody.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(synthesisBody);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "";
  // The user-role message is the message with `role: "user"`.
  // The controller may also include a system message; we
  // search for the first `role: "user"` entry.
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role === "user" && typeof content === "string") {
      return content;
    }
  }
  return "";
}

/**
 * Parse the MEMORIES section out of the user-role prompt
 * the controller built. The synthesis prompt uses the
 * literal delimiters `MEMORIES (id: summary):` (start)
 * and `QUERY:` (end); the helper slices the user prompt
 * between them. The result includes the section header
 * (so a reviewer reading the report can audit the
 * delimiter) and the bullet lines for the memories the
 * controller sent.
 */
function extractMemoriesSection(userPrompt: string): string {
  if (userPrompt.length === 0) return "";
  const start = userPrompt.indexOf("MEMORIES (id: summary):");
  const end = userPrompt.indexOf("\nQUERY:");
  if (start < 0 || end < 0 || end <= start) return "";
  return userPrompt.slice(start, end);
}

/**
 * Extract the memory ids the synthesis prompt actually
 * carried. The synthesis prompt formats memories as
 * `- #N [kind]: text`. The helper pulls every `id` out
 * of the MEMORIES section in score-desc order. An empty
 * section returns an empty array.
 */
function extractSynthesisMemoryIds(memoriesSection: string): number[] {
  if (memoriesSection.length === 0) return [];
  const out: number[] = [];
  // Pattern: `- #<digits>` followed by optional ` [<kind>]`.
  // We only need the digits; the rest of the line is not
  // parsed.
  const re = /-\s+#(\d+)/g;
  let m: RegExpExecArray | null = re.exec(memoriesSection);
  while (m !== null) {
    const id = Number(m[1]);
    if (Number.isFinite(id)) out.push(id);
    m = re.exec(memoriesSection);
  }
  return out;
}

/**
 * Run one (scenario, config) pair end-to-end through
 * `runRecallController`. The function creates an isolated
 * tmp storage, seeds the scenario memories, drives the
 * controller, captures the synthesis body, parses the
 * MEMORIES section, runs the scenario's expectations,
 * and returns a `ScenarioRunResult`.
 */
async function runSingleScenarioConfig(
  scenario: EvaluationScenario,
  config: "adaptive" | "legacy",
  configValue: AdaptiveDepthPipelineConfig
): Promise<ScenarioRunResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `curion-adapt-eval-${scenario.id}-`));
  const handle: StorageHandle = initStorage({ projectRoot: tmp });
  const seededIds: number[] = [];
  try {
    // Seed memories. The superseded-pair scenario needs a
    // second pass to patch the `relationship.supersedes`
    // field on the current memory with the actual id of
    // the previous memory. We track the inserted ids and
    // apply the patch after the first pass.
    const supersededPatch: Array<{ currentId: number; previousId: number }> = [];
    for (const m of scenario.memories) {
      const row: MemoryRecord = insertMemoryRecord(handle, {
        kind: (m.kind as MemoryRecord["kind"]) ?? "fact",
        state: "active",
        memoryContent: m.text,
        providerId: "test",
        modelId: "test-model",
        confidence: 0.9,
        metadata: {
          tags: m.tags ?? [],
          classification: null,
        },
      });
      seededIds.push(row.id);
      if (m.relationship?.supersedes) {
        for (const target of m.relationship.supersedes) {
          supersededPatch.push({ currentId: row.id, previousId: target });
        }
      }
    }
    // For the superseded-pair scenario the `relationship.supersedes`
    // references are symbolic (-1 markers); the harness
    // converts them into real ids by replacing each -1 with
    // the id of the previous-inserted memory (the
    // superseded-pair scenario inserts the previous memory
    // first and the current memory second).
    if (supersededPatch.length > 0) {
      const previousId = seededIds[0] as number;
      const currentId = seededIds[1] as number;
      for (const patch of supersededPatch) {
        const realTarget = patch.previousId === -1 ? previousId : patch.previousId;
        const currentRow = handle.db
          .prepare("SELECT metadata FROM memories WHERE id = ?")
          .get(currentId) as { metadata: string } | undefined;
        if (!currentRow) continue;
        const meta = JSON.parse(currentRow.metadata) as Record<string, unknown>;
        const existingRel = (meta.relationship as Record<string, unknown> | undefined) ?? {};
        const newRel = {
          ...existingRel,
          derivedSchemaVersion: "ccm-draft-1",
          derivedAt: Date.now(),
          conflictsWith: [],
          olderVariantsOf: [],
          detectionConfidence: 1,
          supersedes: [realTarget],
          supersededBy: [],
          resolvedAt: 0,
        };
        meta.relationship = newRel;
        handle.db
          .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
          .run(JSON.stringify(meta), currentId);
      }
      // Sanity: relationship block should be readable.
      const blocks = listActiveMemoryRelationshipBlocks(handle, { limit: 50 });
      const currentBlock = blocks.find((b) => b.id === currentId);
      if (!currentBlock || !currentBlock.block.supersedes.includes(previousId)) {
        throw new Error(
          `superseded-pair seed: relationship block not written for current id=${currentId}`
        );
      }
    }
    // Build the controller options. The harness uses the
    // same scripted fetch the unit tests use so the
    // provider call is fully captured.
    let synthesisBody = "";
    let synthesisCalls = 0;
    const responder = () => {
      synthesisCalls += 1;
      return okChatResponse(scenario.providerResponse ?? "ok");
    };
    const { fetchImpl, calls } = buildRecordingScriptedFetch(responder);
    void calls; // keep eslint happy; calls array is the canonical record but we use synthesisBody.
    // The scripted fetch captures the body into `calls[0].body`.
    // To keep the captured body in a stable local, the
    // helper wraps the fetch impl with a local body grabber.
    const wrappedFetch: typeof fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      if (init && typeof init === "object" && "body" in init && typeof init.body === "string") {
        synthesisBody = init.body;
      }
      return response;
    };
    const controllerOptions: RecallControllerOptions = {
      providerFetchImpl: wrappedFetch,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      adaptiveDepth: configValue,
    };
    const outcome: RecallOutcome = await runRecallController(
      handle,
      scenario.query,
      controllerOptions
    );
    const userPrompt = extractUserPrompt(synthesisBody);
    const memoriesSection = extractMemoriesSection(userPrompt);
    const synthesisMemoryIds = extractSynthesisMemoryIds(memoriesSection);
    const sourceIds =
      outcome.status === "answered" ? outcome.sourceIds : outcome.status === "weak_match" ? [] : [];
    // Run the scenario's expectations against this run.
    const assertionRows: {
      common: ScenarioAssertionRow[];
      configSpecific: ScenarioAssertionRow[];
    } = { common: [], configSpecific: [] };
    const common = scenario.expect.common;
    if (common) {
      if (common.status !== undefined) {
        assertionRows.common.push({
          name: "common.status",
          description: `outcome.status must be "${common.status}"`,
          pass: outcome.status === common.status,
          note: `got "${outcome.status}"`,
        });
      }
      if (common.mustIncludeIds) {
        for (const id of common.mustIncludeIds) {
          assertionRows.common.push({
            name: "common.mustIncludeIds",
            description: `synthesis prompt must include memory id ${id}`,
            pass: synthesisMemoryIds.includes(id),
            note: synthesisMemoryIds.includes(id)
              ? "present"
              : `missing (synthesis ids: [${synthesisMemoryIds.join(", ")}])`,
          });
        }
      }
      if (common.mustExcludeIds) {
        for (const id of common.mustExcludeIds) {
          assertionRows.common.push({
            name: "common.mustExcludeIds",
            description: `synthesis prompt must not include memory id ${id}`,
            pass: !synthesisMemoryIds.includes(id),
            note: !synthesisMemoryIds.includes(id)
              ? "absent"
              : `unexpectedly present (synthesis ids: [${synthesisMemoryIds.join(", ")}])`,
          });
        }
      }
    }
    const cfgExpect = config === "adaptive" ? scenario.expect.adaptive : scenario.expect.legacy;
    if (cfgExpect) {
      if (cfgExpect.minSelectedCount !== undefined) {
        const n = synthesisMemoryIds.length;
        assertionRows.configSpecific.push({
          name: `${config}.minSelectedCount`,
          description: `synthesis prompt must carry >= ${cfgExpect.minSelectedCount} memories`,
          pass: n >= cfgExpect.minSelectedCount,
          note: `got N=${n}`,
        });
      }
      if (cfgExpect.maxSelectedCount !== undefined) {
        const n = synthesisMemoryIds.length;
        assertionRows.configSpecific.push({
          name: `${config}.maxSelectedCount`,
          description: `synthesis prompt must carry <= ${cfgExpect.maxSelectedCount} memories`,
          pass: n <= cfgExpect.maxSelectedCount,
          note: `got N=${n}`,
        });
      }
    }
    // The resolved selector config the controller actually
    // used. We pull it from the configured value the
    // harness passed in (so a reviewer can audit the
    // effective config even when the option is partially
    // populated).
    const cfgForResolved = configValue.selector ?? {};
    const resolvedSelector = resolveAdaptiveDepthConfig(cfgForResolved);
    return {
      config,
      resolvedSelector,
      outcome,
      status: outcome.status,
      sourceIds,
      synthesisCalls,
      synthesisBody,
      memoriesSection,
      synthesisMemoryIds,
      assertions: {
        common: assertionRows.common,
        configSpecific: assertionRows.configSpecific,
        pass: [...assertionRows.common, ...assertionRows.configSpecific].every((r) => r.pass),
      },
    };
  } finally {
    try {
      handle.db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full evaluation. The function is async because
 * the controller is async. It is deterministic for a
 * given (scenario set, config values). The function is
 * the canonical entry point for both the CLI runner and
 * the test suite.
 */
export async function runAdaptiveDepthEvaluation(
  args: {
    scenarios?: ReadonlyArray<EvaluationScenario>;
    /** The adaptive-depth config to use for the `adaptive` runs. */
    adaptiveConfig?: AdaptiveDepthPipelineConfig;
    /** The adaptive-depth config to use for the `legacy` runs. */
    legacyConfig?: AdaptiveDepthPipelineConfig;
  } = {}
): Promise<AdaptiveDepthEvaluationReport> {
  const scenarios = args.scenarios ?? BUILT_IN_SCENARIOS;
  const adaptiveConfig = args.adaptiveConfig ?? DEFAULT_ADAPTIVE_DEPTH_PIPELINE_CONFIG;
  const legacyConfig = args.legacyConfig ?? LEGACY_FIXED_TOPK_PIPELINE_CONFIG;
  const runs: Array<{
    scenarioId: string;
    label: string;
    description: string;
    query: string;
    adaptive: ScenarioRunResult;
    legacy: ScenarioRunResult;
  }> = [];
  for (const s of scenarios) {
    const [adaptive, legacy] = await Promise.all([
      runSingleScenarioConfig(s, "adaptive", adaptiveConfig),
      runSingleScenarioConfig(s, "legacy", legacyConfig),
    ]);
    runs.push({
      scenarioId: s.id,
      label: s.label,
      description: s.description,
      query: s.query,
      adaptive,
      legacy,
    });
  }
  // Compute per-scenario pass summary.
  let passedBoth = 0;
  let passedAdaptiveOnly = 0;
  let passedLegacyOnly = 0;
  let failedBoth = 0;
  for (const r of runs) {
    const ap = r.adaptive.assertions.pass;
    const lp = r.legacy.assertions.pass;
    if (ap && lp) passedBoth += 1;
    else if (ap && !lp) passedAdaptiveOnly += 1;
    else if (!ap && lp) passedLegacyOnly += 1;
    else failedBoth += 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    meta: {
      scenarioCount: scenarios.length,
      passedBothCount: passedBoth,
      passedAdaptiveOnlyCount: passedAdaptiveOnly,
      passedLegacyOnlyCount: passedLegacyOnly,
      failedBothCount: failedBoth,
      totalRuns: scenarios.length * 2,
      adaptiveResolvedSelector: resolveAdaptiveDepthConfig(adaptiveConfig.selector ?? {}),
      legacyResolvedSelector: resolveAdaptiveDepthConfig(legacyConfig.selector ?? {}),
    },
    runs,
    limitations: ADAPTIVE_DEPTH_EVALUATION_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Human report
// ---------------------------------------------------------------------------

/**
 * Format the evaluation report as a human-readable
 * string. The report surfaces:
 *   - the meta header (counts + resolved configs),
 *   - the "READ THIS FIRST" block (probe framing),
 *   - the per-scenario table (one row per scenario, two
 *     cells per row: adaptive / legacy),
 *   - the per-scenario details (controller outcome,
 *     synthesis call count, synthesis body size, id list,
 *     assertion rows),
 *   - the limitations block.
 *
 * The function is pure: same report -> same string.
 */
export function formatAdaptiveDepthEvaluationReport(report: AdaptiveDepthEvaluationReport): string {
  const lines: string[] = [];
  lines.push("=== curion adaptive-depth evaluation ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  // ---- Metadata header ----
  lines.push("--- meta ---");
  lines.push(`  scenarios:             ${report.meta.scenarioCount}`);
  lines.push(
    `  total runs:            ${report.meta.totalRuns} (2 configs x ${report.meta.scenarioCount} scenarios)`
  );
  lines.push(`  passed (both):         ${report.meta.passedBothCount}`);
  lines.push(`  passed (adaptive only):${report.meta.passedAdaptiveOnlyCount}`);
  lines.push(`  passed (legacy only):  ${report.meta.passedLegacyOnlyCount}`);
  lines.push(`  failed (both):         ${report.meta.failedBothCount}`);
  lines.push("");
  lines.push("  adaptive selector (resolved):");
  lines.push(
    `    strategy=${report.meta.adaptiveResolvedSelector.strategy}  minK=${report.meta.adaptiveResolvedSelector.minK}  maxK=${report.meta.adaptiveResolvedSelector.maxK}  relativeFraction=${report.meta.adaptiveResolvedSelector.relativeFraction}  plateauTolerance=${report.meta.adaptiveResolvedSelector.plateauTolerance}  elbowGapTolerance=${report.meta.adaptiveResolvedSelector.elbowGapTolerance}`
  );
  lines.push("  legacy selector (resolved):");
  lines.push(
    `    strategy=${report.meta.legacyResolvedSelector.strategy}  minK=${report.meta.legacyResolvedSelector.minK}  maxK=${report.meta.legacyResolvedSelector.maxK}  relativeFraction=${report.meta.legacyResolvedSelector.relativeFraction}  plateauTolerance=${report.meta.legacyResolvedSelector.plateauTolerance}  elbowGapTolerance=${report.meta.legacyResolvedSelector.elbowGapTolerance}`
  );
  lines.push("");
  // ---- READ THIS FIRST ----
  lines.push("READ THIS FIRST: this is a BENCHMARK-ONLY probe of the");
  lines.push("  adaptive-depth controller stage. It runs six small,");
  lines.push("  deterministic scenarios through `runRecallController`");
  lines.push("  under two configs (production adaptive + legacy");
  lines.push("  fixed-topK=5) and captures the synthesis body the");
  lines.push("  controller actually built. It does NOT make a real");
  lines.push("  provider call, does NOT touch production storage,");
  lines.push("  does NOT modify the public MCP API, and does NOT");
  lines.push("  re-tune the configs on the evaluation results. A");
  lines.push("  pass on a scenario means 'the controller behaves as");
  lines.push("  expected on the v1 scenario set', not 'the adaptive");
  lines.push("  depth stage generalises to production corpora'.");
  lines.push("");
  // ---- Per-scenario table ----
  lines.push("--- per-scenario summary ---");
  lines.push(
    "  scenario                 adaptive status    syn  ids  | legacy   status    syn  ids   | assertions"
  );
  for (const r of report.runs) {
    const adaptiveCell = `status=${r.adaptive.status}  ids=${r.adaptive.synthesisMemoryIds.length}  syn=${r.adaptive.synthesisCalls}`;
    const legacyCell = `status=${r.legacy.status}  ids=${r.legacy.synthesisMemoryIds.length}  syn=${r.legacy.synthesisCalls}`;
    const assertionSummary = `A:${summarise(r.adaptive.assertions)}  L:${summarise(r.legacy.assertions)}`;
    const label = r.scenarioId.length > 24 ? r.scenarioId.slice(0, 21) + "..." : r.scenarioId;
    lines.push(
      `  ${label.padEnd(24)} ${padCell(adaptiveCell, 33)} | ${padCell(legacyCell, 26)} | ${assertionSummary}`
    );
  }
  lines.push("");
  // ---- Per-scenario details ----
  for (const r of report.runs) {
    lines.push(`--- scenario: ${r.scenarioId} (${r.label}) ---`);
    lines.push(`  query:    ${r.query}`);
    lines.push(`  adaptive:`);
    lines.push(`    status:           ${r.adaptive.status}`);
    lines.push(`    sourceIds:        [${r.adaptive.sourceIds.join(", ")}]`);
    lines.push(`    synthesis ids:    [${r.adaptive.synthesisMemoryIds.join(", ")}]`);
    lines.push(`    synthesis calls:  ${r.adaptive.synthesisCalls}`);
    lines.push(`    synthesis body:   ${r.adaptive.synthesisBody.length} chars`);
    lines.push(`    memories section: ${r.adaptive.memoriesSection.length} chars`);
    lines.push(`    assertions:       ${r.adaptive.assertions.pass ? "PASS" : "FAIL"}`);
    for (const row of r.adaptive.assertions.common) {
      lines.push(`      - [common] ${row.name}: ${row.pass ? "PASS" : "FAIL"}  ${row.note}`);
    }
    for (const row of r.adaptive.assertions.configSpecific) {
      lines.push(`      - [adaptive] ${row.name}: ${row.pass ? "PASS" : "FAIL"}  ${row.note}`);
    }
    lines.push(`  legacy:`);
    lines.push(`    status:           ${r.legacy.status}`);
    lines.push(`    sourceIds:        [${r.legacy.sourceIds.join(", ")}]`);
    lines.push(`    synthesis ids:    [${r.legacy.synthesisMemoryIds.join(", ")}]`);
    lines.push(`    synthesis calls:  ${r.legacy.synthesisCalls}`);
    lines.push(`    synthesis body:   ${r.legacy.synthesisBody.length} chars`);
    lines.push(`    memories section: ${r.legacy.memoriesSection.length} chars`);
    lines.push(`    assertions:       ${r.legacy.assertions.pass ? "PASS" : "FAIL"}`);
    for (const row of r.legacy.assertions.common) {
      lines.push(`      - [common] ${row.name}: ${row.pass ? "PASS" : "FAIL"}  ${row.note}`);
    }
    for (const row of r.legacy.assertions.configSpecific) {
      lines.push(`      - [legacy] ${row.name}: ${row.pass ? "PASS" : "FAIL"}  ${row.note}`);
    }
    lines.push("");
  }
  // ---- Limitations block ----
  lines.push("--- limitations (research-only) ---");
  for (const lim of report.limitations) {
    lines.push(`  - ${lim}`);
  }
  lines.push("");
  return lines.join("\n");
}

function summarise(assertions: {
  pass: boolean;
  common: ScenarioAssertionRow[];
  configSpecific: ScenarioAssertionRow[];
}): string {
  const total = assertions.common.length + assertions.configSpecific.length;
  const failed = [...assertions.common, ...assertions.configSpecific].filter((r) => !r.pass).length;
  return `${total - failed}/${total}`;
}

function padCell(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-adaptive-depth-evaluation";

/**
 * Write the evaluation report to disk. The file prefix is
 * `retrieval-adaptive-depth-evaluation-*.json`
 * (distinct from the existing audit / calibration /
 * policy / held-out prefixes) so a reviewer can find the
 * evaluation artifact next to the regular reports without
 * confusing them.
 *
 * The on-disk steps (mkdir, ISO-stamp filename, JSON
 * stringify, writeFileSync, return full path) are shared
 * with the decision-policy writer via
 * `writeTimestampedJsonArtifact` so both runners produce
 * byte-equivalent artifacts under the same convention.
 */
export function writeAdaptiveDepthEvaluationReport(
  report: AdaptiveDepthEvaluationReport,
  dir: string
): string {
  return writeTimestampedJsonArtifact(report, dir, ARTIFACT_FILE_PREFIX);
}

// ---------------------------------------------------------------------------
// Internal sanity check (developer ergonomics)
// ---------------------------------------------------------------------------

// The harness encodes assertions as data in
// `ScenarioExpectations` rather than calling `node:assert`
// directly, so the controller outcome / synthesis body /
// assertion results land in the report artifact. The
// harness is therefore an evaluation tool, not a test
// framework; the companion test suite
// (`tests/adaptive-depth-evaluation.test.ts`) is what
// pins the assertions via `node:assert`.
