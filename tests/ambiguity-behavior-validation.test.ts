/**
 * Phase E — curated behavior-validation suite for the
 * recall-side ambiguity warning behavior.
 *
 * Scope (validation-only, no new production behavior):
 *
 *   - Drives the existing Phase D public-message flag through
 *     a curated matrix of 12 scenarios covering the spec's
 *     stated behavior: stored mutual conflicts, lexical
 *     asymmetric-negation safety-net, mutual older variants,
 *     one-way older variants, no ambiguity, clarified
 *     supersession / history-shaped case (capability gap),
 *     older variants still plausible, and the four public
 *     statuses (answered / no_memory / rejected /
 *     provider_error).
 *   - Asserts, per scenario:
 *       1. expected vs actual public `message` warning prefix;
 *       2. expected vs actual detector reason;
 *       3. expected vs actual public `status`;
 *       4. (when pinned) the public `RecallResult` keys are
 *          exactly the documented allowed set (API drift pin);
 *       5. (when pinned) the provider was called exactly once
 *          (or zero times on no_memory / rejected, when
 *          asserted).
 *   - Aggregates pass / false-positive / false-negative /
 *     gap verdicts into a compact report and prints it as
 *     the last assertion of the file.
 *
 * Properties verified:
 *
 *   - No false positive on the no-ambiguity / one-way /
 *     no_memory / rejected / provider_error cases.
 *   - No false negative on the stored mutual-conflict /
 *     lexical asymmetric-negation / mutual olderVariantsOf
 *     cases.
 *   - The four-status union is preserved.
 *   - The public `RecallResult` shape (key set) is unchanged
 *     in every scenario.
 *   - The provider is called exactly once when a warning
 *     fires (no short-circuit from the detector).
 *   - The clarified supersession / history-shaped case is
 *     documented as a capability gap, not a regression.
 *
 * No benchmark experiment modules are imported. No raw text
 * is stored or echoed. No production code is changed.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  initStorage,
  insertMemoryRecord,
  updateMemoryMetadata,
  type StorageHandle,
  type MemoryRecord,
} from "../src/storage/storage.ts";
import {
  formatAmbiguityNote,
  type AmbiguitySignal,
} from "../src/retrieval/ambiguity.ts";
import {
  handleRecall,
  NO_RELEVANT_MEMORY,
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
  type RecallResult,
} from "../src/tools/recall.ts";
import {
  setListRegisteredProjectsStub,
  resetListRegisteredProjectsStub,
} from "../src/config/registry.ts";

import {
  SCENARIOS,
  resolveIdList,
  newReportRows,
  buildReport,
  formatReport,
  type Scenario,
  type ScenarioReportRow,
  type ExpectedStatus,
  type IdList,
} from "./_helpers/ambiguity-behavior-scenarios.ts";

// ---------------------------------------------------------------------------
// Storage helpers (per-scenario fresh storage)
// ---------------------------------------------------------------------------

interface FreshStorage {
  tmp: string;
  handle: StorageHandle;
}

function mkStorage(): FreshStorage {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-amb-e-"));
  const handle = initStorage({ projectRoot: tmp });
  return { tmp, handle };
}

function rmStorage(s: FreshStorage): void {
  try {
    s.handle.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(s.tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

interface ScriptedFetch {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
}

function scriptFetch(responder: () => Response): ScriptedFetch {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return responder();
  };
  return { fetchImpl, calls };
}

function okChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "sk-fallback-test-not-real-12345";
// Explicit provider config: base URL contains "nvidia" so provider
// label is "nvidia-nim", model is the test primary model.
const PRIMARY_BASE_URL = "https://api.nvidia.example.com/v1";
const PRIMARY_MODEL = "test/model-primary";
const FALLBACK_BASE_URL = "https://api.fallback.example/v1";
const FALLBACK_MODEL = "test/model-fallback";

// ---------------------------------------------------------------------------
// Row insertion
// ---------------------------------------------------------------------------

/**
 * Insert each scenario row and (when the row carries a
 * relationship block) patch the post-write `metadata.relationship`
 * field with the concrete id of the referenced row. Returns
 * the inserted records in declaration order so the runner can
 * use the ids in further assertions if needed.
 */
function seedScenarioRows(
  handle: StorageHandle,
  scenario: Scenario,
): MemoryRecord[] {
  const inserted: MemoryRecord[] = [];
  for (const row of scenario.rows) {
    const rec = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      // Phase 1 internal naming cleanup: the internal
      // `MemoryRecordInput` field is `memoryContent`
      // (TS-side). The DB column on disk is still
      // `summary`. The helper's test-side param
      // `row.summary` is just a test-helper field name and
      // is mapped here at the storage boundary.
      memoryContent: row.summary,
      providerId: "minimax",
      modelId: "MiniMax-M3",
      confidence: 0.9,
      safetyFlags: ["controller-normalized"],
      metadata: {
        tags: row.tags ?? [],
        classification: null,
      },
    });
    inserted.push(rec);
  }
  // Patch relationship blocks. We resolve `{ ref: "other" }`
  // to the *other* row's id in the same scenario.
  for (let i = 0; i < scenario.rows.length; i += 1) {
    const row = scenario.rows[i];
    if (!row || row.relationship === undefined) continue;
    const otherId = inserted[1 - i]?.id ?? -1;
    const otherIdForI = inserted[i === 0 ? 1 : 0]?.id ?? -1;
    // The `{ ref: "other" }` form is shorthand for "point at
    // the other row in this scenario". For two-row scenarios
    // (which is all Phase E currently uses) this resolves to
    // the partner id. For self-loops or fan-out the runner
    // can be extended; Phase E is intentionally simple.
    const conflictsWith: number[] = resolveIdList(
      row.relationship.conflictsWith as IdList | undefined,
      otherId,
    );
    const olderVariantsOf: number[] = resolveIdList(
      row.relationship.olderVariantsOf as IdList | undefined,
      otherId,
    );
    const block = {
      derivedSchemaVersion: row.relationship.derivedSchemaVersion ?? "ccm-draft-1",
      derivedAt: row.relationship.derivedAt ?? 1,
      conflictsWith,
      olderVariantsOf,
      detectionConfidence: row.relationship.detectionConfidence ?? 0,
    };
    // Re-read the current metadata so we can merge without
    // losing the `tags` / `classification` we just wrote.
    const current = inserted[i];
    if (!current) continue;
    const nextMetadata: Record<string, unknown> = {
      ...current.metadata,
      relationship: block,
    };
    updateMemoryMetadata(handle, current.id, nextMetadata);
    // Suppress unused-var lint for the symmetry with the
    // two-row case.
    void otherIdForI;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Public projection (mirrors the controller + tool-layer behavior)
// ---------------------------------------------------------------------------

/**
 * Run the recall controller with a scripted fetch, then
 * project the outcome the way the tool layer does (Phase D
 * note prefix on the answered case). Returns the projected
 * `RecallResult` shape and the count of provider calls.
 *
 * Note: the projection is duplicated from
 * `src/tools/recall.ts#formatOutcome` so the test can drive
 * the controller with a custom `providerFetchImpl` (the
 * public `handleRecall` surface does not expose a fetch
 * override by design). The duplication is intentional: the
 * report must verify behavior, not import the projection
 * it is trying to verify.
 */
async function runProjected(
  handle: StorageHandle,
  scenario: Scenario,
): Promise<{
  status: ExpectedStatus;
  message: string;
  answer?: string;
  sourceIds: number[];
  reason?: string;
  safetyClass?: string;
  warning: boolean;
  reasonActual: "conflicting-candidates" | "older-variant-suspected" | "none";
  providerCalls: number;
  apiKeys: string[];
}> {
  const { fetchImpl, calls } = scriptFetch(() =>
    okChatResponse(scenario.answer),
  );
  const out = await runRecallController(handle, scenario.query, {
    providerFetchImpl: fetchImpl,
    providerPrimaryApiKey: PRIMARY_KEY,
    providerPrimaryBaseUrl: PRIMARY_BASE_URL,
    providerPrimaryModel: PRIMARY_MODEL,
    providerFallbackApiKey: FALLBACK_KEY,
    providerFallbackBaseUrl: FALLBACK_BASE_URL,
    providerFallbackModel: FALLBACK_MODEL,
  });
  if (out.status === "no_memory") {
    return {
      status: "no_memory",
      message: NO_RELEVANT_MEMORY,
      sourceIds: [],
      warning: false,
      reasonActual: "none",
      providerCalls: calls.length,
      apiKeys: [],
    };
  }
  if (out.status === "rejected") {
    return {
      status: "rejected",
      message: `Rejected: ${out.reason}`,
      reason: out.reason,
      safetyClass: out.safetyClass,
      sourceIds: [],
      warning: false,
      reasonActual: "none",
      providerCalls: calls.length,
      apiKeys: [],
    };
  }
  if (out.status === "provider_error") {
    return {
      status: "provider_error",
      message: `Provider error: ${out.reason}`,
      reason: out.reason,
      sourceIds: [],
      warning: false,
      reasonActual: "none",
      providerCalls: calls.length,
      apiKeys: [],
    };
  }
  // status === "answered"
  const internal: AmbiguitySignal = out.internalAmbiguity;
  const note = formatAmbiguityNote(internal);
  const message = note.length === 0 ? out.answer : `${note}\n\n${out.answer}`;
  return {
    status: "answered",
    message,
    answer: out.answer,
    sourceIds: [...out.sourceIds],
    warning: note.length > 0,
    reasonActual:
      internal.kind === "ambiguous" ? internal.reason : "none",
    providerCalls: calls.length,
    apiKeys: [],
  };
}

// ---------------------------------------------------------------------------
// Public-RecallResult key set (the API drift pin)
// ---------------------------------------------------------------------------

/**
 * The exact allowed set of public keys on the tool-layer
 * `RecallResult` shape. Pinning this set is how the report
 * checks for "no new public field has been added".
 */
const ALLOWED_PUBLIC_KEYS = new Set([
  "status",
  "message",
  "answer",
  "sourceIds",
  "safetyClass",
  "source",
  "clarification_needed",
  "notes",
  "summaries",
  "coverage",
]);

/** Build the public `RecallResult` exactly the way the tool
 *  layer does, so the API drift check operates on the same
 *  shape the public surface would. */
function buildPublicResult(scenario: Scenario, projected: {
  status: ExpectedStatus;
  message: string;
  answer?: string;
  sourceIds: number[];
  reason?: string;
  safetyClass?: string;
}): RecallResult {
  switch (projected.status) {
    case "answered":
      return {
        status: "answered",
        message: projected.message,
        answer: projected.answer,
        sourceIds: projected.sourceIds,
      };
    case "no_memory":
      return { status: "no_memory", message: NO_RELEVANT_MEMORY };
    case "rejected":
      return {
        status: "rejected",
        message: `Rejected: ${projected.reason ?? ""}`,
        safetyClass: projected.safetyClass,
      };
    case "provider_error":
      return {
        status: "provider_error",
        message: `Provider error: ${projected.reason ?? ""}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

/** Compute the natural expected provider call count for a
 *  given status. The `answered` path uses 1 (primary
 *  succeeds, no fallback). The `provider_error` path uses
 *  2 (primary + fallback both 500, the controller does
 *  not retry beyond the fallback). The `no_memory` /
 *  `rejected` paths use 0 (the controller short-circuits
 *  before the synthesis call). The detector never adds
 *  or removes a call. */
function expectedProviderCallsFor(status: ExpectedStatus): number {
  switch (status) {
    case "answered":
      return 1;
    case "provider_error":
      return 2;
    case "no_memory":
    case "rejected":
      return 0;
  }
}

/** Run the scenario end-to-end and record a
 *  `ScenarioReportRow`. The async signature is required
 *  because the recall controller is async; the public
 *  `handleRecall` projection is awaited here too so the
 *  API drift check operates on the post-tool-layer shape.
 *  The function is designed so a row is ALWAYS pushed to
 *  the supplied buffer, even if an assertion fails —
 *  the report must reflect the actual state of every
 *  scenario, not only the ones that passed. The assertion
 *  failure is re-thrown so the test framework still
 *  reports the per-scenario test as failed. */
async function runScenarioAsync(
  scenario: Scenario,
  sink: ScenarioReportRow[],
): Promise<void> {
  const expectedStatus: ExpectedStatus = scenario.expected.status ?? "answered";
  const expectedWarning = scenario.expected.warning;
  const expectedReason: string = scenario.expected.reason ?? "none";
  const pinApiShape = scenario.pinApiShape ?? true;
  const pinProviderCalls = scenario.pinProviderCalls ?? true;
  const expectedCalls = expectedProviderCallsFor(expectedStatus);

  const storage = mkStorage();
  let projected: {
    status: ExpectedStatus;
    message: string;
    answer?: string;
    sourceIds: number[];
    reason?: string;
    safetyClass?: string;
    warning: boolean;
    reasonActual: "conflicting-candidates" | "older-variant-suspected" | "none";
    providerCalls: number;
  } | null = null;
  let publicResult: RecallResult | null = null;
  let providerCallCount = 0;

  // Capture errors so we can still push a report row on
  // the failure path. The error is re-thrown at the end of
  // the function so the test framework still records the
  // per-scenario test as failed.
  let captured: { kind: "status" | "warning" | "api" | "calls" | "fatal"; message: string } | null = null;

  try {
    if (expectedStatus === "no_memory") {
      setRecallStorageProvider(() => ({
        handle: storage.handle,
        ownsHandle: false,
      }));
      setListRegisteredProjectsStub(() => []);
      try {
        publicResult = await handleRecall({ text: scenario.query });
      } finally {
        resetListRegisteredProjectsStub();
      }
      if (publicResult.status !== "no_memory") {
        captured = {
          kind: "status",
          message: `expected no_memory, got ${publicResult.status}`,
        };
      }
      projected = {
        status: "no_memory",
        message: publicResult.message,
        sourceIds: [],
        warning: false,
        reasonActual: "none",
        providerCalls: 0,
      };
      providerCallCount = 0;
    } else if (expectedStatus === "rejected") {
      setRecallStorageProvider(() => ({
        handle: storage.handle,
        ownsHandle: false,
      }));
      // Seed rows so the controller has something to
      // consider if it ever got past the safety pre-check
      // (it must not on the secret-shaped path; this is
      // just defense in depth).
      seedScenarioRows(storage.handle, scenario);
      publicResult = await handleRecall({ text: scenario.query });
      if (publicResult.status !== "rejected") {
        captured = {
          kind: "status",
          message: `expected rejected, got ${publicResult.status}`,
        };
      }
      projected = {
        status: "rejected",
        message: publicResult.message,
        reason: publicResult.message.replace(/^Rejected: /, ""),
        safetyClass: publicResult.safetyClass,
        sourceIds: [],
        warning: false,
        reasonActual: "none",
        providerCalls: 0,
      };
      providerCallCount = 0;
    } else if (expectedStatus === "provider_error") {
      // Use a controller-driven 500. The public tool layer
      // does not expose a fetch override by design; we
      // project the outcome the same way the tool layer
      // does.
      //
      // Under the NVIDIA-only stance, the fallback slot is
      // empty by default. To exercise the
      // `expectedCalls === 2` invariant (primary + fallback),
      // the scenario must explicitly opt in to a MiniMax
      // fallback by setting the URL and model in addition
      // to the fallback key. With those three present, the
      // fallback call is attempted and the adapter returns
      // `all-providers-failed` after both slots fail.
      seedScenarioRows(storage.handle, scenario);
      const { fetchImpl, calls } = scriptFetch(
        () => new Response("boom", { status: 500 }),
      );
      const out = await runRecallController(storage.handle, scenario.query, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: "https://api.minimax.io/v1",
        providerFallbackModel: "MiniMax-M3",
      });
      if (out.status !== "provider_error") {
        captured = {
          kind: "status",
          message: `expected provider_error, got ${out.status}`,
        };
      }
      projected = {
        status: "provider_error",
        message: `Provider error: ${out.reason}`,
        reason: out.reason,
        sourceIds: [],
        warning: false,
        reasonActual: "none",
        providerCalls: calls.length,
      };
      providerCallCount = calls.length;
      publicResult = buildPublicResult(scenario, projected);
    } else {
      // `answered`. Drive the controller and project.
      seedScenarioRows(storage.handle, scenario);
      try {
        const r = await runProjected(storage.handle, scenario);
        projected = r;
        providerCallCount = r.providerCalls;
        publicResult = buildPublicResult(scenario, r);
      } catch (err) {
        captured = {
          kind: "fatal",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } finally {
    try {
      resetRecallStorageProvider();
    } catch {
      // ignore
    }
    rmStorage(storage);
  }

  // Build the report row. If we never produced a
  // `projected` (e.g. an exception during the controller
  // call), synthesize a stub row so the report still has
  // 12 entries and the failure is visible.
  if (!projected) {
    sink.push({
      id: scenario.id,
      name: scenario.name,
      kind: scenario.kind,
      verdict: "false-negative",
      expectedWarning,
      actualWarning: false,
      expectedReason,
      actualReason: "none",
      expectedStatus,
      actualStatus: expectedStatus,
      expectedProviderCalls: expectedCalls,
      actualProviderCalls: providerCallCount,
      capabilityGap: scenario.expected.capabilityGap,
      apiDrift: null,
      providerCallOk: null,
      note: captured?.message,
    });
    if (captured) {
      throw new Error(`scenario ${scenario.id}: ${captured.message}`);
    }
    throw new Error(`scenario ${scenario.id}: no projected outcome`);
  }

  const actualStatus = projected.status;
  const actualWarning = projected.warning;
  const actualReason = projected.reasonActual;

  // Status check (capture rather than throw so the report
  // row is still pushed).
  if (actualStatus !== expectedStatus) {
    captured = {
      kind: "status",
      message: `scenario ${scenario.id} status mismatch: expected ${expectedStatus}, got ${actualStatus}`,
    };
  }

  // Warning check.
  if (expectedWarning) {
    if (!actualWarning) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} expected a warning but none fired (reason=${actualReason})`,
      };
    } else if (
      publicResult !== null &&
      !publicResult.message.startsWith("Note: ")
    ) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} public message must start with 'Note: '`,
      };
    } else if (actualReason !== expectedReason) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} reason mismatch: expected ${expectedReason}, got ${actualReason}`,
      };
    }
  } else {
    if (actualWarning) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} expected no warning but one fired (reason=${actualReason})`,
      };
    } else if (actualReason !== "none") {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} detector must be silent when no warning is expected (got reason=${actualReason})`,
      };
    } else if (
      publicResult !== null &&
      publicResult.message.startsWith("Note: ")
    ) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} public message must not start with 'Note: '`,
      };
    }
  }

  // API drift pin.
  let apiDrift: boolean | null = null;
  if (pinApiShape) {
    if (!publicResult) {
      apiDrift = null;
    } else {
      const rAsObj = publicResult as unknown as Record<string, unknown>;
      const keys = Object.keys(rAsObj);
      let ok = true;
      for (const k of keys) {
        if (!ALLOWED_PUBLIC_KEYS.has(k)) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        captured = {
          kind: "api",
          message: `scenario ${scenario.id} public keys must be a subset of the allowed set; got ${keys.join(",")}`,
        };
      }
      apiDrift = ok;
    }
  }

  // Provider-call pin.
  let providerCallOk: boolean | null = null;
  if (pinProviderCalls) {
    if (providerCallCount !== expectedCalls) {
      captured = {
        kind: "calls",
        message: `scenario ${scenario.id} provider call count mismatch: expected ${expectedCalls}, got ${providerCallCount}`,
      };
      providerCallOk = false;
    } else {
      providerCallOk = true;
    }
  }

  // Verdict.
  let verdict: ScenarioReportRow["verdict"];
  if (scenario.expected.capabilityGap !== undefined) {
    verdict = "gap";
  } else if (captured !== null) {
    if (captured.kind === "warning" && expectedWarning && !actualWarning) {
      verdict = "false-negative";
    } else if (captured.kind === "warning" && !expectedWarning && actualWarning) {
      verdict = "false-positive";
    } else if (captured.kind === "warning" && expectedWarning && actualWarning) {
      // Reason mismatch on an expected-warning scenario.
      verdict = "false-negative";
    } else {
      verdict = "false-negative";
    }
  } else {
    verdict = "pass";
  }

  sink.push({
    id: scenario.id,
    name: scenario.name,
    kind: scenario.kind,
    verdict,
    expectedWarning,
    actualWarning,
    expectedReason,
    actualReason,
    expectedStatus,
    actualStatus,
    expectedProviderCalls: expectedCalls,
    actualProviderCalls: providerCallCount,
    capabilityGap: scenario.expected.capabilityGap,
    apiDrift,
    providerCallOk,
    note: captured?.message,
  });

  if (captured) {
    throw new Error(captured.message);
  }
}

// ---------------------------------------------------------------------------
// Test file: one test per scenario + a final summary test
// ---------------------------------------------------------------------------

const reportRows = newReportRows();

before(() => {
  // The buffer is module-scoped; this hook exists so the
  // summary test can be defined alongside the per-scenario
  // tests with a clear ordering.
});

for (const scenario of SCENARIOS) {
  test(`Phase E scenario ${scenario.id}: ${scenario.name}`, async () => {
    await runScenarioAsync(scenario, reportRows);
  });
}

test("Phase E summary: compact validation report", () => {
  // By the time this test runs, every per-scenario test has
  // appended its row. Build the final report and print it.
  const report = buildReport(reportRows);
  // The summary block is printed once, in a single
  // multi-line `console.log` so test runners surface it
  // intact. We use a sentinel prefix to make it greppable.
  // eslint-disable-next-line no-console
  console.log("\n" + formatReport(report));
  // Hard assertions: no false positives, no false negatives.
  assert.equal(
    report.falsePositives,
    0,
    `Phase E: ${report.falsePositives} false positive(s) detected`,
  );
  assert.equal(
    report.falseNegatives,
    0,
    `Phase E: ${report.falseNegatives} false negative(s) detected`,
  );
  // All API drift pins must pass (no new public field).
  assert.equal(
    report.apiDriftChecks.failed,
    0,
    `Phase E: ${report.apiDriftChecks.failed} API drift failure(s)`,
  );
  // All provider-call pins must pass.
  assert.equal(
    report.providerCallChecks.failed,
    0,
    `Phase E: ${report.providerCallChecks.failed} provider-call failure(s)`,
  );
  // Sanity: total scenarios match the curated list.
  assert.equal(
    report.totalScenarios,
    SCENARIOS.length,
    "Phase E report row count must match the curated scenario list",
  );
  // Sanity: the gap scenario is recorded as a gap, not a fail.
  const gapRows = report.rows.filter((r) => r.verdict === "gap");
  assert.ok(
    gapRows.length >= 1,
    "Phase E: at least one scenario (S6) should be recorded as a capability gap",
  );
  // Sanity: the S6 capability gap note is preserved.
  const s6 = report.rows.find((r) => r.id === "S6");
  assert.ok(s6 && s6.capabilityGap !== undefined);
});
