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
 * The trigger for this test file was the regression:
 *
 *   `minimax/openai/gpt-oss-120b#recall: auth failed (HTTP 401)`
 *
 * The recall synthesis adapter had drifted: the `provider`
 * string passed to the http-client and returned in
 * `providerUsed` was hardcoded as `"minimax"` for the primary
 * slot and `"nvidia-nim"` for the fallback slot, while the
 * configured primary base URL is NVIDIA NIM and the configured
 * fallback base URL is MiniMax. The hardcoded labels did not
 * match the endpoints the request was actually sent to.
 *
 * Coverage:
 *   - defaults: documented constants match the URL/model pairs
 *   - primary success -> nvidia-nim + openai/gpt-oss-120b
 *   - primary hard failure -> fallback success, label is
 *     `minimax` + `MiniMax-M3` (the actual fallback endpoint)
 *   - both fail -> the error message references the right
 *     labels for each slot (no `minimax/openai/gpt-oss-120b#recall`)
 *   - primary no-key -> the missing-config message uses the
 *     primary endpoint's label (`nvidia-nim`), not `minimax`
 *   - no keys at all -> typed `missing-config`, no http call
 *   - URL overrides still resolve to the right label
 *   - regression assertion: providerLabel that produced the
 *     original 401 message can no longer be assembled
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  synthesizeRecallWithFallback,
  loadRecallAdapterConfig,
  RECALL_DEFAULT_PRIMARY_BASE_URL,
  RECALL_DEFAULT_PRIMARY_MODEL,
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

const PRIMARY_KEY = "nvapi-primary-test-not-real-12345";
const FALLBACK_KEY = "sk-fallback-test-not-real-12345";

const ENV_KEYS = [
  "CURION_PROVIDER_PRIMARY_KEY",
  "MINIMAX_API_KEY",
  "CURION_PROVIDER_FALLBACK_KEY",
  "NVIDIA_NIM_API_KEY",
  "CURION_NIM_BASE_URL",
  "CURION_NIM_FALLBACK_MODEL",
  "CURION_MINIMAX_BASE_URL",
  "CURION_MINIMAX_MODEL",
  "CURION_ADAPTER_TIMEOUT_MS",
  "CURION_ADAPTER_MAX_TOKENS",
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

test("recall: loadRecallAdapterConfig returns the documented defaults (NVIDIA-only primary, no default fallback)", () => {
  return withCleanEnv(ENV_KEYS, () => {
    const cfg = loadRecallAdapterConfig();
    // Primary: NVIDIA NIM with gpt-oss-120b.
    assert.equal(cfg.primaryBaseUrl, RECALL_DEFAULT_PRIMARY_BASE_URL);
    assert.equal(cfg.primaryBaseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(cfg.primaryModel, RECALL_DEFAULT_PRIMARY_MODEL);
    assert.equal(cfg.primaryModel, "openai/gpt-oss-120b");
    // Fallback: UNCONFIGURED. No provider is hardcoded into the
    // fallback slot by default. The architecture keeps the slot
    // for opt-in but does not default to MiniMax.
    assert.equal(cfg.fallbackBaseUrl, "");
    assert.equal(cfg.fallbackModel, "");
    assert.equal(cfg.timeoutMs, RECALL_DEFAULT_TIMEOUT_MS);
    assert.equal(cfg.timeoutMs, 30_000);
    assert.equal(cfg.maxTokens, RECALL_DEFAULT_MAX_TOKENS);
    assert.equal(cfg.maxTokens, 512);
    // The primary slot IS the NIM slot under the NVIDIA-only
    // stance. The fallback slot is empty (no host).
    assert.match(cfg.primaryBaseUrl, /nvidia/);
  });
});

test("recall: loadRecallAdapterConfig treats whitespace-only overrides as missing", () => {
  return withCleanEnv(ENV_KEYS, () => {
    process.env.CURION_PROVIDER_PRIMARY_KEY = "   ";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "  \t  ";
    process.env.CURION_NIM_BASE_URL = " \t ";
    process.env.CURION_MINIMAX_BASE_URL = "  ";
    const cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryBaseUrl, RECALL_DEFAULT_PRIMARY_BASE_URL);
    assert.equal(cfg.primaryModel, RECALL_DEFAULT_PRIMARY_MODEL);
    // Fallback stays empty even with whitespace-only env vars.
    assert.equal(cfg.fallbackBaseUrl, "");
    assert.equal(cfg.fallbackModel, "");
    assert.equal(cfg.primaryApiKey, "");
    assert.equal(cfg.fallbackApiKey, "");
  });
});

test("recall: NVIDIA-only default (no fallback configured) on primary hard-fail -> all-providers-failed, no fallback call", async () => {
  // Pin the NVIDIA-only stance: with a clean env and only a
  // primary key, the adapter must NOT call any fallback. The
  // missing-config branch fires (no fallback URL + no fallback
  // model + no fallback key) and the result is
  // `all-providers-failed`. No second HTTP call.
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
      { primaryApiKey: PRIMARY_KEY, fetchImpl },
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
// REGRESSION: canonical env-var aliases must follow the same
// primary=NIM / fallback=MiniMax assignment as the URL/model
// overrides and the defaults above. Previously, the alias
// mapping was inverted (primary fell back to MINIMAX_API_KEY and
// fallback fell back to NVIDIA_NIM_API_KEY), so an operator
// running with only the canonical keys in env would send the
// NIM endpoint a MiniMax key (HTTP 401) and vice versa.
// ---------------------------------------------------------------------------

test("recall: loadRecallAdapterConfig maps canonical env-var aliases to the correct slots", () => {
  return withCleanEnv(ENV_KEYS, () => {
    // Case 1: NVIDIA_NIM_API_KEY alone -> primaryApiKey.
    // The primary slot is NIM, so the NIM key must land there,
    // NOT in fallbackApiKey (the MiniMax slot).
    process.env.NVIDIA_NIM_API_KEY = "nvapi-test-primary";
    let cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "nvapi-test-primary");
    assert.equal(cfg.fallbackApiKey, "");

    // Case 2: MINIMAX_API_KEY alone -> fallbackApiKey.
    // The fallback slot is MiniMax, so the MiniMax key must
    // land there, NOT in primaryApiKey (the NIM slot).
    // primaryApiKey must remain the NIM key from Case 1.
    process.env.MINIMAX_API_KEY = "sk-cp-test-fallback";
    cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "nvapi-test-primary");
    assert.equal(cfg.fallbackApiKey, "sk-cp-test-fallback");

    // Case 3: CURION_PROVIDER_PRIMARY_KEY overrides NVIDIA_NIM_API_KEY.
    // The role-named alias takes priority over the canonical
    // alias (it is the second-priority candidate, before the
    // canonical env-var).
    process.env.CURION_PROVIDER_PRIMARY_KEY = "role-primary";
    cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "role-primary");
    assert.equal(cfg.fallbackApiKey, "sk-cp-test-fallback");

    // Case 4: CURION_PROVIDER_FALLBACK_KEY overrides MINIMAX_API_KEY.
    process.env.CURION_PROVIDER_FALLBACK_KEY = "role-fallback";
    cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryApiKey, "role-primary");
    assert.equal(cfg.fallbackApiKey, "role-fallback");
  });
});

// ---------------------------------------------------------------------------
// Primary success: label must be nvidia-nim, model must be openai/gpt-oss-120b
// ---------------------------------------------------------------------------

test("recall: primary success returns nvidia-nim + openai/gpt-oss-120b (the actual primary endpoint)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => okChatResponse("The project uses Postgres 16 for the primary store.", "openai/gpt-oss-120b"),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.providerUsed, "nvidia-nim");
    assert.equal(r.modelUsed, "openai/gpt-oss-120b");
    assert.equal(r.httpCalls, 1);
  }
  // Exactly one HTTP call, going to the NIM base URL.
  assert.equal(log.length, 1);
  assert.match(
    log[0]!.url,
    /^https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions/,
    "primary call must go to the NVIDIA NIM endpoint",
  );
  // The model in the body must be the documented primary model.
  const body = JSON.parse(log[0]!.body);
  assert.equal(body.model, "openai/gpt-oss-120b");
  // Keys must not leak into the request body.
  assert.ok(!log[0]!.body.includes(PRIMARY_KEY));
  assert.ok(!log[0]!.body.includes(FALLBACK_KEY));
});

// ---------------------------------------------------------------------------
// REGRESSION: the bug was a hardcoded `provider: "minimax"` at the
// primary call site even though the primary URL is NIM. This test
// forces a 401 from the primary and asserts the error label says
// `nvidia-nim/openai/gpt-oss-120b#recall`, NOT
// `minimax/openai/gpt-oss-120b#recall`.
// ---------------------------------------------------------------------------

test("recall: regression - primary 401 error label is nvidia-nim/openai/gpt-oss-120b#recall, not minimax/...", async () => {
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
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 1);
    assert.ok(r.lastError, "lastError should be present");
    // The bug: the message used to read
    // `minimax/openai/gpt-oss-120b#recall: auth failed (HTTP 401)`.
    // The fix: it must read
    // `nvidia-nim/openai/gpt-oss-120b#recall: auth failed (HTTP 401)`.
    assert.match(
      r.lastError!.message,
      /nvidia-nim\/openai\/gpt-oss-120b#recall: auth failed \(HTTP 401\)/,
      "primary error message must use the actual primary endpoint label",
    );
    assert.ok(
      !r.lastError!.message.includes("minimax/openai/gpt-oss-120b#recall"),
      "primary error message must NOT carry the old minimax/openai/gpt-oss-120b#recall label",
    );
    // The top-level message also must not echo the wrong label.
    assert.ok(
      !r.message.includes("minimax/openai/gpt-oss-120b#recall"),
      "top-level message must NOT carry the old minimax/openai/gpt-oss-120b#recall label",
    );
  }
  // The request must actually have gone to NIM, not MiniMax.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
});

// ---------------------------------------------------------------------------
// Primary hard failure -> fallback success: when the operator has
// explicitly configured a MiniMax fallback (opt-in, not default),
// the label must be minimax + MiniMax-M3 and the request must
// actually go to the MiniMax endpoint.
// ---------------------------------------------------------------------------

test("recall: primary hard failure falls back to minimax + MiniMax-M3 (opt-in MiniMax fallback)", async () => {
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () => httpErrorResponse(500, "primary down"),
      () =>
        okChatResponse(
          "The project uses Postgres 16 for the primary store.",
          "MiniMax-M3",
        ),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      // Opt-in MiniMax fallback: under the NVIDIA-only stance
      // the fallback slot is empty by default, so the operator
      // must explicitly set the URL and model. With these
      // overrides, the fallback call is attempted and the
      // adapter surfaces the MiniMax provider id.
      fallbackBaseUrl: "https://api.minimax.io/v1",
      fallbackModel: "MiniMax-M3",
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.providerUsed, "minimax");
    assert.equal(r.modelUsed, "MiniMax-M3");
    assert.equal(r.httpCalls, 2);
    // The answer must come from the fallback response.
    assert.match(r.answer, /Postgres/);
  }
  // Call 1 -> NIM (500). Call 2 -> MiniMax (200).
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
  assert.match(log[1]!.url, /^https:\/\/api\.minimax\.io\//);
  const fallbackBody = JSON.parse(log[1]!.body);
  assert.equal(fallbackBody.model, "MiniMax-M3");
});

// ---------------------------------------------------------------------------
// Both providers fail: error message references the right labels for each slot
// ---------------------------------------------------------------------------

test("recall: both providers fail -> error message uses the actual endpoint labels (nvidia-nim primary, minimax fallback)", async () => {
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
      fallbackApiKey: FALLBACK_KEY,
      // Opt-in MiniMax fallback (see comment above).
      fallbackBaseUrl: "https://api.minimax.io/v1",
      fallbackModel: "MiniMax-M3",
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "all-providers-failed");
    assert.equal(r.httpCalls, 2);
    // The aggregate message names each slot by its real label.
    // The shape is:
    //   `primary=<provider>: hard failure (<kind>): <providerLabel>: <http-msg>`
    // and similarly for fallback.
    assert.match(
      r.message,
      /primary=nvidia-nim: hard failure \(auth\): nvidia-nim\/openai\/gpt-oss-120b#recall: auth failed \(HTTP 401\)/,
    );
    assert.match(
      r.message,
      /fallback=minimax: hard failure \(auth\): minimax\/MiniMax-M3#recall: auth failed \(HTTP 403\)/,
    );
    // No stale labels anywhere in the message.
    assert.ok(
      !r.message.includes("minimax/openai/gpt-oss-120b#recall"),
      "aggregate message must NOT carry the old minimax/openai/gpt-oss-120b#recall label",
    );
    assert.ok(
      !r.message.includes("nvidia-nim/MiniMax-M3#recall"),
      "aggregate message must NOT carry a nvidia-nim/MiniMax-M3#recall label",
    );
    // The last error is the fallback's hard failure (403 -> auth).
    assert.equal(r.lastError?.kind, "auth");
    assert.equal(r.lastError?.status, 403);
    // The lastError message itself must also be the fallback's
    // correct label, not the stale primary label.
    assert.match(
      r.lastError!.message,
      /^minimax\/MiniMax-M3#recall: auth failed \(HTTP 403\)/,
    );
  }
  // First call -> NIM. Second -> MiniMax.
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
  assert.match(log[1]!.url, /^https:\/\/api\.minimax\.io\//);
});

// ---------------------------------------------------------------------------
// No primary key (but fallback key configured): the missing-config
// message for the primary slot must say "nvidia-nim", not "minimax".
// ---------------------------------------------------------------------------

test("recall: primary no-key message says nvidia-nim (the actual primary endpoint), not minimax", async () => {
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
    assert.match(
      r.lastError!.message,
      /^nvidia-nim: no api key configured$/,
      "primary missing-config message must use the actual primary endpoint label",
    );
    assert.ok(
      !r.lastError!.message.startsWith("minimax:"),
      "primary missing-config message must NOT start with the stale `minimax:` label",
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
      () => okChatResponse("ok", "MiniMax-M3"),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      // Opt-in MiniMax fallback (see comment above).
      fallbackBaseUrl: "https://api.minimax.io/v1",
      fallbackModel: "MiniMax-M3",
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
      fallbackApiKey: FALLBACK_KEY,
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
      /nvidia-nim\/openai\/gpt-oss-120b#recall: auth failed \(HTTP 401\)/,
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

test("recall: regression gate - synthesised label never equals 'minimax/openai/gpt-oss-120b#recall' for any role", async () => {
  // Force both providers to fail with auth errors and inspect
  // every error surface for the malformed label.
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
        `surface still contains the malformed label: ${JSON.stringify(s)}`,
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

test("recall: primary 200 with malformed content (no fallback configured) -> all-providers-failed with primary's bad-request surfaced", async () => {
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
  // The bad-request error from the primary's http-client call is
  // the operator-visible signal. It must name the missing field
  // and use the actual primary endpoint's label (nvidia-nim /
  // openai/gpt-oss-120b#recall), NOT the stale minimax label.
  assert.equal(r.lastError!.kind, "bad-request");
  assert.equal(r.lastError!.status, 200);
  assert.equal(r.lastError!.reachedServer, true);
  assert.match(
    r.lastError!.message,
    /nvidia-nim\/openai\/gpt-oss-120b#recall: response missing choices\[0\]\.message\.content/,
    "lastError must name the missing field and use the actual primary endpoint label",
  );
  // The top-level message (the string the recall controller
  // surfaces as the public `provider_error.reason`) must follow
  // the documented `primary failed and no fallback configured: ...`
  // shape and include the primary's lastError message.
  assert.match(
    r.message,
    /^primary failed and no fallback configured: nvidia-nim\/openai\/gpt-oss-120b#recall: response missing choices\[0\]\.message\.content$/,
    "top-level message must follow the operator-visible shape",
  );
  // No fabricated answer.
  assert.ok(!r.message.includes("Postgres"));
  // Only the primary slot was called.
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
});

test("recall: primary 200 with malformed content + fallback configured -> fallback recovers with minimax + MiniMax-M3", async () => {
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
          "MiniMax-M3",
        ),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "What database does the project use?",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
      // Opt-in MiniMax fallback (see comment above).
      fallbackBaseUrl: "https://api.minimax.io/v1",
      fallbackModel: "MiniMax-M3",
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fallbackUsed, true, "answer must come from the fallback");
  assert.equal(r.providerUsed, "minimax");
  assert.equal(r.modelUsed, "MiniMax-M3");
  assert.equal(r.httpCalls, 2);
  // The synthesized answer is the fallback's, not a fabricated
  // echo of the primary's empty body.
  assert.match(r.answer, /Postgres 16/);
  // Call 1 -> NIM (200 malformed). Call 2 -> MiniMax (200 ok).
  assert.equal(log.length, 2);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
  assert.match(log[1]!.url, /^https:\/\/api\.minimax\.io\//);
  const fallbackBody = JSON.parse(log[1]!.body);
  assert.equal(fallbackBody.model, "MiniMax-M3");
});

test("recall: primary 200 with empty string content (no fallback configured) -> all-providers-failed with 'empty response content' surface", async () => {
  // The empty-content branch lives in the recall adapter, not
  // the http-client. The http-client returns ok=true with
  // content=""; the adapter then classifies it as
  // "empty response content" and falls back. With no fallback
  // configured, the operator must see a typed all-providers-
  // failed outcome whose message names the primary endpoint
  // (nvidia-nim) and the empty-content reason, with no
  // `lastError` (because the http-client reported ok=true).
  const log: Array<{ url: string; body: string }> = [];
  const fetchImpl = scriptedFetch(
    [
      () =>
        new Response(
          JSON.stringify({
            id: "x",
            model: "openai/gpt-oss-120b",
            choices: [
              { message: { role: "assistant", content: "" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
    log,
  );
  const r = await synthesizeRecallWithFallback(
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
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
    "nvidia-nim: empty response content",
    "top-level message must name the primary endpoint and the empty-content reason",
  );
  assert.equal(r.lastError, undefined);
  assert.equal(log.length, 1);
  assert.match(log[0]!.url, /^https:\/\/integrate\.api\.nvidia\.com\//);
});