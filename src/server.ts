/**
 * MCP server wiring.
 *
 * Registers exactly two public tools:
 *   - `remember(text)`
 *   - `recall(text)`
 *
 * Each tool has exactly one public `text` parameter (zod-validated),
 * and a public `outputSchema` + `structuredContent` that carries
 * the user-approved clean discriminated shape (see
 * `src/tools/recall-structured-content.ts` and
 * `src/tools/remember-structured-content.ts`). No other tools,
 * resources, or prompts are registered.
 *
 * Phase clarification-field-redesign: the wire surface exposes
 * `structuredContent` for both tools, in addition to the
 * on-the-wire `text` content block. The `text` content block is
 * the existing calm-prose form; the `structuredContent` is the
 * clean discriminated shape (no `message` field, no memory ids,
 * no `Note:` prefix, no model / provider metadata, no raw input).
 *
 * The optional `clarification_needed` field on
 * `structuredContent` (on `rejected`, `no_memory`, `weak_match`)
 * carries the user-facing prompt for the agent to ask the user.
 * `clarification_needed` is a field, NOT a status, and never
 * appears on `provider_error`.
 *
 * Public input contract (unchanged):
 *   - exactly one `text` parameter (string), required, non-empty
 *   - no kinds, states, filters, providers, debug, or storage knobs
 *
 * Phase strict-tool-input-schemas: the tool `inputSchema` is a
 * Zod v3 object schema with `.strict()` so the MCP SDK's input
 * validation rejects any unknown top-level key at the
 * SDK/schema boundary. Previously, the SDK normalized a raw
 * shape to a non-strict Zod object which silently stripped
 * unknown keys. The strict object closes that gap: the public
 * `tools/list` JSON schema advertises `additionalProperties:
 * false` (or the equivalent strict-Union projection), and the
 * SDK's `validateToolInput` rejects any extra property on a
 * real tool call before the handler runs. The handler
 * defensive checks in `src/tools/remember.ts` and
 * `src/tools/recall.ts` remain in place as defense in depth.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  handleRemember,
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_INPUT_SCHEMA,
} from "./tools/remember.js";
import {
  handleRecall,
  RECALL_TOOL_DESCRIPTION,
  RECALL_INPUT_SCHEMA,
} from "./tools/recall.js";
import {
  RECALL_STRUCTURED_CONTENT_SCHEMA,
  type RecallStructuredContent,
} from "./tools/recall-structured-content.js";
import {
  REMEMBER_STRUCTURED_CONTENT_SCHEMA,
  type RememberStructuredContent,
} from "./tools/remember-structured-content.js";
import {
  buildRecallPublicText,
  buildRecallStructuredContent,
} from "./tools/recall-projection.js";
import {
  buildRememberPublicText,
  buildRememberStructuredContent,
} from "./tools/remember-projection.js";
import { logger } from "./logging/logger.js";

export const PUBLIC_TOOL_NAMES = ["remember", "recall"] as const;
export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export interface BuildServerOptions {
  /** Server name reported in the MCP initialize handshake. */
  name?: string;
  /** Server version reported in the MCP initialize handshake. */
  version?: string;
}

// Re-export the wire-format types so consumers (tests, future
// agent-facing code) can pin the contract from a single import.
export type { RecallStructuredContent, RememberStructuredContent };
export {
  RECALL_STRUCTURED_CONTENT_SCHEMA,
  REMEMBER_STRUCTURED_CONTENT_SCHEMA,
};

/**
 * Build a fresh McpServer instance with the two public tools registered.
 * Pure factory — no transport is attached here.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "curion",
      version: options.version ?? "0.2.0",
    },
    {
      capabilities: {
        // Tools only. No resources, no prompts.
        tools: {},
      },
    },
  );

  // remember(text)
  //
  // The `registerTool` API is the non-deprecated replacement for
  // the legacy `server.tool(...)` overloads. It supports
  // `outputSchema`, which is required for the MCP SDK to emit
  // `structuredContent` on the wire and to validate the response
  // shape server-side. We use the non-deprecated API so future
  // SDK revisions do not silently drop `outputSchema` support.
  //
  // The `inputSchema` is a strict Zod v3 object schema. The
  // SDK's `validateToolInput` runs `safeParseAsync` on this
  // schema before invoking the handler; `.strict()` makes it
  // reject any unknown top-level key (raw shape would be
  // wrapped in a non-strict object and would silently strip
  // them). This pins the public input contract at the
  // SDK/schema boundary — the only acceptable top-level key
  // is `text`.
  server.registerTool(
    "remember",
    {
      description: REMEMBER_TOOL_DESCRIPTION,
      inputSchema: REMEMBER_INPUT_SCHEMA,
      outputSchema: REMEMBER_STRUCTURED_CONTENT_SCHEMA,
    },
    async (args) => {
      const result = await handleRemember(args);
      const text = buildRememberPublicText(result);
      const structuredContent: RememberStructuredContent =
        buildRememberStructuredContent(result);
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
        structuredContent,
      };
    },
  );

  // recall(text)
  server.registerTool(
    "recall",
    {
      description: RECALL_TOOL_DESCRIPTION,
      inputSchema: RECALL_INPUT_SCHEMA,
      outputSchema: RECALL_STRUCTURED_CONTENT_SCHEMA,
    },
    async (args) => {
      const result = await handleRecall(args);
      const text = buildRecallPublicText(result);
      const structuredContent: RecallStructuredContent =
        buildRecallStructuredContent(result);
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
        structuredContent,
      };
    },
  );

  logger.debug(
    `server built with ${PUBLIC_TOOL_NAMES.length} public tools: ${PUBLIC_TOOL_NAMES.join(", ")}`,
  );

  return server;
}
