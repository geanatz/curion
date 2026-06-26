/**
 * Tests for the recall-synthesis provider adapter.
 *
 * These tests stub `fetch`. No network access is required.
 *
 * Focus: provider-id / model-id / base-URL consistency between
 * the configured slots and the labels surfaced to operators
 * (`providerUsed`, `providerLabel`, error messages, and the
 * no-key message for the primary slot).
 *
 * This adapter has NO hardcoded vendor defaults. The primary and
 * fallback slots are empty by default; the operator must
 * explicitly configure at least one via CURION_PRIMARY_* env
 * vars. The fallback slot is opt-in via CURION_FALLBACK_* vars.
 *
 * Coverage:
 *   - no-config: all slots empty -> typed missing-config, no http call
 *   - primary success with explicit config -> correct provider label
 *   - primary hard failure -> fallback success (when fallback configured)
 *   - both fail -> error message references correct labels
 *   - primary no-key -> missing-config message
 *   - URL overrides resolve to the correct provider label
 *   - no fabricated provider labels in any surface
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  synthesizeRecallWithFallback,
  loadRecallAdapterConfig,
  RECALL_DEFAULT_TIMEOUT_MS,
  RECALL_DEFAULT_MAX_TOKENS,
  type RecallMemoryInput,
} from "../src/providers/recall-synthesis.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function okChatResponse(content: string, model = "m"): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model,
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function httpErrorResponse(status: number, text = "boom"): Response {
  return new Response(text, { status });
}

// Test with explicit generic provider config (no vendor defaults).
// These are neutral values; the provider label is derived from the base URL.
const PRIMARY_KEY = "sk-test-primary-not-real-12345";
const FALLBACK_KEY = "sk-test-fallback-not-real-12345";
const PRIMARY_BASE_URL = "https://api.example.com/v1";
const PRIMARY_MODEL = "test/provider-model-primary";
const FALLBACK_BASE_URL = "https://api.fallback.example/v1";
const FALLBACK_MODEL = "test/provider-model-fallback";

const ENV_KEYS = [
  // Generic role-based keys (the new canonical names).
  "CURION_PRIMARY_API_KEY",
  "CURION_FALLBACK_API_KEY",
  "CURION_PRIMARY_BASE_URL",
  "CURION_PRIMARY_MODEL",
  "CURION_FALLBACK_BASE_URL",
  "CURION_FALLBACK_MODEL",
  "CURION_PRIMARY_PROVIDER_LABEL",
  "CURION_FALLBACK_PROVIDER_LABEL",
  "CURION_ADAPTER_TIMEOUT_MS",
  "CURION_ADAPTER_MAX_TOKENS",
  // Legacy aliases - kept for backward-compat tests only.
  "CURION_PROVIDER_PRIMARY_KEY",
  "MINIMAX_API_KEY",
  "CURION_PROVIDER_FALLBACK_KEY",
  "NVIDIA_NIM_API_KEY",
  "CURION_NIM_BASE_URL",
  "CURION_NIM_FALLBACK_MODEL",
  "CURION_MINIMAX_BASE_URL",
  "CURION_MINIMAX_MODEL",
];

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

// Phase 1 internal naming cleanup: `RecallMemoryInput` is an
// internal TS type whose field is now `memoryContent`. The
// provider JSON contract and the public surface still use
// `summary`; the internal type is what feeds the synthesis
// adapter.
const SAMPLE_MEMORIES: RecallMemoryInput[] = [
  { id: 1, memoryContent: "The project uses Postgres 16 for the primary store." },
  { id: 2, memoryContent: "Auth tokens rotate weekly via the rotation job." },
];

// ---------------------------------------------------------------------------
// Defaults / config
// ---------------------------------------------------------------------------

test("recall: loadRecallAdapterConfig with no env vars: all slots empty, generic defaults for knobs", () => {
  return withCleanEnv(ENV_KEYS, () => {
    const cfg = loadRecallAdapterConfig();
    // No vendor defaults: all provider slots are empty.
    assert.equal(cfg.primaryBaseUrl, "", "primary base URL must be empty when not configured");
    assert.equal(cfg.primaryModel, "", "primary model must be empty when not configured");
    assert.equal(cfg.fallbackBaseUrl, "", "fallback base URL must be empty by default");
    assert.equal(cfg.fallbackModel, "", "fallback model must be empty by default");
    assert.equal(cfg.primaryApiKey, "", "primary key must be empty when not configured");
    assert.equal(cfg.fallbackApiKey, "", "fallback key must be empty by default");
    // Generic adapter knobs still have defaults.
    assert.equal(cfg.timeoutMs, RECALL_DEFAULT_TIMEOUT_MS);
    assert.equal(cfg.timeoutMs, 30_000);
    assert.equal(cfg.maxTokens, RECALL_DEFAULT_MAX_TOKENS);
    assert.equal(cfg.maxTokens, 512);
  });
});

test("recall: loadRecallAdapterConfig treats whitespace-only overrides as missing", () => {
  return withCleanEnv(ENV_KEYS, () => {
    // Whitespace-only values for the new generic env vars.
    process.env.CURION_PRIMARY_API_KEY = "   ";
    process.env.CURION_FALLBACK_API_KEY = "  \t  ";
    process.env.CURION_PRIMARY_BASE_URL = " \t ";
    process.env.CURION_PRIMARY_MODEL = "  ";
    process.env.CURION_FALLBACK_BASE_URL = "  ";
    process.env.CURION_FALLBACK_MODEL = " \t ";
    const cfg = loadRecallAdapterConfig();
    // All slots remain empty when values are whitespace-only.
    assert.equal(cfg.primaryBaseUrl, "", "whitespace-only primary base URL is treated as missing");
    assert.equal(cfg.primaryModel, "", "whitespace-only primary model is treated as missing");
    assert.equal(cfg.fallbackBaseUrl, "", "whitespace-only fallback base URL is treated as missing");
    assert.equal(cfg.fallbackModel, "", "whitespace-only fallback model is treated as missing");
    assert.equal(cfg.primaryApiKey, "", "whitespace-only primary key is treated as missing");
    assert.equal(cfg.fallbackApiKey, "", "whitespace-only fallback key is treated as missing");
  });
});

test("recall: primary hard-fail with no fallback configured -> all-providers-failed, no fallback call", async () => {
  // With explicit primary config but no fallback config, the
  // adapter must NOT call any fallback. The missing-config
  // branch fires (no fallback URL + no fallback model + no
  // fallback key) and the result is `all-providers-failed`.
  // No second HTTP call.
  return withCleanEnv(ENV_KEYS, async () => {
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [
        () => httpErrorResponse(500, "down"),
        () => okChatResponse("ignored", "m"),
      ],
      log,
    );
    const r = await synthesizeRecallWithFallback(
      "q",
      SAMPLE_MEMORIES,
      {
        primaryApiKey: PRIMARY_KEY,
        primaryBaseUrl: PRIMARY_BASE_URL,
        primaryModel: PRIMARY_MODEL,
        fetchImpl,
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "all-providers-failed");
      assert.equal(r.httpCalls, 1, "no fallback call when fallback slot is empty");
      assert.match(
        r.message,
        /^primary failed and no fallback configured: /,
      );
    }
    assert.equal(log.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Config resolution: CURION_PRIMARY_* and CURION_FALLBACK_* are the
// only env vars read for role-based provider config. The legacy
// vendor-specific names (NVIDIA_NIM_API_KEY, MINIMAX_API_KEY,
// CURION_PROVIDER_PRIMARY_KEY, CURION_PROVIDER_FALLBACK_KEY) are
// NOT read by the adapter. The operator must use the generic
// CURION_PRIMARY_API_KEY / CURION_FALLBACK_API_KEY names.
// ---------------------------------------------------------------------------

test("recall: loadRecallAdapterConfig reads only CURION_PRIMARY_* and CURION_FALLBACK_* env vars", () => {
  return withCleanEnv(ENV_KEYS, () => {
    // CURION_PRIMARY_API_KEY sets primaryApiKey.
    process.env.CURION_PRIMARY_API_KEY = "sk-test-primary-from-curion-var";
    let cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "sk-test-primary-from-curion-var");
    assert.equal(cfg.fallbackApiKey, "", "fallback key must be empty");

    // CURION_FALLBACK_API_KEY sets fallbackApiKey.
    process.env.CURION_FALLBACK_API_KEY = "sk-test-fallback-from-curion-var";
    cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "sk-test-primary-from-curion-var");
    assert.equal(cfg.fallbackApiKey, "sk-test-fallback-from-curion-var");

    // Legacy vendor-specific names are NOT read by the adapter.
    process.env.NVIDIA_NIM_API_KEY = "nvapi-legacy-should-be-ignored";
    process.env.MINIMAX_API_KEY = "sk-legacy-minimax-should-be-ignored";
    process.env.CURION_PROVIDER_PRIMARY_KEY = "role-primary-legacy-should-be-ignored";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "role-fallback-legacy-should-be-ignored";
    cfg = loadRecallAdapterConfig();
    // The legacy names must NOT override the CURION_PRIMARY_*/CURION_FALLBACK_* values.
    assert.equal(cfg.primaryApiKey, "sk-test-primary-from-curion-var");
    assert.equal(cfg.fallbackApiKey, "sk-test-fallback-from-curion-var");

    // With no CURION_* vars set, legacy vars are still NOT read.
    delete process.env.CURION_PRIMARY_API_KEY;
    delete process.env.CURION_FALLBACK_API_KEY;
    cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "", "legacy NVIDIA_NIM_API_KEY must not set primaryApiKey");
    assert.equal(cfg.fallbackApiKey, "", "legacy MINIMAX_API_KEY must not set fallbackApiKey");
  });
});

// ---------------------------------------------------------------------------
// Primary success: label is derived from base URL, provider must match
// ---------------------------------------------------------------------------

test("recall: primary success with explicit config returns correct provider label from base URL", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => okChatResponse("The project uses Postgres 16 for the primary store.", PRIMARY_MODEL),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, false);
    // Provider label is "custom" because PRIMARY_BASE_URL ("https://api.example.com")
    // doesn't match any known host (openai, groq, nvidia, minimax, etc.).
    assert.equal(r.providerUsed, "custom");
    assert.equal(r.modelUsed, PRIMARY_MODEL);
    assert.equal(r.httpCalls, 1);
  }
  // Exactly one HTTP call, going to the configured primary base URL.
  assert.equal(log.length, 1);
  assert.match(
    log[0]!.url,
    new RegExp(`^${PRIMARY_BASE_URL}/chat/completions`),
    "primary call must go to the configured primary endpoint",
  );
  const body = JSON.parse(log[0]!.body);
  assert.equal(body.model, PRIMARY_MODEL);
  // Keys must not leak into the request body.
  assert.ok(!log[0]!.body.includes(PRIMARY_KEY));
  assert.ok(!log[0]!.body.includes(FALLBACK_KEY));
});

// ---------------------------------------------------------------------------
// REGRESSION: the bug was a hardcoded `provider: "minimax"` at the
// primary call site even though the primary URL was NIM. The fix
// derives the provider label from the actual base URL. This test
// forces a 401 from the primary and asserts the error label is
// derived from the configured base URL (not a hardcoded vendor).
// ---------------------------------------------------------------------------

test("recall: regression - primary 401 error label is derived from base URL, not hardcoded", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => httpErrorResponse(401, "Unauthorized")],
    log,
  );
  // No fallback key: the adapter should report the primary
  // failure directly (no fallback attempt).
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 1);
    assert.ok(r.lastError, "lastError should be present");
    // Provider label must be derived from PRIMARY_BASE_URL, which
    // is "https://api.example.com" -> "custom".
    assert.match(
      r.lastError!.message,
      /custom\/test\/provider-model-primary#recall: auth failed \(HTTP 401\)/,
      "primary error message must use the actual primary endpoint label derived from base URL",
    );
    // The top-level message also must not echo a wrong vendor label.
    assert.ok(
      !r.message.includes("minimax/"),
      "top-level message must NOT carry a minimax label",
    );
  }
  // The request must have gone to the configured primary base URL.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
});

// ---------------------------------------------------------------------------
// Primary hard failure -> fallback success: when the operator has
// explicitly configured a fallback, the label must be derived from
// the fallback base URL and the request must go there.
// ---------------------------------------------------------------------------

test("recall: primary hard failure falls back to configured fallback provider", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () =>
        okChatResponse(
          "The project uses Postgres 16 for the primary store.",
          FALLBACK_MODEL,
        ),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    // Provider label is "custom" because FALLBACK_BASE_URL doesn't match known hosts.
    assert.equal(r.providerUsed, "custom");
    assert.equal(r.modelUsed, FALLBACK_MODEL);
    assert.equal(r.httpCalls, 2);
    // The answer must come from the fallback response.
    assert.match(r.answer, /Postgres/);
  }
  // Call 1 -> primary (500). Call 2 -> fallback (200).
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
  assert.match(log[1]!.url, new RegExp(`^${FALLBACK_BASE_URL}/`));
  const fallbackBody = JSON.parse(log[1]!.body);
  assert.equal(fallbackBody.model, FALLBACK_MODEL);
});

// ---------------------------------------------------------------------------
// Both providers fail: error message references the right labels for each slot
// ---------------------------------------------------------------------------

test("recall: both providers fail -> error message uses the actual endpoint labels", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(401, "Unauthorized"),
      () => httpErrorResponse(403, "Forbidden"),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 2);
    // Both base URLs contain "example" so both resolve to "custom" provider.
    const primaryLabel = `custom/${PRIMARY_MODEL}#recall`;
    const fallbackLabel = `custom/${FALLBACK_MODEL}#recall`;
    // The message should reference each slot's actual label.
    assert.ok(
      r.message.includes(primaryLabel) || r.message.includes(`primary=${primaryLabel.split("/")[0]}`),
      `message should reference primary provider label`,
    );
    assert.ok(
      r.message.includes(fallbackLabel) || r.message.includes(`fallback=${fallbackLabel.split("/")[0]}`),
      `message should reference fallback provider label`,
    );
    // The last error is the fallback's auth failure (403).
    assert.equal(r.lastError?.kind, "auth");
    assert.equal(r.lastError?.status, 403);
  }
  // First call -> primary. Second -> fallback.
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
  assert.match(log[1]!.url, new RegExp(`^${FALLBACK_BASE_URL}/`));
});

// ---------------------------------------------------------------------------
// No primary key (but fallback key configured): the missing-config
// message references the primary slot's label. Since no primary base URL
// is configured, the label is derived from the empty base URL -> "custom".
// ---------------------------------------------------------------------------

test("recall: primary no-key message reflects the primary slot label (empty base URL -> custom)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => okChatResponse("ignored")],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      // Only the fallback key is set; the primary slot has no key.
      // disableFallback=true keeps the primary's missing-config on
      // the surface so we can inspect the label directly.
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      disableFallback: true,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 0, "no http call when primary has no key");
    assert.ok(r.lastError);
    assert.equal(r.lastError!.kind, "missing-config");
    // With empty primaryBaseUrl, the derived label is "custom".
    assert.match(
      r.lastError!.message,
      /^custom: no api key configured$/,
      "primary missing-config message must use the derived label (custom for empty base URL)",
    );
    // No HTTP call should have been attempted on the primary slot.
    assert.equal(log.length, 0);
  }
});

// ---------------------------------------------------------------------------
// No keys at all: typed missing-config, no http call.
// ---------------------------------------------------------------------------

test("recall: no api keys configured -> typed missing-config (no http calls)", async () => {
  return withCleanEnv(ENV_KEYS, async () => {
    const log: Array<{ url: string; body: string }> = [];
    const fetchImpl = scriptedFetch(
      [() => okChatResponse("ignored")],
      log,
    );
    const r = await synthesizeRecallWithFallback(
      "What database does the project use?",
      SAMPLE_MEMORIES,
      { fetchImpl },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, "missing-config");
      assert.equal(r.httpCalls, 0);
      // Message must not leak any key (there are none anyway, but
      // also must not claim an endpoint-specific label since the
      // adapter short-circuits before consulting the URL).
      assert.match(r.message, /no provider api key configured/);
      assert.ok(!r.message.includes(PRIMARY_KEY));
      assert.ok(!r.message.includes(FALLBACK_KEY));
    }
    assert.equal(log.length, 0, "no http calls when neither key is configured");
  });
});

// ---------------------------------------------------------------------------
// URL overrides: a custom NIM-compatible URL containing "nvidia"
// must still resolve to "nvidia-nim"; a custom MiniMax URL must
// still resolve to "minimax".
// ---------------------------------------------------------------------------

test("recall: custom primary URL containing 'nvidia' still resolves to nvidia-nim label", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => okChatResponse("ok", "m")],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: "https://my.nvidia.proxy.example/v1",
      primaryModel: "openai/gpt-oss-120b",
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.providerUsed, "nvidia-nim");
    assert.equal(r.modelUsed, "openai/gpt-oss-120b");
  }
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/my\.nvidia\.proxy\.example\//);
});

test("recall: custom fallback URL containing 'minimax' still resolves to minimax label", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () => okChatResponse("ok", "MiniMax-M3"),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: "https://integrate.api.nvidia.com/v1",
      primaryModel: "openai/gpt-oss-120b",
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: "https://my.minimax.proxy.example/v1",
      fallbackModel: "MiniMax-M3",
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.providerUsed, "minimax");
    assert.equal(r.modelUsed, "MiniMax-M3");
  }
  assert.equal(log.length, 2);
  assert.match(log[1]!.url, /^https:\/\/my\.minimax\.proxy\.example\//);
});

// ---------------------------------------------------------------------------
// Sanitization: the serialized result must never include a key value.
// ---------------------------------------------------------------------------

test("recall: serialized result never contains api key values", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () => okChatResponse("ok", FALLBACK_MODEL),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
    },
  );
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes(PRIMARY_KEY), "primary key leaked into result");
  assert.ok(!serialized.includes(FALLBACK_KEY), "fallback key leaked into result");
});

// ---------------------------------------------------------------------------
// invalid input -> typed invalid-input, no http call.
// ---------------------------------------------------------------------------

test("recall: empty query returns typed invalid-input (no http call)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => okChatResponse("ignored")],
    log,
  );
  const r = await synthesizeRecallWithFallback("", SAMPLE_MEMORIES, {
    primaryApiKey: PRIMARY_KEY,
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "invalid-input");
    assert.equal(r.httpCalls, 0);
  }
  assert.equal(log.length, 0);
});

test("recall: empty memories list returns typed invalid-input (no http call)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => okChatResponse("ignored")],
    log,
  );
  const r = await synthesizeRecallWithFallback("what?", [], {
    primaryApiKey: PRIMARY_KEY,
    fetchImpl,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "invalid-input");
    assert.equal(r.httpCalls, 0);
  }
  assert.equal(log.length, 0);
});

// ---------------------------------------------------------------------------
// disableFallback: primary failure surfaces directly, no fallback call.
// ---------------------------------------------------------------------------

test("recall: disableFallback short-circuits the fallback on primary failure", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => httpErrorResponse(401, "Unauthorized")],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
      disableFallback: true,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 1);
    assert.match(
      r.lastError!.message,
      new RegExp(`custom\\/${PRIMARY_MODEL}#recall: auth failed \\(HTTP 401\\)`),
    );
  }
  assert.equal(log.length, 1, "no fallback call when disableFallback is true");
});

// ---------------------------------------------------------------------------
// REGRESSION GATE: explicit negative assertion that the
// combination that produced the original 401 message can no
// longer be assembled. If anyone reverts the labels to the
// hardcoded strings, this test fails first.
// ---------------------------------------------------------------------------

test("recall: regression gate - no hardcoded minimax/openai/gpt-oss-120b#recall label can be assembled", async () => {
  // Force primary to fail with auth error and inspect every error
  // surface for the old hardcoded label. With explicit config,
  // the label is derived from the base URL (custom/<model>#recall).
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => httpErrorResponse(401, "Unauthorized")],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    const surfaces = [
      r.message,
      r.lastError?.message ?? "",
    ];
    for (const s of surfaces) {
      assert.ok(
        !s.includes("minimax/openai/gpt-oss-120b#recall"),
        `surface still contains the old hardcoded label: ${JSON.stringify(s)}`,
      );
      assert.ok(
        !s.includes("minimax: hard failure"),
        `surface still contains the stale minimax hard-failure prefix: ${JSON.stringify(s)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// REGRESSION: primary returns HTTP 200 with no usable content
// (the live failure mode that surfaced as
// `nvidia-nim/openai/gpt-oss-120b#recall response missing
// choices[0].message.content`).
//
// The recall adapter must treat a 200 with malformed / missing
// `choices[0].message.content` as a hard failure on the primary
// slot and either (a) recover via the fallback or (b) surface
// `all-providers-failed` with the operator-visible
// `primary failed and no fallback configured: ...` shape so the
// operator can tell which slot produced which error.
//
// The cases here cover the two outcomes an operator will
// realistically hit:
//   1. primary 200 + malformed body, fallback key configured
//      -> fallback recovers; answer / providerUsed / modelUsed
//         must reflect the fallback endpoint
//   2. primary 200 + malformed body, no fallback key configured
//      -> all-providers-failed; the top-level message and
//         `lastError.message` must follow the documented
//         operator-visible shape (no fabricated answer, the
//         primary's bad-request error is surfaced)
// ---------------------------------------------------------------------------

/** A 200 OK response whose body is missing choices[0].message.content. */
function malformedContentResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "openai/gpt-oss-120b",
      // Missing `choices` entirely -> extractContent returns
      // undefined -> http-client returns ok=false, kind=bad-request
      // with message "response missing choices[0].message.content".
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("recall: primary 200 with malformed content (no fallback configured) -> all-providers-failed", async () => {
  // Case (2): no fallback. The primary is the only configured
  // slot, and it returns 200 with no usable content. The adapter
  // must surface the primary's bad-request error to the operator
  // in the documented shape, with `kind: "all-providers-failed"`
  // and the `primary failed and no fallback configured:` prefix
  // on the top-level message.
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [() => malformedContentResponse()],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false, "primary 200 with no usable content must not report ok");
  if (r.ok) return;
  assert.equal(r.kind, "all-providers-failed");
  assert.equal(
    r.httpCalls,
    1,
    "no fallback call when no fallback is configured",
  );
  assert.ok(r.lastError, "lastError should be present");
  // The bad-request error must name the missing field and use
  // the actual primary endpoint's label derived from base URL.
  assert.equal(r.lastError!.kind, "bad-request");
  assert.equal(r.lastError!.status, 200);
  assert.equal(r.lastError!.reachedServer, true);
  assert.match(
    r.lastError!.message,
    new RegExp(`custom\\/${PRIMARY_MODEL}#recall: response missing choices\\[0\\]\\.message\\.content`),
    "lastError must name the missing field and use the actual primary endpoint label",
  );
  // The top-level message must follow the documented shape.
  assert.match(
    r.message,
    new RegExp(`^primary failed and no fallback configured: custom\\/${PRIMARY_MODEL}#recall: response missing choices\\[0\\]\\.message\\.content$`),
    "top-level message must follow the operator-visible shape",
  );
  // No fabricated answer.
  assert.ok(!r.message.includes("Postgres"));
  // Only the primary slot was called.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
});

test("recall: primary 200 with malformed content + fallback configured -> fallback recovers", async () => {
  // Case (1): the primary returns 200 with no usable content;
  // the fallback is configured and returns a valid synthesis.
  // The adapter must NOT report failure, must NOT fabricate an
  // answer from the primary's empty body, and must report the
  // fallback as the source of the answer.
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => malformedContentResponse(),
      () =>
        okChatResponse(
          "The project uses Postgres 16 for the primary store.",
          FALLBACK_MODEL,
        ),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fallbackApiKey: FALLBACK_KEY,
      fallbackBaseUrl: FALLBACK_BASE_URL,
      fallbackModel: FALLBACK_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fallbackUsed, true, "answer must come from the fallback");
  assert.equal(r.providerUsed, "custom");
  assert.equal(r.modelUsed, FALLBACK_MODEL);
  assert.equal(r.httpCalls, 2);
  // The synthesized answer is the fallback's, not a fabricated
  // echo of the primary's empty body.
  assert.match(r.answer, /Postgres 16/);
  // Call 1 -> primary (200 malformed). Call 2 -> fallback (200 ok).
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
  assert.match(log[1]!.url, new RegExp(`^${FALLBACK_BASE_URL}/`));
  const fallbackBody = JSON.parse(log[1]!.body);
  assert.equal(fallbackBody.model, FALLBACK_MODEL);
});

test("recall: primary 200 with empty string content (no fallback) -> all-providers-failed", async () => {
  // The empty-content branch lives in the recall adapter, not
  // the http-client. The http-client returns ok=true with
  // content=""; the adapter then classifies it as
  // "empty response content" and falls back. With no fallback
  // configured, the operator must see a typed all-providers-
  // failed outcome whose message names the primary endpoint
  // and the empty-content reason, with no `lastError`
  // (because the http-client reported ok=true).
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = (() => {
    return async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const body = init && typeof init === "object" && "body" in init ? String(init.body) : "";
      log.push({ url, body });
      // Return a 200 with empty content.
      return new Response(
        JSON.stringify({
          id: "x",
          model: PRIMARY_MODEL,
          choices: [
            { message: { role: "assistant", content: "" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
  })();
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      primaryBaseUrl: PRIMARY_BASE_URL,
      primaryModel: PRIMARY_MODEL,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.kind, "all-providers-failed");
  assert.equal(r.httpCalls, 1);
  // The adapter's own failure message is surfaced (it does not
  // carry a lastError because the http-client reported ok=true).
  assert.equal(
    r.message,
    `custom: empty response content`,
    "top-level message must name the primary endpoint and the empty-content reason",
  );
  assert.equal(r.lastError, undefined);
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, new RegExp(`^${PRIMARY_BASE_URL}/`));
});