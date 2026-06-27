/**
 * Tests for Curion Local Trace Phase 2: tool-boundary tracing.
 *
 * The Phase 2 instrumented `remember` / `recall` handlers write
 * one trace run with a `tool.input` event and a `tool.output`
 * event per public invocation. The trace storage is the same
 * `.curion/trace.sqlite` the Phase 1 foundation owns, kept
 * strictly separate from the memory DB. Tracing is enabled by
 * default and respects `CURION_TRACE_ENABLED=0`.
 *
 * Coverage (per task spec):
 *   1. remember creates a trace run / events containing input
 *      and output when enabled, without changing the returned
 *      result.
 *   2. recall creates a trace run / events similarly.
 *   3. `CURION_TRACE_ENABLED=0` prevents trace writes for tool
 *      boundary calls.
 *   4. Simulated trace writer / storage failure does not change
 *      remember / recall output.
 *   5. Credentials / reasoning redaction applies to traced
 *      inputs / outputs (the tool boundary routes through the
 *      redaction layer).
 *   6. No memory DB is touched beyond the normal remember /
 *      recall behavior, and the trace DB lives next to it in
 *      `.curion/` without colliding.
 *
 * Conventions:
 *   - All tests use isolated temp directories under `os.tmpdir()`
 *     so the real project `.curion/curion.sqlite` is never
 *     touched.
 *   - The trace writer is module-cached; the test harness resets
 *     the writer (`resetTraceWriterForTests`) and re-inits it
 *     against the temp project root between cases.
 *   - `process.env.CURION_TRACE_ENABLED` is saved and restored
 *     per test so env pollution does not leak into other tests.
 *   - The tool handlers' storage providers are pointed at the
 *     test's per-case `StorageHandle` with `ownsHandle: false`
 *     so the test owns the lifecycle and can close the handle
 *     deterministically.
 *
 * Test pattern:
 *   - The async tests below use try / finally so the writer
 *     and the memory handle are closed BEFORE the test
 *     function returns. The Node test runner awaits the
 *     returned promise, and a clean shutdown prevents
 *     "asynchronous activity after the test ended" warnings
 *     caused by post-test cleanup races.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  startToolBoundaryTrace,
  TOOL_INPUT_KIND,
  TOOL_OUTPUT_KIND,
  RECALL_ACTIVE_MEMORY_READ_KIND,
  RECALL_LEXICAL_RANKING_KIND,
  RECALL_SELECTED_CANDIDATES_KIND,
  RECALL_SUPERSEDED_DEMOTION_KIND,
  type ToolBoundaryTracer,
} from "../src/trace/trace-tool-boundary.ts";
import {
  closeTraceWriter,
  getOrInitTraceWriter,
  isTraceEnabled,
  listTraceEventsForRun,
  listTraceRuns,
  resetTraceWriterForTests,
} from "../src/trace/index.ts";
import {
  CURION_DIRNAME,
  initStorage,
  closeStorage,
  insertMemoryRecord,
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
import {
  runRecallController,
  type RecallTraceContext,
} from "../src/controller/recall-controller.ts";

// ---------------------------------------------------------------------------
// Env / state helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot `process.env.CURION_TRACE_ENABLED` and restore it on
 * exit. The trace module is env-driven at call time, so tests
 * that flip the switch must restore the env afterwards. The
 * helper is async-aware: it awaits a returned promise before
 * restoring the env.
 */
async function withEnvSnapshot<T>(fn: () => T | Promise<T>): Promise<T> {
  const orig = process.env.CURION_TRACE_ENABLED;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env.CURION_TRACE_ENABLED;
    else process.env.CURION_TRACE_ENABLED = orig;
  }
}

/** Build a fresh temp project root. */
function mkTraceDir(label = "curion-tb-trace-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

function rmTraceDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Initialize BOTH the memory DB and the trace writer against
 * the same temp project root. Returns a small handle with the
 * memory handle. Caller is responsible for calling the returned
 * `cleanup` once the test body is done. The cleanup closes the
 * memory DB and resets the trace writer module-level state so
 * nothing leaks into the next case.
 *
 * Use this from inside a test's `try { ... } finally { cleanup(); }`
 * block. It is synchronous because the writer API is synchronous
 * and the test body that uses the handle is what runs the async
 * controller / fetch work.
 */
function setupBothStores(projectRoot: string): {
  memHandle: StorageHandle;
  cleanup: () => void;
} {
  const memHandle = initStorage({ projectRoot });
  // Reset and re-init the trace writer so it points at the
  // test's project root (not the real cwd).
  resetTraceWriterForTests();
  const traceHandle = getOrInitTraceWriter({ projectRoot });
  assert.ok(traceHandle, "trace writer should initialize in a temp dir");
  return {
    memHandle,
    cleanup: () => {
      try {
        closeStorage(memHandle);
      } catch {
        // ignore
      }
      try {
        closeTraceWriter();
      } catch {
        // ignore
      }
      resetTraceWriterForTests();
    },
  };
}

/**
 * Open the on-disk trace DB read-only for white-box assertions.
 */
function openTraceDbReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Fetch a run row + its events from the on-disk DB. The reader
 * API (`listTraceRuns` / `listTraceEventsForRun`) would also
 * work, but white-box reads let the test assert exact row
 * ordering and persisted JSON shapes.
 */
function readRunAndEvents(
  projectRoot: string,
  runId: number,
): {
  run: {
    id: number;
    name: string;
    started_at: number;
    ended_at: number | null;
    status: string;
    metadata: string | null;
  };
  events: Array<{
    id: number;
    run_id: number;
    ts: number;
    kind: string;
    payload_json: string | null;
    redacted_keys: string | null;
    sequence: number;
  }>;
} {
  const dbPath = path.join(projectRoot, CURION_DIRNAME, "trace.sqlite");
  const db = openTraceDbReadOnly(dbPath);
  try {
    const run = db
      .prepare(
        `SELECT id, name, started_at, ended_at, status, metadata
           FROM trace_runs WHERE id = ?`,
      )
      .get(runId) as {
      id: number;
      name: string;
      started_at: number;
      ended_at: number | null;
      status: string;
      metadata: string | null;
    };
    const events = db
      .prepare(
        `SELECT id, run_id, ts, kind, payload_json, redacted_keys, sequence
           FROM trace_events
          WHERE run_id = ?
          ORDER BY sequence ASC`,
      )
      .all(runId) as Array<{
      id: number;
      run_id: number;
      ts: number;
      kind: string;
      payload_json: string | null;
      redacted_keys: string | null;
      sequence: number;
    }>;
    return { run, events };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The tool-boundary tests below do not need a scripted fetch /
// provider stub. The VAGUE-JUNK path on remember and the empty-
// store short-circuit on recall both complete before the
// provider is called, so no fetch configuration is required.
// Keeping the file self-contained here means the trace tests
// stay independent of the provider adapter layer.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Helper-level contract
// ---------------------------------------------------------------------------

test("helper: startToolBoundaryTrace creates a run, records input + output, finishes with status + duration", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    const start = 1_000_000;
    let now = start;
    const clock = () => now;
    const tracer: ToolBoundaryTracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "hello world" },
      clock,
    });
    assert.ok(tracer.runId !== null, "tracer should have a run id");
    assert.equal(tracer.toolName, "remember");
    assert.equal(tracer.startedAt, start);

    // Advance the clock and record the output.
    now = 1_000_025;
    tracer.recordOutput({
      status: "saved",
      summary: "ok",
      kind: "fact",
    });

    // Finish. Duration should be 50ms (ended - started).
    now = 1_000_050;
    tracer.finish("ok");

    // Read back the run + events from disk.
    const { run, events } = readRunAndEvents(tmp, tracer.runId as number);
    assert.equal(run.name, "remember");
    assert.equal(run.started_at, start);
    assert.equal(run.ended_at, 1_000_050);
    assert.equal(run.status, "ok");
    const meta = JSON.parse(run.metadata ?? "null") as Record<string, unknown>;
    assert.equal(meta.tool, "remember");
    assert.equal(meta.boundary, "public-tool-handler");
    assert.equal(meta.durationMs, 50);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, TOOL_INPUT_KIND);
    assert.equal(events[0]?.sequence, 1);
    const inputPayload = JSON.parse(
      events[0]?.payload_json ?? "null",
    ) as { text: string };
    assert.equal(inputPayload.text, "hello world");
    assert.equal(events[1]?.kind, TOOL_OUTPUT_KIND);
    assert.equal(events[1]?.sequence, 2);
    const outputPayload = JSON.parse(
      events[1]?.payload_json ?? "null",
    ) as { status: string; summary: string; kind: string };
    assert.equal(outputPayload.status, "saved");
    assert.equal(outputPayload.summary, "ok");
    assert.equal(outputPayload.kind, "fact");
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("helper: finish is idempotent (calling it twice does not double-update the run)", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "x" },
    });
    tracer.recordOutput({ status: "saved" });
    tracer.finish("ok");
    const first = listTraceRuns().find((r) => r.id === tracer.runId);
    const endedAt1 = first?.endedAt ?? null;
    tracer.finish("ok");
    const second = listTraceRuns().find((r) => r.id === tracer.runId);
    // The second finish must not have changed the run.
    assert.equal(second?.endedAt, endedAt1);
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("helper: when CURION_TRACE_ENABLED=0, the tracer is a safe no-op (no run id, no events)", () => {
  const tmp = mkTraceDir();
  withEnvSnapshot(() => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      // Even with a fresh project root, no .curion/ must be
      // created when tracing is disabled. The helper must
      // also short-circuit without touching the writer.
      const tracer = startToolBoundaryTrace({
        toolName: "remember",
        input: { text: "x" },
      });
      assert.equal(tracer.runId, null);
      // recordOutput / finish must not throw and must be no-ops.
      assert.doesNotThrow(() => tracer.recordOutput({ status: "saved" }));
      assert.doesNotThrow(() => tracer.finish("ok"));
      // No .curion/ was created.
      assert.ok(
        !fs.existsSync(path.join(tmp, ".curion")),
        "no .curion/ must be created when tracing is disabled",
      );
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Tool-handler integration: remember
// ---------------------------------------------------------------------------

test("remember: creates a trace run + tool.input + tool.output events without changing the returned result", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    // We exercise the instrumented handleRemember with a
    // VAGUE-JUNK input. The safety pre-check rejects the
    // input BEFORE the provider is called, so the test does
    // not need a working provider config. This pins the
    // trace contract end-to-end: the public result is
    // unchanged, the run is `ok`, and the input + output
    // events are persisted with the redacted payload.
    setRememberStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    try {
      const rawText = "asdf";
      const result: RememberResult = await handleRemember({ text: rawText });
      // Result is unchanged: the public rejected outcome.
      assert.equal(result.status, "rejected");
      assert.equal(result.safetyClass, "vague-junk");

      // Exactly one trace run for the instrumented handler.
      // The controller-direct path was not used in this
      // case, so only `handleRemember` produced a run.
      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0];
      assert.ok(run, "trace run must exist");
      assert.equal(run.name, "remember");
      assert.equal(run.status, "ok");
      // durationMs is a non-negative number in metadata.
      const meta = run.metadata as Record<string, unknown>;
      assert.equal(meta.tool, "remember");
      assert.equal(meta.boundary, "public-tool-handler");
      assert.equal(typeof meta.durationMs, "number");
      assert.ok((meta.durationMs as number) >= 0);

      // Two events: tool.input and tool.output, in that order.
      const events = listTraceEventsForRun(run.id);
      assert.equal(events.length, 2);
      assert.equal(events[0]?.kind, "tool.input");
      assert.equal(events[1]?.kind, "tool.output");

      // The input event carries only the public `text` field.
      const inputPayload = events[0]?.payload as { text: string };
      assert.equal(inputPayload.text, rawText);

      // Hardening pass: the output event carries the
      // user-approved public structured shape (NOT the full
      // internal `RememberResult`). The trace must NOT include
      // `safetyClass`, `memoryId`, `modelId`, `memoryKind`,
      // or the public `message` field. The shape is the
      // same `RememberStructuredContent` the server emits on
      // the wire.
      const outputPayload = events[1]?.payload as Record<string, unknown>;
      assert.equal(outputPayload.status, "rejected");
      assert.equal(typeof outputPayload.reason, "string");
      assert.ok((outputPayload.reason as string).length > 0);
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
          forbidden in outputPayload,
          false,
          `trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(outputPayload)}`,
        );
      }
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 3. Tool-handler integration: recall
// ---------------------------------------------------------------------------

test("recall: creates a trace run + tool.input + tool.output events without changing the returned result", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    setListRegisteredProjectsStub(() => []);
    try {
      // Use a query against an empty store. The controller
      // short-circuits to `no_memory` BEFORE the provider
      // is called, so the test does not need a working
      // provider config. This pins the trace contract for
      // the recall path: result unchanged, run `ok`, input
      // and output events persisted.
      const query = "anything";
      const result: RecallResult = await handleRecall({ text: query });
      assert.equal(result.status, "no_memory");

      // Exactly one trace run for the instrumented handler.
      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0];
      assert.ok(run);
      assert.equal(run.name, "recall");
      assert.equal(run.status, "ok");
      const meta = run.metadata as Record<string, unknown>;
      assert.equal(meta.tool, "recall");
      assert.equal(meta.boundary, "public-tool-handler");
      assert.equal(typeof meta.durationMs, "number");

      // Phase 2 + Phase 3A: tool.input, then two stage events
      // (active-memory-read + lexical-ranking for the empty
      // store path), then tool.output.
      const events = listTraceEventsForRun(run.id);
      assert.equal(events.length, 4);
      assert.equal(events[0]?.kind, "tool.input");
      assert.equal(events[1]?.kind, RECALL_ACTIVE_MEMORY_READ_KIND);
      assert.equal(events[2]?.kind, RECALL_LEXICAL_RANKING_KIND);
      assert.equal(events[3]?.kind, "tool.output");

      const inputPayload = events[0]?.payload as { text: string };
      assert.equal(inputPayload.text, query);

      // Hardening pass: the output event carries the
      // user-approved public structured shape (NOT the full
      // internal `RecallResult`). The trace must NOT include
      // `sourceIds`, `safetyClass`, `notes`, `answer`,
      // `summaries`, or the public `message` field. The
      // shape is the same `RecallStructuredContent` the
      // server emits on the wire.
      const outputPayload = events[3]?.payload as Record<string, unknown>;
      assert.equal(outputPayload.status, "no_memory");
      // No internal fields on the trace payload.
      for (const forbidden of [
        "safetyClass",
        "sourceIds",
        "memoryId",
        "memoryIds",
        "notes",
        "answer",
        "summaries",
        "coverage",
        "message",
      ]) {
        assert.equal(
          forbidden in outputPayload,
          false,
          `trace tool.output payload must not include '${forbidden}'; got ${JSON.stringify(outputPayload)}`,
        );
      }
    } finally {
      resetListRegisteredProjectsStub();
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4. Off switch: CURION_TRACE_ENABLED=0 prevents tool-boundary writes
// ---------------------------------------------------------------------------

test("remember: CURION_TRACE_ENABLED=0 prevents trace writes for tool boundary calls", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        setRememberStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        try {
          // Use a VAGUE-JUNK input so the safety pre-check
          // rejects before the provider is called. The
          // public result must be the rejected outcome, and
          // tracing must not affect it.
          const result = await handleRemember({ text: "asdf" });
          assert.equal(result.status, "rejected");
          assert.equal(result.safetyClass, "vague-junk");

          // No trace DB row, no .curion/trace.sqlite, no run.
          const traceDir = path.join(tmp, ".curion");
          assert.ok(
            !fs.existsSync(path.join(traceDir, "trace.sqlite")),
            "no trace.sqlite must be created when tracing is disabled",
          );
          // The memory DB is fine.
          assert.ok(
            fs.existsSync(path.join(traceDir, "curion.sqlite")),
            "memory DB must be present (it was created before the off switch)",
          );
        } finally {
          resetRememberStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("recall: CURION_TRACE_ENABLED=0 prevents trace writes for tool boundary calls", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        setRecallStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        setListRegisteredProjectsStub(() => []);
        try {
          const result = await handleRecall({ text: "anything" });
          assert.equal(result.status, "no_memory");
          // No trace.sqlite when disabled.
          const traceDir = path.join(tmp, ".curion");
          assert.ok(
            !fs.existsSync(path.join(traceDir, "trace.sqlite")),
            "no trace.sqlite must be created when tracing is disabled",
          );
        } finally {
          resetListRegisteredProjectsStub();
          resetRecallStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Storage failure does not change the tool result
// ---------------------------------------------------------------------------

test("remember: simulated trace writer failure does not change the result", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    // Tracing is enabled (default) so the writer would try
    // to write. We then close the writer mid-test,
    // simulating a storage failure: subsequent writes are
    // no-ops. The tool handler must still return the
    // correct result.
    delete process.env.CURION_TRACE_ENABLED;
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        setRememberStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        try {
          // Simulate a storage failure: close the writer so
          // all subsequent trace writes are no-ops. The
          // tracer sees runId === null and skips every
          // event.
          closeTraceWriter();

          // Use a VAGUE-JUNK input so the safety pre-check
          // rejects before the provider is called. The
          // public result is the rejected outcome; the
          // trace failure must not perturb it.
          const result = await handleRemember({ text: "asdf" });
          assert.equal(result.status, "rejected");
          assert.equal(result.safetyClass, "vague-junk");
          assert.equal(typeof result.message, "string");
          assert.ok(result.message.length > 0);
        } finally {
          resetRememberStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("recall: simulated trace writer failure does not change the result", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    delete process.env.CURION_TRACE_ENABLED;
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        setRecallStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        setListRegisteredProjectsStub(() => []);
        try {
          // Simulate storage failure before the tool call.
          closeTraceWriter();

          // The empty store short-circuits to no_memory
          // before the provider is called. The public
          // result is unchanged by the trace failure.
          const result = await handleRecall({ text: "anything" });
          assert.equal(result.status, "no_memory");
          assert.equal(typeof result.message, "string");
          assert.ok(result.message.length > 0);
        } finally {
          resetListRegisteredProjectsStub();
          resetRecallStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Redaction applies to traced inputs / outputs at the tool boundary
// ---------------------------------------------------------------------------

test("redaction: traced tool.output with a sensitive key gets the key redacted in the persisted payload", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    // The normal public tool output does not include
    // sensitive keys. To exercise the redaction pass at the
    // tool boundary we go through the helper directly with
    // a payload that has an `apiKey` field. The helper is
    // the exact one the handlers use; the writer applies
    // `redactPayload` to every event payload.
    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "harmless input" },
    });
    tracer.recordOutput({
      status: "saved",
      summary: "ok",
      apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      nested: { apiKey: "sk-nested-key" },
    });
    tracer.finish("ok");

    // Read back the persisted tool.output event and verify
    // redaction.
    const run = listTraceRuns()[0];
    assert.ok(run, "trace run must exist");
    const events = listTraceEventsForRun(run.id);
    const outputEvent = events.find((e) => e.kind === "tool.output");
    assert.ok(outputEvent, "tool.output event must exist");
    // The persisted payload's `apiKey` and the nested one
    // are both redacted.
    const payload = outputEvent.payload as Record<string, unknown>;
    assert.equal(payload.apiKey, "<redacted>");
    const nested = payload.nested as Record<string, unknown>;
    assert.equal(nested.apiKey, "<redacted>");
    // The redacted_keys list reports the top-level redaction.
    assert.ok(outputEvent.redactedKeys.includes("apiKey"));
    // The raw secret value is not in the persisted JSON.
    const persisted = JSON.stringify(outputEvent.payload);
    assert.ok(
      !persisted.includes("sk-aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      "raw api key must not survive in the persisted payload",
    );
    assert.ok(
      !persisted.includes("sk-nested-key"),
      "raw nested api key must not survive in the persisted payload",
    );
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("redaction: traced tool.input with a sensitive fragment in the text gets the fragment scrubbed", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    // The helper records the `text` field of the input as
    // the payload. `redactPayload` will scrub a
    // secret-shaped substring from the text. We pass an
    // input whose `text` carries an AKIA- shaped fragment
    // and verify the persisted payload's text does not.
    const secretText =
      "Project uses Postgres 16. Token: AKIAIOSFODNN7EXAMPLE. Tests run in 12s.";
    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: secretText },
    });
    tracer.recordOutput({ status: "rejected", safetyClass: "secret" });
    tracer.finish("ok");

    const run = listTraceRuns()[0];
    assert.ok(run);
    const events = listTraceEventsForRun(run.id);
    const inputEvent = events.find((e) => e.kind === "tool.input");
    assert.ok(inputEvent);
    const persisted = JSON.stringify(inputEvent.payload);
    assert.ok(
      !persisted.includes("AKIAIOSFODNN7EXAMPLE"),
      "raw AKIA-shaped fragment must not survive in the persisted input payload",
    );
    assert.match(persisted, /<redacted>/);
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("redaction: traced tool.input with a reasoning-shaped object drops the reasoning field entirely", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    // The helper records `{ text: ... }` as the input
    // payload (it does not look at other top-level keys).
    // To exercise the redaction-on-payload path with a
    // reasoning-shaped object, we go through recordOutput
    // (which the tool boundary uses for the result).
    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "x" },
    });
    tracer.recordOutput({
      status: "saved",
      reasoning: "internal chain-of-thought should never survive",
      chainOfThought: "another reasoning carrier",
      summary: "ok",
    });
    tracer.finish("ok");

    const run = listTraceRuns()[0];
    assert.ok(run);
    const events = listTraceEventsForRun(run.id);
    const outputEvent = events.find((e) => e.kind === "tool.output");
    assert.ok(outputEvent);
    const payload = outputEvent.payload as Record<string, unknown>;
    assert.ok(
      !("reasoning" in payload),
      "reasoning key must be dropped from the persisted tool.output payload",
    );
    assert.ok(
      !("chainOfThought" in payload),
      "chainOfThought key must be dropped from the persisted tool.output payload",
    );
    assert.equal(payload.summary, "ok");
    assert.ok(outputEvent.redactedKeys.includes("reasoning"));
    assert.ok(outputEvent.redactedKeys.includes("chainOfThought"));
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 7. Memory DB is untouched beyond normal remember / recall; trace DB
//    is separate.
// ---------------------------------------------------------------------------

test("trace DB is separate from the memory DB (no collisions; both present after handleRemember)", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRememberStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    try {
      await handleRemember({ text: "asdf" });

      // Both DBs must be present in `.curion/`.
      const dir = path.join(tmp, ".curion");
      const entries = fs.readdirSync(dir);
      assert.ok(
        entries.includes("curion.sqlite"),
        "memory DB must be present after handleRemember",
      );
      assert.ok(
        entries.includes("trace.sqlite"),
        "trace DB must be present after handleRemember",
      );

      // The memory DB must NOT have a `trace_runs` or
      // `trace_events` table (the trace schema is isolated).
      const memTables = (memHandle.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type IN ('table', 'index')
              AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>).map((r) => r.name);
      assert.ok(
        !memTables.includes("trace_runs"),
        "memory DB must not have a trace_runs table",
      );
      assert.ok(
        !memTables.includes("trace_events"),
        "memory DB must not have a trace_events table",
      );

      // The trace DB must NOT have a `memories` table.
      const traceDb = openTraceDbReadOnly(
        path.join(dir, "trace.sqlite"),
      );
      try {
        const traceTables = (traceDb
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type IN ('table', 'index')
                AND name NOT LIKE 'sqlite_%'`,
          )
          .all() as Array<{ name: string }>).map((r) => r.name);
        assert.ok(
          !traceTables.includes("memories"),
          "trace DB must not have a memories table",
        );
        assert.ok(traceTables.includes("trace_runs"));
        assert.ok(traceTables.includes("trace_events"));
      } finally {
        traceDb.close();
      }
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("handleRemember: no additional memory writes beyond the normal controller path (count is unchanged by tracing)", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRememberStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    try {
      // The trace path must not write to the memory DB.
      // We use a VAGUE-JUNK input so the controller
      // short-circuits before the provider is called AND
      // before any DB write. The memory count must be
      // unchanged.
      const before = (memHandle.db
        .prepare("SELECT COUNT(*) AS c FROM memories")
        .get() as { c: number }).c;
      const result = await handleRemember({ text: "asdf" });
      assert.equal(result.status, "rejected");
      const after = (memHandle.db
        .prepare("SELECT COUNT(*) AS c FROM memories")
        .get() as { c: number }).c;
      assert.equal(after, before, "no memory should be written for a rejected input");
    } finally {
      resetRememberStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 8. Sanity: the env switch + writer state at the start of each test
// ---------------------------------------------------------------------------

test("isTraceEnabled: defaults to ON (no env switch) so the helper writes by default", () => {
  withEnvSnapshot(() => {
    delete process.env.CURION_TRACE_ENABLED;
    assert.equal(isTraceEnabled(), true);
  });
});

// ---------------------------------------------------------------------------
// 9. Phase 3A: recall stage event tracing
// ---------------------------------------------------------------------------
//
// The recall controller emits three stage events
// (`recall.active-memory-read`, `recall.lexical-ranking`,
// `recall.selected-candidates`) on the SAME trace run that
// carries the public `tool.input` and `tool.output` events.
// The events are only emitted when tracing is enabled and a
// trace context is provided.

test("recall Phase 3A: empty store emits active-memory-read + lexical-ranking stage events on the same run as tool.input/tool.output", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    setListRegisteredProjectsStub(() => []);
    try {
      // Empty store → no_memory. The controller emits
      // active-memory-read (count=0) and lexical-ranking
      // (empty ranked list) before the early return.
      const result: RecallResult = await handleRecall({ text: "anything" });
      assert.equal(result.status, "no_memory");

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.name, "recall");

      const events = listTraceEventsForRun(run.id);
      // Expected: tool.input, recall.active-memory-read,
      // recall.lexical-ranking, tool.output
      assert.equal(events.length, 4, "expected 4 events: tool.input + 2 stages + tool.output");
      assert.equal(events[0]!.kind, TOOL_INPUT_KIND);
      assert.equal(events[1]!.kind, RECALL_ACTIVE_MEMORY_READ_KIND);
      assert.equal(events[2]!.kind, RECALL_LEXICAL_RANKING_KIND);
      assert.equal(events[3]!.kind, TOOL_OUTPUT_KIND);

      // Verify active-memory-read payload.
      const amr = events[1]!.payload as {
        readCount: number;
        storageLimit: number;
      };
      assert.equal(amr.readCount, 0, "empty store → readCount=0");
      assert.equal(typeof amr.storageLimit, "number");
      assert.ok(amr.storageLimit > 0);

      // Verify lexical-ranking payload.
      const lr = events[2]!.payload as {
        query: string;
        threshold: number;
        topK: number;
        ranked: unknown[];
      };
      assert.equal(lr.query, "anything");
      assert.equal(typeof lr.threshold, "number");
      assert.equal(typeof lr.topK, "number");
      assert.deepEqual(lr.ranked, [], "empty store → no ranked candidates");

      // No selected-candidates event because the controller
      // returns no_memory before reaching that point.
      const selectedEvents = events.filter(
        (e) => e.kind === RECALL_SELECTED_CANDIDATES_KIND,
      );
      assert.equal(selectedEvents.length, 0, "no selected-candidates on no_memory path");
    } finally {
      resetListRegisteredProjectsStub();
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("recall Phase 3A: populated store emits all three stage events before provider call", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    try {
      // Insert two memories: one relevant, one irrelevant.
      insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent:
          "The project uses Postgres 16 for the primary data store.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.9,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["postgres", "database"] },
      });
      insertMemoryRecord(memHandle, {
        kind: "context",
        state: "active",
        memoryContent:
          "Office plants are watered on a biweekly rotation.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.8,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["plants", "office"] },
      });

      // No API keys configured → provider returns
      // missing-config error immediately (no network call).
      // The result is provider_error, but all three trace
      // stage events are emitted before the provider call.
      const result: RecallResult = await handleRecall({
        text: "What database does the project use?",
      });
      assert.equal(result.status, "provider_error");

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const events = listTraceEventsForRun(runs[0]!.id);

      // Expected: tool.input, recall.active-memory-read,
      // recall.lexical-ranking, recall.superseded-demotion,
      // recall.selected-candidates, tool.output
      assert.equal(events.length, 6, "expected 6 events: tool.input + 4 stages + tool.output");
      assert.equal(events[0]!.kind, TOOL_INPUT_KIND);
      assert.equal(events[1]!.kind, RECALL_ACTIVE_MEMORY_READ_KIND);
      assert.equal(events[2]!.kind, RECALL_LEXICAL_RANKING_KIND);
      assert.equal(events[3]!.kind, RECALL_SUPERSEDED_DEMOTION_KIND);
      assert.equal(events[4]!.kind, RECALL_SELECTED_CANDIDATES_KIND);
      assert.equal(events[5]!.kind, TOOL_OUTPUT_KIND);

      // Verify active-memory-read: 2 memories in the store.
      const amr = events[1]!.payload as { readCount: number };
      assert.equal(amr.readCount, 2);

      // Verify lexical-ranking: at least one candidate passed
      // the threshold for a database-related query.
      const lr = events[2]!.payload as {
        query: string;
        ranked: Array<{
          id: number;
          rank: number;
          score: number;
          overlap: number;
          memoryContent: string | null;
          kind: string | null;
          tags: string[];
          classification: string | null;
          confidence: number | null;
        }>;
      };
      assert.equal(lr.query, "What database does the project use?");
      assert.ok(lr.ranked.length > 0, "at least one candidate should rank");
      // The ranked candidate should have the expected fields.
      const first = lr.ranked[0]!;
      assert.equal(typeof first.id, "number");
      assert.equal(first.rank, 1);
      assert.ok(first.score > 0, "ranked candidate must have positive score");
      assert.equal(typeof first.overlap, "number");
      assert.equal(typeof first.memoryContent, "string");
      assert.ok(first.memoryContent!.length > 0);

      // Verify selected-candidates: the candidates sent to
      // synthesis should match the ranked list (since topK >=
      // the number of ranked candidates).
      const sc = events[4]!.payload as {
        candidates: Array<{
          id: number;
          synthesisOrder: number;
          memoryContent: string;
        }>;
      };
      assert.ok(sc.candidates.length > 0, "selected candidates must be non-empty");
      assert.equal(sc.candidates[0]!.synthesisOrder, 1);
      assert.equal(typeof sc.candidates[0]!.memoryContent, "string");
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("recall Phase 3A: stage event payloads are sufficient to diagnose considered-vs-selected candidates", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    try {
      // Insert several memories with different relevance levels.
      // Only the postgres-related ones should rank high enough.
      const mem1 = insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent:
          "The project uses Postgres 16 for the primary data store.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.9,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["postgres", "database"] },
      });
      const mem2 = insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent:
          "The database uses a connection pool with 20 max connections.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.85,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["database", "pool"] },
      });
      insertMemoryRecord(memHandle, {
        kind: "context",
        state: "active",
        memoryContent:
          "Office plants are watered on a biweekly rotation.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.8,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["plants", "office"] },
      });

      const result: RecallResult = await handleRecall({
        text: "What database does the project use?",
      });
      assert.equal(result.status, "provider_error");

      const runs = listTraceRuns();
      const events = listTraceEventsForRun(runs[0]!.id);

      // Extract the three stage events.
      const amrEvent = events.find(
        (e) => e.kind === RECALL_ACTIVE_MEMORY_READ_KIND,
      );
      const lrEvent = events.find(
        (e) => e.kind === RECALL_LEXICAL_RANKING_KIND,
      );
      const scEvent = events.find(
        (e) => e.kind === RECALL_SELECTED_CANDIDATES_KIND,
      );
      assert.ok(amrEvent, "active-memory-read event must exist");
      assert.ok(lrEvent, "lexical-ranking event must exist");
      assert.ok(scEvent, "selected-candidates event must exist");

      const lr = lrEvent.payload as {
        ranked: Array<{ id: number; rank: number; score: number }>;
      };
      const sc = scEvent.payload as {
        candidates: Array<{ id: number; synthesisOrder: number }>;
      };

      // The ranked list should contain at least the two
      // database-related memories.
      const rankedIds = lr.ranked.map((r) => r.id);
      assert.ok(
        rankedIds.includes(mem1.id),
        `ranked candidates must include mem1 (${mem1.id}), got [${rankedIds}]`,
      );
      assert.ok(
        rankedIds.includes(mem2.id),
        `ranked candidates must include mem2 (${mem2.id}), got [${rankedIds}]`,
      );

      // The irrelevant plant memory must NOT be in the ranked
      // list (it has zero overlap with the database query).
      const plantMem = lr.ranked.find(
        (r) => !r.id || (!rankedIds.includes(mem1.id) && !rankedIds.includes(mem2.id)),
      );
      // All ranked ids should be from the database-related memories.
      for (const r of lr.ranked) {
        assert.ok(
          r.id === mem1.id || r.id === mem2.id,
          `unexpected ranked id ${r.id}; expected only mem1 or mem2`,
        );
      }

      // Selected candidates should be a subset of (or equal to)
      // the ranked list.
      const selectedIds = sc.candidates.map((c) => c.id);
      for (const id of selectedIds) {
        assert.ok(
          rankedIds.includes(id),
          `selected candidate ${id} must appear in the ranked list`,
        );
      }
      // Cross-reference: synthesisOrder should be sequential.
      for (let i = 0; i < sc.candidates.length; i++) {
        assert.equal(sc.candidates[i]!.synthesisOrder, i + 1);
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("recall Phase 3A: CURION_TRACE_ENABLED=0 prevents all recall stage event writes", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        // Insert a memory so the controller would emit
        // stage events if tracing were enabled.
        insertMemoryRecord(memHandle, {
          kind: "fact",
          state: "active",
          memoryContent: "The project uses Postgres 16.",
          providerId: "test",
          modelId: "test-model",
          confidence: 0.9,
          safetyFlags: [],
          metadata: { tags: ["postgres"] },
        });
        setRecallStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        setListRegisteredProjectsStub(() => []);
        try {
          const result = await handleRecall({
            text: "What database?",
          });
          // Result must still be correct regardless of tracing.
          assert.ok(
            result.status === "provider_error" || result.status === "no_memory",
            `expected provider_error or no_memory, got ${result.status}`,
          );
          // No trace DB at all.
          assert.ok(
            !fs.existsSync(path.join(tmp, ".curion", "trace.sqlite")),
            "no trace.sqlite must be created when tracing is disabled",
          );
        } finally {
          resetListRegisteredProjectsStub();
          resetRecallStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("recall Phase 3A: trace writer failure does not change recall result with populated store", async () => {
  const tmp = mkTraceDir();
  await withEnvSnapshot(async () => {
    delete process.env.CURION_TRACE_ENABLED;
    resetTraceWriterForTests();
    try {
      const memHandle = initStorage({ projectRoot: tmp });
      try {
        insertMemoryRecord(memHandle, {
          kind: "fact",
          state: "active",
          memoryContent:
            "The project uses Postgres 16 for the primary data store.",
          providerId: "test",
          modelId: "test-model",
          confidence: 0.9,
          safetyFlags: ["controller-normalized"],
          metadata: { tags: ["postgres", "database"] },
        });
        setRecallStorageProvider(() => ({
          handle: memHandle,
          ownsHandle: false,
        }));
        try {
          // Close the writer to simulate a storage failure.
          closeTraceWriter();

          const result = await handleRecall({
            text: "What database does the project use?",
          });
          // The result must be the same as if tracing were
          // working: the controller ran to completion and
          // the provider returned missing-config.
          assert.equal(result.status, "provider_error");
          assert.equal(typeof result.message, "string");
          assert.ok(result.message.length > 0);
        } finally {
          resetRecallStorageProvider();
        }
      } finally {
        closeStorage(memHandle);
      }
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("recall Phase 3A: recordStage on the tool-boundary tracer writes stage events to the same run", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    // Directly exercise recordStage on the ToolBoundaryTracer
    // to verify the Phase 3A plumbing works end-to-end.
    const tracer = startToolBoundaryTrace({
      toolName: "recall",
      input: { text: "test query" },
    });
    assert.ok(tracer.runId !== null, "tracer must have a run id");

    // Record stage events that mimic what the controller does.
    tracer.recordStage(RECALL_ACTIVE_MEMORY_READ_KIND, {
      readCount: 5,
      storageLimit: 200,
    });
    tracer.recordStage(RECALL_LEXICAL_RANKING_KIND, {
      query: "test query",
      threshold: 0.2,
      topK: 5,
      ranked: [{ id: 1, rank: 1, score: 0.8 }],
    });
    tracer.recordStage(RECALL_SELECTED_CANDIDATES_KIND, {
      candidates: [{ id: 1, synthesisOrder: 1, memoryContent: "memory text" }],
    });
    tracer.recordOutput({ status: "answered", message: "answer" });
    tracer.finish("ok");

    const events = listTraceEventsForRun(tracer.runId);
    // Expected: tool.input (from constructor) + 3 stage events + tool.output
    assert.equal(events.length, 5);
    assert.equal(events[0]!.kind, TOOL_INPUT_KIND);
    assert.equal(events[1]!.kind, RECALL_ACTIVE_MEMORY_READ_KIND);
    assert.equal(events[2]!.kind, RECALL_LEXICAL_RANKING_KIND);
    assert.equal(events[3]!.kind, RECALL_SELECTED_CANDIDATES_KIND);
    assert.equal(events[4]!.kind, TOOL_OUTPUT_KIND);

    // Sequences should be monotonically increasing.
    for (let i = 1; i < events.length; i++) {
      assert.ok(
        events[i]!.sequence > events[i - 1]!.sequence,
        `sequence must increase: ${events[i - 1]!.sequence} -> ${events[i]!.sequence}`,
      );
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});
