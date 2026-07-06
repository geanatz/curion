/**
 * Tests for the shared benchmark helpers:
 *
 *   - `src/benchmark/_artifact.ts`
 *   - `src/benchmark/_cli.ts`
 *   - `src/benchmark/_scripted-fetch.ts`
 *
 * These helpers back the decision-policy and adaptive-depth
 * benchmark runners. The per-runner suites
 * (`tests/decision-policy-evaluation.test.ts`,
 * `tests/adaptive-depth-evaluation.test.ts`) already cover
 * the migration through the public surface (CLI parser,
 * artifact writer, scripted fetch). This file pins the
 * helper-level contract:
 *
 *   - `defaultBenchmarkArtifactsDir()` returns
 *     `<cwd>/.curion/benchmark`.
 *
 *   - `isoStampForFilename(date)` produces a shell-safe
 *     ISO timestamp with `:` / `.` replaced by `-`.
 *
 *   - `writeTimestampedJsonArtifact(report, dir, prefix)`
 *     creates the dir if missing, writes the JSON
 *     artifact, and returns the absolute path. The
 *     filename uses the documented `<prefix>-<stamp>.json`
 *     pattern.
 *
 *   - `parseBenchmarkArtifactCli` accepts `--artifacts`,
 *     and (when opted in) `--no-write` / `--no-stdout`;
 *     unknown flags throw with the runner's context
 *     label.
 *
 *   - `recordScriptedFetchCall` / `buildRecordingScriptedFetch`
 *     record the URL + body of every fetch call and
 *     delegate the response to the responder.
 *
 *   - `okChatResponse(content)` produces the canonical
 *     200 chat-completions response shape.
 *
 *   - `upstreamFailureResponse()` produces the canonical
 *     503 upstream-failure response shape.
 *
 * Why this is a separate file:
 *
 *   The helpers are shared between two runners; if a
 *   reviewer changes the helpers' contract, both runners
 *   pick up the change. The per-runner suites prove the
 *   runner-side behaviour; this file proves the helper
 *   contracts the runners rely on.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultBenchmarkArtifactsDir,
  isoStampForFilename,
  writeTimestampedJsonArtifact,
} from "../src/benchmark/_artifact.ts";
import { parseBenchmarkArtifactCli } from "../src/benchmark/_cli.ts";
import {
  buildRecordingScriptedFetch,
  okChatResponse,
  recordScriptedFetchCall,
  upstreamFailureResponse,
} from "../src/benchmark/_scripted-fetch.ts";

// ---------------------------------------------------------------------------
// 1. _artifact.ts
// ---------------------------------------------------------------------------

test("benchmark helpers: defaultBenchmarkArtifactsDir returns <cwd>/.curion/benchmark", () => {
  assert.equal(
    defaultBenchmarkArtifactsDir("/tmp/foo"),
    path.join("/tmp/foo", ".curion", "benchmark")
  );
  // The default cwd call uses process.cwd(). The shape
  // (suffix `.curion/benchmark`) is what the runner tests
  // assert against; we check the suffix so the test is
  // cwd-independent.
  assert.ok(defaultBenchmarkArtifactsDir().endsWith(".curion/benchmark"));
});

test("benchmark helpers: isoStampForFilename replaces ':' and '.' so the filename is shell-safe", () => {
  const stamp = isoStampForFilename(new Date("2025-01-02T03:04:05.678Z"));
  // No colons or periods; safe across shells.
  assert.ok(!stamp.includes(":"));
  assert.ok(!stamp.includes("."));
  // The non-punctuation parts survive intact so the stamp
  // is still recognisable as an ISO timestamp.
  assert.match(stamp, /2025-01-02T03-04-05-678Z/);
});

test("benchmark helpers: writeTimestampedJsonArtifact creates the dir, writes JSON, returns the absolute path", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-bench-artifact-test-"));
  try {
    const report = { hello: "world", nested: { a: 1 }, list: [1, 2, 3] };
    const file = writeTimestampedJsonArtifact(report, tmp, "test-prefix");
    // Absolute path under the temp dir.
    assert.ok(path.isAbsolute(file));
    assert.ok(file.startsWith(tmp));
    // Filename uses the documented pattern.
    assert.match(path.basename(file), /^test-prefix-\d{4}-\d{2}-\d{2}T/);
    // The written bytes are valid JSON with a 2-space indent.
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, report);
    assert.ok(raw.includes('\n  "hello"'), "JSON output uses a 2-space indent");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("benchmark helpers: writeTimestampedJsonArtifact creates a missing nested target directory", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "curion-bench-artifact-nested-"));
  try {
    const dir = path.join(parent, "deep", "nested", "benchmark");
    const file = writeTimestampedJsonArtifact({ ok: true }, dir, "test-prefix");
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("benchmark helpers: isoStampForFilename produces distinct stamps for distinct dates", () => {
  // The stamp is the only thing that distinguishes two
  // artifacts written to the same prefix. We assert the
  // stamp varies by date so a reviewer reading the
  // helper sees the contract.
  const a = isoStampForFilename(new Date("2025-01-02T03:04:05.678Z"));
  const b = isoStampForFilename(new Date("2025-01-02T03:04:05.679Z"));
  const c = isoStampForFilename(new Date("2025-06-07T08:09:10.111Z"));
  assert.notEqual(a, b, "stamps differ by millisecond");
  assert.notEqual(a, c, "stamps differ by date");
  // All are shell-safe.
  for (const s of [a, b, c]) {
    assert.ok(!s.includes(":"));
    assert.ok(!s.includes("."));
  }
});

// ---------------------------------------------------------------------------
// 2. _cli.ts
// ---------------------------------------------------------------------------

test("benchmark helpers: parseBenchmarkArtifactCli returns the safe default with no args", () => {
  const parsed = parseBenchmarkArtifactCli([], {
    defaultArtifactsDir: "/tmp/safe-default",
  });
  assert.equal(parsed.artifactsDir, "/tmp/safe-default");
  assert.equal(parsed.noWrite, false);
  assert.equal(parsed.noStdout, false);
});

test("benchmark helpers: parseBenchmarkArtifactCli accepts --artifacts <path>", () => {
  const parsed = parseBenchmarkArtifactCli(["--artifacts", "/tmp/override"], {
    defaultArtifactsDir: "/tmp/safe-default",
  });
  assert.equal(parsed.artifactsDir, "/tmp/override");
});

test("benchmark helpers: parseBenchmarkArtifactCli rejects unknown flags with the context label", () => {
  assert.throws(
    () =>
      parseBenchmarkArtifactCli(["--bogus"], {
        contextLabel: "decision-policy evaluation",
      }),
    /unknown decision-policy evaluation cli flag: "--bogus"/
  );
  assert.throws(
    () =>
      parseBenchmarkArtifactCli(["--bogus"], {
        contextLabel: "adaptive-depth evaluation",
      }),
    /unknown adaptive-depth evaluation cli flag: "--bogus"/
  );
});

test("benchmark helpers: parseBenchmarkArtifactCli rejects --no-write when not opted in", () => {
  // Default: noWrite is NOT supported (opt-in only).
  assert.throws(
    () => parseBenchmarkArtifactCli(["--no-write"], { contextLabel: "test" }),
    /unknown test cli flag: "--no-write"/
  );
});

test("benchmark helpers: parseBenchmarkArtifactCli rejects --no-stdout when not opted in", () => {
  assert.throws(
    () => parseBenchmarkArtifactCli(["--no-stdout"], { contextLabel: "test" }),
    /unknown test cli flag: "--no-stdout"/
  );
});

test("benchmark helpers: parseBenchmarkArtifactCli accepts --no-write and --no-stdout when opted in", () => {
  const parsed = parseBenchmarkArtifactCli(["--artifacts", "/tmp/x", "--no-write", "--no-stdout"], {
    defaultArtifactsDir: "/tmp/safe",
    supportNoWrite: true,
    supportNoStdout: true,
    contextLabel: "test",
  });
  assert.equal(parsed.artifactsDir, "/tmp/x");
  assert.equal(parsed.noWrite, true);
  assert.equal(parsed.noStdout, true);
});

test("benchmark helpers: parseBenchmarkArtifactCli uses the default cwd/.curion/benchmark when no override is supplied", () => {
  const parsed = parseBenchmarkArtifactCli([]);
  assert.ok(parsed.artifactsDir.endsWith(".curion/benchmark"));
});

// ---------------------------------------------------------------------------
// 3. _scripted-fetch.ts
// ---------------------------------------------------------------------------

test("benchmark helpers: okChatResponse returns a 200 chat-completions JSON response with the given content", async () => {
  const res = okChatResponse("hello world");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const parsed = (await res.json()) as {
    id: string;
    model: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(parsed.id, "x");
  assert.equal(parsed.model, "m");
  assert.equal(parsed.choices.length, 1);
  assert.equal(parsed.choices[0]!.message.role, "assistant");
  assert.equal(parsed.choices[0]!.message.content, "hello world");
});

test("benchmark helpers: upstreamFailureResponse returns a 503 with an error body", async () => {
  const res = upstreamFailureResponse();
  assert.equal(res.status, 503);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const parsed = (await res.json()) as { error: string };
  assert.equal(parsed.error, "upstream");
});

test("benchmark helpers: recordScriptedFetchCall extracts URL + body from string and URL inputs", () => {
  const fromString = recordScriptedFetchCall("https://api.example/v1/chat", {
    method: "POST",
    body: '{"hello":"world"}',
  });
  assert.equal(fromString.url, "https://api.example/v1/chat");
  assert.equal(fromString.body, '{"hello":"world"}');

  const url = new URL("https://api.example/v1/chat");
  const fromUrl = recordScriptedFetchCall(url, {
    method: "POST",
    body: "x",
  });
  assert.equal(fromUrl.url, "https://api.example/v1/chat");
  assert.equal(fromUrl.body, "x");

  // No body on init -> empty body string.
  const noBody = recordScriptedFetchCall("https://api.example/v1", {});
  assert.equal(noBody.url, "https://api.example/v1");
  assert.equal(noBody.body, "");
});

test("benchmark helpers: buildRecordingScriptedFetch records every call and delegates the response", async () => {
  const responses = ["first", "second", "third"];
  let callIdx = 0;
  const handle = buildRecordingScriptedFetch(() => {
    const content = responses[callIdx] ?? "fallback";
    callIdx += 1;
    return okChatResponse(content);
  });

  // Call 1: string URL + string body.
  const r1 = await handle.fetchImpl("https://api.example/v1/chat", {
    method: "POST",
    body: '{"q":1}',
  });
  assert.equal(r1.status, 200);
  const r1json = (await r1.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(r1json.choices[0]!.message.content, "first");

  // Call 2: URL instance.
  const r2 = await handle.fetchImpl(new URL("https://api.example/v2/chat"), {
    method: "POST",
    body: '{"q":2}',
  });
  const r2json = (await r2.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(r2json.choices[0]!.message.content, "second");

  // Call 3: no body.
  const r3 = await handle.fetchImpl("https://api.example/v3", {});
  const r3json = (await r3.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(r3json.choices[0]!.message.content, "third");

  // All three calls are recorded in order with the
  // resolved URLs + bodies.
  assert.equal(handle.calls.length, 3);
  assert.equal(handle.calls[0]!.url, "https://api.example/v1/chat");
  assert.equal(handle.calls[0]!.body, '{"q":1}');
  assert.equal(handle.calls[1]!.url, "https://api.example/v2/chat");
  assert.equal(handle.calls[1]!.body, '{"q":2}');
  assert.equal(handle.calls[2]!.url, "https://api.example/v3");
  assert.equal(handle.calls[2]!.body, "");
});

test("benchmark helpers: buildRecordingScriptedFetch delegates a 503 upstream failure through the responder", async () => {
  const handle = buildRecordingScriptedFetch(() => upstreamFailureResponse());
  const res = await handle.fetchImpl("https://api.example/v1", {});
  assert.equal(res.status, 503);
  assert.equal(handle.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 4. Migration: helper-shared shapes match the inlined benchmark shapes
// ---------------------------------------------------------------------------

test("benchmark helpers: okChatResponse byte shape is identical to the existing inlined benchmark shape", () => {
  // The decision-policy runner and the adaptive-depth
  // runner each used to define an inline response builder
  // with this exact JSON shape. The shared helper must
  // produce byte-equivalent output so the per-call bytes
  // the adapter sees are unchanged.
  const res = okChatResponse("hello");
  // `text()` is async; await it.
  return res.text().then((text) => {
    assert.equal(
      text,
      '{"id":"x","model":"m","choices":[{"message":{"role":"assistant","content":"hello"}}]}'
    );
  });
});

test("benchmark helpers: upstreamFailureResponse byte shape is identical to the existing inlined benchmark shape", () => {
  const res = upstreamFailureResponse();
  return res.text().then((text) => {
    assert.equal(text, '{"error":"upstream"}');
  });
});
