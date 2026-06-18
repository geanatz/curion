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
  RECALL_DEFAULT_FALLBACK_BASE_URL,
  RECALL_DEFAULT_FALLBACK_MODEL,
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

const SAMPLE_MEMORIES: RecallMemoryInput[] = [
  { id: 1, summary: "The project uses Postgres 16 for the primary store." },
  { id: 2, summary: "Auth tokens rotate weekly via the rotation job." },
];

// ---------------------------------------------------------------------------
// Defaults / config
// ---------------------------------------------------------------------------

test("recall: loadRecallAdapterConfig returns the documented defaults", () => {
  return withCleanEnv(ENV_KEYS, () => {
    const cfg = loadRecallAdapterConfig();
    assert.equal(cfg.primaryBaseUrl, RECALL_DEFAULT_PRIMARY_BASE_URL);
    assert.equal(cfg.primaryBaseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(cfg.primaryModel, RECALL_DEFAULT_PRIMARY_MODEL);
    assert.equal(cfg.primaryModel, "openai/gpt-oss-120b");
    assert.equal(cfg.fallbackBaseUrl, RECALL_DEFAULT_FALLBACK_BASE_URL);
    assert.equal(cfg.fallbackBaseUrl, "https://api.minimax.io/v1");
    assert.equal(cfg.fallbackModel, RECALL_DEFAULT_FALLBACK_MODEL);
    assert.equal(cfg.fallbackModel, "MiniMax-M3");
    assert.equal(cfg.timeoutMs, RECALL_DEFAULT_TIMEOUT_MS);
    assert.equal(cfg.timeoutMs, 30_000);
    assert.equal(cfg.maxTokens, RECALL_DEFAULT_MAX_TOKENS);
    assert.equal(cfg.maxTokens, 512);
    // The primary slot is NVIDIA NIM and the fallback slot is
    // MiniMax. This is the invariant that the labels must honor.
    assert.match(cfg.primaryBaseUrl, /nvidia/);
    assert.match(cfg.fallbackBaseUrl, /minimax/);
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
    assert.equal(cfg.fallbackBaseUrl, RECALL_DEFAULT_FALLBACK_BASE_URL);
    assert.equal(cfg.fallbackModel, RECALL_DEFAULT_FALLBACK_MODEL);
    assert.equal(cfg.primaryApiKey, "");
    assert.equal(cfg.fallbackApiKey, "");
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
// Primary hard failure -> fallback success: label must be minimax + MiniMax-M3
// ---------------------------------------------------------------------------

test("recall: primary hard failure falls back to minimax + MiniMax-M3 (the actual fallback endpoint)", async () => {
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
    "q",
    SAMPLE_MEMORIES,
    {
      primaryApiKey: PRIMARY_KEY,
      fallbackApiKey: FALLBACK_KEY,
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