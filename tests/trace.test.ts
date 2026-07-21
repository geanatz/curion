import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  closeTraceWriter,
  getOrInitTraceWriter,
  isTraceEnabled,
  listTraceEventsForRun,
  listTraceRuns,
  resetTraceWriterForTests,
  resolveTraceDbPath,
  updateTraceRun,
  writeTraceEvent,
  writeTraceRun,
} from "../src/trace/index.ts";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.CURION_TRACE_ENABLED;
  if (value === undefined) delete process.env.CURION_TRACE_ENABLED;
  else process.env.CURION_TRACE_ENABLED = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.CURION_TRACE_ENABLED;
    else process.env.CURION_TRACE_ENABLED = original;
  }
}

function mkProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curion-trace-"));
}

function cleanup(projectRoot: string): void {
  closeTraceWriter();
  resetTraceWriterForTests();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

test("trace-enabled: unset, empty, whitespace, false-like, and unknown values are disabled", () => {
  for (const value of [undefined, "", "   ", "0", "false", "off", "enabled", "anything"]) {
    withEnv(value, () =>
      assert.equal(isTraceEnabled(), false, `expected disabled for ${String(value)}`)
    );
  }
});

test("trace-enabled: only explicit allowlisted values activate tracing", () => {
  for (const value of ["1", "true", "yes", "on", " TRUE "]) {
    withEnv(value, () => assert.equal(isTraceEnabled(), true, `expected enabled for ${value}`));
  }
});

test("trace-writer: preserves trace SQLite schema while persisting only the closed metadata schema", () => {
  const projectRoot = mkProjectRoot();
  try {
    withEnv("1", () => {
      resetTraceWriterForTests();
      const writer = getOrInitTraceWriter({ projectRoot });
      assert.ok(writer);
      const runId = writeTraceRun({
        name: "remember",
        metadata: {
          schemaVersion: 999,
          tool: "remember",
          boundary: "public-tool-handler",
          note: "private prose",
        },
      });
      assert.ok(runId);
      assert.equal(
        writeTraceEvent({
          runId: runId as number,
          kind: "tool.output",
          payload: {
            status: "saved",
            count: 1,
            durationMs: 9,
            text: "private prose",
            message: "provider error",
          },
        }),
        true
      );
      assert.equal(
        updateTraceRun(runId as number, {
          status: "ok",
          metadata: { durationMs: 10, secret: "sk-test" },
        }),
        true
      );

      const run = listTraceRuns()[0];
      assert.deepEqual(run?.metadata, { schemaVersion: 1, durationMs: 10 });
      const event = listTraceEventsForRun(runId as number)[0];
      assert.deepEqual(event?.payload, { schemaVersion: 1, status: "saved", count: 1 });
      assert.deepEqual(event?.redactedKeys, []);

      closeTraceWriter();
      const dbPath = resolveTraceDbPath({ projectRoot });
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const tableNames = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>;
        assert.deepEqual(
          tableNames.map((row) => row.name),
          ["_meta", "sqlite_sequence", "trace_events", "trace_runs"]
        );
        const allJson = db
          .prepare(
            "SELECT metadata AS json FROM trace_runs UNION ALL SELECT payload_json AS json FROM trace_events"
          )
          .all() as Array<{ json: string }>;
        const stored = allJson.map((row) => row.json).join("\n");
        assert.equal(stored.includes("private prose"), false);
        assert.equal(stored.includes("provider error"), false);
        assert.equal(stored.includes("sk-test"), false);
      } finally {
        db.close();
      }
    });
  } finally {
    cleanup(projectRoot);
  }
});

test("trace-writer: disabled tracing does not create trace SQLite", () => {
  const projectRoot = mkProjectRoot();
  try {
    withEnv(undefined, () => {
      resetTraceWriterForTests();
      assert.equal(getOrInitTraceWriter({ projectRoot }), null);
      assert.equal(writeTraceRun({ name: "remember" }), null);
      assert.equal(fs.existsSync(path.join(projectRoot, ".curion", "trace.sqlite")), false);
    });
  } finally {
    cleanup(projectRoot);
  }
});

test("trace-writer: run names and event kinds never persist arbitrary input, provider text, or error prose", () => {
  const projectRoot = mkProjectRoot();
  const rawInput = "raw user input must not persist";
  const providerText = "provider response text must not persist";
  const errorProse = "Error: detailed provider failure prose must not persist";
  try {
    withEnv("1", () => {
      resetTraceWriterForTests();
      assert.ok(getOrInitTraceWriter({ projectRoot }));
      const runId = writeTraceRun({ name: rawInput });
      assert.ok(runId);
      assert.equal(
        writeTraceEvent({ runId, kind: `${providerText}: ${errorProse}`, payload: {} }),
        true
      );
      assert.equal(listTraceRuns()[0]?.name, "unknown");
      assert.equal(listTraceEventsForRun(runId)[0]?.kind, "unknown");
      closeTraceWriter();
      const db = new Database(resolveTraceDbPath({ projectRoot }), { readonly: true });
      try {
        const rows = db
          .prepare("SELECT name FROM trace_runs UNION ALL SELECT kind FROM trace_events")
          .all() as Array<{ name?: string; kind?: string }>;
        const stored = JSON.stringify(rows);
        assert.equal(stored.includes(rawInput), false);
        assert.equal(stored.includes(providerText), false);
        assert.equal(stored.includes(errorProse), false);
      } finally {
        db.close();
      }
    });
  } finally {
    cleanup(projectRoot);
  }
});

test("trace-writer: run statuses are runtime allowlisted and cross-project semantic kind remains intact", () => {
  const projectRoot = mkProjectRoot();
  const maliciousStatus = "provider error prose must not persist";

  try {
    withEnv("1", () => {
      resetTraceWriterForTests();
      assert.ok(getOrInitTraceWriter({ projectRoot }));

      const runId = writeTraceRun({ name: "recall" });
      assert.ok(runId);

      assert.equal(
        updateTraceRun(runId as number, {
          endedAt: 123,
          status: maliciousStatus as never,
        }),
        true
      );

      assert.equal(
        writeTraceEvent({
          runId: runId as number,
          kind: "recall.cross-project-semantic",
          payload: {},
        }),
        true
      );

      closeTraceWriter();

      const db = new Database(resolveTraceDbPath({ projectRoot }), {
        readonly: true,
        fileMustExist: true,
      });

      try {
        const run = db
          .prepare("SELECT status, ended_at AS endedAt FROM trace_runs WHERE id = ?")
          .get(runId) as {
          status: string;
          endedAt: number | null;
        };

        const event = db.prepare("SELECT kind FROM trace_events WHERE run_id = ?").get(runId) as {
          kind: string;
        };

        assert.equal(run.status, "in_progress");
        assert.equal(run.endedAt, 123);
        assert.equal(event.kind, "recall.cross-project-semantic");

        assert.equal(JSON.stringify({ run, event }).includes(maliciousStatus), false);
      } finally {
        db.close();
      }
    });
  } finally {
    cleanup(projectRoot);
  }
});
