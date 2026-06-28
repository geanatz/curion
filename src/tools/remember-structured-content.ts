/**
 * Public MCP `structuredContent` schema for the `remember` tool.
 *
 * User-approved shape (Phase clarification-field-redesign):
 *   - saved:               { status: "saved", summary: string, kind: string, confidence?: number }
 *   - rejected:            { status: "rejected", reason: string, clarification_needed?: Clarification }
 *   - provider_error:      { status: "provider_error", reason: string }
 *
 * Rules:
 *   - No `message` field on the structured payload.
 *   - No memory id (`memoryId`) on the structured payload.
 *   - No model / provider metadata (`modelId`, `providerId`) on
 *     the structured payload.
 *   - No raw input.
 *   - `clarification_needed` is an optional field, NEVER a
 *     status. It appears only on user-intent uncertainty
 *     outcomes (rejected for self-conflict / low-confidence).
 *     Provider errors never carry clarification.
 *
 * `reason` is the common field for human/agent-readable
 * explanation (on `rejected` / `provider_error`). The
 * `clarification_needed.question` is the user-facing prompt
 * the agent should ask when present; `suggestions` is an
 * optional rephrase-hint list, present only when useful.
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
 * Structured `clarification_needed` payload for user-intent
 * uncertainty.
 *
 * Appears as the optional `clarification_needed` field on
 * `rejected` outcomes (and on `no_memory` / `weak_match` /
 * `rejected` on `recall`) when the input has ambiguous,
 * self-conflicting, or low-confidence signals that could be
 * resolved with a rephrase. Provider errors never carry
 * `clarification_needed`.
 *
 * Shape (strict):
 *   - `question`    : required user-facing prompt; the agent
 *                     asks the user this verbatim.
 *   - `suggestions` : optional list of concrete rephrase hints;
 *                     present only when useful.
 *
 * The agent-facing explanation for WHY `clarification_needed`
 * is set lives on the parent object's `reason` field (common
 * across `rejected` / `provider_error`). It is intentionally
 * NOT duplicated inside the clarification object — the parent
 * `reason` is the single source of truth for the explanation.
 */
export const CLARIFICATION_SCHEMA = z
  .object({
    question: z.string(),
    suggestions: z.array(z.string()).optional(),
  })
  .strict();

/** TypeScript type for the clarification object. */
export type Clarification = z.infer<typeof CLARIFICATION_SCHEMA>;

/** The set of valid `status` values for the `remember` tool. */
export const REMEMBER_STATUS_VALUES = ["saved", "rejected", "provider_error"] as const;
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
    // clarification_needed: optional on user-intent-uncertainty
    // outcomes (rejected); NEVER on provider_error. Strict Zod
    // object schema; the field name matches the wire contract.
    clarification_needed: CLARIFICATION_SCHEMA.optional(),
    // provider_error (no clarification_needed)
  })
  .strict();

/** TypeScript type for the validated `structuredContent`. */
export type RememberStructuredContent = z.infer<typeof REMEMBER_STRUCTURED_CONTENT_SCHEMA>;
