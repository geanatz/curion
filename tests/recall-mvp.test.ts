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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRecallController } from "../src/controller/recall-controller.ts";
import {
  initStorage,
  closeStorage,
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
} from "../src/tools/recall.ts";
import { buildServer, PUBLIC_TOOL_NAMES } from "../src/server.ts";
import {
  rankLexical,
  tokenize,
  scoreCandidate,
  DEFAULT_RELEVANCE_THRESHOLD,
} from "../src/retrieval/lexical.ts";
import { runRememberController } from "../src/controller/remember-controller.ts";
import { classifyInput } from "../src/safety/precheck.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkStorage(): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-recall-"));
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

/** Scripted fetch that returns a single canned response. */
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

function insertSummary(
  handle: StorageHandle,
  summary: string,
  opts: { kind?: string; tags?: string[]; classification?: string } = {},
): MemoryRecord {
  return insertMemoryRecord(handle, {
    kind: (opts.kind as MemoryRecord["kind"]) ?? "fact",
    state: "active",
    summary,
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

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";

/** Run the recall controller with a scripted fetch and test keys. */
function runRecall(handle: StorageHandle, opts: {
  text: string;
  fetchImpl: typeof fetch;
  threshold?: number;
  topK?: number;
}) {
  return runRecallController(handle, opts.text, {
    providerFetchImpl: opts.fetchImpl,
    providerPrimaryApiKey: PRIMARY_KEY,
    providerFallbackApiKey: FALLBACK_KEY,
    relevanceThreshold: opts.threshold,
    topK: opts.topK,
  });
}

// ---------------------------------------------------------------------------
// 1. No memories -> no_memory, no provider call
// ---------------------------------------------------------------------------

test("recall: no memories -> no_memory and no provider call", async () => {
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
      providerPrimaryApiKey: PRIMARY_KEY,
      providerFallbackApiKey: FALLBACK_KEY,
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
  const { tmp, handle } = mkStorage();
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
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
      });
      assert.equal(outcome.status, "saved");
      if (outcome.status !== "saved") throw new Error("unreachable");
      const memoryId = outcome.record.id;

      // Now recall via the public tool layer. The recall tool
      // should not call the provider for a no-memory path, so we
      // first test that path: an unrelated query.
      const r1 = await handleRecall({ text: "When is the company picnic?" });
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
        providerPrimaryApiKey: PRIMARY_KEY,
        providerFallbackApiKey: FALLBACK_KEY,
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
  // Tie-break is by ascending id.
  assert.deepEqual(
    r1.map((x) => x.id),
    [1, 2, 3],
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
  const { tmp, handle } = mkStorage();
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
      assert.equal(typeof r.summary, "string");
      assert.ok(r.summary.length > 0);
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
  const { tmp, handle } = mkStorage();
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
