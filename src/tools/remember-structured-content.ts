/**
 * Public MCP `structuredContent` schema for the `remember` tool.
 *
 * User-approved shape (Phase clean-structured-tool-responses):
 *   - saved:               { status: "saved", summary: string, kind: string, confidence?: number }
 *   - rejected:            { status: "rejected", reason: string, clarification?: Clarification }
 *   - provider_error:      { status: "provider_error", reason: string }
 *
 * Rules:
 *   - No `message` field.
 *   - No memory id (`memoryId`).
 *   - No model / provider metadata (`modelId`, `providerId`).
 *   - No raw input.
 *
 * `confidence` is preserved on `saved` because it is already
 * user-visible / useful (it is the only numeric field the
 * provider-normalized save surface exposes, and the remember
 * tool's public text already says "Saved memory (kind,
 * confidence X.XX): ..."). Stripping it would be a needless
 * regression.
 *
 * Schema note: see `recall-structured-content.ts` for why this
 * is a strict Zod object rather than a Zod discriminated union
 * (the MCP SDK's `normalizeObjectSchema` only recognizes Zod
 * v3 object schemas with a `.shape` property).
 */
import { z } from "zod";

/**
 * Structured clarification object for user-intent uncertainty.
 *
 * Appears on `rejected` outcomes when the input has ambiguous,
 * self-conflicting, or low-confidence signals that could be
 * resolved with a rephrase. Provider/system errors never carry
 * clarification.
 *
 * The `reason` field is agent-facing context (why clarification
 * is needed); `question` is a concise user-facing prompt; and
 * `suggestions` is an optional list of concrete rephrase hints.
 */
export const CLARIFICATION_SCHEMA = z
  .object({
    reason: z.string(),
    question: z.string(),
    suggestions: z.array(z.string()).optional(),
  })
  .strict();

/** TypeScript type for the clarification object. */
export type Clarification = z.infer<typeof CLARIFICATION_SCHEMA>;

/** The set of valid `status` values for the `remember` tool. */
export const REMEMBER_STATUS_VALUES = [
  "saved",
  "rejected",
  "provider_error",
] as const;
export type RememberStatusValue = (typeof REMEMBER_STATUS_VALUES)[number];

/**
 * Zod schema for the `remember` tool's `structuredContent`.
 *
 * `.strict()` is critical: it makes the SDK's output validation
 * reject any unknown key, so internal fields like `memoryId`,
 * `modelId`, `providerId`, `safetyClass`, `message`, etc.
 * would be caught if they ever leaked into the
 * structuredContent payload.
 */
export const REMEMBER_STRUCTURED_CONTENT_SCHEMA = z
  .object({
    status: z.enum(REMEMBER_STATUS_VALUES),
    // saved
    summary: z.string().optional(),
    kind: z.string().optional(),
    confidence: z.number().optional(),
    // rejected
    reason: z.string().optional(),
    clarification: CLARIFICATION_SCHEMA.optional(),
    // provider_error (no clarification)
  })
  .strict();

/** TypeScript type for the validated `structuredContent`. */
export type RememberStructuredContent = z.infer<
  typeof REMEMBER_STRUCTURED_CONTENT_SCHEMA
>;
