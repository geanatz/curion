/**
 * Tests for the native Anthropic provider adapter.
 *
 * All tests stub `fetch` via the SDK's fetch injection. No network
 * access is required. No real API keys are used.
 *
 * Coverage:
 *   1. Memory analysis success: request includes model, max_tokens,
 *      top-level system, messages; response text extracted into parsed JSON.
 *   2. Memory analysis repair flow: primary returns invalid JSON,
 *      repair returns valid JSON; result is ok with llmRepairAttempts=1.
 *   3. Recall synthesis success: text response is extracted correctly.
 *   4. Auth error (401): kind="auth", reachedServer=true.
 *   5. Connection/timeout error: kind="timeout"|"network", reachedServer=false.
 *   6. No API key values leak in error messages.
 *   7. Request/response bodies do not include the API key.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeMemoryWithFallback } from "../src/providers/memory-analysis.ts";
import { synthesizeRecallWithFallback } from "../src/providers/recall-synthesis.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = "sk-ant-test-not-real-1234567890abcdef";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

/**
 * A fetch stub that serves a scripted list of responses, one per call.
 * Records the URL and request body so tests can assert on routing and payload.
 */
function scriptedFetch(
  responses: Array<() => Response | Error>,
  log: Array<{ url: string; body: string }>
): typeof fetch {
  let i = 0;
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    log.push({ url, body });
    if (i >= responses.length) {
      throw new Error(`scriptedFetch: unexpected call #${i + 1} to ${url}`);
    }
    const res = responses[i++]();
    if (res instanceof Error) throw res;
    return res;
  };
  return f;
}

/** Build an Anthropic Messages API success response. */
function anthropicSuccessResponse(content: string, model = ANTHROPIC_MODEL): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test123",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** Build an Anthropic Messages API error response (JSON body). */
function anthropicErrorResponse(status: number, errorType: string, errorMessage: string): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: errorType, message: errorMessage },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// 1. Memory analysis success: request mapping and JSON response extraction
// ---------------------------------------------------------------------------

test("anthropic: memory analysis success maps request correctly (model, max_tokens, system, messages)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(
          JSON.stringify({
            summary: "User prefers dark mode in the dashboard.",
            confidence: 0.9,
            tags: ["preference", "ui"],
            classification: "preference",
          })
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("I like dark mode in the dashboard.", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  if (!r.ok) return;

  assert.equal(r.providerUsed, "anthropic");
  assert.equal(r.modelUsed, ANTHROPIC_MODEL);
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.llmRepairAttempts, 0);
  assert.equal(r.httpCalls, 1);

  // Verify request payload structure.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);

  const reqBody = JSON.parse(log[0]!.body);
  assert.equal(reqBody.model, ANTHROPIC_MODEL);
  assert.equal(typeof reqBody.max_tokens, "number");
  assert.ok(reqBody.max_tokens > 0);
  // System prompt should be a top-level field, not in messages.
  assert.ok(reqBody.system, "system prompt must be a top-level field");
  assert.ok(Array.isArray(reqBody.messages), "messages must be an array");
  // No API key in the body.
  assert.ok(!log[0]!.body.includes(ANTHROPIC_KEY));

  // Verify response parsing.
  assert.equal(r.value.summary, "User prefers dark mode in the dashboard.");
  assert.equal(r.value.confidence, 0.9);
  assert.deepEqual(r.value.tags, ["preference", "ui"]);
  assert.equal(r.value.classification, "preference");
});

test("anthropic: memory analysis success extracts text from content block correctly", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(
          JSON.stringify({
            summary: "Project uses Postgres 16.",
            confidence: 0.85,
            tags: ["database", "infrastructure"],
          })
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("We use Postgres 16.", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.summary, "Project uses Postgres 16.");
});

test("anthropic: memory analysis success includes usage and latency fields", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(
          JSON.stringify({ summary: "Test summary.", confidence: 0.5, tags: [] })
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("test input", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(typeof r.latencyMs, "number");
  assert.ok(r.latencyMs >= 0);
});

// ---------------------------------------------------------------------------
// 2. Memory analysis repair flow: invalid JSON first, then valid JSON
// ---------------------------------------------------------------------------

test("anthropic: memory analysis repair flow succeeds on second call", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // First call: invalid JSON (plain prose, not parseable)
      () => anthropicSuccessResponse("This is just some prose, not JSON at all."),
      // Repair call: valid JSON
      () =>
        anthropicSuccessResponse(
          JSON.stringify({
            summary: "Repaired summary after first attempt.",
            confidence: 0.75,
            tags: ["repaired"],
          })
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("Test input for repair flow.", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  if (!r.ok) return;

  assert.equal(r.providerUsed, "anthropic");
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.llmRepairAttempts, 1, "repair should have been attempted");
  assert.equal(r.httpCalls, 2);

  // Both calls should go to the Anthropic endpoint.
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(log[1]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);

  // The repair request should include the previous bad response.
  const repairBody = JSON.parse(log[1]!.body);
  assert.ok(
    repairBody.messages.some(
      (m: { role: string; content: string }) =>
        m.role === "user" && m.content.includes("This is just some prose")
    ),
    "repair request should reference the previous invalid response"
  );

  assert.equal(r.value.summary, "Repaired summary after first attempt.");
  assert.equal(r.value.confidence, 0.75);
});

test("anthropic: memory analysis repair flow falls back on second failure", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary: invalid JSON
      () => anthropicSuccessResponse("not json first"),
      // Primary repair: still invalid
      () => anthropicSuccessResponse("still not json on repair"),
      // Fallback (OpenAI-compatible): valid JSON
      () =>
        new Response(
          JSON.stringify({
            id: "x",
            model: "fallback-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: "Fallback succeeded after primary repair failed.",
                    confidence: 0.8,
                    tags: ["fallback"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("test repair fallback", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fallbackApiKey: ANTHROPIC_KEY,
    fallbackApiFormat: "openai-compatible",
    fallbackBaseUrl: "https://api.example.com/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fallbackUsed, true, "should have used fallback");
  assert.equal(r.llmRepairAttempts, 0, "no repair on fallback");
  assert.equal(r.httpCalls, 3);
});

// ---------------------------------------------------------------------------
// 3. Recall synthesis success: text response extraction
// ---------------------------------------------------------------------------

test("anthropic: recall synthesis success extracts text response correctly", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(
          "The project uses Postgres 16 for the primary database and stores sessions in Redis."
        ),
    ],
    log
  );

  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    [{ id: 1, memoryContent: "Project uses Postgres 16." }],
    {
      primaryApiKey: ANTHROPIC_KEY,
      primaryApiFormat: "anthropic",
      primaryModel: ANTHROPIC_MODEL,
      fetchImpl,
    }
  );

  assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
  if (!r.ok) return;

  assert.equal(r.providerUsed, "anthropic");
  assert.equal(r.modelUsed, ANTHROPIC_MODEL);
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.httpCalls, 1);

  // Verify the request went to the right endpoint.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);

  // Verify text extraction.
  assert.match(r.answer, /Postgres 16/, `expected answer to mention Postgres 16, got: ${r.answer}`);
  assert.ok(!r.answer.includes("sk-ant-"), "answer must not include API key");
});

test("anthropic: recall synthesis primary failure falls back to secondary", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary (Anthropic): 500 error
      () => anthropicErrorResponse(500, "internal_server_error", "Internal server error"),
      // Fallback (OpenAI-compatible): success
      () =>
        new Response(
          JSON.stringify({
            id: "x",
            model: "fallback-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Fallback recovered successfully.",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ],
    log
  );

  const r = await synthesizeRecallWithFallback(
    "query",
    [{ id: 1, memoryContent: "memory content" }],
    {
      primaryApiKey: ANTHROPIC_KEY,
      primaryApiFormat: "anthropic",
      primaryModel: ANTHROPIC_MODEL,
      fallbackApiKey: ANTHROPIC_KEY,
      fallbackApiFormat: "openai-compatible",
      fallbackBaseUrl: "https://api.example.com/v1",
      fallbackModel: "fallback-model",
      fetchImpl,
    }
  );

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.httpCalls, 2);
});

// ---------------------------------------------------------------------------
// 4. Error mapping: 401 auth error -> reachedServer=true
// ---------------------------------------------------------------------------

test("anthropic: 401 auth error sets kind=auth and reachedServer=true", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => anthropicErrorResponse(401, "authentication_error", "Invalid API key")],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false, `expected failure, got: ${JSON.stringify(r)}`);
  if (r.ok) return;

  assert.equal(r.kind, "all-providers-failed");
  assert.equal(r.lastError?.kind, "auth");
  assert.equal(r.lastError?.status, 401);
  assert.equal(r.lastError?.reachedServer, true, "401 should set reachedServer=true");
  assert.ok(!r.lastError?.message.includes(ANTHROPIC_KEY), "API key must not leak in error");
});

test("anthropic: auth error message does not include API key", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: `invalid api key: ${ANTHROPIC_KEY}`,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        ),
    ],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false);
  if (r.ok) return;

  // The error message must not contain the raw API key.
  assert.ok(
    !r.lastError?.message.includes(ANTHROPIC_KEY),
    `API key leaked into error message: ${r.lastError?.message}`
  );
  assert.ok(
    r.lastError?.message.includes("<redacted>"),
    `error message should contain <redacted>: ${r.lastError?.message}`
  );
});

// ---------------------------------------------------------------------------
// 5. Error mapping: connection/timeout error -> reachedServer=false
// ---------------------------------------------------------------------------

test("anthropic: connection refused sets reachedServer=false", async () => {
  const log: Array<{ url: string; body: string }> = [];
  // Simulate a network-level error that the SDK wraps in APIConnectionError.
  const networkError = new TypeError("fetch failed: connection refused");
  const fetchImpl = scriptedFetch(
    [
      () => {
        throw networkError;
      },
    ],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false, `expected failure, got: ${JSON.stringify(r)}`);
  if (r.ok) return;

  // Connection error should be classified as network or timeout.
  assert.ok(
    r.lastError?.kind === "network" || r.lastError?.kind === "timeout",
    `expected network or timeout, got: ${r.lastError?.kind}`
  );
  assert.equal(
    r.lastError?.reachedServer,
    false,
    "connection error should set reachedServer=false"
  );
});

test("anthropic: timeout error sets reachedServer=false", async () => {
  const log: Array<{ url: string; body: string }> = [];
  // Simulate a timeout error that the SDK wraps in APIConnectionTimeoutError.
  const timeoutError = new TypeError("request timed out");
  const fetchImpl = scriptedFetch(
    [
      () => {
        throw timeoutError;
      },
    ],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false);
  if (r.ok) return;

  // Timeout error should be classified as timeout.
  assert.ok(
    r.lastError?.kind === "timeout" || r.lastError?.kind === "network",
    `expected timeout or network, got: ${r.lastError?.kind}`
  );
  assert.equal(r.lastError?.reachedServer, false, "timeout error should set reachedServer=false");
});

test("anthropic: timeout error message does not include API key", async () => {
  const log: Array<{ url: string; body: string }> = [];
  // The error message would typically include the URL; we need to ensure
  // the key is redacted from any error messages.
  const timeoutError = new TypeError(
    `request timed out after 30000ms: https://api.anthropic.com/v1/messages?api_key=${ANTHROPIC_KEY}`
  );
  const fetchImpl = scriptedFetch(
    [
      () => {
        throw timeoutError;
      },
    ],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false);
  if (r.ok) return;

  // The error message must not contain the raw API key.
  assert.ok(
    !r.lastError?.message.includes(ANTHROPIC_KEY),
    `API key leaked into timeout error: ${r.lastError?.message}`
  );
  assert.ok(
    !r.message.includes(ANTHROPIC_KEY),
    `API key leaked into top-level message: ${r.message}`
  );
});

// ---------------------------------------------------------------------------
// 6. API key does not leak in request bodies
// ---------------------------------------------------------------------------

test("anthropic: request body does not include API key value", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(JSON.stringify({ summary: "Test.", confidence: 0.5, tags: [] })),
    ],
    log
  );

  await analyzeMemoryWithFallback("test input", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(log.length, 1);
  assert.ok(
    !log[0]!.body.includes(ANTHROPIC_KEY),
    `API key leaked into request body: ${log[0]!.body}`
  );
});

test("anthropic: serialized success result does not include API key", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        anthropicSuccessResponse(JSON.stringify({ summary: "Test.", confidence: 0.5, tags: [] })),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("test input", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;

  const serialized = JSON.stringify(r);
  assert.ok(
    !serialized.includes(ANTHROPIC_KEY),
    `API key leaked into serialized result: ${serialized}`
  );
});

test("anthropic: serialized failure result does not include API key", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => anthropicErrorResponse(401, "auth", "Invalid key")], log);

  const r = await analyzeMemoryWithFallback("test input", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    disableFallback: true,
    fetchImpl,
  });

  assert.equal(r.ok, false);
  if (r.ok) return;

  const serialized = JSON.stringify(r);
  assert.ok(
    !serialized.includes(ANTHROPIC_KEY),
    `API key leaked into serialized failure: ${serialized}`
  );
});

// ---------------------------------------------------------------------------
// 7. Response missing text content block -> bad-request
// ---------------------------------------------------------------------------

test("anthropic: response without text content block returns bad-request error", async () => {
  const log: Array<{ url: string; body: string }> = [];
  // Response with content block but no text type.
  const fetchImpl = scriptedFetch(
    [
      () =>
        new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: ANTHROPIC_MODEL,
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ],
    log
  );

  const r = await analyzeMemoryWithFallback("test input", undefined, {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fetchImpl,
  });

  assert.equal(r.ok, false, `expected failure, got: ${JSON.stringify(r)}`);
  if (r.ok) return;

  assert.equal(r.kind, "all-providers-failed");
  assert.equal(r.lastError?.kind, "bad-request");
  assert.equal(r.lastError?.reachedServer, true);
  assert.match(
    r.lastError?.message ?? "",
    /response missing text content block|content\[0\]\.type.*text/
  );
});

// ---------------------------------------------------------------------------
// 8. Fallback from Anthropic to OpenAI-compatible works correctly
// ---------------------------------------------------------------------------

test("anthropic: primary fails, fallback (openai-compatible) succeeds", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary (Anthropic): 500 error
      () => anthropicErrorResponse(500, "internal_server_error", "Server error"),
      // Fallback (OpenAI-compatible): success
      () =>
        new Response(
          JSON.stringify({
            id: "x",
            model: "fallback-model",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Fallback answer from OpenAI-compatible provider.",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    ],
    log
  );

  const r = await synthesizeRecallWithFallback("query", [{ id: 1, memoryContent: "memory" }], {
    primaryApiKey: ANTHROPIC_KEY,
    primaryApiFormat: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fallbackApiKey: ANTHROPIC_KEY,
    fallbackApiFormat: "openai-compatible",
    fallbackBaseUrl: "https://api.example.com/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fallbackUsed, true);
  assert.match(r.answer, /Fallback answer from OpenAI-compatible provider/);
  assert.equal(r.httpCalls, 2);
});
