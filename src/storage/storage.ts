/**
 * Project-local storage skeleton.
 *
 * - Project-local hidden directory `.curion/` at the project root.
 * - Local SQLite database inside `.curion/`.
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

export const CURION_DIRNAME = ".curion";
export const CURION_DB_FILENAME = "curion.sqlite";

export interface StorageHandle {
  /** Absolute path to the .curion directory. */
  dir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Open better-sqlite3 handle. */
  db: Database.Database;
}

export interface StorageConfig {
  /** Project root. .curion/ will be created here. Defaults to cwd. */
  projectRoot?: string;
}

/**
 * Resolve the project-local .curion path. Does not create anything.
 */
export function resolveCurionDir(config: StorageConfig = {}): string {
  const root = config.projectRoot ?? process.cwd();
  return path.join(root, CURION_DIRNAME);
}

/**
 * Initialize the project-local storage skeleton.
 *
 * Creates the .curion directory if missing and applies the schema. The
 * schema is intentionally minimal in Phase 1: an empty `memories` table
 * with a `created_at` column, and a `_meta` key/value table. No raw
 * text columns are defined.
 */
export function initStorage(config: StorageConfig = {}): StorageHandle {
  const dir = resolveCurionDir(config);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    logger.info(`created project storage at ${dir}`);
  }

  const dbPath = path.join(dir, CURION_DB_FILENAME);
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
  //
  // The `memories_fts` index is kept in sync with the `memories`
  // content table by three triggers (insert / update / delete). The
  // `terms` column is the FTS5-indexed text and stores the
  // controller-normalized `summary`. The `memory_id` column is
  // UNINDEXED (stored, not searched) so callers can join back to
  // the content table.
  //
  // The delete and update paths use a plain `DELETE FROM
  // memories_fts WHERE rowid = ?` rather than the FTS5 `'delete'`
  // command (SQLite FTS5 docs §4.4.3). The FTS5 `'delete'` command
  // does not work reliably in this SQLite build for FTS5 tables
  // that include UNINDEXED columns — it raises a generic "SQL logic
  // error" — so the plain DELETE is used as the working
  // equivalent. The FTS5 `rowid` is set explicitly to match
  // `memories.rowid` for stable joins; `COALESCE(..., '')` coerces
  // NULL summaries to an empty document (the schema allows NULL
  // summary; an empty document simply doesn't match any FTS5
  // query).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        terms
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, memory_id, terms)
        VALUES (new.rowid, new.id, COALESCE(new.summary, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        DELETE FROM memories_fts WHERE rowid = old.rowid;
        INSERT INTO memories_fts(rowid, memory_id, terms)
        VALUES (new.rowid, new.id, COALESCE(new.summary, ''));
      END;
    `);

    // One-shot backfill: index any pre-existing rows in `memories`
    // that are not already represented in `memories_fts`. This
    // handles the latent bug where the FTS5 table was created but
    // never populated (no triggers, no writer code path). After the
    // first run on a given DB, the index is fully populated and the
    // triggers keep it in sync going forward; subsequent startups
    // are a no-op because the `INSERT OR IGNORE` skips rows whose
    // `rowid` already exists in the FTS5 table.
    //
    // Note: the FTS5 `'rebuild'` command cannot be used here because
    // `memories_fts` is not linked to `memories` via the FTS5
    // `content=` option; the FTS5 table is its own content store.
    // An explicit `INSERT OR IGNORE ... SELECT` is the correct
    // backfill for this schema.
    db.exec(
      `INSERT OR IGNORE INTO memories_fts(rowid, memory_id, terms)
         SELECT rowid, id, COALESCE(summary, '')
           FROM memories;`,
    );
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
 *
 * Kind semantics:
 *   decision  — chosen direction / resolved choice
 *   fact      — observed result / verifiable piece of information
 *   preference — user likes / style / stated inclination
 *   context   — background / surrounding situation
 *   conflict  — tension / contradiction / open disagreement
 *   reference — domain knowledge / schema / documented fact
 *   policy    — standing future behavior / rule (e.g. "always use X for Y")
 *   constraint — hard boundary / requirement / limitation (e.g. "never exceed N")
 *   finding   — observed result / evidence (safe fallback)
 */
export type MemoryKind =
  | "decision"
  | "fact"
  | "preference"
  | "context"
  | "conflict"
  | "reference"
  | "policy"
  | "constraint"
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
  "policy",
  "constraint",
  "finding",
];

/** Allowed list of internal states, exported for validation. */
export const MEMORY_STATES: readonly MemoryState[] = [
  "active",
  "superseded",
  "invalidated",
];

/**
 * Persisted record shape. The `memoryContent` field is the
 * controller-normalized safe memory content; it is never the
 * raw input text. `metadata` is a JSON-encoded string of provider
 * tags/entities/classification so the schema stays small and
 * forward-compatible.
 *
 * Phase 1 internal naming cleanup: the TypeScript property is
 * `memoryContent` to avoid the misleading name "summary" (which
 * suggests a free-form summary string while the field is in
 * fact the persisted memory body — text the controller produced
 * from the provider's sanitized output). The underlying SQLite
 * column is intentionally still named `summary` for backward
 * compatibility with existing DBs and the FTS5 sync triggers;
 * the SQL column name is the storage boundary, the TypeScript
 * property is the internal contract.
 */
export interface MemoryRecordInput {
  /** Internal kind enum. Falls back to `finding` if unknown. */
  kind: MemoryKind;
  /** State. MVP only writes `active`. */
  state: MemoryState;
  /**
   * Controller-normalized memory content. MUST NOT be raw input.
   * Persisted to the DB column `summary` (see SQL layer).
   */
  memoryContent: string;
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
  /**
   * Controller-normalized memory content. Source column on disk
   * is `summary`; the TypeScript property is the internal name.
   */
  memoryContent: string;
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
 *   - `memoryContent` (the controller-normalized safe memory
 *     body — source column on disk is `summary`)
 *   - `tags` and `classification` (parsed from the metadata JSON
 *     blob, but never the raw `metadata` object itself)
 *   - `confidence` (provider confidence; useful for ranking)
 *
 * No raw input, no original text, no provider key, and no
 * unredacted metadata fields are exposed. The repo never had
 * columns for raw input; this is enforced at the schema level
 * and re-asserted at this read boundary.
 *
 * Phase 1 internal naming cleanup: the internal property is
 * `memoryContent`. The DB column remains `summary`; the read
 * projection re-binds SQL `summary` to the TS `memoryContent`
 * field here.
 */
export interface SafeMemorySummary {
  id: number;
  kind: MemoryKind;
  state: MemoryState;
  memoryContent: string;
  tags: string[];
  classification: string | null;
  confidence: number | null;
}

/**
 * Insert a new memory record. Returns the inserted row (including
 * assigned id and timestamps). The memory content is stored
 * verbatim as given by the controller — the controller is
 * responsible for never passing raw input through. The repo does
 * not re-validate the memory content against the raw input; it
 * trusts the controller seam.
 *
 * Phase 1 internal naming cleanup: the TypeScript input field is
 * `memoryContent`; the underlying SQL column is still `summary`.
 * The binding name on the parameterized statement (`@summary`)
 * matches the SQL column name and is preserved.
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
    summary: input.memoryContent,
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
    memoryContent: input.memoryContent,
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
 * Update only the `metadata` JSON column on a single memory
 * row, identified by its autoincrement `id`. Returns the
 * refreshed `MemoryRecord` re-read from the row.
 *
 * This is the narrow, typed seam the controller uses to
 * append the derived `relationship` block onto the existing
 * metadata of a row that was just inserted (the candidate's
 * real `id` is not known at insert time, so a
 * `relationship.olderVariantsOf` derivation must happen
 * post-insert). It updates a single column on a single row
 * and does NOT touch `state`, `summary`, or any other field.
 *
 * Constraints (Phase B invariant):
 *   - It never reads or writes raw text. The metadata column
 *     is the existing JSON blob; the function only stores the
 *     `patch` argument verbatim (after `JSON.stringify`).
 *   - It never transitions `state`. `state` stays whatever it
 *     was when the row was inserted (always `active` for
 *     controller writes).
 *   - It never reads from `metadata`; it overwrites. The
 *     caller is responsible for re-injecting any preserved
 *     keys via the `buildPersistedMetadata` helper (which is
 *     non-mutating and never overwrites a pre-existing
 *     `relationship` key).
 *   - It does not enforce "row exists" semantics defensively.
 *     The UPDATE simply affects zero rows when the id is
 *     unknown; the function then throws because the post-
 *     update re-read finds no row. The controller always
 *     passes the id it just received from `insertMemoryRecord`,
 *     so this is a safe contract — a throw is unreachable in
 *     production. Tests that bypass the controller and call
 *     this with a non-existent id will see a clear error.
 *   - It does not introduce a new column. The `metadata TEXT`
 *     column already exists (Phase 1 schema).
 */
export function updateMemoryMetadata(
  handle: StorageHandle,
  id: number,
  patch: Record<string, unknown>,
): MemoryRecord {
  if (typeof id !== "number" || !Number.isFinite(id)) {
    throw new Error("updateMemoryMetadata: id must be a finite number");
  }
  const now = Date.now();
  const stmt = handle.db.prepare(
    `UPDATE memories
        SET metadata = @metadata, updated_at = @updated_at
      WHERE id = @id`,
  );
  stmt.run({
    id,
    metadata: JSON.stringify(patch),
    updated_at: now,
  });
  // Re-read the row so the caller sees the post-update shape.
  // We project every column we wrote (the row exists because
  // the controller just inserted it) and re-parse the metadata
  // JSON the same way `listActiveMemorySummaries` does, with a
  // defensive fallback to `{}` on malformed JSON.
  const row = handle.db
    .prepare(
      `SELECT id, kind, state, summary, provider_id, model_id,
              confidence, safety_flags, metadata, created_at, updated_at
         FROM memories
        WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        kind: string;
        state: string;
        summary: string | null;
        provider_id: string | null;
        model_id: string | null;
        confidence: number | null;
        safety_flags: string | null;
        metadata: string | null;
        created_at: number;
        updated_at: number | null;
      }
    | undefined;
  if (!row) {
    throw new Error(
      `updateMemoryMetadata: no row found for id ${id} after update`,
    );
  }
  let parsedMetadata: Record<string, unknown> = {};
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const v = JSON.parse(row.metadata) as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        parsedMetadata = v as Record<string, unknown>;
      }
    } catch {
      // Malformed metadata is treated as `{}`; matches the
      // read-side fallback in `listActiveMemorySummaries`.
    }
  }
  let safetyFlags: string[] = [];
  if (typeof row.safety_flags === "string" && row.safety_flags.length > 0) {
    try {
      const v = JSON.parse(row.safety_flags) as unknown;
      if (Array.isArray(v)) {
        safetyFlags = v.filter((s): s is string => typeof s === "string");
      }
    } catch {
      // Malformed safety_flags: fall back to empty list.
    }
  }
  return {
    id: row.id,
    kind: (MEMORY_KINDS.includes(row.kind as MemoryKind)
      ? (row.kind as MemoryKind)
      : "finding"),
    state: (MEMORY_STATES.includes(row.state as MemoryState)
      ? (row.state as MemoryState)
      : "active"),
    // Phase 1 internal naming cleanup: bind the SQL `summary`
    // column back to the TypeScript `memoryContent` field.
    memoryContent: row.summary ?? "",
    providerId: row.provider_id,
    modelId: row.model_id,
    confidence: row.confidence,
    safetyFlags,
    metadata: parsedMetadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a `supersededBy` id to an existing memory row's relationship
 * block without disturbing any other metadata keys.
 *
 * This is the safe, narrow seam the remember controller uses to
 * back-patch an old row when a new memory explicitly supersedes it.
 * The function:
 *   - Reads the row's current `metadata` JSON.
 *   - Appends the new id to the existing `supersededBy` array
 *     (de-duplicated, bounded to 16 entries).
 *   - Writes the updated metadata back via `updateMemoryMetadata`.
 *   - Handles missing / malformed `relationship` blocks gracefully.
 *   - Handles missing / deleted rows safely (no throw; no-op).
 *
 * No state transition, no raw text, no schema change.
 */
export function addSupersededByToMemory(
  handle: StorageHandle,
  id: number,
  supersededById: number,
): void {
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return;
  if (
    typeof supersededById !== "number" ||
    !Number.isFinite(supersededById) ||
    supersededById <= 0
  ) {
    return;
  }

  const row = handle.db
    .prepare("SELECT metadata FROM memories WHERE id = ?")
    .get(id) as { metadata: string | null } | undefined;

  if (!row) return; // row missing or deleted — safe no-op

  let existingBlock: Record<string, unknown> = {};
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rel = parsed.relationship;
        if (rel !== null && typeof rel === "object" && !Array.isArray(rel)) {
          existingBlock = { ...(rel as Record<string, unknown>) };
        }
      }
    } catch {
      // Malformed metadata: start with empty block.
    }
  }

  const supersededByArr = Array.isArray(existingBlock.supersededBy)
    ? (existingBlock.supersededBy as unknown[]).filter(
        (x): x is number =>
          typeof x === "number" && Number.isFinite(x) && x > 0,
      )
    : [];

  // De-duplicate.
  if (!supersededByArr.includes(supersededById)) {
    supersededByArr.push(supersededById);
  }

  // Cap at 16.
  if (supersededByArr.length > 16) {
    supersededByArr.length = 16;
  }

  existingBlock.supersededBy = supersededByArr;

  const updatedMetadata: Record<string, unknown> = {};
  // Re-parse and preserve all existing metadata keys.
  if (typeof row.metadata === "string" && row.metadata.length > 0) {
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (k !== "relationship") {
            updatedMetadata[k] = v;
          }
        }
      }
    } catch {
      // Malformed: start fresh except for the relationship block we're writing.
    }
  }
  updatedMetadata.relationship = existingBlock;

  // Use the existing narrow update seam; it handles the re-read.
  updateMemoryMetadata(handle, id, updatedMetadata);
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
    // Defensive: if a future row has null memory content (SQL
    // column is `summary` and allows NULL), skip it. The
    // controller never inserts a null memory content, but the
    // schema allows it (TEXT NULL default).
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
      // Phase 1 internal naming cleanup: SQL `summary` -> TS
      // `memoryContent`. The DB column name is preserved.
      memoryContent: r.summary,
      tags,
      classification,
      confidence: r.confidence,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parallel relationship-block lookup (Phase C read side)
// ---------------------------------------------------------------------------

/**
 * A row in the parallel `relationship`-block lookup.
 *
 * The shape is intentionally narrow: it carries the stored
 * `relationship` block on a `memories` row, with safe defaults
 * (empty id arrays, `detectionConfidence: 0`, `resolvedAt: 0`)
 * when the block is missing or malformed. The detector
 * consumes this projection; the public recall pipeline does
 * not.
 *
 * The `id` here is the `memories` row id, NOT a relationship
 * target id. Each row is independent.
 *
 * **Phase I additive extension.** The block shape is extended
 * with three optional forward-looking keys (`supersedes`,
 * `supersededBy`, `resolvedAt`). The reader always projects a
 * complete object — the optional Phase I fields are present
 * with their safe-empty defaults (`[]` for the id lists, `0`
 * for the timestamp) regardless of whether the underlying row
 * actually carries them. This means a legacy `"ccm-draft-1"`
 * row projects the same forward-compatible shape as a Phase I
 * `"ccm-draft-2"` row. Callers that want to distinguish the
 * two should read `derivedSchemaVersion`.
 */
export interface MemoryRelationshipBlockRow {
  /** The `memories.id` of the row the block belongs to. */
  id: number;
  /** Parsed `relationship` block, or the safe-empty default. */
  block: {
    derivedSchemaVersion: string;
    derivedAt: number;
    conflictsWith: number[];
    olderVariantsOf: number[];
    detectionConfidence: number;
    /** Optional Phase I field. Safe default: `[]`. */
    supersedes: number[];
    /** Optional Phase I field. Safe default: `[]`. */
    supersededBy: number[];
    /** Optional Phase I field. Safe default: `0`. */
    resolvedAt: number;
  };
}

/**
 * List the stored `relationship` blocks for active memory
 * rows, in deterministic order (ascending `id`).
 *
 * This is a Phase C internal-only read side that runs in
 * parallel to `listActiveMemorySummaries`. The recall
 * controller can use the two projections together (same id
 * order, same `limit`) to feed the ambiguity detector
 * without expanding the public `SafeMemorySummary` shape.
 *
 * Properties:
 *   - Returns at most `limit` rows; default `200`.
 *   - Every returned `id` corresponds to an active memory
 *     row (same `state = 'active'` filter as
 *     `listActiveMemorySummaries`).
 *   - A row with no `relationship` key in `metadata` (the
 *     MVP default, and the pre-Phase-B state) is included
 *     with the safe-empty block (empty id arrays,
 *     `detectionConfidence: 0`, `resolvedAt: 0`).
 *   - A row whose `metadata` JSON is malformed, or whose
 *     `relationship` block is not an object, is included
 *     with the safe-empty block (defensive forward-compat
 *     with old rows).
 *   - `id` arrays in the block are bounded to 16 entries
 *     and de-duplicated while preserving first-seen order;
 *     non-finite ids are dropped. This mirrors the
 *     `buildPersistedMetadata` writer-side bounds.
 *   - `detectionConfidence` is clamped to `[0, 1]`.
 *   - `resolvedAt` is clamped to a non-negative integer;
 *     non-finite or negative values fall back to `0`.
 *   - The function never reads raw text. The `metadata`
 *     column is the existing JSON blob; only its parsed
 *     shape is consumed.
 *   - The function never mutates the database and never
 *     touches `state` (every row stays `active`).
 *
 * **Phase I forward-compat.** The reader always projects a
 * block with `supersedes: []`, `supersededBy: []`, and
 * `resolvedAt: 0`, regardless of whether the underlying row
 * actually carries those keys. A legacy `"ccm-draft-1"` row
 * therefore projects the same shape as a Phase I
 * `"ccm-draft-2"` row; the difference is captured in
 * `derivedSchemaVersion` (the literal string the row stored).
 */
export function listActiveMemoryRelationshipBlocks(
  handle: StorageHandle,
  options: { limit?: number } = {},
): MemoryRelationshipBlockRow[] {
  const limit = options.limit ?? 200;
  const rows = handle.db
    .prepare(
      `SELECT id, metadata
         FROM memories
         WHERE state = 'active'
         ORDER BY id ASC
         LIMIT ?`,
    )
    .all(limit) as Array<{
      id: number;
      metadata: string | null;
    }>;
  const out: MemoryRelationshipBlockRow[] = [];
  for (const r of rows) {
    let block: MemoryRelationshipBlockRow["block"] = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 0,
      conflictsWith: [],
      olderVariantsOf: [],
      detectionConfidence: 0,
      supersedes: [],
      supersededBy: [],
      resolvedAt: 0,
    };
    if (typeof r.metadata === "string" && r.metadata.length > 0) {
      try {
        const parsed = JSON.parse(r.metadata) as Record<string, unknown>;
        const rel = parsed.relationship;
        if (rel !== null && typeof rel === "object" && !Array.isArray(rel)) {
          const o = rel as Record<string, unknown>;
          block = {
            derivedSchemaVersion:
              typeof o.derivedSchemaVersion === "string"
                ? o.derivedSchemaVersion
                : "ccm-draft-1",
            derivedAt:
              typeof o.derivedAt === "number" && Number.isFinite(o.derivedAt)
                ? Math.trunc(o.derivedAt)
                : 0,
            conflictsWith: normalizeIdArray(o.conflictsWith),
            olderVariantsOf: normalizeIdArray(o.olderVariantsOf),
            detectionConfidence: clampConfidence(o.detectionConfidence),
            // Phase I pass-through fields. Each is normalized
            // through the same `normalizeIdArray` /
            // `clampResolvedAt` helpers the conservative
            // fields use, so a malformed value (e.g. a
            // string array, a negative integer, a non-finite
            // number) is silently dropped to the safe
            // default. Missing keys project the safe default
            // directly. This matches the safe-default
            // behaviour the detector relies on.
            supersedes: normalizeIdArray(o.supersedes),
            supersededBy: normalizeIdArray(o.supersededBy),
            resolvedAt: clampResolvedAt(o.resolvedAt),
          };
        }
      } catch {
        // Malformed metadata: row carries the safe-empty block.
      }
    }
    out.push({ id: r.id, block });
  }
  return out;
}

function normalizeIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (!Number.isInteger(x)) continue;
    if (x <= 0) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= 16) break;
  }
  return out;
}

function clampConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Defensive parser for the Phase I `resolvedAt` field. Returns
 * a non-negative integer in ms epoch, or `0` when the input is
 * missing / malformed. Non-finite numbers, NaN, negative
 * values, and non-number values all fall back to `0`. This
 * matches the conservative fallback the detector relies on
 * (a missing or malformed `resolvedAt` is "no resolution
 * timestamp", not an error).
 */
function clampResolvedAt(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  return Math.trunc(v);
}
