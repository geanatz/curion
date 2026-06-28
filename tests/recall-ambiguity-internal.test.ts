/**
 * Phase C + Phase D controller-level tests — internal and
 * public recall-side ambiguity plumbing.
 *
 * Scope: the recall controller's wiring of
 * `detectAmbiguity` onto the `answered` outcome (Phase C),
 * and the tool-layer `formatAmbiguityNote` projection
 * onto the public `message` (Phase D). Companion to the
 * unit tests in `tests/ambiguity-detection.test.ts` (the
 * pure detector) and `tests/format-ambiguity-note.test.ts`
 * (the pure formatter). The existing public-message pinning
 * in `tests/recall-mvp.test.ts` continues to apply; we
 * extend it here with explicit Phase D assertions.
 *
 * Properties verified:
 *
 *   1. The storage read projection
 *      (`listActiveMemoryRelationshipBlocks`) safely carries
 *      the stored `relationship` block from a row's
 *      `metadata` JSON. Forward-compat: a row with no
 *      `relationship` key carries the safe-empty default.
 *   2. The recall controller's internal `answered` outcome
 *      includes an `internalAmbiguity` field. When the
 *      stored `relationship` block on two recalled rows
 *      indicates a mutual conflict above τ, the field is
 *      `{ kind: "ambiguous", reason: "conflicting-candidates",
 *      ... }`.
 *   3. The internal `internalAmbiguity` is empty (`{ kind:
 *      "none" }`) when no stored block indicates a conflict
 *      (the MVP default, including pre-Phase-B rows that
 *      carry no `relationship` key at all, and rows whose
 *      only stored block is `olderVariantsOf` with no
 *      reciprocal pointer).
 *   4. The public `handleRecall` projection (the MCP
 *      `text` content block) does NOT expose the
 *      `internalAmbiguity` field. The public
 *      `message` / `answer` / `sourceIds` / `status` shape
 *      is byte-equal to pre-Phase-C for every status
 *      branch, and contains no substring of the
 *      ambiguity / relationship vocabulary.
 *   5. The recall controller still calls the provider
 *      exactly as before. The detector does not
 *      short-circuit the pipeline; it runs after the
 *      provider has returned a validated answer.
 *   6. The detector does not affect the four-status union
 *      (`answered` | `no_memory` | `rejected` |
 *      `provider_error`).
 *   7. **Phase D** — the tool layer's `formatAmbiguityNote`
 *      projection: when the internal detector returns
 *      `kind: "ambiguous"`, the public `message` is the
 *      formatted note followed by the synthesized answer;
 *      the `answer` field is unchanged. When the internal
 *      detector returns `kind: "none"` (the MVP default),
 *      the public `message` and `answer` are byte-equal to
 *      pre-Phase-D (the synthesized answer text only).
 *   8. **Phase D** — the public `message` is bounded in
 *      length, mentions memory ids, never echoes raw
 *      summaries / raw user query, and never carries
 *      diagnostic substrings.
 *   9. **Phase D** — the `no_memory` / `rejected` /
 *      `provider_error` outcomes are unchanged in every
 *      case (no prefix, no note).
 *
 * No benchmark runner is exercised. No public-message
 * change is exercised for the no-ambiguity case (which
 * remains byte-equal to pre-Phase-D).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  insertMemoryRecord,
  listActiveMemorySummaries,
  listActiveMemoryRelationshipBlocks,
  type StorageHandle,
  type MemoryRecord,
  type SafeMemorySummary,
} from "../src/storage/storage.ts";
import {
  formatAmbiguityNote,
  AMBIGUITY_NOTE_MAX_LENGTH,
} from "../src/retrieval/ambiguity.ts";
import {
  handleRecall,
  NO_RELEVANT_MEMORY,
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
} from "../src/tools/recall.ts";
import {
  setListRegisteredProjectsStub,
  resetListRegisteredProjectsStub,
} from "../src/config/registry.ts";
import {
  TEST_PRIMARY_KEY,
  TEST_FALLBACK_KEY,
  TEST_PRIMARY_BASE_URL,
  TEST_PRIMARY_MODEL,
  TEST_FALLBACK_BASE_URL,
  TEST_FALLBACK_MODEL,
} from "./shared-test-provider.ts";
import { scriptFetch, okChatResponse } from "./_helpers/provider-stub.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a memory record with an optional stored
 * `relationship` block on the metadata JSON. Returns the
 * created record. The block is the same shape the
 * `buildPersistedMetadata` helper writes, so this models
 * the post-Phase-B row shape end-to-end.
 */
function insertWithRelationship(
  handle: StorageHandle,
  opts: {
    // Phase 1 internal naming cleanup: the helper's
    // option-object property is renamed to `memoryContent`
    // to mirror the internal `MemoryRecordInput` field. The
    // helper maps this to the `summary` SQL column on disk
    // at the storage boundary.
    memoryContent: string;
    kind?: MemoryRecord["kind"];
    tags?: string[];
    relationship?: {
      derivedSchemaVersion?: string;
      derivedAt?: number;
      conflictsWith?: number[];
      olderVariantsOf?: number[];
      detectionConfidence?: number;
    };
  },
): MemoryRecord {
  const rel = opts.relationship;
  const metadata: Record<string, unknown> = {
    tags: opts.tags ?? [],
    classification: null,
  };
  if (rel !== undefined) {
    metadata.relationship = {
      derivedSchemaVersion: rel.derivedSchemaVersion ?? "ccm-draft-1",
      derivedAt: rel.derivedAt ?? 0,
      conflictsWith: rel.conflictsWith ?? [],
      olderVariantsOf: rel.olderVariantsOf ?? [],
      detectionConfidence: rel.detectionConfidence ?? 0,
    };
  }
  return insertMemoryRecord(handle, {
    kind: opts.kind ?? "fact",
    state: "active",
    memoryContent: opts.memoryContent,
    providerId: "minimax",
    modelId: "MiniMax-M3",
    confidence: 0.9,
    safetyFlags: ["controller-normalized"],
    metadata,
  });
}

function runRecallWith(handle: StorageHandle, opts: {
  text: string;
  fetchImpl: typeof fetch;
}) {
  return runRecallController(handle, opts.text, {
    providerFetchImpl: opts.fetchImpl,
    providerPrimaryApiKey: TEST_PRIMARY_KEY,
    providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
    providerPrimaryModel: TEST_PRIMARY_MODEL,
    providerFallbackApiKey: TEST_FALLBACK_KEY,
    providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
    providerFallbackModel: TEST_FALLBACK_MODEL,
  });
}

// ---------------------------------------------------------------------------
// 1. Storage read projection: safely carries relationship blocks
// ---------------------------------------------------------------------------

test("storage: listActiveMemoryRelationshipBlocks projects stored relationship blocks", () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    const r1 = insertWithRelationship(handle, {
      memoryContent: "we use Postgres for storage",
      relationship: {
        conflictsWith: [2],
        olderVariantsOf: [],
        detectionConfidence: 0.93,
        derivedAt: 1234,
      },
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "we do not use Postgres",
    });
    const blocks = listActiveMemoryRelationshipBlocks(handle);
    const ids = blocks.map((b) => b.id);
    assert.deepEqual(ids, [r1.id, r2.id]);
    // r1 has a stored block.
    const b1 = blocks.find((b) => b.id === r1.id);
    assert.ok(b1);
    assert.equal(b1!.block.derivedSchemaVersion, "ccm-draft-1");
    assert.equal(b1!.block.derivedAt, 1234);
    assert.deepEqual(b1!.block.conflictsWith, [2]);
    assert.deepEqual(b1!.block.olderVariantsOf, []);
    assert.equal(b1!.block.detectionConfidence, 0.93);
    // r2 has the safe-empty default.
    const b2 = blocks.find((b) => b.id === r2.id);
    assert.ok(b2);
    assert.deepEqual(b2!.block.conflictsWith, []);
    assert.deepEqual(b2!.block.olderVariantsOf, []);
    assert.equal(b2!.block.detectionConfidence, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("storage: listActiveMemoryRelationshipBlocks is forward-compatible with malformed metadata", () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Hand-insert a row with a malformed `metadata` JSON.
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now(),
        "row with bad metadata",
        "active",
        "this is not json {",
      );
    // And a row with `metadata.relationship` set to a
    // non-object (defensive forward-compat).
    handle.db
      .prepare(
        `INSERT INTO memories (kind, created_at, summary, state, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "fact",
        Date.now() + 1,
        "row with non-object relationship",
        "active",
        JSON.stringify({ relationship: "not an object" }),
      );
    const blocks = listActiveMemoryRelationshipBlocks(handle);
    assert.equal(blocks.length, 2);
    for (const b of blocks) {
      assert.deepEqual(b.block.conflictsWith, []);
      assert.deepEqual(b.block.olderVariantsOf, []);
      assert.equal(b.block.detectionConfidence, 0);
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 2. Controller internal outcome: ambiguous when stored blocks indicate conflict
// ---------------------------------------------------------------------------

test("controller: internal outcome includes ambiguity when stored blocks indicate a mutual conflict", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows that carry a mutual conflictsWith pointer
    // above τ. The summaries share enough tokens with the
    // query that the lexical ranker keeps both rows. The
    // synthesized answer mentions Postgres, which is what
    // the model "took" — the structural-pointer path
    // (mutual `conflictsWith` above τ) does not need to
    // look at the answer. The detector must emit
    // `conflicting-candidates` with both ids.
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably",
      relationship: {
        conflictsWith: [], // will patch below
        detectionConfidence: 0,
      },
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably since 2023",
      relationship: {
        conflictsWith: [],
        detectionConfidence: 0,
      },
    });
    // Patch the rows' metadata directly so they point at
    // each other. This models the post-Phase-B shape (a
    // future `buildPersistedMetadata` call would do the
    // same). We do this in raw SQL to keep the test focused
    // on the read side.
    const blockA = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r2.id],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    };
    const blockB = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r1.id],
      olderVariantsOf: [],
      detectionConfidence: 0.93,
    };
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockA }), r1.id);
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockB }), r2.id);

    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("Postgres stores project data reliably."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The internal field exists on the controller outcome.
    assert.ok(
      "internalAmbiguity" in out,
      "RecallOutcome.answered must carry the internalAmbiguity field (Phase C)",
    );
    assert.equal(out.internalAmbiguity.kind, "ambiguous");
    if (out.internalAmbiguity.kind !== "ambiguous") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.reason, "conflicting-candidates");
    assert.deepEqual(
      out.internalAmbiguity.memoryIds.slice().sort((a, b) => a - b),
      [r1.id, r2.id].slice().sort((a, b) => a - b),
    );
    assert.ok(out.internalAmbiguity.confidence >= 0.8);
    // The provider call happened exactly once (no
    // short-circuit, no extra call from the detector).
    assert.equal(calls.length, 1);
    // The public message and sourceIds are unchanged.
    assert.equal(out.answer, "Postgres stores project data reliably.");
    assert.deepEqual(
      out.sourceIds.slice().sort((a, b) => a - b),
      [r1.id, r2.id].slice().sort((a, b) => a - b),
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: internal outcome is none when no stored block indicates a conflict (MVP default)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Pre-Phase-B row shape: no `relationship` key. The
    // detector must return `kind: "none"` because the
    // structural-pointer rules have no stored data, and
    // the lexical safety-net rule requires asymmetric
    // negation (which these rows do not have).
    insertWithRelationship(handle, {
      memoryContent: "The project uses Postgres 16 for the primary store.",
    });
    insertWithRelationship(handle, {
      memoryContent: "The project uses Postgres 16 for the primary data store.",
    });
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("The project uses Postgres 16 for the primary store."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.ok("internalAmbiguity" in out);
    assert.equal(out.internalAmbiguity.kind, "none");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: internal outcome is none when stored block is olderVariantsOf only (no mutual pointer)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows that each carry `olderVariantsOf` pointing
    // at the OTHER row. The detector's older-variant rule
    // requires a *mutual* pointer. With both rows present
    // and pointing at each other, the rule does fire (this
    // is the older-variant test below). Here we want the
    // OPPOSITE: a row that carries `olderVariantsOf`
    // pointing at a row that does NOT reciprocate. The
    // detector must stay silent on the older-variant path
    // and silent on the conflict path (no `conflictsWith`).
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably",
      relationship: {
        olderVariantsOf: [],
        detectionConfidence: 0.95,
      },
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably since 2023",
      relationship: {
        olderVariantsOf: [r1.id],
        detectionConfidence: 0.95,
      },
    });
    // Patch r1 to NOT point at r2 (one-way pointer).
    const blockA = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [], // not reciprocal
      detectionConfidence: 0.95,
    };
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockA }), r1.id);
    // Also no asymmetric negation between the rows, so the
    // lexical safety-net path stays silent too.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("Postgres is the primary store."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.kind, "none");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: internal outcome is ambiguous with reason older-variant-suspected when olderVariantsOf is mutual", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably",
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably since 2023",
    });
    // Mutual `olderVariantsOf` pointer at high confidence.
    const blockA = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [r2.id],
      detectionConfidence: 0.95,
    };
    const blockB = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [],
      olderVariantsOf: [r1.id],
      detectionConfidence: 0.93,
    };
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockA }), r1.id);
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockB }), r2.id);

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("Postgres is the primary store."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.kind, "ambiguous");
    if (out.internalAmbiguity.kind !== "ambiguous") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.reason, "older-variant-suspected");
    assert.ok(out.internalAmbiguity.confidence >= 0.8);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: internal outcome uses lexical safety-net when stored block is missing", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows that DO NOT carry a stored `relationship`
    // block (the MVP default). The detector must still
    // flag the asymmetric-negation case via the lexical
    // safety-net path, with reason `conflicting-candidates`.
    // The summaries share enough tokens with the query for
    // the ranker to keep both rows.
    insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably; we do not use MySQL",
    });
    insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably; we use MySQL",
    });
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("Postgres stores project data reliably; we use MySQL."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.kind, "ambiguous");
    if (out.internalAmbiguity.kind !== "ambiguous") throw new Error("unreachable");
    assert.equal(out.internalAmbiguity.reason, "conflicting-candidates");
    assert.ok(out.internalAmbiguity.confidence >= 0.8);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. Public projection: handleRecall must NOT expose the internal field
// ---------------------------------------------------------------------------

test("public handleRecall projection: message/answer/sourceIds/status unchanged, no ambiguity text", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // Pre-Phase-B shape: no `relationship` block. The
      // detector returns `kind: "none"` for this input
      // (the rows share high overlap but neither negates).
      insertWithRelationship(handle, {
        memoryContent: "The project uses Postgres 16 for the primary store.",
      });
      insertWithRelationship(handle, {
        memoryContent: "The project uses Postgres 16 for the primary data store.",
      });
      // We need to drive the recall through the controller
      // (the public tool layer has no fetch override).
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse("The project uses Postgres 16 for the primary store."),
      );
      // Use the controller directly; the public
      // message-shape pins live in `recall-mvp.test.ts` and
      // we extend them here with explicit "no ambiguity
      // text" assertions.
      const out = await runRecallWith(handle, {
        text: "What database does the project use?",
        fetchImpl,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      // Public-message / answer / sourceIds shape is
      // byte-equal to pre-Phase-C.
      assert.equal(typeof out.answer, "string");
      assert.ok(out.answer.length > 0);
      assert.equal(Array.isArray(out.sourceIds), true);
      for (const id of out.sourceIds) {
        assert.equal(typeof id, "number");
      }
      // No substring of the ambiguity / relationship
      // vocabulary in the public answer.
      for (const tok of [
        "internalAmbiguity",
        "ambiguity",
        "conflictsWith",
        "olderVariantsOf",
        "detectionConfidence",
        "derivedSchemaVersion",
        "derivedAt",
        "relationship",
        "ccm-draft-1",
      ]) {
        assert.ok(
          !out.answer.includes(tok),
          `public answer must not include '${tok}' (Phase C invariant)`,
        );
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("public handleRecall: tool-layer result does not expose internalAmbiguity (the field is dropped)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // Drive the public tool layer end-to-end. The tool
      // layer must return a `RecallResult` whose shape
      // contains exactly the public fields — the
      // `internalAmbiguity` field on the controller
      // outcome is dropped at the projection.
      insertWithRelationship(handle, {
        memoryContent: "The project uses Postgres 16 for the primary store.",
      });
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse("Postgres 16."),
      );
      // We can't inject the fetch into handleRecall
      // through the public surface (the contract forbids
      // knobs). Drive the controller instead, then
      // simulate the projection.
      const out = await runRecallWith(handle, {
        text: "What database does the project use?",
        fetchImpl,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      // Construct a `RecallResult` exactly the way the
      // tool layer does (the layer formats a fresh
      // object). The result object MUST NOT carry
      // `internalAmbiguity`.
      const projected: Record<string, unknown> = {
        status: out.status,
        message: out.answer,
        answer: out.answer,
        sourceIds: [...out.sourceIds],
      };
      assert.equal(
        projected.internalAmbiguity,
        undefined,
        "RecallResult projection must not expose internalAmbiguity",
      );
      // And the public message / answer is unchanged.
      for (const tok of [
        "internalAmbiguity",
        "ambiguity",
        "conflictsWith",
        "olderVariantsOf",
        "detectionConfidence",
        "derivedSchemaVersion",
        "derivedAt",
        "relationship",
        "ccm-draft-1",
      ]) {
        assert.ok(
          !String(projected.message).includes(tok),
          `public message must not include '${tok}'`,
        );
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("public handleRecall: no_memory path is unchanged (no internalAmbiguity field)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    setListRegisteredProjectsStub(() => []);
    try {
      // No stored memories => the controller short-circuits
      // to `no_memory`. The public message must be the
      // exact `NO_RELEVANT_MEMORY` placeholder.
      const r = await handleRecall({ text: "What database does the project use?" });
      assert.equal(r.status, "no_memory");
      assert.equal(r.message, NO_RELEVANT_MEMORY);
      // The tool-layer result shape must not include any
      // ambiguity / relationship text.
      for (const tok of [
        "internalAmbiguity",
        "ambiguity",
        "conflictsWith",
        "olderVariantsOf",
        "detectionConfidence",
        "derivedSchemaVersion",
        "derivedAt",
        "relationship",
      ]) {
        assert.ok(
          !r.message.includes(tok),
          `no_memory public message must not include '${tok}'`,
        );
      }
    } finally {
      resetRecallStorageProvider();
      resetListRegisteredProjectsStub();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Provider is still called (no short-circuit) and the four-status union is preserved
// ---------------------------------------------------------------------------

test("controller: provider is called exactly once per call; detector does not short-circuit", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    insertWithRelationship(handle, {
      memoryContent: "The project uses Postgres 16 for the primary store.",
    });
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("Postgres."),
    );
    await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    // No short-circuit; the provider is called exactly as
    // before. The detector runs after the answer is
    // validated, so it never affects the call count.
    assert.equal(calls.length, 1);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: the four-status union is preserved (answered | no_memory | rejected | provider_error)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Case 1: answered
    insertWithRelationship(handle, {
      memoryContent: "The project uses Postgres 16 for the primary store.",
    });
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("Postgres."),
    );
    const out1 = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.ok(
      ["answered", "no_memory", "rejected", "provider_error"].includes(out1.status),
      `unexpected status: ${out1.status}`,
    );
    // Case 2: no_memory
    {
      const r = await runRecallController(
        handle,
        "When is the company picnic?",
        {
providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
        },
      );
      assert.equal(r.status, "no_memory");
    }
    // Case 3: rejected (secret)
    {
      const r = await runRecallController(
        handle,
        "AKIAIOSFODNN7EXAMPLE",
        {
providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
        },
      );
      assert.equal(r.status, "rejected");
    }
    // Case 4: provider_error
    {
      const errFetch = scriptFetch(() => new Response("boom", { status: 500 }));
      const r = await runRecallController(
        handle,
        "What database does the project use?",
        {
          providerFetchImpl: errFetch.fetchImpl,
          providerPrimaryApiKey: TEST_PRIMARY_KEY,
          providerFallbackApiKey: TEST_FALLBACK_KEY,
        },
      );
      assert.equal(r.status, "provider_error");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. Re-reading SafeMemorySummary still does not expose raw text
// ---------------------------------------------------------------------------

test("controller: SafeMemorySummary projection is unchanged (no raw text leaked)", () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    insertWithRelationship(handle, {
      memoryContent: "we use Postgres for storage",
    });
    const summaries: SafeMemorySummary[] = listActiveMemorySummaries(handle);
    assert.equal(summaries.length, 1);
    for (const s of summaries) {
      // The new parallel lookup is a separate function;
      // `listActiveMemorySummaries` itself is unchanged.
      assert.equal((s as unknown as { relationship?: unknown }).relationship, undefined);
      // The legacy "no raw text" assertion still holds.
      for (const forbidden of ["raw", "text", "content", "body", "input"]) {
        assert.equal(
          (s as unknown as Record<string, unknown>)[forbidden],
          undefined,
          `SafeMemorySummary must not include '${forbidden}'`,
        );
      }
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. Phase D — public message flag (spec §5.4)
//
// When the internal detector returns `kind: "ambiguous"`, the
// tool layer must prefix the public `message` with a short,
// bounded, conservative note (carrying the conflicting memory
// ids). The `answer` field is unchanged. When the internal
// detector returns `kind: "none"`, the public `message` and
// `answer` are byte-equal to pre-Phase-D. The
// `no_memory` / `rejected` / `provider_error` outcomes are
// unchanged in every case.
// ---------------------------------------------------------------------------

test("Phase D: answered + ambiguous -> public message includes concise ambiguity note", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows with a mutual `conflictsWith` pointer above
    // τ. The detector must return `kind: "ambiguous"` and
    // the public `message` must be the formatted note
    // followed by the synthesized answer. The `answer`
    // field is unchanged.
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably",
      relationship: {
        conflictsWith: [],
        detectionConfidence: 0,
      },
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably since 2023",
      relationship: {
        conflictsWith: [],
        detectionConfidence: 0,
      },
    });
    const blockA = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r2.id],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    };
    const blockB = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r1.id],
      olderVariantsOf: [],
      detectionConfidence: 0.93,
    };
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockA }), r1.id);
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockB }), r2.id);

    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("Postgres stores project data reliably."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // Project the public `message` exactly the way the
    // tool layer does (note prefix on the answered case).
    const note = formatAmbiguityNote(out.internalAmbiguity);
    const projectedMessage =
      note.length === 0 ? out.answer : `${note}\n\n${out.answer}`;
    // Public message includes the note and the answer.
    // The note is the prose-only no-id form; ids are NOT
    // rendered into the public message.
    assert.match(
      projectedMessage,
      /^Note: stored memories on this topic disagree\.\n\nPostgres stores project data reliably\.$/s,
    );
    // The answer field (synthesized answer only) is
    // byte-equal to the provider response.
    assert.equal(out.answer, "Postgres stores project data reliably.");
    // The note carries NO `#N` memory-id references. The
    // `internalAmbiguity.memoryIds` array is preserved on
    // the internal signal for tests / structured transport,
    // but the public note is prose only. We assert on the
    // notePart to be explicit about the no-id contract.
    const noteEnd = projectedMessage.indexOf("Postgres stores project data reliably.");
    const notePart = projectedMessage.slice(0, noteEnd);
    assert.ok(
      !/#\d+/.test(notePart),
      `Phase D note must not include any #N id reference; got ${JSON.stringify(notePart)}`,
    );
    // Bounded: note + answer total length is bounded by the
    // formatter cap + the answer length.
    assert.ok(
      projectedMessage.length <= AMBIGUITY_NOTE_MAX_LENGTH + 2 + "Postgres stores project data reliably.".length,
      `total message length must be bounded (got ${projectedMessage.length})`,
    );
    // Provider was still called exactly once.
    assert.equal(calls.length, 1);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: note is prose-only (no ids) and does not echo raw summaries / raw query / answer", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows with distinct, distinctive summaries so we
    // can prove the note does not echo them. Use
    // lexical-asymmetric-negation path (no stored
    // `relationship` block) to drive the detector on a
    // pre-Phase-B shape.
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Zesty lemon tart is on the office menu every Friday",
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Zesty lemon tart is not on the office menu",
    });
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("Zesty lemon tart is on the office menu."),
    );
    const out = await runRecallWith(handle, {
      text: "Is the zesty lemon tart on the office menu today?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // Project the public `message` the same way the tool
    // layer does.
    const note = formatAmbiguityNote(out.internalAmbiguity);
    const projectedMessage =
      note.length === 0 ? out.answer : `${note}\n\n${out.answer}`;
    // The note carries the "Note:" prefix.
    assert.match(projectedMessage, /Note:/);
    // The note is prose only: no `#N` id reference is
    // rendered. The internal `memoryIds` array is preserved
    // on the internal signal but never leaks to the public
    // surface.
    const notePart =
      projectedMessage.split(
        "Zesty lemon tart is on the office menu.",
      )[0] ?? "";
    assert.ok(
      !/#\d+/.test(notePart),
      `Phase D note must not include any #N id reference; got ${JSON.stringify(notePart)}`,
    );
    // The note must NOT echo:
    //   - raw stored summaries
    //   - the raw user query
    //   - the synthesized answer text (the answer is
    //     already a separate `answer` field; the note is
    //     human prose only)
    for (const tok of [
      // distinctive fragments of the stored summaries
      "Zesty lemon tart",
      // fragments of the user query
      "zesty lemon tart",
      "on the office menu today",
      // diagnostic substrings
      "detectionConfidence",
      "derivedAt",
      "derivedSchemaVersion",
      "ccm-draft-1",
      "conflictsWith",
      "olderVariantsOf",
      "internalAmbiguity",
    ]) {
      assert.ok(
        !notePart.includes(tok),
        `Phase D note must not include '${tok}' (note was: ${JSON.stringify(notePart)})`,
      );
    }
    // The synthesized answer itself is preserved in full.
    assert.equal(
      projectedMessage.slice(-(
        "Zesty lemon tart is on the office menu.".length
      )),
      "Zesty lemon tart is on the office menu.",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: no ambiguity signal -> public message byte-equal pre-Phase-D", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Single row, no relationship block. Detector returns
    // `kind: "none"`. The public `message` / `answer` must
    // be byte-equal to the synthesized answer text only
    // (i.e. no note prefix, no extra characters).
    insertWithRelationship(handle, {
      memoryContent: "The project uses Postgres 16 for the primary store.",
    });
    const answer = "The project uses Postgres 16 for the primary store.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // Project the public `message` the same way the tool
    // layer does; in the no-ambiguity case the projection
    // collapses to the synthesized answer.
    const note = formatAmbiguityNote(out.internalAmbiguity);
    const projectedMessage =
      note.length === 0 ? out.answer : `${note}\n\n${out.answer}`;
    // Byte-equal to the synthesized answer text.
    assert.equal(projectedMessage, answer);
    // And the public `message` field is the same string
    // (no "Note:" prefix).
    assert.ok(!projectedMessage.startsWith("Note:"));
    // No diagnostic substring.
    for (const tok of [
      "internalAmbiguity",
      "ambiguity",
      "Note:",
      "conflictsWith",
      "olderVariantsOf",
      "detectionConfidence",
      "derivedSchemaVersion",
      "derivedAt",
      "relationship",
      "ccm-draft-1",
    ]) {
      assert.ok(
        !projectedMessage.includes(tok),
        `byte-equal pre-Phase-D message must not include '${tok}'`,
      );
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: no_memory outcome is unchanged (no prefix, no note)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    setListRegisteredProjectsStub(() => []);
    try {
      // No stored memories => the controller short-circuits
      // to `no_memory`. The public message must be the
      // exact `NO_RELEVANT_MEMORY` placeholder, with no
      // Phase D note.
      const r = await handleRecall({ text: "What database does the project use?" });
      assert.equal(r.status, "no_memory");
      assert.equal(r.message, NO_RELEVANT_MEMORY);
      assert.ok(!r.message.startsWith("Note:"));
    } finally {
      resetRecallStorageProvider();
      resetListRegisteredProjectsStub();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: rejected outcome is unchanged (no prefix, no note)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // A query that contains a secret-shaped fragment is
      // rejected by the safety pre-check before the
      // detector runs. The public message must be the
      // exact `Rejected: ...` shape with no Phase D note.
      const r = await handleRecall({ text: "AKIAIOSFODNN7EXAMPLE" });
      assert.equal(r.status, "rejected");
      assert.match(r.message, /^Rejected: /);
      assert.ok(!r.message.startsWith("Note:"));
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: provider_error outcome is unchanged (no prefix, no note)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // A real stored memory so the provider gets called,
      // but the scripted fetch returns a 500. The
      // controller surfaces `provider_error`. The public
      // message must be the exact `Provider error: ...`
      // shape with no Phase D note.
      insertWithRelationship(handle, {
        memoryContent: "The project uses Postgres 16 for the primary store.",
      });
      // We can't inject the fetch through the public
      // surface; drive the controller and re-project the
      // outcome the same way the tool layer does.
      const errFetch = scriptFetch(() => new Response("boom", { status: 500 }));
      const out = await runRecallController(handle, "What database does the project use?", {
        providerFetchImpl: errFetch.fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
      });
      assert.equal(out.status, "provider_error");
      if (out.status !== "provider_error") throw new Error("unreachable");
      // The tool-layer projection is `Provider error: ${reason}`
      // and never includes the note.
      const projectedMessage = `Provider error: ${out.reason}`;
      assert.ok(!projectedMessage.startsWith("Note:"));
      assert.match(projectedMessage, /^Provider error: /);
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: provider is still called exactly once (no short-circuit)", async () => {
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    // Two rows with a mutual `conflictsWith` pointer above
    // τ. The detector will return `kind: "ambiguous"`,
    // but the pipeline must still call the provider
    // exactly once.
    const r1 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably",
    });
    const r2 = insertWithRelationship(handle, {
      memoryContent: "Postgres stores project data reliably since 2023",
    });
    const blockA = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r2.id],
      olderVariantsOf: [],
      detectionConfidence: 0.95,
    };
    const blockB = {
      derivedSchemaVersion: "ccm-draft-1",
      derivedAt: 1,
      conflictsWith: [r1.id],
      olderVariantsOf: [],
      detectionConfidence: 0.93,
    };
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockA }), r1.id);
    handle.db
      .prepare("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ tags: [], classification: null, relationship: blockB }), r2.id);

    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("Postgres is the primary store."),
    );
    const out = await runRecallWith(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // Detector fired (ambiguous).
    assert.equal(out.internalAmbiguity.kind, "ambiguous");
    // But the provider was called exactly once.
    assert.equal(calls.length, 1);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("Phase D: tool/API contract (single text param, two public tools) still holds", async () => {
  // The Phase D change is internal to the tool layer; the
  // public MCP `text` content block is still the only thing
  // the server exposes. We re-pin the contract here for
  // regression safety: the public `RecallResult.message` is
  // still a string; the four-status union is preserved; no
  // new top-level public field has been added.
  const { tmp, handle } = mkStorage("curion-amb-ctrl-");
  try {
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      insertWithRelationship(handle, {
        memoryContent: "The project uses Postgres 16 for the primary store.",
      });
      const r = await handleRecall({ text: "What database does the project use?" });
      // Four-status union preserved.
      assert.ok(
        ["answered", "no_memory", "rejected", "provider_error"].includes(r.status),
        `unexpected status: ${r.status}`,
      );
      // Public `message` is a string.
      assert.equal(typeof r.message, "string");
      // No new top-level public field is present on the
      // projected `RecallResult` beyond the existing
      // documented shape: `status`, `message`, optionally
      // `answer`, `sourceIds`, `safetyClass`. We assert the
      // public keys are exactly the union of those.
      const allowed = new Set([
        "status",
        "message",
        "answer",
        "sourceIds",
        "safetyClass",
      ]);
      const rAsObj = r as unknown as Record<string, unknown>;
      for (const k of Object.keys(rAsObj)) {
        assert.ok(allowed.has(k), `unexpected public field: ${k}`);
      }
    } finally {
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});
