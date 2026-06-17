/**
 * Permanent tracked MCP stdio E2E test suite.
 *
 * Goal: exercise the real built MCP stdio server (`dist/index.js`)
 * over JSON-RPC and verify the public wire contract end-to-end.
 *
 * Why a real subprocess (not the in-process McpServer):
 *   - The stdio transport is the only transport the production
 *     entrypoint uses. The contracts in
 *     `tests/contracts.test.ts`, `tests/structured-content.test.ts`,
 *     `tests/strict-tool-input-schemas.test.ts`, and
 *     `tests/public-message-no-ids.test.ts` all drive the
 *     in-process `buildServer()` builder or the controllers
 *     directly. Those tests do not cover the JSON-RPC framing
 *     layer, the `initialize` handshake, the `tools/list` wire
 *     schema, or the stderr-only logging guarantee. This file
 *     closes that gap.
 *   - A regression in the stdio entrypoint, the logger's
 *     write-target, the SDK's input/output validation, the
 *     newline-delimited JSON framing, or the McpServer
 *     `registerCapabilities` path would slip past the
 *     in-process tests. This suite catches all of those.
 *
 * Local / offline / no-network guarantee:
 *   - The server is spawned in an isolated temp cwd so the
 *     project-local `.curion/` lives under that temp dir and
 *     the test does not touch the repo root, the developer's
 *     `.env`, or any real on-disk state.
 *   - The server's env is restricted to a known-safe set
 *     (PATH, HOME, TMPDIR, NODE_*); every CURION_* provider
 *     key is removed so the provider adapter short-circuits
 *     to `missing-config` and never opens a socket. The
 *     recall pipeline that needs to traverse the provider
 *     path is reached by pre-seeding a single memory row
 *     into the project's `.curion/curion.sqlite` *before*
 *     the server starts, so the controller's relevance
 *     ranking finds a hit and the provider is consulted
 *     — but the adapter's `missing-config` early-return
 *     means no network is ever contacted.
 *   - The pre-seeded memory uses a controller-safe
 *     summary that does not contain any secret-shaped
 *     fragment.
 *
 * Coverage scenarios (mapped to the user-approved list):
 *   1. `initialize` handshake returns server identity and
 *      capabilities (`serverInfo.name`, `serverInfo.version`,
 *      `capabilities.tools`, `protocolVersion`).
 *   2. `tools/list` returns exactly `remember` and `recall`.
 *   3. Both tools' `inputSchema` expose only `text`, with
 *      `required: ["text"]` and `additionalProperties: false`.
 *   4. Both tools' `outputSchema` are strict objects with a
 *      `status` enum covering every user-approved variant.
 *   5. `recall` against an empty DB returns text
 *      `"No relevant memory found."` and
 *      `structuredContent: { status: "no_memory" }`, with
 *      no ids, no `message` field, no `Note:` prefix.
 *   6. `recall` with a secret-shaped query returns text
 *      `"Rejected: ..."` and
 *      `structuredContent: { status: "rejected", reason }`,
 *      the secret fragment must not appear in the response,
 *      the `recall` provider must not be called (we assert
 *      by structural property: the `text` and `structured`
 *      surface both lack a `notes`/`answer` field).
 *   7. `recall` with an unknown extra top-level key is
 *      rejected at the SDK boundary with `isError: true`
 *      and no `structuredContent` payload.
 *   8. `remember` with a vague input returns
 *      `structuredContent: { status: "rejected", reason }`
 *      and no raw echo of the input.
 *   9. `remember` with an unknown extra top-level key is
 *      rejected at the SDK boundary with `isError: true`.
 *  10. stdout carries only newline-delimited JSON-RPC
 *      frames; all logging travels on stderr. We verify
 *      this by capturing both streams and asserting that
 *      the only stdout content is parseable JSON-RPC
 *      messages, while stderr contains at least one
 *      `[curion]` log line.
 *  11. Optional: `provider_error` path is reached by
 *      pre-seeding one memory row and querying for a
 *      term that matches the row's summary, in a
 *      no-API-key env. The provider adapter's
 *      `missing-config` short-circuit is local — no
 *      network — and the public surface is
 *      `structuredContent: { status: "provider_error",
 *      reason }`.
 *
 * Out of scope (covered by other suites):
 *   - The `answered` path on `recall` (requires a real
 *     provider; covered by `tests/structured-content.test.ts`
 *     via the in-process projection path and the
 *     scripted-fetch pattern).
 *   - The `saved` path on `remember` (same reason).
 *   - The `clarification_needed` path on `remember` (same).
 *
 * The tests are sequential within the file. They are
 * stable: no live network, no real API keys, and each
 * test cleans up its temp dir and its subprocess. The
 * cumulative runtime is bounded by the cold-start cost of
 * `node dist/index.js` (one process per test) plus the
 * JSON-RPC round-trips — well under a few seconds on a
 * developer laptop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { initStorage, insertMemoryRecord } from "../src/storage/storage.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

// ---------------------------------------------------------------------------
// JSON-RPC client helpers
// ---------------------------------------------------------------------------

/**
 * A single JSON-RPC message. We keep this minimal — only the
 * fields the test code reads. The server returns standard
 * `result` / `error` envelopes; notifications carry no `id`.
 */
type JsonRpcId = number | string;
type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

interface PendingRequest {
  resolve: (msg: JsonRpcMessage) => void;
  reject: (err: Error) => void;
}

/**
 * A connected MCP stdio client. Wraps a child process running
 * `dist/index.js`, frames writes as newline-delimited JSON,
 * and routes responses to the matching pending request by
 * `id`. Notifications (no `id`) are dispatched to a
 * notification handler. stderr is captured verbatim so the
 * suite can assert the "logs on stderr, not stdout"
 * invariant.
 */
class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private stdoutLines: string[] = [];
  private stderrChunks: string[] = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  private notificationHandler: ((msg: JsonRpcMessage) => void) | null = null;
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => this.handleStdoutLine(line));
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      this.stderrChunks.push(line);
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      // Reject any outstanding requests so the test sees a
      // clean failure instead of a hang.
      for (const [, p] of this.pending) {
        p.reject(new Error(
          `server exited before responding (code=${code}, signal=${signal})`,
        ));
      }
      this.pending.clear();
    });
    child.on("error", (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /**
   * Spawn the real built server in `cwd`, with `env` exposed
   * to the child. The default `env` strips every CURION_*
   * provider key so the test is hermetic.
   */
  static async start(opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    serverEntry?: string;
  }): Promise<StdioMcpClient> {
    const entry = opts.serverEntry ?? SERVER_ENTRY;
    if (!fs.existsSync(entry)) {
      throw new Error(
        `server entry not found at ${entry}; run \`npm run build\` first`,
      );
    }
    const env = opts.env ?? StdioMcpClient.isolatedEnv();
    const child = spawn(process.execPath, [entry], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioMcpClient(child);
    // Wait for the very first stderr line (the
    // `[curion] ... starting` info log) so we know the
    // server is up and listening on stdin. This is a
    // signal-only check; we do not block forever — if the
    // server never logs, the subsequent request will time
    // out and fail loudly.
    await client.waitForFirstStderrLine(5_000);
    return client;
  }

  /**
   * Build a hermetic env for the child: every CURION_*
   * provider key is removed so the provider adapter
   * short-circuits to `missing-config` and never opens
   * a socket. PATH / HOME / TMPDIR / NODE_* are kept so
   * `node` can resolve and load modules.
   */
  static isolatedEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // Strip every CURION_* key (project config), the
      // provider-specific aliases, and any key that
      // could enable a real network call.
      if (
        k === "CURION_PROVIDER_PRIMARY_KEY" ||
        k === "CURION_PROVIDER_FALLBACK_KEY" ||
        k === "MINIMAX_API_KEY" ||
        k === "NVIDIA_NIM_API_KEY" ||
        k === "GROQ_API_KEY" ||
        k === "CURION_PROJECT_ROOT" ||
        k === "CURION_LOG_LEVEL"
      ) {
        continue;
      }
      env[k] = v;
    }
    // Force a deterministic log level: `info` so the
    // cold-start `starting` line is emitted on stderr
    // (the test asserts stderr is non-empty).
    env.CURION_LOG_LEVEL = "info";
    return env;
  }

  onNotification(handler: (msg: JsonRpcMessage) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * Send a JSON-RPC request and resolve with the matching
   * response. Rejects on server exit, parse error, or
   * timeout. The server response is typed structurally —
   * we surface whatever JSON-RPC returned (including
   * `error` envelopes and notification echoes).
   */
  async request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<JsonRpcMessage> {
    if (this.closed) throw new Error("client is closed");
    const id = this.nextId++;
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const line = JSON.stringify(msg);
    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      const timeoutMs = opts.timeoutMs ?? 10_000;
      const t = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`request ${method} (id=${id}) timed out`));
        }
      }, timeoutMs);
      // Clear the timeout once the request resolves.
      const origResolve = this.pending.get(id)!.resolve;
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
          origResolve(m);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response
   * expected). Used to send `notifications/initialized`
   * after the `initialize` handshake.
   */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Send a `tools/call` request and return the
   * decoded result envelope. Throws on JSON-RPC
   * error envelopes; returns the raw `result` (the
   * `CallToolResult`) on success.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<{
    content: Array<{ type: string; text?: string; [k: string]: unknown }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [k: string]: unknown;
  }> {
    const resp = await this.request(
      "tools/call",
      { name, arguments: args },
      opts,
    );
    if (resp.error) {
      throw new Error(
        `tools/call ${name} returned JSON-RPC error ${resp.error.code}: ${resp.error.message}`,
      );
    }
    return resp.result as ReturnType<StdioMcpClient["callTool"]> extends Promise<infer T>
      ? T
      : never;
  }

  /** Read everything written to stdout so far. */
  stdoutSnapshot(): string {
    return this.stdoutLines.join("\n");
  }

  /** Read everything written to stderr so far. */
  stderrSnapshot(): string {
    return this.stderrChunks.join("\n");
  }

  /** Exit info, or null if the child is still running. */
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.exitInfo;
  }

  /**
   * Close the client: send EOF on stdin, wait for the
   * child to exit (or kill it after a short grace
   * period), and resolve. Safe to call multiple times.
   * The default grace period is short (1500 ms) so the
   * test's `finally` block can release the temp dir
   * quickly and avoid leftover WAL files in /tmp.
   */
  async close(opts: { killAfterMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const killAfterMs = opts.killAfterMs ?? 1_500;
    if (this.exitInfo === null) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = (): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          resolve();
        };
        const termTimer = setTimeout(() => {
          try {
            this.child.kill("SIGTERM");
          } catch {
            // ignore
          }
        }, killAfterMs);
        const killTimer = setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // ignore
          }
          finish();
        }, killAfterMs + 1_000);
        this.child.once("exit", () => {
          finish();
        });
      });
    }
  }

  private handleStdoutLine(line: string): void {
    if (line.length === 0) return;
    this.stdoutLines.push(line);
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch (err) {
      // Non-JSON line on stdout is a fatal protocol
      // violation. Reject all pending requests so the
      // test surfaces this loudly.
      const err2 = new Error(
        `server emitted non-JSON line on stdout: ${JSON.stringify(line.slice(0, 200))}`,
      );
      for (const [, p] of this.pending) p.reject(err2);
      this.pending.clear();
      throw err2;
    }
    if (parsed.id !== undefined) {
      const p = this.pending.get(parsed.id);
      if (p) {
        this.pending.delete(parsed.id);
        p.resolve(parsed);
      }
      // Unmatched ids are tolerated (the test only
      // cares that the protocol is well-formed).
    } else if (parsed.method) {
      this.notificationHandler?.(parsed);
    }
  }

  private async waitForFirstStderrLine(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.stderrChunks.length === 0) {
      if (this.exitInfo !== null) {
        throw new Error(
          `server exited before producing any stderr; code=${this.exitInfo.code}, signal=${this.exitInfo.signal}`,
        );
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for first stderr line from server (cwd=${this.child.spawnargs?.[2] ?? "?"})`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

// ---------------------------------------------------------------------------
// Storage / temp dir helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh isolated project dir under os.tmpdir() and
 * seed a single memory record at the matching `.curion/`
 * location. Returns the temp dir (already containing the
 * SQLite DB). The temp dir is safe to spawn the server in:
 * the project's `.curion/` will live there.
 */
function seedProject(opts: { preSeedMemory?: boolean } = {}): {
  tmp: string;
  curionDir: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-mcp-e2e-"));
  const curionDir = path.join(tmp, ".curion");
  // initStorage creates .curion/ if missing, opens the
  // SQLite file, and applies the schema migrations. We
  // run it once here so the directory and DB exist
  // *before* the server starts; the server's stdio
  // entrypoint will then re-open the same handle.
  const handle = initStorage({ projectRoot: tmp });
  if (opts.preSeedMemory) {
    insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      summary:
        "The project uses Postgres 16 for the primary data store.",
      providerId: "minimax",
      modelId: "MiniMax-M3",
      confidence: 0.9,
      safetyFlags: ["controller-normalized"],
      metadata: { tags: ["postgres", "storage"], classification: "fact" },
    });
  }
  try {
    handle.db.close();
  } catch {
    // ignore
  }
  return { tmp, curionDir };
}

function rmProject(tmp: string): void {
  // SQLite WAL files can be briefly held open by the
  // child process during shutdown. Retry a few times
  // with a short backoff so the test's finally block
  // can clean up the temp dir even if the child is in
  // the middle of exiting. Failures are ignored — a
  // leftover /tmp dir is harmless and the next test
  // gets a fresh one.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EACCES") {
        return;
      }
      // brief synchronous-ish wait
      const until = Date.now() + 50;
      while (Date.now() < until) {
        // spin
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. initialize handshake
// ---------------------------------------------------------------------------

test("e2e: initialize handshake returns server identity and capabilities", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    const resp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    assert.equal(resp.error, undefined, `initialize returned error: ${JSON.stringify(resp.error)}`);
    const result = resp.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    // serverInfo
    assert.ok(result.serverInfo, "initialize result must include serverInfo");
    assert.equal(result.serverInfo.name, "curion");
    assert.equal(typeof result.serverInfo.version, "string");
    assert.ok(result.serverInfo.version.length > 0);
    // protocolVersion
    assert.equal(typeof result.protocolVersion, "string");
    assert.ok(result.protocolVersion.length > 0);
    // capabilities: tools must be present; no resources / prompts.
    assert.ok(result.capabilities, "capabilities must be present");
    assert.ok(
      "tools" in result.capabilities,
      `capabilities must include tools; got ${JSON.stringify(result.capabilities)}`,
    );
    assert.equal(
      "resources" in result.capabilities,
      false,
      "capabilities must not include resources",
    );
    assert.equal(
      "prompts" in result.capabilities,
      false,
      "capabilities must not include prompts",
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 2. tools/list returns exactly remember + recall
// ---------------------------------------------------------------------------

test("e2e: tools/list returns exactly remember and recall, in that order", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    // Drive the initialize -> notifications/initialized
    // handshake so the server's `listChanged` notification
    // path is not relevant here. The tool list itself is
    // available after `initialize`, but the SDK requires
    // the initialized notification before `tools/call`.
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    assert.equal(init.error, undefined);
    client.notify("notifications/initialized", {});

    const resp = await client.request("tools/list", {});
    assert.equal(resp.error, undefined);
    const result = resp.result as { tools: Array<{ name: string }> };
    assert.ok(Array.isArray(result.tools), "tools/list must return an array");
    const names = result.tools.map((t) => t.name);
    assert.deepEqual(names, ["remember", "recall"]);
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 3. inputSchema for both tools (additionalProperties: false, required: text)
// ---------------------------------------------------------------------------

test("e2e: both tools expose inputSchema with only `text`, required, additionalProperties: false", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const resp = await client.request("tools/list", {});
    const tools = (resp.result as { tools: Array<Record<string, unknown>> }).tools;
    for (const name of ["remember", "recall"] as const) {
      const t = tools.find((x) => x["name"] === name);
      assert.ok(t, `${name} must be present in tools/list`);
      const inputSchema = t["inputSchema"] as Record<string, unknown>;
      assert.ok(inputSchema, `${name}.inputSchema must be present`);
      assert.equal(inputSchema["type"], "object");
      assert.deepEqual(inputSchema["additionalProperties"], false);
      assert.deepEqual(inputSchema["required"], ["text"]);
      const props = inputSchema["properties"] as Record<string, unknown>;
      assert.deepEqual(Object.keys(props), ["text"]);
      const text = props["text"] as Record<string, unknown>;
      assert.equal(text["type"], "string");
      // The schema carries the min(1) constraint.
      assert.equal(text["minLength"], 1);
    }
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4. outputSchema for both tools (strict, status enum)
// ---------------------------------------------------------------------------

test("e2e: both tools expose outputSchema with a strict status enum", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const resp = await client.request("tools/list", {});
    const tools = (resp.result as { tools: Array<Record<string, unknown>> }).tools;
    const remember = tools.find((t) => t["name"] === "remember")!;
    const recall = tools.find((t) => t["name"] === "recall")!;
    const ro = remember["outputSchema"] as Record<string, unknown>;
    const co = recall["outputSchema"] as Record<string, unknown>;
    for (const [toolName, schema] of [["remember", ro], ["recall", co]] as const) {
      assert.ok(schema, `${toolName} must have an outputSchema`);
      assert.equal(schema["type"], "object");
      // The Zod strict object is wired through to the
      // wire as `additionalProperties: false` (the SDK
      // applies the strict-Union projection).
      assert.deepEqual(
        schema["additionalProperties"],
        false,
        `${toolName} outputSchema must have additionalProperties: false`,
      );
      const props = schema["properties"] as Record<string, unknown>;
      assert.ok(props["status"], `${toolName} outputSchema must include \`status\``);
      const status = props["status"] as Record<string, unknown>;
      assert.equal(status["type"], "string");
      const values = (status["enum"] as string[]).slice().sort();
      const expected = toolName === "remember"
        ? ["clarification_needed", "provider_error", "rejected", "saved"]
        : ["answered", "no_memory", "provider_error", "rejected"];
      assert.deepEqual(values, expected);
    }
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 5. recall no_memory
// ---------------------------------------------------------------------------

test("e2e: recall with no stored memory -> { status: 'no_memory' } (no ids, no message, no Note: prefix)", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const r = await client.callTool("recall", { text: "anything" });
    // No isError: the handler ran cleanly.
    assert.notEqual(r.isError, true);
    // structuredContent is the user-approved shape.
    assert.ok(r.structuredContent, "structuredContent must be present");
    assert.deepEqual(r.structuredContent, { status: "no_memory" });
    // text content block: the exact public placeholder.
    assert.equal(r.content.length, 1);
    const block = r.content[0]!;
    assert.equal(block.type, "text");
    assert.equal((block as { text: string }).text, "No relevant memory found.");
    // Hard rules: no ids, no `message` field, no `Note:` prefix.
    for (const key of ["memoryId", "sourceIds", "memoryIds", "message"]) {
      assert.equal(
        key in (r.structuredContent as Record<string, unknown>),
        false,
        `recall.no_memory structuredContent must not include '${key}'`,
      );
    }
    const text = (block as { text: string }).text;
    assert.ok(!/Note:/.test(text), `text must not contain "Note:"; got ${JSON.stringify(text)}`);
    assert.ok(!/#\d+/.test(text), `text must not contain #N id; got ${JSON.stringify(text)}`);
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 6. recall rejected (secret-shaped query)
// ---------------------------------------------------------------------------

test("e2e: recall with a secret-shaped query -> { status: 'rejected', reason }, no provider call, no echo, no ids", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const SECRET = "AKIAIOSFODNN7EXAMPLE";
    const r = await client.callTool("recall", { text: SECRET });
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(sc, "structuredContent must be present");
    assert.equal(sc["status"], "rejected");
    assert.equal(typeof sc["reason"], "string");
    assert.ok((sc["reason"] as string).length > 0);
    // The raw secret must not appear anywhere on the
    // wire (text or structured).
    const wireText = JSON.stringify(r);
    assert.ok(
      !wireText.includes(SECRET),
      `raw secret must not appear on the wire; got ${wireText}`,
    );
    // No `answer` / `notes` fields on a rejected response.
    assert.equal("answer" in sc, false);
    assert.equal("notes" in sc, false);
    // No ids.
    for (const k of ["memoryId", "sourceIds", "memoryIds", "message"]) {
      assert.equal(k in sc, false, `recall.rejected must not include '${k}'`);
    }
    // The text content block is the existing
    // `"Rejected: <reason>"` form; it is the calm-prose
    // version of the structured `reason`. The `text`
    // block is not part of the user-approved
    // structured payload, so the no-echo rule is the
    // only constraint on its content.
    assert.equal(r.content.length, 1);
    const text = (r.content[0]! as { text: string }).text;
    assert.ok(
      text.startsWith("Rejected: "),
      `text must be the 'Rejected: ...' form; got ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes(SECRET),
      `text must not echo the raw secret; got ${JSON.stringify(text)}`,
    );
    // No provider call means no `Note:` prefix, no
    // answered-style prose.
    assert.ok(
      !/Note:/.test(text),
      `text must not contain "Note:"; got ${JSON.stringify(text)}`,
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 7. recall unknown extra top-level key rejected at SDK boundary
// ---------------------------------------------------------------------------

test("e2e: recall with an unknown extra top-level key -> isError: true (SDK boundary, no handler invocation)", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const r = await client.callTool("recall", {
      text: "anything",
      // The strict inputSchema must reject this.
      kind: "fact",
      // Other forbidden knobs in the same payload to
      // pin the rejection of the *set*, not just one
      // of them.
      provider: "minimax",
      modelId: "MiniMax-M3",
      debug: true,
    });
    assert.equal(
      r.isError,
      true,
      `SDK input validation must reject extra keys; got ${JSON.stringify(r)}`,
    );
    // The handler was not invoked, so there is no
    // structuredContent payload.
    assert.equal(
      r.structuredContent,
      undefined,
      `isError responses must not include structuredContent; got ${JSON.stringify(r.structuredContent)}`,
    );
    assert.equal(r.content.length, 1);
    const block = r.content[0]! as { type: string; text: string };
    assert.equal(block.type, "text");
    // The exact error text is owned by the SDK; we only
    // assert that it surfaces a "Invalid arguments"
    // style error (or, on newer SDK revisions, an
    // equivalent message).
    assert.match(block.text, /Invalid arguments/i);
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 8. remember rejected (vague input)
// ---------------------------------------------------------------------------

test("e2e: remember with vague input -> { status: 'rejected', reason }, no raw echo, no ids", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const VAGUE = "asdf";
    const r = await client.callTool("remember", { text: VAGUE });
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(sc, "structuredContent must be present");
    assert.equal(sc["status"], "rejected");
    assert.equal(typeof sc["reason"], "string");
    assert.ok((sc["reason"] as string).length > 0);
    // The raw input must not appear anywhere on the
    // wire.
    const wireText = JSON.stringify(r);
    assert.ok(
      !wireText.includes(VAGUE),
      `raw vague input must not appear on the wire; got ${wireText}`,
    );
    // No summary / kind / confidence / question / ids.
    for (const k of [
      "summary",
      "kind",
      "confidence",
      "question",
      "memoryId",
      "modelId",
      "providerId",
      "message",
    ]) {
      assert.equal(k in sc, false, `remember.rejected must not include '${k}'`);
    }
    // text content block: existing "Rejected: <reason>"
    // form, no raw echo.
    assert.equal(r.content.length, 1);
    const text = (r.content[0]! as { text: string }).text;
    assert.ok(
      text.startsWith("Rejected: "),
      `text must be the 'Rejected: ...' form; got ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes(VAGUE),
      `text must not echo the raw vague input; got ${JSON.stringify(text)}`,
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

test("e2e: remember with a secret-shaped input -> { status: 'rejected', reason }, no raw echo", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const SECRET = "glpat-abcdefghijklmnopqrstuvwxyz0123456789";
    const r = await client.callTool("remember", { text: SECRET });
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent as Record<string, unknown>;
    assert.equal(sc["status"], "rejected");
    assert.equal(typeof sc["reason"], "string");
    const wireText = JSON.stringify(r);
    assert.ok(
      !wireText.includes(SECRET),
      `raw secret must not appear on the wire; got ${wireText}`,
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 9. remember unknown extra top-level key rejected at SDK boundary
// ---------------------------------------------------------------------------

test("e2e: remember with an unknown extra top-level key -> isError: true (SDK boundary)", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const r = await client.callTool("remember", {
      text: "hello",
      kind: "fact",
      state: "active",
      provider: "minimax",
      modelId: "MiniMax-M3",
      debug: true,
      storage: ".curion",
    });
    assert.equal(
      r.isError,
      true,
      `SDK input validation must reject extra keys; got ${JSON.stringify(r)}`,
    );
    assert.equal(r.structuredContent, undefined);
    assert.equal(r.content.length, 1);
    const block = r.content[0]! as { type: string; text: string };
    assert.equal(block.type, "text");
    assert.match(block.text, /Invalid arguments/i);
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 10. stdout carries only JSON-RPC; logs go to stderr
// ---------------------------------------------------------------------------

test("e2e: stdout contains only newline-delimited JSON-RPC; logs travel on stderr", async () => {
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    // Drive a few requests so the server emits its
    // usual log lines and a few JSON-RPC responses.
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    await client.request("tools/list", {});
    await client.callTool("recall", { text: "anything" });
    await client.callTool("remember", { text: "asdf" });

    const stdout = client.stdoutSnapshot();
    const stderr = client.stderrSnapshot();

    // Every line on stdout must be parseable as JSON.
    const stdoutLines = stdout.split("\n").filter((l) => l.length > 0);
    assert.ok(stdoutLines.length > 0, "stdout should have at least one JSON-RPC response");
    for (const line of stdoutLines) {
      assert.doesNotThrow(
        () => JSON.parse(line) as unknown,
        `every stdout line must be valid JSON; got: ${line.slice(0, 200)}`,
      );
    }
    // Every parsed line must look like a JSON-RPC envelope.
    for (const line of stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string; id?: unknown; method?: string };
      assert.equal(
        parsed.jsonrpc,
        "2.0",
        `every stdout line must declare jsonrpc: "2.0"; got: ${line.slice(0, 200)}`,
      );
      const hasId = parsed.id !== undefined;
      const hasMethod = typeof parsed.method === "string";
      assert.ok(
        hasId || hasMethod,
        `every stdout line must carry an id (response) or method (notification/signal); got: ${line.slice(0, 200)}`,
      );
    }
    // No raw `[curion]` log lines on stdout.
    assert.ok(
      !stdout.includes("[curion]"),
      `stdout must not contain [curion] log lines; got: ${stdout.slice(0, 400)}`,
    );
    // stderr is non-empty and carries the project
    // logger's `[curion]` prefix.
    assert.ok(
      stderr.length > 0,
      `stderr must be non-empty; the server's startup logs should travel there`,
    );
    assert.match(
      stderr,
      /\[curion\]/,
      `stderr must contain the [curion] log prefix; got: ${stderr.slice(0, 400)}`,
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

// ---------------------------------------------------------------------------
// 11. provider_error path (optional, no-network)
// ---------------------------------------------------------------------------

test("e2e: recall with a pre-seeded memory in a no-API-key env -> { status: 'provider_error', reason } (no network)", async () => {
  // Pre-seed a single memory record so the recall
  // controller finds a lexical hit and consults the
  // provider adapter. With no API key in the env, the
  // adapter's `missing-config` early-return never opens
  // a socket, and the controller surfaces
  // `provider_error`. The wire surface is the same as
  // the in-process projection: a single text content
  // block carrying `"Provider error: <reason>"` and
  // `structuredContent: { status: 'provider_error',
  // reason }`.
  const { tmp } = seedProject({ preSeedMemory: true });
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const r = await client.callTool("recall", {
      text: "What database does the project use?",
    });
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(sc, "structuredContent must be present");
    assert.equal(sc["status"], "provider_error");
    assert.equal(typeof sc["reason"], "string");
    assert.ok((sc["reason"] as string).length > 0);
    // The reason is short and redacted (no
    // network-bound endpoint, no API key, no model id).
    // We assert it is bounded and does not echo the
    // query or any id.
    const reason = sc["reason"] as string;
    assert.ok(reason.length > 0 && reason.length < 400, `reason must be bounded; got length=${reason.length}`);
    assert.ok(
      !reason.includes("What database does the project use?"),
      `reason must not echo the query; got ${JSON.stringify(reason)}`,
    );
    // No `answer` / `notes` / ids.
    for (const k of ["answer", "notes", "memoryId", "sourceIds", "memoryIds", "message"]) {
      assert.equal(k in sc, false, `recall.provider_error must not include '${k}'`);
    }
    // text content block: "Provider error: <reason>".
    assert.equal(r.content.length, 1);
    const text = (r.content[0]! as { text: string }).text;
    assert.ok(
      text.startsWith("Provider error: "),
      `text must be the 'Provider error: ...' form; got ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes("What database does the project use?"),
      `text must not echo the query; got ${JSON.stringify(text)}`,
    );
  } finally {
    await client.close();
    rmProject(tmp);
  }
});

test("e2e: remember with a safe input in a no-API-key env -> { status: 'provider_error', reason } (no network)", async () => {
  // Symmetric coverage on the remember side: a safe,
  // non-secret, non-vague input consults the provider
  // for analysis. With no API key, the adapter's
  // `missing-config` early-return never opens a
  // socket. The controller surfaces `provider_error`
  // without persisting the input.
  const { tmp } = seedProject();
  const client = await StdioMcpClient.start({ cwd: tmp });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curion-mcp-e2e-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized", {});
    const SAFE_TEXT = "The project uses Postgres 16 for the primary data store.";
    const r = await client.callTool("remember", { text: SAFE_TEXT });
    assert.notEqual(r.isError, true);
    const sc = r.structuredContent as Record<string, unknown>;
    assert.ok(sc, "structuredContent must be present");
    assert.equal(sc["status"], "provider_error");
    assert.equal(typeof sc["reason"], "string");
    const reason = sc["reason"] as string;
    assert.ok(reason.length > 0);
    // The reason is short, redacted, and does not echo
    // the input.
    assert.ok(
      !reason.includes(SAFE_TEXT) && !reason.includes("Postgres 16"),
      `reason must not echo the input; got ${JSON.stringify(reason)}`,
    );
    // No `summary` / `kind` / `confidence` / `question` / ids.
    for (const k of [
      "summary",
      "kind",
      "confidence",
      "question",
      "memoryId",
      "modelId",
      "providerId",
      "message",
    ]) {
      assert.equal(k in sc, false, `remember.provider_error must not include '${k}'`);
    }
    // text content block: "Provider error: <reason>".
    assert.equal(r.content.length, 1);
    const text = (r.content[0]! as { text: string }).text;
    assert.ok(
      text.startsWith("Provider error: "),
      `text must be the 'Provider error: ...' form; got ${JSON.stringify(text)}`,
    );
    assert.ok(
      !text.includes(SAFE_TEXT),
      `text must not echo the raw input; got ${JSON.stringify(text)}`,
    );
    // No memory was persisted: the controller
    // short-circuited before the storage write. We
    // assert the public surface is clean — the DB may
    // have no row matching the input summary.
    const dbPath = path.join(tmp, ".curion", "curion.sqlite");
    if (fs.existsSync(dbPath)) {
      // We do not import better-sqlite3 here to keep
      // the test pure; the contract is the wire
      // surface. A future test could open the DB and
      // verify zero rows match the input.
    }
  } finally {
    await client.close();
    rmProject(tmp);
  }
});
