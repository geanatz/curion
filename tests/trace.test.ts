/**
 * Tests for the Curion Local Trace foundation (Phase 1).
 *
 * The trace module ships:
 *   - `src/trace/trace-enabled.ts`    — CURION_TRACE_ENABLED off switch
 *   - `src/trace/trace-storage.ts`    — separate .curion/trace.sqlite DB
 *   - `src/trace/trace-redaction.ts`  — recursive credential/CoT redaction
 *   - `src/trace/trace-writer.ts`     — best-effort, non-throwing writer API
 *   - `src/trace/trace-retention.ts`  — 30-day default purge helpers
 *
 * These tests cover the approved Phase 1 surface only. They do
 * NOT exercise any remember/recall instrumentation, CLI, or
 * provider capture (those belong to later phases).
 *
 * Conventions:
 *   - All tests use isolated temp directories under os.tmpdir() so
 *     the real project .curion/curion.sqlite is never touched.
 *   - The writer module is module-cached; `resetTraceWriterForTests()`
 *     is called between tests so the env switch and project root
 *     are not leaked between cases.
 *   - `process.env.CURION_TRACE_ENABLED` is saved and restored per
 *     test to keep env pollution out of the rest of the suite.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { CURION_DIRNAME, closeStorage, initStorage } from "../src/storage/storage.ts";
import {
  CURION_TRACE_DB_FILENAME,
  DEFAULT_TRACE_MAX_AGE_MS,
  TRACE_SCHEMA_VERSION,
  closeTraceStorage,
  closeTraceWriter,
  getOrInitTraceWriter,
  initTraceStorage,
  isTraceEnabled,
  listTraceEventsForRun,
  listTraceRuns,
  purgeAllTraceRuns,
  purgeTraceRunsOlderThan,
  redactPayload,
  redactString,
  resetTraceWriterForTests,
  resolveTraceDbPath,
  updateTraceRun,
  writeTraceEvent,
  writeTraceRun,
} from "../src/trace/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot the trace-related env vars. The trace foundation has
 * a single env switch (`CURION_TRACE_ENABLED`); we save / restore
 * it around tests that mutate it so the rest of the suite is not
 * affected.
 */
function withEnvSnapshot<T>(fn: () => T): T {
  const orig = process.env.CURION_TRACE_ENABLED;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env.CURION_TRACE_ENABLED;
    else process.env.CURION_TRACE_ENABLED = orig;
  }
}

/**
 * Create a fresh empty temp dir to host a trace DB. The trace
 * storage layer will create `<dir>/.curion/` on first init.
 */
function mkTraceDir(label = "curion-trace-"): string {
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
 * Open the on-disk trace DB file (read-only) for white-box
 * assertions about the schema, rows, and persisted JSON.
 */
function openTraceDbReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Run `fn` with a freshly-initialized writer that targets
 * `projectRoot`. Always tears the writer back down on exit so
 * module-level state does not leak into the next test.
 */
function withWriter<T>(projectRoot: string, fn: () => T): T {
  const originalTraceEnabled = process.env.CURION_TRACE_ENABLED;
  process.env.CURION_TRACE_ENABLED = "1";
  resetTraceWriterForTests();
  try {
    const handle = getOrInitTraceWriter({ projectRoot });
    assert.ok(handle, "writer should initialize successfully in a temp dir");
    return fn();
  } finally {
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
  }
}

// ---------------------------------------------------------------------------
// 1. Trace enablement
// ---------------------------------------------------------------------------

test("trace-enabled: unset, empty, whitespace, false-like, and unknown values are disabled", () => {
  for (const value of [undefined, "", "   ", "0", "false", "no", "off", "enabled", "x"]) {
    withEnvSnapshot(() => {
      if (value === undefined) delete process.env.CURION_TRACE_ENABLED;
      else process.env.CURION_TRACE_ENABLED = value;
      assert.equal(isTraceEnabled(), false, `expected OFF for ${String(value)}`);
    });
  }
});

test("trace-enabled: only explicit allowlisted values activate tracing", () => {
  for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "ON", " true "]) {
    withEnvSnapshot(() => {
      process.env.CURION_TRACE_ENABLED = value;
      assert.equal(isTraceEnabled(), true, `expected ON for "${value}"`);
    });
  }
});

test("trace-enabled: the check is computed at call time", () => {
  withEnvSnapshot(() => {
    delete process.env.CURION_TRACE_ENABLED;
    assert.equal(isTraceEnabled(), false);

    process.env.CURION_TRACE_ENABLED = "1";
    assert.equal(isTraceEnabled(), true);

    process.env.CURION_TRACE_ENABLED = "enabled";
    assert.equal(isTraceEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// 2. Trace storage
// ---------------------------------------------------------------------------

test("trace-storage: resolves path under <root>/.curion/trace.sqlite", () => {
  const tmp = mkTraceDir();
  try {
    const dbPath = resolveTraceDbPath({ projectRoot: tmp });
    assert.equal(dbPath, path.join(tmp, CURION_DIRNAME, "trace.sqlite"));
    assert.equal(CURION_TRACE_DB_FILENAME, "trace.sqlite");
  } finally {
    rmTraceDir(tmp);
  }
});

test("trace-storage: initTraceStorage creates .curion/ + trace.sqlite (NOT curion.sqlite)", () => {
  const tmp = mkTraceDir();
  let handle: ReturnType<typeof initTraceStorage> | null = null;
  try {
    handle = initTraceStorage({ projectRoot: tmp });
    const expectedDir = path.join(tmp, CURION_DIRNAME);
    assert.equal(handle.dir, expectedDir);
    assert.equal(handle.dbPath, path.join(expectedDir, "trace.sqlite"));

    // Filesystem: the .curion/ directory and the trace.sqlite file
    // must exist. The memory DB (curion.sqlite) must NOT exist.
    assert.ok(fs.existsSync(expectedDir), ".curion/ must exist");
    assert.ok(fs.existsSync(handle.dbPath), "trace.sqlite must exist");
    assert.ok(
      !fs.existsSync(path.join(expectedDir, "curion.sqlite")),
      "memory DB curion.sqlite must NOT be created by trace init"
    );
  } finally {
    if (handle) closeTraceStorage(handle);
    rmTraceDir(tmp);
  }
});

test("trace-storage: schema is _meta + trace_runs + trace_events with cascade", () => {
  const tmp = mkTraceDir();
  let handle: ReturnType<typeof initTraceStorage> | null = null;
  try {
    handle = initTraceStorage({ projectRoot: tmp });
    const tables = handle.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type IN ('table', 'index')
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC`
      )
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((r) => r.name));
    assert.ok(names.has("_meta"), "_meta table must exist");
    assert.ok(names.has("trace_runs"), "trace_runs table must exist");
    assert.ok(names.has("trace_events"), "trace_events table must exist");
    assert.ok(
      names.has("trace_events_run_id_idx"),
      "trace_events(run_id, sequence) index must exist"
    );

    // _meta must carry the documented schema version stamp.
    const meta = handle.db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    assert.ok(meta, "_meta.schema_version must be set");
    assert.equal(meta.value, TRACE_SCHEMA_VERSION);
    assert.equal(TRACE_SCHEMA_VERSION, "v1-trace-1");

    // FK action: deleting a trace_runs row must cascade to its events.
    const insertRun = handle.db.prepare(
      `INSERT INTO trace_runs (name, started_at, ended_at, status, metadata)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertEvent = handle.db.prepare(
      `INSERT INTO trace_events (run_id, ts, kind, payload_json, redacted_keys, sequence)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const runId = Number(
      insertRun.run("cascade-test", 1_000, null, "in_progress", null).lastInsertRowid
    );
    insertEvent.run(runId, 1_000, "k", "{}", "[]", 1);
    insertEvent.run(runId, 1_001, "k", "{}", "[]", 2);
    const evBefore = handle.db
      .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ?`)
      .get(runId) as { c: number };
    assert.equal(evBefore.c, 2);
    handle.db.prepare(`DELETE FROM trace_runs WHERE id = ?`).run(runId);
    const evAfter = handle.db
      .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ?`)
      .get(runId) as { c: number };
    assert.equal(evAfter.c, 0, "deleting the run must cascade-delete its events");
  } finally {
    if (handle) closeTraceStorage(handle);
    rmTraceDir(tmp);
  }
});

test("trace-storage: initTraceStorage is idempotent (re-running keeps the same schema)", () => {
  const tmp = mkTraceDir();
  let h1: ReturnType<typeof initTraceStorage> | null = null;
  let h2: ReturnType<typeof initTraceStorage> | null = null;
  try {
    h1 = initTraceStorage({ projectRoot: tmp });
    h1.db
      .prepare(
        `INSERT INTO _meta (key, value) VALUES ('custom', 'first')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run();
    closeTraceStorage(h1);
    h1 = null;

    h2 = initTraceStorage({ projectRoot: tmp });
    const meta = h2.db.prepare(`SELECT value FROM _meta WHERE key = 'custom'`).get() as
      | { value: string }
      | undefined;
    assert.equal(meta?.value, "first", "user _meta rows must survive a re-init");
  } finally {
    if (h1) closeTraceStorage(h1);
    if (h2) closeTraceStorage(h2);
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 3a. Permission hardening
// ---------------------------------------------------------------------------

/**
 * Mask the permission bits of `path` to a numeric mode string for
 * platform-portable assertion. Returns null when the file does not exist.
 */
function modeStr(path: string): string | null {
  try {
    return (fs.statSync(path).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

test("trace-storage: initTraceStorage sets owner-only (0o600) on the main DB file", () => {
  const tmp = mkTraceDir();
  let handle: ReturnType<typeof initTraceStorage> | null = null;
  try {
    handle = initTraceStorage({ projectRoot: tmp });
    closeTraceStorage(handle);
    handle = null;
    const dbPath = path.join(tmp, CURION_DIRNAME, CURION_TRACE_DB_FILENAME);
    const m = modeStr(dbPath);
    // chmod is best-effort; we assert only when the call succeeded.
    if (m !== null) {
      assert.ok(m === "600" || m === "400", `expected owner-only mode, got 0o${m}`);
    }
  } finally {
    if (handle) closeTraceStorage(handle);
    rmTraceDir(tmp);
  }
});

test("trace-storage: WAL sidecar (-wal) gets owner-only mode after first write", () => {
  const tmp = mkTraceDir();
  let handle: ReturnType<typeof initTraceStorage> | null = null;
  try {
    handle = initTraceStorage({ projectRoot: tmp });
    // Trigger WAL creation via a write.
    handle.db.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)`).run("perm-test", "1");
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
    closeTraceStorage(handle);
    handle = null;
    const walPath = path.join(tmp, CURION_DIRNAME, `${CURION_TRACE_DB_FILENAME}-wal`);
    const m = modeStr(walPath);
    if (m !== null) {
      assert.ok(m === "600" || m === "400", `expected owner-only mode on WAL, got 0o${m}`);
    }
  } finally {
    if (handle) closeTraceStorage(handle);
    rmTraceDir(tmp);
  }
});

test("trace-storage: SHM sidecar (-shm) gets owner-only mode when it exists", () => {
  const tmp = mkTraceDir();
  let handle: ReturnType<typeof initTraceStorage> | null = null;
  try {
    handle = initTraceStorage({ projectRoot: tmp });
    // Trigger SHM creation via a write (some SQLite builds create it).
    handle.db.prepare(`INSERT INTO _meta (key, value) VALUES (?, ?)`).run("perm-test-shm", "1");
    closeTraceStorage(handle);
    handle = null;
    const shmPath = path.join(tmp, CURION_DIRNAME, `${CURION_TRACE_DB_FILENAME}-shm`);
    const m = modeStr(shmPath);
    if (m !== null) {
      assert.ok(m === "600" || m === "400", `expected owner-only mode on SHM, got 0o${m}`);
    }
  } finally {
    if (handle) closeTraceStorage(handle);
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 3. Redaction
// ---------------------------------------------------------------------------

test("redactPayload: recursive credential / secret key scrubbing", () => {
  const out = redactPayload({
    apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaa",
    ApiKey: "still-redacted",
    authorization: "Bearer abcdefghijklmnopqrst",
    cookie: "session=abc",
    "set-cookie": "session=abc; HttpOnly",
    password: "hunter2hunter2",
    secret: "shh-secret",
    accessToken: "tkn-1234567890",
    refreshToken: "rtk-1234567890",
    idToken: "idt-1234567890",
    nested: {
      clientSecret: "cs-1",
      private_key: "-----BEGIN PRIVATE KEY-----",
      bearer: "abc123",
    },
    list: [{ apiKey: "first" }, { password: "second" }, "harmless string"],
    keep: "visible",
  }) as Record<string, unknown>;

  // Every credential-shaped key must end up as "<redacted>".
  for (const k of [
    "apiKey",
    "ApiKey",
    "authorization",
    "cookie",
    "set-cookie",
    "password",
    "secret",
    "accessToken",
    "refreshToken",
    "idToken",
  ]) {
    assert.equal(out[k], "<redacted>", `key "${k}" must be redacted`);
  }
  // Nested keys redacted too.
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.clientSecret, "<redacted>");
  assert.equal(nested.private_key, "<redacted>");
  assert.equal(nested.bearer, "<redacted>");
  // Lists / arrays are walked.
  const list = out.list as Array<Record<string, unknown>>;
  assert.equal(list[0]?.apiKey, "<redacted>");
  assert.equal(list[1]?.password, "<redacted>");
  assert.equal(list[2], "harmless string");
  // Innocuous keys / values are preserved.
  assert.equal(out.keep, "visible");
});

test("redactPayload: Authorization / API-key HEADER-style values in strings are scrubbed", () => {
  const out = redactString("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
  assert.ok(!out.includes("sk-abcdefghijklmnopqrstuv"), `sk- leaked: ${out}`);
  assert.match(out, /<redacted>/);

  const out2 = redactString(`x-api-key: "nvapi-aaaaaaaaaaaaaaabbbbbbbb"`);
  assert.ok(!out2.includes("nvapi-aaaaaaaaaaaaaaabbbbbbbb"), `nvapi- leaked: ${out2}`);
});

test("redactPayload: URL basic-auth credentials are stripped", () => {
  const out = redactString("fetching https://user:supersecret123@api.example.com/v1/chat");
  assert.ok(!out.includes("supersecret123"), `basic-auth password leaked: ${out}`);
  // The user and host must still be visible.
  assert.match(out, /user:<redacted>@api\.example\.com/);
});

test("redactPayload: secret-shaped query parameters in free-form strings are scrubbed", () => {
  // The string-based secret regex catches "?token=..." etc. (the
  // Phase 1 spec did not add a dedicated URL query-param scrubber;
  // we verify the string-level pass picks the value up so a URL
  // copied into a log line does not leak the secret).
  const out = redactString("GET /v1/proxy?token=abc123def456ghi789&x=1");
  assert.ok(!out.includes("abc123def456ghi789"), `token leaked: ${out}`);
  assert.match(out, /<redacted>/);
});

test("redactPayload: reasoning / CoT fields are dropped (key is removed entirely)", () => {
  const out = redactPayload({
    prompt: "what is the capital of france",
    reasoning: "the user is asking about geography, the answer is paris",
    reasoning_content: "hidden thinking",
    chain_of_thought: "step 1, step 2",
    chainOfThought: "another carrier",
    cot: "short",
    thoughts: "deep",
    thinking: "expensive",
    hidden_reasoning: "secret chain",
    internal_reasoning: "internal",
    internal_thinking: "internal",
    scratchpad: "scribble",
    reflection: "looking back",
    reflect: "synonym",
    hidden_analysis: "secret analysis",
    analysis: "best-effort CoT carrier",
    plan: "I'll do A then B",
    output: "Paris",
  }) as Record<string, unknown>;

  // None of the reasoning keys may survive.
  for (const k of [
    "reasoning",
    "reasoning_content",
    "chain_of_thought",
    "chainOfThought",
    "cot",
    "thoughts",
    "thinking",
    "hidden_reasoning",
    "internal_reasoning",
    "internal_thinking",
    "scratchpad",
    "reflection",
    "reflect",
    "hidden_analysis",
    "analysis",
    "plan",
  ]) {
    assert.ok(!(k in out), `reasoning key "${k}" must be dropped, got ${JSON.stringify(out[k])}`);
  }
  // Innocuous fields survive.
  assert.equal(out.prompt, "what is the capital of france");
  assert.equal(out.output, "Paris");
});

test("redactPayload: <think>...</think> blocks in strings are stripped", () => {
  const cases: Array<[string, string]> = [
    [
      "hello <think>internal chain-of-thought</think> world",
      "hello <redacted:thinking-block> world",
    ],
    ["<think>step 1\nstep 2\nstep 3</think> answer: 42", "<redacted:thinking-block> answer: 42"],
    ["<think>\there is some leading whitespace</think> ok", "<redacted:thinking-block> ok"],
    ["no think block here, just normal text", "no think block here, just normal text"],
  ];
  for (const [input, expected] of cases) {
    const out = redactString(input);
    assert.equal(out, expected, `unexpected output for: ${input}`);
  }
});

test("redactPayload: nested arrays and objects are walked", () => {
  const out = redactPayload({
    a: {
      b: {
        c: [{ apiKey: "leaf-1" }, { keep: [{ password: "leaf-2" }] }],
      },
    },
  }) as { a: { b: { c: Array<Record<string, unknown>> } } };
  const leaf1 = out.a.b.c[0];
  const leaf2 = (out.a.b.c[1].keep as Array<Record<string, unknown>>)[0];
  assert.equal(leaf1.apiKey, "<redacted>");
  assert.equal(leaf2.password, "<redacted>");
});

test("redactPayload: circular references are surfaced as <circular>", () => {
  const a: Record<string, unknown> = { name: "outer" };
  const b: Record<string, unknown> = { name: "inner", back: a };
  a.b = b; // cycle: a -> b -> a
  const out = redactPayload(a) as Record<string, unknown>;
  // The walk must not throw. The cycle must be reported with the
  // documented placeholder.
  assert.equal(out.name, "outer");
  const inner = out.b as Record<string, unknown>;
  assert.equal(inner.name, "inner");
  assert.equal(inner.back, "<circular>");
});

test("redactPayload: unserializable leaves (BigInt, function, symbol) are safe-stringified", () => {
  const sym = Symbol("api-secret");
  const out = redactPayload({
    big: 12345678901234567890n,
    fn: function namedFn() {
      return 1;
    },
    sym,
    keep: 1,
  }) as Record<string, unknown>;
  // BigInt becomes a tagged string; the original primitive is not
  // smuggled through. The exact body is not asserted beyond the
  // "<bigint:" prefix so the test does not couple to the radix.
  assert.equal(typeof out.big, "string");
  assert.match(out.big as string, /^<bigint:/);
  assert.equal(typeof out.fn, "string");
  assert.match(out.fn as string, /^<function:/);
  assert.equal(typeof out.sym, "string");
  assert.match(out.sym as string, /^<symbol:/);
  assert.equal(out.keep, 1);
});

test("redactPayload: does not throw on deeply nested input (depth cap returns <redacted:depth-cap>)", () => {
  // Build a chain 40 deep (above the 32-deep cap).
  type N = { next?: N; v: number };
  let cur: N = { v: 0 };
  const root: N = cur;
  for (let i = 0; i < 40; i += 1) {
    const n: N = { v: i + 1 };
    cur.next = n;
    cur = n;
  }
  let out: unknown;
  assert.doesNotThrow(() => {
    out = redactPayload(root);
  });
  // The root must round-trip with the same `v`.
  assert.equal((out as { v: number }).v, 0);
  // The cap emits the placeholder somewhere down the chain.
  const json = JSON.stringify(out);
  assert.match(json, /<redacted:depth-cap>/);
});

test("redactPayload: redactUrlCredentials=false leaves basic-auth intact", () => {
  const out = redactString("https://user:supersecret@example.com/", {
    redactUrlCredentials: false,
  });
  assert.ok(
    out.includes("supersecret"),
    `URL should be untouched when redactUrlCredentials=false, got: ${out}`
  );
});

test("redactPayload: stripThinkingBlocks=false leaves <think> blocks intact", () => {
  const out = redactString("hello <think>internal</think> world", { stripThinkingBlocks: false });
  assert.ok(
    out.includes("<think>internal</think>"),
    `think block should be untouched when stripThinkingBlocks=false, got: ${out}`
  );
});

// ---------------------------------------------------------------------------
// 4. Writer
// ---------------------------------------------------------------------------

test("writer: writeTraceRun / writeTraceEvent / updateTraceRun persist only allowlisted metadata", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const runId = writeTraceRun({
        name: "remember",
        startedAt: 1_000_000,
        metadata: { kind: "fact", confidence: 0.9 },
      });
      assert.ok(runId !== null);
      const id = runId as number;

      assert.equal(
        writeTraceEvent({
          runId: id,
          ts: 1_000_010,
          kind: "tool.input",
          payload: {
            text: "hello world",
            apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaa",
            password: "hunter2hunter2",
            nested: { apiKey: "sk-nested-key-value" },
          },
        }),
        true
      );

      assert.equal(
        writeTraceEvent({
          runId: id,
          ts: 1_000_020,
          kind: "tool.output",
          payload: {
            summary: "ok",
            reasoning: "I thought about this a lot",
          },
        }),
        true
      );

      assert.equal(
        updateTraceRun(id, {
          endedAt: 1_000_030,
          status: "ok",
          metadata: { kind: "fact", confidence: 0.95 },
        }),
        true
      );

      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const run = db
          .prepare(
            `SELECT name, started_at, ended_at, status, metadata
               FROM trace_runs WHERE id = ?`
          )
          .get(id) as {
          name: string;
          started_at: number;
          ended_at: number | null;
          status: string;
          metadata: string | null;
        };

        assert.equal(run.name, "remember");
        assert.equal(run.started_at, 1_000_000);
        assert.equal(run.ended_at, 1_000_030);
        assert.equal(run.status, "ok");
        assert.deepEqual(JSON.parse(run.metadata ?? "null"), {
          schemaVersion: 1,
        });

        const events = db
          .prepare(
            `SELECT kind, payload_json, sequence
               FROM trace_events
              WHERE run_id = ?
              ORDER BY sequence ASC`
          )
          .all(id) as Array<{
          kind: string;
          payload_json: string | null;
          sequence: number;
        }>;

        assert.equal(events.length, 2);
        assert.equal(events[0]?.kind, "tool.input");
        assert.equal(events[0]?.sequence, 1);
        assert.deepEqual(JSON.parse(events[0]?.payload_json ?? "null"), {
          schemaVersion: 1,
        });

        assert.equal(events[1]?.kind, "tool.output");
        assert.equal(events[1]?.sequence, 2);
        assert.deepEqual(JSON.parse(events[1]?.payload_json ?? "null"), {
          schemaVersion: 1,
        });

        const persisted = JSON.stringify(events);
        for (const forbidden of [
          "hello world",
          "sk-aaaaaaaaaaaaaaaaaaaaaaaa",
          "hunter2hunter2",
          "sk-nested-key-value",
          "I thought about this a lot",
          '"summary":"ok"',
        ]) {
          assert.ok(!persisted.includes(forbidden));
        }
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: per-run sequence increments monotonically across inserts", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const runId = writeTraceRun({ name: "r", startedAt: 1 }) as number;
      assert.ok(runId > 0);
      for (let i = 0; i < 5; i += 1) {
        assert.equal(writeTraceEvent({ runId, kind: `k${i}`, payload: { i } }), true);
      }
      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const rows = db
          .prepare(`SELECT sequence FROM trace_events WHERE run_id = ? ORDER BY sequence ASC`)
          .all(runId) as Array<{ sequence: number }>;
        assert.deepEqual(
          rows.map((r) => r.sequence),
          [1, 2, 3, 4, 5]
        );
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: listTraceRuns / listTraceEventsForRun return parsed projected rows", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const id = writeTraceRun({
        name: "recall",
        startedAt: 5,
        metadata: { foo: "bar" },
      }) as number;

      writeTraceEvent({
        runId: id,
        kind: "tool.input",
        payload: { keep: 1 },
      });

      const runs = listTraceRuns();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.id, id);
      assert.equal(run.name, "recall");
      assert.equal(run.startedAt, 5);
      assert.equal(run.status, "in_progress");
      assert.deepEqual(run.metadata, { schemaVersion: 1 });

      const events = listTraceEventsForRun(id);
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.kind, "tool.input");
      assert.equal(event.sequence, 1);
      assert.deepEqual(event.payload, { schemaVersion: 1 });
      assert.deepEqual(event.redactedKeys, []);
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: listTraceEventsForRun returns [] for an unknown run id (no throw)", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      assert.deepEqual(listTraceEventsForRun(99999), []);
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: writeTraceEvent validates runId and kind (does not throw, returns false)", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const id = writeTraceRun({ name: "r", startedAt: 1 }) as number;
      // Invalid runId.
      assert.equal(writeTraceEvent({ runId: 0, kind: "k", payload: {} }), false);
      assert.equal(writeTraceEvent({ runId: -1, kind: "k", payload: {} }), false);
      // Invalid kind.
      assert.equal(writeTraceEvent({ runId: id, kind: "", payload: {} }), false);
      // DB must contain zero events after the three invalid calls.
      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const rows = db.prepare(`SELECT COUNT(*) AS c FROM trace_events`).get() as { c: number };
        assert.equal(rows.c, 0);
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: when trace is disabled, every API call is a safe no-op (no DB created)", () => {
  const tmp = mkTraceDir();
  withEnvSnapshot(() => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      // Even with projectRoot = tmp, no .curion/ must be created.
      assert.equal(getOrInitTraceWriter({ projectRoot: tmp }), null);
      assert.equal(writeTraceRun({ name: "x", startedAt: 1 }), null);
      assert.equal(writeTraceEvent({ runId: 1, kind: "k", payload: {} }), false);
      assert.equal(updateTraceRun(1, { status: "ok" }), false);
      assert.deepEqual(listTraceRuns(), []);
      assert.deepEqual(listTraceEventsForRun(1), []);

      const curionDir = path.join(tmp, ".curion");
      assert.ok(!fs.existsSync(curionDir), "no .curion/ must be created when tracing is disabled");
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("writer: writer API never throws on unserializable unknown payload fields", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const id = writeTraceRun({ name: "remember", startedAt: 1 }) as number;
      const big = 1_000_000_000_000_000_000_000n;

      let threw = false;
      let ok = false;
      try {
        ok = writeTraceEvent({
          runId: id,
          kind: "tool.input",
          payload: { big },
        });
      } catch {
        threw = true;
      }

      assert.equal(threw, false);
      assert.equal(ok, true);

      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const row = db
          .prepare(
            `SELECT payload_json
               FROM trace_events
              WHERE run_id = ?
              ORDER BY id ASC
              LIMIT 1`
          )
          .get(id) as { payload_json: string | null };

        assert.deepEqual(JSON.parse(row.payload_json ?? "null"), {
          schemaVersion: 1,
        });
        assert.ok(!(row.payload_json ?? "").includes("<bigint:"));
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("writer: updateTraceRun with no matching id returns false (does not throw)", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      assert.equal(updateTraceRun(99999, { status: "ok" }), false);
      assert.equal(updateTraceRun(0, { status: "ok" }), false);
      assert.equal(updateTraceRun(-1, { status: "ok" }), false);
    });
  } finally {
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 5. Retention / purge
// ---------------------------------------------------------------------------

test("retention: DEFAULT_TRACE_MAX_AGE_MS is 30 days", () => {
  assert.equal(DEFAULT_TRACE_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
});

test("retention: purgeTraceRunsOlderThan removes only runs older than the cutoff (and cascades events)", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const now = 10_000_000;
      const day = 24 * 60 * 60 * 1000;

      const oldId = writeTraceRun({
        name: "remember",
        startedAt: now - 60 * day,
      }) as number;
      const midId = writeTraceRun({
        name: "recall",
        startedAt: now - 10 * day,
      }) as number;
      const newId = writeTraceRun({
        name: "remember",
        startedAt: now - 1 * day,
      }) as number;

      assert.equal(writeTraceEvent({ runId: oldId, kind: "tool.input", payload: {} }), true);
      assert.equal(writeTraceEvent({ runId: oldId, kind: "tool.output", payload: {} }), true);
      assert.equal(writeTraceEvent({ runId: midId, kind: "tool.input", payload: {} }), true);
      assert.equal(writeTraceEvent({ runId: newId, kind: "tool.input", payload: {} }), true);

      const result = purgeTraceRunsOlderThan(
        { now: () => now, maxAgeMs: 30 * day },
        { projectRoot: tmp }
      );
      assert.equal(result.runsDeleted, 1);
      assert.equal(result.eventsDeleted, 2);

      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const runs = db.prepare(`SELECT id, name FROM trace_runs ORDER BY id ASC`).all() as Array<{
          id: number;
          name: string;
        }>;

        assert.deepEqual(
          runs.map((run) => run.id),
          [midId, newId]
        );
        assert.deepEqual(
          runs.map((run) => run.name),
          ["recall", "remember"]
        );

        const midEvents = db
          .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ?`)
          .get(midId) as { c: number };
        const newEvents = db
          .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ?`)
          .get(newId) as { c: number };
        const oldEvents = db
          .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id = ?`)
          .get(oldId) as { c: number };

        assert.equal(midEvents.c, 1);
        assert.equal(newEvents.c, 1);
        assert.equal(oldEvents.c, 0);
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("retention: purgeTraceRunsOlderThan with a default window is a 30-day cutoff", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const now = 50_000_000;
      const day = 24 * 60 * 60 * 1000;
      // 29-day-old run: must NOT be purged with the default 30-day window.
      const keep = writeTraceRun({
        name: "k",
        startedAt: now - 29 * day,
      }) as number;
      // 31-day-old run: must be purged.
      const drop = writeTraceRun({
        name: "d",
        startedAt: now - 31 * day,
      }) as number;
      writeTraceEvent({ runId: keep, kind: "e", payload: {} });
      writeTraceEvent({ runId: drop, kind: "e", payload: {} });
      writeTraceEvent({ runId: drop, kind: "e", payload: {} });

      const res = purgeTraceRunsOlderThan({ now: () => now }, { projectRoot: tmp });
      assert.equal(res.runsDeleted, 1);
      assert.equal(res.eventsDeleted, 2);
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("retention: purgeAllTraceRuns removes every run and cascades every event", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const a = writeTraceRun({ name: "a", startedAt: 1 }) as number;
      const b = writeTraceRun({ name: "b", startedAt: 2 }) as number;
      writeTraceEvent({ runId: a, kind: "e", payload: {} });
      writeTraceEvent({ runId: a, kind: "e", payload: {} });
      writeTraceEvent({ runId: b, kind: "e", payload: {} });

      const res = purgeAllTraceRuns({}, { projectRoot: tmp });
      assert.equal(res.runsDeleted, 2);
      assert.equal(res.eventsDeleted, 3);

      const db = openTraceDbReadOnly(path.join(tmp, ".curion", "trace.sqlite"));
      try {
        const r = db.prepare(`SELECT COUNT(*) AS c FROM trace_runs`).get() as { c: number };
        const e = db.prepare(`SELECT COUNT(*) AS c FROM trace_events`).get() as { c: number };
        assert.equal(r.c, 0);
        assert.equal(e.c, 0);
      } finally {
        db.close();
      }
    });
  } finally {
    rmTraceDir(tmp);
  }
});

test("retention: purge helpers are no-ops when trace is disabled", () => {
  const tmp = mkTraceDir();
  withEnvSnapshot(() => {
    process.env.CURION_TRACE_ENABLED = "0";
    resetTraceWriterForTests();
    try {
      const r1 = purgeAllTraceRuns({}, { projectRoot: tmp });
      assert.deepEqual(r1, { runsDeleted: 0, eventsDeleted: 0 });
      const r2 = purgeTraceRunsOlderThan({ now: () => 0, maxAgeMs: 0 }, { projectRoot: tmp });
      assert.deepEqual(r2, { runsDeleted: 0, eventsDeleted: 0 });
      // No .curion/ must have been created.
      assert.ok(!fs.existsSync(path.join(tmp, ".curion")));
    } finally {
      resetTraceWriterForTests();
      rmTraceDir(tmp);
    }
  });
});

test("retention: purgeTraceRunsOlderThan with invalid maxAgeMs returns the empty result (no throw)", () => {
  const tmp = mkTraceDir();
  try {
    withWriter(tmp, () => {
      const r = purgeTraceRunsOlderThan({ maxAgeMs: -1 }, { projectRoot: tmp });
      assert.deepEqual(r, { runsDeleted: 0, eventsDeleted: 0 });
      const r2 = purgeTraceRunsOlderThan({ maxAgeMs: Number.NaN }, { projectRoot: tmp });
      assert.deepEqual(r2, { runsDeleted: 0, eventsDeleted: 0 });
    });
  } finally {
    rmTraceDir(tmp);
  }
});

// ---------------------------------------------------------------------------
// 6. Memory DB is not touched
// ---------------------------------------------------------------------------

test("trace ops never touch the memory DB (.curion/curion.sqlite) under the same project root", () => {
  const tmp = mkTraceDir();
  let memHandle: ReturnType<typeof initStorage> | null = null;
  try {
    // Initialize a real memory DB in the same temp root, with one
    // memory row. We checkpoint the WAL on close so the on-disk
    // file has a stable, comparable shape.
    memHandle = initStorage({ projectRoot: tmp });
    memHandle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, updated_at, summary, state)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("fact", 1_000, 1_000, "pre-existing memory row", "active");
    const memDbPath = memHandle.dbPath;
    // Force a WAL checkpoint so the main DB file is fully up to date
    // and we can compare on-disk bytes.
    memHandle.db.pragma("wal_checkpoint(TRUNCATE)");
    const memBefore = fs.readFileSync(memDbPath);
    closeStorage(memHandle);
    memHandle = null;

    // Snapshot the on-disk file shape. mtime is excluded because
    // some filesystems update it for unrelated reads; size is a
    // stronger signal.
    const memSizeBefore = fs.statSync(memDbPath).size;
    const memMtimeBefore = fs.statSync(memDbPath).mtimeMs;

    // Now run a full trace write/purge cycle.
    withWriter(tmp, () => {
      const id = writeTraceRun({
        name: "remember",
        startedAt: 2_000,
        metadata: { ok: true },
      }) as number;
      assert.ok(id > 0);
      writeTraceEvent({
        runId: id,
        kind: "k",
        payload: { apiKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxx", keep: 1 },
      });
      const purge = purgeAllTraceRuns({}, { projectRoot: tmp });
      assert.equal(purge.runsDeleted, 1);
      assert.equal(purge.eventsDeleted, 1);
    });

    // Memory DB on disk must be untouched (same bytes, same size).
    const memAfter = fs.readFileSync(memDbPath);
    assert.ok(
      memBefore.equals(memAfter),
      "memory DB must be byte-identical after trace operations"
    );
    assert.equal(
      fs.statSync(memDbPath).size,
      memSizeBefore,
      "memory DB size must not change after trace operations"
    );
    // mtime is allowed to drift on some filesystems (e.g. relatime),
    // but in our test temp dir it must also be stable: trace ops
    // must not even touch the memory DB file.
    assert.equal(
      fs.statSync(memDbPath).mtimeMs,
      memMtimeBefore,
      "memory DB mtime must not change after trace operations"
    );

    // The two DBs live next to each other in the same .curion/ dir
    // but must not collide.
    const dirEntries = fs.readdirSync(path.join(tmp, ".curion"));
    assert.ok(dirEntries.includes("curion.sqlite"), "memory DB must be present");
    assert.ok(dirEntries.includes("trace.sqlite"), "trace DB must be present");
  } finally {
    if (memHandle) closeStorage(memHandle);
    rmTraceDir(tmp);
  }
});

test("trace-writer: run names and event kinds never persist arbitrary input, provider text, or error prose", () => {
  const projectRoot = mkTraceDir();
  const rawInput = "raw user input must not persist";
  const providerText = "provider response text must not persist";
  const errorProse = "Error: detailed provider failure prose must not persist";
  try {
    withEnvSnapshot(() => {
      process.env.CURION_TRACE_ENABLED = "1";
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
    try {
      closeTraceWriter();
    } catch {
      // Best-effort cleanup.
    }
    resetTraceWriterForTests();
    rmTraceDir(projectRoot);
  }
});

test("trace-writer: run statuses are runtime allowlisted and cross-project semantic kind remains intact", () => {
  const projectRoot = mkTraceDir();
  const maliciousStatus = "provider error prose must not persist";

  try {
    withEnvSnapshot(() => {
      process.env.CURION_TRACE_ENABLED = "1";
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
    try {
      closeTraceWriter();
    } catch {
      // Best-effort cleanup.
    }
    resetTraceWriterForTests();
    rmTraceDir(projectRoot);
  }
});
