/**
 * Trace storage.
 *
 * Phase 1 foundation:
 *   - A SECOND sqlite database under the project-local `.curion/`
 *     directory, at `.curion/trace.sqlite`. The trace DB is
 *     strictly separate from the memory DB (`.curion/curion.sqlite`).
 *     No memory table, no `_meta` from the memory DB, no FTS5
 *     from the memory DB. The two databases are fully isolated
 *     and can be opened / closed / purged independently.
 *   - Same `.curion/` permissions as the memory DB: directory
 *     mode `0o700` (created here when it does not exist so the
 *     trace writer is safe even if the memory DB was never
 *     initialized in the same process).
 *   - WAL journal mode for fast concurrent reads and bounded
 *     write latency.
 *   - Schema is forward-compatible: `_meta` for schema version
 *     and a `created_at` timestamp; two content tables
 *     (`trace_runs`, `trace_events`) sized for the next phases
 *     of the project (run lifecycle + per-event payloads).
 *   - Foreign keys are on. `trace_events.run_id` cascades on
 *     delete, so a single delete on `trace_runs` removes the
 *     whole run's events. The retention helper relies on this.
 *
 * NOT in Phase 1:
 *   - No tool-call capture. There is no instrumented path that
 *     writes to this DB from the live `remember` / `recall` flow.
 *     The writer API exists for tests and for later phases.
 *   - No queue / no async writer. Writes are simple, synchronous,
 *     guarded. The trace writer module wraps the call in a
 *     try/catch so a failure here can never throw into a
 *     caller.
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../logging/logger.js";
import { CURION_DIRNAME, type StorageConfig } from "../storage/storage.js";

/** Filename of the trace DB inside `.curion/`. */
export const CURION_TRACE_DB_FILENAME = "trace.sqlite";

/**
 * Re-export of the project-local storage config shape so trace
 * helpers can accept the same `projectRoot` option that the
 * memory storage module accepts, without forcing every caller
 * to also import from `../storage/storage.js`.
 */
export type { StorageConfig };

/** Schema version stamped into `_meta.schema_version` on init. */
export const TRACE_SCHEMA_VERSION = "v1-trace-1";

export interface TraceStorageHandle {
  /** Absolute path to the .curion directory. */
  dir: string;
  /** Absolute path to the trace SQLite database file. */
  dbPath: string;
  /** Open better-sqlite3 handle. */
  db: Database.Database;
}

/**
 * Resolve the path to the trace DB without touching the
 * filesystem. Always returns `<root>/.curion/trace.sqlite` for
 * the supplied `projectRoot` (default `process.cwd()`).
 */
export function resolveTraceDbPath(config: StorageConfig = {}): string {
  const root = config.projectRoot ?? process.cwd();
  return path.join(root, CURION_DIRNAME, CURION_TRACE_DB_FILENAME);
}

/**
 * Initialize the trace storage. Idempotent. Safe to call multiple
 * times within the same process: each call returns its own
 * `Database` handle, which the caller is responsible for
 * closing. The directory is created with mode `0o700` if it does
 * not yet exist, mirroring the memory DB's contract.
 *
 * Best-effort: if the schema migration throws (corrupt DB,
 * missing parent directory due to permissions, etc.) the error
 * is logged and rethrown — the trace writer layer is the place
 * that catches errors and turns them into no-ops; the storage
 * layer surfaces honest failures so the operator can see them
 * in stderr.
 */
export function initTraceStorage(config: StorageConfig = {}): TraceStorageHandle {
  const root = config.projectRoot ?? process.cwd();
  const dir = path.join(root, CURION_DIRNAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    logger.info(`created project storage at ${dir} (trace)`);
  }
  const dbPath = path.join(dir, CURION_TRACE_DB_FILENAME);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A trace run is a single high-level operation, e.g. a
    -- public tool invocation. It carries a stable id, a name
    -- (typically the public tool name or the controller phase),
    -- a wall-clock start / end, a lifecycle status, and an
    -- open-ended metadata JSON blob for tags / counters /
    -- future use. Phase 1 does NOT write any rows; the table
    -- exists so the schema does not need to change later.
    CREATE TABLE IF NOT EXISTS trace_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      status      TEXT NOT NULL DEFAULT 'in_progress',
      metadata    TEXT
    );

    -- A trace event is a single observation inside a run, e.g.
    -- a tool-call attempt, a provider request, a safety
    -- pre-check, a redacted prompt body. "kind" is a short
    -- stable tag (e.g. "tool.input", "tool.output",
    -- "provider.request", "provider.response",
    -- "safety.precheck"). "payload_json" is the redacted JSON
    -- value, serialized by the writer after redactPayload.
    -- "redacted_keys" is a JSON array of the top-level keys
    -- that were either redacted-in-place or dropped, so a
    -- reader can see at a glance what was scrubbed.
    -- "sequence" is a per-run monotonically increasing counter
    -- assigned by the writer so the original ordering is
    -- preserved even when many events are inserted in the same
    -- millisecond.
    CREATE TABLE IF NOT EXISTS trace_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER NOT NULL,
      ts            INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      payload_json  TEXT,
      redacted_keys TEXT,
      sequence      INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES trace_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS trace_events_run_id_idx
      ON trace_events(run_id, sequence);
  `);

  const insertMeta = db.prepare(
    "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
  );
  insertMeta.run("schema_version", TRACE_SCHEMA_VERSION);
  insertMeta.run("created_at", String(Date.now()));
  insertMeta.run("dirname", CURION_DIRNAME);

  return { dir, dbPath, db };
}

/**
 * Close a trace storage handle. Safe to call multiple times.
 */
export function closeTraceStorage(handle: TraceStorageHandle): void {
  try {
    handle.db.close();
  } catch {
    // ignore
  }
}
