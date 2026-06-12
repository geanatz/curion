/**
 * MCP server wiring.
 *
 * Registers exactly two public tools:
 *   - `remember(text)`
 *   - `recall(text)`
 *
 * Each tool has exactly one public `text` parameter (zod-validated).
 * No other tools, resources, or prompts are registered.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleRemember, REMEMBER_TOOL_DESCRIPTION } from "./tools/remember.js";
import { handleRecall, RECALL_TOOL_DESCRIPTION } from "./tools/recall.js";
import { logger } from "./logging/logger.js";

export const PUBLIC_TOOL_NAMES = ["remember", "recall"] as const;
export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export interface BuildServerOptions {
  /** Server name reported in the MCP initialize handshake. */
  name?: string;
  /** Server version reported in the MCP initialize handshake. */
  version?: string;
}

/**
 * Build a fresh McpServer instance with the two public tools registered.
 * Pure factory — no transport is attached here.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "cortex-mcp-v2",
      version: options.version ?? "0.1.0",
    },
    {
      capabilities: {
        // Tools only. No resources, no prompts.
        tools: {},
      },
    },
  );

  // remember(text)
  server.tool(
    "remember",
    REMEMBER_TOOL_DESCRIPTION,
    {
      text: z
        .string()
        .min(1, "text must not be empty")
        .describe("The memory text to store."),
    },
    async (args) => {
      const result = await handleRemember(args);
      return {
        content: [
          {
            type: "text" as const,
            text: result.message,
          },
        ],
        // Structured content not exposed in Phase 1.
      };
    },
  );

  // recall(text)
  server.tool(
    "recall",
    RECALL_TOOL_DESCRIPTION,
    {
      text: z
        .string()
        .min(1, "text must not be empty")
        .describe("The query to recall memory for."),
    },
    async (args) => {
      const result = await handleRecall(args);
      return {
        content: [
          {
            type: "text" as const,
            text: result.message,
          },
        ],
      };
    },
  );

  logger.debug(
    `server built with ${PUBLIC_TOOL_NAMES.length} public tools: ${PUBLIC_TOOL_NAMES.join(", ")}`,
  );

  return server;
}
