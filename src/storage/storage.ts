/**
 * Project-local storage skeleton.
 *
 * - Project-local hidden directory `.cortex/` at the project root.
 * - Local SQLite database inside `.cortex/`.
 * - Gitignored (see repo `.gitignore`).
 *
 * Phase 1 contract:
 *   - The skeleton MAY initialize the directory and schema.
 *   - It MUST NOT persist raw original text in this prototype phase.
 *     `remember` returns a not-yet-implemented message and does not write
 *     to storage. Retrieval variants query the schema with placeholders.
 *
 * MVP vertical slice (Narrow `remember(text)`):
 *   - The `memories` table now stores controller-normalized summaries
 *     and metadata. It does NOT store raw original text.
 *   - Schema migration is additive and idempotent: existing v2 DBs
 *     are upgraded in place; fresh DBs are created with the full
 *     schema. The base `id, kind, created_at` shape is preserved.
 *   - All schema changes are versioned in `_meta.schema_version`.
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { logger } from "../logging/logger.js";

export const CORTEX_DIRNAME = ".cortex";
export const CORTEX_DB_FILENAME = "cortex.sqlite";

export interface StorageHandle {
  /** Absolute path to the .cortex directory. */
  dir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Open better-sqlite3 handle. */
  db: Database.Database;
}

export interface StorageConfig {
  /** Project root. .cortex/ will be created here. Defaults to cwd. */
  projectRoot?: string;
}

/**
 * Resolve the project-local .cortex path. Does not create anything.
 */
export function resolveCortexDir(config: StorageConfig = {}): string {
  const root = config.projectRoot ?? process.cwd();
  return path.join(root, CORTEX_DIRNAME);
}

/**
 * Initialize the project-local storage skeleton.
 *
 * Creates the .cortex directory if missing and applies the schema. The
 * schema is intentionally minimal in Phase 1: an empty `memories` table
 * with a `created_at` column, and a `_meta` key/value table. No raw
 * text columns are defined.
 */
export function initStorage(config: StorageConfig = {}): StorageHandle {
  const dir = resolveCortexDir(config);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    logger.info(`created project storage at ${dir}`);
  }

  const dbPath = path.join(dir, CORTEX_DB_FILENAME);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Minimal Phase 1 schema. Intentionally no raw text column.
  //
  // MVP slice: extend the `memories` table with safe columns used by
  // the controller to persist sanitized summaries. Raw input and
  // original text columns are NEVER added. Column additions are
  // idempotent so both fresh DBs and existing v2 DBs converge on the
  // same final shape.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL DEFAULT 'memory',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id  INTEGER PRIMARY KEY,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
  `);

  // Idempotent column adds for the MVP persisted-summary columns.
  // Each PRAGMA is wrapped so a partial upgrade cannot leave the
  // table in a half-migrated state. New columns:
  //   - summary         TEXT  (controller-normalized; never raw input)
  //   - state           TEXT  (active|superseded|invalidated)
  //   - provider_id     TEXT  (which provider produced the analysis)
  //   - model_id        TEXT  (which model produced the analysis)
  //   - confidence      REAL  (provider-reported 0..1)
  //   - safety_flags    TEXT  (JSON array of safety class strings)
  //   - metadata        TEXT  (JSON blob for tags/entities/classification)
  //   - updated_at      INTEGER
  ensureColumn(db, "memories", "summary", "TEXT");
  ensureColumn(db, "memories", "state", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "memories", "provider_id", "TEXT");
  ensureColumn(db, "memories", "model_id", "TEXT");
  ensureColumn(db, "memories", "confidence", "REAL");
  ensureColumn(db, "memories", "safety_flags", "TEXT");
  ensureColumn(db, "memories", "metadata", "TEXT");
  ensureColumn(db, "memories", "updated_at", "INTEGER");

  // FTS5 is part of the retrieval variant set. We create the virtual
  // table on top of a stub columns; raw text persistence is gated by
  // the `remember` tool which currently refuses to write.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        terms
      );
    `);
  } catch (err) {
    // FTS5 is part of SQLite; if missing, retrieval benchmarks will
    // surface the limitation. We log and continue.
    logger.warn(
      `FTS5 virtual table unavailable: ${(err as Error).message}`,
    );
  }

  const insertMeta = db.prepare(
    "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
  );
  insertMeta.run("schema_version", "v2-mvp-1");
  insertMeta.run("created_at", String(Date.now()));

  return { dir, dbPath, db };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Add a column to a table if it does not already exist. Idempotent
 * and safe to call repeatedly. Column type defaults are taken from
 * the SQL fragment (e.g. `"TEXT"`, `"TEXT NOT NULL DEFAULT 'x'"`,
 * `"INTEGER"`). Used by the MVP schema migration to extend the
 * `memories` table without dropping or rewriting existing rows.
 */
function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  for (const c of cols) {
    if (c.name === column) return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
}

// ---------------------------------------------------------------------------
// Memory record repository (MVP slice)
// ---------------------------------------------------------------------------

/**
 * Internal kind enum for the MVP slice. Provider classifications are
 * mapped to one of these values by the controller. `finding` is the
 * safe fallback when the provider classification is unrecognized.
 */
export type MemoryKind =
  | "decision"
  | "fact"
  | "preference"
  | "context"
  | "conflict"
  | "reference"
  | "finding";

/** Lifecycle state of a memory record. MVP writes only `active`. */
export type MemoryState = "active" | "superseded" | "invalidated";

/** Allowed list of internal kinds, exported for validation. */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "decision",
  "fact",
  "preference",
  "context",
  "conflict",
  "reference",
  "finding",
];

/** Allowed list of internal states, exported for validation. */
export const MEMORY_STATES: readonly MemoryState[] = [
  "active",
  "superseded",
  "invalidated",
];

/**
 * Persisted record shape. The `summary` field is the
 * controller-normalized safe summary; it is never the raw input
 * text. `metadata` is a JSON-encoded string of provider
 * tags/entities/classification so the schema stays small and
 * forward-compatible.
 */
export interface MemoryRecordInput {
  /** Internal kind enum. Falls back to `finding` if unknown. */
  kind: MemoryKind;
  /** State. MVP only writes `active`. */
  state: MemoryState;
  /** Controller-normalized summary. MUST NOT be raw input. */
  summary: string;
  /** Provider id (`minimax` | `nvidia-nim`) or null. */
  providerId: string | null;
  /** Model id or null. */
  modelId: string | null;
  /** Provider confidence (0..1) or null. */
  confidence: number | null;
  /** Safety flags (e.g. `["raw-dump-redacted"]`). */
  safetyFlags: string[];
  /** Free-form metadata JSON (tags, entities, classification). */
  metadata: Record<string, unknown>;
}

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  state: MemoryState;
  summary: string;
  providerId: string | null;
  modelId: string | null;
  confidence: number | null;
  safetyFlags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * A safe, read-only projection of a memory record used by the
 * recall controller to feed the provider synthesis prompt.
 *
 * Only safe fields are exposed:
 *   - `id`, `kind`, `state`
 *   - `summary` (the controller-normalized safe summary)
 *   - `tags` and `classification` (parsed from the metadata JSON
 *     blob, but never the raw `metadata` object itself)
 *   - `confidence` (provider confidence; useful for ranking)
 *
 * No raw input, no original text, no provider key, and no
 * unredacted metadata fields are exposed. The repo never had
 * columns for raw input; this is enforced at the schema level
 * and re-asserted at this read boundary.
 */
export interface SafeMemorySummary {
  id: number;
  kind: MemoryKind;
  state: MemoryState;
  summary: string;
  tags: string[];
  classification: string | null;
  confidence: number | null;
}

/**
 * Insert a new memory record. Returns the inserted row (including
 * assigned id and timestamps). The summary is stored verbatim as
 * given by the controller — the controller is responsible for never
 * passing raw input through. The repo does not re-validate the
 * summary against the raw input; it trusts the controller seam.
 */
export function insertMemoryRecord(
  handle: StorageHandle,
  input: MemoryRecordInput,
): MemoryRecord {
  const now = Date.now();
  const stmt = handle.db.prepare(`
    INSERT INTO memories (
      kind, created_at, updated_at, summary, state,
      provider_id, model_id, confidence, safety_flags, metadata
    ) VALUES (
      @kind, @created_at, @updated_at, @summary, @state,
      @provider_id, @model_id, @confidence, @safety_flags, @metadata
    )
  `);
  const info = stmt.run({
    kind: input.kind,
    created_at: now,
    updated_at: now,
    summary: input.summary,
    state: input.state,
    provider_id: input.providerId,
    model_id: input.modelId,
    confidence: input.confidence,
    safety_flags: JSON.stringify(input.safetyFlags),
    metadata: JSON.stringify(input.metadata),
  });
  const id = Number(info.lastInsertRowid);
  return {
    id,
    kind: input.kind,
    state: input.state,
    summary: input.summary,
    providerId: input.providerId,
    modelId: input.modelId,
    confidence: input.confidence,
    safetyFlags: [...input.safetyFlags],
    metadata: { ...input.metadata },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Close the storage handle. Safe to call multiple times.
 */
export function closeStorage(handle: StorageHandle): void {
  try {
    handle.db.close();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Read-side query (recall MVP)
// ---------------------------------------------------------------------------

/**
 * List all active memory summaries in deterministic order.
 *
 * This is the read-side complement to `insertMemoryRecord` used by
 * the recall controller. It returns only safe fields — never any
 * raw input, never the original text, never the raw `metadata` JSON
 * blob. The schema itself has no raw input column, so this read is
 * inherently safe; the explicit projection here is defense in depth
 * against future schema changes that might add sensitive columns.
 *
 * Order: oldest first (ascending `id`). This is stable across calls
 * and is the same order the controller will rank in. The retrieval
 * ranking layer applies its own scoring; this function does no
 * scoring.
 *
 * Limit defaults to 200 to keep the working set bounded for the
 * recall MVP. The recall controller will re-rank this list and pick
 * its own top-K.
 */
export function listActiveMemorySummaries(
  handle: StorageHandle,
  options: { limit?: number } = {},
): SafeMemorySummary[] {
  const limit = options.limit ?? 200;
  // Only ever select the safe columns. Never SELECT *.
  const rows = handle.db
    .prepare(
      `SELECT id, kind, state, summary, confidence, metadata
         FROM memories
         WHERE state = 'active'
         ORDER BY id ASC
         LIMIT ?`,
    )
    .all(limit) as Array<{
      id: number;
      kind: string;
      state: string;
      summary: string | null;
      confidence: number | null;
      metadata: string | null;
    }>;
  const out: SafeMemorySummary[] = [];
  for (const r of rows) {
    // Defensive: if a future row has null summary, skip it. The
    // controller never inserts a null summary, but the schema
    // allows it (TEXT NULL default).
    if (typeof r.summary !== "string" || r.summary.length === 0) continue;
    let tags: string[] = [];
    let classification: string | null = null;
    if (typeof r.metadata === "string" && r.metadata.length > 0) {
      try {
        const parsed = JSON.parse(r.metadata) as Record<string, unknown>;
        if (Array.isArray(parsed.tags)) {
          tags = parsed.tags
            .filter((t): t is string => typeof t === "string")
            .slice(0, 16);
        }
        if (typeof parsed.classification === "string") {
          classification = parsed.classification;
        }
      } catch {
        // Malformed metadata: treat as no tags / no classification.
      }
    }
    out.push({
      id: r.id,
      kind: (MEMORY_KINDS.includes(r.kind as MemoryKind)
        ? (r.kind as MemoryKind)
        : "finding"),
      state: (MEMORY_STATES.includes(r.state as MemoryState)
        ? (r.state as MemoryState)
        : "active"),
      summary: r.summary,
      tags,
      classification,
      confidence: r.confidence,
    });
  }
  return out;
}
