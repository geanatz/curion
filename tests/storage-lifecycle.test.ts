/**
 * Tests for the lifecycle foundation: the additive
 * `memory_transitions` audit table and the internal
 * `transitionMemoryState` / `listMemoryTransitions` API.
 *
 * Phase 1+2 scope: no automatic lifecycle transitions are wired
 * yet (supersession / invalidation / reactivation are out of
 * scope). These tests pin:
 *
 *   1.  Schema creation
 *         - The `memory_transitions` table exists on a fresh DB
 *           after `initStorage`.
 *         - Both indexes (`memory_id`, `created_at`) exist.
 *         - Re-running `initStorage` on an existing DB does not
 *           duplicate the table or indexes and does not lose
 *           existing data (additive + idempotent migration).
 *
 *   2.  Successful transition
 *         - `transitionMemoryState` updates `memories.state` to
 *           the target state.
 *         - It writes exactly one coherent audit row.
 *         - The audit row captures every required field
 *           (memoryId, fromState, toState, reason,
 *           triggeringMemoryId, confidence, actor, metadata,
 *           createdAt).
 *         - `updated_at` is bumped on the memory row.
 *         - Multiple transitions stack as ordered history rows.
 *
 *   3.  Invalid input handling
 *         - Unknown memory id → throws, no audit row.
 *         - Unknown target state → throws.
 *         - Disallowed transition (e.g. `active → active`,
 *           `superseded → active` is allowed but
 *           `active → active` is not) → throws, no state change,
 *           no audit row.
 *         - Negative / non-integer / non-finite memoryId → throws.
 *         - Out-of-range confidence → throws.
 *         - Non-positive triggeringMemoryId → throws.
 *         - Empty / too-long reason → throws.
 *         - Non-string actor → throws.
 *
 *   4.  Recall behaviour is unchanged
 *         - `listActiveMemorySummaries`,
 *           `listActiveMemorySummariesByFts5`, and
 *           `listActiveMemoryRelationshipBlocks` continue to
 *           filter strictly on `state = 'active'`.
 *         - A memory whose state is `superseded` or `invalidated`
 *           is hidden from recall even though the row is still on
 *           disk.
 *         - `insertMemoryRecord` still writes `state = 'active'`
 *           and the existing public behaviour is preserved.
 *
 *   5.  Round-trip: `listMemoryTransitions` returns history in
 *       chronological order with all fields.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  MEMORY_STATES,
  MEMORY_TRANSITIONS,
  type MemoryState,
  type MemoryTransitionInput,
  type MemoryTransitionRecord,
  type StorageHandle,
  closeStorage,
  initStorage,
  insertMemoryRecord,
  listActiveMemoryRelationshipBlocks,
  listActiveMemorySummaries,
  listActiveMemorySummariesByFts5,
  listMemoryTransitions,
  transitionMemoryState,
} from "../src/storage/storage.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a memory through the public repo seam and return its id.
 * Kept here so the tests are self-contained — the FTS5-sync tests
 * use a similar helper inline; we follow the same pattern.
 */
function insertMemory(
  handle: StorageHandle,
  opts: { memoryContent: string; state?: MemoryState; kind?: string } = {
    memoryContent: "default",
  }
): number {
  const rec = insertMemoryRecord(handle, {
    kind: (opts.kind as "fact") ?? "fact",
    state: opts.state ?? "active",
    memoryContent: opts.memoryContent,
    providerId: null,
    modelId: null,
    confidence: null,
    metadata: {},
  });
  return rec.id;
}

/**
 * Read a single memory row's `state` directly from the DB.
 * Avoids re-parsing the full record.
 */
function readState(handle: StorageHandle, id: number): string | null {
  const row = handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(id) as
    | { state: string }
    | undefined;
  return row?.state ?? null;
}

/**
 * Count audit rows for a given memory id directly from the DB.
 */
function countAuditRows(handle: StorageHandle, memoryId: number): number {
  const row = handle.db
    .prepare("SELECT COUNT(*) AS c FROM memory_transitions WHERE memory_id = ?")
    .get(memoryId) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// 1. Schema creation
// ---------------------------------------------------------------------------

test("lifecycle: initStorage creates the memory_transitions table and its indexes on a fresh DB", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    // The table must exist.
    const tableRow = handle.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_transitions'`
      )
      .get() as { name: string } | undefined;
    assert.ok(tableRow, "memory_transitions table must exist after initStorage");

    // The required columns must be present with the expected types / nullability.
    const cols = handle.db.prepare(`PRAGMA table_info(memory_transitions)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const [name, type, notnull] of [
      ["memory_id", "INTEGER", 1],
      ["from_state", "TEXT", 1],
      ["to_state", "TEXT", 1],
      ["reason", "TEXT", 1],
      ["triggering_memory_id", "INTEGER", 0],
      ["confidence", "REAL", 0],
      ["actor", "TEXT", 1],
      ["metadata", "TEXT", 0],
      ["created_at", "INTEGER", 1],
    ] as const) {
      const c = byName.get(name);
      assert.ok(c, `column ${name} must exist on memory_transitions`);
      assert.equal(c.type, type, `column ${name} must be ${type}`);
      assert.equal(c.notnull, notnull, `column ${name} NOT NULL must be ${notnull}`);
    }
    // `id` is autoincrement — assert by name only (the type field
    // for an INTEGER PRIMARY KEY AUTOINCREMENT is reported as
    // 'INTEGER' and notnull=1 in PRAGMA output).
    assert.ok(byName.get("id"), "id column must exist on memory_transitions");

    // The two indexes must exist.
    const indexRows = handle.db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'memory_transitions'
            AND name IN ('idx_memory_transitions_memory_id', 'idx_memory_transitions_created_at')
          ORDER BY name ASC`
      )
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      indexRows.map((r) => r.name),
      ["idx_memory_transitions_created_at", "idx_memory_transitions_memory_id"],
      "both audit indexes must be present after initStorage"
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: re-running initStorage on an existing DB is additive and idempotent (no data loss)", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    // Insert a memory and write one audit row directly so we have
    // baseline data we can verify survives a second initStorage.
    const id = insertMemory(handle, {
      memoryContent: "The ouroboros protocol is self-stabilizing.",
    });
    const audit = transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "supersession",
      triggeringMemoryId: 9999, // synthetic; the row exists for this test only
      confidence: 0.7,
      actor: "test",
      metadata: { note: "first transition" },
    });
    assert.equal(audit.id > 0, true);

    // Re-open the DB via a second initStorage call. The migration
    // must be additive: no destructive operation, no data loss.
    closeStorage(handle);
    const reopened = initStorage({ projectRoot: tmp });
    try {
      // The memory row survives.
      assert.equal(readState(reopened, id), "superseded");
      // The audit row survives with all fields intact.
      const rows = reopened.db
        .prepare(
          `SELECT id, memory_id, from_state, to_state, reason,
                  triggering_memory_id, confidence, actor, metadata, created_at
             FROM memory_transitions
            WHERE memory_id = ?
            ORDER BY id ASC`
        )
        .all(id) as Array<{
        id: number;
        memory_id: number;
        from_state: string;
        to_state: string;
        reason: string;
        triggering_memory_id: number | null;
        confidence: number | null;
        actor: string;
        metadata: string | null;
        created_at: number;
      }>;
      assert.equal(rows.length, 1);
      const r = rows[0] as (typeof rows)[number];
      assert.equal(r.memory_id, id);
      assert.equal(r.from_state, "active");
      assert.equal(r.to_state, "superseded");
      assert.equal(r.reason, "supersession");
      assert.equal(r.triggering_memory_id, 9999);
      assert.equal(r.confidence, 0.7);
      assert.equal(r.actor, "test");
      assert.equal(r.metadata, JSON.stringify({ note: "first transition" }));

      // Re-init did NOT duplicate the table. `CREATE TABLE IF NOT
      // EXISTS` is a no-op when the table is already there.
      const tableCount = reopened.db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master
            WHERE type = 'table' AND name = 'memory_transitions'`
        )
        .get() as { c: number };
      assert.equal(tableCount.c, 1, "memory_transitions must not be duplicated");

      // Re-init did NOT duplicate the indexes.
      const indexCount = reopened.db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'memory_transitions'`
        )
        .get() as { c: number };
      assert.equal(indexCount.c, 2, "the two audit indexes must not be duplicated");
    } finally {
      closeStorage(reopened);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Successful transition
// ---------------------------------------------------------------------------

test("lifecycle: transitionMemoryState updates memories.state and writes exactly one audit row", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, {
      memoryContent: "The phoenix protocol reboots itself on a daily cycle.",
    });
    assert.equal(readState(handle, id), "active");
    assert.equal(countAuditRows(handle, id), 0);

    const now = Date.now();
    const audit = transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "supersession",
      triggeringMemoryId: 42,
      confidence: 0.85,
      actor: "supersession-controller",
      metadata: { detectionConfidence: 0.92, edge: "newer" },
    });

    // The audit row's identity fields.
    assert.equal(audit.id > 0, true);
    assert.equal(audit.memoryId, id);
    assert.equal(audit.fromState, "active");
    assert.equal(audit.toState, "superseded");
    assert.equal(audit.reason, "supersession");
    assert.equal(audit.triggeringMemoryId, 42);
    assert.equal(audit.confidence, 0.85);
    assert.equal(audit.actor, "supersession-controller");
    assert.deepEqual(audit.metadata, { detectionConfidence: 0.92, edge: "newer" });
    assert.equal(audit.createdAt >= now, true);

    // The memory's state is updated.
    assert.equal(readState(handle, id), "superseded");

    // Exactly ONE audit row exists for this memory.
    assert.equal(countAuditRows(handle, id), 1);

    // The audit row is queryable from the DB and matches.
    const rows = handle.db
      .prepare(
        `SELECT memory_id, from_state, to_state, reason,
                triggering_memory_id, confidence, actor, metadata, created_at
           FROM memory_transitions
          WHERE id = ?`
      )
      .all(audit.id) as Array<{
      memory_id: number;
      from_state: string;
      to_state: string;
      reason: string;
      triggering_memory_id: number | null;
      confidence: number | null;
      actor: string;
      metadata: string | null;
      created_at: number;
    }>;
    assert.equal(rows.length, 1);
    const r = rows[0] as (typeof rows)[number];
    assert.equal(r.memory_id, id);
    assert.equal(r.from_state, "active");
    assert.equal(r.to_state, "superseded");
    assert.equal(r.reason, "supersession");
    assert.equal(r.triggering_memory_id, 42);
    assert.equal(r.confidence, 0.85);
    assert.equal(r.actor, "supersession-controller");
    assert.equal(r.metadata, JSON.stringify({ detectionConfidence: 0.92, edge: "newer" }));
    assert.equal(r.created_at, audit.createdAt);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState bumps memories.updated_at", async () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const before = Date.now();
    const id = insertMemory(handle, {
      memoryContent: "The cinnabar fruit only ripens under a gibbous moon.",
    });
    const initial = handle.db.prepare("SELECT updated_at FROM memories WHERE id = ?").get(id) as {
      updated_at: number;
    };
    // Small pause to keep `now` strictly greater than the
    // initial updated_at (Date.now resolution is ms).
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    transitionMemoryState(handle, {
      memoryId: id,
      toState: "invalidated",
      reason: "invalidation",
    });
    const after = handle.db.prepare("SELECT updated_at FROM memories WHERE id = ?").get(id) as {
      updated_at: number;
    };
    assert.ok(
      after.updated_at > initial.updated_at,
      `updated_at must advance: was ${initial.updated_at}, now ${after.updated_at}`
    );
    assert.ok(after.updated_at >= before, "updated_at must be at or after the call wallclock");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: multiple transitions stack as ordered history rows", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, {
      memoryContent: "The zephyr-7b model fits on a single consumer GPU at int4.",
    });
    // Walk: active → superseded → invalidated → active.
    const t1 = transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "supersession",
    });
    const t2 = transitionMemoryState(handle, {
      memoryId: id,
      toState: "invalidated",
      reason: "admin",
    });
    const t3 = transitionMemoryState(handle, {
      memoryId: id,
      toState: "active",
      reason: "manual_reactivation",
    });

    assert.equal(readState(handle, id), "active");
    assert.equal(countAuditRows(handle, id), 3);
    assert.ok(t1.id < t2.id && t2.id < t3.id, "audit ids must be monotonically increasing");

    // listMemoryTransitions returns the full history in order.
    const history = listMemoryTransitions(handle, id);
    assert.equal(history.length, 3);
    assert.equal(history[0]?.fromState, "active");
    assert.equal(history[0]?.toState, "superseded");
    assert.equal(history[1]?.fromState, "superseded");
    assert.equal(history[1]?.toState, "invalidated");
    assert.equal(history[2]?.fromState, "invalidated");
    assert.equal(history[2]?.toState, "active");
    for (const row of history) {
      assert.equal(row.memoryId, id);
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState defaults actor to 'internal' and stores it on the audit row", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, {
      memoryContent: "The libpurple protocols are upstreamed into the libgnt fork.",
    });
    const audit = transitionMemoryState(handle, {
      memoryId: id,
      toState: "invalidated",
      reason: "invalidation",
    });
    assert.equal(audit.actor, "internal");
    const row = handle.db
      .prepare("SELECT actor FROM memory_transitions WHERE id = ?")
      .get(audit.id) as { actor: string };
    assert.equal(row.actor, "internal");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: MEMORY_TRANSITIONS matrix covers the explicit foundation transitions", () => {
  // The matrix is exported; pin its expected shape so a future
  // silent change to the allowed transition set is caught here.
  const expected = [
    "active→superseded",
    "active→invalidated",
    "superseded→invalidated",
    "superseded→active",
    "invalidated→active",
    "invalidated→superseded",
  ];
  for (const k of expected) {
    assert.ok(MEMORY_TRANSITIONS.has(k), `matrix must allow ${k}`);
  }
  // And self-transitions are explicitly NOT in the matrix.
  assert.ok(!MEMORY_TRANSITIONS.has("active→active"), "active→active must be rejected");
  assert.ok(!MEMORY_TRANSITIONS.has("superseded→superseded"));
  assert.ok(!MEMORY_TRANSITIONS.has("invalidated→invalidated"));
  // MEMORY_STATES remains the source of truth.
  assert.deepEqual([...MEMORY_STATES], ["active", "superseded", "invalidated"]);
});

// ---------------------------------------------------------------------------
// 3. Invalid input handling
// ---------------------------------------------------------------------------

test("lifecycle: transitionMemoryState throws and writes NO audit row when the memory id is unknown", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    // Pre-condition: no audit rows at all.
    const total = handle.db.prepare("SELECT COUNT(*) AS c FROM memory_transitions").get() as {
      c: number;
    };
    assert.equal(total.c, 0);

    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: 999_999,
          toState: "superseded",
          reason: "supersession",
        }),
      /no memory row found/i
    );

    // The transaction must have rolled back: still zero audit rows.
    const after = handle.db.prepare("SELECT COUNT(*) AS c FROM memory_transitions").get() as {
      c: number;
    };
    assert.equal(after.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on disallowed transitions (self-transition is rejected)", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "active row" });
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          toState: "active",
          reason: "noop",
        }),
      /transition .* is not allowed/
    );
    // State must be unchanged.
    assert.equal(readState(handle, id), "active");
    // No audit row written.
    assert.equal(countAuditRows(handle, id), 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on unknown target state values", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          // `unknown` is not in MEMORY_STATES; the input validator must catch it.
          toState: "unknown" as unknown as MemoryState,
          reason: "test",
        }),
      /toState must be one of/
    );
    assert.equal(readState(handle, id), "active");
    assert.equal(countAuditRows(handle, id), 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws and writes NO audit row on bad memoryId input", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const badInputs: Array<MemoryTransitionInput> = [
      { memoryId: 0, toState: "superseded", reason: "x" },
      { memoryId: -1, toState: "superseded", reason: "x" },
      { memoryId: 1.5, toState: "superseded", reason: "x" },
      { memoryId: Number.NaN, toState: "superseded", reason: "x" },
      { memoryId: Number.POSITIVE_INFINITY, toState: "superseded", reason: "x" },
    ];
    for (const input of badInputs) {
      assert.throws(
        () => transitionMemoryState(handle, input),
        /memoryId must be a positive integer/
      );
    }
    const total = handle.db.prepare("SELECT COUNT(*) AS c FROM memory_transitions").get() as {
      c: number;
    };
    assert.equal(total.c, 0, "no audit row must be written for any invalid memoryId");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on out-of-range confidence", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          transitionMemoryState(handle, {
            memoryId: id,
            toState: "superseded",
            reason: "test",
            confidence: bad,
          }),
        /confidence must be a number in \[0, 1\] or null/
      );
    }
    // Confidence in [0, 1] inclusive is accepted.
    for (const ok of [0, 0.5, 1]) {
      // Each accepted call must succeed; the first transitions
      // active→superseded and the others fail the matrix check
      // (superseded→superseded). Use a fresh row for each.
      const localId = insertMemory(handle, { memoryContent: `conf-${ok}` });
      transitionMemoryState(handle, {
        memoryId: localId,
        toState: "superseded",
        reason: "test",
        confidence: ok,
      });
      assert.equal(readState(handle, localId), "superseded");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on bad triggeringMemoryId", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          transitionMemoryState(handle, {
            memoryId: id,
            toState: "superseded",
            reason: "test",
            triggeringMemoryId: bad,
          }),
        /triggeringMemoryId must be a positive integer or null/
      );
    }
    // null and undefined are accepted (null is the "no triggering
    // memory" sentinel).
    transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "test",
      triggeringMemoryId: null,
    });
    assert.equal(readState(handle, id), "superseded");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on empty / too-long reason", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          toState: "superseded",
          reason: "",
        }),
      /reason must be a non-empty string/
    );
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          toState: "superseded",
          reason: "x".repeat(257),
        }),
      /reason must be at most 256 characters/
    );
    // Sanity: a non-empty, short reason is accepted.
    transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "ok",
    });
    assert.equal(readState(handle, id), "superseded");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: transitionMemoryState throws on non-string / empty actor", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          toState: "superseded",
          reason: "test",
          // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for the validator
          actor: 42 as any,
        }),
      /actor must be a non-empty string/
    );
    assert.throws(
      () =>
        transitionMemoryState(handle, {
          memoryId: id,
          toState: "superseded",
          reason: "test",
          actor: "",
        }),
      /actor must be a non-empty string/
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: listMemoryTransitions returns [] for unknown memory id and is read-only", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    // Unknown memory id → empty.
    const empty = listMemoryTransitions(handle, 424242);
    assert.deepEqual(empty, []);
    // Bad memory id inputs → empty (no throw).
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.deepEqual(listMemoryTransitions(handle, bad), []);
    }
    // Read-only: confirm no audit row got created by the call.
    const total = handle.db.prepare("SELECT COUNT(*) AS c FROM memory_transitions").get() as {
      c: number;
    };
    assert.equal(total.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Recall behaviour is unchanged
// ---------------------------------------------------------------------------

test("lifecycle: existing active recall filters still hide superseded and invalidated rows", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    // Three rows in three different states.
    const idActive = insertMemory(handle, {
      memoryContent: "The ouroboros protocol is self-stabilizing under load.",
      kind: "fact",
    });
    const idSuperseded = insertMemory(handle, {
      memoryContent: "The phoenix protocol reboots itself on a daily cycle.",
      kind: "fact",
    });
    const idInvalidated = insertMemory(handle, {
      memoryContent: "The cinnabar fruit only ripens under a gibbous moon.",
      kind: "fact",
    });

    transitionMemoryState(handle, {
      memoryId: idSuperseded,
      toState: "superseded",
      reason: "supersession",
    });
    transitionMemoryState(handle, {
      memoryId: idInvalidated,
      toState: "invalidated",
      reason: "invalidation",
    });

    // listActiveMemorySummaries: only the active row.
    const summaries = listActiveMemorySummaries(handle, { limit: 50 });
    const summaryIds = summaries.map((s) => s.id);
    assert.ok(summaryIds.includes(idActive), "active row must remain in recall");
    assert.ok(!summaryIds.includes(idSuperseded), "superseded row must be hidden from recall");
    assert.ok(!summaryIds.includes(idInvalidated), "invalidated row must be hidden from recall");
    // The `state` projection on the active row is `active`.
    const activeSummary = summaries.find((s) => s.id === idActive);
    assert.equal(activeSummary?.state, "active");

    // listActiveMemorySummariesByFts5: same filter. Use a query
    // that hits each row's distinctive term with implicit OR
    // (FTS5's default for unquoted multi-word queries is implicit
    // AND, which would not match any single row containing all
    // three rare terms; explicit OR mirrors recall usage).
    const ftsMatches = listActiveMemorySummariesByFts5(handle, "ouroboros OR phoenix OR cinnabar", {
      limit: 50,
    });
    const ftsIds = ftsMatches.map((m) => m.id);
    assert.ok(ftsIds.includes(idActive));
    assert.ok(!ftsIds.includes(idSuperseded));
    assert.ok(!ftsIds.includes(idInvalidated));

    // listActiveMemoryRelationshipBlocks: same filter.
    const blocks = listActiveMemoryRelationshipBlocks(handle, { limit: 50 });
    const blockIds = blocks.map((b) => b.id);
    assert.ok(blockIds.includes(idActive));
    assert.ok(!blockIds.includes(idSuperseded));
    assert.ok(!blockIds.includes(idInvalidated));

    // Sanity: the non-active rows are still on disk (no destructive
    // operation was performed).
    assert.equal(readState(handle, idSuperseded), "superseded");
    assert.equal(readState(handle, idInvalidated), "invalidated");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: insertMemoryRecord still writes state='active' (public behavior unchanged)", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const rec = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The libpurple protocols are upstreamed into the libgnt fork.",
      providerId: null,
      modelId: null,
      confidence: null,
      metadata: {},
    });
    assert.equal(rec.state, "active");
    assert.equal(readState(handle, rec.id), "active");
    // No audit row is created by an insert — the lifecycle
    // foundation is write-on-transition, not write-on-insert.
    assert.equal(countAuditRows(handle, rec.id), 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. listMemoryTransitions round-trip
// ---------------------------------------------------------------------------

test("lifecycle: listMemoryTransitions returns the full history with all fields parsed", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, {
      memoryContent: "The zephyr-7b model fits on a single consumer GPU at int4.",
    });
    const otherId = insertMemory(handle, {
      memoryContent: "Some unrelated row.",
    });

    // Two transitions on the target row, plus one transition on the
    // unrelated row to confirm scoping by memory_id.
    const t1 = transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "supersession",
      triggeringMemoryId: otherId,
      confidence: 0.6,
      actor: "detector-a",
      metadata: { detail: "first" },
    });
    const t2 = transitionMemoryState(handle, {
      memoryId: id,
      toState: "invalidated",
      reason: "invalidation",
      confidence: 0.95,
      actor: "detector-b",
      metadata: { detail: "second" },
    });
    transitionMemoryState(handle, {
      memoryId: otherId,
      toState: "superseded",
      reason: "supersession",
    });

    const history = listMemoryTransitions(handle, id);
    assert.equal(history.length, 2);

    // The first transition.
    const r1 = history[0] as MemoryTransitionRecord;
    assert.equal(r1.id, t1.id);
    assert.equal(r1.memoryId, id);
    assert.equal(r1.fromState, "active");
    assert.equal(r1.toState, "superseded");
    assert.equal(r1.reason, "supersession");
    assert.equal(r1.triggeringMemoryId, otherId);
    assert.equal(r1.confidence, 0.6);
    assert.equal(r1.actor, "detector-a");
    assert.deepEqual(r1.metadata, { detail: "first" });

    // The second transition.
    const r2 = history[1] as MemoryTransitionRecord;
    assert.equal(r2.id, t2.id);
    assert.equal(r2.memoryId, id);
    assert.equal(r2.fromState, "superseded");
    assert.equal(r2.toState, "invalidated");
    assert.equal(r2.reason, "invalidation");
    assert.equal(r2.triggeringMemoryId, null);
    assert.equal(r2.confidence, 0.95);
    assert.equal(r2.actor, "detector-b");
    assert.deepEqual(r2.metadata, { detail: "second" });

    // The unrelated row's history is scoped to its own memory_id.
    const otherHistory = listMemoryTransitions(handle, otherId);
    assert.equal(otherHistory.length, 1);
    assert.equal(otherHistory[0]?.memoryId, otherId);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("lifecycle: listMemoryTransitions returns [] when audit metadata is malformed but row exists", () => {
  const { tmp, handle } = mkStorage("curion-lifecycle-");
  try {
    const id = insertMemory(handle, { memoryContent: "test row" });
    // Write a transition normally so we have a valid row, then
    // corrupt the metadata blob on the audit row to simulate a
    // disk-level corruption.
    const audit = transitionMemoryState(handle, {
      memoryId: id,
      toState: "superseded",
      reason: "supersession",
      metadata: { ok: true },
    });
    handle.db
      .prepare("UPDATE memory_transitions SET metadata = ? WHERE id = ?")
      .run("this is not json", audit.id);

    // The reader must not throw; it falls back to {} for the
    // metadata field.
    const history = listMemoryTransitions(handle, id);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]?.metadata, {});
    // Other fields are still projected correctly.
    assert.equal(history[0]?.reason, "supersession");
    assert.equal(history[0]?.fromState, "active");
    assert.equal(history[0]?.toState, "superseded");
  } finally {
    rmStorage(tmp, handle);
  }
});
