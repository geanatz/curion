/**
 * Phase B tests — write-side relationship metadata append.
 *
 * Scope: the controller-side wiring that appends the derived
 * `relationship` block onto the existing `metadata` JSON blob
 * when the seam returns related memories. Companion to the
 * Phase A pure-function tests in `tests/relationship-derivation.test.ts`.
 *
 * Properties verified:
 *
 *   1. `buildPersistedMetadata` preserves the existing metadata
 *      keys (`tags`, `entities`, `classification`,
 *      `providerFallbackUsed`, `llmRepairAttempts`,
 *      `parseStrategy`) when the derived block is appended.
 *   2. When the related-memory seam returns an empty list (the
 *      MVP default), no `relationship` key is written. Existing
 *      behavior is byte-equal to pre-Phase-B for this case.
 *   3. When the seam is overridden to return synthetic related
 *      memories, the persisted `metadata` JSON contains a
 *      `relationship` block with `conflictsWith` /
 *      `olderVariantsOf` / `detectionConfidence` /
 *      `derivedSchemaVersion` / `derivedAt`.
 *   4. The stored `metadata` JSON contains no raw input string
 *      and no raw provider fragment, and `state` remains
 *      `active` (no state transition).
 *   5. The public `RememberResult.message` /
 *      `RememberResult.status` is byte-equal to pre-Phase-B
 *      behavior in all paths exercised here (no public-API
 *      regression).
 *   6. The `derivedAt` timestamp is controller-supplied (via
 *      `options.now`) and is the value persisted in the JSON,
 *      not a clock read inside the pure helper.
 *   7. The existing test surface (public tool params, public
 *      tool names, schema columns) is unchanged.
 *
 * No recall behavior is exercised here. No benchmark runner is
 * touched. No raw input storage is added.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRememberController } from "../src/controller/remember-controller.ts";
import {
  initStorage,
  closeStorage,
  type StorageHandle,
} from "../src/storage/storage.ts";
import { handleRemember } from "../src/tools/remember.ts";
import { buildServer, PUBLIC_TOOL_NAMES } from "../src/server.ts";
import {
  setRelatedMemoriesImpl,
  resetRelatedMemoriesImpl,
} from "../src/retrieval/seam.ts";
import {
  buildPersistedMetadata,
  hasMeaningfulRelationshipData,
  DERIVED_SCHEMA_VERSION,
  type RelationshipMetadataFields,
} from "../src/retrieval/relationship.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-rb-"));
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

// Pin a deterministic `Date.now()` for tests that read the
// persisted `derivedAt`. The seam override also reads from this
// clock for the controller-side wiring.
function pinnedNow(t: number): () => number {
  return () => t;
}

// ---------------------------------------------------------------------------
// 1. buildPersistedMetadata unit tests — preserve existing keys
// ---------------------------------------------------------------------------

test("buildPersistedMetadata: preserves all existing metadata keys", () => {
  const existing = {
    tags: ["postgres", "storage"],
    entities: [{ name: "Postgres", kind: "database" }],
    classification: "fact",
    providerFallbackUsed: false,
    llmRepairAttempts: 0,
    parseStrategy: "primary-direct" as const,
  };
  const derived: RelationshipMetadataFields = {
    conflictsWith: [42],
    olderVariantsOf: [],
    detectionConfidence: 0.91,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1_700_000_000_000,
  };
  const out = buildPersistedMetadata(existing, derived);
  for (const k of [
    "tags",
    "entities",
    "classification",
    "providerFallbackUsed",
    "llmRepairAttempts",
    "parseStrategy",
  ]) {
    assert.deepEqual(out[k], (existing as Record<string, unknown>)[k]);
  }
  // And the relationship block is appended, not merged into the
  // existing keys. The new write literal is `DERIVED_SCHEMA_VERSION`
  // (`"ccm-draft-2"`, Phase I bump); use the constant so the
  // test is robust to a future bump.
  assert.equal(typeof out.relationship, "object");
  assert.equal(
    (out.relationship as Record<string, unknown>).derivedSchemaVersion,
    DERIVED_SCHEMA_VERSION,
  );
  assert.equal(
    (out.relationship as Record<string, unknown>).derivedSchemaVersion,
    "ccm-draft-2",
  );
});

test("buildPersistedMetadata: empty derived fields -> no relationship block", () => {
  const existing = { tags: ["x"], classification: "fact" };
  const derived: RelationshipMetadataFields = {
    conflictsWith: [],
    olderVariantsOf: [],
    detectionConfidence: 0,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1,
  };
  const out = buildPersistedMetadata(existing, derived);
  // No `relationship` key was added.
  assert.equal(out.relationship, undefined);
  // Existing keys are preserved verbatim.
  assert.deepEqual(out.tags, ["x"]);
  assert.equal(out.classification, "fact");
});

test("hasMeaningfulRelationshipData: false for empty arrays; true when any non-empty", () => {
  const empty: RelationshipMetadataFields = {
    conflictsWith: [],
    olderVariantsOf: [],
    detectionConfidence: 0,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 0,
  };
  assert.equal(hasMeaningfulRelationshipData(empty), false);
  assert.equal(
    hasMeaningfulRelationshipData({ ...empty, conflictsWith: [1] }),
    true,
  );
  assert.equal(
    hasMeaningfulRelationshipData({ ...empty, olderVariantsOf: [2] }),
    true,
  );
});

test("buildPersistedMetadata: does not overwrite a pre-existing relationship key", () => {
  // Forward-compat: the first version is additive-only. If a
  // future re-derivation step or migration wrote a
  // `relationship` key first, the helper leaves it alone. This
  // test specifically uses the legacy `ccm-draft-1` literal
  // for the pre-existing block to model a row written under
  // the previous schema version; the helper's append-only
  // rule must respect that block verbatim.
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
  };
  const out = buildPersistedMetadata(existing, derived);
  const rel = out.relationship as Record<string, unknown>;
  assert.equal(rel.derivedAt, 1, "existing relationship block must be preserved");
  assert.deepEqual(rel.conflictsWith, [99]);
});

test("buildPersistedMetadata: malformed existing metadata is treated as {}", () => {
  // Spec §4.4: a malformed JSON blob in the existing column
  // (e.g. an old row written before the helper existed) is
  // treated as `{}` so the derived block still lands.
  for (const bad of [null, undefined, "string", 42, true, [1, 2, 3]] as unknown[]) {
    const out = buildPersistedMetadata(bad as never, {
      conflictsWith: [7],
      olderVariantsOf: [],
      detectionConfidence: 0.9,
      derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
      derivedAt: 3,
    });
    assert.equal(typeof out.relationship, "object");
    const rel = out.relationship as Record<string, unknown>;
    assert.deepEqual(rel.conflictsWith, [7]);
  }
});

test("buildPersistedMetadata: does not mutate the existing object", () => {
  const existing = { tags: ["a"], classification: "fact" };
  const snapshot = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 4,
  };
  buildPersistedMetadata(existing, derived);
  // Existing object was not touched.
  assert.deepEqual(existing, snapshot);
});

// ---------------------------------------------------------------------------
// 2. Controller wiring: empty seam (MVP default) -> no relationship block
// ---------------------------------------------------------------------------

test("controller: default seam returns empty list -> no relationship block in metadata", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() => okChatResponse(safeAnalysis()));
    const outcome = await runRememberController(handle, "Some safe project fact.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const row = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(
      parsed.relationship,
      undefined,
      "no relationship block expected when seam returns empty list",
    );
    // Existing keys are still there.
    assert.deepEqual(parsed.tags, ["postgres", "storage"]);
    assert.equal(parsed.classification, "fact");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. Controller wiring: seam override -> relationship block stored
// ---------------------------------------------------------------------------

test("controller: seam override returns synthetic related memories -> relationship block stored", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Override the seam to return a candidate that the detector
    // will flag as a conflict. The candidate summary "we do not
    // use Postgres ..." has an asymmetric negation marker
    // relative to the related summary "we use Postgres ...".
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1000,
          summary: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "we do not use Postgres for this service in production",
          tags: ["postgres", "storage"],
        }),
      ),
    );
    const pinnedTime = 1_700_000_000_000;
    const outcome = await runRememberController(
      handle,
      "Some safe project fact.",
      {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
        now: pinnedNow(pinnedTime),
      },
    );
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const row = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string; state: string };

    // Older memories are NOT state-transitioned. The newly
    // inserted row is `active`. We don't write `superseded` or
    // `invalidated` anywhere.
    assert.equal(row.state, "active");

    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    // Existing keys preserved.
    assert.deepEqual(parsed.tags, ["postgres", "storage"]);
    assert.equal(parsed.classification, "fact");
    // Relationship block is present and well-formed. The
    // schema version is the Phase I new-write literal
    // (`"ccm-draft-2"`, exported as `DERIVED_SCHEMA_VERSION`).
    assert.equal(typeof parsed.relationship, "object");
    const rel = parsed.relationship as Record<string, unknown>;
    assert.equal(rel.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
    assert.equal(rel.derivedSchemaVersion, "ccm-draft-2");
    assert.equal(rel.derivedAt, pinnedTime);
    assert.deepEqual(rel.conflictsWith, [1000]);
    assert.deepEqual(rel.olderVariantsOf, []);
    assert.equal(typeof rel.detectionConfidence, "number");
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Stored metadata contains no raw input
// ---------------------------------------------------------------------------

test("controller: stored metadata does not contain raw input string (Phase B invariant)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 2000,
          summary: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override",
    }));

    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "we do not use Postgres for this service in production",
        }),
      ),
    );
    const rawText =
      "We picked Postgres 16 for the primary data store because of better JSON support.";
    const outcome = await runRememberController(handle, rawText, {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
      now: pinnedNow(1_700_000_000_000),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    const dbRows = handle.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(outcome.record.id) as Record<string, unknown>;
    for (const [k, v] of Object.entries(dbRows)) {
      if (typeof v === "string") {
        assert.ok(
          !v.includes(rawText),
          `persisted column '${k}' must not contain the raw input`,
        );
        // The provider-returned summary text must also not be
        // present in any non-summary column.
        if (k !== "summary") {
          assert.ok(
            !v.includes("we do not use Postgres"),
            `non-summary column '${k}' must not echo the provider summary verbatim`,
          );
        }
      }
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. Public remember/recall tool result shape unchanged
// ---------------------------------------------------------------------------

test("public remember tool result shape is unchanged with seam override (status, message)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 3000,
          summary: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override",
    }));
    const { setStorageProvider, resetStorageProvider } = await import(
      "../src/tools/remember.ts"
    );
    setStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: "we do not use Postgres for this service in production",
          }),
        ),
      );
      // The tool layer accepts a fetch override indirectly by
      // calling the controller; the easiest path here is to use
      // the controller directly. The tool surface is verified
      // by the existing remember-mvp tests, so we use the
      // controller and check the structured result.
      const r = await runRememberController(handle, "Some safe fact.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
        now: pinnedNow(1_700_000_000_000),
      });
      assert.equal(r.status, "saved");
      if (r.status !== "saved") throw new Error("unreachable");
      // The public message shape is unchanged: it does not
      // mention `relationship`, `conflictsWith`,
      // `olderVariantsOf`, `detectionConfidence`, or
      // `derivedSchemaVersion`. The controller's saved
      // message format is the no-id form: `saved (kind,
      // confidence 0.95)` — the memory id is an internal
      // storage handle and is NOT part of the on-the-wire
      // public message (it remains on the returned
      // `record.id` for tests and structured transport).
      assert.match(
        r.message,
        /^saved \([a-z]+, confidence \d+\.\d{2}\)$/,
      );
      assert.ok(!r.message.includes("relationship"));
      assert.ok(!r.message.includes("conflictsWith"));
      assert.ok(!r.message.includes("olderVariantsOf"));
      assert.ok(!r.message.includes("detectionConfidence"));
      assert.ok(!r.message.includes("derivedSchemaVersion"));
      // No memory id in the public message.
      assert.ok(
        !/#\d+/.test(r.message),
        `public message must not include a #N id; got ${JSON.stringify(r.message)}`,
      );
    } finally {
      resetStorageProvider();
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

test("public tool surface is still exactly remember + recall", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

test("remember tool: still exposes exactly one text param", () => {
  const server = buildServer();
  const registered = (server as unknown as {
    _registeredTools: Record<string, { inputSchema: unknown }>;
  })._registeredTools;
  const remember = registered["remember"] as {
    inputSchema: {
      _def?: { shape?: () => Record<string, unknown> };
    };
  };
  const shape = remember.inputSchema._def?.shape?.();
  assert.ok(shape);
  assert.deepEqual(Object.keys(shape), ["text"]);
});

test("storage: memories table never has a raw/original text column (no schema migration)", () => {
  const { tmp, handle } = mkStorage();
  try {
    const cols = handle.db
      .prepare("PRAGMA table_info(memories)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const forbidden of [
      "raw_text",
      "raw",
      "original_text",
      "original",
      "input",
      "text",
      "content",
      "body",
      "source",
    ]) {
      assert.ok(
        !names.includes(forbidden),
        `memories must not have a '${forbidden}' column`,
      );
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. derivedAt is controller-supplied, not derived from a clock inside the helper
// ---------------------------------------------------------------------------

test("controller: derivedAt is the value the controller passed via options.now", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 4000,
          summary: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override",
    }));
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: "we do not use Postgres for this service in production",
        }),
      ),
    );
    const t = 1_650_000_000_000;
    const outcome = await runRememberController(handle, "Some safe fact.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
      now: pinnedNow(t),
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const row = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string };
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    const rel = parsed.relationship as Record<string, unknown>;
    assert.equal(rel.derivedAt, t);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 7. older memories are not state-transitioned
// ---------------------------------------------------------------------------

test("controller: pre-existing active rows are not state-transitioned by a new insert", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert one safe memory.
    {
      const { fetchImpl } = scriptFetch(() => okChatResponse(safeAnalysis()));
      const r1 = await runRememberController(handle, "First safe fact.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
        now: pinnedNow(1),
      });
      assert.equal(r1.status, "saved");
    }
    // Insert another memory. The first row's `state` must still
    // be `active` after the second insert. We do NOT couple
    // `olderVariantsOf` / `conflictsWith` to a state transition
    // in Phase B (spec §7: all memories remain `active`).
    {
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({ summary: "A second fact for storage." }),
        ),
      );
      const r2 = await runRememberController(handle, "Second safe fact.", {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
        now: pinnedNow(2),
      });
      assert.equal(r2.status, "saved");
    }

    const states = handle.db
      .prepare("SELECT state FROM memories ORDER BY id ASC")
      .all() as Array<{ state: string }>;
    assert.equal(states.length, 2);
    for (const s of states) {
      assert.equal(s.state, "active");
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 8. Seam override reset path — default behavior restored
// ---------------------------------------------------------------------------

test("controller: after seam override reset, the seam returns the MVP empty list", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [{ id: 5000, summary: "anything" }],
      reason: "test override",
    }));
    // Reset back to default.
    resetRelatedMemoriesImpl();
    const { fetchImpl } = scriptFetch(() => okChatResponse(safeAnalysis()));
    const r = await runRememberController(handle, "Some safe fact.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(r.status, "saved");
    if (r.status !== "saved") throw new Error("unreachable");
    const row = handle.db
      .prepare("SELECT metadata FROM memories WHERE id = ?")
      .get(r.record.id) as { metadata: string };
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(parsed.relationship, undefined);
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 9. Controller does not import benchmark experiment modules
// ---------------------------------------------------------------------------

test("relationship metadata write: remember-controller does not import benchmark experiment modules", async () => {
  const fsP = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const srcPath = pathMod.resolve(here, "../src/controller/remember-controller.ts");
  const text = await fsP.readFile(srcPath, "utf8");
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
  for (const tok of forbidden) {
    assert.equal(
      text.includes(tok),
      false,
      `remember-controller.ts must not reference benchmark experiment module "${tok}"`,
    );
  }
  assert.equal(
    /from\s+["'][^"']*benchmark\//.test(text),
    false,
    "remember-controller.ts must not import from src/benchmark/",
  );
});

// ---------------------------------------------------------------------------
// 10. handleRemember (tool layer) integration: still returns the four statuses
// ---------------------------------------------------------------------------

test("tool: handleRemember with seam override still returns one of the four statuses", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 6000,
          summary: "we use Postgres for this service in production",
        },
      ],
      reason: "test seam override",
    }));
    const { setStorageProvider, resetStorageProvider } = await import(
      "../src/tools/remember.ts"
    );
    setStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // Vague junk: short-circuits before provider.
      const r1 = await handleRemember({ text: "asdf" });
      assert.equal(r1.status, "rejected");
      assert.equal(r1.safetyClass, "vague-junk");
    } finally {
      resetStorageProvider();
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 11. Pure helper does not read the wall clock
// ---------------------------------------------------------------------------

test("buildPersistedMetadata is pure — output is independent of wall clock", () => {
  const existing = { tags: ["a"], classification: "fact" };
  const derivedAt = 1_700_000_000_000;
  const derived: RelationshipMetadataFields = {
    conflictsWith: [1],
    olderVariantsOf: [],
    detectionConfidence: 0.9,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt,
  };
  const a = buildPersistedMetadata(existing, derived);
  // Wait a few ms to ensure the wall clock would have changed
  // if the helper had read it.
  const start = Date.now();
  while (Date.now() - start < 5) {
    // spin briefly
  }
  const b = buildPersistedMetadata(existing, derived);
  assert.deepEqual(a, b);
  // And the derivedAt is exactly what was passed in.
  const rel = a.relationship as Record<string, unknown>;
  assert.equal(rel.derivedAt, derivedAt);
});

// ---------------------------------------------------------------------------
// 12. B-1 regression: olderVariantsOf is meaningful in the controller path
// ---------------------------------------------------------------------------
//
// The Phase B fix must make `olderVariantsOf` non-empty when the
// related-memories set contains an earlier near-paraphrase of the
// candidate. The candidate's id is not known at insert time, so
// the controller must derive AFTER insert, with the real id, and
// patch the row's `metadata` JSON via a narrow update.
//
// We pre-insert a memory first (so the new candidate's id is 2
// rather than 1, and the related memory's id is 1 < candidate.id).
// The seam override returns the older row's id. The candidate is
// a near-paraphrase of the older row that clears τ' (0.90).
test("controller: olderVariantsOf is non-empty when a related memory is an earlier near-variant (B-1 fix)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Step 1: pre-insert an "earlier" memory (id will be 1).
    // Use a high-overlap summary the detector can later see as a
    // near-paraphrase of the candidate. We use a controller call
    // so the row is inserted through the same path production
    // uses (and so we do not need a separate fixture).
    {
      // The "older" row is intentionally a SHORTER version; the
      // candidate (newer row) will be the LONGER paraphrase
      // with one extra clause. Token multisets:
      //   older:    postgres, stores, project, data, reliably,
      //             migrated, mysql, production, deployment
      //             (9 tokens)
      //   candidate: same 9 + "since" (10 tokens)
      // Jaccard: 9 / 10 = 0.90, clearing τ'.
      const olderSummary =
        "Postgres stores project data reliably; migrated from MySQL; production deployment";
      const { fetchImpl } = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: olderSummary,
            tags: ["postgres", "storage"],
          }),
        ),
      );
      const olderOutcome = await runRememberController(
        handle,
        "Older fact about Postgres migration.",
        {
          providerFetchImpl: fetchImpl,
          providerPrimaryApiKey: PRIMARY_KEY,
          providerFallbackApiKey: FALLBACK_KEY,
          now: pinnedNow(1_700_000_000_000),
        },
      );
      assert.equal(olderOutcome.status, "saved");
      if (olderOutcome.status !== "saved") throw new Error("unreachable");
      // The older row's id must be < the candidate's id below.
      assert.equal(olderOutcome.record.id, 1);
    }

    // Step 2: override the seam to return the older row (id 1)
    // as a related memory. The candidate (newer row) is the
    // longer paraphrase of the older row, with one extra
    // "since 2023" clause.
    setRelatedMemoriesImpl(() => ({
      memories: [
        {
          id: 1,
          summary:
            "Postgres stores project data reliably; migrated from MySQL; production deployment",
        },
      ],
      reason: "test seam override (older near-variant)",
    }));

    const candidateSummary =
      "Postgres stores project data reliably; migrated from MySQL; production deployment since 2023";
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary: candidateSummary,
          tags: ["postgres", "storage"],
        }),
      ),
    );
    const pinnedTime = 1_700_000_000_001;
    const outcome = await runRememberController(
      handle,
      "Newer near-paraphrase about Postgres migration.",
      {
        providerFetchImpl: fetchImpl,
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
        now: pinnedNow(pinnedTime),
      },
    );
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    // The candidate must be the new row (id 2), strictly later
    // than the older row (id 1).
    assert.equal(outcome.record.id, 2);

    const row = handle.db
      .prepare("SELECT metadata, state FROM memories WHERE id = ?")
      .get(outcome.record.id) as { metadata: string; state: string };

    // Older memories are NOT state-transitioned. The candidate
    // itself is `active`. The older row (id 1) must still be
    // `active` after this insert.
    assert.equal(row.state, "active");
    const olderState = handle.db
      .prepare("SELECT state FROM memories WHERE id = ?")
      .get(1) as { state: string };
    assert.equal(olderState.state, "active", "older row must remain active");

    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    // Existing keys preserved.
    assert.deepEqual(parsed.tags, ["postgres", "storage"]);
    assert.equal(parsed.classification, "fact");
    // Relationship block is present and well-formed. The B-1 fix
    // is what makes this assertion meaningful: the candidate's
    // real id (2) is used in derivation, so the older row (id
    // 1) is in `olderVariantsOf`. The schema version is the
    // Phase I new-write literal (`"ccm-draft-2"`).
    assert.equal(typeof parsed.relationship, "object");
    const rel = parsed.relationship as Record<string, unknown>;
    assert.equal(rel.derivedSchemaVersion, DERIVED_SCHEMA_VERSION);
    assert.equal(rel.derivedAt, pinnedTime);
    assert.deepEqual(
      rel.olderVariantsOf,
      [1],
      "olderVariantsOf must include the earlier near-variant id",
    );
    assert.deepEqual(rel.conflictsWith, []);
    assert.ok(
      typeof rel.detectionConfidence === "number" &&
        rel.detectionConfidence >= 0.9,
      "detectionConfidence must be at or above the older-variant τ'",
    );

    // The returned record (from the controller) must carry the
    // updated metadata, not the pre-insert metadata.
    assert.equal(
      (outcome.record.metadata as Record<string, unknown>).relationship !==
        undefined,
      true,
      "controller-returned record must reflect the post-update metadata",
    );
    const returnedRel = (
      outcome.record.metadata as Record<string, unknown>
    ).relationship as Record<string, unknown>;
    assert.deepEqual(returnedRel.olderVariantsOf, [1]);

    // The public message is unchanged: no relationship /
    // olderVariantsOf substring. The controller's saved
    // message uses the no-id form — the memory id is an
    // internal storage handle and is not part of the
    // on-the-wire public message.
    assert.match(
      outcome.message,
      /^saved \([a-z]+, confidence \d+\.\d{2}\)$/,
    );
    assert.ok(!outcome.message.includes("relationship"));
    assert.ok(!outcome.message.includes("olderVariantsOf"));
    // No memory id in the public message.
    assert.ok(
      !/#\d+/.test(outcome.message),
      `public message must not include a #N id; got ${JSON.stringify(outcome.message)}`,
    );
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 13. I-1: malformed related-memory ids are skipped, not coerced
// ---------------------------------------------------------------------------
//
// The seam override is permitted to return a row whose `id` is
// not a finite number (defense in depth against bad producer
// code). Such a row must be silently dropped before it reaches
// the detector and before any value lands in the persisted
// JSON. The previous behavior coerced to -1 and persisted a
// `conflictsWith: [-1]` / `olderVariantsOf: [-1]` list, which is
// wrong on every read.
test("controller: malformed related-memory id is skipped, not coerced to -1 and persisted (I-1 fix)", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Override the seam to return ONE good related memory and
    // several bad rows (non-finite ids, string ids, etc.). The
    // good memory's summary is a high-overlap conflict pair
    // with the candidate, so the controller path WOULD have
    // emitted `conflictsWith: [7000]` under the previous
    // behavior (with -1 also being emitted). Under the fix,
    // only [7000] is emitted and the bad rows are dropped.
    setRelatedMemoriesImpl(() => ({
      memories: [
        // Good row: real id, real summary, will be the only id
        // that lands in conflictsWith.
        {
          id: 7000,
          summary: "we use Postgres for this service in production",
        },
        // Bad rows: non-finite id, string id, NaN, missing id.
        // The MVP impl exposes `id` as `unknown` for the seam;
        // a permissive producer could send any of these.
        { id: "abc", summary: "we use Postgres for this service in production" } as never,
        { id: Number.NaN, summary: "we use Postgres for this service in production" } as never,
        { id: Number.POSITIVE_INFINITY, summary: "we use Postgres for this service in production" } as never,
        { summary: "we use Postgres for this service in production" } as never,
      ] as never,
      reason: "test seam override (mixed good + malformed ids)",
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
    // The good row is the only id that lands.
    assert.deepEqual(rel.conflictsWith, [7000]);
    // No -1 ever lands. The previous (buggy) behavior
    // persisted `olderVariantsOf: [-1]` and/or
    // `conflictsWith: [-1]` whenever a related row's id was
    // not a finite number. That must not happen.
    const conflicts = rel.conflictsWith as unknown[];
    const older = rel.olderVariantsOf as unknown[];
    for (const arr of [conflicts, older]) {
      for (const v of arr) {
        assert.ok(
          typeof v === "number" && Number.isFinite(v) && v > 0,
          `related id list must contain only positive finite numbers, got: ${JSON.stringify(v)}`,
        );
      }
    }
  } finally {
    resetRelatedMemoriesImpl();
    rmStorage(tmp, handle);
  }
});
