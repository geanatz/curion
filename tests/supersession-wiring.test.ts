/**
 * Integration tests for supersession detection wiring in the
 * remember controller.
 *
 * Verifies that when `remember` is called with text that explicitly
 * supersedes an older related memory, the controller:
 *   1. Writes `supersedes: [oldId]` on the new row.
 *   2. Back-patches the old row with `supersededBy: [newId]`.
 *   3. Keeps the old row `active` (no state transition).
 *   4. The recall demotion helper then ranks the current above stale.
 *
 * No live provider calls. Uses scripted fetch and seam overrides.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRememberController } from "../src/controller/remember-controller.ts";
import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  initStorage,
  type StorageHandle,
} from "../src/storage/storage.ts";
import {
  setRelatedMemoriesImpl,
  resetRelatedMemoriesImpl,
} from "../src/retrieval/seam.ts";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-supersession-"));
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

// ---------------------------------------------------------------------------
// Scripted fetch
// ---------------------------------------------------------------------------

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
    summary:
      opts.summary ??
      "The project uses Postgres 16 for the primary store.",
    confidence: opts.confidence ?? 0.82,
    tags: opts.tags ?? ["postgres", "storage"],
    entities: [{ name: "Postgres", kind: "database" }],
    classification: opts.classification ?? "fact",
  });
}

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";
// Explicit provider config: neutral URLs resolve to "custom" label.
const PRIMARY_BASE_URL = "https://api.example.com/v1";
const PRIMARY_MODEL = "test/model-primary";
const FALLBACK_BASE_URL = "https://api.fallback.example/v1";
const FALLBACK_MODEL = "test/model-fallback";

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
            summary:
              "We use MiniMax for text embeddings in the recall pipeline.",
            tags: ["minimax", "embeddings"],
          }),
        ),
      );
      const r = await runRememberController(
        handle,
        "MiniMax embedding decision.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerPrimaryBaseUrl: PRIMARY_BASE_URL,
          providerPrimaryModel: PRIMARY_MODEL,
          providerFallbackApiKey: FALLBACK_KEY,
          providerFallbackBaseUrl: FALLBACK_BASE_URL,
          providerFallbackModel: FALLBACK_MODEL,
          now: pinnedNow(1_700_000_000_000),
        },
      );
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
        }),
      ),
    );
    const outcome = await runRememberController(
      handle,
      "Update embedding provider.",
      {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
        now: pinnedNow(pinnedTime),
      },
    );

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    assert.equal(outcome.record.id, 2, "new memory should have id 2");

    // Verify new row has supersedes.
    const newRow = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(2) as { metadata: string; state: string };
    const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
    assert.equal(newRow.state, "active");
    assert.equal(
      typeof newParsed.relationship,
      "object",
      "new row must have relationship block",
    );

    const newRel = newParsed.relationship as Record<string, unknown>;
    assert.deepEqual(
      newRel.supersedes,
      [1],
      "new row must supersede the old memory's id",
    );

    // Verify old row has supersededBy.
    const oldRow = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(1) as { metadata: string; state: string };
    assert.equal(oldRow.state, "active", "old row must remain active");

    const oldParsed = JSON.parse(oldRow.metadata) as Record<string, unknown>;
    assert.equal(
      typeof oldParsed.relationship,
      "object",
      "old row must have a relationship block from the back-patch",
    );
    const oldRel = oldParsed.relationship as Record<string, unknown>;
    assert.deepEqual(
      oldRel.supersededBy,
      [2],
      "old row must have supersededBy pointing to the new memory",
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 2: Old row remains active (no state transition)
// ---------------------------------------------------------------------------

test("controller supersession: superseded old row stays active", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Pre-insert old memory.
    {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "We use SQLite for local development.",
            tags: ["sqlite", "local", "dev"],
          }),
        ),
      );
      await runRememberController(handle, "Local dev database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          memoryContent: "We use SQLite for local development.",
        },
      ],
      reason: "test",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "We no longer use SQLite for local development; use Docker Compose with PostgreSQL instead.",
          tags: ["docker", "postgres", "local"],
        }),
      ),
    );
    await runRememberController(handle, "Local dev stack update.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    const oldRow = handle.db
      .prepare("SELECT state FROM memories WHERE id = ?")
      .get(1) as { state: string };
    assert.equal(
      oldRow.state,
      "active",
      "superseded memory must stay active",
    );

    const newRow = handle.db
      .prepare("SELECT state FROM memories WHERE id = ?")
      .get(2) as { state: string };
    assert.equal(newRow.state, "active");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Recall demotion ranks current above stale
// ---------------------------------------------------------------------------

test("controller supersession: recall demotion ranks current above superseded stale", async () => {
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
          }),
        ),
      );
      await runRememberController(handle, "Embedding provider decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
        }),
      ),
    );
    await runRememberController(handle, "Switch embedding provider.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(1_700_000_000_001),
    });

    // Recall with a query that matches both memories via shared tags.
    // (Uses "minimax embeddings" because the lexical matcher requires
    // exact token overlap; "embedding" ≠ "embeddings" without stemming.)
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
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const recallOut = await runRecallController(
      handle,
      "minimax embeddings",
      {
        providerFetchImpl: recallFetch,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
        relevanceThreshold: 0.05,
        topK: 10,
      },
    );

    assert.equal(recallOut.status, "answered");
    if (recallOut.status === "answered") {
      const currentIdx = recallOut.sourceIds.indexOf(2);
      const staleIdx = recallOut.sourceIds.indexOf(1);
      assert.ok(
        currentIdx >= 0 && staleIdx >= 0,
        "both memories must be in sourceIds",
      );
      assert.ok(
        currentIdx < staleIdx,
        "current superseding memory must rank above superseded stale memory",
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
          }),
        ),
      );
      await runRememberController(handle, "Cache decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
          summary:
            "We no longer use Redis for caching in the web tier; use Memcached instead.",
          tags: ["memcached", "caching"],
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Update cache approach.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
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
        okChatResponse(
          safeAnalysis({ summary, tags: ["minimax", "embeddings"] }),
        ),
      );
      const r = await runRememberController(handle, `Memory ${id}.`, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Switch embeddings.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(1_700_000_000_003),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    // New row has supersedes: [1, 2].
    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newRel = (JSON.parse(newRow.metadata) as Record<string, unknown>)
      .relationship as Record<string, unknown>;
    assert.deepEqual(newRel.supersedes, [1, 2], "must supersede both old memories");

    // Each old row gets supersededBy: [3].
    for (const oldId of [1, 2] as const) {
      const oldRow = handle.db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(oldId) as { metadata: string };
      const oldRel = (JSON.parse(oldRow.metadata) as Record<string, unknown>)
        .relationship as Record<string, unknown>;
      assert.deepEqual(
        oldRel.supersededBy,
        [3],
        `old memory ${oldId} must have supersededBy: [3]`,
      );
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
          summary:
            "We no longer use MiniMax; use NVIDIA NIM instead.",
          tags: ["nvidia"],
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Switch.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
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
    assert.ok(
      outcome.record.id === 1,
      "memory should be inserted with id 1",
    );
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
          }),
        ),
      );
      await runRememberController(handle, "DB decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
          summary:
            "After evaluation we decided to use Postgres 17 for better performance.",
          tags: ["postgres"],
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Upgrade Postgres.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
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
        "no supersedes when no supersession language",
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
          }),
        ),
      );
      await runRememberController(handle, "MiniMax embedding decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
          memoryContent:
            "We use MiniMax for embeddings in the recall pipeline.",
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
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Switch embeddings.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const newRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const newRel = (JSON.parse(newRow.metadata) as Record<string, unknown>)
      .relationship as Record<string, unknown>;

    assert.deepEqual(newRel.supersedes, [1], "supersedes must be set");
    assert.ok(
      newRel.conflictsWith !== undefined,
      "conflictsWith should also be set (asymmetric negation)",
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
          }),
        ),
      );
      await runRememberController(handle, "MiniMax decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
        now: pinnedNow(1),
      });
    }

    // Manually patch the old row to have an existing supersededBy: [99].
    const { updateMemoryMetadata } = await import(
      "../src/storage/storage.ts"
    );
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
        }),
      ),
    );
    await runRememberController(handle, "Switch.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    const oldRow = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(1) as { metadata: string };
    const oldRel = (JSON.parse(oldRow.metadata) as Record<string, unknown>)
      .relationship as Record<string, unknown>;

    const supersededBy = oldRel.supersededBy as number[];
    assert.ok(
      supersededBy.includes(99),
      "existing supersededBy entry must be preserved",
    );
    assert.ok(
      supersededBy.includes(2),
      "new supersededBy entry must be appended",
    );
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
          }),
        ),
      );
      await runRememberController(handle, "DB fact.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Switch DB.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerPrimaryBaseUrl: PRIMARY_BASE_URL,
      providerPrimaryModel: PRIMARY_MODEL,
      providerFallbackApiKey: FALLBACK_KEY,
      providerFallbackBaseUrl: FALLBACK_BASE_URL,
      providerFallbackModel: FALLBACK_MODEL,
      now: pinnedNow(2),
    });

    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    assert.ok(
      !outcome.message.includes("supersedes"),
      "public message must not include 'supersedes'",
    );
    assert.ok(
      !outcome.message.includes("supersededBy"),
      "public message must not include 'supersededBy'",
    );
    assert.ok(
      !/#\d+/.test(outcome.message),
      "public message must not include memory id",
    );
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
        }),
      );
    for (let i = 0; i < 3; i++) {
      setRelatedMemoriesImpl(() => ({ memories: [], reason: "empty" }));
      const { fetchImpl } = scriptFetch(distractorFetch);
      await runRememberController(handle, `NVIDIA NIM embedding fact ${i}.`, {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
          }),
        ),
      );
      const r = await runRememberController(
        handle,
        "Curion provider policy: use MiniMax as the default provider for remember and recall.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerPrimaryBaseUrl: PRIMARY_BASE_URL,
          providerPrimaryModel: PRIMARY_MODEL,
          providerFallbackApiKey: FALLBACK_KEY,
          providerFallbackBaseUrl: FALLBACK_BASE_URL,
          providerFallbackModel: FALLBACK_MODEL,
          now: pinnedNow(1_700_000_000_010),
        },
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
          }),
        ),
      );
      const outcome = await runRememberController(
        handle,
        "Curion provider policy update: we no longer use MiniMax as the default provider. Use NVIDIA NIM openai/gpt-oss-120b as the only default provider for remember and recall. This new policy supersedes the previous MiniMax provider policy.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerPrimaryBaseUrl: PRIMARY_BASE_URL,
          providerPrimaryModel: PRIMARY_MODEL,
          providerFallbackApiKey: FALLBACK_KEY,
          providerFallbackBaseUrl: FALLBACK_BASE_URL,
          providerFallbackModel: FALLBACK_MODEL,
          now: pinnedNow(1_700_000_000_011),
        },
      );
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");
      assert.equal(outcome.record.id, 5, "NVIDIA policy should have id 5");

      // Verify new row (id 5) has supersedes: [4]
      const newRow = handle.db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(5) as { metadata: string };
      const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
      const newRel = newParsed.relationship as Record<string, unknown>;
      assert.deepEqual(
        newRel.supersedes,
        [4],
        "new NVIDIA policy must supersede the immediate old MiniMax policy (id 4)",
      );

      // Verify old row (id 4) has supersededBy: [5]
      const oldRow = handle.db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(4) as { metadata: string };
      const oldParsed = JSON.parse(oldRow.metadata) as Record<string, unknown>;
      const oldRel = oldParsed.relationship as Record<string, unknown>;
      assert.deepEqual(
        oldRel.supersededBy,
        [5],
        "old MiniMax policy must have supersededBy pointing to new NVIDIA policy",
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
          }),
        ),
      );
      await runRememberController(handle, "Database decision.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerPrimaryBaseUrl: PRIMARY_BASE_URL,
        providerPrimaryModel: PRIMARY_MODEL,
        providerFallbackApiKey: FALLBACK_KEY,
        providerFallbackBaseUrl: FALLBACK_BASE_URL,
        providerFallbackModel: FALLBACK_MODEL,
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
          }),
        ),
      );
      const outcome = await runRememberController(
        handle,
        "Provider policy: use NVIDIA NIM as default.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerPrimaryBaseUrl: PRIMARY_BASE_URL,
          providerPrimaryModel: PRIMARY_MODEL,
          providerFallbackApiKey: FALLBACK_KEY,
          providerFallbackBaseUrl: FALLBACK_BASE_URL,
          providerFallbackModel: FALLBACK_MODEL,
          now: pinnedNow(2),
        },
      );
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");

      // Verify new row does NOT have supersedes (unrelated topic)
      const newRow = handle.db
        .prepare("SELECT metadata FROM memories WHERE id = ?")
        .get(2) as { metadata: string };
      const newParsed = JSON.parse(newRow.metadata) as Record<string, unknown>;
      const newRel = newParsed.relationship as Record<string, unknown> | undefined;
      assert.ok(
        !newRel || !("supersedes" in newRel) || (Array.isArray(newRel.supersedes) && newRel.supersedes.length === 0),
        "unrelated old memory must not be superseded",
      );
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});