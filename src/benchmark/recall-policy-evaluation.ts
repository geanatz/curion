/**
 * Benchmark-only recall-policy evaluation harness (v1).
 *
 * Background
 * ----------
 * The Memory Decision Engine (`src/decision/`) ships SHADOW MODE
 * ONLY in Phase 1. The recall-policy decision vocabulary
 * (structured status + sourceIds + reason + pointer arrays)
 * does NOT yet exist as a production code path. A future
 * phase may add a recall-policy adapter analogous to the
 * decision adapter.
 *
 * Purpose
 * -------
 * This module is a small, deterministic, no-network
 * evaluation harness that runs a benchmark-only adapter
 * against a curated v1 scenario set, captures the captured
 * decision, evaluates the per-scenario expectations, and
 * emits a JSON artifact + human-readable summary.
 *
 * v1 contract
 * -----------
 * The v1 scenario set (16 scenarios) covers the brief's
 * required recall-side rubric:
 *
 *   - 3 answerable (direct, paraphrase, multi-hop),
 *   - 3 no-memory / weak-match (no-relevant, thin-related, refusal),
 *   - 3 ambiguity (conflicting, unclear, multiple-targets),
 *   - 3 lifecycle (superseded-hidden, current-truth, false-premise),
 *   - 4 robustness (irrelevant-high-ranked, malformed-answer,
 *     always-invalid, refusal-shape-valid).
 *
 * The harness is benchmark-only / research-only. It:
 *
 *   - does NOT touch production storage,
 *   - does NOT call the production recall controller,
 *   - does NOT mutate the public MCP `recall` tool behavior,
 *   - does NOT install / activate a production recall-policy
 *     decision engine (the production recall-policy engine does
 *     not yet exist; this benchmark runs a benchmark-only
 *     adapter as a research probe ahead of one).
 *
 * The harness wires a scripted `fetch` override into the
 * benchmark-only adapter's `fetchImpl` seam (the same seam
 * the production recall-synthesis adapter exposes for tests).
 * The scripted fetch returns canned responses in-process; no
 * live network.
 *
 * What it captures per scenario
 * -----------------------------
 *   - The captured `RecallPolicyAdapterResult` (either the
 *     success shape with status / reason / sourceIds /
 *     confidence / httpCalls, OR the failure shape with
 *     `kind`).
 *   - The per-expectation assertion rows the harness checked.
 *   - The per-scenario Jaccard (= IoU over id sets) on the
 *     scenario's `expectedSourceIds` block.
 *   - The provider-call inference (`repairAttempted`,
 *     `fallbackAttempted`).
 *
 * What it does NOT do
 * -------------------
 *   - It does NOT make any network call. The `fetchImpl`
 *     override is a local scripted implementation.
 *   - It does NOT touch production storage.
 *   - It does NOT modify the public MCP API, the public MCP
 *     tool schema, or the public `structuredContent` shape.
 *   - It does NOT activate any production recall-policy
 *     decision engine (none exists); the captured structured
 *     decision is recorded on the report but never applied to
 *     persisted memory or any controller state.
 *
 * Scope (benchmark-only / research-only):
 *   The harness is read-only. It does not persist anything
 *   beyond the optional JSON artifact under
 *   `.curion/benchmark/`. The artifact prefix is
 *   `recall-policy-evaluation-`. The harness never activates
 *   the recall-policy decision vocabulary in production.
 */

import { writeTimestampedJsonArtifact } from "./_artifact.js";
import {
  okChatResponse,
  recordScriptedFetchCall,
  upstreamFailureResponse,
} from "./_scripted-fetch.js";
import {
  type RecallPolicyCapturedTargetIds,
  type RecallPolicyEvaluationReport,
  type RecallPolicyScenarioRunResult,
  buildRecallPolicyEvaluationMetrics,
  jaccardBetween,
} from "./recall/metrics.js";
import {
  BUILT_IN_RECALL_POLICY_SCENARIOS,
  RECALL_POLICY_SCENARIO_SET_VERSION,
  type RecallPolicyExpectations,
  type RecallPolicyReason,
  type RecallPolicyScenario,
  type RecallPolicyScenarioCategory,
  type RecallPolicyStatus,
} from "./recall/scenarios.js";
import type { ScriptedRecallProviderSpec } from "./recall/spec.js";

// ---------------------------------------------------------------------------
// Limitations
// ---------------------------------------------------------------------------

/**
 * The evaluation's limitations / research-only block. The
 * block is surfaced on the artifact (`report.limitations`)
 * and on the human report.
 */
export const RECALL_POLICY_EVALUATION_LIMITATIONS: ReadonlyArray<string> = [
  `Synthetic-scenario evaluation (v1 scenario set, ${BUILT_IN_RECALL_POLICY_SCENARIOS.length} scenarios). The scenarios are hand-curated and exercise a benchmark-only adapter against small, deterministic evidence packets. A reviewer who reads a scenario-pass rate as 'the recall-policy decision engine generalises to production traffic' is over-reading the result. The right reading is 'the benchmark-only adapter produces the expected structured decision on the v1 scenario set'.`,
  "No-network (scripted mode). The harness never makes a real provider call; the scripted fetch returns the canned responses in-process. A future live mode would invalidate the determinism contract and is intentionally NOT exposed in v1 (the production recall-policy engine does not yet exist).",
  "Benchmark-only adapter, not a production adapter. The recall-policy decision vocabulary does NOT yet exist as a production code path; v1 ships a benchmark-only adapter that consumes canned JSON decisions via a scripted fetch. A future Phase that adds a production recall-policy adapter can lift the benchmark-only adapter's evidence-packet / scripted-fetch / expectation-evaluator wiring into a server-internal module without changing the v1 scenario expectations.",
  "Adapter-driven, not controller-driven. The harness exercises a benchmark-only adapter directly with constructed evidence packets. The production recall controller's lexical ranker, adaptive-depth selector, and synthesis-validation reroute are NOT exercised by this harness. The companion adaptive-depth evaluation (`benchmark:retrieval:adaptive-depth`) and the recall-mvp controller test suite cover those paths.",
  "Scenario expectations are expectations on the structured decision shape, NOT on user-visible behavior. The adapter's `ok: true` result is recorded on the report artifact but NEVER applied to persisted memory, public output, public `structuredContent`, or the MCP `recall` tool schema. The recall controller's behavior, public message projection, and stored state are unchanged.",
  `Frozen scenario set (version ${RECALL_POLICY_SCENARIO_SET_VERSION}). The v1 scenario set is the canonical reference set; a future v2 that adds new categories, axes, or replaces existing scenarios is a deliberate, visible change. The harness never re-tunes the scenario expectations on the evaluation results.`,
  "Benchmark-only / research-only. The evaluation does NOT modify the production `recall(text)` behavior, the public MCP API, the existing dev-set / audit / calibration / policy / held-out / adaptive-depth-evaluation report shapes. The artifact prefix is `recall-policy-evaluation-` and is separate from the held-out / dev-set / adaptive-depth artifacts.",
  "The scripted fetch is the only provider path (scripted mode). The harness wires a single `fetchImpl` override into the benchmark-only adapter. No live mode is exposed in v1; the `benchmark:decision-policy-evaluation:live` opt-in is NOT extended to recall-policy in this pass.",
  "Target-memory IDs in `expectedSourceIds` / `sourceIdInAnswer` / `sourceIdNotInAnswer` are the stable storage ids the production recall controller would emit (NOT positional indices). The harness pins these ids in its expectation blocks so a Jaccard of 1.0 means the model emitted the controller-side id values.",
  "Abstention gate attribution. The `abstentionGate` reads `pass` per scenario (NOT the `decisionQualityPass`-only attribution used in the decision-policy v2.1 split). The recall-policy benchmark does not expose a live mode in v1 so the provider-path vs decision-quality attribution split is unnecessary — every scripted-failure scenario exercises scripted determinism, and a live provider is not in scope.",
  "Safety gate is currently informational. The v1 set does not exercise a `safety` category (the recall-policy adapter is benchmark-only and does not process user-supplied input through a safety pre-check). The `safetyGate` block is reported for forward compatibility and passes vacuously when 0 safety-critical scenarios are present. A future v2 that adds `secret` / `prompt-injection`-style recall scenarios can populate the gate.",
];

// ---------------------------------------------------------------------------
// Scripted fetch (private to the harness)
// ---------------------------------------------------------------------------

/**
 * A scripted `fetch` that returns canned responses based on
 * the scenario's `ScriptedRecallProviderSpec`. The fetch
 * records every call's URL and body so a reviewer can audit
 * the actual provider-shape traffic.
 *
 * The per-call state machine mirrors the production recall
 * adapter's primary → repair → fallback → fallback-repair
 * flow. Discrimination is done by URL (fallback host marker)
 * to mirror the decision-policy harness exactly.
 */
interface ScriptedFetchHandle {
  fetchImpl: typeof fetch;
  /** Every call the scripted fetch saw, in order. */
  calls: Array<{ url: string; body: string }>;
  /**
   * Provider-path label for each call (in order):
   *   - `"primary-first"` / `"primary-repair"` for primary calls
   *   - `"fallback-first"` / `"fallback-repair"` for fallback calls
   */
  paths: Array<"primary-first" | "primary-repair" | "fallback-first" | "fallback-repair">;
}

const FALLBACK_HOST_MARKER = "api.fallback-recall.example";

function buildScriptedFetch(spec: ScriptedRecallProviderSpec): ScriptedFetchHandle {
  const calls: Array<{ url: string; body: string }> = [];
  const paths: Array<"primary-first" | "primary-repair" | "fallback-first" | "fallback-repair"> =
    [];
  let primaryCallIndex = 0;
  let fallbackCallIndex = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const recorded = recordScriptedFetchCall(input, init);
    calls.push(recorded);

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

function resolvePrimaryScriptedResponse(
  spec: ScriptedRecallProviderSpec,
  callIndex: number
): Response {
  if (callIndex === 0) {
    if (spec.primaryHardFailure) return upstreamFailureResponse();
    if (typeof spec.primaryResponse === "string") {
      return okChatResponse(spec.primaryResponse);
    }
    return upstreamFailureResponse();
  }
  if (callIndex === 1) {
    if (typeof spec.repairResponse === "string") {
      return okChatResponse(spec.repairResponse);
    }
    return okChatResponse("");
  }
  return upstreamFailureResponse();
}

function resolveFallbackScriptedResponse(
  spec: ScriptedRecallProviderSpec,
  callIndex: number
): Response {
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
    if (typeof fb.repairResponse === "string") {
      return okChatResponse(fb.repairResponse);
    }
    return okChatResponse("");
  }
  return upstreamFailureResponse();
}

// ---------------------------------------------------------------------------
// Benchmark-only adapter (private to the harness)
// ---------------------------------------------------------------------------

/**
 * Captured adapter success decision. The benchmark-only
 * adapter parses the canned provider response into a typed
 * `RecallPolicyDecision` shape the harness's expectation
 * evaluator consumes.
 *
 * This shape is intentionally minimal: it mirrors the
 * production `RecallOutcome` status union plus the pointer
 * arrays a future production recall-policy adapter would
 * need (conflictIds / supersededIds / olderVariantIds).
 * Forward-looking fields are typed so a future migration
 * does not require a schema change.
 */
export interface RecallPolicyDecisionSuccess {
  ok: true;
  value: {
    status: RecallPolicyStatus;
    reason: RecallPolicyReason;
    sourceIds: number[];
    conflictIds: number[];
    supersededIds: number[];
    olderVariantIds: number[];
    confidence: number;
    notes?: string;
  };
  httpCalls: number;
}

export interface RecallPolicyDecisionFailure {
  ok: false;
  kind: "missing-config" | "invalid-input" | "invalid-output" | "all-providers-failed";
  message: string;
  httpCalls: number;
}

export type RecallPolicyAdapterResult = RecallPolicyDecisionSuccess | RecallPolicyDecisionFailure;

/**
 * Benchmark-only recall-policy adapter. Drives the
 * scripted fetch under the same primary → repair →
 * fallback → fallback-repair state machine the production
 * recall synthesis adapter uses, parses the canned
 * response into a `RecallPolicyDecision` JSON shape, and
 * returns a typed `RecallPolicyAdapterResult`.
 *
 * The function is benchmark-only:
 *
 *   - It NEVER calls a real provider.
 *   - It NEVER touches production storage.
 *   - It NEVER mutates the public MCP API, the public MCP
 *     tool schema, or the recall controller's behavior.
 *   - It is consumed ONLY by the recall-policy evaluation
 *     harness and its companion test suite.
 *
 * The state machine is shaped after the production recall
 * adapter's behaviour (primary hard failure → fallback
 * first → fallback repair → all-providers-failed). The
 * parser is intentionally minimal: it tolerates the
 * `\`\`\`json ... \`\`\`` fenced form the production
 * memory-analysis and decision adapters tolerate, then
 * extracts a JSON object via balanced-brace search, and
 * finally runs a strict Zod-style shape check.
 *
 * URL discrimination:
 *
 *   The adapter drives the scripted-fetch state machine by
 *   targeting distinct URLs per call: primary calls hit
 *   `https://api.recall-policy-benchmark.example/v1` and
 *   fallback calls hit `https://api.fallback-recall.example/v1`.
 *   The fetch helper discriminates by URL via the
 *   `FALLBACK_HOST_MARKER` substring and routes to the
 *   corresponding state machine (see `buildScriptedFetch`).
 *   This matches the canonical decision-policy harness shape.
 */
export async function runBenchmarkOnlyRecallPolicyAdapter(
  scenario: RecallPolicyScenario,
  fetchImpl: typeof fetch
): Promise<RecallPolicyAdapterResult> {
  // Always 1 call per scenario in scripted mode, with
  // up to 3 additional calls on the repair / fallback state
  // machine.
  const PRIMARY_URL = "https://api.recall-policy-benchmark.example/v1";
  const FALLBACK_URL = "https://api.fallback-recall.example/v1";
  let httpCalls = 0;
  const callProvider = async (url: string): Promise<Response> => {
    httpCalls += 1;
    return fetchImpl(url, {
      method: "POST",
      body: JSON.stringify({
        query: scenario.query,
        related: scenario.related.map((r) => r.memoryContentExcerpt),
      }),
    });
  };

  // Primary first.
  const primaryResponse = await callProvider(PRIMARY_URL);
  if (primaryResponse.status >= 500) {
    // Hard failure path: try fallback if configured.
    const fbSpec = scenario.scripted.fallback;
    if (fbSpec) {
      const fallbackResponse = await callProvider(FALLBACK_URL);
      const parsed = await safeParseRecallPolicyDecision(fallbackResponse);
      if (parsed.ok) {
        return { ok: true, value: parsed.value, httpCalls };
      }
      // Repair on fallback.
      const repairResponse = await callProvider(FALLBACK_URL);
      const parsedRepair = await safeParseRecallPolicyDecision(repairResponse);
      if (parsedRepair.ok) {
        return { ok: true, value: parsedRepair.value, httpCalls };
      }
      return {
        ok: false,
        kind: "all-providers-failed",
        message: "primary + fallback + fallback repair all returned invalid output",
        httpCalls,
      };
    }
    return {
      ok: false,
      kind: "all-providers-failed",
      message: "primary returned 5xx and no fallback was configured",
      httpCalls,
    };
  }

  const parsedPrimary = await safeParseRecallPolicyDecision(primaryResponse);
  if (parsedPrimary.ok) {
    return { ok: true, value: parsedPrimary.value, httpCalls };
  }

  // Primary repair (same URL, primary state machine).
  const repairResponse = await callProvider(PRIMARY_URL);
  const parsedRepair = await safeParseRecallPolicyDecision(repairResponse);
  if (parsedRepair.ok) {
    return { ok: true, value: parsedRepair.value, httpCalls };
  }

  // After primary repair failure try fallback if configured.
  const fbSpec = scenario.scripted.fallback;
  if (fbSpec) {
    const fallbackResponse = await callProvider(FALLBACK_URL);
    const parsedFallback = await safeParseRecallPolicyDecision(fallbackResponse);
    if (parsedFallback.ok) {
      return { ok: true, value: parsedFallback.value, httpCalls };
    }
    const fbRepair = await callProvider(FALLBACK_URL);
    const parsedFbRepair = await safeParseRecallPolicyDecision(fbRepair);
    if (parsedFbRepair.ok) {
      return { ok: true, value: parsedFbRepair.value, httpCalls };
    }
    return {
      ok: false,
      kind: "all-providers-failed",
      message: "primary first + primary repair + fallback + fallback repair all invalid",
      httpCalls,
    };
  }

  return {
    ok: false,
    kind: "invalid-output",
    message: "primary first + primary repair both returned invalid output",
    httpCalls,
  };
}

/**
 * Parse a chat-completions response into a typed
 * `RecallPolicyDecision`. Tolerant of the `\`\`\`json...\`\`\``
 * fenced form the production adapters tolerate.
 *
 * Returns `{ ok: false, error }` on any parse / validation
 * failure so the adapter can route to repair / fallback.
 */
async function safeParseRecallPolicyDecision(
  response: Response
): Promise<
  { ok: true; value: RecallPolicyDecisionSuccess["value"] } | { ok: false; error: string }
> {
  let body = "";
  try {
    body = await response.text();
  } catch (err) {
    return {
      ok: false,
      error: `failed to read response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const assistantText = extractAssistantContent(body);
  if (assistantText === null) {
    return { ok: false, error: "response did not contain an assistant content field" };
  }
  const jsonText = extractBalancedJson(assistantText);
  if (jsonText === null) {
    return { ok: false, error: "no balanced JSON object in assistant content" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return validateDecisionShape(parsed);
}

/**
 * Extract the assistant message content from a chat-completions
 * JSON envelope. Mirrors the production adapters' extraction.
 */
function extractAssistantContent(body: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/**
 * Find the first balanced `{...}` JSON object in the
 * assistant content. The helper handles the `\`\`\`json ... \`\`\``
 * fenced form by stripping fences first, then scanning for a
 * balanced `{...}` block.
 */
function extractBalancedJson(text: string): string | null {
  // Strip code fences (the production adapters tolerate this form).
  const stripped = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1");
  // Find the first `{` and scan forward for a balanced `}`.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return stripped.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Validate a parsed JSON object against the recall-policy
 * decision shape. Returns a normalized decision on success.
 *
 * The shape mirrors `RememberPolicyDecisionSchema` but with
 * `status` (mirroring `RecallOutcome.status`) in place of
 * `action`. The status enum is the SAME enum the production
 * `RecallOutcome.status` union carries; the reason enum is
 * the benchmark-only recall-policy reason vocabulary.
 */
function validateDecisionShape(
  parsed: unknown
): { ok: true; value: RecallPolicyDecisionSuccess["value"] } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "parsed value is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const status = obj["status"];
  const reason = obj["reason"];
  const sourceIds = obj["sourceIds"];
  const conflictIds = obj["conflictIds"];
  const supersededIds = obj["supersededIds"];
  const olderVariantIds = obj["olderVariantIds"];
  const confidence = obj["confidence"];
  const notes = obj["notes"];

  if (typeof status !== "string") {
    return { ok: false, error: "decision.status missing or not a string" };
  }
  if (
    status !== "answered" &&
    status !== "weak_match" &&
    status !== "no_memory" &&
    status !== "rejected" &&
    status !== "provider_error"
  ) {
    return { ok: false, error: `decision.status is not a recognised status: ${status}` };
  }
  if (typeof reason !== "string") {
    return { ok: false, error: "decision.reason missing or not a string" };
  }
  if (!Array.isArray(sourceIds)) {
    return { ok: false, error: "decision.sourceIds missing or not an array" };
  }
  if (conflictIds !== undefined && !Array.isArray(conflictIds)) {
    return { ok: false, error: "decision.conflictIds present but not an array" };
  }
  if (supersededIds !== undefined && !Array.isArray(supersededIds)) {
    return { ok: false, error: "decision.supersededIds present but not an array" };
  }
  if (olderVariantIds !== undefined && !Array.isArray(olderVariantIds)) {
    return { ok: false, error: "decision.olderVariantIds present but not an array" };
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    return { ok: false, error: "decision.confidence missing or not in [0, 1]" };
  }

  const validatedSourceIds = sourceIds.filter((n): n is number => typeof n === "number");
  const validatedConflictIds = (conflictIds ?? []).filter(
    (n): n is number => typeof n === "number"
  );
  const validatedSupersededIds = (supersededIds ?? []).filter(
    (n): n is number => typeof n === "number"
  );
  const validatedOlderVariantIds = (olderVariantIds ?? []).filter(
    (n): n is number => typeof n === "number"
  );

  return {
    ok: true,
    value: {
      status: status as RecallPolicyStatus,
      reason: reason as RecallPolicyReason,
      sourceIds: validatedSourceIds,
      conflictIds: validatedConflictIds,
      supersededIds: validatedSupersededIds,
      olderVariantIds: validatedOlderVariantIds,
      confidence,
      ...(typeof notes === "string" ? { notes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario end-to-end through the benchmark-only
 * adapter. Never throws on expected failure paths.
 */
async function runSingleScenario(
  scenario: RecallPolicyScenario
): Promise<RecallPolicyScenarioRunResult> {
  const scripted = buildScriptedFetch(scenario.scripted);
  const adapterResult = await runBenchmarkOnlyRecallPolicyAdapter(scenario, scripted.fetchImpl);

  const expectationResult = evaluateExpectations(scenario.expect, adapterResult);
  const assertionRows = expectationResult.assertions;
  const pass = assertionRows.every((r) => r.pass);
  const decisionQualityPass = assertionRows
    .filter((r) => r.group === "decision-quality")
    .every((r) => r.pass);
  const providerPathPass = assertionRows
    .filter((r) => r.group === "provider-path")
    .every((r) => r.pass);

  const repairAttempted = scripted.paths.includes("primary-repair");
  const fallbackAttempted =
    scripted.paths.includes("fallback-first") || scripted.paths.includes("fallback-repair");

  const category: RecallPolicyScenarioCategory = scenario.category;
  const abstentionCritical = scenario.abstentionCritical ?? category === "no-memory-weak-match";
  const safetyCritical = scenario.safetyCritical ?? false;
  const evaluationScope = scenario.evaluationScope ?? "model-quality";

  const capturedTargetIds: RecallPolicyCapturedTargetIds = adapterResult.ok
    ? {
        sourceIds: [...adapterResult.value.sourceIds],
        conflictIds: [...adapterResult.value.conflictIds],
        supersededIds: [...adapterResult.value.supersededIds],
        olderVariantIds: [...adapterResult.value.olderVariantIds],
      }
    : {
        sourceIds: [],
        conflictIds: [],
        supersededIds: [],
        olderVariantIds: [],
      };

  let perScenarioJaccard: number | null = null;
  const exp = scenario.expect;
  if (exp.expectedConflictIds || exp.expectedSupersededIds || exp.expectedOlderVariantIds) {
    const jCon = jaccardBetween(exp.expectedConflictIds ?? [], capturedTargetIds.conflictIds);
    const jSup = jaccardBetween(exp.expectedSupersededIds ?? [], capturedTargetIds.supersededIds);
    const jOlder = jaccardBetween(
      exp.expectedOlderVariantIds ?? [],
      capturedTargetIds.olderVariantIds
    );
    perScenarioJaccard = (jCon + jSup + jOlder) / 3;
  } else if (exp.sourceIdInAnswer || exp.sourceIdNotInAnswer) {
    // Compute a per-scenario Jaccard on `sourceIds` against
    // the explicit `sourceIdInAnswer` set when present.
    const expectedIds = exp.sourceIdInAnswer ?? [];
    perScenarioJaccard = jaccardBetween(expectedIds, capturedTargetIds.sourceIds);
  }

  // Confusion-matrix row label. Always a string: the
  // expected status when set, `<none>` otherwise.
  const confusionRowLabel = exp.expectedStatus ?? "<none>";

  let run: RecallPolicyScenarioRunResult;
  if (adapterResult.ok) {
    run = {
      scenarioId: scenario.id,
      label: scenario.label,
      description: scenario.description,
      query: scenario.query,
      relatedCount: scenario.related.length,
      httpCalls: adapterResult.httpCalls,
      repairAttempted,
      fallbackAttempted,
      adapterOk: true as const,
      status: adapterResult.value.status,
      reason: adapterResult.value.reason,
      confidence: adapterResult.value.confidence,
      sourceIds: adapterResult.value.sourceIds,
      conflictIds: adapterResult.value.conflictIds,
      supersededIds: adapterResult.value.supersededIds,
      olderVariantIds: adapterResult.value.olderVariantIds,
      ...(adapterResult.value.notes !== undefined ? { notes: adapterResult.value.notes } : {}),
      category,
      abstentionCritical,
      safetyCritical,
      evaluationScope,
      capturedTargetIds,
      targetMemoryJaccard: perScenarioJaccard,
      assertions: assertionRows,
      pass,
      decisionQualityPass,
      providerPathPass,
      expectedConfusionRowLabel: confusionRowLabel,
      ...(scenario.expect.expectedStatus !== undefined
        ? { expectedStatus: scenario.expect.expectedStatus }
        : {}),
      ...(scenario.expect.expectedReason !== undefined
        ? { expectedReason: scenario.expect.expectedReason }
        : {}),
    };
  } else {
    run = {
      scenarioId: scenario.id,
      label: scenario.label,
      description: scenario.description,
      query: scenario.query,
      relatedCount: scenario.related.length,
      httpCalls: adapterResult.httpCalls,
      repairAttempted,
      fallbackAttempted,
      adapterOk: false,
      failureKind: adapterResult.kind,
      category,
      abstentionCritical,
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
  return run;
}

/**
 * Evaluate the scenario's `expect` block against the captured
 * adapter decision. Returns `{ assertions }` so the metrics
 * builder can compute per-scenario pass / fail.
 */
function evaluateExpectations(
  expect: RecallPolicyExpectations,
  result: RecallPolicyAdapterResult
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

  if (!result.ok) {
    // On adapter failure only the httpCalls expectation is meaningful;
    // every other expectation is recorded as "skipped (adapter failed)".
    if (expect.expectedStatus !== undefined) {
      rows.push({
        name: "status",
        description: `expected status "${expect.expectedStatus}"`,
        pass: false,
        note: `adapter failed with kind=${result.kind}`,
        group: "decision-quality",
      });
    }
    if (expect.expectedReason !== undefined) {
      rows.push({
        name: "reason",
        description: `expected reason "${expect.expectedReason}"`,
        pass: false,
        note: `adapter failed with kind=${result.kind}`,
        group: "decision-quality",
      });
    }
    if (expect.httpCalls !== undefined) {
      rows.push({
        name: "httpCalls",
        description: `expected httpCalls=${expect.httpCalls}`,
        pass: result.httpCalls === expect.httpCalls,
        note: `got ${result.httpCalls}`,
        group: "provider-path",
      });
    }
    return { assertions: rows };
  }

  const v = result.value;

  if (expect.expectedStatus !== undefined) {
    rows.push({
      name: "status",
      description: `decision.status must be "${expect.expectedStatus}"`,
      pass: v.status === expect.expectedStatus,
      note: `got "${v.status}"`,
      group: "decision-quality",
    });
  }
  if (expect.expectedReason !== undefined) {
    rows.push({
      name: "reason",
      description: `decision.reason must be "${expect.expectedReason}"`,
      pass: v.reason === expect.expectedReason,
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

  if (expect.sourceIdInAnswer) {
    for (const id of expect.sourceIdInAnswer) {
      rows.push({
        name: "sourceIdInAnswer",
        description: `sourceIds must include ${id}`,
        pass: v.sourceIds.includes(id),
        note: v.sourceIds.includes(id) ? "present" : `missing (got [${v.sourceIds.join(", ")}])`,
        group: "decision-quality",
      });
    }
  }
  if (expect.sourceIdNotInAnswer) {
    for (const id of expect.sourceIdNotInAnswer) {
      rows.push({
        name: "sourceIdNotInAnswer",
        description: `sourceIds must NOT include ${id}`,
        pass: !v.sourceIds.includes(id),
        note: !v.sourceIds.includes(id) ? "clear" : `unexpectedly present`,
        group: "decision-quality",
      });
    }
  }
  if (expect.expectedConflictIds !== undefined) {
    rows.push({
      name: "expectedConflictIds",
      description: `conflictIds must equal [${expect.expectedConflictIds.join(", ")}] (set match)`,
      pass: jaccardBetween(expect.expectedConflictIds, v.conflictIds) === 1,
      note: `got [${v.conflictIds.join(", ")}]`,
      group: "decision-quality",
    });
  }
  if (expect.expectedSupersededIds !== undefined) {
    rows.push({
      name: "expectedSupersededIds",
      description: `supersededIds must equal [${expect.expectedSupersededIds.join(", ")}] (set match)`,
      pass: jaccardBetween(expect.expectedSupersededIds, v.supersededIds) === 1,
      note: `got [${v.supersededIds.join(", ")}]`,
      group: "decision-quality",
    });
  }
  if (expect.expectedOlderVariantIds !== undefined) {
    rows.push({
      name: "expectedOlderVariantIds",
      description: `olderVariantIds must equal [${expect.expectedOlderVariantIds.join(", ")}] (set match)`,
      pass: jaccardBetween(expect.expectedOlderVariantIds, v.olderVariantIds) === 1,
      note: `got [${v.olderVariantIds.join(", ")}]`,
      group: "decision-quality",
    });
  }

  if (expect.httpCalls !== undefined) {
    rows.push({
      name: "httpCalls",
      description: `adapter.httpCalls must equal ${expect.httpCalls}`,
      pass: result.httpCalls === expect.httpCalls,
      note: `got ${result.httpCalls}`,
      group: "provider-path",
    });
  }
  return { assertions: rows };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Public entry point: run the full recall-policy evaluation.
 *
 * The function is the canonical entry point for both the CLI
 * runner and the test suite. It is deterministic for a fixed
 * `(scenarios)` argument and never makes a live network call.
 */
export async function runRecallPolicyEvaluation(
  args: {
    scenarios?: ReadonlyArray<RecallPolicyScenario>;
  } = {}
): Promise<RecallPolicyEvaluationReport> {
  const scenarios = args.scenarios ?? BUILT_IN_RECALL_POLICY_SCENARIOS;
  const runs: RecallPolicyScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    runs.push(await runSingleScenario(scenario));
  }
  const metrics = buildRecallPolicyEvaluationMetrics(runs);
  return {
    generatedAt: new Date().toISOString(),
    scenarioSetVersion: metrics.scenarioSetVersion,
    meta: metrics.meta,
    categories: metrics.categories,
    scopes: metrics.scopes,
    statusHistogram: metrics.statusHistogram,
    reasonHistogram: metrics.reasonHistogram,
    perStatusAccuracy: metrics.perStatusAccuracy,
    perReasonAccuracy: metrics.perReasonAccuracy,
    statusConfusionMatrix: metrics.statusConfusionMatrix,
    targetMemoryMatch: metrics.targetMemoryMatch,
    providerCallStats: metrics.providerCallStats,
    abstentionGate: metrics.abstentionGate,
    safetyGate: metrics.safetyGate,
    modelQualityGate: metrics.modelQualityGate,
    providerPathGate: metrics.providerPathGate,
    gates: metrics.gates,
    runs: metrics.runs,
    limitations: RECALL_POLICY_EVALUATION_LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "recall-policy-evaluation";

/**
 * Write the evaluation report to disk. The file prefix is
 * `recall-policy-evaluation-*.json` (distinct from the
 * existing audit / calibration / policy / held-out / adaptive-
 * depth / decision-policy-evaluation prefixes).
 */
export function writeRecallPolicyEvaluationReport(
  report: RecallPolicyEvaluationReport,
  dir: string
): string {
  return writeTimestampedJsonArtifact(report, dir, ARTIFACT_FILE_PREFIX);
}

// Re-export the human formatter, scenario helpers, and types
// from the metrics and scenario modules so a downstream
// consumer can `import { format..., RecallPolicyScenario }`
// from this entry point.
export { formatRecallPolicyEvaluationReport, jaccardBetween } from "./recall/metrics.js";
export type {
  RecallPolicyScenarioRunResult,
  RecallPolicyAssertionRow,
  RecallPolicyAbstentionGate,
  RecallPolicySafetyGate,
  RecallPolicyModelQualityGate,
  RecallPolicyProviderPathGate,
  RecallPolicyGates,
  RecallPolicyCategorySummary,
  RecallPolicyStatusAccuracyRow,
  RecallPolicyReasonAccuracyRow,
  RecallPolicyCapturedTargetIds,
  RecallPolicyProviderCallStats,
  RecallPolicyStatusConfusionMatrix,
  RecallPolicyTargetMemoryMatch,
} from "./recall/metrics.js";
export type {
  RecallPolicyScenario,
  RecallPolicyScenarioCategory,
  RecallPolicyEvaluationScope,
  RecallPolicyExpectations,
  RecallPolicyRelatedMemory,
  RecallPolicyStatus,
  RecallPolicyReason,
} from "./recall/scenarios.js";
export {
  RECALL_POLICY_SCENARIO_CATEGORIES,
  RECALL_POLICY_SCENARIO_SET_VERSION,
  RECALL_POLICY_EVALUATION_SCOPES,
  RECALL_POLICY_STATUSES,
  RECALL_POLICY_REASONS,
  BUILT_IN_RECALL_POLICY_SCENARIOS,
} from "./recall/scenarios.js";
export type { ScriptedRecallProviderSpec } from "./recall/spec.js";
// `RecallPolicyAdapterResult` and `runBenchmarkOnlyRecallPolicyAdapter`
// are declared at the top of this module; they are exported via
// their inline `export` declarations below. Re-exporting them
// from `./recall-policy-evaluation.js` (i.e. self) would
// circular-import; the inline `export` is the canonical form.
// (No re-export needed here — the declarations above ARE the
// exports.)
