import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { closeStorage, initStorage } from "../src/storage/storage.ts";
import {
  handleRecall,
  resetStorageProvider as resetRecallStorageProvider,
  setStorageProvider as setRecallStorageProvider,
} from "../src/tools/recall.ts";
import {
  handleRemember,
  resetStorageProvider as resetRememberStorageProvider,
  setStorageProvider as setRememberStorageProvider,
} from "../src/tools/remember.ts";
import {
  closeTraceWriter,
  getOrInitTraceWriter,
  listTraceEventsForRun,
  listTraceRuns,
  resetTraceWriterForTests,
  writeTraceEvent,
  writeTraceRun,
} from "../src/trace/index.ts";
import { startToolBoundaryTrace } from "../src/trace/trace-tool-boundary.ts";

function withTraceEnv<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.CURION_TRACE_ENABLED;
  if (value === undefined) delete process.env.CURION_TRACE_ENABLED;
  else process.env.CURION_TRACE_ENABLED = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env.CURION_TRACE_ENABLED;
    else process.env.CURION_TRACE_ENABLED = original;
  });
}

function mkProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "curion-trace-privacy-"));
}

function cleanup(projectRoot: string): void {
  resetRememberStorageProvider();
  resetRecallStorageProvider();
  closeTraceWriter();
  resetTraceWriterForTests();
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function traceJson(projectRoot: string): string {
  const dbPath = path.join(projectRoot, ".curion", "trace.sqlite");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT metadata FROM trace_runs UNION ALL SELECT payload_json FROM trace_events")
      .all() as Array<{ metadata: string | null }>;
    return rows.map((row) => row.metadata ?? "").join("\n");
  } finally {
    db.close();
  }
}

test("privacy: absent or empty CURION_TRACE_ENABLED creates no trace database", async () => {
  for (const enabled of [undefined, "", "   "]) {
    const projectRoot = mkProjectRoot();
    try {
      await withTraceEnv(enabled, async () => {
        resetTraceWriterForTests();
        assert.equal(getOrInitTraceWriter({ projectRoot }), null);
        const trace = startToolBoundaryTrace({
          toolName: "remember",
          input: { text: "ordinary private prose" },
        });
        trace.recordOutput({ status: "saved", answer: "provider response" });
        trace.finish("ok");
        assert.equal(trace.runId, null);
        assert.equal(fs.existsSync(path.join(projectRoot, ".curion", "trace.sqlite")), false);
      });
    } finally {
      cleanup(projectRoot);
    }
  }
});

test("privacy: explicit enable persists metadata only and writer drops unknown content-bearing fields", async () => {
  const projectRoot = mkProjectRoot();
  const rememberText = "ordinary remember prose should never persist";
  const recallQuery = "ordinary recall query should never persist";
  const providerText = "provider response body should never persist";
  const errorText = "arbitrary provider error should never persist";
  const secretText = "sk-live-secret-shaped-value";
  try {
    await withTraceEnv("1", async () => {
      resetTraceWriterForTests();
      assert.ok(getOrInitTraceWriter({ projectRoot }));
      const rememberTrace = startToolBoundaryTrace({
        toolName: "remember",
        input: { text: rememberText },
      });
      assert.ok(rememberTrace.runId);
      rememberTrace.recordOutput({
        status: "saved",
        summary: providerText,
        error: errorText,
        apiKey: secretText,
      });
      rememberTrace.finish("ok");

      const directRun = writeTraceRun({
        name: "defense",
        metadata: { tool: "recall", text: recallQuery, schemaVersion: "v1" },
      });
      assert.ok(directRun);
      assert.equal(
        writeTraceEvent({
          runId: directRun as number,
          kind: "tool.output",
          payload: {
            status: "error",
            count: 2,
            response: providerText,
            message: errorText,
            token: secretText,
          },
        }),
        true
      );

      const events = listTraceEventsForRun(rememberTrace.runId as number);
      assert.equal(events.length, 2);
      assert.deepEqual(events[0]?.payload, { schemaVersion: 1, tool: "remember" });
      assert.deepEqual(events[1]?.payload, { schemaVersion: 1, tool: "remember", status: "saved" });
      const runs = listTraceRuns();
      assert.equal((runs[0]?.metadata as Record<string, unknown>).schemaVersion, 1);
      assert.equal((runs[0]?.metadata as Record<string, unknown>).tool, "remember");

      closeTraceWriter();
      const stored = traceJson(projectRoot);
      for (const forbidden of [rememberText, recallQuery, providerText, errorText, secretText]) {
        assert.equal(
          stored.includes(forbidden),
          false,
          `trace SQLite must not contain ${forbidden}`
        );
      }
      assert.equal(stored.includes('"schemaVersion":1'), true);
      assert.equal(stored.includes('"status":"saved"'), true);
    });
  } finally {
    cleanup(projectRoot);
  }
});

test("privacy: explicit enable leaves remember and recall MCP results unchanged while SQLite excludes inputs and outputs", async () => {
  const projectRoot = mkProjectRoot();
  const rememberText = "asdf";
  const recallQuery = "recall query not for trace";
  try {
    await withTraceEnv("true", async () => {
      const memory = initStorage({ projectRoot });
      resetTraceWriterForTests();
      assert.ok(getOrInitTraceWriter({ projectRoot }));
      setRememberStorageProvider(() => ({ handle: memory, ownsHandle: false }));
      setRecallStorageProvider(() => ({ handle: memory, ownsHandle: false }));
      try {
        const remember = await handleRemember({ text: rememberText });
        const recall = await handleRecall({ text: recallQuery });
        assert.equal(remember.status, "rejected");
        assert.equal(recall.status, "no_memory");
        closeTraceWriter();
        const stored = traceJson(projectRoot);
        assert.equal(stored.includes(rememberText), false);
        assert.equal(stored.includes(recallQuery), false);
      } finally {
        closeStorage(memory);
      }
    });
  } finally {
    cleanup(projectRoot);
  }
});
