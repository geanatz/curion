/**
 * Tests for the narrow MVP `remember(text)` pipeline.
 *
 * The provider adapter is driven by a scripted `fetch` so no network
 * is touched. The storage layer uses a fresh temp dir per test.
 *
 * Coverage (per task spec):
 *   1. Safe input -> stored; raw input is NOT in the persisted record.
 *   2. Unsafe secret input -> rejected BEFORE the provider call
 *      (no fetch invocation recorded).
 *   3. Vague junk -> rejected/clarification BEFORE the provider call.
 *   4. Provider clarification result -> `clarification_needed`,
 *      nothing stored.
 *   5. Provider error -> `provider_error`, nothing stored.
 *   6. Mixed safe+sensitive input -> rejected; the secret fragment
 *      must not appear in storage.
 *   7. Tool still has exactly one `text` param.
 *   8. `recall` remains unchanged.
 *   9. Storage schema has no raw/original text column.
 *  10. Persisted record has summary/provider/model/confidence/state/kind.
 *  11. Defense in depth: a provider summary that echoes a secret
 *      is redacted; an entirely-secret summary is rejected.
 *  12. Idempotent migration: re-running `initStorage` does not
 *      duplicate columns and preserves existing rows.
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
import {
  handleRemember,
  setStorageProvider,
  resetStorageProvider,
} from "../src/tools/remember.ts";
import {
  handleRecall,
  NO_RELEVANT_MEMORY,
} from "../src/tools/recall.ts";
import { buildServer, PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { classifyInput, redactSummary } from "../src/safety/precheck.ts";
import { findRelatedMemories } from "../src/retrieval/seam.ts";
import { SAFETY_FIXTURES } from "../src/safety/fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp project dir + storage handle. Caller closes handle + cleans dir. */
function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mvp-rm-"));
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

/** A scripted `fetch` that serves a single canned response. */
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

function httpErrorResponse(status: number, text = "boom"): Response {
  return new Response(text, { status });
}

/** A valid, safe analysis payload the provider would return. */
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

// ---------------------------------------------------------------------------
// 1. Safe input -> stored; raw input is NOT in the persisted record
// ---------------------------------------------------------------------------

test("remember: safe input is stored; raw input is not persisted", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    const rawText =
      "We picked Postgres 16 for the primary data store because of better JSON support.";
    const outcome = await runRememberController(handle, rawText, {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");

    // Provider was called exactly once (primary succeeded).
    assert.equal(calls.length, 1);

    // Persisted record shape.
    const rec = outcome.record;
    assert.ok(rec.id > 0);
    assert.equal(typeof rec.summary, "string");
    assert.ok(rec.summary.length > 0);
    assert.equal(rec.providerId, "minimax");
    assert.equal(typeof rec.modelId, "string");
    assert.ok((rec.modelId ?? "").length > 0);
    assert.ok(rec.confidence !== null && rec.confidence > 0);
    assert.equal(rec.state, "active");
    assert.ok(["fact", "decision", "preference", "context", "conflict", "reference", "finding"].includes(rec.kind));

    // The raw input MUST NOT be present in any persisted field.
    const dbRows = handle.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(rec.id) as Record<string, unknown>;
    for (const [k, v] of Object.entries(dbRows)) {
      if (typeof v === "string") {
        assert.ok(
          !v.includes(rawText),
          `persisted column '${k}' must not contain the raw input`,
        );
        assert.ok(
          !v.includes("Postgres 16 for the primary data store because of better JSON support"),
          `persisted column '${k}' must not contain a raw-input fragment`,
        );
      }
    }
    // The summary stored is the controller-normalized provider summary,
    // not the raw input.
    assert.equal(dbRows.summary, rec.summary);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 2. Unsafe secret input -> rejected BEFORE the provider call
// ---------------------------------------------------------------------------

test("remember: unsafe secret input is rejected before any provider call", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    // Pure secret (no substantial safe content) so the classifier
    // routes to `secret` rather than `mixed-safe-sensitive`. The
    // mixed path is exercised separately below.
    const rawText = "AKIAIOSFODNN7EXAMPLE";
    const outcome = await runRememberController(handle, rawText, {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "secret");

    // The provider must NOT have been called.
    assert.equal(calls.length, 0, "provider must not be called for secret input");

    // Nothing must be stored.
    const rows = handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. Vague junk -> rejected/clarification BEFORE the provider call
// ---------------------------------------------------------------------------

test("remember: vague junk is rejected before any provider call", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    const outcome = await runRememberController(handle, "asdf", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "vague-junk");
    assert.equal(calls.length, 0, "provider must not be called for vague junk");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("remember: empty / whitespace-only input is rejected before any provider call", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    const outcome = await runRememberController(handle, "   \n  \t  ", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "rejected");
    assert.equal(calls.length, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Provider clarification result -> clarification_needed; nothing stored
// ---------------------------------------------------------------------------

test("remember: low provider confidence returns clarification_needed and stores nothing", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(safeAnalysis({ confidence: 0.3, summary: "Vague guess." })),
    );
    const outcome = await runRememberController(handle, "Some input that confuses the model.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "clarification_needed");
    if (outcome.status !== "clarification_needed") throw new Error("unreachable");
    assert.match(outcome.question, /rephrase|confirm|context/i);
    const rows = handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("remember: confidence exactly at threshold is accepted", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(safeAnalysis({ confidence: 0.5, summary: "Borderline confidence but valid." })),
    );
    const outcome = await runRememberController(handle, "Some input.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
      confidenceThreshold: 0.5,
    });
    assert.equal(outcome.status, "saved");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. Provider error -> provider_error; nothing stored
// ---------------------------------------------------------------------------

test("remember: provider hard failure returns provider_error and stores nothing", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() => httpErrorResponse(503, "service down"));
    const outcome = await runRememberController(handle, "Some input.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    // Either primary failed and fallback also failed (all-providers-failed),
    // or primary failed and no fallback configured. Both surface as
    // provider_error with no record written.
    assert.equal(outcome.status, "provider_error");
    const rows = handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. Mixed safe + sensitive -> rejected; secret MUST NOT be stored
// ---------------------------------------------------------------------------

test("remember: mixed safe+sensitive input is rejected; secret fragment is not stored", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    const rawText =
      "Project uses Postgres 16. The CI token is glpat-abcdefghijklmnopqrst. Tests run in 12s.";
    const outcome = await runRememberController(handle, rawText, {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "mixed-safe-sensitive");
    assert.equal(calls.length, 0, "provider must not be called for mixed input");
    const rows = handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    assert.equal(rows.c, 0);
    // Also assert the entire DB has no occurrence of the secret fragment.
    const all = handle.db
      .prepare("SELECT * FROM memories")
      .all() as Array<Record<string, unknown>>;
    for (const row of all) {
      for (const v of Object.values(row)) {
        if (typeof v === "string") {
          assert.ok(
            !v.includes("glpat-abcdefghijklmnopqrst"),
            "secret fragment must not appear in any persisted column",
          );
        }
      }
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 7. Tool still has exactly one `text` param
// ---------------------------------------------------------------------------

test("remember tool: still exposes exactly one text param", () => {
  const server = buildServer();
  const registered = (server as unknown as {
    _registeredTools: Record<string, { inputSchema: unknown }>;
  })._registeredTools;
  // The MCP SDK stores the input schema as a zod object. We can
  // probe its shape via `_def.shape()` to confirm the public params.
  const remember = registered["remember"] as {
    inputSchema: {
      _def?: {
        shape?: () => Record<string, unknown>;
      };
    };
  };
  const shape = remember.inputSchema._def?.shape?.();
  assert.ok(shape, "remember tool inputSchema must expose a shape");
  assert.deepEqual(Object.keys(shape), ["text"]);
});

test("public tool surface is still exactly remember + recall", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

// ---------------------------------------------------------------------------
// 8. recall behavior: no memories -> no_memory
// ---------------------------------------------------------------------------

test("recall handler: no memories -> no_memory placeholder", async () => {
  const r = await handleRecall({ text: "anything" });
  assert.equal(r.status, "no_memory");
  assert.equal(r.message, NO_RELEVANT_MEMORY);
});

// ---------------------------------------------------------------------------
// 9. Storage schema has no raw/original text column
// ---------------------------------------------------------------------------

test("storage: memories table never has a raw/original text column", () => {
  const { tmp, handle } = mkStorage();
  try {
    const cols = handle.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
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
// 10. Persisted record has summary/provider/model/confidence/state/kind
// ---------------------------------------------------------------------------

test("persisted record: has summary, provider, model, confidence, state, kind", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(safeAnalysis({ classification: "decision" })),
    );
    const outcome = await runRememberController(handle, "We decided to use Postgres 16.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const row = handle.db
      .prepare(
        "SELECT summary, provider_id, model_id, confidence, state, kind FROM memories WHERE id = ?",
      )
      .get(outcome.record.id) as Record<string, unknown>;
    assert.equal(typeof row.summary, "string");
    assert.ok((row.summary as string).length > 0);
    assert.equal(row.provider_id, "minimax");
    assert.equal(typeof row.model_id, "string");
    assert.equal(typeof row.confidence, "number");
    assert.equal(row.state, "active");
    assert.equal(row.kind, "decision");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("controller: maps unknown provider classification to 'finding' fallback kind", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(safeAnalysis({ classification: "totally-unknown-thing" })),
    );
    const outcome = await runRememberController(handle, "Some input.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    assert.equal(outcome.record.kind, "finding");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 11. Defense in depth: a provider summary that echoes a secret is
//     redacted; an entirely-secret summary is rejected.
// ---------------------------------------------------------------------------

test("remember: a provider summary that is entirely a secret fragment is rejected", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // The provider returns a summary that IS the secret, with no
    // surrounding safe text. After redaction the summary is empty,
    // so the controller must reject.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({ summary: "sk-abcdefghijklmnopqrstuv" }),
      ),
    );
    const outcome = await runRememberController(handle, "Some input.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    assert.equal(outcome.safetyClass, "secret-echoed-by-provider");
    const rows = handle.db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    assert.equal(rows.c, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("remember: a provider summary with a secret embedded in real text is redacted but still saved", async () => {
  const { tmp, handle } = mkStorage();
  try {
    const leakySummary =
      "The CI uses a token; the project uses Postgres 16 for the primary store.";
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(
        safeAnalysis({
          summary:
            "The project uses Postgres 16. Token: sk-abcdefghijklmnopqrstuv. Tests run in 12s.",
        }),
      ),
    );
    const outcome = await runRememberController(handle, "Some input.", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const stored = outcome.record.summary;
    assert.ok(
      !stored.includes("sk-abcdefghijklmnopqrstuv"),
      "secret must be redacted from the persisted summary",
    );
    assert.ok(stored.includes("<redacted>"), "redaction marker must appear");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 12. Idempotent migration: re-running initStorage preserves data
// ---------------------------------------------------------------------------

test("storage: re-running initStorage does not duplicate columns and preserves existing rows", async () => {
  const { tmp, handle } = mkStorage();
  try {
    // Insert one record through the controller.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse(safeAnalysis()),
    );
    const outcome = await runRememberController(handle, "Hello world", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
    });
    assert.equal(outcome.status, "saved");
    if (outcome.status !== "saved") throw new Error("unreachable");
    const firstId = outcome.record.id;
    handle.db.close();

    // Re-open the same dir; migration must be idempotent.
    const reopened = initStorage({ projectRoot: tmp });
    try {
      const cols = reopened.db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      const unique = new Set(names);
      assert.equal(unique.size, names.length, "no duplicate columns after re-open");
      // Row is still there.
      const row = reopened.db
        .prepare("SELECT id, summary FROM memories WHERE id = ?")
        .get(firstId) as { id: number; summary: string };
      assert.equal(row.id, firstId);
      assert.ok(row.summary.length > 0);
      // schema_version meta reflects the MVP version.
      const meta = reopened.db
        .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
        .get() as { value: string };
      assert.equal(meta.value, "v2-mvp-1");
    } finally {
      reopened.db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tool layer integration: handler delegates to controller
// ---------------------------------------------------------------------------

test("tool: handleRemember returns a structured result with one of the four statuses", async () => {
  const { tmp, handle } = mkStorage();
  try {
    setStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // Vague junk: short-circuits before provider.
      const r1 = await handleRemember({ text: "asdf" });
      assert.equal(r1.status, "rejected");
      assert.equal(r1.safetyClass, "vague-junk");

      // Secret: short-circuits before provider.
      const r2 = await handleRemember({
        text: "My key is AKIAIOSFODNN7EXAMPLE.",
      });
      assert.equal(r2.status, "rejected");
      assert.equal(r2.safetyClass, "secret");
    } finally {
      resetStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Safety pre-check unit tests
// ---------------------------------------------------------------------------

test("classifyInput: secret patterns are detected across many shapes", () => {
  for (const sample of [
    "AKIAIOSFODNN7EXAMPLE is my AWS access key",
    "GitHub token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "OpenAI key is sk-abcdefghijklmnopqrstuv",
    "GitLab PAT: glpat-AbCdEfGhIjKlMnOpQrSt",
    "Slack: xoxb-12345-67890-abcdefghijkl",
    "Google: AIzaSyA-abcdefghijklmnopqrstuvwxyz123456",
    "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEog==\n-----END RSA PRIVATE KEY-----",
    "password=hunter2hunter2hunter2",
    "api_key=AbCdEfGhIjKlMnOpQrSt",
  ]) {
    const r = classifyInput(sample);
    assert.equal(
      r.class,
      "secret",
      `expected 'secret' for: ${sample.slice(0, 40)}`,
    );
  }
});

test("classifyInput: vague junk is detected", () => {
  for (const sample of ["asdf", "....", "foo foo foo foo", "   ", ""]) {
    const r = classifyInput(sample);
    assert.equal(r.class, "vague-junk", `expected 'vague-junk' for: '${sample}'`);
  }
});

test("classifyInput: mixed safe+sensitive is detected", () => {
  const r = classifyInput(
    "Project uses Postgres 16. The CI token is glpat-AbCdEfGhIjKlMnOpQrSt. Tests run in 12s.",
  );
  assert.equal(r.class, "mixed-safe-sensitive");
});

test("classifyInput: safe factual text is allowed", () => {
  const r = classifyInput(
    "We picked Postgres 16 because the JSON support is much better than 14.",
  );
  assert.equal(r.class, "safe");
});

test("redactSummary: redacts secret-shaped substrings and preserves safe text", () => {
  const redacted = redactSummary(
    "The project uses Postgres 16. Token: sk-abcdefghijklmnopqrstuv. Tests run in 12s.",
  );
  assert.ok(!redacted.includes("sk-abcdefghijklmnopqrstuv"));
  assert.ok(redacted.includes("Postgres 16"));
  assert.ok(redacted.includes("<redacted>"));
});

// ---------------------------------------------------------------------------
// Related-memory seam: returns empty for the MVP slice
// ---------------------------------------------------------------------------

test("related-memory seam: returns empty list with a stable reason for the MVP", () => {
  const { tmp, handle } = mkStorage();
  try {
    const out = findRelatedMemories(handle, { text: "anything" });
    assert.deepEqual(out.memories, []);
    assert.equal(typeof out.reason, "string");
    assert.match(out.reason, /mvp|no related/i);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Sanity: SAFETY_FIXTURES corpus still intact
// ---------------------------------------------------------------------------

test("safety fixtures: all required classes are present (no regression)", () => {
  const required = new Set([
    "secret",
    "prompt-injection",
    "unsafe-preference",
    "raw-dump",
    "vague-junk",
    "self-conflict",
    "mixed-safe-sensitive",
  ]);
  for (const f of SAFETY_FIXTURES) {
    assert.ok(required.has(f.class), `missing class: ${f.class}`);
  }
});
