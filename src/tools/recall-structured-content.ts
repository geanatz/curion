/**
 * Public MCP `structuredContent` schema for the `recall` tool.
 *
 * User-approved shape (Phase clarification-field-redesign):
 *   - answered:            { status: "answered", answer: string, notes?: string[], source?: "local"|"cross_project" }
 *   - weak_match:          { status: "weak_match", summaries: string[], coverage: { topScore: number, supportingCount: number }, clarification_needed?: Clarification }
 *   - no_memory:           { status: "no_memory", clarification_needed?: Clarification }
 *   - rejected:            { status: "rejected", reason: string, clarification_needed?: Clarification }
 *   - provider_error:      { status: "provider_error", reason: string }
 *
 * Rules:
 *   - No `message` field on the structured payload.
 *   - No memory ids (`memoryId`, `sourceIds`, `memoryIds`) on
 *     the structured payload. The no-IDs rule is enforced at
 *     the schema level: there is no id-bearing field on any
 *     status variant. The `weak_match.summaries` field is a
 *     `string[]` (each entry is plain curator-voice prose, no
 *     id-bearing child objects), and the `weak_match.coverage`
 *     block has no id fields. A future curator summary that
 *     contains an id reference in its prose would have the
 *     same write-path source as the existing `answered.answer`
 *     field; the schema does not sanitize summary content,
 *     but the no-IDs rule is consistent across the tool
 *     surface (a curator that wrote `#N` into a summary would
 *     surface that text on both the `answered` and
 *     `weak_match` paths).
 *   - No note `type` / `severity`. `notes` are plain strings only.
 *   - No `Note:` prefix on notes. The recall-side note formatters
 *     return prose with the `Note:` prefix; the wire projection
 *     strips the prefix.
 *   - No model / provider metadata.
 *   - No raw input.
 *   - `clarification_needed` is an optional field, NEVER a
 *     status. It appears only on user-intent uncertainty
 *     outcomes (no_memory, weak_match, rejected with rephrase
 *     potential). Provider errors never carry
 *     `clarification_needed`.
 *
 * `reason` is the common field for human/agent-readable
 * explanation (on `rejected` / `provider_error`). The
 * `clarification_needed.question` is the user-facing prompt
 * the agent should ask when present; `suggestions` is an
 * optional rephrase-hint list, present only when useful.
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
import { CLARIFICATION_SCHEMA } from "./remember-structured-content.js";

/** The set of valid `status` values for the `recall` tool. */
export const RECALL_STATUS_VALUES = [
  "answered",
  "weak_match",
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
export const RECALL_SOURCE_VALUES = ["local", "cross_project"] as const;
export type RecallSourceValue = (typeof RECALL_SOURCE_VALUES)[number];

export const RECALL_STRUCTURED_CONTENT_SCHEMA = z
  .object({
    status: z.enum(RECALL_STATUS_VALUES),
    // answered
    answer: z.string().optional(),
    notes: z.array(z.string()).optional(),
    // source: indicates where the answer came from
    // "local" = from the current project's own memory (default when answered)
    // "cross_project" = promoted to answered based on cross-project recall
    source: z.enum(RECALL_SOURCE_VALUES).optional(),
    // weak_match
    summaries: z.array(z.string()).optional(),
    coverage: z
      .object({
        topScore: z.number(),
        supportingCount: z.number(),
      })
      .optional(),
    // no_memory / weak_match / rejected: optional
    // clarification_needed field (NEVER a status, NEVER on
    // provider_error). The agent-facing reason for WHY
    // clarification is needed lives on the parent `reason`
    // field; the clarification object only carries the
    // user-facing question and optional rephrase hints.
    clarification_needed: CLARIFICATION_SCHEMA.optional(),
    // rejected / provider_error
    reason: z.string().optional(),
  })
  .strict();

/** TypeScript type for the validated `structuredContent`. */
export type RecallStructuredContent = z.infer<
  typeof RECALL_STRUCTURED_CONTENT_SCHEMA
>;
