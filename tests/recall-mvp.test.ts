/**
 * Tests for the narrow MVP `recall(text)` pipeline.
 *
 * The provider adapter is driven by a scripted `fetch` so no
 * network is touched. The storage layer uses a fresh temp dir per
 * test. The provider API key paths use placeholder strings.
 *
 * Coverage (per task spec):
 *   1.  no memories               -> no_memory, no provider call
 *   2.  irrelevant memories       -> no_memory, no provider call
 *   3.  relevant memory           -> provider called, answer returned
 *   4.  provider hard failure     -> provider_error, no fabricated answer
 *   5.  query with obvious secret -> rejected, no provider, no log of raw text
 *   6.  provider answer with secret / raw dump -> provider_error / safe
 *   7.  public MCP tool surface unchanged (only remember + recall)
 *   8.  recall has exactly one text param
 *   9.  recall does not expose citations/evidence/diagnostics in public message
 *  10.  recall uses only stored summaries, not raw input
 *  11.  remember -> recall e2e via handler/storage with stubbed providers
 *  12.  lexical ranker unit tests
 *  13.  no query text or secret fragment in stderr
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  insertMemoryRecord,
  type StorageHandle,
  type MemoryRecord,
} from "../src/storage/storage.ts";
import {
  handleRecall,
  handleRemember,
  setStorageProvider as setRememberStorageProvider,
  resetStorageProvider as resetRememberStorageProvider,
  setStorageProvider as setRecallStorageProvider,
  resetStorageProvider as resetRecallStorageProvider,
  NO_RELEVANT_MEMORY,
  WEAK_MATCH_PUBLIC_MESSAGE,
  type RecallResult,
} from "../src/tools/recall.ts";
import { buildServer, PUBLIC_TOOL_NAMES } from "../src/server.ts";
import {
  buildRecallPublicText,
  buildRecallStructuredContent,
} from "../src/tools/recall-projection.ts";
import {
  rankLexical,
  tokenize,
  scoreCandidate,
  DEFAULT_RELEVANCE_THRESHOLD,
} from "../src/retrieval/lexical.ts";
import { runRememberController } from "../src/controller/remember-controller.ts";
import { classifyInput } from "../src/safety/precheck.ts";
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
import { scriptFetch, okChatResponse, safeAnalysis } from "./_helpers/provider-stub.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpErrorResponse(status: number, text = "boom"): Response {
  return new Response(text, { status });
}

function insertSummary(
  handle: StorageHandle,
  memoryContent: string,
  opts: { kind?: string; tags?: string[]; classification?: string } = {},
): MemoryRecord {
  return insertMemoryRecord(handle, {
    kind: (opts.kind as MemoryRecord["kind"]) ?? "fact",
    state: "active",
    memoryContent,
    providerId: "minimax",
    modelId: "MiniMax-M3",
    confidence: 0.9,
    safetyFlags: ["controller-normalized"],
    metadata: {
      tags: opts.tags ?? [],
      classification: opts.classification ?? null,
    },
  });
}

/** Run the recall controller with a scripted fetch and test keys. */
function runRecall(handle: StorageHandle, opts: {
  text: string;
  fetchImpl: typeof fetch;
  threshold?: number;
  topK?: number;
}) {
  return runRecallController(handle, opts.text, {
    providerFetchImpl: opts.fetchImpl,
    providerPrimaryApiKey: TEST_PRIMARY_KEY,
    providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
    providerPrimaryModel: TEST_PRIMARY_MODEL,
    providerFallbackApiKey: TEST_FALLBACK_KEY,
    providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
    providerFallbackModel: TEST_FALLBACK_MODEL,
    relevanceThreshold: opts.threshold,
    topK: opts.topK,
  });
}

// ---------------------------------------------------------------------------
// 1. No memories -> no_memory, no provider call
// ---------------------------------------------------------------------------

test("recall: no memories -> no_memory and no provider call", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("This should never be served."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "no_memory");
    assert.equal(calls.length, 0, "provider must not be called when there are no memories");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 2. Irrelevant memories -> no_memory, no provider call
// ---------------------------------------------------------------------------

test("recall: irrelevant memories -> no_memory and no provider call", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    // Use summaries that share zero content tokens with the
    // query. The lexical ranker is a token-overlap scorer; if a
    // summary contains an incidental common word like "project"
    // or "use", it can produce a non-zero score even though the
    // summary is clearly not about the same topic. The MVP
    // contract is: no relevant memory => no_memory. To exercise
    // that path we use summaries with no shared content tokens.
    insertSummary(
      handle,
      "The kitchen dishwasher runs nightly at 11pm Eastern.",
      { kind: "context", tags: ["kitchen", "schedule"] },
    );
    insertSummary(
      handle,
      "Office plants are watered on a biweekly rotation by the facilities team.",
      { kind: "context", tags: ["plants", "office"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("This should never be served."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "no_memory");
    assert.equal(calls.length, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 3. Relevant memory -> provider called, answer returned
// ---------------------------------------------------------------------------

test("recall: relevant memory -> provider called, synthesized answer returned", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary data store because of better JSON support.",
      { kind: "fact", tags: ["postgres", "database", "storage"] },
    );
    insertSummary(
      handle,
      "Office plants are watered on a biweekly rotation by the facilities team.",
      { kind: "context", tags: ["plants", "office"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(
        "The project uses Postgres 16 for the primary store, chosen for its stronger JSON support.",
      ),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.ok(out.answer.length > 0);
    assert.match(out.answer, /Postgres 16/);
    assert.equal(calls.length, 1, "primary called once, no fallback");
    // The primary call went to the primary base URL.
    assert.match(
      calls[0]!.url,
      /\/chat\/completions/,
    );
    // The provider request must include the stored summary (as
    // context) but must NOT include the raw input (only the query).
    assert.match(calls[0]!.body, /Postgres 16/);
    assert.match(calls[0]!.body, /What database does the project use/);
    // sourceIds should point at the relevant record only.
    assert.equal(out.sourceIds.length, 1);
    assert.equal(typeof out.sourceIds[0], "number");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 4. Provider hard failure -> provider_error, no fabricated answer
// ---------------------------------------------------------------------------

test("recall: provider hard failure -> provider_error, no fabricated answer", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // Both providers return 500. The controller must surface
    // provider_error and the public message must NOT contain a
    // fabricated answer.
    const { fetchImpl, calls } = scriptFetch(() =>
      httpErrorResponse(500, "provider down"),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "provider_error");
    if (out.status !== "provider_error") throw new Error("unreachable");
    assert.match(out.reason, /provider|fallback|primary|failed/i);
    // The public error reason must not be a fabricated answer
    // pretending the model said something. We just assert it
    // doesn't read like a normal synthesis ("Postgres") and
    // includes a hard-failure keyword.
    assert.ok(!/Postgres 16/.test(out.reason), "must not fabricate an answer");
    // The controller attempted both providers.
    assert.ok(calls.length >= 1, "at least the primary should have been called");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 5. Query with obvious secret -> rejected, no provider, no log of raw text
// ---------------------------------------------------------------------------

test("recall: query with obvious secret -> rejected, no provider call, raw text not logged", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("This should never be served."),
    );
    // Capture stderr so we can assert that the raw query text and
    // the secret fragment never appear in any log line.
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (b: string) => boolean }).write =
      ((chunk: string | Uint8Array): boolean => {
        captured.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
        return true;
      }) as unknown as typeof process.stderr.write;
    try {
      // The query mixes a secret with substantive non-secret
      // content (well over 40 chars), so the classifier assigns
      // `mixed-safe-sensitive` and the controller rejects. The
      // important guarantees for this test are: no provider call,
      // no echo of the secret in the public message, and no
      // appearance of the secret in stderr. The exact safety
      // class is an implementation detail of the classifier; the
      // reject behavior is what we are asserting.
      const out = await runRecall(handle, {
        text: "My AWS access key is AKIAIOSFODNN7EXAMPLE, what is the project database?",
        fetchImpl,
      });
      assert.equal(out.status, "rejected");
      if (out.status !== "rejected") throw new Error("unreachable");
      assert.equal(
        out.safetyClass,
        "mixed-safe-sensitive",
        "queries that mix safe content with a secret are classified as mixed-safe-sensitive",
      );
      // No provider call.
      assert.equal(calls.length, 0, "provider must not be called for secret queries");
      // The public message must NOT echo the raw query text.
      const publicMessage = `Rejected: ${out.reason}`;
      assert.ok(
        !publicMessage.includes("AKIAIOSFODNN7EXAMPLE"),
        "public message must not echo the secret",
      );
      assert.ok(
        !publicMessage.includes("AWS access key"),
        "public message must not echo the raw query",
      );
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = origWrite;
    }
    // The raw secret fragment must not appear anywhere in stderr.
    const allStderr = captured.join("");
    assert.ok(
      !allStderr.includes("AKIAIOSFODNN7EXAMPLE"),
      "raw secret fragment must not be logged",
    );
    assert.ok(
      !allStderr.includes("AWS access key"),
      "raw query text must not be logged",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: a pure-secret-only query is classified as `secret` (rejected)", async () => {
  // Sanity: a query that IS a bare credential (no surrounding
  // context over 40 chars) is classified as `secret`, not
  // `mixed-safe-sensitive`. This is the case the original test
  // asserted, kept here as a focused unit-level check.
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("never served"),
    );
    const out = await runRecall(handle, {
      text: "AKIAIOSFODNN7EXAMPLE",
      fetchImpl,
    });
    assert.equal(out.status, "rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    assert.equal(out.safetyClass, "secret");
    assert.equal(calls.length, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 6. Provider answer with secret / raw dump -> provider_error
// ---------------------------------------------------------------------------

test("recall: provider answer that is a secret -> provider_error, no unsafe public answer", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The provider returns a secret-shaped string. The controller's
    // answer-validation layer must redact-and-reject (because the
    // meaningful content is now empty), and the public message
    // must NOT expose the secret.
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("AKIAIOSFODNN7EXAMPLE"),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "provider_error");
    if (out.status !== "provider_error") throw new Error("unreachable");
    assert.equal(calls.length, 1, "provider was called once");
    // The public reason must NOT contain the secret.
    assert.ok(
      !out.reason.includes("AKIAIOSFODNN7EXAMPLE"),
      "public provider_error reason must not echo the secret",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: provider answer that looks like a raw dump -> provider_error", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const dumpAnswer = [
      "FOO=bar",
      "BAZ=qux",
      "SECRET=hunter2",
      "PATH=/usr/bin",
      "HOME=/root",
    ].join("\n");
    const { fetchImpl } = scriptFetch(() => okChatResponse(dumpAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "provider_error");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: provider answer with a secret embedded in real text is redacted but still saved", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The provider answers with mostly-safe text that contains a
    // single secret-shaped substring. The answer-validation layer
    // redacts that substring and still returns the rest. The
    // public message contains "<redacted>" but never the raw
    // secret value.
    const leakyAnswer =
      "The project uses Postgres 16. The access key is sk-abcdefghijklmnopqrstuv. Tests run in 12s.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(leakyAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.ok(
      !out.answer.includes("sk-abcdefghijklmnopqrstuv"),
      "answer must not contain the raw secret",
    );
    assert.ok(
      out.answer.includes("<redacted>"),
      "answer must include the redaction marker",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 7. Public MCP tool surface unchanged
// ---------------------------------------------------------------------------

test("recall: public tool surface is still exactly remember + recall", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
  const server = buildServer();
  const registered = (server as unknown as {
    _registeredTools: Record<string, unknown>;
  })._registeredTools;
  const keys = Object.keys(registered);
  assert.equal(keys.length, 2);
  assert.ok("remember" in registered);
  assert.ok("recall" in registered);
});

// ---------------------------------------------------------------------------
// 8. recall has exactly one text param
// ---------------------------------------------------------------------------

test("recall tool: exposes exactly one text param", () => {
  const server = buildServer();
  const registered = (server as unknown as {
    _registeredTools: Record<string, { inputSchema: unknown }>;
  })._registeredTools;
  const recall = registered["recall"] as {
    inputSchema: {
      _def?: {
        shape?: () => Record<string, unknown>;
      };
    };
  };
  const shape = recall.inputSchema._def?.shape?.();
  assert.ok(shape, "recall tool inputSchema must expose a shape");
  assert.deepEqual(Object.keys(shape), ["text"]);
});

// ---------------------------------------------------------------------------
// 9. recall does not expose citations/evidence/diagnostics in public message
// ---------------------------------------------------------------------------

test("recall: public message is the synthesized answer (no citations / evidence / diagnostics)", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The provider returns an answer that mentions a citation
    // marker like [#1]. The public recall message must be the
    // plain text only — no citation list, no evidence chain, no
    // diagnostic header. The tool layer does not parse out
    // citations; it just exposes whatever the model said.
    const answer = "Postgres 16 is the primary store. See [#1].";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The public message is the plain answer.
    assert.equal(out.answer, answer);
    // The message field is the same string. No diagnostics, no
    // "Sources:" header, no "[memory #1]" prefix, no provider
    // name leaked.
    assert.ok(
      !/Sources?:|Citations?:|memory #\d+|provider used|minimax|nvidia/i.test(
        out.answer,
      ),
      "public message must not include diagnostic-style metadata",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 10. recall uses only stored summaries, not raw input
// ---------------------------------------------------------------------------

test("recall: synthesis prompt uses stored summaries, not raw input", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    const storedSummary =
      "The project uses Postgres 16 for the primary store. The office hallway has walnut flooring.";
    insertSummary(handle, storedSummary, {
      kind: "fact",
      tags: ["postgres", "storage"],
    });
    // The raw input we passed to remember; this MUST NOT be in
    // the synthesis request body. It contains a distinctive
    // fragment ("zesty lemon tart") that the stored summary
    // does not contain.
    const rawInput =
      "We picked Postgres 16 for the primary data store; the office kitchen has a zesty lemon tart on Fridays.";
    // First, run remember with the raw input (stubbed provider
    // returns the safe analysis).
    const rememberFetch = scriptFetch(() => okChatResponse(safeAnalysis()));
    await runRememberController(handle, rawInput, {
      providerFetchImpl: rememberFetch.fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
    });
    // Now run recall with a query. The synthesis request body
    // must include the stored summary and must NOT include the
    // raw input verbatim.
    const recallFetch = scriptFetch(() =>
      okChatResponse("Postgres 16."),
    );
    await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl: recallFetch.fetchImpl,
    });
    assert.equal(recallFetch.calls.length, 1);
    const body = recallFetch.calls[0]!.body;
    assert.match(
      body,
      new RegExp(
        storedSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
      "synthesis prompt must include the stored summary",
    );
    assert.ok(
      !body.includes(rawInput),
      "synthesis prompt must not include the raw remember input",
    );
    // The raw input's distinguishing fragment is also not echoed.
    assert.ok(
      !body.includes("zesty lemon tart"),
      "synthesis prompt must not include raw input fragments",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 11. remember -> recall e2e via handler/storage with stubbed providers
// ---------------------------------------------------------------------------

test("recall e2e: remember then recall via the tool layer with stubbed providers", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    setRememberStorageProvider(() => ({ handle, ownsHandle: false }));
    setRecallStorageProvider(() => ({ handle, ownsHandle: false }));
    try {
      // The raw input to remember contains a distinctive phrase
      // ("zesty lemon tart") that the synthesized summary must
      // not echo. The summary contains a different distinctive
      // phrase ("walnut flooring") that the raw input does not
      // contain.
      const rawInput =
        "We picked Postgres 16 for the primary data store; the office kitchen has a zesty lemon tart on Fridays.";
      const storedSummary =
        "The project uses Postgres 16 for the primary store. The office hallway has walnut flooring.";
      const rememberFetch = scriptFetch(() =>
        okChatResponse(
          safeAnalysis({
            summary: storedSummary,
            classification: "fact",
            tags: ["postgres", "database", "storage"],
          }),
        ),
      );
      // We need to inject the remember controller's provider
      // options too. The handleRemember tool doesn't expose them
      // (and shouldn't — it's the public contract). But we can
      // call runRememberController directly to drive the e2e
      // with our scripted fetch.
      const outcome = await runRememberController(handle, rawInput, {
        providerFetchImpl: rememberFetch.fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
      });
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");
      const memoryId = outcome.record.id;

      // Now recall via the public tool layer. The recall tool
      // should not call the provider for a no-memory path, so we
      // first test that path: an unrelated query.
      setListRegisteredProjectsStub(() => []);
      let r1: RecallResult;
      try {
        r1 = await handleRecall({ text: "When is the company picnic?" });
      } finally {
        resetListRegisteredProjectsStub();
      }
      assert.equal(r1.status, "no_memory");
      assert.equal(r1.message, NO_RELEVANT_MEMORY);

      // Now recall a relevant query. Stub the recall fetch to
      // return a sensible synthesis.
      const recallFetch = scriptFetch(() =>
        okChatResponse("Postgres 16 is the primary store."),
      );
      // We can't inject the fetch into handleRecall through the
      // public tool (the contract forbids knobs). Drive the
      // controller directly with our fetch — this is the
      // controlled e2e path the task allows.
      const out = await runRecallController(handle, "What database does the project use?", {
        providerFetchImpl: recallFetch.fetchImpl,
        providerPrimaryApiKey: TEST_PRIMARY_KEY,
        providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
        providerPrimaryModel: TEST_PRIMARY_MODEL,
        providerFallbackApiKey: TEST_FALLBACK_KEY,
        providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
        providerFallbackModel: TEST_FALLBACK_MODEL,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      assert.match(out.answer, /Postgres 16/);
      assert.ok(out.sourceIds.includes(memoryId));
      // The synthesis request body must include the stored
      // summary and must NOT include the raw remember input
      // (verified via the distinctive raw-input fragment).
      assert.equal(recallFetch.calls.length, 1);
      const body = recallFetch.calls[0]!.body;
      assert.match(body, /Postgres 16 for the primary store/);
      assert.ok(
        !body.includes("zesty lemon tart"),
        "synthesis prompt must not include raw input fragments",
      );
    } finally {
      resetRememberStorageProvider();
      resetRecallStorageProvider();
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 12. Lexical ranker unit tests
// ---------------------------------------------------------------------------

test("lexical: tokenize normalizes case, drops stop words and short tokens", () => {
  const toks = tokenize(
    "The project USES Postgres 16 for the primary STORE",
  );
  // Stop words ("the", "for") are dropped. "USES" lowercased.
  // "16" is a pure-digit token and is dropped.
  assert.ok(toks.includes("project"));
  assert.ok(toks.includes("uses"));
  assert.ok(toks.includes("postgres"));
  assert.ok(toks.includes("primary"));
  assert.ok(toks.includes("store"));
  assert.ok(!toks.includes("the"));
  assert.ok(!toks.includes("for"));
  assert.ok(!toks.includes("16"));
});

test("lexical: scoreCandidate returns 0 for no overlap", () => {
  const s = scoreCandidate("postgres storage", "the cat sat on the mat");
  assert.equal(s, 0);
});

test("lexical: scoreCandidate returns 1 for full coverage and adds phrase boost", () => {
  const s = scoreCandidate(
    "postgres storage",
    "we picked postgres for the storage layer",
  );
  // Two query tokens, both present -> 2/2 = 1.0 + phrase boost 0.2.
  assert.ok(s > 1, `expected score > 1, got ${s}`);
});

test("lexical: rankLexical returns nothing for empty query tokens", () => {
  const r = rankLexical("the and for", [
    { id: 1, text: "postgres storage" },
  ]);
  assert.equal(r.length, 0);
});

test("lexical: rankLexical returns nothing for low overlap", () => {
  const r = rankLexical("postgres storage", [
    { id: 1, text: "the cat sat on the mat" },
    { id: 2, text: "office plants and watering schedule" },
  ]);
  assert.equal(r.length, 0);
});

test("lexical: rankLexical ranks higher-similarity candidates first", () => {
  const r = rankLexical("postgres storage", [
    { id: 1, text: "office plants and watering schedule" },
    { id: 2, text: "we use postgres for the storage layer" },
    { id: 3, text: "the team drinks earl grey tea" },
  ]);
  // Only candidate 2 should pass the threshold.
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, 2);
});

test("lexical: rankLexical includes tag overlap in the match text", () => {
  const r = rankLexical("postgres", [
    { id: 1, text: "the cat sat on the mat", tags: ["postgres", "storage"] },
  ]);
  // The candidate's text doesn't mention postgres, but the tag
  // does. The match-text is "summary + tags", so it should pass.
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, 1);
});

test("lexical: rankLexical is deterministic and stable on ties", () => {
  const r1 = rankLexical("postgres", [
    { id: 1, text: "we use postgres" },
    { id: 2, text: "we use postgres" },
    { id: 3, text: "we use postgres" },
  ]);
  const r2 = rankLexical("postgres", [
    { id: 3, text: "we use postgres" },
    { id: 1, text: "we use postgres" },
    { id: 2, text: "we use postgres" },
  ]);
  assert.deepEqual(
    r1.map((x) => x.id),
    r2.map((x) => x.id),
  );
  // Tie-break is by descending id (newer memory wins).
  assert.deepEqual(
    r1.map((x) => x.id),
    [3, 2, 1],
  );
});

test("lexical: default threshold is 0.2 and rejects near-zero overlap", () => {
  // 1 of 3 query tokens matches (33%) -> 0.33 > 0.2 -> passes.
  const r1 = rankLexical("postgres storage database", [
    { id: 1, text: "we picked postgres because reasons" },
  ]);
  assert.equal(r1.length, 1);
  // 0 of 3 query tokens match -> 0 -> rejected.
  const r2 = rankLexical("postgres storage database", [
    { id: 1, text: "the cat sat on the mat" },
  ]);
  assert.equal(r2.length, 0);
  // Sanity: default threshold constant matches the documented value.
  assert.equal(DEFAULT_RELEVANCE_THRESHOLD, 0.2);
});

// ---------------------------------------------------------------------------
// 13. Storage query: listActiveMemorySummaries returns only safe fields
// ---------------------------------------------------------------------------

test("storage: listActiveMemorySummaries exposes only safe fields", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(handle, "We use Postgres 16 for the primary store.", {
      kind: "fact",
      tags: ["postgres", "storage"],
      classification: "fact",
    });
    const rows = (
      handle.db
        .prepare("SELECT summary FROM memories")
        .all() as Array<{ summary: string }>
    ).map((r) => r.summary);
    // The storage read is intentionally exercised through
    // runRecallController here, but the listActiveMemorySummaries
    // function is the read-side contract. Exercise it directly:
    const { listActiveMemorySummaries } = await import(
      "../src/storage/storage.ts"
    );
    const list = listActiveMemorySummaries(handle);
    assert.equal(list.length, rows.length);
    for (const r of list) {
      assert.equal(typeof r.id, "number");
      // Phase 1 internal naming cleanup: the internal
      // `SafeMemorySummary` property is `memoryContent`
      // (TS-side). The SQL `summary` column on disk is the
      // storage boundary; the read projection re-binds the
      // column to the internal TS field.
      assert.equal(typeof r.memoryContent, "string");
      assert.ok(r.memoryContent.length > 0);
      assert.equal(typeof r.kind, "string");
      // No raw/original text column on the schema, but we
      // additionally assert that the projection does not include
      // a `raw` / `text` / `content` / `body` field.
      assert.equal(
        (r as unknown as { raw?: unknown }).raw,
        undefined,
      );
      assert.equal(
        (r as unknown as { text?: unknown }).text,
        undefined,
      );
      assert.equal(
        (r as unknown as { content?: unknown }).content,
        undefined,
      );
      assert.equal(
        (r as unknown as { body?: unknown }).body,
        undefined,
      );
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 14. Mixed safe+sensitive query -> rejected (defense in depth)
// ---------------------------------------------------------------------------

test("recall: query mixing safe content with a secret -> rejected, no provider", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("never served"),
    );
    const out = await runRecall(handle, {
      text:
        "Project uses Postgres 16. The CI token is glpat-abcdefghijklmnopqrst. What database do we use?",
      fetchImpl,
    });
    assert.equal(out.status, "rejected");
    if (out.status !== "rejected") throw new Error("unreachable");
    assert.equal(out.safetyClass, "mixed-safe-sensitive");
    assert.equal(calls.length, 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 15. Sanity: classifier treats obvious-secret-only query as `secret`
// ---------------------------------------------------------------------------

test("recall: a pure-secret query is classified as `secret` (rejected) — unit check on the classifier", () => {
  // This is a unit-level check on the underlying classifier. The
  // integration path (controller + tool layer) for the same input
  // is covered by the earlier
  // `recall: a pure-secret-only query is classified as secret`
  // test, which also asserts the provider is not called and the
  // public response is a reject.
  const r = classifyInput("AKIAIOSFODNN7EXAMPLE");
  assert.equal(r.class, "secret");
});

// ---------------------------------------------------------------------------
// 16. Provider reasoning-block cleanup (think / thinking / Reasoning: /
//     Thought:) — public output is the visible answer only
// ---------------------------------------------------------------------------

test("recall: <think>...</think> reasoning block is stripped from the public answer", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("<think>private reasoning</think>Final answer."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The visible answer is preserved; the thinking block is gone.
    assert.equal(out.answer, "Final answer.");
    assert.ok(
      !out.answer.includes("<think>"),
      "public answer must not include the think tag opener",
    );
    assert.ok(
      !out.answer.includes("private reasoning"),
      "public answer must not include the reasoning content",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: multiline + case-insensitive <THINK>...</THINK> block is stripped", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const reasoningAnswer = [
      "<THINK>",
      "this reasoning",
      "spans multiple",
      "  lines with leading whitespace",
      "</THINK>",
      "",
      "Postgres 16 is the primary store.",
    ].join("\n");
    const { fetchImpl } = scriptFetch(() => okChatResponse(reasoningAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The visible answer is the trailing sentence, trimmed.
    assert.equal(out.answer, "Postgres 16 is the primary store.");
    assert.ok(
      !/<THINK>|<\/THINK>|<think>|<\/think>/i.test(out.answer),
      "public answer must not include any think tag",
    );
    assert.ok(
      !out.answer.includes("this reasoning"),
      "public answer must not include the reasoning content",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: <thinking>...</thinking> block (low-cost variant) is stripped", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const reasoningAnswer =
      "<thinking>hidden scratchpad notes</thinking>Postgres 16 is the primary store.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(reasoningAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, "Postgres 16 is the primary store.");
    assert.ok(
      !out.answer.includes("hidden scratchpad notes"),
      "public answer must not include reasoning content",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: leading 'Reasoning:' block is stripped when followed by a blank line and visible answer", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const reasoningAnswer = [
      "Reasoning: the user asked about the database.",
      "The stored summary clearly says Postgres 16.",
      "",
      "Postgres 16 is the primary store.",
    ].join("\n");
    const { fetchImpl } = scriptFetch(() => okChatResponse(reasoningAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, "Postgres 16 is the primary store.");
    assert.ok(
      !/^Reasoning\s*:/i.test(out.answer),
      "public answer must not start with a Reasoning: header",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: provider answer that is only a think block -> provider_error, no unsafe empty answer", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The provider returns ONLY a reasoning block. The controller
    // must NOT expose an empty (or near-empty) answer to the
    // public — it must surface a provider_error.
    const { fetchImpl } = scriptFetch(() =>
      okChatResponse("<think>just thinking, no answer</think>"),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "provider_error");
    if (out.status !== "provider_error") throw new Error("unreachable");
    // The public reason must not echo the thinking content.
    assert.ok(
      !out.reason.includes("just thinking"),
      "public reason must not echo reasoning content",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: secret inside stripped think block does not appear in public answer, log, or storage", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The provider's reasoning block embeds a secret-shaped
    // fragment. The thinking block is stripped first, so the
    // secret never reaches the public answer, the controller's
    // redaction pass, the stderr log, or the storage table.
    const leakyReasoning = "think";
    const secretInReasoning = "AKIAIOSFODNN7EXAMPLE";
    const reasoningAnswer =
      `<think>${leakyReasoning} ${secretInReasoning}</think>` +
      "Postgres 16 is the primary store.";

    // Capture stderr so we can assert the secret never lands in
    // any log line.
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (b: string) => boolean }).write =
      ((chunk: string | Uint8Array): boolean => {
        captured.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
        return true;
      }) as unknown as typeof process.stderr.write;
    const { fetchImpl } = scriptFetch(() => okChatResponse(reasoningAnswer));
    try {
      const out = await runRecall(handle, {
        text: "What database does the project use?",
        fetchImpl,
      });
      assert.equal(out.status, "answered");
      if (out.status !== "answered") throw new Error("unreachable");
      // The public answer must NOT include the secret.
      assert.ok(
        !out.answer.includes(secretInReasoning),
        "public answer must not include the secret from the stripped think block",
      );
      // The public answer must NOT include the thinking tag.
      assert.ok(
        !/<think/i.test(out.answer),
        "public answer must not include a think tag",
      );
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = origWrite;
    }
    // The secret must not appear anywhere in stderr.
    const allStderr = captured.join("");
    assert.ok(
      !allStderr.includes(secretInReasoning),
      "raw secret from stripped think block must not be logged",
    );
    // The memories table must not contain the secret. (Recall
    // does not persist provider answers, but the storage
    // invariant is that the secret never lands anywhere in the
    // memory store.)
    const storedTexts = (handle.db
      .prepare("SELECT summary FROM memories")
      .all() as Array<{ summary: string }>).map((r) => r.summary);
    for (const s of storedTexts) {
      assert.ok(
        !s.includes(secretInReasoning),
        "stored memory must not contain the secret from the stripped think block",
      );
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: answer without a reasoning block is returned unchanged (no false-positive stripping)", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // A normal answer that happens to contain the word "Reasoning"
    // inside a real sentence. The conservative stripper must NOT
    // eat this — the word is not a section header at the start of
    // the answer.
    const normalAnswer =
      "Postgres 16 is the primary store. The reasoning behind that choice is its stronger JSON support.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(normalAnswer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The full answer is preserved verbatim.
    assert.equal(out.answer, normalAnswer);
    assert.ok(
      out.answer.includes("reasoning behind that choice"),
      "answer that contains the word 'reasoning' in a normal sentence must be preserved",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 15. Provider-refusal reroute (Phase: thin-match honest no_memory)
// ---------------------------------------------------------------------------
//
// When the synthesis LLM is given stored memories it cannot lexically
// ground on, it may produce a first-person refusal paraphrase (e.g. "I
// don't have a specific summary for session 2 in the available
// memories."). The controller must detect that shape and reroute to
// `no_memory` instead of stamping the misleading `status: "answered"`
// contract. The tests below pin:
//   - the live failure phrase (verbatim)
//   - the original failure paraphrase (regression guard)
//   - the three article-gap pattern variants (summary, entry, note)
//   - three false-positive guards (substantive answers must NOT be
//     rerouted, including the load-bearing "I don't have the answer"
//     guard that justifies NOT adding `answer` to the noun list)
//   - the unchanged secret-shaped rejection path
//
// All tests share the same storage shape: a single summary that
// lexically overlaps the query, so the ranker clears the threshold and
// the controller proceeds to call the synthesis provider. The
// scripted fetch then returns the phrase under test, and the
// controller decides what to do with it.

test("recall: live failure phrase 'I don't have a specific summary for session 2 in the available memories.' -> weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "Session 2 of the project covered the controller and the lexical retrieval boundary.",
      { kind: "context", tags: ["session", "controller"] },
    );
    const livePhrase =
      "I don't have a specific summary for session 2 in the available memories.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(livePhrase));
    const out = await runRecall(handle, {
      text: "session 2",
      fetchImpl,
    });
    assert.equal(calls.length, 1, "provider must be called exactly once before reroute");
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0, "weak_match must surface at least one summary");
    assert.ok(out.summaries.length <= 3, "weak_match must cap at 3 summaries");
    assert.ok(out.coverage.topScore > 0, "coverage.topScore must be > 0");
    assert.ok(out.coverage.supportingCount > 0, "coverage.supportingCount must be > 0");
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: original failure paraphrase 'I don't have specific details about that.' -> weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("I don't have specific details about that."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1, "provider must be called exactly once before reroute");
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0 && out.summaries.length <= 3);
    assert.ok(out.coverage.topScore > 0);
    assert.ok(out.coverage.supportingCount > 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: article-gap variant with 'summary' and no qualifier -> weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("I don't have a summary for that topic."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: article-gap variant with 'entry' and 'any' qualifier -> weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(
        "I don't have any entry for that topic in the stored memories.",
      ),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: article-gap variant with 'note' and 'specific' qualifier -> weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(
        "I don't have a specific note about that in the available memories.",
      ),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: false-positive guard — 'I don't have the answer' substantive response must NOT be rerouted", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // The model can decline to answer part of the query and still
    // provide a substantive, useful response. The phrase contains
    // "I don't have the answer" but the rest of the sentence
    // delivers real content. The detector must NOT reroute this
    // — that is the load-bearing reason `answer` is NOT in the
    // noun list.
    const answer =
      "I don't have the answer to that, but I can tell you that the project uses TypeScript and Node 20.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: false-positive guard — substantive answer that mentions memories naturally must NOT be rerouted", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // A substantive answer that happens to mention stored memories.
    // No first-person refusal shape, no third-person "no X were/are
    // found" form. The detector must leave this alone.
    const answer =
      "The stored memories include references to the project's MCP architecture and the lexical-only production recall boundary.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: false-positive guard — 'The memory does not contain X' substantive answer must NOT be rerouted", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // A third-person substantive answer: the model is saying
    // something the user asked about (whether secrets are stored)
    // using a sentence that incidentally contains a memory-record
    // noun. The detector's first-person anchor and lack of a
    // generic "memory does not contain" pattern means this is
    // preserved as a substantive answer.
    const answer = "The memory does not contain secrets.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: false-positive guard — 'There are no records of X' substantive answer must NOT be rerouted", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // Third-person "are no records of X" is a substantive answer
    // about what the store does or does not contain. The detector's
    // pattern 5 is anchored on a leading "no X" + "found/available/
    // on file/recorded/stored" verb, so it does NOT match "are no
    // records of" — that is the test that pins this boundary.
    const answer = "There are no records of this user.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: regression guard — secret-shaped provider answer still routes to provider_error (not no_memory)", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // A bare secret-shaped string. The structural-safety gates
    // (empty, length, secret-redaction, short-after-redaction,
    // raw-dump) must catch this BEFORE the refusal-shape gate.
    // The public reason must not echo the secret.
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("AKIAIOSFODNN7EXAMPLE"),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1, "provider must be called once before rejection");
    assert.equal(out.status, "provider_error");
    if (out.status !== "provider_error") throw new Error("unreachable");
    assert.ok(
      !out.reason.includes("AKIAIOSFODNN7EXAMPLE"),
      "public provider_error reason must not echo the secret",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 16. Refusal-with-thin-match reroute (Phase: weak_match)
// ---------------------------------------------------------------------------
//
// The synthesis LLM can refuse to answer a query even when the
// lexical ranker found a relevant stored summary (a "thin
// match"). The controller now exposes a `weak_match` status
// in that case, carrying the top-3 curator-voice summaries
// and a coverage block, instead of routing to a misleading
// `no_memory` ("no relevant memory was found" would be
// incorrect — the ranker DID find something) or a fabricated
// `answered` (which would leak the refusal prose on the
// wire).
//
// The tests below pin:
//   (a) the live failure phrase -> weak_match with the
//       documented shape
//   (b) the original failure paraphrase -> weak_match with
//       the documented shape (different phrasing, same
//       trigger)
//   (c) strong-overlap control -> answered (regression guard:
//       a substantive answer still passes through as
//       `answered`, the refusal detector does NOT fire)
//   (d) zero-overlap query -> no_memory (unchanged: when the
//       ranker finds nothing, `topSummaries.length === 0` and
//       the refusal-with-thin-match branch does not fire —
//       the controller returns `no_memory` directly before
//       even calling the provider)
//   (e) `structuredContent.weak_match` shape: at most 3
//       summaries, coverage block has both `topScore` and
//       `supportingCount`, NO `message` field on the wire
//       (the public text is in `content[0].text`)
//   (f) regression guard: the `weak_match` reroute is
//       ADDITIVE — the false-positive guards (substantive
//       answers) and the secret-shaped regression (provider
//       answer is a bare secret) continue to route as
//       `answered` and `provider_error` respectively, NOT
//       `weak_match`.

test("recall: weak_match (a) live failure phrase -> weak_match with coverage and summaries", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "Session 2 of the project covered the controller and the lexical retrieval boundary.",
      { kind: "context", tags: ["session", "controller"] },
    );
    const livePhrase =
      "I don't have a specific summary for session 2 in the available memories.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(livePhrase));
    const out = await runRecall(handle, {
      text: "session 2",
      fetchImpl,
    });
    assert.equal(calls.length, 1, "provider must be called exactly once before reroute");
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(
      out.summaries.length > 0,
      "weak_match must surface at least one summary",
    );
    assert.ok(
      out.summaries.length <= 3,
      "weak_match must cap at 3 summaries",
    );
    assert.ok(out.coverage.topScore > 0, "coverage.topScore must be > 0");
    assert.ok(
      out.coverage.supportingCount > 0,
      "coverage.supportingCount must be > 0",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: weak_match (b) original failure paraphrase -> weak_match with the same shape", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse("I don't have specific details about that."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "weak_match");
    if (out.status !== "weak_match") throw new Error("unreachable");
    assert.ok(out.summaries.length > 0 && out.summaries.length <= 3);
    assert.ok(out.coverage.topScore > 0);
    assert.ok(out.coverage.supportingCount > 0);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: weak_match (c) strong-overlap control — substantive answer for '5 explorer subagents' must remain answered (regression guard)", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    // Store a summary that strongly overlaps the query.
    // The synthesis LLM is given this summary and returns a
    // substantive answer (no refusal). The controller must
    // route this as `answered`, NOT `weak_match`. This pins
    // that the refusal detector still gates the new
    // `weak_match` reroute — a substantive answer does not
    // trigger the new branch.
    insertSummary(
      handle,
      "The project dispatches 5 explorer subagents to scan the local store before answering.",
      { kind: "fact", tags: ["explorer", "subagents"] },
    );
    const answer =
      "The project dispatches 5 explorer subagents to scan the local store before answering.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "5 explorer subagents",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
    // The `weak_match` fields must NOT be present on an
    // answered outcome.
    assert.equal(out.summaries, undefined);
    assert.equal(out.coverage, undefined);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: weak_match (d) zero-overlap query -> no_memory (unchanged: thin-match branch does not fire when the ranker finds nothing)", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    // Insert summaries that share zero content tokens with
    // the query. The lexical ranker returns zero hits, the
    // controller short-circuits with `no_memory` BEFORE
    // calling the provider — so the new `weak_match` reroute
    // does not fire even if the provider would have
    // produced a refusal.
    insertSummary(
      handle,
      "The kitchen dishwasher runs nightly at 11pm Eastern.",
      { kind: "context", tags: ["kitchen", "schedule"] },
    );
    insertSummary(
      handle,
      "Office plants are watered on a biweekly rotation by the facilities team.",
      { kind: "context", tags: ["plants", "office"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      // Even with a refusal phrase, the ranker returning
      // empty means the provider is not called and the
      // controller returns `no_memory` directly.
      okChatResponse("I don't have any details about that topic."),
    );
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 0, "provider must not be called when the ranker finds nothing");
    assert.equal(out.status, "no_memory");
    if (out.status !== "no_memory") throw new Error("unreachable");
    assert.equal(out.summaries, undefined);
    assert.equal(out.coverage, undefined);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: weak_match (e) structuredContent.weak_match shape — <= 3 summaries, coverage has both fields, no `message` field on the wire", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    // Drive the controller to produce a real weak_match
    // outcome, then route it through the wire-format
    // projection helpers to assert the `structuredContent`
    // shape on the wire.
    insertSummary(
      handle,
      "Session 2 of the project covered the controller and the lexical retrieval boundary.",
      { kind: "context", tags: ["session", "controller"] },
    );
    insertSummary(
      handle,
      "Session 2 also covered the storage layer and the schema migrations.",
      { kind: "context", tags: ["session", "storage"] },
    );
    insertSummary(
      handle,
      "Session 2 included a deep dive on the safety pre-check classifier.",
      { kind: "context", tags: ["session", "safety"] },
    );
    insertSummary(
      handle,
      "Session 2 wrapped up with the benchmark corpus expansion.",
      { kind: "context", tags: ["session", "benchmark"] },
    );
    const { fetchImpl, calls } = scriptFetch(() =>
      okChatResponse(
        "I don't have a specific summary for session 2 in the available memories.",
      ),
    );
    const outcome = await runRecallController(handle, "session 2", {
      providerFetchImpl: fetchImpl,
      providerPrimaryApiKey: TEST_PRIMARY_KEY,
      providerPrimaryBaseUrl: TEST_PRIMARY_BASE_URL,
      providerPrimaryModel: TEST_PRIMARY_MODEL,
      providerFallbackApiKey: TEST_FALLBACK_KEY,
      providerFallbackBaseUrl: TEST_FALLBACK_BASE_URL,
      providerFallbackModel: TEST_FALLBACK_MODEL,
    });
    assert.equal(outcome.status, "weak_match");
    if (outcome.status !== "weak_match") throw new Error("unreachable");
    // Cap-at-3 invariant on the controller's outcome.
    assert.ok(
      outcome.summaries.length <= 3,
      `weak_match.summaries must be capped at 3 (got ${outcome.summaries.length})`,
    );
    // Coverage block has both fields, both numeric.
    assert.equal(typeof outcome.coverage.topScore, "number");
    assert.equal(typeof outcome.coverage.supportingCount, "number");
    assert.ok(outcome.coverage.topScore > 0);
    assert.ok(outcome.coverage.supportingCount > 0);
    // Build the wire-format `RecallResult` shape by hand
    // from the controller outcome (mirroring what
    // `formatOutcome` does for this status). The projection
    // helpers below read this `RecallResult` to produce the
    // public `text` and the `structuredContent`.
    const toolResult: RecallResult = {
      status: "weak_match",
      message: WEAK_MATCH_PUBLIC_MESSAGE,
      summaries: [...outcome.summaries],
      coverage: { ...outcome.coverage },
    };
    // The public `text` block is the locked public prose.
    const wireText = buildRecallPublicText(toolResult);
    assert.equal(wireText, WEAK_MATCH_PUBLIC_MESSAGE);
    // The structuredContent carries no `message` field.
    const wireStructured = buildRecallStructuredContent(toolResult);
    assert.equal(wireStructured.status, "weak_match");
    if (wireStructured.status !== "weak_match") throw new Error("unreachable");
    assert.ok(
      wireStructured.summaries !== undefined,
      "structuredContent.weak_match.summaries must be present",
    );
    assert.ok(
      wireStructured.summaries.length <= 3,
      "structuredContent.weak_match.summaries must be <= 3",
    );
    assert.ok(
      wireStructured.coverage !== undefined,
      "structuredContent.weak_match.coverage must be present",
    );
    assert.equal(typeof wireStructured.coverage.topScore, "number");
    assert.equal(typeof wireStructured.coverage.supportingCount, "number");
    // The `message` field is explicitly NOT on the wire.
    assert.equal(
      (wireStructured as unknown as { message?: unknown }).message,
      undefined,
      "structuredContent.weak_match must not include a `message` field",
    );
    // No memory-id reference anywhere in the summaries or
    // the coverage block (the no-IDs rule is enforced at
    // the schema level, but we still assert the surface is
    // clean).
    for (const s of wireStructured.summaries) {
      assert.ok(
        !/#[0-9]+/.test(s),
        "weak_match.summaries must not contain a `#N` memory-id reference",
      );
    }
    assert.equal(
      (wireStructured.coverage as unknown as { memoryId?: unknown }).memoryId,
      undefined,
      "weak_match.coverage must not contain a `memoryId` field",
    );
    assert.equal(
      (wireStructured.coverage as unknown as { id?: unknown }).id,
      undefined,
      "weak_match.coverage must not contain an `id` field",
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: weak_match (f) regression — substantive answer (false-positive guard) still routes to answered, not weak_match", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The project uses Postgres 16 for the primary store.",
      { kind: "fact", tags: ["postgres", "storage"] },
    );
    // A substantive answer that happens to contain the word
    // "details" in a normal sentence. The refusal detector
    // must NOT fire (the sentence is not a refusal shape),
    // and the controller must NOT reroute this to
    // `weak_match` — it stays as `answered`. This is the
    // regression guard for the new `weak_match` branch: a
    // false positive on `isProviderRefusal` would silently
    // move substantive answers out of `answered`.
    const answer =
      "The project uses Postgres 16. The reasoning behind that choice is its stronger JSON support and detailed schema validation.";
    const { fetchImpl, calls } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What database does the project use?",
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    assert.equal(out.answer, answer);
    assert.equal(out.summaries, undefined);
    assert.equal(out.coverage, undefined);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// 17. Memory-id reference strip (controller validateAnswer)
// ---------------------------------------------------------------------------
//
// These tests cover the new `stripMemoryIdReferences` pass inside
// `validateAnswer`. The pass enforces the no-IDs-in-public-text
// invariant on the `answered` content path: the synthesis LLM may
// echo the id-bearing `- #N kind: summary` format it sees in its
// prompt, and that echo must not reach the public `text` block.
//
// Each test drives the controller end-to-end through
// `runRecallController` (the same scaffolding as the rest of this
// file) and asserts on `out.answer`, which is the post-validation
// text the tool layer exposes as the public `content[0].text`.

test("recall: memory-id leak stripping — Memory #N is replaced with [memory] in the public text", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The lexical-only production recall boundary is documented in the curion project.",
      { kind: "fact", tags: ["lexical", "recall", "boundary"] },
    );
    // The scripted answer echoes a memory-id reference the way
    // the live Q15 failure did. The strip pass must remove the
    // reference from the public text.
    const answer =
      "Memory #20 documents the lexical-only production recall boundary. Memory #20 also references the curion project.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What is the lexical-only production recall boundary?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The public answer must not contain the id-bearing forms.
    assert.ok(
      !/Memory #20/i.test(out.answer),
      `public answer must not contain "Memory #20" (any case); got: ${out.answer}`,
    );
    assert.ok(
      !/#20\b/.test(out.answer),
      `public answer must not contain a bare "#20" reference; got: ${out.answer}`,
    );
    // The strip pass replaces the reference with the placeholder
    // `[memory]`. The two adjacent "Memory #20" mentions collapse
    // to a single placeholder so the public text is not noisy.
    assert.ok(
      out.answer.includes("[memory]"),
      `public answer must contain the "[memory]" placeholder; got: ${out.answer}`,
    );
    // The surrounding sentence structure is preserved: the
    // curion project reference survives, and the rest of the
    // prose is intact.
    assert.ok(
      out.answer.includes("curion project"),
      `public answer must preserve the "curion project" reference; got: ${out.answer}`,
    );
    assert.ok(
      out.answer.includes("lexical-only production recall boundary"),
      `public answer must preserve the surrounding sentence; got: ${out.answer}`,
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: memory-id leak stripping — bare #N and noun-prefixed #N are stripped", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The lexical-only recall boundary and the FTS5 sync decision are core curion design choices.",
      { kind: "fact", tags: ["lexical", "fts5", "sync"] },
    );
    // The scripted answer uses three id-bearing forms: a
    // noun-prefixed "entry #N", a bare "see #N", and a bare
    // "in #N" mid-sentence. The strip pass must remove all of
    // them.
    const answer =
      "The lexical-only recall is documented in entry #15. See also #42 for the FTS5 sync decision.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What is the lexical-only recall boundary?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // No id-bearing forms remain in the public answer.
    assert.ok(
      !/#15\b/.test(out.answer),
      `public answer must not contain "#15"; got: ${out.answer}`,
    );
    assert.ok(
      !/#42\b/.test(out.answer),
      `public answer must not contain "#42"; got: ${out.answer}`,
    );
    assert.ok(
      !/entry #\d+/i.test(out.answer),
      `public answer must not contain "entry #N"; got: ${out.answer}`,
    );
    // The strip pass inserts [memory] placeholders. With the
    // adjaceny-collapse rule, two adjacent [memory] insertions
    // (the bare #42 and the entry #15) collapse to one.
    assert.ok(
      out.answer.includes("[memory]"),
      `public answer must contain the "[memory]" placeholder; got: ${out.answer}`,
    );
    // The surrounding sentence content is preserved.
    assert.ok(
      out.answer.includes("lexical-only recall"),
      `public answer must preserve the surrounding sentence; got: ${out.answer}`,
    );
    assert.ok(
      out.answer.includes("FTS5 sync decision"),
      `public answer must preserve the FTS5 reference; got: ${out.answer}`,
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: memory-id leak stripping — false-positive guard, URL with #fragment is preserved", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The curion GitHub repository tracks issues and pull requests against the production recall boundary.",
      { kind: "fact", tags: ["curion", "github", "issues"] },
    );
    // The scripted answer contains both a URL with a fragment
    // (must be preserved) and a bare #N mid-sentence (must be
    // stripped).
    const answer =
      "The GitHub issue is at https://github.com/curion/curion/issues/37. The PR is #42.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "Where is the curion issue tracker?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The URL is preserved: the `/` and `://` characters in the
    // URL are not in the bare-#N allowlist, so the strip pass
    // must not touch the #37 fragment inside the path.
    assert.ok(
      out.answer.includes("https://github.com/curion/curion/issues/37"),
      `public answer must preserve the URL with #fragment; got: ${out.answer}`,
    );
    // The bare "#42" mid-sentence IS stripped. The pattern
    // matches because "#42" follows the space after "is".
    assert.ok(
      !/#42\b/.test(out.answer),
      `public answer must not contain the bare "#42" reference; got: ${out.answer}`,
    );
    // The placeholder is present where the bare #42 used to be.
    assert.ok(
      out.answer.includes("[memory]"),
      `public answer must contain the "[memory]" placeholder; got: ${out.answer}`,
    );
  } finally {
    rmStorage(tmp, handle);
  }
});

test("recall: memory-id leak stripping — answers without id references are unchanged", async () => {
  const { tmp, handle } = mkStorage("curion-recall-");
  try {
    insertSummary(
      handle,
      "The lexical-only production recall boundary is documented in the curion project.",
      { kind: "fact", tags: ["lexical", "recall", "boundary"] },
    );
    // The scripted answer contains no id-bearing forms. The
    // strip pass must be a no-op: no placeholder is inserted,
    // and the answer is returned verbatim.
    const answer =
      "The lexical-only production recall boundary is documented in the project.";
    const { fetchImpl } = scriptFetch(() => okChatResponse(answer));
    const out = await runRecall(handle, {
      text: "What is the lexical-only production recall boundary?",
      fetchImpl,
    });
    assert.equal(out.status, "answered");
    if (out.status !== "answered") throw new Error("unreachable");
    // The answer is unchanged — no placeholder insertion, no
    // mutation of the prose.
    assert.equal(out.answer, answer);
    assert.ok(
      !out.answer.includes("[memory]"),
      `public answer must not contain the "[memory]" placeholder when no id references are present; got: ${out.answer}`,
    );
    assert.ok(
      !/#\d/.test(out.answer),
      `public answer must not contain any "#N" reference when no id references are present; got: ${out.answer}`,
    );
  } finally {
    rmStorage(tmp, handle);
  }
});
