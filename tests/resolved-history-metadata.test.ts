/**
 * Phase I tests — internal metadata compatibility step.
 *
 * Scope: the internal-only schema bump from `"ccm-draft-1"`
 * to `"ccm-draft-2"` and the write-side pass-through of the
 * three new optional forward-looking keys
 * (`supersedes`, `supersededBy`, `resolvedAt`) on the
 * `relationship` block. This is a **metadata compatibility
 * step only** — no public behavior change, no recall
 * controller wiring, no resolved-history note, no state
 * transition, no storage schema migration (the keys live
 * inside the existing `metadata` JSON blob), no raw text,
 * no remember/recall API signature change. The detector
 * remains pure / unwired.
 *
 * Properties verified (per Orchestrator's approved scope):
 *
 *   1. New writes use `"ccm-draft-2"` (the new
 *      `DERIVED_SCHEMA_VERSION` literal). The legacy
 *      `"ccm-draft-1"` literal is preserved as
 *      `LEGACY_DERIVED_SCHEMA_VERSION` for compatibility
 *      tests.
 *   2. `buildPersistedMetadata` preserves / copies
 *      `supersedes` / `supersededBy` / `resolvedAt` when
 *      the caller supplies them (pass-through). The
 *      detector does NOT derive them.
 *   3. Existing metadata keys are preserved verbatim. A
 *      pre-existing `relationship` block is NOT
 *      overwritten.
 *   4. The read-side projection in
 *      `listActiveMemoryRelationshipBlocks` round-trips
 *      the new fields. A legacy `"ccm-draft-1"` row
 *      projects safe defaults (`[]` arrays, `0`
 *      timestamp).
 *   5. Missing / malformed metadata returns safe
 *      defaults and does not throw.
 *   6. The public `recall` output does NOT expose any
 *      of the new tokens
 *      (`derivedSchemaVersion`, `ccm-draft-1`,
 *      `ccm-draft-2`, `supersedes`, `supersededBy`,
 *      `resolvedAt`).
 *   7. The recall controller does NOT emit a
 *      `resolved-history` signal. The detector remains
 *      pure and unwired.
 *
 * Negative constraints also pinned:
 *   - The detector does not import benchmark experiment
 *     modules.
 *   - `hasMeaningfulRelationshipData` does not consider
 *     the Phase I pass-through fields when deciding
 *     whether the derived block is "meaningful" (the
 *     conservative detector fields remain the gate).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import {
  buildPersistedMetadata,
  hasMeaningfulRelationshipData,
  deriveRelationshipMetadata,
  DERIVED_SCHEMA_VERSION,
  LEGACY_DERIVED_SCHEMA_VERSION,
  type RelationshipMetadataFields,
} from "../src/retrieval/relationship.ts";
import {
  initStorage,
  closeStorage,
  listActiveMemoryRelationshipBlocks,
  type StorageHandle,
  type MemoryRelationshipBlockRow,
} from "../src/storage/storage.ts";
import { runRememberController } from "../src/controller/remember-controller.ts";
import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
} from "../src/tools/recall.ts";
import {
  setRelatedMemoriesImpl,
  resetRelatedMemoriesImpl,
} from "../src/retrieval/seam.ts";
import type { SafeMemorySummary } from "../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-mcp-pi-"));
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

function scriptFetch(responder: () => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return responder();
  };
  return { fetchImpl, calls };
}

function okChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function safeAnalysis(opts: {
  summary?: string;
  confidence?: number;
  classification?: string;
  tags?: string[];
} = {}): string {
  return JSON.stringify({
    summary: opts.summary ?? "The project uses Postgres 16 for the primary store.",
    confidence: opts.confidence ?? 0.82,
    tags: opts.tags ?? ["postgres", "storage"],
    entities: [{ name: "Postgres", kind: "database" }],
    classification: opts.classification ?? "fact",
  });
}

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";

function pinnedNow(t: number): () => number {
  return () => t;
}

function mkSummary(overrides: Partial<SafeMemorySummary> = {}): SafeMemorySummary {
  return {
    id: 0,
    kind: "finding",
    state: "active",
    // Phase 1 internal naming cleanup: the internal
    // `SafeMemorySummary` field is `memoryContent`
    // (TS-side). Provider JSON / public surface still use
    // `summary`; the internal type is the seam.
    memoryContent: "default summary",
    tags: [],
    classification: null,
    confidence: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Schema version literals (Phase I bump + legacy constant)
// ---------------------------------------------------------------------------

test("Phase I: DERIVED_SCHEMA_VERSION is the literal ccm-draft-2", () => {
  // The new write literal. Tests pin the constant + the
  // string value so a future bump is intentional.
  assert.equal(DERIVED_SCHEMA_VERSION, "ccm-draft-2");
});

test("Phase I: LEGACY_DERIVED_SCHEMA_VERSION is the literal ccm-draft-1 (compat)", () => {
  // The old literal is preserved for compatibility tests
  // and the read-side fallback in
  // `listActiveMemoryRelationshipBlocks`. It is NOT the
  // new write literal.
  assert.equal(LEGACY_DERIVED_SCHEMA_VERSION, "ccm-draft-1");
  assert.notEqual(LEGACY_DERIVED_SCHEMA_VERSION, DERIVED_SCHEMA_VERSION);
});

test("Phase I: deriveRelationshipMetadata emits ccm-draft-2 on a clean call", () => {
  const candidate = mkSummary({ id: 1, memoryContent: "we use Postgres for storage" });
  const out = deriveRelationshipMetadata({
    candidate,
    others: [],
    asOf: 1_700_000_000_000,
  });
  assert.equal(out.derivedSchemaVersion, "ccm-draft-2");
  assert.equal(out.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// 2. buildPersistedMetadata: pass-through of new optional fields
// ---------------------------------------------------------------------------

test("buildPersistedMetadata: copies supersedes / supersededBy / resolvedAt when supplied (pass-through)", () => {
  // Pass-through rule: when the caller supplies the new
  // fields on the derived block, the writer copies them
  // verbatim onto the persisted block. The detector does
  // NOT derive them.
  const existing = { tags: ["postgres"], classification: "fact" };
  const derived: RelationshipMetadataFields = {
    conflictsWith: [42],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1_700_000_000_000,
    supersedes: [10, 11],
    supersededBy: [12],
    resolvedAt: 1_700_000_000_001,
  };
  const out = buildPersistedMetadata(existing, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.deepEqual(rel.supersedes, [10, 11]);
  assert.deepEqual(rel.supersededBy, [12]);
  assert.equal(rel.resolvedAt, 1_700_000_000_001);
  // The conservative fields are still written.
  assert.equal(rel.derivedSchemaVersion, "ccm-draft-2");
  assert.deepEqual(rel.conflictsWith, [42]);
  // Existing keys are preserved.
  assert.deepEqual(out.tags, ["postgres"]);
  assert.equal(out.classification, "fact");
});

test("buildPersistedMetadata: does not write the new fields when the caller omits them", () => {
  // The pass-through is opt-in. A caller that does NOT
  // supply the new fields gets a block WITHOUT the new
  // keys, exactly as the first version did. The detector
  // does not populate them.
  const existing = { tags: ["x"] };
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
  };
  const out = buildPersistedMetadata(existing, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.equal(rel.supersedes, undefined);
  assert.equal(rel.supersededBy, undefined);
  assert.equal(rel.resolvedAt, undefined);
});

test("buildPersistedMetadata: filters non-finite / non-integer ids in the new fields", () => {
  // Defensive: a malformed value in the new fields is
  // silently dropped (the conservative fields use the
  // same defensive policy). The block still lands with
  // the conservative fields intact.
  const derived: RelationshipMetadataFields = {
    conflictsWith: [7],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
    // Mixed good and bad entries: 10, 11 are valid; the
    // others are NaN, string, negative, fractional, zero.
    supersedes: [10, 11, Number.NaN, "x", -1, 1.5, 0] as unknown as number[],
    supersededBy: [20, Number.POSITIVE_INFINITY, 21] as unknown as number[],
    // Negative resolvedAt is dropped; non-finite is
    // dropped; only the valid positive integer lands.
    resolvedAt: 1_700_000_000_002,
  };
  const out = buildPersistedMetadata({ tags: ["x"] }, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.deepEqual(rel.supersedes, [10, 11]);
  assert.deepEqual(rel.supersededBy, [20, 21]);
  assert.equal(rel.resolvedAt, 1_700_000_000_002);
});

test("buildPersistedMetadata: empty / non-positive supersedes arrays are not written", () => {
  // The writer only writes the key when the array has at
  // least one valid positive integer. An empty array or
  // an array of all-invalid entries leaves the key
  // absent (not set to `[]`).
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
    supersedes: [] as number[],
    supersededBy: [-1, -2, 0] as unknown as number[],
  };
  const out = buildPersistedMetadata({ tags: ["x"] }, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.equal(rel.supersedes, undefined);
  assert.equal(rel.supersededBy, undefined);
});

test("buildPersistedMetadata: non-finite resolvedAt is dropped (default 0)", () => {
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
    resolvedAt: Number.NaN,
  };
  const out = buildPersistedMetadata({ tags: ["x"] }, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.equal(rel.resolvedAt, undefined);
});

test("buildPersistedMetadata: supersedes array is bounded to 16 entries", () => {
  // The cap matches the conservative fields' cap and
  // the spec's hard limit.
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
    supersedes: ids,
  };
  const out = buildPersistedMetadata({ tags: ["x"] }, derived);
  const rel = out.relationship as Record<string, unknown>;
  const arr = rel.supersedes as number[];
  assert.equal(arr.length, 16);
  // First 16 are kept.
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

// ---------------------------------------------------------------------------
// 3. Append-only invariant
// ---------------------------------------------------------------------------

test("Phase I: existing relationship block is NOT overwritten by a new pass-through write", () => {
  // The append-only rule from Phase B is preserved: a
  // pre-existing `relationship` key is left in place. The
  // new pass-through fields do NOT change this rule. The
  // pre-existing block is the canonical "legacy" shape
  // here.
  const existing = {
    tags: ["a"],
    relationship: {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [99],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    },
  };
  const derived: RelationshipMetadataFields = {
    conflictsWith: [42],
    olderVariantsOf: [],
    detectionConfidence: 0.91,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 2,
    supersedes: [10],
    supersededBy: [11],
    resolvedAt: 3,
  };
  const out = buildPersistedMetadata(existing, derived);
  const rel = out.relationship as Record<string, unknown>;
  // Pre-existing block is preserved verbatim.
  assert.equal(rel.derivedSchemaVersion, "ccm-draft-1");
  assert.equal(rel.derivedAt, 1);
  assert.deepEqual(rel.conflictsWith, [99]);
  assert.equal(rel.detectionConfidence, 0.95);
  // The new pass-through fields are NOT merged into the
  // pre-existing block.
  assert.equal(rel.supersedes, undefined);
  assert.equal(rel.supersededBy, undefined);
  assert.equal(rel.resolvedAt, undefined);
});

// ---------------------------------------------------------------------------
// 4. hasMeaningfulRelationshipData ignores the Phase I fields
// ---------------------------------------------------------------------------

test("hasMeaningfulRelationshipData: does NOT consider the Phase I pass-through fields", () => {
  // The conservative detector fields are the gate for
  // "should we write a `relationship` block at all". A
  // row with only Phase I fields and no conservative
  // signal is "no detector output" and the writer must
  // NOT write a noisy empty block.
  const empty: RelationshipMetadataFields = {
    conflictsWith: [],
    olderVariantsOf: [],
    detectionConfidence: 0,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 0,
    supersedes: [10],
    supersededBy: [11],
    resolvedAt: 1_700_000_000_000,
  };
  assert.equal(hasMeaningfulRelationshipData(empty), false);
  // Sanity: a row with even one conservative field is
  // still meaningful.
  assert.equal(
    hasMeaningfulRelationshipData({ ...empty, conflictsWith: [1] }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 5. Controller integration: new writes use ccm-draft-2
// ---------------------------------------------------------------------------

test("controller: new writes use DERIVED_SCHEMA_VERSION (ccm-draft-2)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          // Use a high id (e.g. 9001) so the candidate
          // (whose real id will be 1) is strictly greater
          // than the related memory's id. The detector
          // requires `other.id !== candidate.id` to
          // consider the related row, and the asymmetric-
          // negation rule needs a real pair to fire on.
          id: 9001,
          // Phase 1 internal naming cleanup: this fixture
          // is the internal `RelatedMemory` seam row, so
          // the property key is `memoryContent` (TS-side).
          // The provider JSON contract and the public
          // surface still use `summary`; the seam is the
          // boundary.
          memoryContent: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override (Phase I schema version pin)",
    }));
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "we do not use Postgres for this service in production",
          tags: ["postgres", "storage"],
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Some safe fact.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
      now: pinnedNow(1_700_000_000_000),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const row = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(typeof parsed.relationship, "object");
    const rel = parsed.relationship as Record<string, unknown>;
    // The new write literal lands in the persisted JSON.
    assert.equal(rel.derivedSchemaVersion, "ccm-draft-2");
    assert.equal(rel.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
    // The conservative fields are present and the Phase I
    // pass-through fields are absent (the detector does
    // not derive them).
    assert.deepEqual(rel.conflictsWith, [9001]);
    assert.equal(rel.supersedes, undefined);
    assert.equal(rel.supersededBy, undefined);
    assert.equal(rel.resolvedAt, undefined);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. Read-side projection: round-trips new fields
// ---------------------------------------------------------------------------

test("listActiveMemoryRelationshipBlocks: round-trips ccm-draft-2 rows with the new fields", () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert a row that carries the Phase I fields on its
    // relationship block. Use raw SQL so we can write a
    // block exactly the way the Phase I writer would.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "row with ccm-draft-2 + Phase I fields",
        "active",
        JSON.stringify({
          tags: ["x"],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-2",
            derivedAt: 1_700_000_000_000,
            conflictsWith: [10],
            olderVariantsOf: [],
            detectionConfidence: 0.9,
            supersedes: [11, 12],
            supersededBy: [13],
            resolvedAt: 1_700_000_000_001,
          },
        }),
      );
    const blocks: MemoryRelationshipBlockRow[] =
      listActiveMemoryRelationshipBlocks(handle);
    assert.equal(blocks.length, 1);
    const b = blocks[0]!.block;
    assert.equal(b.derivedSchemaVersion, "ccm-draft-2");
    assert.equal(b.derivedAt, 1_700_000_000_000);
    assert.deepEqual(b.conflictsWith, [10]);
    assert.deepEqual(b.olderVariantsOf, []);
    assert.equal(b.detectionConfidence, 0.9);
    // Phase I fields round-trip.
    assert.deepEqual(b.supersedes, [11, 12]);
    assert.deepEqual(b.supersededBy, [13]);
    assert.equal(b.resolvedAt, 1_700_000_000_001);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("listActiveMemoryRelationshipBlocks: legacy ccm-draft-1 rows project safe defaults", () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert a legacy row (Phase A shape, no Phase I
    // fields). The reader must project safe defaults
    // (`[]` arrays, `0` timestamp) for the new fields.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "legacy ccm-draft-1 row",
        "active",
        JSON.stringify({
          tags: ["x"],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-1",
            derivedAt: 1_700_000_000_000,
            conflictsWith: [99],
            olderVariantsOf: [],
            detectionConfidence: 0.85,
          },
        }),
      );
    const blocks: MemoryRelationshipBlockRow[] =
      listActiveMemoryRelationshipBlocks(handle);
    assert.equal(blocks.length, 1);
    const b = blocks[0]!.block;
    // Legacy literal is preserved.
    assert.equal(b.derivedSchemaVersion, "ccm-draft-1");
    // Conservative fields preserved.
    assert.deepEqual(b.conflictsWith, [99]);
    assert.equal(b.detectionConfidence, 0.85);
    // Phase I fields default safely.
    assert.deepEqual(b.supersedes, []);
    assert.deepEqual(b.supersededBy, []);
    assert.equal(b.resolvedAt, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("listActiveMemoryRelationshipBlocks: rows without a relationship key project safe defaults", () => {
  // Pre-Phase-B row shape (no `relationship` key at
  // all). The reader must project safe defaults for
  // BOTH the conservative and Phase I fields.
  const { tmp, handle } = mkStorage();
  try {
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "row with no relationship key",
        "active",
        JSON.stringify({ tags: ["x"], classification: null }),
      );
    const blocks: MemoryRelationshipBlockRow[] =
      listActiveMemoryRelationshipBlocks(handle);
    assert.equal(blocks.length, 1);
    const b = blocks[0]!.block;
    // The pre-Phase-B fallback schema version is the
    // legacy literal, mirroring the original Phase B
    // behaviour.
    assert.equal(b.derivedSchemaVersion, "ccm-draft-1");
    assert.deepEqual(b.conflictsWith, []);
    assert.deepEqual(b.olderVariantsOf, []);
    assert.equal(b.detectionConfidence, 0);
    // Phase I defaults.
    assert.deepEqual(b.supersedes, []);
    assert.deepEqual(b.supersededBy, []);
    assert.equal(b.resolvedAt, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("listActiveMemoryRelationshipBlocks: missing / malformed metadata returns safe defaults and does not throw", () => {
  const { tmp, handle } = mkStorage();
  try {
    // Malformed JSON in the metadata column.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "row with malformed JSON",
        "active",
        "this is not json {",
      );
    // Null metadata.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 1,
        "row with null metadata",
        "active",
        null,
      );
    // Non-object relationship block.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 2,
        "row with non-object relationship",
        "active",
        JSON.stringify({ relationship: "not an object" }),
      );
    // Relationship block where the new fields are
    // non-array / non-number, but the conservative
    // fields are valid. The reader must preserve the
    // valid conservative fields and silently drop the
    // malformed Phase I fields to safe defaults.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 3,
        "row with malformed Phase I fields",
        "active",
        JSON.stringify({
          tags: [],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-2",
            derivedAt: 1,
            conflictsWith: [],
            olderVariantsOf: [],
            detectionConfidence: 0.5,
            supersedes: "not an array",
            // All-invalid id list: a string, a negative
            // integer, a fractional, zero, NaN. None
            // survive the `x > 0 && integer && finite`
            // filter, so the projection drops the field
            // to its safe default (`[]`).
            supersededBy: ["bad", -1, 2.5, 0, Number.NaN] as unknown,
            resolvedAt: "not a number",
          },
        }),
      );
    const blocks: MemoryRelationshipBlockRow[] =
      listActiveMemoryRelationshipBlocks(handle);
    assert.equal(blocks.length, 4);
    // The first three rows have completely missing or
    // malformed metadata; they all project the safe
    // defaults for both the conservative and the Phase I
    // fields. (The `derivedSchemaVersion` for those rows
    // is the legacy fallback.)
    for (let i = 0; i < 3; i += 1) {
      const b = blocks[i]!;
      assert.equal(b.block.derivedSchemaVersion, "ccm-draft-1");
      assert.deepEqual(b.block.conflictsWith, []);
      assert.deepEqual(b.block.olderVariantsOf, []);
      assert.equal(b.block.detectionConfidence, 0);
      assert.deepEqual(b.block.supersedes, []);
      assert.deepEqual(b.block.supersededBy, []);
      assert.equal(b.block.resolvedAt, 0);
    }
    // The fourth row has a valid `relationship` block
    // whose conservative fields are preserved but whose
    // Phase I fields are silently dropped. The reader
    // must keep the conservative value and use safe
    // defaults for the malformed Phase I fields.
    const last = blocks[3]!;
    assert.equal(last.block.derivedSchemaVersion, "ccm-draft-2");
    assert.equal(last.block.derivedAt, 1);
    assert.deepEqual(last.block.conflictsWith, []);
    assert.deepEqual(last.block.olderVariantsOf, []);
    assert.equal(last.block.detectionConfidence, 0.5);
    assert.deepEqual(last.block.supersedes, []);
    assert.deepEqual(last.block.supersededBy, []);
    assert.equal(last.block.resolvedAt, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 7. Public recall output does NOT expose the new tokens
// ---------------------------------------------------------------------------

test("public recall output: does NOT expose derivedSchemaVersion, ccm-draft-1, ccm-draft-2, supersedes, supersededBy, resolvedAt", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Seed two active memories with Phase I pass-through
    // relationship blocks. The lexical ranker will keep
    // both; the controller will not emit a resolved-
    // history signal in Phase I (it does not wire the
    // detector). The public message must not carry any
    // diagnostic token.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "Postgres stores project data reliably",
        "active",
        JSON.stringify({
          tags: ["postgres"],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-2",
            derivedAt: 1_700_000_000_000,
            conflictsWith: [2],
            olderVariantsOf: [],
            detectionConfidence: 0.95,
            supersededBy: [2],
            resolvedAt: 1_700_000_000_001,
          },
        }),
        0.9,
      );
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 1,
        "Postgres stores project data reliably since 2023",
        "active",
        JSON.stringify({
          tags: ["postgres"],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-2",
            derivedAt: 1_700_000_000_002,
            conflictsWith: [1],
            olderVariantsOf: [],
            detectionConfidence: 0.93,
            supersedes: [1],
            resolvedAt: 1_700_000_000_003,
          },
        }),
        0.9,
      );
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse("Postgres stores project data reliably."),
      );
      const out = await runRecallController(handle, "What database does the project use?", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      // The public answer / message must not contain any
      // of the new diagnostic tokens.
      for (const tok of [
        "derivedSchemaVersion",
        "ccm-draft-1",
        "ccm-draft-2",
        "supersedes",
        "supersededBy",
        "resolvedAt",
        "relationship",
        "internalAmbiguity",
      ]) {
        assert.ok(
          !out.answer.includes(tok),
          `public answer must not include '${tok}' (Phase I invariant)`,
        );
      }
      // The controller did not wire the resolved-history
      // detector in Phase I: `internalAmbiguity` is
      // present (it always has been since Phase C) but
      // its `kind` is the Phase D discriminator
      // (`"ambiguous"` / `"none"`), not the new
      // `"resolved-history"`.
      if ("internalAmbiguity" in out && out.internalAmbiguity) {
        const k = out.internalAmbiguity.kind;
        assert.ok(
          k === "ambiguous" || k === "none",
          `Phase I internalAmbiguity.kind must be ambiguous|none, got '${k}' (resolved-history is Phase J only)`,
        );
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("public recall output: no_memory / rejected / provider_error paths are unchanged", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Seed one active memory so the provider path is
    // actually exercised (an empty storage short-circuits
    // to `no_memory` before the provider is called).
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "Postgres is the primary store.",
        "active",
        JSON.stringify({ tags: ["postgres"], classification: null }),
        0.9,
      );
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const { fetchImpl } = scriptFetch(() => okChatResponse("x"));
      // no_memory
      const r1 = await runRecallController(handle, "When is the company picnic?", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(r1.status, "no_memory");
      // rejected (secret-shaped query)
      const r2 = await runRecallController(handle, "AKIAIOSFODNN7EXAMPLE", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(r2.status, "rejected");
      if (r2.status === "rejected") {
        for (const tok of [
          "derivedSchemaVersion",
          "ccm-draft-1",
          "ccm-draft-2",
          "supersedes",
          "supersededBy",
          "resolvedAt",
          "internalAmbiguity",
        ]) {
          assert.ok(
            !r2.reason.includes(tok),
            `rejected reason must not include '${tok}'`,
          );
        }
      }
      // provider_error — a query that DOES match the
      // seeded memory, paired with a 500-returning
      // scripted fetch. The controller must reach the
      // provider, fail, and return provider_error.
      const errFetch = scriptFetch(() => new Response("boom", { status: 500 }));
      const r3 = await runRecallController(handle, "primary store", {
        providerFetchImpl: errFetch.fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(r3.status, "provider_error");
      if (r3.status === "provider_error") {
        for (const tok of [
          "derivedSchemaVersion",
          "ccm-draft-1",
          "ccm-draft-2",
          "supersedes",
          "supersededBy",
          "resolvedAt",
        ]) {
          assert.ok(
            !r3.reason.includes(tok),
            `provider_error reason must not include '${tok}'`,
          );
        }
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 8. Recall controller wires the resolved-history detector (Phase J)
// ---------------------------------------------------------------------------

test("recall controller: imports + calls the resolved-history detector (Phase J wiring)", async () => {
  // Phase I (the prior step) left the controller
  // unwired: the detector was a pure module, the
  // controller did not import it, and the public
  // message was byte-equal to pre-Phase-H. Phase J
  // flips the wiring: the controller now imports
  // `detectResolvedHistory` and the `ResolvedHistorySignal`
  // type, runs the detector on the answered outcome,
  // and exposes the result on a parallel
  // `internalResolvedHistory` field. The tool layer
  // imports `formatResolvedHistoryNote` and prefixes
  // the public `message` with the prose-only history
  // note. This test pins the wiring on disk (a static
  // source check) so any future regression that drops
  // the import or the call surfaces here rather than
  // as a silent loss of the new feature.
  const fsP = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const controllerPath = pathMod.resolve(
    here,
    "../src/controller/recall-controller.ts",
  );
  const text = await fsP.readFile(controllerPath, "utf8");
  for (const required of [
    "detectResolvedHistory",
    "ResolvedHistorySignal",
  ]) {
    assert.ok(
      text.includes(required),
      `recall-controller.ts must reference "${required}" in Phase J (wiring invariant)`,
    );
  }
  // The controller must NOT call the public-note
  // formatter directly: the formatter lives in the
  // tool layer. This is the layering pin; Phase J
  // separates detection (controller) from formatting
  // (tool layer) by design. The check is for an
  // `import` statement specifically — a docstring
  // reference is allowed (and useful for the reader).
  assert.equal(
    /import\s+\{[^}]*formatResolvedHistoryNote[^}]*\}\s+from\s+["'][^"']*resolved-history(?:\.js)?["']/.test(text),
    false,
    "recall-controller.ts must not import formatResolvedHistoryNote; " +
      "the formatter lives in src/tools/recall.ts (tool layer)",
  );
  // Tool layer: the projection must call
  // `formatResolvedHistoryNote` and reference the new
  // verdict.
  const toolPath = pathMod.resolve(here, "../src/tools/recall.ts");
  const toolText = await fsP.readFile(toolPath, "utf8");
  for (const required of [
    "formatResolvedHistoryNote",
    "internalResolvedHistory",
  ]) {
    assert.ok(
      toolText.includes(required),
      `recall.ts must reference "${required}" in Phase J (wiring invariant)`,
    );
  }
});

test("recall controller: sourceIds and answer field shape are byte-equal pre-Phase I (no demotion)", async () => {
  // The Phase I invariant: a pair of rows with Phase I
  // pass-through relationship blocks (including a
  // `supersedes` pointer that the Phase H detector would
  // resolve) must still produce a byte-equal pre-Phase I
  // public outcome. The detector is silent; no
  // resolved-history note is prefixed; both source ids
  // remain listed. This is the spec §2.3 "older memories
  // remain retrievable" invariant at the surface level.
  const { tmp, handle } = mkStorage();
  try {
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "Render was the project hosting platform.",
        "active",
        JSON.stringify({ tags: [], classification: null }),
        0.9,
      );
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 1,
        "Fly.io is the current hosting platform for production.",
        "active",
        JSON.stringify({
          tags: [],
          classification: null,
          relationship: {
            derivedSchemaVersion: "ccm-draft-2",
            derivedAt: 1_700_000_000_000,
            conflictsWith: [],
            olderVariantsOf: [],
            detectionConfidence: 0,
            supersedes: [1],
          },
        }),
        0.9,
      );
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse("Fly.io is the current hosting platform for production."),
      );
      // Use a query that lexically matches the seeded
      // summaries so the recall path is exercised end-to-
      // end (the lexical ranker must keep both rows for
      // the detector to see them).
      const out = await runRecallController(handle, "hosting platform production", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      // Both ids are still listed — no demotion.
      assert.deepEqual(
        out.sourceIds.slice().sort((a, b) => a - b),
        [1, 2].slice().sort((a, b) => a - b),
      );
      // The public answer is the synthesized answer
      // verbatim. No resolved-history prefix.
      assert.ok(
        out.answer.startsWith("Fly.io"),
        `public answer must not have a resolved-history prefix, got: ${out.answer.slice(0, 80)}`,
      );
      for (const tok of [
        "resolved-history",
        "Note:",
        "supersedes",
        "ccm-draft-2",
      ]) {
        assert.ok(
          !out.answer.includes(tok),
          `public answer must not include '${tok}'`,
        );
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 9. detector remains pure / unwired
// ---------------------------------------------------------------------------

test("resolved-history detector: remains pure and unwired (does not import the controller)", async () => {
  const fsP = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const srcPath = pathMod.resolve(
    here,
    "../src/retrieval/resolved-history.ts",
  );
  const text = await fsP.readFile(srcPath, "utf8");
  // The detector is a pure module. It must not import
  // the controller, the tool layer, the provider layer,
  // or benchmark experiment modules. It MAY import the
  // shared `SafeMemorySummary` type from
  // `../storage/storage.js` (the type is a pure data
  // shape, not a runtime dependency on storage), but it
  // must not invoke any storage I/O.
  for (const forbidden of [
    "controller/",
    "tools/",
    "providers/",
    "benchmark/",
  ]) {
    assert.equal(
      text.includes(`from "../${forbidden}`) ||
        text.includes(`from "./${forbidden}`),
      false,
      `resolved-history.ts must not import from ../${forbidden}`,
    );
  }
  // The detector exposes the pure `detectResolvedHistory`
  // and a small set of constants. After Phase J, the
  // module also exposes the public-message note
  // formatter `formatResolvedHistoryNote` (the formatter
  // is structurally separate from the detector but
  // intentionally co-located in the same pure module so
  // the public note's no-id-in-public-text contract
  // stays anchored to the same source as the detector
  // it renders). The controller imports only the
  // detector; the tool layer imports only the
  // formatter. Neither imports the other.
  assert.equal(text.includes("detectResolvedHistory"), true);
  assert.equal(
    text.includes("formatResolvedHistoryNote"),
    true,
    "formatResolvedHistoryNote is defined in Phase J",
  );
  // Defensive: no storage I/O calls in the detector.
  // (The detector must not invoke `initStorage`,
  // `listActiveMemorySummaries`, or any other storage
  // runtime helper. The `SafeMemorySummary` type import
  // is compile-time only.)
  for (const runtimeCall of [
    "initStorage(",
    "listActiveMemorySummaries(",
    "listActiveMemoryRelationshipBlocks(",
    "insertMemoryRecord(",
    "updateMemoryMetadata(",
    "handle.db",
  ]) {
    assert.equal(
      text.includes(runtimeCall),
      false,
      `resolved-history.ts must not invoke storage runtime "${runtimeCall}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. legacy schema literal is preserved across the module boundary
// ---------------------------------------------------------------------------

test("Phase I: the legacy literal ccm-draft-1 is preserved for the read-side fallback", () => {
  // The reader in `listActiveMemoryRelationshipBlocks`
  // falls back to the legacy literal when the stored
  // block is missing a `derivedSchemaVersion` key. The
  // storage module pins the same literal as a module-
  // local constant. The relationship module exposes the
  // same literal as `LEGACY_DERIVED_SCHEMA_VERSION`.
  // They are byte-equal, ensuring a single source of
  // truth across the writer/reader.
  assert.equal(
    LEGACY_DERIVED_SCHEMA_VERSION,
    "ccm-draft-1",
  );
});

// ---------------------------------------------------------------------------
// 11. Phase I does not introduce a new AmbiguitySignal variant
// ---------------------------------------------------------------------------

test("Phase I: AmbiguitySignal discriminator set is unchanged (no resolved-history variant yet)", async () => {
  // The Phase F §8.3 plan defers the new
  // `kind: "resolved-history"` variant to Phase J. Phase
  // I does not extend `AmbiguitySignal` (the controller
  // never has a chance to emit a `resolved-history`
  // signal). This test pins the current discriminator
  // set.
  const fsP = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const ambPath = pathMod.resolve(
    here,
    "../src/retrieval/ambiguity.ts",
  );
  const text = await fsP.readFile(ambPath, "utf8");
  // The Phase D discriminator set is the only one
  // currently in `AmbiguitySignal`. Phase I does not
  // extend it; the resolved-history variant lives in
  // its own `ResolvedHistorySignal` type in
  // `resolved-history.ts`.
  assert.equal(
    text.includes("resolved-history"),
    false,
    "Phase I: ambiguity.ts must not reference the resolved-history verdict (Phase J only)",
  );
});

// ---------------------------------------------------------------------------
// 12. Files we touch do not import benchmark experiment modules
// ---------------------------------------------------------------------------

test("Phase I: edited files do not import benchmark experiment modules", async () => {
  const fsP = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const touched = [
    "../src/retrieval/relationship.ts",
    "../src/retrieval/resolved-history.ts",
    "../src/storage/storage.ts",
    "../src/controller/recall-controller.ts",
    "../src/controller/remember-controller.ts",
  ];
  const forbidden = [
    "supersedes-promote-guard",
    "supersession-edge-simulation",
    "multi-anchor-current-previous",
    "temporal-candidate-generation-probe",
    "temporal-ranking-preference",
    "temporal-truth-diagnostic",
    "paraphrase-recovery",
    "false-abstention-damage",
  ];
  for (const rel of touched) {
    const abs = pathMod.resolve(here, rel);
    const text = await fsP.readFile(abs, "utf8");
    for (const tok of forbidden) {
      assert.equal(
        text.includes(tok),
        false,
        `${rel} must not reference benchmark experiment module "${tok}"`,
      );
    }
    assert.equal(
      /from\s+["'][^"']*benchmark\//.test(text),
      false,
      `${rel} must not import from src/benchmark/`,
    );
  }
});
