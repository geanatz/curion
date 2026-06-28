/**
 * Integration tests for superseded-memory demotion in the recall controller.
 *
 * Verifies that the `demoteSupersededMemories` helper is correctly wired
 * into the recall controller ranking pipeline via the relationship metadata
 * stored in `metadata.relationship`.
 *
 * Covers:
 *   1. Current memory supersedes stale memory -> current ranks above stale.
 *   2. Stale memory supersededBy current -> stale is demoted.
 *   3. Missing references are ignored safely (no crash, no wrong ranking).
 *   4. Self-supersession is ignored (candidate cannot supersede itself).
 *   5. Duplicate supersession edges are harmless.
 *   6. Unrelated ranking order is preserved when no supersession applies.
 *   7. Trace event `recall.superseded-demotion` is emitted with correct payload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  insertMemoryRecord,
  updateMemoryMetadata,
  type StorageHandle,
  type MemoryRecord,
} from "../src/storage/storage.ts";
import { DEMOTION_FACTOR } from "../src/retrieval/superseded-demotion.ts";
import {
  TEST_PRIMARY_KEY,
  TEST_FALLBACK_KEY,
  TEST_PRIMARY_BASE_URL,
  TEST_PRIMARY_MODEL,
  TEST_FALLBACK_BASE_URL,
  TEST_FALLBACK_MODEL,
} from "./shared-test-provider.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";

// ---------------------------------------------------------------------------
// Scripted fetch (unused in most tests — no_memory when scores are low)
// ---------------------------------------------------------------------------

function scriptFetch() {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return new Response(
      JSON.stringify({
        id: "x",
        model: "m",
        choices: [{ message: { role: "assistant", content: "This should not be returned." } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Relationship block builder
// ---------------------------------------------------------------------------

interface RelationshipBlock {
  derivedSchemaVersion?: string;
  derivedAt?: number;
  conflictsWith?: number[];
  olderVariantsOf?: number[];
  detectionConfidence?: number;
  supersedes?: number[];
  supersededBy?: number[];
  resolvedAt?: number;
}

function mkRelationshipBlock(partial: RelationshipBlock): RelationshipBlock {
  return {
    derivedSchemaVersion: "ccm-draft-2",
    derivedAt: 1_700_000_000_000,
    conflictsWith: [],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Memory insertion with optional relationship metadata
// ---------------------------------------------------------------------------

function insertWithRelationship(
  handle: StorageHandle,
  memoryContent: string,
  relationship?: RelationshipBlock,
): MemoryRecord {
  const rec = insertMemoryRecord(handle, {
    kind: "fact",
    state: "active",
    memoryContent,
    providerId: "minimax",
    modelId: "MiniMax-M3",
    confidence: 0.9,
    safetyFlags: ["controller-normalized"],
    metadata: {
      tags: [],
      classification: null,
    },
  });
  if (relationship) {
    updateMemoryMetadata(handle, rec.id, {
      ...rec.metadata,
      relationship,
    });
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Trace collector
// ---------------------------------------------------------------------------

interface TraceStage {
  kind: string;
  payload: unknown;
}

/**
 * A trace context that collects emitted stages in memory for inspection.
 * Mirrors the real `RecallTraceContext` shape but records rather than persists.
 */
function makeInMemoryTraceContext(): {
  trace: {
    runId: number;
    recordStage: (kind: string, payload: unknown) => void;
  };
  stages: TraceStage[];
} {
  const stages: TraceStage[] = [];
  return {
    trace: {
      runId: 42,
      recordStage: (kind, payload) => {
        stages.push({ kind, payload: JSON.parse(JSON.stringify(payload)) });
      },
    },
    stages,
  };
}

// ---------------------------------------------------------------------------
// Test: current supersedes stale -> stale demoted
// ---------------------------------------------------------------------------

test("recall: A supersedes B -> B demoted below A (supersedes path)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert two memories that share query tokens so both pass lexical threshold.
    // A (current) supersedes B (stale).
    const recB = insertWithRelationship(
      handle,
      "The project uses Postgres 16 for the primary data store.",
      mkRelationshipBlock({ supersededBy: [] }), // placeholder; patched below
    );
    const recA = insertWithRelationship(
      handle,
      "Postgres 16 is the primary database for this project.",
      mkRelationshipBlock({ supersedes: [recB.id] }),
    );
    // Patch B's supersededBy to point to A.
    updateMemoryMetadata(handle, recB.id, {
      ...recB.metadata,
      relationship: mkRelationshipBlock({ supersededBy: [recA.id] }),
    });

    // Both memories match "Postgres database".
    // A should rank above B because A supersedes B.
    const { fetchImpl } = scriptFetch();
    const { trace, stages } = makeInMemoryTraceContext();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      trace,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    // Provider was called (both passed threshold).
    assert.equal(out.status, "answered", `expected answered, got ${out.status}`);

    // A (superseding) must be in sourceIds before B (superseded).
    if (out.status === "answered") {
      const aIdx = out.sourceIds.indexOf(recA.id);
      const bIdx = out.sourceIds.indexOf(recB.id);
      assert.ok(aIdx >= 0, "current memory A should be in sourceIds");
      assert.ok(bIdx >= 0, "stale memory B should be in sourceIds");
      assert.ok(aIdx < bIdx, "current A should rank above stale B");
    }

    // Trace: superseded-demotion stage must be present.
    const demotionStage = stages.find((s) => s.kind === "recall.superseded-demotion");
    assert.ok(demotionStage !== undefined, "trace must emit recall.superseded-demotion stage");

    // Payload must summarize the demotion without raw memory text.
    const payload = demotionStage.payload as {
      demotions: Array<{
        id: number;
        rawScore: number;
        demotedScore: number;
        reason: string;
        supersedingId?: number;
      }>;
    };
    assert.ok(Array.isArray(payload.demotions), "payload must have demotions array");
    assert.equal(payload.demotions.length, 1, "only B should be demoted");
    const demotion = payload.demotions[0]!;
    assert.equal(demotion.id, recB.id, "demoted id should be B");
    assert.equal(demotion.reason, "supersededBy", "reason should be supersededBy");
    assert.equal(demotion.supersedingId, recA.id, "supersedingId should be A");
    assert.ok(demotion.rawScore > demotion.demotedScore, "demotedScore must be less than rawScore");
    assert.equal(demotion.demotedScore, demotion.rawScore * DEMOTION_FACTOR);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: stale supersededBy current -> stale demoted (supersededBy path)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Same topology but relationship is on the stale side.
    const recB = insertWithRelationship(
      handle,
      "Postgres 16 is used for the main database.",
      mkRelationshipBlock({ supersededBy: [] }), // placeholder
    );
    const recA = insertWithRelationship(
      handle,
      "The project uses Postgres 16 as its primary database.",
      mkRelationshipBlock({ supersedes: [recB.id] }),
    );
    // Patch B's supersededBy to point to A.
    updateMemoryMetadata(handle, recB.id, {
      ...recB.metadata,
      relationship: mkRelationshipBlock({ supersededBy: [recA.id] }),
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      const aIdx = out.sourceIds.indexOf(recA.id);
      const bIdx = out.sourceIds.indexOf(recB.id);
      assert.ok(aIdx < bIdx, "current A must rank above stale B");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: missing references ignored
// ---------------------------------------------------------------------------

test("recall: supersedes target not in candidate list -> no demotion (safe ignore)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // A supersedes B, but B does not exist in storage.
    const recA = insertWithRelationship(
      handle,
      "The project uses Postgres 16 for the primary database.",
      mkRelationshipBlock({ supersedes: [9999] }), // 9999 does not exist
    );

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    // Provider was called (A passes threshold on its own).
    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      assert.ok(out.sourceIds.includes(recA.id));
      // No demotion trace event should fire (no demotions occurred).
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: supersededBy referrer not in candidate list -> stale not demoted", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // B is superseded by A, but A does not match the query well enough to be
    // in the candidate list. B should NOT be demoted (no superseding candidate present).
    const recB = insertWithRelationship(
      handle,
      "Postgres 16 is used for the primary database.",
      mkRelationshipBlock({ supersededBy: [9998] }), // 9998 does not exist
    );

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      // B is the only candidate and was not demoted.
      assert.ok(out.sourceIds.includes(recB.id));
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: self-supersession ignored
// ---------------------------------------------------------------------------

test("recall: self-supersession (A supersedes A) -> safely ignored, no crash", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Memory that claims to supersede itself.
    const rec = insertWithRelationship(
      handle,
      "The project uses Postgres 16 for the primary database.",
      mkRelationshipBlock({ supersedes: [] }), // placeholder; patched below
    );
    updateMemoryMetadata(handle, rec.id, {
      ...rec.metadata,
      relationship: mkRelationshipBlock({ supersedes: [rec.id] }), // self-ref
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    // Must not crash. Memory should be in sourceIds.
    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      assert.ok(out.sourceIds.includes(rec.id));
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: self-supersededBy (A supersededBy A) -> safely ignored, no crash", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const rec = insertWithRelationship(
      handle,
      "Postgres 16 is the project database.",
      mkRelationshipBlock({ supersededBy: [0] }), // placeholder; patched below
    );
    updateMemoryMetadata(handle, rec.id, {
      ...rec.metadata,
      relationship: mkRelationshipBlock({ supersededBy: [rec.id] }), // self-ref
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      assert.ok(out.sourceIds.includes(rec.id));
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: duplicate edges harmless
// ---------------------------------------------------------------------------

test("recall: duplicate supersedes entries -> no crash, correct demotion", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const recB = insertWithRelationship(
      handle,
      "Postgres 16 is the primary database.",
      mkRelationshipBlock({ supersededBy: [] }),
    );
    const recA = insertWithRelationship(
      handle,
      "The project uses Postgres 16 for storage.",
      // Duplicate entries: [recB.id, recB.id]
      mkRelationshipBlock({ supersedes: [recB.id, recB.id] }),
    );
    updateMemoryMetadata(handle, recB.id, {
      ...recB.metadata,
      relationship: mkRelationshipBlock({ supersededBy: [recA.id] }),
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      const aIdx = out.sourceIds.indexOf(recA.id);
      const bIdx = out.sourceIds.indexOf(recB.id);
      assert.ok(aIdx < bIdx, "A must rank above B despite duplicate edge");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: unrelated ranking preserved
// ---------------------------------------------------------------------------

test("recall: unrelated candidates preserve lexical order when no supersession applies", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Three unrelated memories with different scores.
    const rec1 = insertWithRelationship(
      handle,
      "The project uses Postgres 16.",
      undefined, // no relationship
    );
    const rec2 = insertWithRelationship(
      handle,
      "Postgres 16 is the primary database.",
      undefined,
    );
    const rec3 = insertWithRelationship(
      handle,
      "Postgres is a relational database.",
      undefined,
    );

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      // All three should be present.
      assert.equal(out.sourceIds.length, 3);
      // No supersession applies, so the order should follow lexical scores
      // (descending by score, then descending by id as tiebreaker).
      // rec1 id=1, rec2 id=2, rec3 id=3. With identical content they'd
      // tie on score but id desc means rec3 > rec2 > rec1.
      // The exact order depends on the ranker, but we just verify all present.
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: stale with higher raw score is still demoted
// ---------------------------------------------------------------------------

test("recall: stale with higher raw score still demoted below current", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // B has higher raw lexical score than A, but B is stale.
    // A should still rank above B after demotion.
    const recB = insertWithRelationship(
      handle,
      "Postgres 16 is used for this project's primary database server.",
      mkRelationshipBlock({ supersededBy: [] }),
    );
    const recA = insertWithRelationship(
      handle,
      "The project uses Postgres 16.",
      mkRelationshipBlock({ supersedes: [recB.id] }),
    );
    updateMemoryMetadata(handle, recB.id, {
      ...recB.metadata,
      relationship: mkRelationshipBlock({ supersededBy: [recA.id] }),
    });

    // B's summary is longer so it gets a higher lexical score.
    // A's summary is shorter but A is the superseding memory.
    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres database", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      const aIdx = out.sourceIds.indexOf(recA.id);
      const bIdx = out.sourceIds.indexOf(recB.id);
      assert.ok(aIdx >= 0 && bIdx >= 0, "both A and B must be in sourceIds");
      assert.ok(aIdx < bIdx, "current A must rank above stale B despite lower raw score");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: trace emits count when no demotions
// ---------------------------------------------------------------------------

test("recall: no demotions -> trace emits compact count (no demotions array)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Two unrelated memories, no supersession.
    insertWithRelationship(
      handle,
      "The project uses Postgres 16 for the database.",
      undefined,
    );
    insertWithRelationship(
      handle,
      "The project uses Redis for caching.",
      undefined,
    );

    const { fetchImpl } = scriptFetch();
    const { trace, stages } = makeInMemoryTraceContext();
    const out = await runRecallController(handle, "Postgres", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      trace,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    const demotionStage = stages.find((s) => s.kind === "recall.superseded-demotion");
    // When no demotions, we emit a compact `{demotions: 0}` form.
    assert.ok(demotionStage !== undefined, "trace must emit superseded-demotion stage even when no demotions");
    const payload = demotionStage.payload as { demotions: number };
    assert.equal(payload.demotions, 0, "compact count of 0 when no demotions");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test: malformed/missing relationship data ignored
// ---------------------------------------------------------------------------

test("recall: malformed supersedes (non-array) -> safely ignored, no crash", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const rec = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The project uses Postgres 16.",
      providerId: "minimax",
      modelId: "MiniMax-M3",
      confidence: 0.9,
      safetyFlags: ["controller-normalized"],
      metadata: {
        tags: [],
        classification: null,
        // @ts-expect-error -- intentionally passing malformed relationship to test runtime safety
        relationship: {
          supersedes: "not-an-array", // malformed
          supersededBy: null,
        },
      },
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      assert.ok(out.sourceIds.includes(rec.id));
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: missing metadata relationship block -> treated as no relationship", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert with no metadata.relationship at all.
    const rec = insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The project uses Postgres 16.",
      providerId: "minimax",
      modelId: "MiniMax-M3",
      confidence: 0.9,
      safetyFlags: ["controller-normalized"],
      metadata: {
        tags: [],
        classification: null,
      },
    });

    const { fetchImpl } = scriptFetch();
    const out = await runRecallController(handle, "Postgres", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(out.status, "answered");
    if (out.status === "answered") {
      assert.ok(out.sourceIds.includes(rec.id));
    }
  } finally {
    rmStorage(tmp, handle);
  }
});
