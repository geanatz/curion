#!/usr/bin/env node
/**
 * Stdio entrypoint for curion.
 *
 * Attaches the MCP server to a stdio transport. All logging must
 * travel on stderr; this file is the single place where stdio is
 * wired up. Anything written to stdout will corrupt the MCP protocol
 * stream, so we use the stderr-only logger throughout.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, PUBLIC_TOOL_NAMES } from "./server.js";
import { logger } from "./logging/logger.js";
import { initStorage, closeStorage } from "./storage/storage.js";
import { setStorageProvider } from "./tools/remember.js";
import { setStorageProvider as setRecallStorageProvider } from "./tools/recall.js";

async function main(): Promise<void> {
  // Initialize project-local storage. Side effect: creates .curion/ if
  // missing. Failures here are fatal — the server cannot run without
  // its data directory.
  const storage = initStorage();
  logger.info(
    `curion starting (storage: ${storage.dir}, tools: ${PUBLIC_TOOL_NAMES.join(", ")})`,
  );

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
