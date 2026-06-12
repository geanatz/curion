/**
 * Tests for the provider HTTP client.
 *
 * All tests stub `fetch`. No network access is required.
 *
 * Coverage:
 *   1. Authorization header is sent as `Bearer <key>` and the key
 *      does NOT appear in the JSON request body.
 *   2. Server error bodies that echo the API key have the key
 *      redacted from the returned `ProviderError.message`.
 *   3. Server error bodies that contain a `Bearer <token>` string
 *      or a known key prefix (`sk-...`, `nvapi-...`) have those
 *      values redacted.
 *   4. Network-level fetch failures with the key embedded in the
 *      error text have the key redacted.
 *   5. The `sanitizeServerText` helper scrubs named JSON fields
 *      (`api_key`, `token`, `password`, etc.) and truncates long
 *      bodies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { chatCompletion, sanitizeServerText } from "../src/providers/http-client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = "sk-test-not-real-1234567890abcdef";

/** A fetch stub that records the request and returns a scripted response. */
function recordingFetch(
  response: () => Response,
  log: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): typeof fetch {
  const f: typeof fetch = async (input, init) => {
    log.url = typeof input === "string" ? input : (input as URL).toString();
    log.method = init?.method;
    log.headers = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string> | Headers;
      if (typeof (h as Headers).get === "function") {
        const hd = h as Headers;
        for (const k of ["authorization", "content-type", "accept"]) {
          const v = hd.get(k);
          if (v !== null) log.headers![k] = v;
        }
      } else {
        Object.assign(log.headers, h as Record<string, string>);
      }
    }
    log.body = typeof init?.body === "string" ? init.body : "";
    return response();
  };
  return f;
}

const VALID_REQ = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "hello" }],
  temperature: 0,
  responseFormat: "json_object" as const,
  maxTokens: 64,
};

// ---------------------------------------------------------------------------
// 1. Authorization header is sent correctly and key is not in body
// ---------------------------------------------------------------------------

test("http-client: sends Authorization: Bearer <key> header, key is NOT in body", async () => {
  const log: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {};
  const fetchImpl = recordingFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "test-model",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    log,
  );
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    providerLabel: "test",
  });
  assert.equal(r.ok, true);
  // Header is present and well-formed.
  assert.equal(log.headers?.["authorization"], `Bearer ${TEST_KEY}`);
  // Body is JSON without the key.
  assert.ok(log.body, "request body must be recorded");
  assert.ok(!log.body!.includes(TEST_KEY), "api key must not appear in request body");
  const parsed = JSON.parse(log.body!);
  assert.equal(parsed.model, "test-model");
  assert.deepEqual(parsed.messages, VALID_REQ.messages);
  assert.equal(parsed.response_format?.type, "json_object");
});

// ---------------------------------------------------------------------------
// 2. Server error body echoing the API key is redacted
// ---------------------------------------------------------------------------

test("http-client: server error body that contains the API key has it redacted", async () => {
  const log: Record<string, string> = {};
  const echoBody =
    `upstream error: request rejected, auth=<${TEST_KEY}> please rotate`;
  const fetchImpl = recordingFetch(
    () => new Response(echoBody, { status: 500, headers: { "content-type": "text/plain" } }),
    log as { body?: string },
  );
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    providerLabel: "test",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "server");
    assert.equal(r.error.status, 500);
    assert.ok(!r.error.message.includes(TEST_KEY), "key must be redacted from error message");
    assert.match(r.error.message, /<redacted>/);
  }
});

// ---------------------------------------------------------------------------
// 3. Bearer / sk- / nvapi- patterns in server bodies are redacted
// ---------------------------------------------------------------------------

test("http-client: server error body containing a Bearer token is redacted", async () => {
  const fetchImpl = recordingFetch(
    () =>
      new Response(
        `proxy echoed: Authorization: Bearer nvapi-abcdef0123456789xyzAB`,
        { status: 502 },
      ),
    {} as { body?: string },
  );
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    providerLabel: "test",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "server");
    assert.ok(
      !r.error.message.includes("nvapi-abcdef0123456789xyzAB"),
      "raw token must be redacted",
    );
    assert.match(r.error.message, /<redacted>/);
  }
});

test("http-client: server error body containing an sk- key is redacted", async () => {
  const fetchImpl = recordingFetch(
    () =>
      new Response(
        `mirror debug: sk-abcdefghijklmnopqrstuv`,
        { status: 500 },
      ),
    {} as { body?: string },
  );
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    providerLabel: "test",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "server");
    assert.ok(
      !r.error.message.includes("sk-abcdefghijklmnopqrstuv"),
      "raw sk- key must be redacted",
    );
  }
});

test("http-client: server error body with JSON field 'api_key' has its value redacted", async () => {
  const fetchImpl = recordingFetch(
    () =>
      new Response(
        JSON.stringify({ error: "upstream", api_key: "leaked-key-1" }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    {} as { body?: string },
  );
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl,
    providerLabel: "test",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "server");
    assert.ok(
      !r.error.message.includes("leaked-key-1"),
      "json api_key value must be redacted",
    );
    assert.match(r.error.message, /api[_-]?key"?\s*:\s*"?<redacted>/i);
  }
});

// ---------------------------------------------------------------------------
// 4. Network-level fetch failures with key embedded in the error
// ---------------------------------------------------------------------------

test("http-client: network error message that contains the API key has it redacted", async () => {
  const f: typeof fetch = async () => {
    // Simulate a runtime / undici-style error message that
    // includes the URL with the bearer token in a query string.
    throw new Error(
      `TypeError: failed to fetch https://api.test/v1/chat/completions?token=${TEST_KEY}`,
    );
  };
  const r = await chatCompletion(VALID_REQ, {
    baseUrl: "https://api.test/v1",
    apiKey: TEST_KEY,
    timeoutMs: 5_000,
    fetchImpl: f,
    providerLabel: "test",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "network");
    assert.ok(
      !r.error.message.includes(TEST_KEY),
      "key must be redacted from network error message",
    );
  }
});

// ---------------------------------------------------------------------------
// 5. sanitizeServerText unit tests
// ---------------------------------------------------------------------------

test("sanitizeServerText: redacts known caller-supplied secrets", () => {
  const out = sanitizeServerText(`auth=<${TEST_KEY}> please check`, [TEST_KEY]);
  assert.ok(!out.includes(TEST_KEY));
  assert.match(out, /<redacted>/);
});

test("sanitizeServerText: redacts Bearer tokens and sk- / nvapi- prefixes", () => {
  const bearer = sanitizeServerText(`Authorization: Bearer abcdefghijklmnop`);
  assert.ok(!bearer.includes("abcdefghijklmnop"), `bearer not redacted: ${bearer}`);
  const sk = sanitizeServerText(`debug mirror: sk-aaaaaaaaaaaaaaabbbbbbbb`);
  assert.ok(!sk.includes("sk-aaaaaaaaaaaaaaabbbbbbbb"), `sk- not redacted: ${sk}`);
  const nv = sanitizeServerText(`forwarded: nvapi-aaaaaaaaaaaaaaabbbbbbbb`);
  assert.ok(!nv.includes("nvapi-aaaaaaaaaaaaaaabbbbbbbb"), `nvapi- not redacted: ${nv}`);
});

test("sanitizeServerText: redacts named JSON secret fields", () => {
  for (const field of ["api_key", "apiKey", "token", "password", "secret", "authorization"]) {
    const out = sanitizeServerText(
      JSON.stringify({ [field]: "leaked-value-123" }),
    );
    assert.ok(
      !out.includes("leaked-value-123"),
      `value of field ${field} must be redacted, got: ${out}`,
    );
  }
});

test("sanitizeServerText: collapses whitespace and truncates long bodies", () => {
  const long = "x".repeat(500);
  const out = sanitizeServerText(long);
  assert.ok(out.length <= 245, `expected truncation around 240, got ${out.length}`);
  assert.match(out, /\.\.\.$/);
  const multi = sanitizeServerText("line1\nline2\r\nline3\t\tline4");
  // Whitespace is collapsed to single spaces; the original newlines
  // and tabs are gone.
  assert.ok(!multi.includes("\n"));
  assert.ok(!multi.includes("\t"));
  assert.match(multi, /^line1 line2 line3 line4$/);
});

test("sanitizeServerText: non-string input returns empty string", () => {
  // Defensive: the type system already prevents this, but the
  // implementation guards against it too.
  const out = sanitizeServerText(undefined as unknown as string);
  assert.equal(out, "");
});
