/**
 * Public MCP `structuredContent` schema for the `recall` tool.
 *
 * User-approved shape (Phase clean-structured-tool-responses):
 *   - answered:            { status: "answered", answer: string, notes?: string[] }
 *   - no_memory:          { status: "no_memory" }
 *   - rejected:           { status: "rejected", reason: string }
 *   - provider_error:     { status: "provider_error", reason: string }
 *
 * Rules:
 *   - No `message` field.
 *   - No memory ids (`memoryId`, `sourceIds`, `memoryIds`).
 *   - No note `type` / `severity`. `notes` are plain strings only.
 *   - No `Note:` prefix on notes. The recall-side note formatters
 *     return prose with the `Note:` prefix; the wire projection
 *     strips the prefix.
 *   - No model / provider metadata.
 *   - No raw input.
 *
 * Schema note: the MCP SDK's `normalizeObjectSchema` only
 * recognizes Zod v3 object schemas (it reads `.shape`). A Zod
 * discriminated union is not recognized and would be silently
 * dropped from the wire tool list. We use a strict Zod object
 * schema with all per-status fields optional. The wire
 * `outputSchema` is a single-object schema that documents the
 * union shape; the `status` field is the discriminator. The
 * actual `structuredContent` payload the tool returns is the
 * per-status object the projection helper builds; clients use
 * the `status` field to discriminate. The `strict()` modifier
 * rejects unknown keys so accidental internal-field leakage is
 * caught at validation time.
 */
import { z } from "zod";

/** The set of valid `status` values for the `recall` tool. */
export const RECALL_STATUS_VALUES = [
  "answered",
  "no_memory",
  "rejected",
  "provider_error",
] as const;
export type RecallStatusValue = (typeof RECALL_STATUS_VALUES)[number];

/**
 * Zod schema for the `recall` tool's `structuredContent`.
 *
 * `.strict()` is critical: it makes the SDK's output validation
 * reject any unknown key, so internal fields like `memoryId`,
 * `sourceIds`, `message`, etc. would be caught if they ever
 * leaked into the structuredContent payload.
 */
export const RECALL_STRUCTURED_CONTENT_SCHEMA = z
  .object({
    status: z.enum(RECALL_STATUS_VALUES),
    // answered
    answer: z.string().optional(),
    notes: z.array(z.string()).optional(),
    // rejected / provider_error
    reason: z.string().optional(),
  })
  .strict();

/** TypeScript type for the validated `structuredContent`. */
export type RecallStructuredContent = z.infer<
  typeof RECALL_STRUCTURED_CONTENT_SCHEMA
>;
