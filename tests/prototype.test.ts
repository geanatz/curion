/**
 * Tests for the Phase 1 provider prototype infrastructure.
 *
 * Coverage:
 *   - env-loader: redaction, secret detection, .env parsing, override
 *     semantics, presence reporting (never values).
 *   - http-client: error classification, timeout, missing config, ok
 *     path with a stubbed fetch.
 *   - structured-output: parser strategies (raw, fenced, balanced),
 *     repair attempt, schema validation, prompt builder.
 *   - prototype fixtures: shape and P1..P6 ids.
 *   - runner: dry-run path (no network, no keys), CLI parse, report
 *     shape, missing-config visibility, live path with stubbed fetch.
 *
 * No test in this file requires real network access or real API keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SECRET_ENV_VARS,
  describeEnv,
  isSecretEnvVar,
  loadDotEnv,
  loadPrototypeConfig,
  redactValue,
} from "../src/config/env-loader.ts";
import {
  buildResponseFormat,
  chatCompletion,
  type ChatCompletionResponse,
} from "../src/providers/http-client.ts";
import {
  MEMORY_ANALYSIS_JSON_SCHEMA,
  MemoryAnalysisSchema,
  buildStructuredPrompt,
  parseMemoryAnalysis,
} from "../src/prototype/structured-output.ts";
import { PROTOTYPE_FIXTURES, fixtureById } from "../src/prototype/fixtures.ts";
import {
  formatHumanReport,
  parseCli,
  resolveArtifactsDir,
  runExperiments,
  type ProviderAttempt,
} from "../src/prototype/runner.ts";

// ---------------------------------------------------------------------------
// env-loader
// ---------------------------------------------------------------------------

test("env-loader: SECRET_ENV_VARS contains both aliases for each provider", () => {
  for (const v of [
    "CURION_PROVIDER_PRIMARY_KEY",
    "MINIMAX_API_KEY",
    "CURION_PROVIDER_FALLBACK_KEY",
    "NVIDIA_NIM_API_KEY",
  ]) {
    assert.ok(SECRET_ENV_VARS.includes(v), `expected ${v} in SECRET_ENV_VARS`);
  }
});

test("env-loader: isSecretEnvVar flags secrets and ignores other names", () => {
  assert.equal(isSecretEnvVar("MINIMAX_API_KEY"), true);
  assert.equal(isSecretEnvVar("CURION_LOG_LEVEL"), false);
  assert.equal(isSecretEnvVar(""), false);
});

test("env-loader: redactValue preserves length-class and never echoes secret", () => {
  const s = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const r = redactValue("MINIMAX_API_KEY", s);
  assert.notEqual(r, s, "must not echo the original");
  // First 2 / last 2 are preserved.
  assert.ok(r.startsWith(s.slice(0, 2)));
  assert.ok(r.endsWith(s.slice(-2)));
  // The middle is masked.
  assert.match(r, /\*{4,}/);
  // Non-secrets pass through.
  assert.equal(redactValue("CURION_LOG_LEVEL", "debug"), "debug");
});

test("env-loader: describeEnv redacts secrets and labels missing", () => {
  const out = describeEnv({
    CURION_LOG_LEVEL: "info",
    MINIMAX_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
    NVIDIA_NIM_API_KEY: undefined,
    CURION_PROVIDER_FALLBACK_KEY: "nvapi-something-secret",
  });
  assert.equal(out.CURION_LOG_LEVEL, "info");
  assert.notEqual(out.MINIMAX_API_KEY, "sk-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.equal(out.NVIDIA_NIM_API_KEY, "<unset>");
  assert.notEqual(out.CURION_PROVIDER_FALLBACK_KEY, "nvapi-something-secret");
  // No echoed secret should appear in the keys/values.
  for (const k of Object.keys(out)) {
    assert.ok(
      !out[k].includes("sk-abcdefghijklmnopqrstuvwxyz1234567890"),
      `secret leaked under key ${k}`,
    );
  }
});

test("env-loader: loadDotEnv parses simple KEY=value lines", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-env-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(
    file,
    [
      "# comment line",
      "",
      "CURION_LOG_LEVEL=debug",
      "export CURION_FOO=bar",
      "CURION_QUOTED=\"hello world\"",
      "CURION_SQ='single quoted'",
      "NOT_A_VALID_LINE",
    ].join("\n"),
  );
  const before = { ...process.env };
  try {
    delete process.env.CURION_LOG_LEVEL;
    delete process.env.CURION_FOO;
    delete process.env.CURION_QUOTED;
    delete process.env.CURION_SQ;
    const r = loadDotEnv({ path: file });
    assert.equal(r.loaded, true);
    assert.ok(r.keys.includes("CURION_LOG_LEVEL"));
    assert.ok(r.keys.includes("CURION_FOO"));
    assert.equal(process.env.CURION_LOG_LEVEL, "debug");
    assert.equal(process.env.CURION_FOO, "bar");
    assert.equal(process.env.CURION_QUOTED, "hello world");
    assert.equal(process.env.CURION_SQ, "single quoted");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env-loader: loadDotEnv does not overwrite existing values by default", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-env-"));
  const file = path.join(tmp, ".env");
  fs.writeFileSync(file, "CURION_LOG_LEVEL=debug\n");
  const before = process.env.CURION_LOG_LEVEL;
  process.env.CURION_LOG_LEVEL = "warn";
  try {
    const r = loadDotEnv({ path: file });
    assert.equal(process.env.CURION_LOG_LEVEL, "warn", "must not override");
    assert.ok(r.skipped.includes("CURION_LOG_LEVEL"));
    assert.ok(!r.keys.includes("CURION_LOG_LEVEL"));
  } finally {
    if (before === undefined) delete process.env.CURION_LOG_LEVEL;
    else process.env.CURION_LOG_LEVEL = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("env-loader: loadDotEnv skip:true leaves process.env untouched", () => {
  // Even if a real .env is sitting in cwd, skip:true must NOT load it.
  const before = { ...process.env };
  const r = loadDotEnv({ skip: true });
  assert.equal(r.loaded, false);
  assert.equal(r.keys.length, 0);
  // process.env must not have been modified for any key.
  for (const k of Object.keys(process.env)) {
    if (!(k in before)) {
      assert.fail(`process.env unexpectedly gained key ${k}`);
    }
  }
});

test("env-loader: loadPrototypeConfig reports presence not values", () => {
  const before = { ...process.env };
  try {
    delete process.env.CURION_PROVIDER_PRIMARY_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CURION_PROVIDER_FALLBACK_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.CURION_NIM_MODELS;
    // `skip: true` keeps the test independent of any `.env` in the
    // current working directory.
    const cfg = loadPrototypeConfig({ skip: true });
    assert.equal(cfg.hasPrimaryKey, false);
    assert.equal(cfg.hasFallbackKey, false);
    assert.deepEqual(cfg.nimModels, [
      "openai/gpt-oss-120b",
      "meta/llama-3.3-70b-instruct",
    ]);
    assert.equal(typeof cfg.minimaxModel, "string");
    assert.ok(cfg.minimaxModel.length > 0);
    assert.equal(typeof cfg.minimaxBaseUrl, "string");
    assert.equal(cfg.minimaxBaseUrl, "https://api.minimax.io/v1");
    assert.equal(typeof cfg.nimBaseUrl, "string");
    assert.equal(typeof cfg.timeoutMs, "number");
    assert.equal(typeof cfg.maxTokens, "number");
    assert.ok(cfg.maxTokens > 0);

    // With a key set, hasPrimaryKey flips to true; we never see the value
    // echoed in the config object (it is not exposed by the API).
    process.env.MINIMAX_API_KEY = "sk-test-not-real";
    const cfg2 = loadPrototypeConfig({ skip: true });
    assert.equal(cfg2.hasPrimaryKey, true);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

// ---------------------------------------------------------------------------
// http-client
// ---------------------------------------------------------------------------

test("http-client: returns missing-config when apiKey is empty", async () => {
  const r = await chatCompletion(
    { model: "x", messages: [{ role: "user", content: "hi" }] },
    { baseUrl: "https://example.com/v1", apiKey: "", timeoutMs: 1000 },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "missing-config");
    assert.equal(r.error.reachedServer, false);
  }
});

test("http-client: classifies 401 as auth error", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("nope", { status: 401 });
  const r = await chatCompletion(
    { model: "x", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      timeoutMs: 1000,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "auth");
    assert.equal(r.error.status, 401);
    assert.equal(r.error.reachedServer, true);
  }
});

test("http-client: classifies 429 as rate-limit", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("slow down", { status: 429 });
  const r = await chatCompletion(
    { model: "x", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      timeoutMs: 1000,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "rate-limit");
  }
});

test("http-client: classifies 5xx as server error", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("oops", { status: 500 });
  const r = await chatCompletion(
    { model: "x", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      timeoutMs: 1000,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "server");
  }
});

test("http-client: classifies AbortError as timeout", async () => {
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise((_, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    });
  const r = await chatCompletion(
    { model: "x", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      timeoutMs: 50,
      fetchImpl,
    },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "timeout");
  }
});

test("http-client: parses OpenAI-compatible content from a 200 response", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "abc",
        model: "test-model",
        choices: [
          {
            message: { role: "assistant", content: "hello world" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const r = await chatCompletion(
    { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    {
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      timeoutMs: 1000,
      fetchImpl,
    },
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const resp: ChatCompletionResponse = r.response;
    assert.equal(resp.content, "hello world");
    assert.equal(resp.model, "test-model");
    assert.equal(resp.finishReason, "stop");
    assert.equal(resp.usage?.totalTokens, 6);
    assert.equal(typeof resp.latencyMs, "number");
  }
});

// ---------------------------------------------------------------------------
// structured-output
// ---------------------------------------------------------------------------

test("structured-output: schema accepts a valid analysis", () => {
  const ok = MemoryAnalysisSchema.safeParse({
    summary: "ok",
    confidence: 0.5,
    tags: ["a", "b"],
  });
  assert.equal(ok.success, true);
});

test("structured-output: schema rejects out-of-range confidence", () => {
  const bad = MemoryAnalysisSchema.safeParse({
    summary: "ok",
    confidence: 1.5,
    tags: [],
  });
  assert.equal(bad.success, false);
});

test("structured-output: parser accepts raw JSON object", () => {
  const text = JSON.stringify({
    summary: "raw ok",
    confidence: 0.7,
    tags: ["x"],
  });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "raw");
});

test("structured-output: parser accepts a fenced JSON block", () => {
  const text =
    "Here you go:\n```json\n" +
    JSON.stringify({ summary: "fenced ok", confidence: 0.5, tags: ["t"] }) +
    "\n```\nDone.";
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "fenced");
});

test("structured-output: parser accepts a balanced object inside prose", () => {
  const obj = { summary: "balanced", confidence: 0.2, tags: [] };
  const text = `Some prose. ${JSON.stringify(obj)} More prose.`;
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, "balanced");
});

test("structured-output: parser reports schema errors with details", () => {
  const text = JSON.stringify({ summary: "x", confidence: 2, tags: "not-an-array" });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("structured-output: parser accepts strict-mode shape with null optional fields", () => {
  // Groq strict json_schema always emits `entities` and `classification`,
  // but marks them `nullable: true`. The model returns `null` when
  // there is nothing to report. The parser must translate that into
  // the zod schema's optional/empty defaults rather than fail.
  const text = JSON.stringify({
    summary: "strict mode ok",
    confidence: 0.6,
    tags: ["t"],
    entities: null,
    classification: null,
  });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true, `errors: ${r.errors.join("; ")}`);
  assert.equal(r.repaired, false, "normalization is not a textual repair");
  // `entities: null` becomes the zod default: an empty array.
  assert.deepEqual(r.value?.entities, []);
  // `classification: null` is treated as absent: the key is removed
  // so the zod `optional()` field stays `undefined`.
  assert.equal(
    r.value?.classification,
    undefined,
    "classification: null becomes absent",
  );
});

test("structured-output: parser normalizes only entities: null", () => {
  const text = JSON.stringify({
    summary: "ok",
    confidence: 0.5,
    tags: [],
    entities: null,
    classification: "preference",
  });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true, `errors: ${r.errors.join("; ")}`);
  assert.deepEqual(r.value?.entities, []);
  assert.equal(r.value?.classification, "preference");
});

test("structured-output: parser normalizes only classification: null", () => {
  const text = JSON.stringify({
    summary: "ok",
    confidence: 0.5,
    tags: ["a"],
    entities: [{ name: "Alice", kind: "person" }],
    classification: null,
  });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, true, `errors: ${r.errors.join("; ")}`);
  assert.deepEqual(r.value?.entities, [{ name: "Alice", kind: "person" }]);
  assert.equal(r.value?.classification, undefined);
});

test("structured-output: parser still rejects a non-null invalid entity", () => {
  // `entities: "not-an-array"` is not `null` and not absent, so the
  // schema must still reject it. The normalization pass must not
  // silently turn invalid shapes into valid ones.
  const text = JSON.stringify({
    summary: "ok",
    confidence: 0.5,
    tags: [],
    entities: "not-an-array",
    classification: null,
  });
  const r = parseMemoryAnalysis(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("entities:")), "expected entities error");
});

test("structured-output: parser returns clean error on empty input", () => {
  const r = parseMemoryAnalysis("");
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["empty response"]);
});

test("structured-output: buildStructuredPrompt wraps input as JSON string", () => {
  const p = buildStructuredPrompt("hello");
  assert.match(p, /INPUT:/);
  assert.match(p, /hello/);
  assert.match(p, /"summary": string/);
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

test("fixtures: P1..P6 are present with non-empty text", () => {
  const ids = PROTOTYPE_FIXTURES.map((f) => f.id);
  assert.deepEqual(ids, ["P1", "P2", "P3", "P4", "P5", "P6"]);
  for (const f of PROTOTYPE_FIXTURES) {
    assert.equal(typeof f.text, "string");
    assert.ok(f.text.length > 0, `text for ${f.id}`);
    assert.ok(f.description.length > 0, `description for ${f.id}`);
  }
});

test("fixtures: lookup by id returns the right entry", () => {
  assert.equal(fixtureById("P3")?.id, "P3");
  assert.equal(fixtureById("nope"), undefined);
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

test("runner: parseCli defaults to dry-run and recognizes flags", () => {
  const a = parseCli([]);
  assert.equal(a.live, false);
  const b = parseCli(["--live"]);
  assert.equal(b.live, true);
  const c = parseCli([
    "--only-provider",
    "minimax,nvidia-nim",
    "--only-fixture",
    "P1,P2",
    "--only-nim-model",
    "openai/gpt-oss-120b",
    "--artifacts",
    "/tmp/x",
    "--max-tokens",
    "2048",
  ]);
  assert.deepEqual(c.onlyProviders, ["minimax", "nvidia-nim"]);
  assert.deepEqual(c.onlyFixtures, ["P1", "P2"]);
  assert.deepEqual(c.onlyNimModels, ["openai/gpt-oss-120b"]);
  assert.equal(c.artifactsDir, "/tmp/x");
  assert.equal(c.maxTokens, 2048);
});

test("runner: parseCli throws on --max-tokens with bad value", () => {
  assert.throws(() => parseCli(["--max-tokens", "abc"]), /--max-tokens/);
  assert.throws(() => parseCli(["--max-tokens", "0"]), /--max-tokens/);
  assert.throws(() => parseCli(["--max-tokens", "-3"]), /--max-tokens/);
});

test("runner: parseCli throws on unknown flags", () => {
  assert.throws(() => parseCli(["--bogus"]), /unknown argument/);
});

test("runner: dry-run makes no network calls and reports a plan", async () => {
  // We assert "no network" by NOT providing a fetchImpl and not setting
  // any keys. If the runner attempted a fetch, this test would time out
  // or throw a network error. `dotenvSkip: true` keeps the test
  // independent of any `.env` in the current working directory.
  const before = { ...process.env };
  try {
    delete process.env.CURION_PROVIDER_PRIMARY_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CURION_PROVIDER_FALLBACK_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.GROQ_API_KEY;
    const report = await runExperiments({
      live: false,
      onlyFixtures: ["P1"],
      dotenvSkip: true,
    });
    assert.equal(report.mode, "dry-run");
    // 1 minimax + 2 NIM (two candidate models) + 1 groq = 4.
    assert.equal(report.summary.total, 4);
    // In dry-run, attempts are not actually parsed, so parsed=0.
    assert.equal(report.summary.parsed, 0);
    assert.equal(report.summary.skipped, 0);
    // No attempt should carry an error in dry-run.
    for (const a of report.attempts) {
      assert.equal(a.error, undefined, `unexpected error in dry-run: ${JSON.stringify(a)}`);
    }
    // Default dry-run includes all three providers.
    const providers = new Set(report.attempts.map((a) => a.provider));
    assert.ok(providers.has("minimax"), "minimax attempt missing");
    assert.ok(providers.has("nvidia-nim"), "nvidia-nim attempt missing");
    assert.ok(providers.has("groq"), "groq attempt missing");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: live mode without keys yields missing-config errors (no network)", async () => {
  const before = { ...process.env };
  try {
    delete process.env.CURION_PROVIDER_PRIMARY_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CURION_PROVIDER_FALLBACK_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.GROQ_API_KEY;
    const report = await runExperiments({
      live: true,
      onlyProviders: ["minimax", "nvidia-nim"],
      onlyFixtures: ["P1"],
      onlyNimModels: ["openai/gpt-oss-120b"],
      dotenvSkip: true,
    });
    assert.equal(report.mode, "live");
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.skipped, 2);
    for (const a of report.attempts) {
      assert.equal(a.error?.kind, "missing-config");
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: live mode with stubbed fetch parses a model response", async () => {
  const before = { ...process.env };
  try {
    process.env.CURION_PROVIDER_PRIMARY_KEY = "sk-test-not-real";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "nvapi-test-not-real";
    const valid = JSON.stringify({
      summary: "stubbed",
      confidence: 0.9,
      tags: ["a"],
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [
            { message: { role: "assistant", content: "```json\n" + valid + "\n```" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["minimax"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(report.summary.parsed, 1);
    assert.equal(report.summary.parseFailed, 0);
    const attempt: ProviderAttempt = report.attempts[0]!;
    assert.equal(attempt.ok, true);
    assert.equal(attempt.parse.strategy, "fenced");
    assert.equal(attempt.parse.value?.summary, "stubbed");
    // No raw prompt is in the report; only a snippet.
    assert.equal(typeof attempt.rawSnippet, "string");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: live mode with stubbed fetch that returns fenced-but-broken JSON applies one repair", async () => {
  const before = { ...process.env };
  try {
    process.env.CURION_PROVIDER_FALLBACK_KEY = "nvapi-test-not-real";
    // Trailing comma and stray fence: should be repaired.
    const broken = "```json\n{ \"summary\": \"rep\", \"confidence\": 0.4, \"tags\": [], }\n```";
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: broken } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["nvidia-nim"],
      onlyNimModels: ["meta/llama-3.3-70b-instruct"],
      onlyFixtures: ["P2"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(report.summary.parsed, 1);
    const attempt: ProviderAttempt = report.attempts[0]!;
    assert.equal(attempt.parse.repaired, true);
    assert.equal(attempt.repairsApplied, 1);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: report records maxTokens per attempt and in config", async () => {
  const before = { ...process.env };
  try {
    process.env.CURION_PROVIDER_PRIMARY_KEY = "sk-test-not-real";
    const valid = JSON.stringify({
      summary: "mt",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["minimax"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
      maxTokens: 2048,
    });
    assert.equal(report.config.maxTokens, 1024); // loader default
    const attempt: ProviderAttempt = report.attempts[0]!;
    assert.equal(attempt.maxTokens, 2048); // CLI override wins
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: report is sanitized — no API key value is present", async () => {
  const before = { ...process.env };
  try {
    const fakeKey = "sk-test-not-real-very-specific-value-12345";
    process.env.CURION_PROVIDER_PRIMARY_KEY = fakeKey;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"summary": "sanitized", "confidence": 0.5, "tags": []}',
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["minimax"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    const serialized = JSON.stringify(report);
    assert.ok(
      !serialized.includes(fakeKey),
      "report JSON must not contain the API key value",
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: resolveArtifactsDir creates the directory if missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-art-"));
  const target = path.join(tmp, "deep", "nested", "artifacts");
  try {
    const cfg = loadPrototypeConfig({ skip: true });
    const dir = resolveArtifactsDir(cfg, { artifactsDir: target, live: false, dotenvSkip: true });
    assert.equal(dir, target);
    assert.ok(fs.existsSync(target));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runner: formatHumanReport mentions every provider and fixture in dry-run", async () => {
  const before = { ...process.env };
  try {
    delete process.env.CURION_PROVIDER_PRIMARY_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CURION_PROVIDER_FALLBACK_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.GROQ_API_KEY;
    const report = await runExperiments({ live: false, dotenvSkip: true });
    const cfg = loadPrototypeConfig({ skip: true });
    const text = formatHumanReport(report, cfg);
    assert.match(text, /mode:\s+dry-run/);
    // All three providers should appear in the per-provider summary.
    assert.match(text, /minimax\//);
    assert.match(text, /nvidia-nim\//);
    assert.match(text, /groq\//);
    // The configured max tokens line is part of the human report.
    assert.match(text, /max tokens:\s+\d+/);
    // All six fixtures.
    for (const f of PROTOTYPE_FIXTURES) {
      assert.match(text, new RegExp(`\\[${f.id}\\]`));
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: dry-run default also works when dotenv is present and loaded", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-cwd-"));
  const before = { ...process.env };
  const beforeCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tmp, ".env"),
      [
        "# placeholder env, no real keys",
        "CURION_LOG_LEVEL=info",
        "MINIMAX_API_KEY=sk-test-not-real-very-specific-value-12345",
        "NVIDIA_NIM_API_KEY=nvapi-test-not-real-very-specific-value-12345",
        "CURION_NIM_MODELS=openai/gpt-oss-120b,meta/llama-3.3-70b-instruct",
      ].join("\n"),
    );
    process.chdir(tmp);
    const report = await runExperiments({
      live: false,
      onlyProviders: ["minimax", "nvidia-nim"],
      onlyFixtures: ["P1"],
    });
    // 1 minimax + 2 NIM = 3 attempts.
    assert.equal(report.summary.total, 3);
    // Sanity: the report must not contain the secret value we put in .env.
    assert.ok(!JSON.stringify(report).includes("sk-test-not-real-very-specific-value-12345"));
  } finally {
    process.chdir(beforeCwd);
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Groq (prototype comparison candidate)
// ---------------------------------------------------------------------------

const GROQ_ENV_KEYS = [
  "GROQ_API_KEY",
  "CURION_GROQ_BASE_URL",
  "CURION_GROQ_MODEL",
  "CURION_GROQ_REASONING_EFFORT",
];

function withCleanGroqEnv<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const before: Record<string, string | undefined> = {};
  for (const k of GROQ_ENV_KEYS) before[k] = process.env[k];
  for (const k of GROQ_ENV_KEYS) delete process.env[k];
  return Promise.resolve(fn()).finally(() => {
    for (const k of GROQ_ENV_KEYS) {
      const v = before[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("env-loader: GROQ_API_KEY is in the secret set and is redacted", () => {
  assert.ok(SECRET_ENV_VARS.includes("GROQ_API_KEY"));
  assert.equal(isSecretEnvVar("GROQ_API_KEY"), true);
  // Generic non-namespaced alias used at runtime.
  const r = redactValue("GROQ_API_KEY", "gsk_abcdefghijklmnopqrstuvwxyz1234567890");
  assert.notEqual(r, "gsk_abcdefghijklmnopqrstuvwxyz1234567890");
  assert.ok(r.startsWith("gs"));
  assert.ok(r.endsWith("90"));
  assert.match(r, /\*{4,}/);
  // describeEnv masks the value too.
  const out = describeEnv({ GROQ_API_KEY: "gsk_abcdefghijklmnopqrstuvwxyz1234567890" });
  assert.notEqual(out.GROQ_API_KEY, "gsk_abcdefghijklmnopqrstuvwxyz1234567890");
});

test("env-loader: loadPrototypeConfig exposes Groq presence and config with documented defaults", () => {
  return withCleanGroqEnv(() => {
    // No GROQ_API_KEY set: presence flag is false, defaults are used.
    const cfg = loadPrototypeConfig({ skip: true });
    assert.equal(cfg.hasGroqKey, false);
    assert.equal(cfg.groqBaseUrl, "https://api.groq.com/openai/v1");
    assert.equal(cfg.groqModel, "openai/gpt-oss-120b");
    assert.equal(cfg.groqReasoningEffort, "high");
    // When the key is set, the presence flag flips. The value is
    // never exposed in the config object.
    process.env.GROQ_API_KEY = "gsk_test_not_real_1234567890abcdef";
    const cfg2 = loadPrototypeConfig({ skip: true });
    assert.equal(cfg2.hasGroqKey, true);
    // No property on the config carries the key value.
    assert.equal(
      JSON.stringify(cfg2).includes("gsk_test_not_real_1234567890abcdef"),
      false,
    );
  });
});

test("env-loader: Groq env overrides are respected and trimmed", () => {
  return withCleanGroqEnv(() => {
    process.env.GROQ_API_KEY = "  gsk_test  \n";
    process.env.CURION_GROQ_BASE_URL = "  https://proxy.test/v1  ";
    process.env.CURION_GROQ_MODEL = "  openai/gpt-oss-20b  ";
    process.env.CURION_GROQ_REASONING_EFFORT = "  low  ";
    const cfg = loadPrototypeConfig({ skip: true });
    assert.equal(cfg.hasGroqKey, true);
    assert.equal(cfg.groqBaseUrl, "https://proxy.test/v1");
    assert.equal(cfg.groqModel, "openai/gpt-oss-20b");
    assert.equal(cfg.groqReasoningEffort, "low");
  });
});

test("env-loader: whitespace-only Groq env values fall back to defaults", () => {
  return withCleanGroqEnv(() => {
    process.env.CURION_GROQ_BASE_URL = "   ";
    process.env.CURION_GROQ_MODEL = "\t";
    process.env.CURION_GROQ_REASONING_EFFORT = "  \n  ";
    const cfg = loadPrototypeConfig({ skip: true });
    assert.equal(cfg.groqBaseUrl, "https://api.groq.com/openai/v1");
    assert.equal(cfg.groqModel, "openai/gpt-oss-120b");
    assert.equal(cfg.groqReasoningEffort, "high");
  });
});

test("structured-output: MEMORY_ANALYSIS_JSON_SCHEMA is strict-mode compatible", () => {
  // Groq strict-mode rules (mirroring OpenAI's strict-schema rules):
  //   - top-level object sets additionalProperties: false
  //   - every property is listed in required
  //   - nested objects also set additionalProperties: false
  //   - optional fields are nullable and still listed in required
  const top = MEMORY_ANALYSIS_JSON_SCHEMA;
  assert.equal(top.type, "object");
  assert.equal(top.additionalProperties, false);
  const props = top.properties as Record<string, unknown>;
  const required = top.required as string[];
  assert.deepEqual(
    [...required].sort(),
    [...Object.keys(props)].sort(),
    "every property must be in required",
  );
  // Optional fields are expressed as nullable.
  for (const optional of ["entities", "classification"]) {
    const p = props[optional] as Record<string, unknown>;
    assert.equal(p.nullable, true, `${optional} must be nullable in strict mode`);
  }
  // Nested entity object is also strict.
  const entities = props.entities as Record<string, unknown>;
  const entityItems = entities.items as Record<string, unknown>;
  assert.equal(entityItems.additionalProperties, false);
  const entityRequired = entityItems.required as string[];
  const entityProps = entityItems.properties as Record<string, unknown>;
  assert.deepEqual(
    [...entityRequired].sort(),
    [...Object.keys(entityProps)].sort(),
  );
});

test("http-client: buildResponseFormat maps json_object and text", () => {
  assert.deepEqual(buildResponseFormat("json_object"), { type: "json_object" });
  assert.deepEqual(buildResponseFormat("text"), { type: "text" });
});

test("http-client: buildResponseFormat emits strict json_schema payload for Groq", () => {
  const schema = MEMORY_ANALYSIS_JSON_SCHEMA;
  const out = buildResponseFormat({
    kind: "json_schema",
    schema,
    strict: true,
    name: "memory_analysis",
  });
  assert.equal(out.type, "json_schema");
  const inner = out.json_schema as Record<string, unknown>;
  assert.equal(inner.strict, true);
  assert.equal(inner.name, "memory_analysis");
  assert.equal(inner.schema, schema);
});

test("http-client: buildResponseFormat defaults the schema name when not provided", () => {
  const out = buildResponseFormat({
    kind: "json_schema",
    schema: MEMORY_ANALYSIS_JSON_SCHEMA,
    strict: true,
  });
  const inner = out.json_schema as Record<string, unknown>;
  assert.equal(inner.name, "response");
  assert.equal(inner.strict, true);
});

test("runner: --only-provider groq restricts the matrix to one provider per fixture", async () => {
  const before = { ...process.env };
  try {
    delete process.env.CURION_PROVIDER_PRIMARY_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CURION_PROVIDER_FALLBACK_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    delete process.env.GROQ_API_KEY;
    const report = await runExperiments({
      live: false,
      onlyProviders: ["groq"],
      dotenvSkip: true,
    });
    // 6 fixtures * 1 Groq attempt = 6.
    assert.equal(report.summary.total, 6);
    const providers = new Set(report.attempts.map((a) => a.provider));
    assert.deepEqual([...providers], ["groq"]);
    for (const a of report.attempts) {
      assert.equal(a.model, "openai/gpt-oss-120b");
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: parseCli accepts groq in --only-provider and recognizes Groq-only flags", () => {
  const a = parseCli([
    "--only-provider",
    "minimax,groq",
    "--groq-reasoning-effort",
    "low",
  ]);
  assert.deepEqual(a.onlyProviders, ["minimax", "groq"]);
  assert.equal(a.groqReasoningEffortOverride, "low");
  const b = parseCli(["--only-provider", "groq", "--no-groq-strict-schema"]);
  assert.deepEqual(b.onlyProviders, ["groq"]);
  assert.equal(b.groqDisableStrictJsonSchema, true);
});

test("runner: live mode with Groq key sends model + reasoning_effort + strict json_schema, no key in body", async () => {
  const before = { ...process.env };
  try {
    process.env.GROQ_API_KEY = "gsk-test-not-real-very-specific-value-12345";
    const log: { body?: string; url?: string } = {};
    const valid = JSON.stringify({
      summary: "groq ok",
      confidence: 0.7,
      tags: ["t"],
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      log.url = typeof _url === "string" ? _url : (_url as URL).toString();
      log.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: "x",
          model: "openai/gpt-oss-120b",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(report.summary.parsed, 1);
    assert.equal(report.summary.skipped, 0);
    assert.ok(log.body, "request body must be recorded");
    // Key is NOT in the body.
    assert.ok(
      !log.body!.includes("gsk-test-not-real-very-specific-value-12345"),
      "api key must not appear in request body",
    );
    // URL is the Groq OpenAI-compatible base.
    assert.match(log.url!, /^https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions/);
    const parsed = JSON.parse(log.body!);
    // Model id is sent.
    assert.equal(parsed.model, "openai/gpt-oss-120b");
    // reasoning_effort is sent (default "high").
    assert.equal(parsed.reasoning_effort, "high");
    // Strict json_schema response_format is present.
    assert.equal(parsed.response_format?.type, "json_schema");
    assert.equal(parsed.response_format?.json_schema?.strict, true);
    assert.ok(parsed.response_format?.json_schema?.schema, "schema present");
    assert.equal(parsed.response_format?.json_schema?.name, "memory_analysis");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: Groq live stub with strict json_schema and null optional fields parses ok", async () => {
  // Strict json_schema forces the model to always emit `entities` and
  // `classification`, and marks them `nullable: true`. When there is
  // nothing to report, the model returns `null`. The parser must
  // accept that shape (translating `null` into the zod defaults) so
  // the runner reports `ok: true` and a normalized value, not a
  // parse failure.
  const before = { ...process.env };
  try {
    process.env.GROQ_API_KEY = "gsk-test-not-real-very-specific-value-12345";
    const log: { body?: string } = {};
    const strictNullPayload = JSON.stringify({
      summary: "strict nulls ok",
      confidence: 0.8,
      tags: ["x"],
      entities: null,
      classification: null,
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      log.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: "x",
          model: "openai/gpt-oss-120b",
          choices: [{ message: { role: "assistant", content: strictNullPayload } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(report.summary.parsed, 1, `summary: ${JSON.stringify(report.summary)}`);
    assert.equal(report.summary.parseFailed, 0);
    const attempt = report.attempts[0]!;
    assert.equal(attempt.ok, true, `errors: ${attempt.parse.errors.join("; ")}`);
    assert.equal(attempt.parse.repaired, false, "null normalization is not a textual repair");
    assert.equal(attempt.responseFormatType, "json_schema");
    // Normalized value: entities defaulted to [], classification absent.
    assert.deepEqual(attempt.parse.value?.entities, []);
    assert.equal(attempt.parse.value?.classification, undefined);
    // The request body still used the strict json_schema payload.
    const sent = JSON.parse(log.body!);
    assert.equal(sent.response_format?.type, "json_schema");
    assert.equal(sent.response_format?.json_schema?.strict, true);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: Groq attempt reports responseFormatType=json_schema and reasoning_effort in the attempt metadata", async () => {
  const before = { ...process.env };
  try {
    process.env.GROQ_API_KEY = "gsk-test-not-real-1234567890";
    process.env.CURION_GROQ_REASONING_EFFORT = "medium";
    const valid = JSON.stringify({
      summary: "ok",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    const attempt = report.attempts[0]!;
    assert.equal(attempt.responseFormatType, "json_schema");
    assert.equal(attempt.reasoningEffort, "medium");
    // Report config also carries the resolved groq effort.
    assert.equal(report.config.groqReasoningEffort, "medium");
    assert.equal(report.config.hasGroqKey, true);
    assert.equal(report.config.groqBaseUrl, "https://api.groq.com/openai/v1");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: Groq --no-groq-strict-schema drops the schema payload but keeps reasoning_effort", async () => {
  const before = { ...process.env };
  try {
    process.env.GROQ_API_KEY = "gsk-test-not-real-1234567890";
    const log: { body?: string } = {};
    const valid = JSON.stringify({
      summary: "ok",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      log.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
      groqDisableStrictJsonSchema: true,
    });
    const attempt = report.attempts[0]!;
    assert.equal(attempt.responseFormatType, "json_object");
    assert.equal(attempt.reasoningEffort, "high");
    const parsed = JSON.parse(log.body!);
    assert.equal(parsed.response_format?.type, "json_object");
    // No json_schema payload is sent.
    assert.equal(parsed.response_format?.json_schema, undefined);
    // reasoning_effort is still forwarded.
    assert.equal(parsed.reasoning_effort, "high");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: empty --groq-reasoning-effort omits the param from the request body", async () => {
  const before = { ...process.env };
  try {
    process.env.GROQ_API_KEY = "gsk-test-not-real-1234567890";
    const log: { body?: string } = {};
    const valid = JSON.stringify({
      summary: "ok",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      log.body = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
      groqReasoningEffortOverride: "",
    });
    const parsed = JSON.parse(log.body!);
    assert.equal(parsed.reasoning_effort, undefined);
    // Strict json_schema is still used.
    assert.equal(parsed.response_format?.type, "json_schema");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: MiniMax and NIM requests do NOT include reasoning_effort", async () => {
  const before = { ...process.env };
  try {
    process.env.CURION_PROVIDER_PRIMARY_KEY = "sk-test-not-real-1234567890";
    process.env.CURION_PROVIDER_FALLBACK_KEY = "nvapi-test-not-real-1234567890";
    const log: Array<{ url: string; body: string }> = [];
    const valid = JSON.stringify({
      summary: "ok",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async (_url, init) => {
      const url = typeof _url === "string" ? _url : (_url as URL).toString();
      const body = typeof init?.body === "string" ? init.body : "";
      log.push({ url, body });
      return new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await runExperiments({
      live: true,
      onlyProviders: ["minimax", "nvidia-nim"],
      onlyNimModels: ["openai/gpt-oss-120b"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(log.length, 2);
    for (const entry of log) {
      const parsed = JSON.parse(entry.body);
      assert.equal(
        parsed.reasoning_effort,
        undefined,
        `reasoning_effort leaked to ${entry.url}`,
      );
      // The legacy non-Groq path still uses response_format: json_object.
      assert.equal(parsed.response_format?.type, "json_object");
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: Groq sanitized report excludes the Groq key value", async () => {
  const before = { ...process.env };
  try {
    const fakeKey = "gsk-groq-test-not-real-very-specific-value-12345";
    process.env.GROQ_API_KEY = fakeKey;
    const valid = JSON.stringify({
      summary: "ok",
      confidence: 0.5,
      tags: [],
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: "x",
          model: "m",
          choices: [{ message: { role: "assistant", content: valid } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    const serialized = JSON.stringify(report);
    assert.ok(
      !serialized.includes(fakeKey),
      "Groq key value must not appear anywhere in the report",
    );
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: Groq attempts with missing key yield clean missing-config (no network)", async () => {
  const before = { ...process.env };
  try {
    delete process.env.GROQ_API_KEY;
    let called = 0;
    const fetchImpl: typeof fetch = async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    };
    const report = await runExperiments({
      live: true,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      fetchImpl,
      dotenvSkip: true,
    });
    assert.equal(called, 0, "fetch must not be called when the key is missing");
    assert.equal(report.summary.skipped, 1);
    const attempt = report.attempts[0]!;
    assert.equal(attempt.error?.kind, "missing-config");
    assert.equal(attempt.responseFormatType, "json_schema");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});

test("runner: dry-run Groq attempts still carry the planned responseFormatType and reasoning_effort", async () => {
  const before = { ...process.env };
  try {
    delete process.env.GROQ_API_KEY;
    process.env.CURION_GROQ_REASONING_EFFORT = "low";
    const report = await runExperiments({
      live: false,
      onlyProviders: ["groq"],
      onlyFixtures: ["P1"],
      dotenvSkip: true,
    });
    const attempt = report.attempts[0]!;
    assert.equal(attempt.provider, "groq");
    assert.equal(attempt.responseFormatType, "json_schema");
    // Reasoning effort is metadata that the runner records per-attempt
    // even in dry-run, so the report preview is honest.
    assert.equal(attempt.reasoningEffort, "low");
    assert.equal(report.config.groqReasoningEffort, "low");
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in before)) delete process.env[k];
    }
    Object.assign(process.env, before);
  }
});
