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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  resetListRegisteredProjectsStub,
  setListRegisteredProjectsStub,
} from "../src/config/registry.ts";
import {
  CURION_DIRNAME,
  type StorageHandle,
  closeStorage,
  initStorage,
  insertMemoryRecord,
} from "../src/storage/storage.ts";
import {
  type RecallResult,
  handleRecall,
  resetStorageProvider as resetRecallStorageProvider,
  setStorageProvider as setRecallStorageProvider,
} from "../src/tools/recall.ts";
import {
  type RememberResult,
  handleRemember,
  resetStorageProvider as resetRememberStorageProvider,
  setStorageProvider as setRememberStorageProvider,
} from "../src/tools/remember.ts";
import {
  closeTraceWriter,
  getOrInitTraceWriter,
  isTraceEnabled,
  listTraceEventsForRun,
  listTraceRuns,
  resetTraceWriterForTests,
} from "../src/trace/index.ts";
import {
  RECALL_ACTIVE_MEMORY_READ_KIND,
  RECALL_LEXICAL_RANKING_KIND,
  RECALL_SELECTED_CANDIDATES_KIND,
  RECALL_SUPERSEDED_DEMOTION_KIND,
  TOOL_INPUT_KIND,
  TOOL_OUTPUT_KIND,
  type ToolBoundaryTracer,
  startToolBoundaryTrace,
} from "../src/trace/trace-tool-boundary.ts";

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
  const originalTraceEnabled = process.env.CURION_TRACE_ENABLED;
  process.env.CURION_TRACE_ENABLED = "1";

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
      if (originalTraceEnabled === undefined) {
        delete process.env.CURION_TRACE_ENABLED;
      } else {
        process.env.CURION_TRACE_ENABLED = originalTraceEnabled;
      }
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
  runId: number
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
           FROM trace_runs WHERE id = ?`
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
          ORDER BY sequence ASC`
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

test("helper: startToolBoundaryTrace creates a metadata-only run and finishes with status + duration", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    const start = 1_000_000;
    let now = start;
    const tracer: ToolBoundaryTracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "hello world" },
      clock: () => now,
    });

    assert.ok(tracer.runId !== null);
    assert.equal(tracer.toolName, "remember");
    assert.equal(tracer.startedAt, start);

    now = 1_000_025;
    tracer.recordOutput({
      status: "saved",
      summary: "must not persist",
      kind: "fact",
    });

    now = 1_000_050;
    tracer.finish("ok");

    const { run, events } = readRunAndEvents(tmp, tracer.runId as number);
    assert.equal(run.name, "remember");
    assert.equal(run.started_at, start);
    assert.equal(run.ended_at, 1_000_050);
    assert.equal(run.status, "ok");

    const metadata = JSON.parse(run.metadata ?? "null") as Record<string, unknown>;
    assert.equal(metadata.tool, "remember");
    assert.equal(metadata.boundary, "public-tool-handler");
    assert.equal(metadata.durationMs, 50);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, TOOL_INPUT_KIND);
    assert.equal(events[0]?.sequence, 1);
    assert.deepEqual(JSON.parse(events[0]?.payload_json ?? "null"), {
      schemaVersion: 1,
      tool: "remember",
    });

    assert.equal(events[1]?.kind, TOOL_OUTPUT_KIND);
    assert.equal(events[1]?.sequence, 2);
    assert.deepEqual(JSON.parse(events[1]?.payload_json ?? "null"), {
      schemaVersion: 1,
      tool: "remember",
      status: "saved",
    });

    const persisted = JSON.stringify(events);
    assert.ok(!persisted.includes("hello world"));
    assert.ok(!persisted.includes("must not persist"));
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
        "no .curion/ must be created when tracing is disabled"
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

test("remember: creates metadata-only boundary events without changing the returned result", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRememberStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));

    try {
      const rawText = "asdf";
      const result: RememberResult = await handleRemember({ text: rawText });

      assert.equal(result.status, "rejected");
      assert.equal(result.safetyClass, "vague-junk");

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.name, "remember");
      assert.equal(run.status, "ok");

      const metadata = run.metadata as Record<string, unknown>;
      assert.equal(metadata.tool, "remember");
      assert.equal(metadata.boundary, "public-tool-handler");
      assert.equal(typeof metadata.durationMs, "number");

      const events = listTraceEventsForRun(run.id);
      assert.equal(events.length, 2);
      assert.equal(events[0]?.kind, TOOL_INPUT_KIND);
      assert.equal(events[1]?.kind, TOOL_OUTPUT_KIND);

      assert.deepEqual(events[0]?.payload, {
        schemaVersion: 1,
        tool: "remember",
      });
      assert.deepEqual(events[1]?.payload, {
        schemaVersion: 1,
        tool: "remember",
        status: "rejected",
      });

      assert.ok(!JSON.stringify(events).includes(rawText));
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

test("recall: creates metadata-only boundary and stage events without changing the returned result", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    setListRegisteredProjectsStub(() => []);

    try {
      const query = "anything";
      const result: RecallResult = await handleRecall({ text: query });
      assert.equal(result.status, "no_memory");

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.name, "recall");
      assert.equal(run.status, "ok");

      const events = listTraceEventsForRun(run.id);
      assert.equal(events.length, 4);
      assert.deepEqual(
        events.map((event) => event.kind),
        [
          TOOL_INPUT_KIND,
          RECALL_ACTIVE_MEMORY_READ_KIND,
          RECALL_LEXICAL_RANKING_KIND,
          TOOL_OUTPUT_KIND,
        ]
      );

      assert.deepEqual(events[0]?.payload, {
        schemaVersion: 1,
        tool: "recall",
      });
      assert.deepEqual(events[3]?.payload, {
        schemaVersion: 1,
        tool: "recall",
        status: "no_memory",
      });

      assert.ok(!JSON.stringify(events).includes(query));
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
            "no trace.sqlite must be created when tracing is disabled"
          );
          // The memory DB is fine.
          assert.ok(
            fs.existsSync(path.join(traceDir, "curion.sqlite")),
            "memory DB must be present (it was created before the off switch)"
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
            "no trace.sqlite must be created when tracing is disabled"
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

test("projection: traced tool.output drops sensitive and unknown fields before persistence", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: "harmless input" },
    });
    tracer.recordOutput({
      status: "saved",
      summary: "must not persist",
      apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      nested: { apiKey: "sk-nested-key" },
    });
    tracer.finish("ok");

    const run = listTraceRuns()[0]!;
    const outputEvent = listTraceEventsForRun(run.id).find(
      (event) => event.kind === TOOL_OUTPUT_KIND
    );
    assert.ok(outputEvent);

    assert.deepEqual(outputEvent.payload, {
      schemaVersion: 1,
      tool: "remember",
      status: "saved",
    });

    const persisted = JSON.stringify(outputEvent);
    assert.ok(!persisted.includes("sk-aaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert.ok(!persisted.includes("sk-nested-key"));
    assert.ok(!persisted.includes("must not persist"));
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("projection: traced tool.input drops the entire content-bearing input", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
    const secretText = "Project uses Postgres 16. Token: AKIAIOSFODNN7EXAMPLE. Tests run in 12s.";

    const tracer = startToolBoundaryTrace({
      toolName: "remember",
      input: { text: secretText },
    });
    tracer.recordOutput({ status: "rejected", safetyClass: "secret" });
    tracer.finish("ok");

    const run = listTraceRuns()[0]!;
    const inputEvent = listTraceEventsForRun(run.id).find(
      (event) => event.kind === TOOL_INPUT_KIND
    );
    assert.ok(inputEvent);

    assert.deepEqual(inputEvent.payload, {
      schemaVersion: 1,
      tool: "remember",
    });

    const persisted = JSON.stringify(inputEvent);
    assert.ok(!persisted.includes(secretText));
    assert.ok(!persisted.includes("AKIAIOSFODNN7EXAMPLE"));
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("projection: traced tool.output drops reasoning and other content-bearing fields", () => {
  const tmp = mkTraceDir();
  const { cleanup } = setupBothStores(tmp);
  try {
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

    const run = listTraceRuns()[0]!;
    const outputEvent = listTraceEventsForRun(run.id).find(
      (event) => event.kind === TOOL_OUTPUT_KIND
    );
    assert.ok(outputEvent);

    assert.deepEqual(outputEvent.payload, {
      schemaVersion: 1,
      tool: "remember",
      status: "saved",
    });

    const persisted = JSON.stringify(outputEvent);
    assert.ok(!persisted.includes("internal chain-of-thought"));
    assert.ok(!persisted.includes("another reasoning carrier"));
    assert.ok(!persisted.includes('"summary":"ok"'));
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
        "memory DB must be present after handleRemember"
      );
      assert.ok(entries.includes("trace.sqlite"), "trace DB must be present after handleRemember");

      // The memory DB must NOT have a `trace_runs` or
      // `trace_events` table (the trace schema is isolated).
      const memTables = (
        memHandle.db
          .prepare(
            `SELECT name FROM sqlite_master
            WHERE type IN ('table', 'index')
              AND name NOT LIKE 'sqlite_%'`
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      assert.ok(!memTables.includes("trace_runs"), "memory DB must not have a trace_runs table");
      assert.ok(
        !memTables.includes("trace_events"),
        "memory DB must not have a trace_events table"
      );

      // The trace DB must NOT have a `memories` table.
      const traceDb = openTraceDbReadOnly(path.join(dir, "trace.sqlite"));
      try {
        const traceTables = (
          traceDb
            .prepare(
              `SELECT name FROM sqlite_master
              WHERE type IN ('table', 'index')
                AND name NOT LIKE 'sqlite_%'`
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name);
        assert.ok(!traceTables.includes("memories"), "trace DB must not have a memories table");
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
      const before = (
        memHandle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
      ).c;
      const result = await handleRemember({ text: "asdf" });
      assert.equal(result.status, "rejected");
      const after = (
        memHandle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
      ).c;
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

test("isTraceEnabled: defaults to OFF and requires an explicit allowlisted value", () => {
  return withEnvSnapshot(() => {
    delete process.env.CURION_TRACE_ENABLED;
    assert.equal(isTraceEnabled(), false);

    process.env.CURION_TRACE_ENABLED = "1";
    assert.equal(isTraceEnabled(), true);

    process.env.CURION_TRACE_ENABLED = "enabled";
    assert.equal(isTraceEnabled(), false);
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

test("recall Phase 3A: empty store emits metadata-only stage events on the same run", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));
    setListRegisteredProjectsStub(() => []);

    try {
      const query = "anything";
      const result: RecallResult = await handleRecall({ text: query });
      assert.equal(result.status, "no_memory");

      const run = listTraceRuns()[0]!;
      const events = listTraceEventsForRun(run.id);

      assert.deepEqual(
        events.map((event) => event.kind),
        [
          TOOL_INPUT_KIND,
          RECALL_ACTIVE_MEMORY_READ_KIND,
          RECALL_LEXICAL_RANKING_KIND,
          TOOL_OUTPUT_KIND,
        ]
      );

      const active = events[1]!.payload as Record<string, unknown>;
      assert.equal(active.readCount, 0);
      assert.equal(typeof active.storageLimit, "number");

      const lexical = events[2]!.payload as Record<string, unknown>;
      assert.equal(lexical.schemaVersion, 1);
      assert.equal("query" in lexical, false);
      assert.equal("ranked" in lexical, false);

      assert.equal(
        events.some((event) => event.kind === RECALL_SELECTED_CANDIDATES_KIND),
        false
      );
      assert.ok(!JSON.stringify(events).includes(query));
    } finally {
      resetListRegisteredProjectsStub();
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("recall Phase 3A: populated store emits metadata-only stage events before provider call", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));

    try {
      insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent: "The project uses Postgres 16 for the primary data store.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.9,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["postgres", "database"] },
      });
      insertMemoryRecord(memHandle, {
        kind: "context",
        state: "active",
        memoryContent: "Office plants are watered on a biweekly rotation.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.8,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["plants", "office"] },
      });

      const query = "What database does the project use?";
      const result: RecallResult = await handleRecall({ text: query });
      assert.equal(result.status, "provider_error");

      const events = listTraceEventsForRun(listTraceRuns()[0]!.id);
      assert.deepEqual(
        events.map((event) => event.kind),
        [
          TOOL_INPUT_KIND,
          RECALL_ACTIVE_MEMORY_READ_KIND,
          RECALL_LEXICAL_RANKING_KIND,
          RECALL_SUPERSEDED_DEMOTION_KIND,
          RECALL_SELECTED_CANDIDATES_KIND,
          TOOL_OUTPUT_KIND,
        ]
      );

      const active = events[1]!.payload as Record<string, unknown>;
      assert.equal(active.readCount, 2);

      const lexical = events[2]!.payload as Record<string, unknown>;
      const selected = events[4]!.payload as Record<string, unknown>;

      assert.equal(lexical.schemaVersion, 1);
      assert.equal(selected.schemaVersion, 1);
      assert.equal("query" in lexical, false);
      assert.equal("ranked" in lexical, false);
      assert.equal("candidates" in selected, false);

      const persisted = JSON.stringify(events);
      assert.ok(!persisted.includes(query));
      assert.ok(!persisted.includes("Postgres 16"));
      assert.ok(!persisted.includes("Office plants"));
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});

test("recall Phase 3A: stage events retain counts without candidate identities or content", async () => {
  const tmp = mkTraceDir();
  const { memHandle, cleanup } = setupBothStores(tmp);
  try {
    setRecallStorageProvider(() => ({
      handle: memHandle,
      ownsHandle: false,
    }));

    try {
      insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent: "The project uses Postgres 16 for the primary data store.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.9,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["postgres", "database"] },
      });
      insertMemoryRecord(memHandle, {
        kind: "fact",
        state: "active",
        memoryContent: "The database uses a connection pool with 20 max connections.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.85,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["database", "pool"] },
      });
      insertMemoryRecord(memHandle, {
        kind: "context",
        state: "active",
        memoryContent: "Office plants are watered on a biweekly rotation.",
        providerId: "test",
        modelId: "test-model",
        confidence: 0.8,
        safetyFlags: ["controller-normalized"],
        metadata: { tags: ["plants", "office"] },
      });

      const query = "What database does the project use?";
      const result: RecallResult = await handleRecall({ text: query });
      assert.equal(result.status, "provider_error");

      const events = listTraceEventsForRun(listTraceRuns()[0]!.id);
      const active = events.find((event) => event.kind === RECALL_ACTIVE_MEMORY_READ_KIND);
      const lexical = events.find((event) => event.kind === RECALL_LEXICAL_RANKING_KIND);
      const selected = events.find((event) => event.kind === RECALL_SELECTED_CANDIDATES_KIND);

      assert.ok(active);
      assert.ok(lexical);
      assert.ok(selected);

      assert.equal((active.payload as Record<string, unknown>).readCount, 3);

      for (const event of [lexical, selected]) {
        const payload = event.payload as Record<string, unknown>;
        assert.equal(payload.schemaVersion, 1);
        assert.equal("query" in payload, false);
        assert.equal("ranked" in payload, false);
        assert.equal("candidates" in payload, false);
        assert.equal("memoryContent" in payload, false);
      }

      const persisted = JSON.stringify(events);
      assert.ok(!persisted.includes(query));
      assert.ok(!persisted.includes("Postgres 16"));
      assert.ok(!persisted.includes("connection pool"));
      assert.ok(!persisted.includes("Office plants"));
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
            `expected provider_error or no_memory, got ${result.status}`
          );
          // No trace DB at all.
          assert.ok(
            !fs.existsSync(path.join(tmp, ".curion", "trace.sqlite")),
            "no trace.sqlite must be created when tracing is disabled"
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
          memoryContent: "The project uses Postgres 16 for the primary data store.",
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
        `sequence must increase: ${events[i - 1]!.sequence} -> ${events[i]!.sequence}`
      );
    }
  } finally {
    cleanup();
    rmTraceDir(tmp);
  }
});
