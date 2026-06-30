#!/usr/bin/env node
/**
 * Stdio entrypoint for curion.
 *
 * Attaches the MCP server to a stdio transport. All logging must
 * travel on stderr; this file is the single place where stdio is
 * wired up. Anything written to stdout will corrupt the MCP protocol
 * stream, so we use the stderr-only logger throughout.
 *
 * CLI flag interception:
 *   - `--help` / `-h` print the help text (see `src/cli-help.ts`)
 *     to stdout and exit 0.
 *   - `--version` / `-v` print the package version (see
 *     `src/version.js`) to stdout and exit 0.
 *   - Both flag paths short-circuit BEFORE `initStorage()` so the
 *     project-local `.curion/` directory is NEVER created for a
 *     help/version invocation. The MCP stdio transport is also
 *     never started for these invocations, so the JSON-RPC framing
 *     on stdout is never contaminated by help/version output.
 *   - The flag handlers do not call the logger (stderr stays
 *     empty) so the help/version output is the only thing the
 *     shell sees on either stream.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildHelpText } from "./cli-help.js";
import { logger } from "./logging/logger.js";
import { PUBLIC_TOOL_NAMES, buildServer } from "./server.js";
import { closeStorage, initStorage } from "./storage/storage.js";
import { setStorageProvider as setRecallStorageProvider } from "./tools/recall.js";
import { setStorageProvider } from "./tools/remember.js";
import { VERSION } from "./version.js";

/**
 * Recognized CLI flags. Each entry is a token that, when present
 * in `argv`, triggers the matching handler. The order of this
 * table defines the "first match wins" precedence when multiple
 * recognized flags are passed in the same invocation.
 */
const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

/**
 * Apply the help/version short-circuit. Returns `true` if a flag
 * was handled (and `process.exit(0)` was called); `false` if the
 * caller should continue with normal startup. Centralizing the
 * short-circuit here keeps the entrypoint flow readable and lets
 * the unit tests assert the helper in isolation from the rest of
 * `main()`.
 *
 * The function intentionally calls `process.exit(0)` directly so
 * no side effect from `main()` runs after a flag is matched.
 */
function maybeHandleCliFlags(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (HELP_FLAGS.has(arg)) {
      process.stdout.write(buildHelpText(VERSION));
      process.exit(0);
    }
    if (VERSION_FLAGS.has(arg)) {
      // Plain version on a single line so scripts / CI can parse it.
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }
  }
  return false;
}

async function main(): Promise<void> {
  // CLI flag interception: --help / -h / --version / -v must
  // short-circuit BEFORE any storage side effect (`.curion/`
  // creation) or stdio transport setup. `maybeHandleCliFlags`
  // calls `process.exit(0)` directly when a recognized flag is
  // present, so no further code in `main()` runs for those
  // invocations. Normal MCP stdio behavior is unchanged when no
  // flag is passed.
  maybeHandleCliFlags(process.argv.slice(2));

  // Initialize project-local storage. Side effect: creates .curion/ if
  // missing. Failures here are fatal — the server cannot run without
  // its data directory.
  const storage = initStorage();
  logger.info(`curion starting (storage: ${storage.dir}, tools: ${PUBLIC_TOOL_NAMES.join(", ")})`);

  // Inject the long-lived storage handle into both tool layers so
  // they do not open a fresh DB on every call. We retain ownership
  // of the handle here and close it in the shutdown handler.
  const provider = () => ({ handle: storage, ownsHandle: false });
  setStorageProvider(provider);
  setRecallStorageProvider(provider);

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport connected");

  // Graceful shutdown: close the DB and the transport cleanly.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    try {
      await server.close();
    } catch (err) {
      logger.error(`server.close failed: ${(err as Error).message}`);
    }
    try {
      closeStorage(storage);
    } catch (err) {
      logger.error(`closeStorage failed: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Use the logger (stderr) here too — no console.log.
  process.stderr.write(`[curion] FATAL ${msg}\n`);
  process.exit(1);
});
