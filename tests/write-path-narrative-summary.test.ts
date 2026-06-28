/**
 * Tests for the write-path synthesis prompt used by
 * `analyzeMemoryWithFallback`.
 *
 * These are prompt-shape tests: they drive the adapter with a
 * scripted `fetch` (no real LLM call) and assert that the user
 * message sent to the provider contains the new narrative-voice
 * guidance. They do not assert on the LLM's response to a real
 * call.
 *
 * Coverage (per task spec):
 *   1. User preference input    -> prompt contains narrative guidance
 *                                  and the input is passed through.
 *   2. Project fact input       -> prompt contains narrative guidance
 *                                  and the input is passed through.
 *   3. Decision input           -> prompt contains narrative guidance
 *                                  and the input is passed through.
 *   4. Constraint input         -> prompt contains narrative guidance
 *                                  and the input is passed through.
 *   5. Empty / pure-procedural  -> result is rejected at the adapter
 *                                  level (invalid-input); no http
 *                                  call is made.
 *
 * In addition, a single test pins the exact new guidance text and
 * verifies that the legacy "1-2 sentence summary of the input"
 * curator framing is no longer present in the prompt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMemoryWithFallback,
  type MemoryAnalysisResult,
} from "../src/providers/memory-analysis.ts";
import {
  TEST_PRIMARY_KEY,
  TEST_FALLBACK_KEY,
  TEST_PRIMARY_BASE_URL,
  TEST_PRIMARY_MODEL,
  TEST_FALLBACK_BASE_URL,
  TEST_FALLBACK_MODEL,
} from "./shared-test-provider.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror the pattern used in tests/provider-adapter.test.ts)
// ---------------------------------------------------------------------------

/**
 * A `fetch` stub that serves a scripted list of responses, one per
 * call. Records the URL and request body of every call so tests can
 * assert on the user message sent to the provider.
 */
function scriptedFetch(
  responses: Array<() => Response>,
  log: Array<{ url: string; body: string }>,
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
    return responses[i++]();
  };
  return f;
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

const VALID_JSON = JSON.stringify({
  summary: "A short narrative summary of the input.",
  confidence: 0.82,
  tags: ["test"],
});

/** Run the adapter with a one-shot scripted fetch and return the log + result. */
async function runOnce(
  text: string,
): Promise<{
  log: Array<{ url: string; body: string }>;
  result: MemoryAnalysisResult;
}> {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
  const result = await analyzeMemoryWithFallback(text, undefined, {
    primaryApiKey: TEST_PRIMARY_KEY,
    fallbackApiKey: TEST_FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });
  return { log, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("write-path prompt: user preference input -> prompt contains narrative guidance and input", async () => {
  const input = "I prefer TypeScript with strict mode for all new projects.";
  const { log, result } = await runOnce(input);

  assert.equal(result.ok, true, "adapter should succeed with scripted fetch");
  assert.equal(log.length, 1, "exactly one http call");

  const body = log[0]!.body;
  // The new narrative-voice guidance must be present.
  assert.match(
    body,
    /narrative memory/,
    "user message must include the new narrative-voice prompt text",
  );
  // The legacy curator framing must be gone.
  assert.doesNotMatch(
    body,
    /1-2 sentence summary of the input/,
    "legacy curator framing must be removed from the prompt",
  );
  // The user input must be present in the request body.
  assert.ok(
    body.includes("TypeScript") && body.includes("strict"),
    "user input must be passed through to the provider",
  );
});

test("write-path prompt: project fact input -> prompt contains narrative guidance and input", async () => {
  const input =
    "The curion project uses the lexical-only production recall boundary, " +
    "with dense/vector/hybrid variants confined to src/benchmark/.";
  const { log, result } = await runOnce(input);

  assert.equal(result.ok, true);
  assert.equal(log.length, 1);

  const body = log[0]!.body;
  assert.match(body, /narrative memory/);
  assert.doesNotMatch(body, /1-2 sentence summary of the input/);
  // The concrete terms from the input must be present in the body.
  assert.ok(
    body.includes("lexical-only") &&
      body.includes("production recall") &&
      body.includes("src/benchmark/"),
    "concrete terms from the input must be passed through to the provider",
  );
});

test("write-path prompt: decision input -> prompt contains narrative guidance and input", async () => {
  const input =
    "We decided to use Anthropic's contextualized chunk pattern " +
    "(50-100 token LLM-generated context prefix) for the write path improvement.";
  const { log, result } = await runOnce(input);

  assert.equal(result.ok, true);
  assert.equal(log.length, 1);

  const body = log[0]!.body;
  assert.match(body, /narrative memory/);
  assert.doesNotMatch(body, /1-2 sentence summary of the input/);
  // The decision and concrete reference must be passed through.
  assert.ok(
    body.includes("Anthropic") &&
      body.includes("contextualized chunk pattern") &&
      body.includes("write path improvement"),
    "decision and concrete reference must be passed through to the provider",
  );
});

test("write-path prompt: constraint input -> prompt contains narrative guidance and input", async () => {
  const input =
    "The synthesis prompt must not exceed 500 characters per summary " +
    "to fit the storage budget.";
  const { log, result } = await runOnce(input);

  assert.equal(result.ok, true);
  assert.equal(log.length, 1);

  const body = log[0]!.body;
  assert.match(body, /narrative memory/);
  assert.doesNotMatch(body, /1-2 sentence summary of the input/);
  // The constraint must be passed through.
  assert.ok(
    body.includes("500 characters") &&
      body.includes("storage budget") &&
      body.includes("synthesis prompt"),
    "constraint must be passed through to the provider",
  );
});

test("write-path prompt: empty / pure-procedural input -> invalid-input, no http call", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
  const result = await analyzeMemoryWithFallback("   ", undefined, {
    primaryApiKey: TEST_PRIMARY_KEY,
    fallbackApiKey: TEST_FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });

  assert.equal(result.ok, false, "empty input must be rejected");
  if (!result.ok) {
    assert.equal(result.kind, "invalid-input");
  }
  assert.equal(log.length, 0, "no http call for empty input");
});

test("write-path prompt: pinned narrative guidance text is present verbatim", async () => {
  const { log, result } = await runOnce("any input at all");

  assert.equal(result.ok, true);
  assert.equal(log.length, 1);

  const body = log[0]!.body;
  // The body is a JSON-encoded chat-completions request, so any
  // inner double-quotes from the prompt guidance will be
  // backslash-escaped. We account for that when pinning the exact
  // text. If the prompt is later regressed, this test will fail.
  assert.ok(
    body.includes(
      "Write a 1-3 sentence narrative memory that preserves the useful context from the input.",
    ),
    "exact narrative guidance phrase must be present",
  );
  assert.ok(
    body.includes(
      'Do not start with \\"The user asked\\", \\"This memory captures\\", or similar curator framings.',
    ),
    "curator-framing prohibition must be present (JSON-escaped)",
  );
  assert.ok(
    body.includes("Do not include memory IDs or internal storage references."),
    "no-IDs prohibition must be present",
  );
});
