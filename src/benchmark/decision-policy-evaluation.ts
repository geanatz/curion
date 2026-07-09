/**
 * Benchmark-only Memory Decision Engine evaluation harness
 * (v2).
 *
 * Background
 * ----------
 * The Memory Decision Engine (`src/decision/`) ships SHADOW MODE
 * ONLY in Phase 1. The adapter returns a structured decision on
 * the `decideRememberPolicyWithFallback` seam; the controller
 * observes it and never mutates persisted memory based on it.
 * The companion test suite (`tests/decision-engine.test.ts`)
 * pins the controller integration, the schema, and the parser
 * surface — but it does NOT exercise the engine's full action
 * vocabulary against a curated scenario set, and it does NOT
 * collect an artifact a reviewer can audit.
 *
 * Purpose
 * -------
 * This module closes that gap. It is a small, deterministic,
 * no-network evaluation harness that runs the REAL
 * `decideRememberPolicyWithFallback` adapter against a curated
 * set of synthetic scenarios, captures the structured decision
 * the adapter emits, checks the per-scenario expectations, and
 * emits a JSON artifact + human-readable summary.
 *
 * v2 expansion
 * ------------
 * The v2 scenario set supersedes the v1 sanity set. The harness
 * keeps the v1 contract (every scenario has a labelled
 * expectation; the harness never throws on expected failure
 * paths) and extends the report with:
 *
 *   - `scenarioSetVersion` stamp ("v2").
 *   - `category` per scenario
 *     (normal-memory-decisions / safety-privacy /
 *      lifecycle-time / robustness-traps).
 *   - `safetyCritical` per scenario, used to drive the
 *     safety-privacy gate.
 *   - per-action accuracy, per-reason accuracy, confusion
 *     matrix, target-memory Jaccard / IoU match,
 *     confidence buckets, provider-call stats, and an
 *     overall gates block.
 *
 * See `src/benchmark/decision/scenarios.ts` for the canonical
 * v2 scenario set and `src/benchmark/decision/metrics.ts` for
 * the report shape.
 *
 * Why the harness does NOT drive the controller end-to-end:
 *
 *   The decision adapter is invoked AFTER the controller's
 *   deterministic safety pre-check. Most of the engine's
 *   action vocabulary (`reject`, `clarify`, `invalidate`,
 *   `redact`) would never reach the engine under safe inputs —
 *   the controller short-circuits before the engine runs. To
 *   exercise the engine's full vocabulary we build evidence
 *   packets directly with a chosen `safetyClass` and feed
 *   them into the adapter, NOT through the controller's
 *   end-to-end pipeline. The packet still validates against
 *   the typed `RememberDecisionEvidencePacketSchema` so the
 *   harness exercises the same adapter code path the
 *   controller would use. This is documented in the scenario
 *   module header.
 *
 * What it captures per scenario:
 *
 *   - The captured `DecisionAdapterResult` (either the
 *     success shape with action / reason / confidence /
 *     id arrays / providerUsed / fallbackUsed / latencyMs /
 *     httpCalls, OR the failure shape with `kind`).
 *   - The per-expectation assertion rows the harness checked.
 *   - The per-scenario Jaccard (= IoU over id sets) on the
 *     scenario's `expected*Ids` block.
 *   - The provider-call inference (`repairAttempted`,
 *     `fallbackAttempted`).
 *
 * Scenarios
 * ---------
 * The harness ships the v2 curated scenario set (defined in
 * `BUILT_IN_DECISION_POLICY_SCENARIOS`) of 26 scenarios
 * across the four categories listed above. The v1 brief's
 * required axes are still covered; v2 adds multi-target
 * supersession, redundancy_by_content, redact, secret /
 * prompt-injection / unsafe-preference / mixed-sensitive
 * rejection paths, temporal replacement, current-vs-old
 * ambiguity, stale-but-not-replaced, irrelevant high-ranked
 * memory, fallback recovery after primary failure, always-
 * invalid provider output, false-supersession / false-
 * conflict traps, and the invalid-output-after-repair
 * trap.
 *
 * What it does NOT do
 * -------------------
 *   - It does NOT make any network call. The `fetchImpl`
 *     override is a local scripted implementation.
 *   - It does NOT touch production storage. The harness does
 *     not insert any memory rows; it builds evidence packets
 *     in-process.
 *   - It does NOT modify the controller's behavior, the
 *     public MCP API, the tool schemas, or the
 *     `DecisionAdapterOptions` public surface.
 *   - It does NOT activate decision actions. The captured
 *     `DecisionAdapterSuccess.value` is recorded on the
 *     report artifact but never applied to persisted
 *     memory.
 *
 * Live evaluation mode (manual opt-in)
 * ------------------------------------
 * In addition to the default scripted mode, the harness
 * supports a manual live-evaluation mode that drives the
 * REAL provider/model via the configured
 * `CURION_PRIMARY_*` / `CURION_FALLBACK_*` env config. The
 * live path is gated by TWO independent opt-in signals so it
 * is impossible to reach by accident:
 *
 *   1. `CURION_DECISION_EVAL_LIVE=1` env var must be set.
 *   2. The `--live` CLI flag must be passed (the runner
 *      refuses to enable live mode otherwise).
 *
 * In live mode the harness invokes
 * `decideRememberPolicyWithFallback` WITHOUT passing
 * `fetchImpl`, so the adapter's HTTP path uses the global
 * `fetch` against the user's real provider. The captured
 * decision is recorded on the artifact (with provider / model
 * / latency / httpCalls) but is NEVER applied to persisted
 * memory, the public MCP API, or any controller state. Live
 * mode does NOT activate the production decision engine: the
 * existing `CURION_REMEMBER_DECISION_MODE` activation gate
 * is untouched.
 *
 * The live-mode report carries a `live` metadata block that
 * records (without secrets):
 *   - the env opt-in flag presence,
 *   - the resolved provider / model / format / timeout /
 *     maxTokens config (API keys are NOT recorded; only
 *     `hasPrimaryApiKey` / `hasFallbackApiKey` booleans),
 *   - aggregate providerUsed / modelUsed counts,
 *   - the total live HTTP call count,
 *   - a reviewer-must-read-first warnings list (cost,
 *     provider-policy, latency, etc.).
 *
 * Scope (benchmark-only / research-only):
 *   The harness is read-only. It does not persist anything
 *   beyond the optional JSON artifact under
 *   `.curion/benchmark/`. The artifact prefix is
 *   `decision-policy-evaluation-`. The harness never
 *   activates the decision engine in production; the
 *   production activation gate is the existing
 *   `CURION_REMEMBER_DECISION_MODE` env var, and this
 *   harness does not modify it.
 */

import {
  type DecisionAdapterOptions,
  decideRememberPolicyWithFallback,
  loadDecisionAdapterConfig,
} from "../decision/adapter.js";
import { buildRememberDecisionEvidence } from "../decision/evidence.js";
import type {
  DecisionAdapterResult,
  DecisionAdapterSuccess,
  RememberDecisionEvidencePacket,
} from "../decision/types.js";
import { type SafetyClass, classifyInput } from "../safety/precheck.js";
import { writeTimestampedJsonArtifact } from "./_artifact.js";
import {
  okChatResponse,
  recordScriptedFetchCall,
  upstreamFailureResponse,
} from "./_scripted-fetch.js";
import {
  type DecisionPolicyEvaluationLiveBlock,
  type DecisionPolicyEvaluationMode,
  type DecisionPolicyEvaluationReport,
  type DecisionPolicyScenarioRunResult,
  buildDecisionPolicyEvaluationMetrics,
  jaccardBetween,
} from "./decision/metrics.js";
import {
  BUILT_IN_DECISION_POLICY_SCENARIOS,
  DECISION_POLICY_SCENARIO_SET_VERSION,
  type DecisionPolicyScenario,
  type DecisionPolicyScenarioCategory,
  type ScenarioExpectations,
} from "./decision/scenarios.js";
import type { ScriptedProviderSpec } from "./decision/spec.js";

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

/**
 * The evaluation's limitations / research-only block. The block
 * is surfaced on the artifact (`report.limitations`) and on the
 * human report.
 */
export const DECISION_POLICY_EVALUATION_LIMITATIONS: ReadonlyArray<string> = [
  `Synthetic-scenario evaluation (v2 scenario set, ${BUILT_IN_DECISION_POLICY_SCENARIOS.length} scenarios). The scenarios are hand-curated and exercise the adapter against small, deterministic evidence packets. A reviewer who reads a scenario-pass rate as 'the decision engine generalises to production traffic' is over-reading the result. The right reading is 'the adapter produces the expected structured decision on the v2 scenario set'.`,
  "No-network (scripted mode). The harness never makes a real provider call; the scripted fetch returns the canned responses in-process. A future experiment that adds a real provider call would invalidate the determinism contract.",
  'Scripted mode separates model-quality from provider-path scenarios. Each scenario carries an `evaluationScope: "model-quality" | "provider-path"` tag. The 21 model-quality scenarios drive `gates.modelQualityPassed`; the 5 provider-path scenarios drive `gates.providerPathPassed` and are reported separately. In scripted mode all 26 are expected to pass (scripted responses are designed that way); in live mode the provider-path gate is informational only — live providers typically succeed on the first call so the scripted-failure expectations are not exercised.',
  "v2.1 attribution split. The `modelQualityGate` reads `decisionQualityPass` per scenario (NOT the full `pass` conjunction) so a live provider that exercises a different call shape than the scripted expectation (e.g. httpCalls=1 instead of the scripted expected 2 because a live provider typically succeeds on the first call) does NOT fail the model-quality headline. Provider-path mismatches on model-quality scenarios are surfaced under `gates.modelQualityProviderPathMismatchScenarioIds` so a live reviewer can audit that the model was right while the harness state machine just took a different path. In scripted mode the mismatch list is always empty because the scripted fetches always honour the provider-path expectations.",
  "Adapter-driven, not controller-driven. The harness calls `decideRememberPolicyWithFallback` directly with constructed evidence packets. The controller's deterministic safety pre-check, related-memory seam, and post-insert relationship derivation are NOT exercised by this harness. The companion controller-integration test suite (`tests/decision-engine.test.ts`) covers those paths.",
  "Scenario expectations are expectations on the structured decision shape, NOT on user-visible behavior. The adapter's `ok: true` result is recorded on the report artifact but NEVER applied to persisted memory, public output, public structured content, or the MCP tool schema. Activation is reserved for Phase 2+ when the engine's action vocabulary is approved for execution.",
  `Frozen scenario set (version ${DECISION_POLICY_SCENARIO_SET_VERSION}). The v2 scenario set is the canonical reference set; a future v3 that adds new categories, axes, or replaces existing scenarios is a deliberate, visible change. The harness never re-tunes the scenario expectations on the evaluation results.`,
  "Benchmark-only / research-only. The evaluation does NOT modify the production `remember(text)` behavior, the public MCP API, the existing dev-set / audit / calibration / policy / held-out / adaptive-depth-evaluation report shapes. The artifact prefix is `decision-policy-evaluation-` and is separate from the held-out / dev-set / adaptive-depth artifacts.",
  "The scripted fetch is the only provider path (scripted mode). The harness wires a single `fetchImpl` override into the adapter's `DecisionAdapterOptions.fetchImpl` slot. Production code does not set this option. The companion controller-integration test suite asserts the seam is reserved for tests; this harness is one such test surface.",
  "Phase 1 only. The harness evaluates the remember-policy decision vocabulary. The recall-policy decision vocabulary (Phase 2+) is out of scope and is not exercised.",
  "Target-memory IDs in the prompt are the stable storage ids the controller emits (NOT positional indices). The prompt renders each related memory as `- id=N [kind] excerpt` so the model emits `id=N` values in `supersededIds` / `conflictsWithIds` / `redundantWithIds`. The harness pins these ids in its expectation blocks so a Jaccard of 1.0 means the model emitted the controller-side id values.",
];

/**
 * The live-mode-only limitations / warnings block. The
 * block is surfaced on the live artifact (`report.live.warnings`)
 * and on the human report. The strings are the reviewer-must-read
 * caveats: live mode is a manual, opt-in, cost-bearing
 * experiment and a successful adapter call is NOT a production
 * activation.
 */
export const DECISION_POLICY_EVALUATION_LIVE_WARNINGS: ReadonlyArray<string> = [
  "LIVE MODE — this run invoked the real configured provider/model with no `fetchImpl` override. Each HTTP call incurs cost (billed to the API key in your environment) and exercises your provider's policy / rate limits / content filter.",
  "Scenario set is the same curated v2 synthetic set used in scripted mode. The pass rate here is 'how the real configured model handles the curated synthetic evidence packets', NOT 'how the model generalises to production traffic'.",
  "Live mode is a manual, opt-in research probe. It does NOT activate the production decision engine. The `CURION_REMEMBER_DECISION_MODE` env var is unchanged and the captured structured decision is NEVER applied to persisted memory, public MCP output, or any controller state.",
  "API keys are NOT recorded on the artifact. The live block records provider presence (`hasPrimaryApiKey` / `hasFallbackApiKey` booleans) only — never the resolved key value. Inspect your local environment to verify keys.",
  "Latency and providerUsed / modelUsed counts in the live block reflect real provider behavior on the date of the run; a re-run on a different day may differ (model weights, routing, load).",
  "Live mode disables the scripted fetch. A live run is non-deterministic by construction; the report's `generatedAt` is the canonical timestamp a reviewer reads.",
];

// ---------------------------------------------------------------------------
// Live-mode opt-in gating
// ---------------------------------------------------------------------------

/**
 * Name of the env opt-in flag. Set to "1" to enable live mode.
 * The env flag is a NECESSARY but NOT SUFFICIENT condition for
 * live mode: the runner also requires the `--live` CLI flag,
 * and the harness function additionally requires an explicit
 * `mode: "live"` argument. A user who sets only the env var,
 * or only the CLI flag, still gets scripted mode (the runner
 * prints a notice).
 */
export const DECISION_POLICY_EVAL_LIVE_ENV = "CURION_DECISION_EVAL_LIVE";

/**
 * Pure helper: is the env opt-in flag set? Exported so the
 * CLI runner and the tests can both ask the same question.
 *
 * The check is intentionally narrow: only the exact string
 * "1" enables live mode. "true" / "yes" / "on" / any other
 * truthy value is REJECTED so an accidentally-set boolean
 * env var cannot enable live mode by surprise.
 */
export function isLiveOptInEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): boolean {
  return env[DECISION_POLICY_EVAL_LIVE_ENV] === "1";
}

/**
 * Pure helper: build the live-mode warnings list. The function
 * is exported so the runner can show the same warnings on stderr
 * (before the run) and on the human report (after the run).
 */
export function buildLiveWarnings(): ReadonlyArray<string> {
  return DECISION_POLICY_EVALUATION_LIVE_WARNINGS;
}

/**
 * Live-mode entry-point signature. The harness function and the
 * CLI runner share the same struct so the runner's gating logic
 * is the only place that decides whether to actually enable
 * live mode.
 */
export interface LiveOptInSignal {
  /** True iff `CURION_DECISION_EVAL_LIVE=1` was present at run start. */
  envOptInFlag: boolean;
  /**
   * The CLI args the runner saw (e.g. `["--live"]`). Empty
   * when the function is driven from a programmatic caller.
   */
  cliArgs: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Scripted fetch (private to the harness)
// ---------------------------------------------------------------------------

/**
 * A scripted `fetch` that returns canned responses based on the
 * scenario's `ScriptedProviderSpec`. The fetch records every
 * call's URL and body so a reviewer can audit the actual
 * provider-shape traffic.
 *
 * The per-call state machine is per-provider (primary first /
 * primary repair / fallback first / fallback repair). The
 * adapter drives which provider's call is being made (via the
 * URL the adapter passes to fetch), so this scripted fetch
 * discriminates by the URL rather than by a global call index.
 *
 * Discrimination by URL:
 *
 *   The adapter calls primary first via base URL
 *   `https://api.example.com/v1/chat/completions` and the
 *   fallback (when configured) via
 *   `https://api.fallback.example/v1/chat/completions`. The
 *   fetch handler routes each call to the correct provider's
 *   state machine based on whether the request URL contains
 *   the fallback host substring. This matches the harness's
 *   hardcoded base URLs below; a future reviewer who makes
 *   the base URLs a scenario-level field is a deliberate,
 *   visible change.
 */
interface ScriptedFetchHandle {
  fetchImpl: typeof fetch;
  /** Every call the scripted fetch saw, in order. */
  calls: Array<{ url: string; body: string }>;
  /**
   * Provider-path label for each call (in order):
   *   - `"primary-first"` / `"primary-repair"` for primary calls
   *   - `"fallback-first"` / `"fallback-repair"` for fallback calls
   * The labels let the harness distinguish "primary repair
   * was attempted" from "fallback first attempt succeeded",
   * since both events yield a 2-call httpCalls total.
   */
  paths: Array<"primary-first" | "primary-repair" | "fallback-first" | "fallback-repair">;
}

const FALLBACK_HOST_MARKER = "api.fallback.example";

function buildScriptedFetch(spec: ScriptedProviderSpec): ScriptedFetchHandle {
  const calls: Array<{ url: string; body: string }> = [];
  const paths: Array<"primary-first" | "primary-repair" | "fallback-first" | "fallback-repair"> =
    [];
  let primaryCallIndex = 0;
  let fallbackCallIndex = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const recorded = recordScriptedFetchCall(input, init);
    calls.push(recorded);

    // Discriminate by URL. If the URL contains the fallback
    // host, route to the fallback state machine; otherwise
    // route to the primary state machine. The harness sets
    // these base URLs verbatim; a reviewer who changes them
    // must update this marker too.
    const isFallback = recorded.url.includes(FALLBACK_HOST_MARKER);
    const response = isFallback
      ? resolveFallbackScriptedResponse(spec, fallbackCallIndex)
      : resolvePrimaryScriptedResponse(spec, primaryCallIndex);

    if (isFallback) {
      paths.push(fallbackCallIndex === 0 ? "fallback-first" : "fallback-repair");
      fallbackCallIndex += 1;
    } else {
      paths.push(primaryCallIndex === 0 ? "primary-first" : "primary-repair");
      primaryCallIndex += 1;
    }
    return response;
  };
  return { fetchImpl, calls, paths };
}

/**
 * Resolve the scripted response for a primary provider call
 * based on the primary-side call index:
 *   - 0: primary first call (first attempt)
 *   - 1: primary same-provider repair
 *   - >= 2: out-of-range; treat as hard failure so a mis-scoped
 *           spec surfaces cleanly.
 */
function resolvePrimaryScriptedResponse(spec: ScriptedProviderSpec, callIndex: number): Response {
  if (callIndex === 0) {
    if (spec.primaryHardFailure) return upstreamFailureResponse();
    if (typeof spec.primaryFirstResponse === "string") {
      return okChatResponse(spec.primaryFirstResponse);
    }
    return upstreamFailureResponse();
  }
  if (callIndex === 1) {
    if (spec.primaryRepairHardFailure) return upstreamFailureResponse();
    if (typeof spec.primaryRepairResponse === "string") {
      return okChatResponse(spec.primaryRepairResponse);
    }
    // No primary repair response scripted -> mirror "no repair
    // was provided" with an empty payload (parse failure).
    return okChatResponse("");
  }
  // Any further primary calls are out-of-spec; surface as a
  // hard failure so the harness's failure path runs cleanly.
  return upstreamFailureResponse();
}

/**
 * Resolve the scripted response for a fallback provider call
 * based on the fallback-side call index:
 *   - 0: fallback first call (first attempt)
 *   - 1: fallback same-provider repair
 *   - >= 2: out-of-range; treat as hard failure.
 */
function resolveFallbackScriptedResponse(spec: ScriptedProviderSpec, callIndex: number): Response {
  if (callIndex === 0) {
    const fb = spec.fallback;
    if (!fb) return upstreamFailureResponse();
    if (fb.hardFailure) return upstreamFailureResponse();
    if (typeof fb.firstResponse === "string") {
      return okChatResponse(fb.firstResponse);
    }
    return upstreamFailureResponse();
  }
  if (callIndex === 1) {
    const fb = spec.fallback;
    if (!fb) return upstreamFailureResponse();
    if (fb.repairHardFailure) return upstreamFailureResponse();
    if (typeof fb.repairResponse === "string") {
      return okChatResponse(fb.repairResponse);
    }
    return okChatResponse("");
  }
  return upstreamFailureResponse();
}

// ---------------------------------------------------------------------------
// Evidence packet builder
// ---------------------------------------------------------------------------

/**
 * Build the `RememberDecisionEvidencePacket` the adapter
 * receives for a scenario. The harness bypasses the controller
 * safety pre-check and writes the scenario's `safetyClass`
 * directly into the packet's `safety.safetyClass` field. The
 * deterministic signals (when present) are passed through.
 */
function buildScenarioEvidencePacket(
  scenario: DecisionPolicyScenario
): RememberDecisionEvidencePacket {
  // We always run the deterministic classifier so the
  // evidence packet's `rawInputLength` and `rawInputHash`
  // fields are derived from the real input string.
  const realSafety = classifyInput(scenario.rawInput);
  const built = buildRememberDecisionEvidence({
    rawInput: scenario.rawInput,
    safety: realSafety,
    related: scenario.related.map((r) => {
      const mapped: {
        id: number;
        kind?: string;
        memoryContent: string;
      } = {
        id: r.id,
        memoryContent: r.memoryContentExcerpt,
      };
      if (typeof r.kind === "string") {
        mapped.kind = r.kind;
      }
      return mapped;
    }),
    signals: scenario.signals,
  });
  return overlaySafetyClass(built, scenario.safetyClass);
}

/**
 * Overlay the scenario's chosen `safetyClass` onto the typed
 * packet.
 */
function overlaySafetyClass(
  packet: RememberDecisionEvidencePacket,
  safetyClass: SafetyClass
): RememberDecisionEvidencePacket {
  return {
    ...packet,
    safety: { ...packet.safety, safetyClass },
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

/**
 * Per-scenario captured-provider state. Only populated in
 * live mode (the scripted harness uses the
 * `ScriptedFetchHandle`'s URL labels instead). Exposed as
 * an internal helper so the live-mode aggregate counts are
 * computed from a single source of truth.
 */
interface PerScenarioLiveCaptures {
  primaryCallCount: number;
  repairCallCount: number;
  fallbackCallCount: number;
  fallbackRepairCallCount: number;
}

/**
 * A scripted `fetch` implementation backed by
 * `globalThis.fetch`. The wrapper exists so the live path
 * can `count` calls and attribute them to the primary /
 * repair / fallback / fallback-repair state machine without
 * touching the user's real `fetch` semantics. The wrapper is
 * installed in `runSingleScenario` only when `mode === "live"`
 * — production code never installs it.
 */
function buildLiveFetchCounter(): {
  fetchImpl: typeof fetch;
  reads: () => PerScenarioLiveCaptures;
} {
  let primaryCallCount = 0;
  let repairCallCount = 0;
  let fallbackCallCount = 0;
  let fallbackRepairCallCount = 0;
  // We attribute live calls by inspecting the URL + body the
  // adapter passes. The harness uses the same hardcoded
  // fallback host marker as the scripted harness so the
  // discrimination mirrors the scripted state machine.
  const fetchImpl: typeof fetch = async (input, init) => {
    const recorded = recordScriptedFetchCall(input, init);
    const url = recorded.url;
    const isFallback = url.includes(FALLBACK_HOST_MARKER);
    // We cannot tell "first attempt" from "repair" purely
    // from the URL on a single per-scenario run; we infer by
    // counting. The primary provider gets up to two calls
    // (first + repair); the fallback provider gets up to two
    // (first + repair). The order is primary first → primary
    // repair (only when called) → fallback first → fallback
    // repair (only when called). This mirrors the
    // `decideRememberPolicyWithFallback` flow exactly.
    const prior = primaryCallCount + repairCallCount + fallbackCallCount + fallbackRepairCallCount;
    const kind: "primary-first" | "primary-repair" | "fallback-first" | "fallback-repair" =
      !isFallback
        ? prior === 0
          ? "primary-first"
          : "primary-repair"
        : prior === primaryCallCount + repairCallCount
          ? "fallback-first"
          : "fallback-repair";
    if (kind === "primary-first") primaryCallCount += 1;
    else if (kind === "primary-repair") repairCallCount += 1;
    else if (kind === "fallback-first") fallbackCallCount += 1;
    else fallbackRepairCallCount += 1;
    return fetch(recorded.url, init as RequestInit);
  };
  return {
    fetchImpl,
    reads: () => ({
      primaryCallCount,
      repairCallCount,
      fallbackCallCount,
      fallbackRepairCallCount,
    }),
  };
}

/**
 * Run a single scenario end-to-end through
 * `decideRememberPolicyWithFallback`. Never throws on expected
 * failure paths.
 *
 * The `mode` parameter selects the provider path:
 *   - `"scripted"` (default) — wires the in-process scripted
 *     fetch and the test fake API keys. Identical to the v2
 *     scripted baseline; never makes a real HTTP call.
 *   - `"live"` — wires the user's configured
 *     `CURION_PRIMARY_*` / `CURION_FALLBACK_*` env config via
 *     `loadDecisionAdapterConfig`, installs a counter
 *     wrapper around `globalThis.fetch` so the harness can
 *     attribute live HTTP calls to primary / repair / fallback
 *     state machines, and DOES NOT pass `fetchImpl` to the
 *     adapter (the adapter then uses `globalThis.fetch`
 *     directly against the configured provider).
 */
async function runSingleScenario(
  scenario: DecisionPolicyScenario,
  args: {
    mode: DecisionPolicyEvaluationMode;
    envOptInFlag?: boolean;
  }
): Promise<{
  run: DecisionPolicyScenarioRunResult;
  liveCaptures?: PerScenarioLiveCaptures;
}> {
  const packet = buildScenarioEvidencePacket(scenario);
  const isLive = args.mode === "live";

  // The harness builds two distinct adapter-option shapes
  // depending on mode. Both shapes are documented and stable;
  // the v2 scripted contract is preserved bit-for-bit.
  let adapterOptions: DecisionAdapterOptions;
  let scripted: ScriptedFetchHandle | undefined;
  let liveCounter: ReturnType<typeof buildLiveFetchCounter> | undefined;
  if (isLive) {
    // Live mode: resolve provider config from the env, install
    // the counter wrapper around `globalThis.fetch`, and pass
    // it as the `fetchImpl` override (the wrapper itself calls
    // through to the real `globalThis.fetch`). The adapter's
    // behaviour in live mode mirrors the production code path
    // exactly except for the counter wrapper.
    const cfg = loadDecisionAdapterConfig();
    liveCounter = buildLiveFetchCounter();
    const liveOpts: DecisionAdapterOptions = {
      fetchImpl: liveCounter.fetchImpl,
    };
    // The harness passes through the env-resolved values so
    // the adapter's `decideRememberPolicyWithFallback`
    // receives the same config a production caller would.
    // We never record the API key value itself on the
    // artifact; only the boolean `hasPrimaryApiKey` /
    // `hasFallbackApiKey` presence flags are surfaced.
    if (cfg.primaryBaseUrl) liveOpts.primaryBaseUrl = cfg.primaryBaseUrl;
    if (cfg.primaryModel) liveOpts.primaryModel = cfg.primaryModel;
    if (cfg.primaryApiFormat) liveOpts.primaryApiFormat = cfg.primaryApiFormat;
    if (cfg.fallbackBaseUrl) liveOpts.fallbackBaseUrl = cfg.fallbackBaseUrl;
    if (cfg.fallbackModel) liveOpts.fallbackModel = cfg.fallbackModel;
    if (cfg.fallbackApiFormat) liveOpts.fallbackApiFormat = cfg.fallbackApiFormat;
    if (cfg.timeoutMs) liveOpts.timeoutMs = cfg.timeoutMs;
    if (cfg.maxTokens) liveOpts.maxTokens = cfg.maxTokens;
    adapterOptions = liveOpts;
  } else {
    scripted = buildScriptedFetch(scenario.scripted);
    adapterOptions = {
      fetchImpl: scripted.fetchImpl,
      primaryApiKey: "sk-test-primary-not-real-12345",
      primaryBaseUrl: "https://api.example.com/v1",
      primaryModel: "test/model-primary",
      primaryApiFormat: "openai-compatible",
      fallbackApiFormat: "openai-compatible",
    };
    if (scenario.scripted.fallback) {
      adapterOptions.fallbackApiKey = "sk-test-fallback-not-real-12345";
      adapterOptions.fallbackBaseUrl = "https://api.fallback.example/v1";
      adapterOptions.fallbackModel = "test/model-fallback";
    }
  }

  let adapterResult: DecisionAdapterResult;
  try {
    adapterResult = await decideRememberPolicyWithFallback(
      packet,
      scenario.rawInput,
      adapterOptions
    );
  } catch (err) {
    adapterResult = {
      ok: false,
      kind: "all-providers-failed",
      message: `adapter threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      httpCalls: 0,
    };
  }

  const expectationResult = evaluateExpectations(scenario.expect, adapterResult);
  const assertionRows = expectationResult.assertions;
  const pass = assertionRows.every((r) => r.pass);
  // v2.1 attribution split: per-group pass flags so the
  // `modelQualityGate` can be sourced from
  // `decisionQualityPass` (NOT the full `pass` conjunction)
  // when the live provider exercises a different call shape
  // than the scripted expectation. A scenario with no
  // `provider-path` assertions (every model-quality scenario
  // except the v2 robustness traps) yields
  // `providerPathPass === true` vacuously; a scenario with
  // no `decision-quality` assertions (the v2 robustness
  // trap scenarios whose outcome is a failure kind) yields
  // `decisionQualityPass === true` vacuously.
  const decisionQualityPass = assertionRows
    .filter((r) => r.group === "decision-quality")
    .every((r) => r.pass);
  const providerPathPass = assertionRows
    .filter((r) => r.group === "provider-path")
    .every((r) => r.pass);

  // Provider-path call inference.
  //   - Scripted mode: from the scripted-fetch URL labels.
  //   - Live mode: from the live counter wrapper reads.
  // Both paths produce the same boolean set so the per-scenario
  // result fields are stable across modes.
  let repairAttempted: boolean;
  let fallbackAttempted: boolean;
  if (isLive && liveCounter) {
    const caps = liveCounter.reads();
    repairAttempted = caps.repairCallCount > 0;
    fallbackAttempted = caps.fallbackCallCount > 0 || caps.fallbackRepairCallCount > 0;
  } else if (scripted) {
    const paths = scripted.paths;
    repairAttempted = paths.includes("primary-repair");
    fallbackAttempted = paths.includes("fallback-first") || paths.includes("fallback-repair");
  } else {
    repairAttempted = false;
    fallbackAttempted = false;
  }
  const category: DecisionPolicyScenarioCategory = scenario.category;
  const safetyCritical = scenario.safetyCritical ?? category === "safety-privacy";
  // Evaluation scope: defaults to "model-quality". A scenario
  // opts in to "provider-path" by setting `evaluationScope` on
  // its literal. The five scripted-failure scenarios
  // (`repair-recovers`, `primary-hard-failure-no-fallback`,
  // `fallback-recovery-after-primary-failure`,
  // `always-invalid-provider-output`,
  // `invalid-output-after-repair-still-invalid`) opt in so the
  // harness separates harness-state-machine failures from
  // real-model-quality failures.
  const evaluationScope = scenario.evaluationScope ?? "model-quality";

  // The expected ids for Jaccard computation, when the
  // scenario set them. If the adapter call failed, the
  // captured id arrays are all empty (no provider output).
  const capturedTargetIds = {
    supersededIds: adapterResult.ok ? [...adapterResult.value.supersededIds] : [],
    conflictsIds: adapterResult.ok ? [...adapterResult.value.conflictsWithIds] : [],
    redundantIds: adapterResult.ok ? [...adapterResult.value.redundantWithIds] : [],
  };

  let perScenarioJaccard: number | null = null;
  const supersedeExp = scenario.expect.expectedSupersededIds;
  const conflictsExp = scenario.expect.expectedConflictsIds;
  const redundantExp = scenario.expect.expectedRedundantIds;
  if (supersedeExp !== undefined || conflictsExp !== undefined || redundantExp !== undefined) {
    const jSup = jaccardBetween(supersedeExp ?? [], capturedTargetIds.supersededIds);
    const jCon = jaccardBetween(conflictsExp ?? [], capturedTargetIds.conflictsIds);
    const jRed = jaccardBetween(redundantExp ?? [], capturedTargetIds.redundantIds);
    // Micro mean across the three id arrays on this row.
    perScenarioJaccard = (jSup + jCon + jRed) / 3;
  }

  // The confusion-matrix row label the metrics builder keys
  // on. For success-expectation scenarios: the expected
  // action. For failure-expectation scenarios:
  // `<failed:<kind>>`. Otherwise: `<none>`.
  const confusionRowLabel =
    scenario.expect.action ??
    (scenario.expect.outcome && scenario.expect.outcome !== "ok"
      ? `<failed:${scenario.expect.outcome}>`
      : "<none>");

  let run: DecisionPolicyScenarioRunResult;
  if (adapterResult.ok) {
    run = {
      scenarioId: scenario.id,
      label: scenario.label,
      description: scenario.description,
      rawInput: scenario.rawInput,
      safetyClass: scenario.safetyClass,
      relatedCount: scenario.related.length,
      httpCalls: adapterResult.httpCalls,
      repairAttempted,
      fallbackAttempted,
      adapterOk: true as const,
      action: adapterResult.value.action,
      reason: adapterResult.value.reason,
      confidence: adapterResult.value.confidence,
      supersededIds: adapterResult.value.supersededIds,
      conflictsWithIds: adapterResult.value.conflictsWithIds,
      redundantWithIds: adapterResult.value.redundantWithIds,
      providerUsed: adapterResult.providerUsed,
      modelUsed: adapterResult.modelUsed,
      fallbackUsed: adapterResult.fallbackUsed,
      category,
      safetyCritical,
      evaluationScope,
      capturedTargetIds,
      targetMemoryJaccard: perScenarioJaccard,
      assertions: assertionRows,
      pass,
      decisionQualityPass,
      providerPathPass,
      expectedConfusionRowLabel: confusionRowLabel,
      ...(scenario.expect.action !== undefined ? { expectedAction: scenario.expect.action } : {}),
      ...(scenario.expect.reason !== undefined ? { expectedReason: scenario.expect.reason } : {}),
    };
  } else {
    run = {
      scenarioId: scenario.id,
      label: scenario.label,
      description: scenario.description,
      rawInput: scenario.rawInput,
      safetyClass: scenario.safetyClass,
      relatedCount: scenario.related.length,
      httpCalls: adapterResult.httpCalls,
      repairAttempted,
      fallbackAttempted,
      adapterOk: false,
      failureKind: adapterResult.kind,
      category,
      safetyCritical,
      evaluationScope,
      capturedTargetIds,
      targetMemoryJaccard: perScenarioJaccard,
      assertions: assertionRows,
      pass,
      decisionQualityPass,
      providerPathPass,
      expectedConfusionRowLabel: confusionRowLabel,
    };
  }
  return {
    run,
    ...(isLive && liveCounter ? { liveCaptures: liveCounter.reads() } : {}),
  };
}

/**
 * Evaluate the scenario's `expect` block against the captured
 * adapter result. Returns `{ assertions, expectedAction,
 * expectedReason, expectedConfusionRowLabel }` so the metrics
 * builder has the side-channel data it needs.
 *
 * v2.1: every assertion row carries a `group` tag so the
 * `modelQualityGate` can be sourced from `decision-quality`
 * assertions only. Provider-path assertions (`httpCalls`,
 * `fallbackUsed`, `providerUsed`) are tagged `"provider-path"`
 * and contribute to the `providerPathGate` only. This is the
 * key separation that lets the live-mode `modelQualityGate`
 * stay green when the live provider exercises a different
 * call shape than the scripted expectation (a live provider
 * typically succeeds on the first call, producing
 * httpCalls=1 instead of the scripted expected 2 or 4).
 */
function evaluateExpectations(
  expect: ScenarioExpectations,
  result: DecisionAdapterResult
): {
  assertions: Array<{
    name: string;
    description: string;
    pass: boolean;
    note: string;
    group: "decision-quality" | "provider-path";
  }>;
} {
  type Row = {
    name: string;
    description: string;
    pass: boolean;
    note: string;
    group: "decision-quality" | "provider-path";
  };
  const rows: Row[] = [];

  if (expect.outcome !== undefined) {
    if (expect.outcome === "ok") {
      const ok = result.ok;
      rows.push({
        name: "outcome",
        description: `adapter outcome must be "ok"`,
        pass: ok,
        note: ok ? "ok" : `got failure kind=${(result as { kind: string }).kind}`,
        group: "decision-quality",
      });
    } else {
      const ok = !result.ok && (result as { kind: string }).kind === expect.outcome;
      rows.push({
        name: "outcome",
        description: `adapter failure kind must be "${expect.outcome}"`,
        pass: ok,
        note: result.ok
          ? `got ok (action=${(result as DecisionAdapterSuccess).value.action})`
          : `got failure kind=${(result as { kind: string }).kind}`,
        group: "decision-quality",
      });
    }
  }

  if (!result.ok) {
    return { assertions: rows };
  }
  const success = result as DecisionAdapterSuccess;
  const v = success.value;

  if (expect.action !== undefined) {
    rows.push({
      name: "action",
      description: `decision.action must be "${expect.action}"`,
      pass: v.action === expect.action,
      note: `got "${v.action}"`,
      group: "decision-quality",
    });
  }

  if (expect.reason !== undefined) {
    rows.push({
      name: "reason",
      description: `decision.reason must be "${expect.reason}"`,
      pass: v.reason === expect.reason,
      note: `got "${v.reason}"`,
      group: "decision-quality",
    });
  }

  if (expect.confidenceMin !== undefined) {
    rows.push({
      name: "confidenceMin",
      description: `decision.confidence must be >= ${expect.confidenceMin}`,
      pass: v.confidence >= expect.confidenceMin,
      note: `got ${v.confidence.toFixed(2)}`,
      group: "decision-quality",
    });
  }
  if (expect.confidenceMax !== undefined) {
    rows.push({
      name: "confidenceMax",
      description: `decision.confidence must be <= ${expect.confidenceMax}`,
      pass: v.confidence <= expect.confidenceMax,
      note: `got ${v.confidence.toFixed(2)}`,
      group: "decision-quality",
    });
  }

  // Presence assertions.
  if (expect.targetIdInSuperseded !== undefined) {
    const id = expect.targetIdInSuperseded;
    rows.push({
      name: "targetIdInSuperseded",
      description: `supersededIds must include ${id}`,
      pass: v.supersededIds.includes(id),
      note: v.supersededIds.includes(id)
        ? "present"
        : `missing (got [${v.supersededIds.join(", ")}])`,
      group: "decision-quality",
    });
  }
  if (expect.targetIdInConflicts !== undefined) {
    const id = expect.targetIdInConflicts;
    rows.push({
      name: "targetIdInConflicts",
      description: `conflictsWithIds must include ${id}`,
      pass: v.conflictsWithIds.includes(id),
      note: v.conflictsWithIds.includes(id)
        ? "present"
        : `missing (got [${v.conflictsWithIds.join(", ")}])`,
      group: "decision-quality",
    });
  }
  if (expect.targetIdInRedundant !== undefined) {
    const id = expect.targetIdInRedundant;
    rows.push({
      name: "targetIdInRedundant",
      description: `redundantWithIds must include ${id}`,
      pass: v.redundantWithIds.includes(id),
      note: v.redundantWithIds.includes(id)
        ? "present"
        : `missing (got [${v.redundantWithIds.join(", ")}])`,
      group: "decision-quality",
    });
  }

  // Negative assertions: NONE of the listed ids appear in the
  // captured id array.
  if (expect.targetIdNotInSuperseded !== undefined) {
    const ids = expect.targetIdNotInSuperseded;
    const offenders = ids.filter((id) => v.supersededIds.includes(id));
    rows.push({
      name: "targetIdNotInSuperseded",
      description: `supersededIds must NOT include any of [${ids.join(", ")}]`,
      pass: offenders.length === 0,
      note: offenders.length === 0 ? "clear" : `unexpected ids present: [${offenders.join(", ")}]`,
      group: "decision-quality",
    });
  }
  if (expect.targetIdNotInConflicts !== undefined) {
    const ids = expect.targetIdNotInConflicts;
    const offenders = ids.filter((id) => v.conflictsWithIds.includes(id));
    rows.push({
      name: "targetIdNotInConflicts",
      description: `conflictsWithIds must NOT include any of [${ids.join(", ")}]`,
      pass: offenders.length === 0,
      note: offenders.length === 0 ? "clear" : `unexpected ids present: [${offenders.join(", ")}]`,
      group: "decision-quality",
    });
  }
  if (expect.targetIdNotInRedundant !== undefined) {
    const ids = expect.targetIdNotInRedundant;
    const offenders = ids.filter((id) => v.redundantWithIds.includes(id));
    rows.push({
      name: "targetIdNotInRedundant",
      description: `redundantWithIds must NOT include any of [${ids.join(", ")}]`,
      pass: offenders.length === 0,
      note: offenders.length === 0 ? "clear" : `unexpected ids present: [${offenders.join(", ")}]`,
      group: "decision-quality",
    });
  }

  // Expected-id-array sets (Jaccard / IoU input). These do
  // NOT contribute a per-assertion row; the per-scenario
  // Jaccard is computed by the harness and surfaced on the run
  // result's `targetMemoryJaccard` field.
  void expect.expectedSupersededIds;
  void expect.expectedConflictsIds;
  void expect.expectedRedundantIds;

  // Provider-path assertions. Tagged `provider-path` so they
  // contribute to the `providerPathGate` only — NOT to the
  // `modelQualityGate` headline. In live mode a live provider
  // may legitimately make fewer HTTP calls than the scripted
  // expectation (typically 1 instead of 2 or 4 because a live
  // provider usually succeeds on the first call), in which
  // case these assertions fail but `decisionQualityPass` is
  // the headline that matters and stays green.
  if (expect.httpCalls !== undefined) {
    rows.push({
      name: "httpCalls",
      description: `adapter.httpCalls must equal ${expect.httpCalls}`,
      pass: success.httpCalls === expect.httpCalls,
      note: `got ${success.httpCalls}`,
      group: "provider-path",
    });
  }

  if (expect.providerUsed !== undefined) {
    rows.push({
      name: "providerUsed",
      description: `providerUsed must be "${expect.providerUsed}"`,
      pass: success.providerUsed === expect.providerUsed,
      note: `got "${success.providerUsed}"`,
      group: "provider-path",
    });
  }

  if (expect.fallbackUsed !== undefined) {
    rows.push({
      name: "fallbackUsed",
      description: `fallbackUsed must be ${expect.fallbackUsed ? "true" : "false"}`,
      pass: success.fallbackUsed === expect.fallbackUsed,
      note: `got ${success.fallbackUsed ? "true" : "false"}`,
      group: "provider-path",
    });
  }

  return { assertions: rows };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Error thrown when the caller asks for live mode without the
 * required opt-in. The runner surfaces this as a clear
 * "live mode is opt-in" failure so a user who sets the env
 * flag without the CLI flag (or vice versa) gets an
 * unambiguous error instead of a silent scripted fallback.
 */
export class LiveOptInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveOptInRequiredError";
  }
}

/**
 * Public entry point: run the full decision-policy
 * evaluation. Async because the adapter is async.
 *
 * Mode selection:
 *   - `args.mode === "scripted"` (default): scripted fetch
 *     override, no network, deterministic, identical to the
 *     v2 scripted baseline.
 *   - `args.mode === "live"`: real provider call against the
 *     user's configured `CURION_PRIMARY_*` / `CURION_FALLBACK_*`
 *     env config. Requires `args.envOptInFlag === true` AND
 *     `args.cliArgs` containing `"--live"`. The function
 *     throws `LiveOptInRequiredError` otherwise so the live
 *     path is impossible to reach accidentally.
 *
 * The function is the canonical entry point for both the CLI
 * runner and the test suite.
 */
export async function runDecisionPolicyEvaluation(
  args: {
    scenarios?: ReadonlyArray<DecisionPolicyScenario>;
    mode?: DecisionPolicyEvaluationMode;
    envOptInFlag?: boolean;
    cliArgs?: ReadonlyArray<string>;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  } = {}
): Promise<DecisionPolicyEvaluationReport> {
  const mode: DecisionPolicyEvaluationMode = args.mode ?? "scripted";
  const envOptInFlag = args.envOptInFlag ?? isLiveOptInEnv(args.env ?? process.env);
  const cliArgs = args.cliArgs ?? [];

  // Live-mode gating. BOTH signals must be present:
  //   1. `CURION_DECISION_EVAL_LIVE=1` env flag.
  //   2. `--live` CLI flag.
  // Either alone is a hard error (no silent fallback to
  // scripted). The runner ALSO prints a notice on stderr so
  // a user who set one but not the other is told which signal
  // is missing.
  if (mode === "live") {
    const cliHasLive = cliArgs.includes("--live");
    if (!envOptInFlag || !cliHasLive) {
      const missing: string[] = [];
      if (!envOptInFlag) missing.push(`env ${DECISION_POLICY_EVAL_LIVE_ENV}=1`);
      if (!cliHasLive) missing.push("CLI --live flag");
      throw new LiveOptInRequiredError(
        `decision-policy live evaluation requires BOTH opt-in signals. ` +
          `Missing: ${missing.join(" AND ")}. ` +
          `Live mode is impossible to reach accidentally. ` +
          `Set ${DECISION_POLICY_EVAL_LIVE_ENV}=1 and pass --live.`
      );
    }
  }

  const scenarios = args.scenarios ?? BUILT_IN_DECISION_POLICY_SCENARIOS;
  const runs: DecisionPolicyScenarioRunResult[] = [];
  const providerUsedCounts: Record<string, number> = Object.create(null);
  const modelUsedCounts: Record<string, number> = Object.create(null);
  let liveCallCount = 0;
  for (const scenario of scenarios) {
    const { run, liveCaptures } = await runSingleScenario(scenario, {
      mode,
      ...(mode === "live" ? { envOptInFlag } : {}),
    });
    runs.push(run);
    if (mode === "live" && run.adapterOk) {
      if (run.providerUsed) {
        providerUsedCounts[run.providerUsed] = (providerUsedCounts[run.providerUsed] ?? 0) + 1;
      }
      if (run.modelUsed) {
        modelUsedCounts[run.modelUsed] = (modelUsedCounts[run.modelUsed] ?? 0) + 1;
      }
    }
    if (mode === "live" && liveCaptures) {
      liveCallCount +=
        liveCaptures.primaryCallCount +
        liveCaptures.repairCallCount +
        liveCaptures.fallbackCallCount +
        liveCaptures.fallbackRepairCallCount;
    } else {
      liveCallCount += run.httpCalls;
    }
  }

  // Live metadata block. The snapshot intentionally omits
  // any API key material — only boolean presence flags are
  // recorded.
  let liveBlock: DecisionPolicyEvaluationLiveBlock | undefined;
  if (mode === "live") {
    const cfg = loadDecisionAdapterConfig();
    liveBlock = {
      optInEnvPresent: envOptInFlag,
      optInCliArgs: cliArgs.filter((a) => a === "--live"),
      providerConfigSnapshot: {
        primaryBaseUrl: cfg.primaryBaseUrl,
        primaryModel: cfg.primaryModel,
        primaryApiFormat: cfg.primaryApiFormat,
        primaryProviderLabel: cfg.primaryProviderLabel,
        fallbackBaseUrl: cfg.fallbackBaseUrl,
        fallbackModel: cfg.fallbackModel,
        fallbackApiFormat: cfg.fallbackApiFormat,
        fallbackProviderLabel: cfg.fallbackProviderLabel,
        timeoutMs: cfg.timeoutMs,
        maxTokens: cfg.maxTokens,
        hasPrimaryApiKey: cfg.primaryApiKey.length > 0,
        hasFallbackApiKey: cfg.fallbackApiKey.length > 0,
      },
      providerUsedCounts,
      modelUsedCounts,
      liveCallCount,
      warnings: buildLiveWarnings(),
    };
  }

  const metrics = buildDecisionPolicyEvaluationMetrics(runs, {
    mode,
    ...(liveBlock ? { liveBlock } : {}),
  });
  return {
    generatedAt: new Date().toISOString(),
    scenarioSetVersion: DECISION_POLICY_SCENARIO_SET_VERSION,
    evaluationMode: mode,
    meta: metrics.meta,
    categories: metrics.categories,
    scopes: metrics.scopes,
    actionHistogram: metrics.actionHistogram,
    reasonHistogram: metrics.reasonHistogram,
    perActionAccuracy: metrics.perActionAccuracy,
    perReasonAccuracy: metrics.perReasonAccuracy,
    confusionMatrix: metrics.confusionMatrix,
    targetMemoryMatch: metrics.targetMemoryMatch,
    confidenceBuckets: metrics.confidenceBuckets,
    providerCallStats: metrics.providerCallStats,
    safetyPrivacyGate: metrics.safetyPrivacyGate,
    modelQualityGate: metrics.modelQualityGate,
    providerPathGate: metrics.providerPathGate,
    gates: metrics.gates,
    runs,
    limitations: DECISION_POLICY_EVALUATION_LIMITATIONS,
    ...(liveBlock ? { live: liveBlock } : {}),
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "decision-policy-evaluation";

/**
 * Write the evaluation report to disk. The file prefix is
 * `decision-policy-evaluation-*.json` (distinct from the existing
 * audit / calibration / policy / held-out / adaptive-depth
 * prefixes).
 */
export function writeDecisionPolicyEvaluationReport(
  report: DecisionPolicyEvaluationReport,
  dir: string
): string {
  return writeTimestampedJsonArtifact(report, dir, ARTIFACT_FILE_PREFIX);
}

// Re-export the human formatter, scenario helpers, and types
// from the metrics and scenario modules so a downstream
// consumer can `import { format..., DecisionPolicyScenario }`
// from this entry point.
export {
  formatDecisionPolicyEvaluationReport,
  type DecisionPolicyEvaluationReport,
  type DecisionPolicyScenarioRunResult,
  type DecisionPolicyAssertionRow,
  type DecisionPolicyEvaluationMode,
  type DecisionPolicyEvaluationLiveBlock,
} from "./decision/metrics.js";
export type {
  DecisionPolicyScenario,
  DecisionPolicyScenarioCategory,
  DecisionPolicyEvaluationScope,
  ScenarioExpectations,
  ScenarioRelatedMemory,
} from "./decision/scenarios.js";
export {
  DECISION_POLICY_SCENARIO_CATEGORIES,
  DECISION_POLICY_SCENARIO_SET_VERSION,
  DECISION_POLICY_EVALUATION_SCOPES,
} from "./decision/scenarios.js";
export type { ScriptedProviderSpec } from "./decision/spec.js";
export { BUILT_IN_DECISION_POLICY_SCENARIOS } from "./decision/scenarios.js";
// Also re-export for ergonomic Action / Reason typing.
export type { RememberDecisionAction, RememberDecisionReason } from "../decision/types.js";
