/**
 * Trace writer API.
 *
 * Phase 1 contract:
 *   - Best-effort, NON-throwing. Every public function in this
 *     module returns a safe default (null / false / 0) on
 *     failure and logs a warning to stderr. Callers in the live
 *     `remember` / `recall` flow MUST be able to call into the
 *     trace writer without a try/catch.
 *   - Lazy, process-wide storage handle. The first call that
 *     needs a DB connection opens the handle; subsequent calls
 *     reuse it. The handle is closed when `closeTraceWriter()`
 *     is called (typically during process shutdown, mirroring
 *     `closeStorage`).
 *   - Synchronous, guarded writes. A `try / catch` around every
 *     `db.prepare(...).run(...)` keeps a corrupt DB, full disk,
 *     or `attempt to write a readonly database` from bubbling
 *     up. Phase 1 does not introduce a queue; later phases can
 *     add one if hot-path latency is a concern.
 *   - When `isTraceEnabled()` returns false, every API call is
 *     a no-op: no DB open, no I/O, no log line, no allocation
 *     beyond the return value.
 *   - `redactPayload` is applied to every event payload before
 *     it is JSON-stringified and inserted. Reasoning / CoT
 *     fields are dropped, sensitive values are redacted, and
 *     the redacted-key list is captured for the
 *     `trace_events.redacted_keys` column.
 *
 * Public surface (Phase 1):
 *   - `getOrInitTraceWriter(config?)` -> handle
 *   - `closeTraceWriter()`             -> void
 *   - `writeTraceRun(input)`           -> number | null
 *   - `writeTraceEvent(input)`         -> boolean
 *   - `updateTraceRun(id, patch)`      -> boolean
 *   - `listTraceRuns(options?)`        -> readonly TraceRunRow[]
 *   - `listTraceEventsForRun(runId)`   -> readonly TraceEventRow[]
 */

import type { Database, Statement } from "better-sqlite3";
import { logger } from "../logging/logger.js";
import { isTraceEnabled } from "./trace-enabled.js";
import { redactPayload } from "./trace-redaction.js";
import {
  type StorageConfig,
  type TraceStorageHandle,
  closeTraceStorage,
  initTraceStorage,
} from "./trace-storage.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

interface WriterState {
  handle: TraceStorageHandle;
  /** Cached prepared statements; rebuilt on schema bumps. */
  stmts: WriterStatements;
}

interface WriterStatements {
  insertRun: Statement;
  updateRun: Statement;
  insertEvent: Statement;
  /** Per-run next sequence lookup. */
  nextSequence: Statement;
}

let writerState: WriterState | null = null;

/** Test/utility: confirmed-closed flag. */
let closed = false;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public status lifecycle for a trace run. */
export type TraceRunStatus = "in_progress" | "ok" | "error" | "cancelled";

export interface TraceRunInput {
  /** Stable name, e.g. "remember", "recall", or a controller phase. */
  name: string;
  /** Wall-clock start (ms epoch). Defaults to `Date.now()`. */
  startedAt?: number;
  /** Optional open-ended metadata JSON value. */
  metadata?: unknown;
}

export interface TraceRunPatch {
  /** New end timestamp (ms epoch). */
  endedAt?: number;
  /** New status. */
  status?: TraceRunStatus;
  /** New metadata (replaces the existing blob). */
  metadata?: unknown;
}

export interface TraceRunRow {
  id: number;
  name: string;
  startedAt: number;
  endedAt: number | null;
  status: TraceRunStatus;
  metadata: unknown;
}

export interface TraceEventInput {
  /** Run id returned from `writeTraceRun`. */
  runId: number;
  /** Event kind, e.g. "tool.input", "provider.request". */
  kind: string;
  /** Payload to redact and persist. */
  payload: unknown;
  /** Wall-clock ts. Defaults to `Date.now()`. */
  ts?: number;
}

export interface TraceEventRow {
  id: number;
  runId: number;
  ts: number;
  kind: string;
  payload: unknown;
  redactedKeys: string[];
  sequence: number;
}

// ---------------------------------------------------------------------------
// Handle acquisition
// ---------------------------------------------------------------------------

/**
 * Return the active writer handle, opening it on first use.
 *
 * Returns `null` when tracing is disabled or when the DB cannot
 * be opened. The function never throws.
 */
export function getOrInitTraceWriter(config: StorageConfig = {}): TraceStorageHandle | null {
  if (!isTraceEnabled()) return null;
  if (writerState) return writerState.handle;
  if (closed) return null;
  try {
    const handle = initTraceStorage(config);
    writerState = {
      handle,
      stmts: prepareStatements(handle.db),
    };
    return handle;
  } catch (err) {
    logWarn(`trace writer: failed to open DB: ${(err as Error).message}`);
    return null;
  }
}

/** Close the writer and release the handle. Safe to call multiple times. */
export function closeTraceWriter(): void {
  if (writerState) {
    try {
      closeTraceStorage(writerState.handle);
    } catch (err) {
      logWarn(`trace writer: close failed: ${(err as Error).message}`);
    }
    writerState = null;
  }
  closed = true;
}

function prepareStatements(db: Database): WriterStatements {
  return {
    insertRun: db.prepare(`
      INSERT INTO trace_runs (name, started_at, ended_at, status, metadata)
      VALUES (@name, @started_at, @ended_at, @status, @metadata)
    `),
    updateRun: db.prepare(`
      UPDATE trace_runs
         SET ended_at = COALESCE(@ended_at, ended_at),
             status   = COALESCE(@status, status),
             metadata = COALESCE(@metadata, metadata)
       WHERE id = @id
    `),
    insertEvent: db.prepare(`
      INSERT INTO trace_events (
        run_id, ts, kind, payload_json, redacted_keys, sequence
      ) VALUES (
        @run_id, @ts, @kind, @payload_json, @redacted_keys, @sequence
      )
    `),
    nextSequence: db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
         FROM trace_events WHERE run_id = ?`
    ),
  };
}

// ---------------------------------------------------------------------------
// Public writer API
// ---------------------------------------------------------------------------

/**
 * Insert a new trace run. Returns the assigned id, or `null` when
 * the write was skipped (tracing disabled, DB unavailable, or the
 * write failed). Never throws.
 */
export function writeTraceRun(input: TraceRunInput): number | null {
  const state = requireState();
  if (!state) return null;
  const startedAt = input.startedAt ?? Date.now();
  const metadataJson = safeStringify(input.metadata);
  try {
    const info = state.stmts.insertRun.run({
      name: input.name,
      started_at: startedAt,
      ended_at: null,
      status: "in_progress",
      metadata: metadataJson,
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    logWarn(`trace writer: writeTraceRun failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Insert a new trace event. Returns `true` when the row was
 * written, `false` otherwise. Never throws.
 */
export function writeTraceEvent(input: TraceEventInput): boolean {
  const state = requireState();
  if (!state) return false;
  if (!Number.isInteger(input.runId) || input.runId <= 0) {
    logWarn(`trace writer: writeTraceEvent: invalid runId ${input.runId}`);
    return false;
  }
  if (typeof input.kind !== "string" || input.kind.length === 0) {
    logWarn("trace writer: writeTraceEvent: missing kind");
    return false;
  }
  const ts = input.ts ?? Date.now();
  // Redact first; capture the top-level redacted keys separately
  // so a reader can see at a glance which keys were scrubbed.
  const redacted = redactPayload(input.payload);
  const redactedKeys = captureRedactedKeys(input.payload, redacted);
  let payloadJson: string | null;
  try {
    payloadJson = safeStringify(redacted);
  } catch (err) {
    logWarn(`trace writer: writeTraceEvent: payload not serializable: ${(err as Error).message}`);
    return false;
  }
  // Sequence: look up max+1 for this run. The whole insert is
  // wrapped in a synchronous transaction-like try/catch so a
  // race with the retention helper can never throw into the
  // caller.
  let sequence = 0;
  try {
    const row = state.stmts.nextSequence.get(input.runId) as { next: number };
    sequence = row.next;
    state.stmts.insertEvent.run({
      run_id: input.runId,
      ts,
      kind: input.kind,
      payload_json: payloadJson,
      redacted_keys: safeStringify(redactedKeys),
      sequence,
    });
    return true;
  } catch (err) {
    logWarn(`trace writer: writeTraceEvent failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Update an existing trace run. Returns `true` when a row was
 * updated, `false` otherwise. Never throws.
 */
export function updateTraceRun(id: number, patch: TraceRunPatch): boolean {
  const state = requireState();
  if (!state) return false;
  if (!Number.isInteger(id) || id <= 0) {
    logWarn(`trace writer: updateTraceRun: invalid id ${id}`);
    return false;
  }
  try {
    const info = state.stmts.updateRun.run({
      id,
      ended_at: typeof patch.endedAt === "number" ? patch.endedAt : null,
      status: typeof patch.status === "string" ? patch.status : null,
      metadata: patch.metadata === undefined ? null : safeStringify(patch.metadata),
    });
    return info.changes > 0;
  } catch (err) {
    logWarn(`trace writer: updateTraceRun failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * List trace runs ordered by id ascending. Returns an empty list
 * when tracing is disabled or the DB is unavailable. Never throws.
 */
export function listTraceRuns(options: { limit?: number } = {}): readonly TraceRunRow[] {
  const state = requireState();
  if (!state) return [];
  const limit = options.limit ?? 200;
  try {
    const rows = state.handle.db
      .prepare(
        `SELECT id, name, started_at, ended_at, status, metadata
           FROM trace_runs
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      name: string;
      started_at: number;
      ended_at: number | null;
      status: string;
      metadata: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: normalizeStatus(r.status),
      metadata: parseJsonOrNull(r.metadata),
    }));
  } catch (err) {
    logWarn(`trace writer: listTraceRuns failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * List events for a run, ordered by sequence. Returns an empty
 * list when tracing is disabled or the DB is unavailable. Never
 * throws.
 */
export function listTraceEventsForRun(runId: number): readonly TraceEventRow[] {
  const state = requireState();
  if (!state) return [];
  if (!Number.isInteger(runId) || runId <= 0) return [];
  try {
    const rows = state.handle.db
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
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      ts: r.ts,
      kind: r.kind,
      payload: parseJsonOrNull(r.payload_json),
      redactedKeys: parseStringArrayOrEmpty(r.redacted_keys),
      sequence: r.sequence,
    }));
  } catch (err) {
    logWarn(`trace writer: listTraceEventsForRun failed: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireState(): WriterState | null {
  if (closed) return null;
  if (!isTraceEnabled()) return null;
  if (writerState) return writerState;
  // Lazy open on first write.
  const handle = getOrInitTraceWriter();
  if (!handle) return null;
  return writerState;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(safeRepr(value));
  }
}

function safeRepr(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return `<bigint:${(value as bigint).toString()}>`;
  if (t === "function") return "<function>";
  if (t === "symbol") return "<symbol>";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    return value.map((v) => safeRepr(v, seen));
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "<circular>";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = safeRepr(obj[k], seen);
    }
    return out;
  }
  return `<unserializable:${t}>`;
}

function captureRedactedKeys(original: unknown, redacted: unknown): string[] {
  if (!isPlainObject(original) || !isPlainObject(redacted)) return [];
  const out: string[] = [];
  for (const key of Object.keys(original)) {
    if (!(key in redacted)) {
      // Key was dropped (e.g. reasoning field).
      out.push(key);
    } else if (original[key] !== redacted[key]) {
      // Value was rewritten (e.g. credential redacted to "<redacted>").
      out.push(key);
    }
  }
  // Stable order.
  out.sort();
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonOrNull(s: string | null): unknown {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseStringArrayOrEmpty(s: string | null): string[] {
  const v = parseJsonOrNull(s);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeStatus(s: string): TraceRunStatus {
  switch (s) {
    case "in_progress":
    case "ok":
    case "error":
    case "cancelled":
      return s;
    default:
      return "in_progress";
  }
}

function logWarn(msg: string): void {
  try {
    logger.warn(msg);
  } catch {
    // The logger itself should never throw, but if it does we
    // swallow it here so the writer's "never throw" contract
    // holds even under double-fault conditions.
  }
}

/**
 * Test/utility: reset the module-level state. Intended for test
 * harnesses that need a clean writer between cases. Production
 * code does not call this.
 */
export function resetTraceWriterForTests(): void {
  if (writerState) {
    try {
      closeTraceStorage(writerState.handle);
    } catch {
      // ignore
    }
    writerState = null;
  }
  closed = false;
}
