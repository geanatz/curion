/**
 * Tests for the real provider adapter layer.
 *
 * All tests stub `fetch`. No network access is required.
 *
 * Coverage (per task spec):
 *   1. primary success -> no fallback
 *   2. primary hard failure -> fallback success
 *   3. primary invalid JSON -> repair success on same provider
 *   4. primary invalid JSON + failed repair -> fallback success
 *   5. both providers fail -> typed all-providers-failed result
 *   6. no API key/config -> typed missing-config result
 *   7. provider metadata and fallbackUsed flag are correct
 *   8. no public tool surface change
 *  Plus:
 *   - result is sanitized: no API key value in any serialized field
 *   - input text is not echoed in the result
 *   - invalid input is rejected with a typed result (no HTTP call)
 *   - defaults match the documented model names and base URLs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMemoryWithFallback,
  loadAdapterConfig,
  COMPARISON_NIM_MODEL,
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_NIM_BASE_URL,
  DEFAULT_NIM_FALLBACK_MODEL,
  type MemoryAnalysisResult,
} from "../src/providers/memory-analysis.ts";
import { PUBLIC_TOOL_NAMES, buildServer } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A `fetch` stub that serves a scripted list of responses, one per
 * call. Records the URL and request body of every call so tests
 * can assert on routing and payload.
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

function httpErrorResponse(status: number, text = "boom"): Response {
  return new Response(text, { status });
}

const VALID_JSON = JSON.stringify({
  summary: "A short summary of the input.",
  confidence: 0.82,
  tags: ["project", "memory"],
  entities: [{ name: "Curion", kind: "project" }],
  classification: "project-context",
});

const PRIMARY_KEY = "sk-primary-test-not-real-12345";
const FALLBACK_KEY = "nvapi-fallback-test-not-real-12345";

/** Save and restore a fixed set of env vars around a test body. */
function withCleanEnv<T>(
  keys: string[],
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const before: Record<string, string | undefined> = {};
  for (const k of keys) before[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      const v = before[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const ENV_KEYS = [
  "CURION_PROVIDER_PRIMARY_KEY",
  "MINIMAX_API_KEY",
  "CURION_PROVIDER_FALLBACK_KEY",
  "NVIDIA_NIM_API_KEY",
  "CURION_MINIMAX_BASE_URL",
  "CURION_MINIMAX_MODEL",
  "CURION_NIM_BASE_URL",
  "CURION_NIM_FALLBACK_MODEL",
  "CURION_ADAPTER_TIMEOUT_MS",
  "CURION_ADAPTER_MAX_TOKENS",
];

// ---------------------------------------------------------------------------
// Defaults / config
// ---------------------------------------------------------------------------

test("adapter: loadAdapterConfig returns the documented defaults", () => {
  return withCleanEnv(ENV_KEYS, () => {
    const cfg = loadAdapterConfig();
    assert.equal(cfg.primaryBaseUrl, DEFAULT_MINIMAX_BASE_URL);
    assert.equal(cfg.primaryBaseUrl, "https://api.minimax.io/v1");
    assert.equal(cfg.primaryModel, DEFAULT_MINIMAX_MODEL);
    assert.equal(cfg.primaryModel, "MiniMax-M3");
    assert.equal(cfg.fallbackBaseUrl, DEFAULT_NIM_BASE_URL);
    assert.equal(cfg.fallbackBaseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(cfg.fallbackModel, DEFAULT_NIM_FALLBACK_MODEL);
    assert.equal(cfg.fallbackModel, "openai/gpt-oss-120b");
    assert.equal(typeof cfg.timeoutMs, "number");
    assert.equal(cfg.timeoutMs, 30_000);
    assert.equal(typeof cfg.maxTokens, "number");
    assert.equal(cfg.maxTokens, 1024);
    // Default fallback is NOT the comparison model.
    assert.notEqual(cfg.fallbackModel, COMPARISON_NIM_MODEL);
    assert.equal(COMPARISON_NIM_MODEL, "meta/llama-3.3-70b-instruct");
  });
});

test("adapter: loadAdapterConfig treats whitespace-only env values as missing", () => {
  return withCleanEnv(ENV_KEYS, () => {
    // Set every env var to a whitespace-only placeholder. None of
    // these should be treated as configured values.
    process.env.CURION_PROVIDER_PRIMARY_KEY = "   ";
    process.env.MINIMAX_API_KEY = "\t\n  ";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "  \n";
    process.env.NVIDIA_NIM_API_KEY = " ";
    process.env.CURION_MINIMAX_BASE_URL = "  ";
    process.env.CURION_MINIMAX_MODEL = "   ";
    process.env.CURION_NIM_BASE_URL = " \t ";
    process.env.CURION_NIM_FALLBACK_MODEL = "   ";
    const cfg = loadAdapterConfig();
    // Built-in defaults must still be used for URLs/models.
    assert.equal(cfg.primaryBaseUrl, DEFAULT_MINIMAX_BASE_URL);
    assert.equal(cfg.primaryModel, DEFAULT_MINIMAX_MODEL);
    assert.equal(cfg.fallbackBaseUrl, DEFAULT_NIM_BASE_URL);
    assert.equal(cfg.fallbackModel, DEFAULT_NIM_FALLBACK_MODEL);
    // And both keys must be empty so the adapter returns missing-config.
    assert.equal(cfg.primaryApiKey, "");
    assert.equal(cfg.fallbackApiKey, "");
  });
});

test("adapter: loadAdapterConfig trims surrounding whitespace from env values", () => {
  return withCleanEnv(ENV_KEYS, () => {
    process.env.CURION_PROVIDER_PRIMARY_KEY = `  ${PRIMARY_KEY}\n`;
    process.env.CURION_MINIMAX_BASE_URL = ` ${DEFAULT_MINIMAX_BASE_URL} `;
    const cfg = loadAdapterConfig();
    assert.equal(cfg.primaryApiKey, PRIMARY_KEY);
    assert.equal(cfg.primaryBaseUrl, DEFAULT_MINIMAX_BASE_URL);
  });
});

test("adapter: loadAdapterConfig treats whitespace-only overrides as missing", () => {
  const cfg = loadAdapterConfig({
    primaryApiKey: "   ",
    primaryBaseUrl: "  ",
    primaryModel: "\t",
  });
  // Whitespace-only overrides fall through to env/defaults; with
  // env clean, defaults are used.
  assert.equal(cfg.primaryApiKey, "");
  assert.equal(cfg.primaryBaseUrl, DEFAULT_MINIMAX_BASE_URL);
  assert.equal(cfg.primaryModel, DEFAULT_MINIMAX_MODEL);
});

test("adapter: whitespace-only primary key in env -> typed missing-config (no http calls)", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    process.env.CURION_PROVIDER_PRIMARY_KEY = "   ";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "  \t  ";
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [() => okChatResponse(VALID_JSON)],
      log,
    );
    const r = await analyzeMemoryWithFallback("hello world", undefined, {
      fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "missing-config");
      assert.equal(r.httpCalls, 0);
    }
    assert.equal(log.length, 0, "no http calls when keys are whitespace-only");
  });
});

// ---------------------------------------------------------------------------
// 1. Primary success, no fallback
// ---------------------------------------------------------------------------

test("adapter: primary success returns adapter result with no fallback", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.providerUsed, "minimax");
    assert.equal(r.modelUsed, "primary-model");
    assert.equal(r.llmRepairAttempts, 0);
    assert.equal(r.httpCalls, 1);
    assert.equal(r.value.summary, "A short summary of the input.");
    assert.equal(r.value.confidence, 0.82);
    assert.deepEqual(r.value.tags, ["project", "memory"]);
  }
  // Exactly one HTTP call, going to the primary URL.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
  // Request body must not include the API key.
  assert.ok(!log[0]!.body.includes(PRIMARY_KEY));
  assert.ok(!log[0]!.body.includes(FALLBACK_KEY));
});

// ---------------------------------------------------------------------------
// 2. Primary hard failure -> fallback success
// ---------------------------------------------------------------------------

test("adapter: primary hard failure (500) falls back to secondary provider", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "internal error"),
      () => okChatResponse(VALID_JSON),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.providerUsed, "nvidia-nim");
    assert.equal(r.modelUsed, "fallback-model");
    assert.equal(r.llmRepairAttempts, 0);
    assert.equal(r.httpCalls, 2);
  }
  // Call 1 -> primary URL (500). Call 2 -> fallback URL (200).
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
  assert.match(log[1]!.url, /^https:\/\/fallback\.test\/v1\/chat\/completions/);
});

// ---------------------------------------------------------------------------
// 3. Primary invalid JSON -> repair success on same provider (no fallback)
// ---------------------------------------------------------------------------

test("adapter: primary invalid JSON triggers one repair on the same provider, no fallback", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // First primary call: returns content that the parser will reject.
      () => okChatResponse("not-json-at-all-just-some-prose"),
      // Same-provider repair call: returns valid JSON.
      () => okChatResponse("```json\n" + VALID_JSON + "\n```"),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.providerUsed, "minimax");
    assert.equal(r.modelUsed, "primary-model");
    assert.equal(r.llmRepairAttempts, 1);
    assert.equal(r.httpCalls, 2);
    assert.equal(r.parseStrategy, "fenced");
  }
  // Both calls went to primary, not fallback.
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
  assert.match(log[1]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
});

// ---------------------------------------------------------------------------
// 4. Primary invalid JSON + failed repair -> fallback success
// ---------------------------------------------------------------------------

test("adapter: primary invalid JSON + failed repair falls back to secondary provider", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => okChatResponse("first bad response"),
      () => okChatResponse("repair also bad response"),
      () => okChatResponse(VALID_JSON),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "primary-model",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "fallback-model",
    fetchImpl,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.providerUsed, "nvidia-nim");
    assert.equal(r.modelUsed, "fallback-model");
    assert.equal(r.llmRepairAttempts, 0);
    assert.equal(r.httpCalls, 3);
  }
  assert.equal(log.length, 3);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
  assert.match(log[1]!.url, /^https:\/\/primary\.test\/v1\/chat\/completions/);
  assert.match(log[2]!.url, /^https:\/\/fallback\.test\/v1\/chat\/completions/);
});

// ---------------------------------------------------------------------------
// 5. Both providers fail -> typed all-providers-failed
// ---------------------------------------------------------------------------

test("adapter: both providers failing returns a typed all-providers-failed result", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary returns a hard 500. The adapter goes straight to
      // fallback without a same-provider repair attempt.
      () => httpErrorResponse(500, "primary down"),
      // Fallback also returns a hard 500. The adapter gives up.
      () => httpErrorResponse(502, "fallback down"),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "f",
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(typeof r.message, "string");
    assert.ok(r.message.length > 0);
    // No key values in the message.
    assert.ok(!r.message.includes(PRIMARY_KEY));
    assert.ok(!r.message.includes(FALLBACK_KEY));
    // Last error is the fallback's hard failure.
    assert.equal(r.lastError?.kind, "server");
    // 1 primary hard fail + 1 fallback hard fail = 2 calls.
    assert.equal(r.httpCalls, 2);
  }
  // First call -> primary URL. Second -> fallback URL.
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\//);
  assert.match(log[1]!.url, /^https:\/\/fallback\.test\/v1\//);
});

test("adapter: both providers with invalid structured output (4 calls) returns typed all-providers-failed", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary returns invalid JSON.
      () => okChatResponse("not-json"),
      // Primary repair also returns invalid JSON.
      () => okChatResponse("repair also not-json"),
      // Fallback returns invalid JSON.
      () => okChatResponse("fallback also not-json"),
      // Fallback repair also returns invalid JSON.
      () => okChatResponse("fallback repair also not-json"),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "f",
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(typeof r.lastParseErrors, "object");
    assert.ok((r.lastParseErrors?.length ?? 0) > 0);
    // 1 primary + 1 primary-repair + 1 fallback + 1 fallback-repair = 4.
    assert.equal(r.httpCalls, 4);
  }
  assert.equal(log.length, 4);
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\//);
  assert.match(log[1]!.url, /^https:\/\/primary\.test\/v1\//);
  assert.match(log[2]!.url, /^https:\/\/fallback\.test\/v1\//);
  assert.match(log[3]!.url, /^https:\/\/fallback\.test\/v1\//);
});

// ---------------------------------------------------------------------------
// 6. No API key/config -> typed missing-config
// ---------------------------------------------------------------------------

test("adapter: no API key configured returns typed missing-config (no http calls)", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [() => okChatResponse(VALID_JSON)],
      log,
    );
    const r = await analyzeMemoryWithFallback("hello world", undefined, {
      fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "missing-config");
      assert.equal(r.httpCalls, 0);
      assert.ok(!r.message.includes(PRIMARY_KEY));
    }
    assert.equal(log.length, 0, "no http calls when neither key is configured");
  });
});

test("adapter: only primary key configured, primary hard-fails -> all-providers-failed (no fallback available)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => httpErrorResponse(500, "down")],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.lastError?.kind, "server");
    assert.equal(r.httpCalls, 1);
  }
  // Only one HTTP call (primary). No fallback call attempted.
  assert.equal(log.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Provider metadata / fallback flag / no secret in result
// ---------------------------------------------------------------------------

test("adapter: success result exposes providerUsed / modelUsed / fallbackUsed and is sanitized", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () => okChatResponse(VALID_JSON),
    ],
    log,
  );
  const r: MemoryAnalysisResult = await analyzeMemoryWithFallback(
    "hello world",
    undefined,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      primaryBaseUrl: "https://primary.test/v1",
      primaryModel: "primary-model",
      fallbackBaseUrl: "https://fallback.test/v1",
      fallbackModel: "fallback-model",
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.providerUsed, "nvidia-nim");
    assert.equal(r.modelUsed, "fallback-model");
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.llmRepairAttempts, 0);
    assert.equal(r.httpCalls, 2);
  }
  // The serialized result must not contain any API key value.
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(PRIMARY_KEY), "primary key leaked");
  assert.ok(!serialized.includes(FALLBACK_KEY), "fallback key leaked");
});

test("adapter: result never echoes the input text", async () => {
  const secretInput = "the launch code is 1-2-3-4-5";
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
  const r = await analyzeMemoryWithFallback(secretInput, undefined, {
    primaryApiKey: PRIMARY_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fetchImpl,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(secretInput), "input text leaked into result");
    // The summary returned by the model is the only text in the value;
    // it must be the model's summary, not the input.
    assert.notEqual(r.value.summary, secretInput);
  }
});

// ---------------------------------------------------------------------------
// 8. Public MCP tool surface is unchanged
// ---------------------------------------------------------------------------

test("adapter: public MCP tool surface is still exactly remember + recall", () => {
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
// Additional coverage
// ---------------------------------------------------------------------------

test("adapter: invalid input returns typed invalid-input (no http call)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
  for (const bad of ["", "   "]) {
    const r = await analyzeMemoryWithFallback(bad, undefined, {
      primaryApiKey: PRIMARY_KEY,
      fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      // Whitespace-only input is treated as invalid because the
      // effective input length after trim is zero.
      assert.equal(r.kind, "invalid-input");
      assert.equal(r.httpCalls, 0);
    }
  }
  assert.equal(log.length, 0);
});

test("adapter: disableRepair forces fallback on parse failure (no repair attempt)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      // Primary returns invalid JSON; with disableRepair we must NOT
      // do a same-provider repair, only fall back.
      () => okChatResponse("not-json"),
      () => okChatResponse(VALID_JSON),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "f",
    fetchImpl,
    disableRepair: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.httpCalls, 2);
  }
  assert.equal(log.length, 2);
  // First call to primary, second to fallback. No same-provider repair call.
  assert.match(log[0]!.url, /^https:\/\/primary\.test\/v1\//);
  assert.match(log[1]!.url, /^https:\/\/fallback\.test\/v1\//);
});

test("adapter: repair prompt does not echo the original input text", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => okChatResponse("not-json"),
      () => okChatResponse("```json\n" + VALID_JSON + "\n```"),
    ],
    log,
  );
  const secretInput = "TOP-SECRET-INPUT-DO-NOT-LEAK";
  await analyzeMemoryWithFallback(secretInput, undefined, {
    primaryApiKey: PRIMARY_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fetchImpl,
  });
  assert.equal(log.length, 2);
  // The repair request body must not include the original input.
  assert.ok(
    !log[1]!.body.includes(secretInput),
    "repair prompt must not contain the original input text",
  );
});

test("adapter: relatedMemories are included in the initial prompt only (not the repair prompt)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => okChatResponse("not-json"),
      () => okChatResponse("```json\n" + VALID_JSON + "\n```"),
    ],
    log,
  );
  const related = [
    // Phase 1 internal naming cleanup: this fixture is
    // passed to `analyzeMemoryWithFallback` as a
    // `RelatedMemory[]` (internal seam type), so the
    // property key is `memoryContent` (TS-side). The
    // provider JSON contract and the public surface
    // still use `summary`; the seam is the boundary.
    { id: 42, memoryContent: "prior context summary", kind: "memory" },
  ];
  await analyzeMemoryWithFallback("hello", related, {
    primaryApiKey: PRIMARY_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fetchImpl,
  });
  assert.equal(log.length, 2);
  // Initial request includes the related memory block.
  assert.match(log[0]!.body, /prior context summary/);
  // Repair request does NOT include the related memory text.
  assert.ok(
    !log[1]!.body.includes("prior context summary"),
    "repair prompt must not echo related memory summaries",
  );
});

test("adapter: no key values appear in serialized failure results", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () => httpErrorResponse(500, "primary down on repair"),
      () => httpErrorResponse(502, "fallback down"),
      () => httpErrorResponse(502, "fallback down on repair"),
    ],
    log,
  );
  const r = await analyzeMemoryWithFallback("hello world", undefined, {
    primaryApiKey: PRIMARY_KEY,
    fallbackApiKey: FALLBACK_KEY,
    primaryBaseUrl: "https://primary.test/v1",
    primaryModel: "p",
    fallbackBaseUrl: "https://fallback.test/v1",
    fallbackModel: "f",
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(PRIMARY_KEY));
    assert.ok(!serialized.includes(FALLBACK_KEY));
  }
});

test("adapter: uses documented default model names when env is unset", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch([() => okChatResponse(VALID_JSON)], log);
    const r = await analyzeMemoryWithFallback("hello", undefined, {
      primaryApiKey: PRIMARY_KEY,
      // No baseUrl/model overrides -> adapter uses defaults.
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.providerUsed, "minimax");
      assert.equal(r.modelUsed, "MiniMax-M3");
    }
    // Default MiniMax base URL must be present in the request URL.
    assert.match(
      log[0]!.url,
      /^https:\/\/api\.minimax\.io\/v1\/chat\/completions/,
    );
    // The model field in the body must be the documented default.
    const body = JSON.parse(log[0]!.body);
    assert.equal(body.model, "MiniMax-M3");
    assert.equal(body.response_format?.type, "json_object");
    assert.equal(body.temperature, 0);
  });
});

test("adapter: default fallback model is openai/gpt-oss-120b, not the comparison model", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [
        () => httpErrorResponse(500, "primary down"),
        () => okChatResponse(VALID_JSON),
      ],
      log,
    );
    const r = await analyzeMemoryWithFallback("hello", undefined, {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      // No model overrides -> adapter uses default fallback.
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.fallbackUsed, true);
      assert.equal(r.modelUsed, "openai/gpt-oss-120b");
    }
    const body = JSON.parse(log[1]!.body);
    assert.equal(body.model, "openai/gpt-oss-120b");
  });
});

test("adapter: env override CURION_NIM_FALLBACK_MODEL switches fallback model", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    process.env.CURION_NIM_FALLBACK_MODEL = COMPARISON_NIM_MODEL;
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [
        () => httpErrorResponse(500, "primary down"),
        () => okChatResponse(VALID_JSON),
      ],
      log,
    );
    const r = await analyzeMemoryWithFallback("hello", undefined, {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.modelUsed, COMPARISON_NIM_MODEL);
    }
    const body = JSON.parse(log[1]!.body);
    assert.equal(body.model, COMPARISON_NIM_MODEL);
  });
});
