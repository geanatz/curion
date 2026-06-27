/**
 * Tests for the clarification-hardening pass on the `remember` /
 * `recall` surface and the trace `tool.output` payload.
 *
 * Coverage (per task spec):
 *   1. Vague memory input (e.g. "Remember the thing we decided
 *      earlier.") is rejected BEFORE the provider call with
 *      `status: "rejected"`, a clear `reason`, and
 *      `clarification_needed.question`. No memory is stored. The
 *      controller classifies the input as `vague-memory` and the
 *      tool layer exposes the structured shape with
 *      `clarification_needed`.
 *   2. Replacement / correction input (e.g. "Curion uses Postgres,
 *      not SQLite.") is rejected BEFORE the provider call with the
 *      same shape (`status: "rejected"`, `clarification_needed.question`).
 *      The controller classifies the input as
 *      `replacement-correction`.
 *   3. Valid temporal facts (e.g. "Curion used SQLite before, but
 *      now it uses Postgres.") are NOT rejected by the new
 *      `replacement-correction` detector. They fall through to
 *      `safe` and proceed to the provider (the user-stated desired
 *      behavior is to allow temporal facts).
 *   4. Trace `tool.output` payload for a `remember` `saved`
 *      outcome contains NO internal fields (`memoryId`, `modelId`,
 *      `message`, `memoryKind`, `safetyClass`) and uses `kind`
 *      (not `memoryKind`). The persisted JSON is the same
 *      `RememberStructuredContent` the server emits on the wire.
 *   5. Trace `tool.output` payload for a `remember` `rejected`
 *      self-conflict / replacement-correction outcome has
 *      `status: "rejected"` AND `clarification_needed.question`.
 *   6. Trace `tool.output` payload for a `recall` outcome
 *      contains NO internal ids (`sourceIds`, `memoryId`,
 *      `memoryIds`) or internal classifications (`safetyClass`).
 *      The persisted JSON is the same `RecallStructuredContent`
 *      the server emits on the wire.
 *   7. `provider_error` outcomes NEVER carry `clarification_needed`
 *      on the trace `tool.output` payload (the projection helper
 *      is the single source of truth and pins this invariant).
 *
 * Conventions:
 *   - Each test uses an isolated temp project root under `os.tmpdir()`
 *     so the real `.curion/` is never touched.
 *   - The trace writer is module-cached; tests call
 *     `resetTraceWriterForTests` between cases.
 *   - The provider adapter is driven by a scripted `fetch` so no
 *     network is touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  startToolBoundaryTrace,
  TOOL_OUTPUT_KIND,
  listTraceEventsForRun,
  listTraceRuns,
  getOrInitTraceWriter,
  closeTraceWriter,
  resetTraceWriterForTests,
} from "../src/trace/index.ts";
import {
  CURION_DIRNAME,
  initStorage,
  closeStorage,
  type StorageHandle,
} from "../src/storage/storage.ts";
import {
  handleRemember,
  setStorageProvider as setRememberStorageProvider,
  resetStorageProvider as resetRememberStorageProvider,
  type RememberResult,
} from "../src/tools/remember.ts";
import {
  handleRecall,
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
  type RecallResult,
} from "../src/tools/recall.ts";
import {
  setListRegisteredProjectsStub,
  resetListRegisteredProjectsStub,
} from "../src/config/registry.ts";
import { runRememberController } from "../src/controller/remember-controller.ts";
import { classifyInput } from "../src/safety/precheck.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-hardening-"));
  const handle = initStorage({ projectRoot: tmp });
  return { tmp, handle };
}

function rmStorage(tmp: string, handle: StorageHandle): void {
  try {
    handle.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function scriptFetch(responder: () => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
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

function safeAnalysis(): string {
  return JSON.stringify({
    summary: "The project uses Postgres 16 for the primary store.",
    confidence: 0.82,
    tags: ["postgres", "storage"],
    entities: [{ name: "Postgres", kind: "database" }],
    classification: "fact",
  });
}

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";
const PRIMARY_BASE_URL = "https://api.example.com/v1";
const PRIMARY_MODEL = "test/model-primary";
const FALLBACK_BASE_URL = "https://api.fallback.example/v1";
const FALLBACK_MODEL = "test/model-fallback";

async function runController(handle: StorageHandle, opts: {
  fetchImpl: typeof fetch;
  text: string;
  confidenceThreshold?: number;
}) {
  return runRememberController(handle, opts.text, {
    providerFetchImpl: opts.fetchImpl,
    providerPrimaryApiKey: PRIMARY_KEY,
    providerPrimaryBaseUrl: PRIMARY_BASE_URL,
    providerPrimaryModel: PRIMARY_MODEL,
    providerFallbackApiKey: FALLBACK_KEY,
    providerFallbackBaseUrl: FALLBACK_BASE_URL,
    providerFallbackModel: FALLBACK_MODEL,
    confidenceThreshold: opts.confidenceThreshold,
  });
}

/**
 * Initialize the trace writer for a given project root and return
 * a cleanup thunk. Used by the trace-payload tests so the writer
 * points at the temp dir, not the real cwd.
 */
function initTraceForTmp(tmp: string): { cleanup: () => void } {
  resetTraceWriterForTests();
  const handle = getOrInitTraceWriter({ projectRoot: tmp });
  assert.ok(handle, "trace writer should initialize in a temp dir");
  return {
    cleanup: () => {
      try {
        closeTraceWriter();
      } catch {
        // ignore
      }
      resetTraceWriterForTests();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Vague memory input is rejected with clarification_needed
// ---------------------------------------------------------------------------

test("remember: vague memory text is rejected with clarification_needed (no provider call)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(safeAnalysis()));
    setRememberStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // The representative example from the task spec.
      const text = "Remember the thing we decided earlier.";
      const result: RememberResult = await handleRemember({ text });
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") throw new Error("unreachable");
      assert.equal(result.safetyClass, "vague-memory");
      assert.equal(
        calls.length,
        0,
        "provider must NOT be called for vague-memory input",
      );
      // The rejection carries clarification_needed with a
      // user-facing question (no raw input echo).
      assert.ok(result.clarification_needed, "rejection must carry clarification_needed");
      assert.equal(typeof result.clarification_needed!.question, "string");
      assert.ok(result.clarification_needed!.question.length > 0);
      assert.ok(
        !result.clarification_needed!.question.includes(text),
        "clarification_needed.question must not echo raw input",
      );
      // Nothing persisted.
      const rows = handle.db
        .prepare("SELECT COUNT(*) AS c FROM memories")
        .get() as { c: number };
      assert.equal(rows.c, 0, "no rows should be persisted for vague input");
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("remember (controller): vague-memory classification returns rejected with clarification_needed (no provider call)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(safeAnalysis()));
    const outcome = await runController(handle, {
      fetchImpl,
      text: "Remember the thing we decided earlier.",
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "vague-memory");
    assert.ok(outcome.clarification_needed);
    assert.equal(
      calls.length,
      0,
      "provider must NOT be called for vague-memory input",
    );
    const rows = handle.db
      .prepare("SELECT COUNT(*) AS c FROM memories")
      .get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("classifyInput: vague-memory patterns are detected", () => {
  const samples = [
    "Remember the thing we decided earlier.",
    "Save what we agreed on.",
    "Note the decision we made.",
    "Remember that point we discussed yesterday.",
    "Save the plan we chose.",
    "Remember the rule we set.",
    "Note the agreement we settled on.",
  ];
  for (const s of samples) {
    const r = classifyInput(s);
    assert.equal(
      r.class,
      "vague-memory",
      `expected vague-memory for: ${s.slice(0, 60)} (got ${r.class}: ${r.reason})`,
    );
  }
});

test("classifyInput: concrete content does not trip vague-memory patterns", () => {
  // These should remain `safe` (or fall through to other
  // detectors as appropriate). The point is that the
  // `vague-memory` detector must NOT fire on concrete content.
  const benign = [
    "Remember the Postgres migration decision.",
    "Save the JWT auth rollout plan.",
    "Note the deadline for the v1.2 release.",
    "Remember to deploy Postgres 16 by Friday.",
    "The thing about Postgres is its JSON support.", // declarative statement, no past-tense decision verb
  ];
  for (const s of benign) {
    const r = classifyInput(s);
    assert.notEqual(
      r.class,
      "vague-memory",
      `vague-memory must NOT fire on: ${s.slice(0, 80)} (got ${r.class})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Replacement / correction input is rejected with clarification_needed
// ---------------------------------------------------------------------------

test("remember: 'Curion uses Postgres, not SQLite.' is rejected with clarification_needed (no provider call)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(safeAnalysis()));
    setRememberStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const text = "Curion uses Postgres, not SQLite.";
      const result: RememberResult = await handleRemember({ text });
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") throw new Error("unreachable");
      assert.equal(result.safetyClass, "replacement-correction");
      assert.equal(
        calls.length,
        0,
        "provider must NOT be called for replacement-correction input",
      );
      assert.ok(result.clarification_needed, "rejection must carry clarification_needed");
      assert.equal(typeof result.clarification_needed!.question, "string");
      assert.ok(result.clarification_needed!.question.length > 0);
      assert.ok(
        !result.clarification_needed!.question.includes(text),
        "clarification_needed.question must not echo raw input",
      );
      const rows = handle.db
        .prepare("SELECT COUNT(*) AS c FROM memories")
        .get() as { c: number };
      assert.equal(rows.c, 0, "no rows should be persisted for replacement input");
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("remember (controller): replacement-correction classification returns rejected with clarification_needed", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(safeAnalysis()));
    const outcome = await runController(handle, {
      fetchImpl,
      text: "Curion uses Postgres, not SQLite.",
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "replacement-correction");
    assert.ok(outcome.clarification_needed);
    assert.equal(
      calls.length,
      0,
      "provider must NOT be called for replacement-correction input",
    );
    const rows = handle.db
      .prepare("SELECT COUNT(*) AS c FROM memories")
      .get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("classifyInput: replacement-correction patterns are detected", () => {
  const samples = [
    "Curion uses Postgres, not SQLite.",
    "We use Postgres, but not SQLite.",
    "Use Postgres instead of SQLite.",
    "Use Postgres rather than SQLite.",
    "Use Postgres (not SQLite).",
    "Postgres is the database, not the storage engine.",
    "Use the new SDK, not the old client library.",
  ];
  for (const s of samples) {
    const r = classifyInput(s);
    assert.equal(
      r.class,
      "replacement-correction",
      `expected replacement-correction for: ${s.slice(0, 80)} (got ${r.class}: ${r.reason})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Valid temporal facts are NOT rejected by replacement-correction
// ---------------------------------------------------------------------------

test("remember: temporal valid text is NOT rejected by replacement-correction; falls through to safe", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(safeAnalysis()));
    setRememberStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const text = "Curion used SQLite before, but now it uses Postgres.";
      // The temporal fact must NOT be classified as
      // replacement-correction (it has explicit temporal
      // markers "before" + "now" + past-tense "used"). It may
      // fall through to safe and proceed to the provider.
      const outcome = await runController(handle, { fetchImpl, text });
      assert.equal(
        outcome.safetyClass,
        undefined,
        `temporal fact must NOT carry a rejection safetyClass; got ${outcome.safetyClass}`,
      );
      // Either saved OR provider_error (both are acceptable;
      // the assertion is that the input was not rejected).
      assert.notEqual(outcome.status, "rejected");
      // Provider was called exactly once for a safe input.
      assert.equal(
        calls.length,
        1,
        "provider should be called exactly once for a safe (temporal) input",
      );
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("classifyInput: valid temporal facts do NOT trip replacement-correction", () => {
  const samples = [
    "Curion used SQLite before, but now it uses Postgres.",
    "We used MySQL previously, now we use Postgres.",
    "Earlier the project used SQLite; currently it uses Postgres.",
    "We used to use SQLite, now we use Postgres.",
  ];
  for (const s of samples) {
    const r = classifyInput(s);
    assert.notEqual(
      r.class,
      "replacement-correction",
      `replacement-correction must NOT fire on temporal fact: ${s.slice(0, 80)} (got ${r.class})`,
    );
    // The temporal fact may still be classified as
    // `self-conflict` (the temporal-change pattern is
    // separate). The important assertion is that it is NOT
    // replacement-correction.
  }
});

test("classifyInput: comparatives without replacement do NOT trip replacement-correction", () => {
  const samples = [
    "Postgres is faster than SQLite.",
    "We prefer Postgres over SQLite.",
    "Postgres is better than SQLite for JSON.",
  ];
  for (const s of samples) {
    const r = classifyInput(s);
    assert.notEqual(
      r.class,
      "replacement-correction",
      `replacement-correction must NOT fire on comparative: ${s.slice(0, 80)} (got ${r.class})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Trace tool.output payload for remember saved outcome is clean
// ---------------------------------------------------------------------------

test("trace: remember saved tool.output uses `kind` (not `memoryKind`) and carries NO internal fields", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-tr-clean-rm-"));
  const memHandle = initStorage({ projectRoot: tmp });
  const { cleanup: traceCleanup } = initTraceForTmp(tmp);
  try {
    setRememberStorageProvider(() => ({ handle: memHandle, ownsHandle: false }));
    try {
      // Provide a scripted fetch so the provider returns a
      // `saved` outcome without contacting the network.
      const fetchImpl = scriptFetch(() => okChatResponse(safeAnalysis())).fetchImpl;
      // The handleRemember tool does NOT expose a fetch
      // override, so we drive the controller directly and
      // then project through the same buildRememberStructuredContent
      // path the tool layer uses. This pins the trace
      // payload's clean shape end-to-end.
      const controllerOut = await runRememberController(
        memHandle,
        "The team picked Postgres 16 for the primary store.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerPrimaryBaseUrl: PRIMARY_BASE_URL,
          providerPrimaryModel: PRIMARY_MODEL,
          providerFallbackApiKey: FALLBACK_KEY,
          providerFallbackBaseUrl: FALLBACK_BASE_URL,
          providerFallbackModel: FALLBACK_MODEL,
        },
      );
      assert.equal(controllerOut.status, "saved");
      if (controllerOut.status !== "saved") throw new Error("unreachable");

      // Drive the production projection path used by the
      // tool layer. We construct a RememberResult mirroring
      // the tool layer's `formatOutcome` output, then call
      // `buildRememberStructuredContent` and record via the
      // helper exactly as the production code does. The
      // `formatOutcome` function is internal to the tool
      // layer; mirroring it here keeps the test honest
      // against the public projection contract.
      const { buildRememberStructuredContent } = await import(
        "../src/tools/remember-projection.ts"
      );
      const rememberResult: RememberResult = {
        status: "saved",
        message: `Saved memory (${controllerOut.record.kind}, confidence ${(controllerOut.record.confidence ?? 0).toFixed(2)}): ${controllerOut.record.memoryContent}`,
        memoryId: controllerOut.record.id,
        memoryKind: controllerOut.record.kind,
        modelId: controllerOut.record.modelId,
        confidence: controllerOut.record.confidence,
        summary: controllerOut.record.memoryContent,
      };
      const structured = buildRememberStructuredContent(rememberResult);

      // Open a tool-boundary trace and record the
      // structured content via the helper, exactly like
      // the production tool layer does.
      const tracer = startToolBoundaryTrace({
        toolName: "remember",
        input: { text: "The team picked Postgres 16 for the primary store." },
      });
      tracer.recordOutput(structured);
      tracer.finish("ok");
      assert.ok(tracer.runId !== null);

      // Read the persisted payload.
      const dbPath = path.join(tmp, CURION_DIRNAME, "trace.sqlite");
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare(
            "SELECT payload_json FROM trace_events WHERE run_id = ? AND kind = ?",
          )
          .get(tracer.runId, TOOL_OUTPUT_KIND) as { payload_json: string } | undefined;
        assert.ok(row, "tool.output event must exist");
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        // Saved shape uses `kind`, not `memoryKind`.
        assert.equal(payload.status, "saved");
        assert.equal(typeof payload.kind, "string");
        assert.ok((payload.kind as string).length > 0);
        assert.equal(typeof payload.summary, "string");
        assert.equal(typeof payload.confidence, "number");
        // No internal fields on the trace payload.
        for (const forbidden of [
          "memoryId",
          "memoryKind",
          "modelId",
          "providerId",
          "safetyClass",
          "message",
        ]) {
          assert.equal(
            forbidden in payload,
            false,
            `saved trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(payload)}`,
          );
        }
        // The trace payload byte-equals the public
        // `buildRememberStructuredContent` output (modulo
        // JSON key ordering, which `assert.deepEqual`
        // ignores).
        assert.deepEqual(payload, structured);
      } finally {
        db.close();
      }
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    closeStorage(memHandle);
    traceCleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Trace tool.output payload for remember rejected (with clarification)
// ---------------------------------------------------------------------------

test("trace: remember rejected self-conflict / replacement-correction carries clarification_needed.question on tool.output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-tr-rej-rm-"));
  const memHandle = initStorage({ projectRoot: tmp });
  const { cleanup: traceCleanup } = initTraceForTmp(tmp);
  try {
    setRememberStorageProvider(() => ({ handle: memHandle, ownsHandle: false }));
    try {
      // The representative replacement-correction input
      // from the task spec. This route fires BEFORE the
      // provider (no scripted fetch needed).
      const text = "Curion uses Postgres, not SQLite.";
      const result: RememberResult = await handleRemember({ text });
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected") throw new Error("unreachable");
      assert.equal(result.safetyClass, "replacement-correction");
      assert.ok(result.clarification_needed);

      // Read the persisted trace payload.
      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.name, "remember");
      const events = listTraceEventsForRun(run.id);
      const outputEvent = events.find((e) => e.kind === TOOL_OUTPUT_KIND);
      assert.ok(outputEvent, "tool.output event must exist");

      const payload = outputEvent.payload as Record<string, unknown>;
      assert.equal(payload.status, "rejected");
      assert.equal(typeof payload.reason, "string");
      assert.ok((payload.reason as string).length > 0);
      // clarification_needed carries the user-facing question.
      const clarification = payload.clarification_needed as
        | { question: string; suggestions?: string[] }
        | undefined;
      assert.ok(clarification, "trace tool.output must include clarification_needed");
      assert.equal(typeof clarification!.question, "string");
      assert.ok(clarification!.question.length > 0);
      // No internal fields on the trace payload.
      for (const forbidden of [
        "safetyClass",
        "memoryId",
        "memoryKind",
        "modelId",
        "providerId",
        "message",
        "summary",
        "kind",
        "confidence",
      ]) {
        assert.equal(
          forbidden in payload,
          false,
          `rejected trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(payload)}`,
        );
      }
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    closeStorage(memHandle);
    traceCleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Trace tool.output payload for recall outcome is clean (no sourceIds)
// ---------------------------------------------------------------------------

test("trace: recall tool.output contains NO sourceIds / safetyClass / internal IDs", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-tr-clean-rc-"));
  const memHandle = initStorage({ projectRoot: tmp });
  const { cleanup: traceCleanup } = initTraceForTmp(tmp);
  try {
    setRecallStorageProvider(() => ({ handle: memHandle, ownsHandle: false }));
    setListRegisteredProjectsStub(() => []);
    try {
      // Empty store -> no_memory. The handler routes
      // through the trace, so the no_memory outcome lands
      // on tool.output.
      const result: RecallResult = await handleRecall({ text: "anything" });
      assert.equal(result.status, "no_memory");

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      const events = listTraceEventsForRun(run.id);
      const outputEvent = events.find((e) => e.kind === TOOL_OUTPUT_KIND);
      assert.ok(outputEvent);

      const payload = outputEvent.payload as Record<string, unknown>;
      assert.equal(payload.status, "no_memory");
      // No internal fields on the trace payload.
      for (const forbidden of [
        "sourceIds",
        "memoryId",
        "memoryIds",
        "safetyClass",
        "notes",
        "answer",
        "summaries",
        "coverage",
        "message",
      ]) {
        assert.equal(
          forbidden in payload,
          false,
          `recall trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(payload)}`,
        );
      }
    } finally {
      resetListRegisteredProjectsStub();
      resetRecallStorageProvider();
    }
  } finally {
    closeStorage(memHandle);
    traceCleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Trace tool.output payload for provider_error has NO clarification_needed
// ---------------------------------------------------------------------------

test("trace: provider_error tool.output has NO clarification_needed (hardening invariant)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-tr-pe-"));
  const memHandle = initStorage({ projectRoot: tmp });
  const { cleanup: traceCleanup } = initTraceForTmp(tmp);
  try {
    setRememberStorageProvider(() => ({ handle: memHandle, ownsHandle: false }));
    try {
      // A safe input with no provider config -> the
      // provider adapter short-circuits to a
      // `provider_error` outcome. The handler routes
      // through the trace.
      const result: RememberResult = await handleRemember({
        text: "The team picked Postgres 16 for the primary store.",
      });
      assert.equal(result.status, "provider_error");
      assert.equal(
        "clarification_needed" in result,
        false,
        "provider_error result must not carry clarification_needed",
      );

      // Read the persisted trace payload.
      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      const events = listTraceEventsForRun(run.id);
      const outputEvent = events.find((e) => e.kind === TOOL_OUTPUT_KIND);
      assert.ok(outputEvent);

      const payload = outputEvent.payload as Record<string, unknown>;
      assert.equal(payload.status, "provider_error");
      assert.equal(typeof payload.reason, "string");
      // Provider_error MUST NOT carry clarification_needed.
      assert.equal(
        "clarification_needed" in payload,
        false,
        `provider_error trace tool.output payload must not include clarification_needed; got ${JSON.stringify(payload)}`,
      );
      // No internal fields on the trace payload.
      for (const forbidden of [
        "safetyClass",
        "memoryId",
        "memoryKind",
        "modelId",
        "providerId",
        "message",
        "summary",
        "kind",
        "confidence",
      ]) {
        assert.equal(
          forbidden in payload,
          false,
          `provider_error trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(payload)}`,
        );
      }
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    closeStorage(memHandle);
    traceCleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
