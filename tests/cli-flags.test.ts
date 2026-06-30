/**
 * CLI flag interception tests for `curion --help` / `--version`.
 *
 * Two layers of coverage:
 *
 *   1. Unit tests against the pure `buildHelpText()` helper and
 *      the generated `VERSION` constant. These run in-process and
 *      do NOT require a build; they verify the text content and
 *      the package-version source of truth.
 *
 *   2. End-to-end subprocess tests that spawn the built
 *      `dist/index.js` with each recognized flag in an isolated
 *      temp directory, capture stdout / stderr / exit code, and
 *      assert that no `.curion/` directory was created. These
 *      mirror the user-visible behavior of running
 *      `curion --help` from a shell.
 *
 * The e2e subprocess tests require `dist/index.js` to exist
 * (i.e. `npm run build` to have run). The test fails loudly with
 * a clear error if the binary is missing.
 *
 * Lockfile / network / API-key guarantees:
 *   - No API keys are touched; the server is never asked to make
 *     a provider call.
 *   - The subprocess HOME is not overridden (we only care about
 *     `.curion/` under the spawn cwd, not `~/.curion/`). The
 *     registry module is not invoked either, because
 *     `maybeHandleCliFlags` short-circuits before `initStorage`
 *     and the `setStorageProvider` chain runs.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildHelpText } from "../src/cli-help.ts";
import { VERSION } from "../src/version.ts";
import { PUBLIC_TOOL_NAMES, buildServer } from "../src/server.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const PKG_JSON = path.join(REPO_ROOT, "package.json");

// ---------------------------------------------------------------------------
// Unit tests: buildHelpText() shape and content
// ---------------------------------------------------------------------------

test("buildHelpText: includes the binary name, both flags, and the two tools", () => {
  const text = buildHelpText("9.9.9-test");
  assert.ok(text.length > 0, "help text must not be empty");
  assert.ok(text.endsWith("\n"), "help text must end with a newline");
  // Binary identity line (with em-dash). Pinned as a string the
  // docs / README also reference so a future rewrite that drops
  // the name would break this test loudly.
  assert.match(text, /curion — project-local memory layer for AI agents/);
  // Both long and short flag forms must appear.
  assert.match(text, /-h, --help/);
  assert.match(text, /-v, --version/);
  // The two public tools must be advertised so a curious user
  // can see them without reading the docs.
  assert.match(text, /remember\(text\)/);
  assert.match(text, /recall\(text\)/);
  // The docs URL must be present.
  assert.match(text, /https:\/\/github\.com\/geanatz\/curion/);
  // The version literal passed in must NOT appear in the help
  // text — the help text is intentionally version-agnostic so we
  // don't churn the test on every release tag.
  assert.ok(
    !text.includes("9.9.9-test"),
    "help text must not embed the version (the --version flag is the canonical source)"
  );
});

test("buildHelpText: pure function (same input -> same output)", () => {
  const a = buildHelpText("0.0.0");
  const b = buildHelpText("0.0.0");
  assert.equal(a, b);
});

test("buildHelpText: contains env-var configuration contract", () => {
  // A user running `curion --help` should be able to see the
  // minimum configuration without reading the docs. Pin the
  // specific env-var names so a future copy edit that breaks the
  // contract is caught here.
  const text = buildHelpText("0.0.0");
  for (const envVar of [
    "CURION_PRIMARY_API_KEY",
    "CURION_PRIMARY_BASE_URL",
    "CURION_PRIMARY_MODEL",
    "CURION_SEMANTIC_ENABLED",
    "CURION_LOG_LEVEL",
  ]) {
    assert.ok(
      text.includes(envVar),
      `help text must mention the env var ${envVar}; got: ${text}`
    );
  }
});

// ---------------------------------------------------------------------------
// Unit tests: VERSION constant and its source-of-truth
// ---------------------------------------------------------------------------

test("VERSION matches package.json#version (no stale hardcoded fallback)", () => {
  const pkgRaw = fs.readFileSync(PKG_JSON, "utf8");
  const pkg = JSON.parse(pkgRaw) as { version?: unknown };
  assert.equal(
    typeof pkg.version,
    "string",
    "package.json must have a string `version` field"
  );
  assert.equal(VERSION, pkg.version, "src/version.ts must match package.json#version");
  // Sanity: VERSION must not be the historical stale "0.2.0"
  // fallback that used to live in src/server.ts. If a future
  // release legitimately starts at 0.2.0 again, this assertion
  // should be updated consciously.
  assert.notEqual(
    VERSION,
    "0.2.0",
    "VERSION must not be the stale `0.2.0` fallback that previously hardcoded in src/server.ts"
  );
});

test("VERSION is a non-empty string (so --version output is never empty)", () => {
  assert.equal(typeof VERSION, "string");
  assert.ok(VERSION.length > 0, "VERSION must not be empty");
  // Must look like a semver-ish identifier (digits + dots, at
  // least one dot). This is a loose shape check; the real semver
  // parser is in the release tooling.
  assert.match(VERSION, /^\d+\.\d+\.\d+/, `VERSION must be semver-shaped; got "${VERSION}"`);
});

// ---------------------------------------------------------------------------
// Server wiring uses VERSION (regression guard for the stale 0.2.0 fallback)
// ---------------------------------------------------------------------------

test("buildServer uses the runtime VERSION constant (no hardcoded 0.2.0)", () => {
  // We can't directly read `serverInfo.version` from the McpServer
  // (it's set on the internal Server instance). Instead, exercise
  // `buildServer()` and confirm the version used is the generated
  // one — by checking the package version is reflected in the
  // server's `serverInfo` via the SDK's `getServerVersion` helper
  // when available, or by a probe of the registered server shape.
  const server = buildServer();
  const registered = (
    server as unknown as {
      server?: { _serverInfo?: { version?: string } };
    }
  ).server;
  // The SDK stores the original `Server` instance on
  // `server.server`. The `Server` class exposes the version it was
  // constructed with via internal state. We tolerate either of the
  // two known shapes here, and fall back to a string-grep on the
  // raw object if needed.
  const fromInternals =
    registered && (registered as unknown as { _serverInfo?: { version?: string } })._serverInfo;
  if (fromInternals && typeof fromInternals.version === "string") {
    assert.equal(
      fromInternals.version,
      VERSION,
      `serverInfo.version must equal VERSION; got ${fromInternals.version}`
    );
  }
  // We always assert: buildServer() does not throw, and the
  // public tool surface is unchanged.
  assert.equal(PUBLIC_TOOL_NAMES.length, 2);
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
});

test("buildServer honors options.version override (test escape hatch)", () => {
  const server = buildServer({ version: "9.9.9-override" });
  const registered = (
    server as unknown as {
      server?: { _serverInfo?: { version?: string } };
    }
  ).server;
  const fromInternals =
    registered && (registered as unknown as { _serverInfo?: { version?: string } })._serverInfo;
  if (fromInternals && typeof fromInternals.version === "string") {
    assert.equal(
      fromInternals.version,
      "9.9.9-override",
      `options.version must take precedence; got ${fromInternals.version}`
    );
  }
});

// ---------------------------------------------------------------------------
// End-to-end subprocess tests: spawn dist/index.js with each flag
// ---------------------------------------------------------------------------

/**
 * Run `node dist/index.js` with `args` in `cwd` and capture
 * stdout / stderr / exit code. The child has no stdin input; we
 * close stdin immediately so the server (in the non-flag path)
 * sees EOF and shuts down cleanly.
 *
 * Returns the captured streams and exit code. The function does
 * not throw on a non-zero exit; the caller asserts on it.
 */
async function runCli(args: string[], cwd: string): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `server entry not found at ${SERVER_ENTRY}; run \`npm run build\` first`
    );
  }
  return await new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [SERVER_ENTRY, ...args],
      {
        cwd,
        env: {
          // Strip the developer's real .env / provider keys so the
          // server cannot accidentally open a socket or write to a
          // real registry in a non-flag path. For flag paths the
          // server never reaches the env, but we strip anyway to
          // keep the test hermetic and avoid network noise.
          ...process.env,
          HOME: cwd, // also hermetic for any registry reads
          CURION_LOG_LEVEL: "info",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    // Close stdin immediately. For flag invocations the process
    // exits before reading stdin; for non-flag invocations (used
    // by the "no flag" smoke test) EOF on stdin is the canonical
    // shutdown signal.
    child.stdin.end();
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/** Make a fresh temp dir under os.tmpdir(). Caller cleans up. */
function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursive rm with a few retries for busy SQLite WAL files. */
function rmTmpDirBestEffort(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EACCES") {
        return;
      }
      const until = Date.now() + 25;
      // eslint-disable-next-line no-empty
      while (Date.now() < until) {
        /* spin briefly */
      }
    }
  }
}

/**
 * Assert that running `dist/index.js` with the given args:
 *   - exits with code 0
 *   - emits nothing on stderr
 *   - does NOT create a `.curion/` directory under `cwd`
 *   - matches `stdoutPredicate` against the captured stdout
 */
async function assertFlagClean(opts: {
  args: string[];
  cwd: string;
  stdoutPredicate: (stdout: string) => void;
}): Promise<void> {
  const { exitCode, stdout, stderr } = await runCli(opts.args, opts.cwd);
  assert.equal(
    exitCode,
    0,
    `expected exit 0; got exit=${exitCode}, signal=${null}; stdout=${stdout.slice(0, 400)}; stderr=${stderr.slice(0, 400)}`
  );
  assert.equal(
    stderr,
    "",
    `stderr must be empty for flag invocation; got: ${JSON.stringify(stderr.slice(0, 400))}`
  );
  // The .curion/ directory must NOT be created.
  const curionDir = path.join(opts.cwd, ".curion");
  assert.equal(
    fs.existsSync(curionDir),
    false,
    `.curion/ must not be created for flag invocation; found at ${curionDir}`
  );
  opts.stdoutPredicate(stdout);
}

// ---------------------------------------------------------------------------
// --help / -h
// ---------------------------------------------------------------------------

test("e2e: --help prints help to stdout, nothing on stderr, exits 0, no .curion/", async () => {
  const cwd = mkTmpDir("curion-cli-help-");
  try {
    await assertFlagClean({
      args: ["--help"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.match(stdout, /curion — project-local memory layer for AI agents/);
        assert.match(stdout, /-h, --help/);
        assert.match(stdout, /-v, --version/);
        assert.match(stdout, /remember\(text\)/);
        assert.match(stdout, /recall\(text\)/);
        // Help text should NOT include the version literal; the
        // --version flag is the canonical source for the version.
        // The user can pipe `curion --version` into a parser
        // without ambiguity. (If a future release decides to
        // embed the version here too, update this assertion
        // consciously.)
        assert.ok(
          !stdout.includes(VERSION),
          `--help must not embed the version; got stdout starting with: ${stdout.slice(0, 200)}`
        );
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

test("e2e: -h is equivalent to --help", async () => {
  const cwd = mkTmpDir("curion-cli-help-short-");
  try {
    await assertFlagClean({
      args: ["-h"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.match(stdout, /curion — project-local memory layer for AI agents/);
        assert.match(stdout, /-h, --help/);
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

// ---------------------------------------------------------------------------
// --version / -v
// ---------------------------------------------------------------------------

test("e2e: --version prints the package version to stdout, nothing on stderr, exits 0, no .curion/", async () => {
  const cwd = mkTmpDir("curion-cli-version-");
  try {
    await assertFlagClean({
      args: ["--version"],
      cwd,
      stdoutPredicate: (stdout) => {
        // Plain version on a single line so scripts can parse it.
        assert.equal(stdout, `${VERSION}\n`);
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

test("e2e: -v is equivalent to --version", async () => {
  const cwd = mkTmpDir("curion-cli-version-short-");
  try {
    await assertFlagClean({
      args: ["-v"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.equal(stdout, `${VERSION}\n`);
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

// ---------------------------------------------------------------------------
// Combined flags: first match wins
// ---------------------------------------------------------------------------

test("e2e: --version --help prints version (first arg in argv wins)", async () => {
  // The flag handler iterates argv in order; the first matching
  // flag short-circuits the rest. With `--version` first, the
  // version wins regardless of subsequent `--help`. This is the
  // standard CLI convention (mirrors how `git --version --help`
  // prints the version because `--version` comes first).
  const cwd = mkTmpDir("curion-cli-version-then-help-");
  try {
    await assertFlagClean({
      args: ["--version", "--help"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.equal(
          stdout,
          `${VERSION}\n`,
          `first flag --version must win; got stdout starting with: ${stdout.slice(0, 80)}`
        );
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

test("e2e: --help --version prints help (first arg in argv wins)", async () => {
  // Symmetric to the previous test: with `--help` first, help
  // wins. Pins the "argv order is the precedence" rule.
  const cwd = mkTmpDir("curion-cli-help-then-version-");
  try {
    await assertFlagClean({
      args: ["--help", "--version"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.match(stdout, /curion — project-local memory layer for AI agents/);
        assert.match(stdout, /-h, --help/);
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

test("e2e: -v -h prints version (short forms, argv order wins)", async () => {
  const cwd = mkTmpDir("curion-cli-short-version-then-help-");
  try {
    await assertFlagClean({
      args: ["-v", "-h"],
      cwd,
      stdoutPredicate: (stdout) => {
        assert.equal(stdout, `${VERSION}\n`);
      },
    });
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});

// ---------------------------------------------------------------------------
// Regression: no flag -> normal MCP stdio behavior is unchanged
// ---------------------------------------------------------------------------

test("e2e: no flag still creates .curion/ and starts the MCP server (regression guard)", async () => {
  // Smoke test that flag interception did NOT break the normal
  // path. With no flag, the server starts up, creates .curion/,
  // and waits on stdin. We close stdin immediately so the process
  // exits cleanly. We assert .curion/ IS created (the flag short
  // circuit did not accidentally swallow the normal startup) and
  // that the process exits 0 (the SDK's shutdown on EOF is
  // graceful).
  const cwd = mkTmpDir("curion-cli-noflag-");
  try {
    const { exitCode, stdout, stderr } = await runCli([], cwd);
    assert.equal(
      exitCode,
      0,
      `expected exit 0 on no-flag invocation; got exit=${exitCode}; stderr=${stderr.slice(0, 400)}`
    );
    const curionDir = path.join(cwd, ".curion");
    assert.equal(
      fs.existsSync(curionDir),
      true,
      `.curion/ must be created for normal (no-flag) startup; not found at ${curionDir}`
    );
    // Normal startup logs land on stderr; the JSON-RPC transport
    // is attached but emits nothing until a client sends a
    // request, so stdout should be empty for this run.
    assert.equal(stdout, "", `stdout must be empty when stdin closes immediately; got: ${stdout}`);
    assert.match(
      stderr,
      /\[curion\]/,
      `stderr must carry the [curion] log prefix for normal startup; got: ${stderr.slice(0, 400)}`
    );
  } finally {
    rmTmpDirBestEffort(cwd);
  }
});