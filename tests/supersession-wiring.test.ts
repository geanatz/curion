/**
 * Integration tests for supersession detection wiring in the
 * remember controller.
 *
 * Verifies that when `remember` is called with text that explicitly
 * supersedes an older related memory, the controller:
 *   1. Writes `supersedes: [oldId]` on the new row.
 *   2. Back-patches the old row with `supersededBy: [newId]`.
 *   3. **Phase 3 wiring:** transitions the old row's `state` from
 *      `active` to `superseded` via the audit-backed
 *      `transitionMemoryState` seam, so the existing active filter
 *      hides it from normal recall.
 *   4. Writes an audit row to `memory_transitions` with reason
 *      `supersession`, actor `supersession-controller`, the
 *      detector confidence, and `triggering_memory_id` set to the
 *      new memory's id.
 *   5. Public API is unchanged: the saved `message` carries no
 *      supersession metadata, no memory id, and no audit detail.
 *
 * No live provider calls. Uses scripted fetch and seam overrides.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runRecallController } from "../src/controller/recall-controller.ts";
import { runRememberController } from "../src/controller/remember-controller.ts";
import { resetRelatedMemoriesImpl, setRelatedMemoriesImpl } from "../src/retrieval/seam.ts";
import { okChatResponse, safeAnalysis, scriptFetch } from "./_helpers/provider-stub.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";
import {
  TEST_FALLBACK_BASE_URL,
  TEST_FALLBACK_KEY,
  TEST_FALLBACK_MODEL,
  TEST_PRIMARY_BASE_URL,
  TEST_PRIMARY_KEY,
  TEST_PRIMARY_MODEL,
} from "./shared-test-provider.ts";

function pinnedNow(t: number): () => number {
  return () => t;
}

// ---------------------------------------------------------------------------
// Test 1: New memory writes supersedes on new row; old row gets supersededBy
// ---------------------------------------------------------------------------

test("controller supersession: new row carries supersedes, old row carries supersededBy", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Step 1: Insert the "old" memory about MiniMax embeddings.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      const r = await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1_700_000_000_000),
      });
      assert.equal(r.status, "saved");
      if (r.status !== "saved") throw new Error("unreachable");
      assert.equal(r.record.id, 1, "old memory should have id 1");
    }

    // Step 2: Override the seam to return the old memory as related.
    // The candidate provider output explicitly supersedes MiniMax embeddings.
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test seam override",
    }));

    const pinnedTime = 1_700_000_000_001;
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Update embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(pinnedTime),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    assert.equal(outcome.record.id, 2, "new memory should have id 2");

    // Verify new row has supersedes.
    const newRow = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(2) as { metadata: string; state: string };
    const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
    assert.equal(newRow.state, "active");
    assert.equal(typeof newParsed.relationship, "object", "new row must have relationship block");

    const newRel = newParsed.relationship as Record<string, unknown>;
    assert.deepEqual(newRel.supersedes, [1], "new row must supersede the old memory's id");

    // Verify old row has supersededBy AND has been transitioned
    // to `superseded` by the Phase 3 wiring (the explicit
    // supersession path now hides the older memory from normal
    // recall through the existing `state = 'active'` filter).
    const oldRow = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(1) as { metadata: string; state: string };
    assert.equal(oldRow.state, "superseded", "old row must be transitioned to superseded");

    const oldParsed = JSON.parse(oldRow.metadata) as Record<string, unknown>;
    assert.equal(
      typeof oldParsed.relationship,
      "object",
      "old row must have a relationship block from the back-patch"
    );
    const oldRel = oldParsed.relationship as Record<string, unknown>;
    assert.deepEqual(
      oldRel.supersededBy,
      [2],
      "old row must have supersededBy pointing to the new memory"
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 2: Old row is transitioned to `superseded` by Phase 3 wiring
// ---------------------------------------------------------------------------

test("controller supersession: superseded old row transitions to 'superseded' state", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory. Use wording with enough token
    // overlap + an explicit supersession-style phrase in
    // the candidate summary so the conservative detector
    // fires. The raw input carries explicit supersession
    // language ("no longer use") so the detector uses the
    // reduced overlap threshold (0.2) — this is the
    // standard Phase 1 supersession-detection shape.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use SQLite for local development databases.",
            tags: ["sqlite", "local", "dev"],
          })
        )
      );
      await runRememberController(handle, "Local dev database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use SQLite for local development databases.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use SQLite for local development databases; use Docker Compose with PostgreSQL instead.",
          tags: ["docker", "postgres", "local"],
        })
      )
    );
    await runRememberController(
      handle,
      "Local dev stack update: we no longer use SQLite for local development databases.",
      {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(2),
      }
    );

    const oldRow = handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as {
      state: string;
    };
    // Phase 3 wiring: the explicit supersession path
    // transitions the old row to `superseded` so it is
    // hidden from normal recall (existing
    // `listActiveMemorySummaries` /
    // `listActiveMemorySummariesByFts5` /
    // `listActiveMemoryRelationshipBlocks` filter on
    // `state = 'active'`).
    assert.equal(oldRow.state, "superseded", "superseded memory must transition to 'superseded'");

    const newRow = handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(2) as {
      state: string;
    };
    assert.equal(newRow.state, "active", "new memory stays active");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Superseded old memory is hidden from recall
// ---------------------------------------------------------------------------
//
// Phase 3 wiring changes the expected recall behaviour for
// explicitly superseded memories: the old row's `state` is now
// `superseded`, so `listActiveMemorySummaries` (and the FTS5 /
// relationship-block parallel reads) filter it out. The
// superseding memory remains the only candidate surfaced for
// the query, which is the whole point of the lifecycle wiring:
// once the user explicitly supersedes an old fact, the recall
// path stops returning the stale value.

test("controller supersession: superseded old memory is hidden from recall (only the new memory surfaces)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert the old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "Embedding provider decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1_700_000_000_000),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(1_700_000_000_001),
    });

    // Recall with a query that would have matched both memories
    // when both were active. (Uses "minimax embeddings" because
    // the lexical matcher requires exact token overlap;
    // "embedding" ≠ "embeddings" without stemming.)
    const recallFetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [
            {
              message: {
                role: "assistant",
                content: "The current embedding provider is NVIDIA NIM.",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    const recallOut = await runRecallController(handle, "minimax embeddings", {
      providerFetchImpl: recallFetch,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      relevanceThreshold: 0.05,
      topK: 10,
    });

    assert.equal(recallOut.status, "answered");
    if (recallOut.status === "answered") {
      // The new superseding memory MUST appear in sourceIds.
      assert.ok(
        recallOut.sourceIds.includes(2),
        "new superseding memory must remain in recall sourceIds"
      );
      // The old superseded memory MUST NOT appear in sourceIds —
      // Phase 3 wiring hides it via the `state = 'active'` filter.
      assert.ok(
        !recallOut.sourceIds.includes(1),
        "superseded old memory must be hidden from recall"
      );
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Supersession without conflictsWith / olderVariantsOf
// ---------------------------------------------------------------------------

test("controller supersession: supersession-only block is persisted (no conflictsWith)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use Redis for caching in the web tier.",
            tags: ["redis", "caching"],
          })
        )
      );
      await runRememberController(handle, "Cache decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use Redis for caching in the web tier.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "We no longer use Redis for caching in the web tier; use Memcached instead.",
          tags: ["memcached", "caching"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Update cache approach.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
    const newRel = newParsed.relationship as Record<string, unknown>;

    assert.equal(typeof newRel, "object");
    assert.deepEqual(newRel.supersedes, [1], "supersedes must be set");
    assert.deepEqual(newRel.conflictsWith, []);
    assert.deepEqual(newRel.olderVariantsOf, []);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 5: Multiple superseded memories
// ---------------------------------------------------------------------------

test("controller supersession: new memory can supersede multiple related memories", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert two old memories about MiniMax.
    for (const [id, summary] of [
      [1, "We use MiniMax for text embeddings in the recall pipeline."],
      [2, "MiniMax is our text embedding provider for recall."],
    ] as const) {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(safeAnalysis({ summary, tags: ["minimax", "embeddings"] }))
      );
      const r = await runRememberController(handle, `Memory ${id}.`, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1_700_000_000_000 + id),
      });
      assert.equal(r.status, "saved");
      if (r.status !== "saved") throw new Error("unreachable");
      assert.equal(r.record.id, id);
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
        {
          id: 2,
          memoryContent: "MiniMax is used for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embeddings.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(1_700_000_000_003),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    // New row has supersedes: [1, 2].
    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newRel = (JSON.parse(newRow.metadata) as Record<string, unknown>).relationship as Record<
      string,
      unknown
    >;
    assert.deepEqual(newRel.supersedes, [1, 2], "must supersede both old memories");

    // Each old row gets supersededBy: [3].
    for (const oldId of [1, 2] as const) {
      const oldRow = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(oldId) as {
        metadata: string;
      };
      const oldRel = (JSON.parse(oldRow.metadata) as Record<string, unknown>)
        .relationship as Record<string, unknown>;
      assert.deepEqual(oldRel.supersededBy, [3], `old memory ${oldId} must have supersededBy: [3]`);
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 6: Missing old row — addSupersededByToMemory is a safe no-op
// ---------------------------------------------------------------------------

test("controller supersession: missing old row is safe no-op (no crash)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Override seam to return a non-existent id 9999.
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 9999,
          memoryContent: "Some non-existent memory.",
        },
      ],
      reason: "test (nonexistent id)",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "We no longer use MiniMax; use NVIDIA NIM instead.",
          tags: ["nvidia"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(1),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    // New row exists and has a relationship block (though supersedes may be empty
    // since the nonexistent id wasn't found in storage).
    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
    // If supersession signal was emitted, supersedes: [9999] would be set and
    // addSupersededByToMemory(9999, ...) would be called (no-op since 9999 doesn't exist).
    // If no signal (because the seam id 9999 doesn't exist in storage for the
    // detector), then no relationship block is written.
    // Either way: no crash.
    assert.ok(outcome.record.id === 1, "memory should be inserted with id 1");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 7: No supersession language → no supersedes metadata
// ---------------------------------------------------------------------------

test("controller supersession: no supersession language → no supersedes on new row", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "The project uses Postgres 16.",
            tags: ["postgres"],
          })
        )
      );
      await runRememberController(handle, "DB decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "The project uses Postgres 16.",
        },
      ],
      reason: "test",
    }));

    // New memory has overlap but NO supersession language.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "After evaluation we decided to use Postgres 17 for better performance.",
          tags: ["postgres"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Upgrade Postgres.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
    const newRel = newParsed.relationship as Record<string, unknown> | undefined;

    // No supersession language → no supersedes field.
    if (newRel) {
      assert.ok(
        !("supersedes" in newRel) ||
          (Array.isArray(newRel.supersedes) && newRel.supersedes.length === 0),
        "no supersedes when no supersession language"
      );
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 8: Supersession plus existing conflictsWith — both written
// ---------------------------------------------------------------------------

test("controller supersession: supersedes and conflictsWith can coexist on new row", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory with conflicting claim.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for embeddings.",
            tags: ["minimax"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Use a seam text with high overlap (>0.5 Jaccard) with the new
    // summary so the supersession detector fires. The old memory
    // text is almost identical to the new one except for the
    // "no longer" supersession marker.
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    // New memory that both supersedes AND conflicts (high overlap
    // with old memory + explicit supersession phrasing + negation).
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "minimax"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embeddings.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newRel = (JSON.parse(newRow.metadata) as Record<string, unknown>).relationship as Record<
      string,
      unknown
    >;

    assert.deepEqual(newRel.supersedes, [1], "supersedes must be set");
    assert.ok(
      newRel.conflictsWith !== undefined,
      "conflictsWith should also be set (asymmetric negation)"
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 9: Back-patch does not overwrite existing supersededBy array
// ---------------------------------------------------------------------------

test("controller supersession: back-patch appends to existing supersededBy array", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory with existing supersededBy: [99].
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for embeddings.",
            tags: ["minimax"],
          })
        )
      );
      await runRememberController(handle, "MiniMax decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Manually patch the old row to have an existing supersededBy: [99].
    const { updateMemoryMetadata } = await import("../src/storage/storage.ts");
    updateMemoryMetadata(handle, 1, {
      tags: ["minimax"],
      classification: null,
      relationship: {
        derivedSchemaVersion: "ccm-draft-2",
        derivedAt: 1_700_000_000_000,
        conflictsWith: [],
        olderVariantsOf: [],
        detectionConfidence: 0.9,
        supersededBy: [99],
      },
    });

    // Use a seam text with high overlap (>0.5 Jaccard) so the
    // supersession detector fires and back-patch is triggered.
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia"],
        })
      )
    );
    await runRememberController(handle, "Switch.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    const oldRow = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(1) as {
      metadata: string;
    };
    const oldRel = (JSON.parse(oldRow.metadata) as Record<string, unknown>).relationship as Record<
      string,
      unknown
    >;

    const supersededBy = oldRel.supersededBy as number[];
    assert.ok(supersededBy.includes(99), "existing supersededBy entry must be preserved");
    assert.ok(supersededBy.includes(2), "new supersededBy entry must be appended");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 10: Public message shape unchanged
// ---------------------------------------------------------------------------

test("controller supersession: public message does not reveal supersession metadata", async () => {
  const { tmp, handle } = mkStorage();
  try {
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use Postgres 16.",
            tags: ["postgres"],
          })
        )
      );
      await runRememberController(handle, "DB fact.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use Postgres 16.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "We no longer use Postgres 16; use Aurora instead.",
          tags: ["aurora"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch DB.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    assert.ok(
      !outcome.message.includes("supersedes"),
      "public message must not include 'supersedes'"
    );
    assert.ok(
      !outcome.message.includes("supersededBy"),
      "public message must not include 'supersededBy'"
    );
    assert.ok(!/#\d+/.test(outcome.message), "public message must not include memory id");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Regression Test: Freshly-created same-topic old policy is superseded
// ---------------------------------------------------------------------------
// This is the exact live case from run 3758 where row 177 (NVIDIA policy)
// superseded rows 151 and 166 but did NOT supersede the freshly created
// old policy memory 176.
//
// Root cause: the remember-time supersession detector only saw related-memory
// candidates returned by the seam's lexical topK=5 lookup on the raw input.
// The raw input ("NVIDIA NIM openai/gpt-oss-120b") has dominant tokens that
// don't overlap with "MiniMax as default provider". Row 176 was pushed out
// of topK=5 by other memories with NVIDIA-related tokens, even though 176
// was the direct predecessor of the new policy.
//
// Fix: the seam now accepts `candidateText` (normalized summary) and runs a
// dual-text union lookup. For supersession detection specifically, the
// controller calls the seam with both raw input AND candidateText and uses
// topK=16. This ensures topically similar memories like 176 are included.
// ---------------------------------------------------------------------------

test("controller supersession: fresh same-topic old policy is superseded even when other provider memories exist", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-create "distractor" memories that have high lexical overlap
    // with "nvidia/nim/openai/gpt-oss-120b" tokens in the raw input
    // but are NOT the policy being superseded. These simulate rows
    // 151 and 166 from run 3758.
    const distractorFetch = () =>
      okChatResponse(
        safeAnalysis({
          summary: "NVIDIA NIM provides embeddings for production workloads.",
          tags: ["nvidia", "nim", "embeddings"],
          classification: "fact",
        })
      );
    for (let i = 0; i < 3; i++) {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(distractorFetch);
      await runRememberController(handle, `NVIDIA NIM embedding fact ${i}.`, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1_700_000_000_000 + i),
      });
    }

    // Reset the seam override from the for loop so the NVIDIA policy
    // block uses the real seam. Without this, the for loop's override
    // would persist into the NVIDIA policy block, causing the real seam
    // to never be called.
    resetRelatedMemoriesImpl();

    // Step 1: Insert the "old" MiniMax policy (simulates row 176).
    // This is the freshly created policy that should be superseded.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary:
              "The Curion system policy designates MiniMax as the default provider for both remember and recall operations.",
            tags: ["minimax", "provider", "default"],
            classification: "policy",
          })
        )
      );
      const r = await runRememberController(
        handle,
        "Curion provider policy: use MiniMax as the default provider for remember and recall.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
          providerPrimaryModel: TEST_PRIMARY_MODEL,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
          providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
          providerFallbackModel: TEST_FALLBACK_MODEL,
          now: pinnedNow(1_700_000_000_010),
        }
      );
      assert.equal(r.status, "saved");
      if (r.status !== "saved") throw new Error("unreachable");
      assert.equal(r.record.id, 4, "MiniMax policy should have id 4");
    }

    // Reset seam override from MiniMax policy block so the NVIDIA policy
    // block uses the real seam. The MiniMax block set the override but
    // had no finally to reset it.
    resetRelatedMemoriesImpl();

    // Step 2: Insert the new NVIDIA policy that explicitly supersedes
    // the MiniMax policy. The raw input has "nvidia/nim/openai/gpt-oss-120b"
    // tokens that would dominate lexical scoring and push the MiniMax policy
    // (id 4) out of topK=5 if we only used raw input text.
    // The fix uses both raw input AND normalized summary for candidate
    // selection, ensuring the MiniMax policy IS included.
    {
      // Use the real seam (no override) so the dual-text union is exercised.
      // The seam will find related memories using BOTH the raw input
      // (NVIDIA NIM tokens) AND the normalized summary ("default provider"
      // "remember" "recall" tokens). The MiniMax policy should be found
      // via the summary-text lookup even if it doesn't match the raw input.
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary:
              "The Curion provider policy was changed to make NVIDIA NIM (openai/gpt-oss-120b) the sole default provider for both remember and recall operations, replacing MiniMax as the default.",
            tags: ["nvidia", "nim", "provider", "default"],
            classification: "policy",
          })
        )
      );
      const outcome = await runRememberController(
        handle,
        "Curion provider policy update: we no longer use MiniMax as the default provider. Use NVIDIA NIM openai/gpt-oss-120b as the only default provider for remember and recall. This new policy supersedes the previous MiniMax provider policy.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
          providerPrimaryModel: TEST_PRIMARY_MODEL,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
          providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
          providerFallbackModel: TEST_FALLBACK_MODEL,
          now: pinnedNow(1_700_000_000_011),
        }
      );
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");
      assert.equal(outcome.record.id, 5, "NVIDIA policy should have id 5");

      // Verify new row (id 5) has supersedes: [4]
      const newRow = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(5) as {
        metadata: string;
      };
      const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
      const newRel = newParsed.relationship as Record<string, unknown>;
      assert.deepEqual(
        newRel.supersedes,
        [4],
        "new NVIDIA policy must supersede the immediate old MiniMax policy (id 4)"
      );

      // Verify old row (id 4) has supersededBy: [5]
      const oldRow = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(4) as {
        metadata: string;
      };
      const oldParsed = JSON.parse(oldRow.metadata) as Record<string, unknown>;
      const oldRel = oldParsed.relationship as Record<string, unknown>;
      assert.deepEqual(
        oldRel.supersededBy,
        [5],
        "old MiniMax policy must have supersededBy pointing to new NVIDIA policy"
      );
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Negative Test: No false positive supersession when old memory is unrelated
// ---------------------------------------------------------------------------

test("controller supersession: no false positive supersession for unrelated old memory", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-create an unrelated memory about a different topic.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "The project uses PostgreSQL 16 for the primary database.",
            tags: ["postgresql", "database"],
            classification: "fact",
          })
        )
      );
      await runRememberController(handle, "Database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Try to supersede with a policy about a completely different topic.
    // The old memory (PostgreSQL) should NOT be superseded because there's
    // no topical overlap and no supersession language applies.
    {
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary:
              "The Curion provider policy was changed to make NVIDIA NIM the sole default provider.",
            tags: ["nvidia", "provider"],
            classification: "policy",
          })
        )
      );
      const outcome = await runRememberController(
        handle,
        "Provider policy: use NVIDIA NIM as default.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
          providerPrimaryModel: TEST_PRIMARY_MODEL,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
          providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
          providerFallbackModel: TEST_FALLBACK_MODEL,
          now: pinnedNow(2),
        }
      );
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");

      // Verify new row does NOT have supersedes (unrelated topic)
      const newRow = handle.db.prepare("SELECT metadata FROM memories WHERE id = ?").get(2) as {
        metadata: string;
      };
      const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
      const newRel = newParsed.relationship as Record<string, unknown> | undefined;
      assert.ok(
        !newRel ||
          !("supersedes" in newRel) ||
          (Array.isArray(newRel.supersedes) && newRel.supersedes.length === 0),
        "unrelated old memory must not be superseded"
      );
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ===========================================================================
// Phase 3 wiring — supersession audit log + recall-exclusion + non-supersession paths
// ===========================================================================
//
// These tests pin the Phase 3 wiring: when an explicit
// supersession signal fires in the controller, the old row is
// transitioned to `superseded` through the audit-backed
// `transitionMemoryState` seam. The transition writes exactly
// one coherent row to `memory_transitions` per superseded old
// id, the existing active filter hides the row from recall, and
// non-supersession paths (olderVariantsOf, conflictsWith without
// supersession language) leave state unchanged.
//
// All tests use the same scripted fetch / seam-override pattern
// the rest of the file uses. No live provider calls.
// ---------------------------------------------------------------------------

import {
  listActiveMemoryRelationshipBlocks,
  listActiveMemorySummaries,
  listActiveMemorySummariesByFts5,
  listMemoryTransitions,
} from "../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Phase 3 — Test 1: Audit row is written with correct fields
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: writes exactly one audit row per superseded old memory with correct reason/actor/confidence/triggering memory id", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory about MiniMax embeddings.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Sanity: no audit rows on the old memory before the
    // supersession fires.
    assert.equal(listMemoryTransitions(handle, 1).length, 0);

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const newMemoryId = outcome.record.id;
    assert.equal(newMemoryId, 2, "new memory should have id 2");

    // Phase 3 invariant: exactly ONE audit row exists for
    // the old memory, with the controller-driven supersession
    // contract.
    const history = listMemoryTransitions(handle, 1);
    assert.equal(history.length, 1, "exactly one audit row per superseded old memory");
    const row = history[0] as (typeof history)[number];
    assert.equal(row.memoryId, 1, "audit row must reference the old memory id");
    assert.equal(row.fromState, "active", "from_state must be 'active'");
    assert.equal(row.toState, "superseded", "to_state must be 'superseded'");
    assert.equal(row.reason, "supersession", "reason must identify the canonical supersession tag");
    assert.equal(row.actor, "supersession-controller", "actor must identify the controller path");
    assert.equal(
      row.triggeringMemoryId,
      newMemoryId,
      "triggering_memory_id must be the new (superseding) memory id"
    );
    assert.ok(
      row.confidence !== null && row.confidence > 0 && row.confidence <= 1,
      `confidence must be a non-null value in (0, 1]; got ${row.confidence}`
    );
    // The audit metadata round-trips the detector source so
    // forensic consumers can correlate the row with the
    // controller's signal shape.
    assert.equal(row.metadata.source, "detectSupersession");
    assert.equal(row.metadata.detector, "controller");
    assert.deepEqual(
      row.metadata.supersededIds,
      [1],
      "metadata.supersededIds must echo the detector's signal shape"
    );

    // The new memory must NOT have any audit row: it stays
    // `active` and no transition was performed on it.
    const newHistory = listMemoryTransitions(handle, newMemoryId);
    assert.equal(
      newHistory.length,
      0,
      "no audit row is written for the new memory (it stays active)"
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 2: listActiveMemorySummaries excludes superseded old memory
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: listActiveMemorySummaries excludes the superseded old memory", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    // The active summary list MUST exclude the superseded
    // old memory and MUST include the new superseding one.
    const summaries = listActiveMemorySummaries(handle, { limit: 50 });
    const ids = summaries.map((s) => s.id);
    assert.ok(!ids.includes(1), "superseded old memory must be hidden from active summaries");
    assert.ok(ids.includes(2), "new superseding memory must remain in active summaries");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 3: listActiveMemorySummariesByFts5 excludes superseded old memory
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: listActiveMemorySummariesByFts5 excludes the superseded old memory", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    // The FTS5 active-filtered read MUST exclude the
    // superseded old memory even when the query token
    // would have matched it. Use the distinctive `minimax`
    // token with an explicit OR so the FTS5 parser doesn't
    // try to AND it with `nvidia`.
    const matches = listActiveMemorySummariesByFts5(handle, "minimax OR nvidia", { limit: 50 });
    const ids = matches.map((m) => m.id);
    assert.ok(!ids.includes(1), "superseded old memory must be hidden from FTS5 active read");
    assert.ok(ids.includes(2), "new superseding memory must remain in FTS5 active read");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 4: listActiveMemoryRelationshipBlocks excludes superseded old memory
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: listActiveMemoryRelationshipBlocks excludes the superseded old memory", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    // The parallel relationship-block read MUST also
    // exclude the superseded old memory.
    const blocks = listActiveMemoryRelationshipBlocks(handle, { limit: 50 });
    const ids = blocks.map((b) => b.id);
    assert.ok(
      !ids.includes(1),
      "superseded old memory must be hidden from relationship-block read"
    );
    assert.ok(ids.includes(2), "new superseding memory must remain in relationship-block read");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 5: Relationship metadata remains intact after state transition
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: relationship metadata (supersededBy on old row, supersedes on new row) remains intact after state transition", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const newMemoryId = outcome.record.id;

    // Old row state is `superseded` (Phase 3).
    const oldRow = handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as {
      state: string;
    };
    assert.equal(oldRow.state, "superseded");

    // Old row's metadata STILL carries `supersededBy: [newId]`
    // (relationship metadata is preserved on the audit-only row).
    const oldMetadataRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(1) as { metadata: string };
    const oldParsed = JSON.parse(oldMetadataRow.metadata) as Record<string, unknown>;
    const oldRel = oldParsed.relationship as Record<string, unknown> | undefined;
    assert.ok(oldRel, "old row's relationship block must be preserved");
    assert.deepEqual(
      oldRel?.supersededBy,
      [newMemoryId],
      "old row's supersededBy pointer must be preserved after the state transition"
    );

    // New row's metadata STILL carries `supersedes: [1]`.
    const newMetadataRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(newMemoryId) as { metadata: string };
    const newParsed = JSON.parse(newMetadataRow.metadata) as Record<string, unknown>;
    const newRel = newParsed.relationship as Record<string, unknown> | undefined;
    assert.ok(newRel, "new row's relationship block must be preserved");
    assert.deepEqual(
      newRel?.supersedes,
      [1],
      "new row's supersedes pointer must be preserved after the state transition"
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 6: No transition for olderVariants-only (no supersession signal)
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: olderVariants-of signal alone does NOT transition state (conservative)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory with content that triggers the
    // `olderVariantsOf` heuristic but NOT supersession
    // language. The candidate paraphrase is so close that
    // the older-variant detector fires, but no supersession
    // phrasings ("no longer", "supersedes", "replaced by")
    // are present.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary:
              "Postgres 16 is the primary database for the project; it stores all customer records reliably.",
            tags: ["postgres"],
          })
        )
      );
      await runRememberController(handle, "Postgres 16 database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent:
            "Postgres 16 is the primary database for the project; it stores all customer records reliably.",
        },
      ],
      reason: "test",
    }));

    // Near-paraphrase of the old memory, with NO supersession
    // phrasings. The `olderVariantsOf` heuristic may fire
    // here because the Jaccard is high; supersession must NOT.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "Postgres 16 is the primary database for the project; it stores all customer records reliably and consistently.",
          tags: ["postgres"],
        })
      )
    );
    await runRememberController(handle, "Postgres 16 database decision revisited.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    // Old row's state MUST remain `active`. No supersession
    // language was present, so the detector did not fire
    // and no transition was written.
    const oldState = (
      handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as { state: string }
    ).state;
    assert.equal(oldState, "active", "olderVariants-of alone must not transition state");

    // No audit row should exist for the old memory.
    assert.equal(listMemoryTransitions(handle, 1).length, 0);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 7: No transition for conflicts-only (no supersession signal)
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: conflicts-with signal alone does NOT transition state (conservative)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory about Postgres 16.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary:
              "Postgres 16 is the primary database for the project; it stores all customer records reliably.",
            tags: ["postgres"],
          })
        )
      );
      await runRememberController(handle, "Postgres 16 database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent:
            "Postgres 16 is the primary database for the project; it stores all customer records reliably.",
        },
      ],
      reason: "test",
    }));

    // High-overlap asymmetric negation: the candidate
    // contains "not" but the old memory does not. This
    // should fire `conflictsWith` (Phase B) but NOT
    // supersession. The candidate wording intentionally
    // avoids any supersession-trigger phrase ("no longer
    // use", "do not use", "supersedes", "replaced by",
    // "deprecated", "overrides", etc.) so the supersession
    // detector stays silent and no transition happens.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "Postgres 16 is not the primary database for the project; customer records do not go there.",
          tags: ["postgres"],
        })
      )
    );
    await runRememberController(
      handle,
      "Postgres 16 is not the primary database for the project.",
      {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(2),
      }
    );

    // Old row's state MUST remain `active`. Conflicts are
    // preserved per the conservative rule: they are kept
    // visible (with both rows active) and flagged through
    // metadata, not resolved by hiding the older memory.
    const oldState = (
      handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as { state: string }
    ).state;
    assert.equal(
      oldState,
      "active",
      "conflicts-with alone must not transition state (conservative)"
    );

    // No audit row should exist for the old memory.
    assert.equal(listMemoryTransitions(handle, 1).length, 0);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 8: No transition when no supersession language
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: no supersession language → no transition and no audit row", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "The project uses Postgres 16.",
            tags: ["postgres"],
          })
        )
      );
      await runRememberController(handle, "Postgres 16 decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "The project uses Postgres 16.",
        },
      ],
      reason: "test",
    }));

    // New memory has high overlap but NO supersession
    // language (no "no longer", "supersedes", "replaced",
    // etc.). Detector must not fire; no transition.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "After evaluation we decided to use Postgres 17 for better performance.",
          tags: ["postgres"],
        })
      )
    );
    await runRememberController(handle, "Upgrade Postgres.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    // Old row stays active. New row also stays active.
    const oldState = (
      handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as { state: string }
    ).state;
    assert.equal(oldState, "active", "no transition when no supersession language");

    // No audit row for the old memory.
    assert.equal(listMemoryTransitions(handle, 1).length, 0);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 9: Multiple superseded memories get multiple audit rows
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: multiple superseded memories → one audit row per old memory, all transitioned", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert two related memories about MiniMax.
    // Both summaries share enough tokens with the candidate
    // (after dropping stopwords) for the conservative
    // detector to fire supersession on each. Token Jaccard
    // for the candidate against each old memory must clear
    // the 0.5 floor the detector enforces when the raw
    // input has no explicit supersession phrasing.
    for (const summary of [
      "We use MiniMax for text embeddings in the recall pipeline.",
      "We use MiniMax text embeddings in the recall pipeline.",
    ]) {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(safeAnalysis({ summary, tags: ["minimax", "embeddings"] }))
      );
      const r = await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1_700_000_000_000 + summary.length),
      });
      assert.equal(r.status, "saved");
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
        {
          id: 2,
          memoryContent: "We use MiniMax text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embeddings.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(1_700_000_000_999),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const newMemoryId = outcome.record.id;

    // Both old rows are transitioned to `superseded`.
    for (const oldId of [1, 2]) {
      const state = (
        handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(oldId) as {
          state: string;
        }
      ).state;
      assert.equal(state, "superseded", `old memory ${oldId} must be superseded`);

      // Exactly one audit row per old memory, with the new
      // memory id as triggering_memory_id.
      const history = listMemoryTransitions(handle, oldId);
      assert.equal(history.length, 1, `old memory ${oldId} must have exactly one audit row`);
      const row = history[0] as (typeof history)[number];
      assert.equal(row.fromState, "active");
      assert.equal(row.toState, "superseded");
      assert.equal(row.reason, "supersession");
      assert.equal(row.actor, "supersession-controller");
      assert.equal(row.triggeringMemoryId, newMemoryId);
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 10: Public API is unchanged (controller message shape)
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: public message does NOT mention state transition or audit row", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    const outcome = await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    // The controller's `message` (the public surface the tool
    // layer serializes into the MCP `text` content block) is
    // byte-identical to the pre-Phase-3 shape: it carries the
    // kind and confidence only, with no id, no
    // "superseded", and no audit detail.
    assert.match(outcome.message, /^saved \([a-z]+, confidence \d+\.\d{2}\)$/);
    for (const tok of [
      "supersedes",
      "supersededBy",
      "superseded",
      "supersession",
      "supersession-controller",
      "transitionMemoryState",
      "memory_transitions",
    ]) {
      assert.ok(
        !outcome.message.includes(tok),
        `public message must not mention '${tok}'; got ${JSON.stringify(outcome.message)}`
      );
    }
    assert.ok(!/#\d+/.test(outcome.message), "public message must not include any #N memory id");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Test 11: Already-superseded old row is handled safely (no crash)
// ---------------------------------------------------------------------------

test("phase3 supersession wiring: already-superseded old row is skipped safely (no crash, no duplicate audit row)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          })
        )
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Manually transition the old memory to `superseded`
    // (simulating a prior explicit supersession) BEFORE the
    // candidate runs. The detector will skip the row
    // (because `other.state !== "active"`), so no transition
    // is attempted.
    handle.db.prepare("UPDATE memories SET state = 'superseded' WHERE id = 1").run();

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use MiniMax for text embeddings in the recall pipeline.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
          tags: ["nvidia", "embeddings"],
        })
      )
    );
    // The detector filters on `state === "active"`, so the
    // candidate's `supersession` signal would already be
    // empty when the old memory is inactive — but we drive
    // the seam explicitly so the test simulates the
    // detector's normal candidate projection. The seam
    // projects the related memory's summary as-is (the
    // detector itself is what filters on state).
    //
    // Result: the controller call succeeds without
    // crashing, the new row is saved, and the old row's
    // state stays `superseded` (the detector skips it).
    const outcome = await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
      now: pinnedNow(2),
    });
    assert.equal(outcome.status, "saved", "controller must save the new memory");
    if (outcome.status !== "saved") throw new Error("unreachable");

    // The old memory's state stays `superseded` (no
    // duplicate transition attempted because the detector
    // filters on `state === "active"`).
    const oldState = (
      handle.db.prepare("SELECT state FROM memories WHERE id = ?").get(1) as { state: string }
    ).state;
    assert.equal(oldState, "superseded", "already-superseded old row must not be re-transitioned");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});
