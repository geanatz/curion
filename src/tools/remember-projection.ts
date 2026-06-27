/**
 * Wire-format projection for the `remember` tool.
 *
 * The `formatOutcome` function in `src/tools/remember.ts`
 * produces the tool-layer `RememberResult` (with `message`,
 * `memoryId`, `memoryKind`, `modelId`, `confidence`,
 * `summary`, `safetyClass`, `clarification`, etc.). The MCP
 * `text` content block and the MCP `structuredContent` are
 * derived from that result by this module. The projection is
 * the single place where the user-approved wire shape is
 * enforced:
 *
 *   - The on-the-wire `text` for the `saved` case is
 *     `Saved memory (kind, confidence X.XX): <summary>` (the
 *     existing `RememberResult.message` form; the saved
 *     memory id is NEVER in the public text).
 *   - The on-the-wire `text` for the other statuses
 *     (`rejected`, `provider_error`) is the existing
 *     `RememberResult.message` form.
 *   - The `structuredContent` is the user-approved
 *     discriminated shape (see
 *     `src/tools/remember-structured-content.ts`).
 *
 * No `Note:` prefix is involved on the remember side; the
 * tool-layer's `formatOutcome` for the `saved` case already
 * uses prose-only text without the prefix. The other
 * statuses use `Rejected: ...` / `Provider error: ...`,
 * none of which contain a `Note:` prefix.
 */

import type { RememberResult } from "./remember.js";
import type { RememberStructuredContent } from "./remember-structured-content.js";

/**
 * Build the per-status public `text` for the `remember` tool.
 *
 * The on-the-wire `text` is unchanged from
 * `RememberResult.message` for all three non-saved statuses.
 * The function exists to keep the wire-projection interface
 * parallel to `buildRecallPublicText` (the recall tool's
 * wire text needs more work because of the note prefix;
 * the remember tool's wire text is already clean).
 */
export function buildRememberPublicText(result: RememberResult): string {
  return result.message;
}

/**
 * Build the per-status `structuredContent` for the `remember`
 * tool.
 *
 * User-approved shape (Phase clean-structured-tool-responses):
 *   - `saved`               -> { status, summary, kind, confidence? }
 *   - `rejected`            -> { status, reason, clarification? }
 *   - `provider_error`      -> { status, reason }
 *
 * The `summary` is the controller-normalized provider
 * summary; the `kind` is the internal `MemoryKind` enum
 * value; the `confidence` is the provider's confidence
 * (numeric, optional). No memory id, no model / provider
 * metadata, no raw input.
 *
 * `confidence` is preserved on `saved` because it is already
 * user-visible / useful (it is the only numeric field the
 * provider-normalized save surface exposes, and the remember
 * tool's public text already says "Saved memory (kind,
 * confidence X.XX): ..."). Stripping it would be a needless
 * regression.
 *
 * The `clarification` field appears on `rejected` when the
 * input had self-conflicting or low-confidence signals that
 * could be resolved with a rephrase. Provider errors never
 * carry clarification.
 */
export function buildRememberStructuredContent(
  result: RememberResult,
): RememberStructuredContent {
  switch (result.status) {
    case "saved": {
      const out: RememberStructuredContent = {
        status: "saved",
        summary: result.summary ?? "",
        kind: result.memoryKind ?? "",
      };
      if (
        typeof result.confidence === "number" &&
        Number.isFinite(result.confidence)
      ) {
        out.confidence = result.confidence;
      }
      return out;
    }
    case "rejected": {
      const reason = stripRejectedPrefix(result.message);
      const out: RememberStructuredContent = { status: "rejected", reason };
      if (result.clarification) {
        out.clarification = result.clarification;
      }
      return out;
    }
    case "provider_error": {
      const reason = stripProviderErrorPrefix(result.message);
      return { status: "provider_error", reason };
    }
  }
}

function stripRejectedPrefix(message: string): string {
  if (typeof message !== "string") return "";
  if (message.startsWith("Rejected: ")) return message.slice("Rejected: ".length);
  return message;
}

function stripProviderErrorPrefix(message: string): string {
  if (typeof message !== "string") return "";
  if (message.startsWith("Provider error: ")) {
    return message.slice("Provider error: ".length);
  }
  return message;
}
