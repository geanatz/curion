/**
 * Tests for the FTS5 sync triggers on the `memories` content table.
 *
 * The `memories_fts` virtual table is kept in sync with `memories`
 * by three triggers created in `initStorage`:
 *   - `memories_ai` (AFTER INSERT)
 *   - `memories_au` (AFTER UPDATE)
 *   - `memories_ad` (AFTER DELETE)
 *
 * Plus a one-shot `INSERT OR IGNORE ... SELECT FROM memories`
 * backfill on every startup, which is a no-op once the FTS5
 * table is fully populated and indexes any pre-existing rows
 * from older DBs that were written before the triggers existed.
 *
 * Coverage:
 *   1. Inserting a memory populates `memories_fts` (the new row
 *      is searchable via a `MATCH` query).
 *   2. Updating a memory's `summary` updates the corresponding
 *      `memories_fts` row (old term gone, new term present).
 *   3. Deleting a memory removes the corresponding `memories_fts`
 *      row.
 *   4. The three triggers `memories_ai` / `memories_au` /
 *      `memories_ad` exist on a freshly initialized DB, and the
 *      one-shot backfill on startup indexes pre-existing rows
 *      that were inserted directly (without going through the
 *      triggers).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initStorage,
  closeStorage,
  insertMemoryRecord,
  type StorageHandle,
} from "../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-fts5-sync-"));
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

/**
 * Count the rows in `memories_fts` for a given `memory_id`. Uses
 * the FTS5-internal `rowid`, which is set explicitly by the
 * triggers to match `memories.rowid`, so this is a stable lookup.
 */
function ftsRowCount(
  handle: StorageHandle,
  memoryId: number,
): number {
  const row = handle.db
    .prepare(
      `SELECT COUNT(*) AS c FROM memories_fts WHERE memory_id = ?`,
    )
    .get(memoryId) as { c: number };
  return row.c;
}

function ftsTerms(
  handle: StorageHandle,
  memoryId: number,
): string | null {
  const row = handle.db
    .prepare(
      `SELECT terms FROM memories_fts WHERE memory_id = ?`,
    )
    .get(memoryId) as { terms: string | null } | undefined;
  return row?.terms ?? null;
}

// ---------------------------------------------------------------------------
// 1. INSERT trigger
// ---------------------------------------------------------------------------

test("FTS5 sync: INSERT trigger populates memories_fts with the summary", () => {
  const { tmp, handle } = mkStorage();
  try {
    // Use a distinctive word in the summary so we can verify the
    // FTS5 tokenizer indexed it correctly.
    const record = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      summary: "The libpurple protocols are upstreamed into the libgnt fork.",
      providerId: null,
      modelId: null,
      confidence: null,
      safetyFlags: [],
      metadata: {},
    });

    // The trigger must have inserted exactly one row keyed to
    // this memory's `rowid` (== `id` for AUTOINCREMENT).
    assert.equal(ftsRowCount(handle, record.id), 1);

    // The `terms` column must contain the summary text verbatim
    // (FTS5 stores the original text in `terms`; the index is a
    // separate internal structure).
    assert.equal(
      ftsTerms(handle, record.id),
      "The libpurple protocols are upstreamed into the libgnt fork.",
    );

    // A FTS5 MATCH query against a distinctive token from the
    // summary must return the row.
    const match = handle.db
      .prepare(
        `SELECT memory_id FROM memories_fts
          WHERE memories_fts MATCH ?
          ORDER BY rowid ASC`,
      )
      .all(`"libpurple"`) as Array<{ memory_id: number }>;
    assert.equal(match.length, 1);
    assert.equal(match[0]?.memory_id, record.id);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 2. UPDATE trigger
// ---------------------------------------------------------------------------

test("FTS5 sync: UPDATE trigger refreshes memories_fts when summary changes", () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert with a distinctive original word.
    const record = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      summary: "The ouroboros protocol loops indefinitely without external input.",
      providerId: null,
      modelId: null,
      confidence: null,
      safetyFlags: [],
      metadata: {},
    });

    // Sanity: original word is indexed.
    const beforeMatch = handle.db
      .prepare(
        `SELECT memory_id FROM memories_fts
          WHERE memories_fts MATCH ?`,
      )
      .all(`"ouroboros"`) as Array<{ memory_id: number }>;
    assert.equal(beforeMatch.length, 1);
    assert.equal(beforeMatch[0]?.memory_id, record.id);

    // Update the summary via a direct SQL UPDATE so the trigger
    // fires (the public `updateMemoryMetadata` helper only
    // touches the `metadata` column; a summary update goes
    // through raw SQL).
    const now = Date.now();
    handle.db
      .prepare(
        `UPDATE memories
            SET summary = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        "The phoenix protocol reboots itself on a daily cycle.",
        now,
        record.id,
      );

    // The old word must no longer match.
    const afterOldMatch = handle.db
      .prepare(
        `SELECT memory_id FROM memories_fts
          WHERE memories_fts MATCH ?`,
      )
      .all(`"ouroboros"`) as Array<{ memory_id: number }>;
    assert.equal(
      afterOldMatch.length,
      0,
      "old summary term must be removed from the FTS5 index",
    );

    // The new word must now match.
    const afterNewMatch = handle.db
      .prepare(
        `SELECT memory_id FROM memories_fts
          WHERE memories_fts MATCH ?`,
      )
      .all(`"phoenix"`) as Array<{ memory_id: number }>;
    assert.equal(afterNewMatch.length, 1);
    assert.equal(afterNewMatch[0]?.memory_id, record.id);

    // The `terms` column must reflect the new summary verbatim.
    assert.equal(
      ftsTerms(handle, record.id),
      "The phoenix protocol reboots itself on a daily cycle.",
    );

    // No duplicate rows for the same memory_id.
    assert.equal(ftsRowCount(handle, record.id), 1);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. DELETE trigger
// ---------------------------------------------------------------------------

test("FTS5 sync: DELETE trigger removes the corresponding memories_fts row", () => {
  const { tmp, handle } = mkStorage();
  try {
    const record = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      summary: "The zephyr-7b model fits on a single consumer GPU at int4.",
      providerId: null,
      modelId: null,
      confidence: null,
      safetyFlags: [],
      metadata: {},
    });

    // Sanity: the row is indexed.
    assert.equal(ftsRowCount(handle, record.id), 1);

    // Delete the row directly (the public repo has no delete
    // helper, so we use raw SQL — exactly what the trigger is
    // designed to fire on).
    handle.db.prepare(`DELETE FROM memories WHERE id = ?`).run(record.id);

    // The FTS5 row must be gone.
    assert.equal(ftsRowCount(handle, record.id), 0);

    // A MATCH query must no longer find the deleted term.
    const match = handle.db
      .prepare(
        `SELECT memory_id FROM memories_fts
          WHERE memories_fts MATCH ?`,
      )
      .all(`"zephyr-7b"`) as Array<{ memory_id: number }>;
    assert.equal(match.length, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Trigger presence + one-shot backfill on startup
// ---------------------------------------------------------------------------

test("FTS5 sync: initStorage creates the three sync triggers and backfills pre-existing rows", () => {
  const { tmp, handle } = mkStorage();
  try {
    // The three triggers must exist on a freshly initialized DB.
    const triggerRows = handle.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_au', 'memories_ad')
          ORDER BY name ASC`,
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      triggerRows.map((r) => r.name),
      ["memories_ad", "memories_ai", "memories_au"],
      "all three sync triggers must be present after initStorage",
    );

    // The one-shot backfill on startup must index pre-existing
    // rows. The freshly-initialized DB above had 0 rows at
    // trigger-creation time, so to simulate the "pre-existing
    // row" scenario we close this handle, drop the triggers on
    // a fresh handle, insert a row directly, close it, and
    // re-open via `initStorage` (which re-runs the migration
    // including the backfill on the existing content). This
    // proves the backfill path is wired up.
    closeStorage(handle);
    {
      const probeHandle = initStorage({ projectRoot: tmp });
      try {
        // Drop the triggers and insert a row directly so the
        // FTS5 row is NOT created by the trigger. This
        // simulates a row that was written before the triggers
        // existed (e.g. an older DB).
        probeHandle.db.exec("DROP TRIGGER memories_ai");
        probeHandle.db.exec("DROP TRIGGER memories_au");
        probeHandle.db.exec("DROP TRIGGER memories_ad");
        probeHandle.db
          .prepare(
            `INSERT INTO memories (kind, created_at, updated_at, summary, state)
                    VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "fact",
            Date.now(),
            Date.now(),
            "The cinnabar fruit only ripens under a gibbous moon.",
            "active",
          );
        // Without the triggers and without the rebuild, the
        // FTS5 table is empty.
        const ftsCount = probeHandle.db
          .prepare(`SELECT COUNT(*) AS c FROM memories_fts`)
          .get() as { c: number };
        assert.equal(ftsCount.c, 0);
      } finally {
        closeStorage(probeHandle);
      }
    }
    // Re-open the DB. `initStorage` is idempotent on the
    // `CREATE TABLE / CREATE TRIGGER IF NOT EXISTS` clauses,
    // and runs the `INSERT OR IGNORE ... SELECT` backfill at
    // the end. The row that was inserted with the triggers
    // dropped must now be in `memories_fts`.
    const reopened = initStorage({ projectRoot: tmp });
    try {
      const ftsCount = reopened.db
        .prepare(`SELECT COUNT(*) AS c FROM memories_fts`)
        .get() as { c: number };
      assert.equal(
        ftsCount.c,
        1,
        "the one-shot backfill on startup must index pre-existing rows",
      );
      const match = reopened.db
        .prepare(
          `SELECT memory_id FROM memories_fts
            WHERE memories_fts MATCH ?`,
        )
        .all(`"cinnabar"`) as Array<{ memory_id: number }>;
      assert.equal(match.length, 1);
    } finally {
      closeStorage(reopened);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
