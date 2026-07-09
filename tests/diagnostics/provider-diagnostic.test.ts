/**
 * Tests for the provider diagnostic.
 *
 * No network access. Every test stubs `fetch` directly.
 *
 * Coverage:
 *   1. Pure helpers
 *      - `classifyHttpStatus` covers 401/403/404/408/429/5xx/4xx/200.
 *      - `classifyTransportError` covers fetch-failed / timeout.
 *      - `classifyMalformedBody` covers non-json / missing-content / ok.
 *      - `buildProbeRequestBody` produces the expected shape.
 *      - `urlHost` extracts the host safely.
 *      - `resolveDiagnosticEnv` resolves MiniMax fallback env and
 *        reports key presence without echoing the value.
 *      - `formatProbeReport` / `formatDiagnosticReport` produce
 *        a string that contains the model + status + keyPresent
 *        flag but NEVER contains the key value.
 *
 *   2. Probe network behavior (with `fetch` stubbed)
 *      - 200 OK with valid body -> ok.
 *      - 401 -> auth, reachedServer=true, httpStatus=401.
 *      - 403 -> auth.
 *      - 404 -> not-found.
 *      - 429 -> rate-limit.
 *      - 500 -> server.
 *      - 400 -> bad-request.
 *      - 200 OK with malformed body -> malformed-response.
 *      - 200 OK with non-JSON content-type -> malformed-response.
 *      - fetch throws (e.g. "fetch failed") -> fetch-failed.
 *      - AbortController fires -> timeout.
 *      - Missing api key -> missing-config (no HTTP call).
 *      - Server error body that echoes the key has it redacted.
 *      - Network error message that includes the URL with a query
 *        token has the key redacted.
 *      - `Authorization: Bearer <key>` header is sent and the
 *        key is NOT in the request body.
 *      - Body uses `max_tokens: 1` and the default tiny prompt.
 *
 * Conventions:
 *   - Hand-written, deterministic. No property-based tests here
 *     because the diagnostic is small and the failure modes are
 *     enumerated by the task description.
 *   - The key constant is intentionally shaped like an OpenAI
 *     key (`sk-...`) so the redaction patterns exercise on a
 *     realistic string. The literal value is fake.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DIAGNOSTIC_MAX_TOKENS,
  DEFAULT_DIAGNOSTIC_PROMPT,
  type DiagnosticProviderId,
  type ProbeProviderResult,
  buildProbeRequestBody,
  classifyHttpStatus,
  classifyMalformedBody,
  classifyTransportError,
  formatDiagnosticReport,
  formatProbeReport,
  probeProvider,
  resolveDiagnosticEnv,
  urlHost,
} from "../../src/providers/provider-diagnostic.ts";

// ---------------------------------------------------------------------------
// Constants (fake credentials)
// ---------------------------------------------------------------------------

/**
 * A fake OpenAI-shaped key. Used purely to exercise the
 * redaction paths. Never logged.
 */
const FAKE_KEY = "sk-test-diag-1234567890abcdefXYZ";

/** A fake NIM-shaped key. */
const FAKE_NIM_KEY = "nvapi-test-diag-1234567890abcdefXYZ";

/** Standard valid 200 OK response for the probe. */
function okResponse(content = "pong"): Response {
  return new Response(
    JSON.stringify({
      id: "diag-1",
      model: "diag-model",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordingFetch {
  fetchImpl: typeof fetch;
  calls: Array<{
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal | null;
  }>;
}

function recordingFetch(
  responder: (req: { url: string; body: string }) => Response
): RecordingFetch {
  const calls: RecordingFetch["calls"] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    const headers: Record<string, string> = {};
    if (init && typeof init === "object" && init.headers) {
      const h = init.headers as Record<string, string> | Headers;
      if (typeof (h as Headers).get === "function") {
        const hd = h as Headers;
        for (const k of ["authorization", "content-type", "accept"]) {
          const v = hd.get(k);
          if (v !== null) headers[k] = v;
        }
      } else {
        Object.assign(headers, h as Record<string, string>);
      }
    }
    calls.push({
      url,
      method: init?.method,
      headers,
      body,
      signal: init?.signal ?? null,
    });
    return responder({ url, body });
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

test("diagnostic: classifyHttpStatus covers common classes", () => {
  assert.equal(classifyHttpStatus(200), "unknown"); // 2xx is not classified by this helper
  assert.equal(classifyHttpStatus(401), "auth");
  assert.equal(classifyHttpStatus(403), "auth");
  assert.equal(classifyHttpStatus(404), "not-found");
  assert.equal(classifyHttpStatus(408), "timeout");
  assert.equal(classifyHttpStatus(429), "rate-limit");
  assert.equal(classifyHttpStatus(500), "server");
  assert.equal(classifyHttpStatus(502), "server");
  assert.equal(classifyHttpStatus(503), "server");
  assert.equal(classifyHttpStatus(504), "timeout");
  assert.equal(classifyHttpStatus(400), "bad-request");
  assert.equal(classifyHttpStatus(418), "bad-request");
  assert.equal(classifyHttpStatus(600), "unknown");
});

test("diagnostic: classifyTransportError covers fetch-failed and timeout", () => {
  assert.equal(classifyTransportError(new Error("fetch failed")), "fetch-failed");
  assert.equal(classifyTransportError(new Error("TypeError: failed to fetch")), "fetch-failed");
  assert.equal(
    classifyTransportError(new Error("connect ECONNREFUSED 127.0.0.1:443")),
    "fetch-failed"
  );
  assert.equal(
    classifyTransportError(new Error("getaddrinfo ENOTFOUND api.example")),
    "fetch-failed"
  );
  // An AbortError from AbortController.abort("timeout") is treated as timeout.
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(classifyTransportError(aborted), "timeout");
  // Anything we don't recognize still collapses to fetch-failed (transport).
  assert.equal(classifyTransportError(new Error("weird thing")), "fetch-failed");
});

test("diagnostic: classifyMalformedBody returns the right reason", () => {
  const valid = JSON.stringify({
    choices: [{ message: { content: "x" } }],
  });
  assert.deepEqual(classifyMalformedBody(valid, "application/json"), {
    isMalformed: false,
    reason: "ok",
  });

  assert.deepEqual(classifyMalformedBody("", "application/json"), {
    isMalformed: true,
    reason: "non-json",
  });

  assert.deepEqual(classifyMalformedBody("{not json", "application/json"), {
    isMalformed: true,
    reason: "non-json",
  });

  // non-json content-type wins even if the body happens to be JSON.
  assert.deepEqual(classifyMalformedBody(valid, "text/plain"), {
    isMalformed: true,
    reason: "non-json",
  });

  // JSON but no choices.
  assert.deepEqual(classifyMalformedBody(JSON.stringify({}), "application/json"), {
    isMalformed: true,
    reason: "missing-content",
  });
  // JSON but empty choices.
  assert.deepEqual(classifyMalformedBody(JSON.stringify({ choices: [] }), "application/json"), {
    isMalformed: true,
    reason: "missing-content",
  });
  // JSON but content is not a string.
  assert.deepEqual(
    classifyMalformedBody(
      JSON.stringify({ choices: [{ message: { content: null } }] }),
      "application/json"
    ),
    { isMalformed: true, reason: "missing-content" }
  );
  // JSON but message is missing.
  assert.deepEqual(
    classifyMalformedBody(
      JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
      "application/json"
    ),
    { isMalformed: true, reason: "missing-content" }
  );
});

test("diagnostic: buildProbeRequestBody uses minimal shape with max_tokens=1", () => {
  const body = buildProbeRequestBody({
    model: "m",
    userPrompt: "hi",
    maxTokens: 1,
  });
  assert.equal(body.model, "m");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.stream, false);
});

test("diagnostic: urlHost extracts host or returns empty for invalid", () => {
  assert.equal(urlHost("https://api.minimax.io/v1"), "api.minimax.io");
  assert.equal(urlHost("https://integrate.api.nvidia.com/v1/"), "integrate.api.nvidia.com");
  assert.equal(urlHost("HTTPS://API.MINIMAX.IO"), "api.minimax.io");
  assert.equal(urlHost("not a url"), "");
  assert.equal(urlHost(""), "");
});

// ---------------------------------------------------------------------------
// 2. Env resolution (no key values in the descriptor)
// ---------------------------------------------------------------------------

test("diagnostic: resolveDiagnosticEnv reports MiniMax presence without values", () => {
  const env = {
    CURION_PROVIDER_FALLBACK_KEY: FAKE_KEY,
    CURION_FALLBACK_BASE_URL: "https://api.minimax.io/v1",
    CURION_FALLBACK_MODEL: "MiniMax-M3",
  } satisfies Record<string, string>;
  const desc = resolveDiagnosticEnv("minimax", env);
  assert.equal(desc.provider, "minimax");
  assert.equal(desc.baseUrl, "https://api.minimax.io/v1");
  assert.equal(desc.model, "MiniMax-M3");
  assert.equal(desc.keyPresent, true);
  assert.equal(desc.host, "api.minimax.io");
  assert.equal(desc.path, "/chat/completions");
  assert.equal(desc.ready, true);
  // Crucially, the descriptor must NEVER contain the key value
  // in any field. We serialize it for the assertion so a future
  // accidental field can't sneak through.
  const serialized = JSON.stringify(desc);
  assert.ok(
    !serialized.includes(FAKE_KEY),
    `descriptor must not contain key value, got: ${serialized}`
  );
});

test("diagnostic: resolveDiagnosticEnv reports NIM presence without values", () => {
  const env = {
    NVIDIA_NIM_API_KEY: FAKE_NIM_KEY,
    CURION_NIM_BASE_URL: "https://integrate.api.nvidia.com/v1",
    CURION_NIM_FALLBACK_MODEL: "openai/gpt-oss-120b",
  } satisfies Record<string, string>;
  const desc = resolveDiagnosticEnv("nvidia-nim", env);
  assert.equal(desc.provider, "nvidia-nim");
  assert.equal(desc.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(desc.model, "openai/gpt-oss-120b");
  assert.equal(desc.keyPresent, true);
  assert.equal(desc.host, "integrate.api.nvidia.com");
  const serialized = JSON.stringify(desc);
  assert.ok(
    !serialized.includes(FAKE_NIM_KEY),
    `descriptor must not contain NIM key value, got: ${serialized}`
  );
});

test("diagnostic: resolveDiagnosticEnv falls back to defaults when env is empty", () => {
  const desc = resolveDiagnosticEnv("minimax", {});
  assert.equal(desc.provider, "minimax");
  assert.equal(desc.baseUrl, "https://api.minimax.io/v1");
  assert.equal(desc.model, "MiniMax-M3");
  assert.equal(desc.keyPresent, false);
  assert.equal(desc.ready, false);
});

test("diagnostic: resolveDiagnosticEnv prefers canonical env over legacy aliases", () => {
  // MINIMAX_API_KEY is the legacy alias; CURION_PROVIDER_FALLBACK_KEY wins
  // when both are present. The descriptor only reports presence, but the
  // consulted env list lets the operator see which slot was used.
  const env = {
    MINIMAX_API_KEY: FAKE_KEY,
    CURION_PROVIDER_FALLBACK_KEY: FAKE_KEY, // same value, different env name
    CURION_MINIMAX_BASE_URL: "https://api.minimax.io/v1",
    CURION_MINIMAX_MODEL: "MiniMax-M3",
  } satisfies Record<string, string>;
  const desc = resolveDiagnosticEnv("minimax", env);
  assert.equal(desc.keyPresent, true);
  assert.ok(
    desc.envVars.includes("CURION_PROVIDER_FALLBACK_KEY"),
    "expected canonical fallback key env to appear in consulted list"
  );
});

// ---------------------------------------------------------------------------
// 3. Report formatting (key value must never appear in output)
// ---------------------------------------------------------------------------

test("diagnostic: formatProbeReport never echoes the key value", () => {
  const desc = {
    provider: "minimax" as DiagnosticProviderId,
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    keyPresent: true,
    host: "api.minimax.io",
    path: "/chat/completions",
    ready: true,
    envVars: ["MINIMAX_API_KEY"],
  };
  const result: ProbeProviderResult = {
    provider: "minimax",
    model: "MiniMax-M3",
    baseUrl: "https://api.minimax.io/v1",
    status: "ok",
    httpStatus: 200,
    latencyMs: 42,
    reachedServer: true,
    errorClass: "ok",
    contentPreview: "pong",
  };
  const out = formatProbeReport(desc, result);
  assert.ok(out.includes("MiniMax-M3"), "model id should appear");
  assert.ok(out.includes("ok"), "status should appear");
  assert.ok(out.includes("api.minimax.io"), "host should appear");
  assert.ok(out.includes("yes"), "key presence flag should appear");
  assert.ok(!out.includes(FAKE_KEY), `report must not contain key value, got: ${out}`);
});

test("diagnostic: formatDiagnosticReport produces summary lines", () => {
  const descs = [
    {
      provider: "minimax" as DiagnosticProviderId,
      baseUrl: "https://api.minimax.io/v1",
      model: "MiniMax-M3",
      keyPresent: true,
      host: "api.minimax.io",
      path: "/chat/completions",
      ready: true,
      envVars: ["MINIMAX_API_KEY"],
    },
  ];
  const results: ProbeProviderResult[] = [
    {
      provider: "minimax",
      model: "MiniMax-M3",
      baseUrl: "https://api.minimax.io/v1",
      status: "ok",
      httpStatus: 200,
      latencyMs: 17,
      reachedServer: true,
      errorClass: "ok",
      contentPreview: "pong",
    },
  ];
  const out = formatDiagnosticReport(descs, results);
  assert.ok(out.includes("curion provider diagnostic"));
  assert.ok(out.includes("summary"));
  assert.ok(out.includes("ok"));
});

// ---------------------------------------------------------------------------
// 4. Probe network behavior (stubbed fetch)
// ---------------------------------------------------------------------------

test("diagnostic: probeProvider returns ok on 200 with valid body", async () => {
  const { fetchImpl, calls } = recordingFetch(() => okResponse());
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.httpStatus, 200);
  assert.equal(r.reachedServer, true);
  assert.equal(r.latencyMs >= 0, true);
  assert.equal(r.contentPreview, "pong");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.minimax.io/v1/chat/completions");
  assert.equal(calls[0]?.headers?.["authorization"], `Bearer ${FAKE_KEY}`);
  // The key must not appear anywhere in the request body.
  assert.ok(!calls[0]?.body?.includes(FAKE_KEY), "key must not appear in request body");
  const parsed = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(parsed.max_tokens, 1);
  assert.equal(parsed.temperature, 0);
  assert.deepEqual(parsed.messages, [{ role: "user", content: DEFAULT_DIAGNOSTIC_PROMPT }]);
});

test("diagnostic: probeProvider returns auth on 401", async () => {
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
  );
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "auth");
  assert.equal(r.httpStatus, 401);
  assert.equal(r.reachedServer, true);
  assert.equal(r.errorClass, "auth");
  assert.match(r.errorMessage ?? "", /HTTP 401/);
});

test("diagnostic: probeProvider returns auth on 403", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("forbidden", { status: 403 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "auth");
  assert.equal(r.httpStatus, 403);
});

test("diagnostic: probeProvider returns not-found on 404", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("model missing", { status: 404 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "not-found");
  assert.equal(r.httpStatus, 404);
  assert.equal(r.reachedServer, true);
  assert.match(r.errorMessage ?? "", /model missing/);
});

test("diagnostic: probeProvider returns rate-limit on 429", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("slow down", { status: 429 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "rate-limit");
  assert.equal(r.httpStatus, 429);
});

test("diagnostic: probeProvider returns server on 500", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("upstream broke", { status: 500 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "server");
  assert.equal(r.httpStatus, 500);
  assert.equal(r.reachedServer, true);
  assert.match(r.errorMessage ?? "", /upstream broke/);
});

test("diagnostic: probeProvider returns bad-request on 400", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("bad input", { status: 400 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "bad-request");
  assert.equal(r.httpStatus, 400);
});

test("diagnostic: probeProvider returns malformed-response on 200 OK missing content", async () => {
  const { fetchImpl } = recordingFetch(
    () =>
      new Response(JSON.stringify({ id: "x", choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "malformed-response");
  assert.equal(r.httpStatus, 200);
  assert.equal(r.reachedServer, true);
});

test("diagnostic: probeProvider returns malformed-response on 200 OK non-JSON", async () => {
  const { fetchImpl } = recordingFetch(
    () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
  );
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "malformed-response");
  assert.equal(r.httpStatus, 200);
});

test("diagnostic: probeProvider returns fetch-failed when transport throws", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("fetch failed");
  };
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "fetch-failed");
  assert.equal(r.reachedServer, false);
  assert.match(r.errorMessage ?? "", /fetch failed/);
});

test("diagnostic: probeProvider returns timeout when AbortController fires", async () => {
  // fetchImpl hangs forever (simulating a slow upstream). The
  // probe's internal 200ms timeout should fire and classify the
  // outcome as timeout.
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }
    });
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 200,
    fetchImpl,
  });
  assert.equal(r.status, "timeout");
  assert.equal(r.reachedServer, false);
  assert.match(r.errorMessage ?? "", /timeout/);
});

test("diagnostic: probeProvider returns missing-config without HTTP when apiKey is empty", async () => {
  let fetchCalled = false;
  const fetchImpl: typeof fetch = async () => {
    fetchCalled = true;
    return okResponse() as Response;
  };
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: "",
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "missing-config");
  assert.equal(r.reachedServer, false);
  assert.equal(fetchCalled, false, "fetch must not be called when apiKey is empty");
});

test("diagnostic: probeProvider redacts key from server error body", async () => {
  const echo = `upstream error: auth=<${FAKE_KEY}> rotate`;
  const { fetchImpl } = recordingFetch(() => new Response(echo, { status: 500 }));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "server");
  assert.ok(
    !r.errorMessage?.includes(FAKE_KEY),
    `error message must redact the key, got: ${r.errorMessage}`
  );
  assert.match(r.errorMessage ?? "", /<redacted>/);
});

test("diagnostic: probeProvider redacts key from transport error message", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error(
      `TypeError: failed to fetch https://api.minimax.io/v1/chat/completions?token=${FAKE_KEY}`
    );
  };
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "fetch-failed");
  assert.ok(
    !r.errorMessage?.includes(FAKE_KEY),
    `transport error message must redact the key, got: ${r.errorMessage}`
  );
});

test("diagnostic: probeProvider accepts trailing slash on baseUrl", async () => {
  const { fetchImpl, calls } = recordingFetch(() => okResponse());
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1/", // trailing slash
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "ok");
  assert.equal(calls[0]?.url, "https://api.minimax.io/v1/chat/completions");
});

test("diagnostic: probeProvider trims long contentPreview to a safe length", async () => {
  const longContent = "x".repeat(500);
  const { fetchImpl } = recordingFetch(() => okResponse(longContent));
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
  });
  assert.equal(r.status, "ok");
  assert.ok(
    r.contentPreview !== undefined && r.contentPreview.length <= 125,
    `preview should be truncated to ~120 chars, got ${r.contentPreview?.length}`
  );
  assert.match(r.contentPreview ?? "", /\.{3}$/);
});

// ---------------------------------------------------------------------------
// 5. probeProvider request body honors an explicit maxTokens
// ---------------------------------------------------------------------------

test("diagnostic: probeProvider uses max_tokens=1 by default in the request body", async () => {
  const { fetchImpl, calls } = recordingFetch(() => okResponse());
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    // intentionally omit maxTokens
  });
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body.max_tokens, 1, "default max_tokens must remain 1");
});

test("diagnostic: probeProvider forwards an explicit maxTokens into the request body", async () => {
  const { fetchImpl, calls } = recordingFetch(() => okResponse());
  const r = await probeProvider({
    provider: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M3",
    apiKey: FAKE_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    maxTokens: 32,
  });
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]?.body ?? "{}");
  assert.equal(body.max_tokens, 32);
  // Sanity: the rest of the body is unchanged so an operator
  // tweaking --max-tokens does not silently alter other fields.
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.model, "MiniMax-M3");
});

test("diagnostic: buildProbeRequestBody reflects maxTokens arg directly", () => {
  const body = buildProbeRequestBody({
    model: "m",
    userPrompt: "hi",
    maxTokens: 64,
  });
  assert.equal(body.max_tokens, 64);
});

// ---------------------------------------------------------------------------
// 6. CLI parsing for --max-tokens (and other flags touched together)
// ---------------------------------------------------------------------------

import {
  type CliOptions,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  parseDiagnosticCli,
} from "../../scripts/provider-diagnostic.ts";

function parseOk(argv: readonly string[]): CliOptions {
  const r = parseDiagnosticCli(argv);
  if ("error" in r) {
    throw new Error(`unexpected parse error: ${r.error}`);
  }
  return r.opts;
}

test("diagnostic: parseDiagnosticCli defaults maxTokens to 1", () => {
  const opts = parseOk([]);
  assert.equal(opts.provider, "minimax");
  assert.equal(opts.maxTokens, DEFAULT_DIAGNOSTIC_MAX_TOKENS);
  assert.equal(opts.maxTokens, 1);
});

test("diagnostic: parseDiagnosticCli accepts --max-tokens inside the allowed range", () => {
  assert.equal(parseOk(["--max-tokens", "1"]).maxTokens, 1);
  assert.equal(parseOk(["--max-tokens", "32"]).maxTokens, 32);
  assert.equal(parseOk(["--max-tokens", "256"]).maxTokens, 256);
});

test("diagnostic: parseDiagnosticCli rejects --max-tokens below MIN_MAX_TOKENS", () => {
  for (const v of ["0", "-1", "-100"]) {
    const r = parseDiagnosticCli(["--max-tokens", v]);
    if (!("error" in r)) {
      throw new Error(`expected error for --max-tokens ${v}`);
    }
    assert.match(r.error, /--max-tokens/, `error must mention --max-tokens, got: ${r.error}`);
    assert.match(r.error, new RegExp(`\\[${MIN_MAX_TOKENS}, ${MAX_MAX_TOKENS}\\]`));
  }
});

test("diagnostic: parseDiagnosticCli rejects --max-tokens above MAX_MAX_TOKENS", () => {
  for (const v of ["257", "999", "100000"]) {
    const r = parseDiagnosticCli(["--max-tokens", v]);
    if (!("error" in r)) {
      throw new Error(`expected error for --max-tokens ${v}`);
    }
    assert.match(r.error, /--max-tokens/);
    assert.match(r.error, new RegExp(`\\[${MIN_MAX_TOKENS}, ${MAX_MAX_TOKENS}\\]`));
  }
});

test("diagnostic: parseDiagnosticCli rejects non-integer --max-tokens", () => {
  for (const v of ["abc", "1.5", "1e2", " ", ""]) {
    const r = parseDiagnosticCli(["--max-tokens", v]);
    if (!("error" in r)) {
      throw new Error(`expected error for --max-tokens ${JSON.stringify(v)}`);
    }
    assert.match(
      r.error,
      /--max-tokens must be (an integer|an integer in)/,
      `error must reject non-integer, got: ${r.error}`
    );
  }
});

test("diagnostic: parseDiagnosticCli rejects --max-tokens with no value", () => {
  const r = parseDiagnosticCli(["--max-tokens"]);
  if (!("error" in r)) {
    throw new Error("expected error when --max-tokens has no value");
  }
  assert.match(r.error, /--max-tokens requires a value/);
});

test("diagnostic: parseDiagnosticCli composes --max-tokens with other flags", () => {
  const opts = parseOk([
    "--provider",
    "nvidia-nim",
    "--timeout",
    "20000",
    "--max-tokens",
    "128",
    "--dry-run",
    "--skip-dotenv",
    "--dotenv",
    "/tmp/example.env",
  ]);
  assert.equal(opts.provider, "nvidia-nim");
  assert.equal(opts.timeoutMs, 20000);
  assert.equal(opts.maxTokens, 128);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.skipDotenv, true);
  assert.equal(opts.dotenvPath, "/tmp/example.env");
});

test("diagnostic: parseDiagnosticCli treats --help as an unknown argument (CLI wrapper handles help)", () => {
  // The pure parser is intentionally side-effect-free and does
  // NOT call printHelp; help handling lives in the CLI wrapper
  // (`parseCli`) which short-circuits before reaching the parser.
  // The parser therefore treats --help like any other unknown
  // flag so tests can detect that the wrapper is the right place
  // for help output.
  const r = parseDiagnosticCli(["--help"]);
  if (!("error" in r)) {
    throw new Error("expected error for --help in the pure parser");
  }
  assert.match(r.error, /unknown argument/);
});

test("diagnostic: parseDiagnosticCli rejects unknown arguments", () => {
  const r = parseDiagnosticCli(["--not-a-flag"]);
  if (!("error" in r)) {
    throw new Error("expected error for unknown argument");
  }
  assert.match(r.error, /unknown argument/);
});
