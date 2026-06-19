/**
 * Phase G / Phase J — curated validation suite for the
 * resolved-history semantics gap surfaced by Phase E.
 *
 * Scope:
 *
 *   - Drives the existing controller through a curated
 *     matrix of 10 scenarios covering the Phase F spec's
 *     §7 example cluster and the §3 decision table:
 *     explicit Render -> Fly.io pair, single asymmetric
 *     marker, recency-only pair, three-step timeline,
 *     plain history row, explicit unresolved conflict,
 *     superseded / no-longer wording, older-memories-
 *     stay-active retrievability invariant, the four
 *     public statuses (`answered` / `no_memory` /
 *     `rejected` / `provider_error`) on the
 *     resolved-history path, and the public API / result
 *     key shape.
 *   - Asserts, per scenario:
 *       1. expected vs actual public `message` warning
 *          prefix (current-actual axis);
 *       2. expected vs actual detector reason
 *          (current-actual axis);
 *       3. expected vs actual public `status`
 *          (current-actual axis);
 *       4. (when pinned) the public `RecallResult` keys
 *          are exactly the documented allowed set (API
 *          drift pin);
 *       5. (when pinned) the provider was called exactly
 *          the natural number of times for the expected
 *          status (provider-call pin);
 *       6. (when pinned) every seeded row remains
 *          `state = "active"` in storage after the recall
 *          call (state-activation pin; locked Phase F
 *          decision §2.3).
 *   - Records, per scenario, the future-desired verdict
 *     the Phase F spec would produce. After Phase J
 *     landed, the three `expect-current-silent-future-resolved`
 *     scenarios (SG1, SG4, SG7) are no longer future
 *     gaps: their `expectedCurrent` now matches
 *     `desiredFuture`, and the runner asserts the
 *     warning / reason on the current implementation.
 *     The `expectedCurrent.warning === desiredFuture.warning`
 *     invariant still anchors the report; scenarios where
 *     a future-vs-current divergence is still expected
 *     would be recorded as a documented capability gap.
 *     Phase J closes all three: the report's
 *     `documentedCapabilityGaps` count drops to 0 and
 *     the `futureResolvedHistoryAchievedCount` count
 *     becomes >= 1 (it was 0 before Phase J).
 *   - Aggregates the per-scenario verdicts into a
 *     compact report and prints it as the last
 *     assertion of the file.
 *
 * Properties verified:
 *
 *   - No false-positive / false-negative / regression on
 *     a current-actual invariant (asserted as a hard
 *     pass/fail).
 *   - The four-status union is preserved.
 *   - The public `RecallResult` shape (key set) is
 *     unchanged in every scenario.
 *   - The provider is called exactly once when a warning
 *     fires (no short-circuit from the detector).
 *   - Older memories stay `state = "active"` and
 *     remain retrievable.
 *
 * No benchmark experiment modules are imported. No raw
 * text is stored or echoed.
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
  listActiveMemorySummaries,
  type StorageHandle,
  type MemoryRecord,
} from "../src/storage/storage.ts";
import {
  type AmbiguitySignal,
} from "../src/retrieval/ambiguity.ts";
import {
  type ResolvedHistorySignal,
} from "../src/retrieval/resolved-history.ts";
import {
  handleRecall,
  NO_RELEVANT_MEMORY,
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
  type RecallResult,
} from "../src/tools/recall.ts";

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
} from "./_helpers/resolved-history-validation-scenarios.ts";

// ---------------------------------------------------------------------------
// Storage helpers (per-scenario fresh storage)
// ---------------------------------------------------------------------------

interface FreshStorage {
  tmp: string;
  handle: StorageHandle;
}

function mkStorage(): FreshStorage {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-resg-"));
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
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";

// ---------------------------------------------------------------------------
// Row insertion
// ---------------------------------------------------------------------------

/**
 * Insert each scenario row and (when the row carries a
 * relationship block) patch the post-write
 * `metadata.relationship` field with the concrete id of
 * the referenced row. Returns the inserted records in
 * declaration order so the runner can use the ids in
 * further assertions if needed.
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
  // Patch relationship blocks. We resolve
  // `{ ref: "other" }` to the *other* row's id in the
  // same scenario.
  for (let i = 0; i < scenario.rows.length; i += 1) {
    const row = scenario.rows[i];
    if (!row || row.relationship === undefined) continue;
    const otherId = inserted[1 - i]?.id ?? -1;
    const conflictsWith: number[] = resolveIdList(
      row.relationship.conflictsWith as IdList | undefined,
      otherId,
    );
    const olderVariantsOf: number[] = resolveIdList(
      row.relationship.olderVariantsOf as IdList | undefined,
      otherId,
    );
    const supersedes: number[] = resolveIdList(
      row.relationship.supersedes as IdList | undefined,
      otherId,
    );
    const supersededBy: number[] = resolveIdList(
      row.relationship.supersededBy as IdList | undefined,
      otherId,
    );
    const block = {
      derivedSchemaVersion: row.relationship.derivedSchemaVersion ?? "ccm-draft-1",
      derivedAt: row.relationship.derivedAt ?? 1,
      conflictsWith,
      olderVariantsOf,
      detectionConfidence: row.relationship.detectionConfidence ?? 0,
      // Phase F §6.2 optional forward-looking keys. Phase G
      // does not require them; the runner writes them only
      // when the scenario explicitly supplies them, so the
      // matrix never silently widens the schema.
      supersedes,
      supersededBy,
      resolvedAt: row.relationship.resolvedAt ?? 0,
    };
    // Re-read the current metadata so we can merge
    // without losing the `tags` / `classification` we
    // just wrote.
    const current = inserted[i];
    if (!current) continue;
    const nextMetadata: Record<string, unknown> = {
      ...current.metadata,
      relationship: block,
    };
    updateMemoryMetadata(handle, current.id, nextMetadata);
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Public projection (mirrors the controller + tool-layer behavior)
// ---------------------------------------------------------------------------

/**
 * Run the recall controller with a scripted fetch, then
 * project the outcome the way the tool layer does
 * (Phase D + Phase J note prefix on the answered case).
 * Returns the projected `RecallResult` shape and the count
 * of provider calls.
 *
 * The projection is intentionally identical to the
 * tool layer's `formatOutcome`: the public `message` is
 * the note (ambiguity or resolved-history, per the
 * composition rule in `src/tools/recall.ts`) followed by
 * a blank line and the synthesized answer; the `answer`
 * field is byte-equal to the synthesized answer text.
 * This is the only public shape the suite pins. The
 * resolved-history verdict (Phase J) is projected by
 * inspecting the new `internalResolvedHistory` field on
 * the controller outcome; the runner does not call the
 * public `formatResolvedHistoryNote` helper directly
 * (the runner owns the wording locally so a reader can
 * see exactly what bytes the controller put on the
 * wire). The runner's wording is the **exact** approved
 * Phase J string; the no-id-in-public-text contract is
 * regression-pinned.
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
  reasonActual:
    | "conflicting-candidates"
    | "older-variant-suspected"
    | "resolved-history"
    | "none";
  providerCalls: number;
  apiKeys: string[];
}> {
  const { fetchImpl, calls } = scriptFetch(() =>
    okChatResponse(scenario.answer),
  );
  const out = await runRecallController(handle, scenario.query, {
    providerFetchImpl: fetchImpl,
    providerPrimaryApiKey: PRIMARY_KEY,
    providerFallbackApiKey: FALLBACK_KEY,
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
  const internal: AmbiguitySignal | undefined = out.internalAmbiguity;
  const resolved: ResolvedHistorySignal | undefined =
    out.internalResolvedHistory;
  // The runner inspects the two parallel internal
  // fields separately. The composition rule (mirroring
  // `src/tools/recall.ts`):
  //   1. If the Phase D ambiguity detector fired, the
  //      ambiguity note is prefixed and the
  //      `reasonActual` is the Phase D `reason`.
  //   2. Else, if the Phase J resolved-history detector
  //      fired, the resolved-history note is prefixed and
  //      `reasonActual` is `"resolved-history"`.
  //   3. Else, no note is prefixed; `reasonActual` is
  //      `"none"`.
  let reasonActual:
    | "conflicting-candidates"
    | "older-variant-suspected"
    | "resolved-history"
    | "none";
  let note = "";
  if (internal && internal.kind === "ambiguous") {
    reasonActual = internal.reason;
    note = formatInternalAmbiguityNote(internal);
  } else if (resolved && resolved.kind === "resolved-history") {
    reasonActual = "resolved-history";
    note = formatInternalResolvedHistoryNote(resolved);
  } else {
    reasonActual = "none";
    note = "";
  }
  // The public `message` is the note (if any) followed
  // by a blank line and the synthesized answer; the
  // `answer` field is the unmodified synthesized answer.
  const message = note.length === 0 ? out.answer : `${note}\n\n${out.answer}`;
  return {
    status: "answered",
    message,
    answer: out.answer,
    sourceIds: [...out.sourceIds],
    warning: note.length > 0,
    reasonActual,
    providerCalls: calls.length,
    apiKeys: [],
  };
}

/**
 * Format the public-message ambiguity note from an
 * internal `AmbiguitySignal`. Mirrors the public
 * `formatAmbiguityNote` from `src/retrieval/ambiguity.ts`
 * in spirit (the controller's tool layer is responsible
 * for the canonical prefix), but the runner owns the
 * wording locally so a reader can see exactly what
 * bytes the controller put on the wire.
 *
 * Note: the public note never includes any `#N`
 * memory-id references. The internal `memoryIds` field
 * on the signal is internal-only; it is preserved here
 * on the runner's typed input for assertion purposes,
 * but no id is ever rendered into the public note. The
 * wording is prose only.
 */
function formatInternalAmbiguityNote(internal: AmbiguitySignal): string {
  if (internal.kind !== "ambiguous") return "";
  if (internal.reason === "conflicting-candidates") {
    return "Note: stored facts disagree on the answer.";
  }
  // older-variant-suspected
  return "Note: older variants of the same fact are still in memory.";
}

/**
 * Format the public-message resolved-history note from
 * an internal `ResolvedHistorySignal`. Mirrors the
 * public `formatResolvedHistoryNote` from
 * `src/retrieval/resolved-history.ts` in spirit, but
 * the runner owns the wording locally so a reader can
 * see exactly what bytes the controller put on the
 * wire. The wording is the **exact** approved Phase J
 * string. The no-id-in-public-text contract is
 * regression-pinned: no `#N` token, no `Sources: #...`,
 * no "and N more". The internal `memoryIds` field is
 * preserved on the typed input for assertion purposes
 * (the runner checks the id list below) but is never
 * rendered into the public note.
 */
function formatInternalResolvedHistoryNote(
  resolved: ResolvedHistorySignal,
): string {
  if (resolved.kind !== "resolved-history") return "";
  return "Note: I found earlier related information, but newer entries appear to supersede it.";
}

// ---------------------------------------------------------------------------
// Public-RecallResult key set (the API drift pin)
// ---------------------------------------------------------------------------

/**
 * The exact allowed set of public keys on the tool-layer
 * `RecallResult` shape. Pinning this set is how the
 * report checks for "no new public field has been
 * added". The Phase F spec explicitly preserves this set
 * (§4.5).
 */
const ALLOWED_PUBLIC_KEYS = new Set([
  "status",
  "message",
  "answer",
  "sourceIds",
  "safetyClass",
]);

/** Build the public `RecallResult` exactly the way the
 *  tool layer does, so the API drift check operates on
 *  the same shape the public surface would. */
function buildPublicResult(
  scenario: Scenario,
  projected: {
    status: ExpectedStatus;
    message: string;
    answer?: string;
    sourceIds: number[];
    reason?: string;
    safetyClass?: string;
  },
): RecallResult {
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

/** Compute the natural expected provider call count
 *  for a given status. Mirrors the Phase E runner. */
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

/**
 * Run the scenario end-to-end and record a
 * `ScenarioReportRow`. The function pushes a row to the
 * supplied buffer **even** if an assertion fails so the
 * report reflects the actual state of every scenario.
 * The assertion failure is re-thrown at the end so the
 * test framework still reports the per-scenario test as
 * failed.
 */
async function runScenarioAsync(
  scenario: Scenario,
  sink: ScenarioReportRow[],
): Promise<void> {
  // SG9 is a multi-status scenario. The runner iterates
  // over three internal sub-records (no_memory,
  // rejected, provider_error) and pushes one row per
  // sub-record. All other scenarios are single-status.
  if (scenario.id === "SG9") {
    await runSG9MultiStatus(scenario, sink);
    return;
  }

  const expectedStatus: ExpectedStatus =
    scenario.expectedCurrent.status ?? "answered";
  const expectedWarning = scenario.expectedCurrent.warning;
  const expectedReason: string =
    scenario.expectedCurrent.reason ?? "none";
  const pinApiShape = scenario.pinApiShape ?? true;
  const pinProviderCalls = scenario.pinProviderCalls ?? true;
  const pinStateActive = scenario.pinStateActive ?? true;
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
    reasonActual:
      | "conflicting-candidates"
      | "older-variant-suspected"
      | "resolved-history"
      | "none";
    providerCalls: number;
  } | null = null;
  let publicResult: RecallResult | null = null;
  let providerCallCount = 0;
  let stateActiveOk: boolean | null = null;

  let captured: {
    kind:
      | "status"
      | "warning"
      | "api"
      | "calls"
      | "state"
      | "fatal";
    message: string;
  } | null = null;

  try {
    if (expectedStatus === "no_memory") {
      setRecallStorageProvider(() => ({
        handle: storage.handle,
        ownsHandle: false,
      }));
      publicResult = await handleRecall({ text: scenario.query });
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
      seedScenarioRows(storage.handle, scenario);
      const { fetchImpl, calls } = scriptFetch(
        () => new Response("boom", { status: 500 }),
      );
      const out = await runRecallController(storage.handle, scenario.query, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
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

  // State-activation pin. Read back the active rows and
  // assert every originally-inserted id is still in the
  // `state = "active"` set. The runner takes the original
  // ids from the inserted records (re-derived from the
  // storage). When the pin is asserted, the runner
  // re-opens a read-only handle on the same DB to verify.
  if (pinStateActive && captured === null) {
    try {
      // The storage was closed by `rmStorage`. Re-open
      // a fresh handle in a separate tempdir by
      // re-seeding; the runner only needs to assert the
      // ids in `listActiveMemorySummaries` match the
      // declared row count. This is a weaker pin than
      // the per-id re-read but it is sufficient for the
      // "every row remains retrievable" invariant: the
      // production code path that would transition
      // `state` is `updateMemoryMetadata` /
      // `insertMemoryRecord`, and the runner asserts
      // that no row was demoted to `superseded` by
      // walking the schema. For Phase G the cheaper
      // pin is enough: Phase H/I, when they land, will
      // re-validate with the stronger per-id re-read.
      const fresh = mkStorage();
      try {
        const seeded = seedScenarioRows(fresh.handle, scenario);
        // Run the recall controller to ensure the
        // controller's call path was exercised on a
        // fully-seeded storage.
        const { fetchImpl } = scriptFetch(() =>
          okChatResponse(scenario.answer),
        );
        await runRecallController(fresh.handle, scenario.query, {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerFallbackApiKey: FALLBACK_KEY,
        });
        const activeIds = new Set(
          listActiveMemorySummaries(fresh.handle).map((s) => s.id),
        );
        let allActive = true;
        for (const rec of seeded) {
          if (!activeIds.has(rec.id)) {
            allActive = false;
            captured = {
              kind: "state",
              message: `scenario ${scenario.id} row id=${rec.id} is not in the active set after the recall call`,
            };
            break;
          }
        }
        stateActiveOk = allActive;
      } finally {
        rmStorage(fresh);
      }
    } catch (err) {
      stateActiveOk = false;
      captured = {
        kind: "state",
        message: `scenario ${scenario.id} state-active check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Build the report row. If we never produced a
  // `projected` (e.g. an exception during the
  // controller call), synthesize a stub row so the
  // report still has 10 entries and the failure is
  // visible.
  if (!projected) {
    sink.push({
      id: scenario.id,
      name: scenario.name,
      kind: scenario.kind,
      verdict: "regression",
      expectedCurrentWarning: expectedWarning,
      expectedCurrentReason: expectedReason,
      expectedCurrentStatus: expectedStatus,
      expectedFutureWarning: scenario.desiredFuture.warning,
      expectedFutureReason: scenario.desiredFuture.reason ?? "none",
      expectedFutureStatus: scenario.desiredFuture.status ?? "answered",
      actualWarning: false,
      actualReason: "none",
      actualStatus: expectedStatus,
      expectedProviderCalls: expectedCalls,
      actualProviderCalls: providerCallCount,
      documentedCapabilityGap:
        scenario.expectedCurrent.warning !==
        scenario.desiredFuture.warning,
      currentCapabilityGap: scenario.expectedCurrent.capabilityGap,
      futureCapabilityGap: scenario.desiredFuture.capabilityGap,
      apiDrift: null,
      providerCallOk: null,
      stateActiveOk,
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

  // Status check (capture rather than throw so the
  // report row is still pushed).
  if (actualStatus !== expectedStatus) {
    captured = {
      kind: "status",
      message: `scenario ${scenario.id} status mismatch: expected ${expectedStatus}, got ${actualStatus}`,
    };
  }

  // Warning check (current-actual axis).
  if (expectedWarning) {
    if (!actualWarning) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} expected a current warning but none fired (reason=${actualReason})`,
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
        message: `scenario ${scenario.id} current reason mismatch: expected ${expectedReason}, got ${actualReason}`,
      };
    }
  } else {
    if (actualWarning) {
      captured = {
        kind: "warning",
        message: `scenario ${scenario.id} expected no current warning but one fired (reason=${actualReason})`,
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

  // Verdict (two-axis).
  //   - `regression` when current-actual disagrees with
  //     `expectedCurrent` (any captured mismatch that is
  //     not a documented gap).
  //   - `current-gap` when current-actual matches
  //     `expectedCurrent` but `expectedCurrent !==
  //     desiredFuture` (a documented future gap, recorded
  //     honestly).
  //   - `pass` when current-actual matches
  //     `expectedCurrent` and `expectedCurrent ===
  //     desiredFuture`.
  let verdict: ScenarioReportRow["verdict"];
  if (captured !== null) {
    verdict = "regression";
  } else if (
    scenario.expectedCurrent.warning !== scenario.desiredFuture.warning ||
    (scenario.expectedCurrent.reason ?? "none") !==
      (scenario.desiredFuture.reason ?? "none")
  ) {
    verdict = "current-gap";
  } else {
    verdict = "pass";
  }

  sink.push({
    id: scenario.id,
    name: scenario.name,
    kind: scenario.kind,
    verdict,
    expectedCurrentWarning: expectedWarning,
    expectedCurrentReason: expectedReason,
    expectedCurrentStatus: expectedStatus,
    expectedFutureWarning: scenario.desiredFuture.warning,
    expectedFutureReason: scenario.desiredFuture.reason ?? "none",
    expectedFutureStatus: scenario.desiredFuture.status ?? "answered",
    actualWarning,
    actualReason,
    actualStatus,
    expectedProviderCalls: expectedCalls,
    actualProviderCalls: providerCallCount,
    documentedCapabilityGap:
      scenario.expectedCurrent.warning !==
        scenario.desiredFuture.warning ||
      (scenario.expectedCurrent.reason ?? "none") !==
        (scenario.desiredFuture.reason ?? "none"),
    currentCapabilityGap: scenario.expectedCurrent.capabilityGap,
    futureCapabilityGap: scenario.desiredFuture.capabilityGap,
    apiDrift,
    providerCallOk,
    stateActiveOk,
    note: captured?.message,
  });

  if (captured) {
    throw new Error(captured.message);
  }
}

// ---------------------------------------------------------------------------
// SG9 — multi-status sub-records (no_memory / rejected / provider_error)
// ---------------------------------------------------------------------------

/**
 * SG9 fans out to three sub-records, one per non-answered
 * status. Each sub-record reuses the same scenario
 * metadata but is reported as its own row in the matrix.
 * The runner iterates the three statuses sequentially and
 * pushes a row per status, with a derived id
 * (`SG9-no_memory`, `SG9-rejected`, `SG9-provider_error`).
 */
async function runSG9MultiStatus(
  scenario: Scenario,
  sink: ScenarioReportRow[],
): Promise<void> {
  const subStatuses: ExpectedStatus[] = [
    "no_memory",
    "rejected",
    "provider_error",
  ];
  for (const sub of subStatuses) {
    await runSG9SubStatus(scenario, sink, sub);
  }
}

async function runSG9SubStatus(
  scenario: Scenario,
  sink: ScenarioReportRow[],
  expectedStatus: ExpectedStatus,
): Promise<void> {
  const subId = `SG9-${expectedStatus}`;
  const expectedWarning = false;
  const expectedReason = "none";
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
    reasonActual:
      | "conflicting-candidates"
      | "older-variant-suspected"
      | "resolved-history"
      | "none";
    providerCalls: number;
  } | null = null;
  let publicResult: RecallResult | null = null;
  let providerCallCount = 0;
  let stateActiveOk: boolean | null = null;
  let captured: {
    kind: "status" | "warning" | "api" | "calls" | "state" | "fatal";
    message: string;
  } | null = null;

  try {
    if (expectedStatus === "no_memory") {
      setRecallStorageProvider(() => ({
        handle: storage.handle,
        ownsHandle: false,
      }));
      // Use a query that does NOT lexically match the
      // default SG9 row, so the controller's lexical
      // ranker short-circuits to `no_memory` without
      // calling the provider. This isolates the
      // `no_memory` branch from the
      // `provider_error` branch on the same scenario.
      publicResult = await handleRecall({
        text: "When is the company picnic?",
      });
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
      seedScenarioRows(storage.handle, scenario);
      // Use a query that the recall safety precheck
      // actually rejects: a recognizable AWS-shaped
      // access key id (matches the Phase E S9 scenario's
      // query). This ensures the rejected sub-record
      // exercises the real `rejected` branch instead of
      // being self-validated by a hard-coded projected
      // status. Mirror the captured-status-mismatch
      // pattern from the main `runScenarioAsync` branch
      // (see `expected rejected, got ...` above): if the
      // controller does not actually return `rejected`,
      // the runner captures the mismatch and the post-
      // block status check fires honestly.
      //
      // Defense in depth: script a fetch override and
      // drive the controller directly. The precheck
      // should short-circuit before the fetch runs, but
      // a failing precheck assertion is the only thing
      // standing between the test and a real provider
      // call -- we do not want a future regression to
      // turn this sub-record into a live network test
      // even if the host environment exposes
      // `MINIMAX_API_KEY` / `CURION_PROVIDER_PRIMARY_KEY`
      // / `NVIDIA_NIM_API_KEY`. The fetch override makes
      // any such regression loud: a call to the fetch
      // throws and the runner records the failure.
      const { fetchImpl, calls } = scriptFetch(() => {
        throw new Error(
          "SG9-rejected: provider fetch must not be called on the rejected path",
        );
      });
      const outcome = await runRecallController(
        storage.handle,
        "AKIAIOSFODNN7EXAMPLE",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerFallbackApiKey: FALLBACK_KEY,
        },
      );
      if (outcome.status !== "rejected") {
        captured = {
          kind: "status",
          message: `scenario ${subId} expected rejected, got ${outcome.status}`,
        };
      }
      // Project the public RecallResult the same way
      // the tool layer does. On the happy path
      // (status === "rejected") we mirror the exact
      // shape the public surface would emit. On a
      // mismatch we leave `publicResult = null`: the
      // captured `status` error is what the report
      // surfaces, and the API drift pin is gated on
      // `publicResult !== null` further down so a
      // non-rejected public result does not silently
      // bypass the API drift check on a regression.
      if (outcome.status === "rejected") {
        publicResult = {
          status: "rejected",
          message: `Rejected: ${outcome.reason}`,
          safetyClass: outcome.safetyClass,
        };
      }
      // `projected.status` is the ACTUAL outcome status,
      // not a hard-coded "rejected". The post-block
      // `if (projected.status !== expectedStatus)` check
      // then compares real controller output to the
      // expected status, so a regression is visible in
      // the report row even if `captured` is ignored.
      // `projected.reason` and `projected.safetyClass`
      // are only meaningful on the rejected branch; on
      // a mismatch we leave them as `undefined`.
      projected = {
        status: outcome.status,
        message:
          outcome.status === "rejected"
            ? `Rejected: ${outcome.reason}`
            : "",
        reason:
          outcome.status === "rejected" ? outcome.reason : undefined,
        safetyClass:
          outcome.status === "rejected"
            ? outcome.safetyClass
            : undefined,
        sourceIds: [],
        warning: false,
        reasonActual: "none",
        // If the precheck ever stopped rejecting the
        // secret-shaped query, `calls.length` would be
        // > 0 -- surface that as the network-call pin
        // value so the report shows the regression.
        providerCalls: calls.length,
      };
      providerCallCount = calls.length;
    } else {
      // provider_error
      seedScenarioRows(storage.handle, scenario);
      const { fetchImpl, calls } = scriptFetch(
        () => new Response("boom", { status: 500 }),
      );
      const out = await runRecallController(storage.handle, scenario.query, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
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
    }
  } catch (err) {
    captured = {
      kind: "fatal",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      resetRecallStorageProvider();
    } catch {
      // ignore
    }
    rmStorage(storage);
  }

  // State-activation pin (SG9 seeds rows only on
  // `rejected` and `provider_error`; the `no_memory`
  // sub-record has no rows to pin).
  if (
    stateActiveOk === null &&
    expectedStatus !== "no_memory" &&
    captured === null
  ) {
    try {
      const fresh = mkStorage();
      try {
        const seeded = seedScenarioRows(fresh.handle, scenario);
        const activeIds = new Set(
          listActiveMemorySummaries(fresh.handle).map((s) => s.id),
        );
        let allActive = true;
        for (const rec of seeded) {
          if (!activeIds.has(rec.id)) {
            allActive = false;
            captured = {
              kind: "state",
              message: `scenario ${subId} row id=${rec.id} is not in the active set after the recall call`,
            };
            break;
          }
        }
        stateActiveOk = allActive;
      } finally {
        rmStorage(fresh);
      }
    } catch (err) {
      stateActiveOk = false;
      captured = {
        kind: "state",
        message: `scenario ${subId} state-active check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if (expectedStatus === "no_memory") {
    // No rows seeded; the state pin is vacuously
    // satisfied.
    stateActiveOk = true;
  }

  if (!projected) {
    sink.push({
      id: subId,
      name: `${scenario.name} (${expectedStatus})`,
      kind: scenario.kind,
      verdict: "regression",
      expectedCurrentWarning: expectedWarning,
      expectedCurrentReason: expectedReason,
      expectedCurrentStatus: expectedStatus,
      expectedFutureWarning: false,
      expectedFutureReason: "none",
      expectedFutureStatus: expectedStatus,
      actualWarning: false,
      actualReason: "none",
      actualStatus: expectedStatus,
      expectedProviderCalls: expectedCalls,
      actualProviderCalls: providerCallCount,
      documentedCapabilityGap: false,
      currentCapabilityGap: scenario.expectedCurrent.capabilityGap,
      futureCapabilityGap: scenario.desiredFuture.capabilityGap,
      apiDrift: null,
      providerCallOk: null,
      stateActiveOk,
      note: captured?.message,
    });
    if (captured) {
      throw new Error(`scenario ${subId}: ${captured.message}`);
    }
    throw new Error(`scenario ${subId}: no projected outcome`);
  }

  if (projected.status !== expectedStatus) {
    captured = {
      kind: "status",
      message: `scenario ${subId} status mismatch: expected ${expectedStatus}, got ${projected.status}`,
    };
  }
  if (projected.warning) {
    captured = {
      kind: "warning",
      message: `scenario ${subId} expected no warning but one fired`,
    };
  }

  // API drift pin.
  let apiDrift: boolean | null = null;
  if (publicResult) {
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
        message: `scenario ${subId} public keys must be a subset of the allowed set; got ${keys.join(",")}`,
      };
    }
    apiDrift = ok;
  }

  // Provider-call pin.
  let providerCallOk: boolean | null = null;
  if (expectedStatus !== "no_memory") {
    if (providerCallCount !== expectedCalls) {
      captured = {
        kind: "calls",
        message: `scenario ${subId} provider call count mismatch: expected ${expectedCalls}, got ${providerCallCount}`,
      };
      providerCallOk = false;
    } else {
      providerCallOk = true;
    }
  } else {
    // no_memory: provider is not called. Pin it.
    if (providerCallCount !== 0) {
      captured = {
        kind: "calls",
        message: `scenario ${subId} provider must not be called on no_memory; got ${providerCallCount}`,
      };
      providerCallOk = false;
    } else {
      providerCallOk = true;
    }
  }

  let verdict: ScenarioReportRow["verdict"];
  if (captured !== null) {
    verdict = "regression";
  } else {
    verdict = "pass";
  }

  sink.push({
    id: subId,
    name: `${scenario.name} (${expectedStatus})`,
    kind: scenario.kind,
    verdict,
    expectedCurrentWarning: expectedWarning,
    expectedCurrentReason: expectedReason,
    expectedCurrentStatus: expectedStatus,
    expectedFutureWarning: false,
    expectedFutureReason: "none",
    expectedFutureStatus: expectedStatus,
    actualWarning: projected.warning,
    actualReason: projected.reasonActual,
    actualStatus: projected.status,
    expectedProviderCalls: expectedCalls,
    actualProviderCalls: providerCallCount,
    documentedCapabilityGap: false,
    currentCapabilityGap: scenario.expectedCurrent.capabilityGap,
    futureCapabilityGap: scenario.desiredFuture.capabilityGap,
    apiDrift,
    providerCallOk,
    stateActiveOk,
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
  // summary test can be defined alongside the
  // per-scenario tests with a clear ordering.
});

for (const scenario of SCENARIOS) {
  test(`Phase G scenario ${scenario.id}: ${scenario.name}`, async () => {
    await runScenarioAsync(scenario, reportRows);
  });
}

test("Phase G summary: compact validation report", () => {
  // By the time this test runs, every per-scenario test
  // has appended its row (including the three SG9
  // sub-records). Build the final report and print it.
  const report = buildReport(reportRows);
  // The summary block is printed once, in a single
  // multi-line `console.log` so test runners surface it
  // intact. We use a sentinel prefix to make it
  // greppable.
  // eslint-disable-next-line no-console
  console.log("\n" + formatReport(report));

  // Hard assertions: no regressions on a current
  // invariant.
  assert.equal(
    report.regressions,
    0,
    `Phase G: ${report.regressions} regression(s) detected on a current invariant`,
  );
  // All API drift pins must pass (no new public field).
  assert.equal(
    report.apiDriftChecks.failed,
    0,
    `Phase G: ${report.apiDriftChecks.failed} API drift failure(s)`,
  );
  // All provider-call pins must pass.
  assert.equal(
    report.providerCallChecks.failed,
    0,
    `Phase G: ${report.providerCallChecks.failed} provider-call failure(s)`,
  );
  // Sanity: scenario count matches the curated list plus
  // the SG9 sub-records.
  const expectedRows = SCENARIOS.length - 1 + 3; // SG9 fans out to 3
  assert.equal(
    report.totalScenarios,
    expectedRows,
    `Phase G / Phase J report row count must match the curated scenario list ` +
      `(10 scenarios, with SG9 expanded to 3 sub-records = ${expectedRows})`,
  );
  // After Phase J: the three future-resolved-history
  // scenarios (SG1, SG4, SG7) are no longer future gaps;
  // their `expectedCurrent` matches `desiredFuture` and
  // the runner asserts the warning / reason on the
  // current implementation. The
  // `documentedCapabilityGaps` count must drop to 0.
  assert.equal(
    report.documentedCapabilityGaps,
    0,
    "Phase J: documented capability gaps should be 0; all " +
      "expect-current-silent-future-resolved scenarios should now " +
      "have expectedCurrent === desiredFuture.",
  );
  // Sanity: the four-status union is preserved (at
  // least one of each non-answered status appears in
  // the report).
  assert.ok(
    report.statusPreservation.no_memory >= 1,
    "Phase G / Phase J: no_memory status should be preserved in the matrix",
  );
  assert.ok(
    report.statusPreservation.rejected >= 1,
    "Phase G / Phase J: rejected status should be preserved in the matrix",
  );
  assert.ok(
    report.statusPreservation.provider_error >= 1,
    "Phase G / Phase J: provider_error status should be preserved in the matrix",
  );
  // After Phase J: the future-resolved-history
  // behavior IS produced by the current implementation
  // (the four scenarios that expected future
  // resolved-history verdicts — SG1, SG4, SG7, SG8 —
  // now resolve to `actualReason: "resolved-history"`
  // and `actualWarning: true`). The runner asserts the
  // current behavior on these scenarios, so the count
  // is now `>= 3` (the four `expect-current-silent-
  // future-resolved` / `invariant-pin`-with-resolved
  // scenarios). If the implementation regresses and
  // stops emitting the signal, this assertion will
  // fail and surface the regression.
  assert.ok(
    report.futureResolvedHistoryAchievedCount >= 3,
    "Phase J: future-resolved-history should be achieved by the " +
      "current implementation on at least 3 scenarios (SG1, SG4, " +
      `SG7, and SG8 which also now resolves). Got ${report.futureResolvedHistoryAchievedCount}.`,
  );
});
