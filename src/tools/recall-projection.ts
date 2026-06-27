/**
 * Wire-format projection for the `recall` tool.
 *
 * The `formatOutcome` function in `src/tools/recall.ts` produces
 * the tool-layer `RecallResult` (with `message`, `answer`,
 * `sourceIds`, `notes`, etc.). The MCP `text` content block and
 * the MCP `structuredContent` are derived from that result by
 * this module. The projection is the single place where the
 * user-approved wire shape is enforced:
 *
 *   - The on-the-wire `text` for the `answered` case is the
 *     plain synthesized answer, optionally preceded by the
 *     note(s) joined with a blank line. Notes have the literal
 *     `Note:` prefix stripped (the recall-side formatters
 *     return prose that starts with `Note: `; the wire text
 *     does not).
 *   - The on-the-wire `text` for `no_memory` / `rejected` /
 *     `provider_error` is unchanged from `RecallResult.message`.
 *   - The `structuredContent` is the user-approved
 *     discriminated shape (see
 *     `src/tools/recall-structured-content.ts`).
 *
 * The note formatters themselves (`formatAmbiguityNote` and
 * `formatResolvedHistoryNote`) are not modified by this
 * phase. Their existing tests continue to pin the `Note: `
 * prefix in the formatter output. The prefix is dropped at
 * the wire-projection boundary only.
 */

import type { RecallResult } from "./recall.js";
import type { RecallStructuredContent } from "./recall-structured-content.js";

/**
 * Strip the literal `Note:` prefix (and a single leading space)
 * from a single note string. Defensive: returns the input
 * unchanged if the prefix is absent or the input is not a
 * string.
 */
function stripNotePrefix(note: string): string {
  if (typeof note !== "string") return note;
  // The note formatters emit "Note: <prose>." (with a single
  // space after the colon). We strip "Note:" plus optional
  // trailing whitespace. Other leading-whitespace patterns are
  // preserved.
  if (/^Note:\s*/.test(note)) {
    return note.replace(/^Note:\s*/, "");
  }
  return note;
}

/**
 * Build the per-status public `text` for the `recall` tool.
 *
 * User-approved rule (Phase clean-structured-tool-responses):
 *   - `answered` with notes: notes (without `Note:` prefix)
 *     joined with a blank line, then a blank line, then the
 *     synthesized answer.
 *   - `answered` without notes: the synthesized answer.
 *   - `no_memory`: "No relevant memory found." (the existing
 *     `NO_RELEVANT_MEMORY` placeholder).
 *   - `rejected`: "Rejected: <reason>" (the existing
 *     `RecallResult.message`; the `reason` does not echo the
 *     query).
 *   - `provider_error`: "Provider error: <reason>" (the
 *     existing `RecallResult.message`).
 *
 * The function is pure: it reads `result` and returns a
 * string. It does not log, persist, or call the controller.
 */
export function buildRecallPublicText(result: RecallResult): string {
  switch (result.status) {
    case "answered": {
      const answer = result.answer ?? "";
      const cleanNotes = (result.notes ?? [])
        .map((n) => stripNotePrefix(n))
        .filter((n) => typeof n === "string" && n.length > 0);
      if (cleanNotes.length === 0) {
        return answer;
      }
      return `${cleanNotes.join("\n\n")}\n\n${answer}`;
    }
    case "weak_match":
    case "no_memory":
    case "rejected":
    case "provider_error":
      return result.message;
  }
}

/**
 * Build the per-status `structuredContent` for the `recall`
 * tool.
 *
 * User-approved shape (Phase clean-structured-tool-responses):
 *   - `answered`          -> { status, answer, notes?, source? }
 *   - `weak_match`        -> { status, summaries, coverage, clarification? }
 *   - `no_memory`         -> { status, clarification? }
 *   - `rejected`          -> { status, reason, clarification? }
 *   - `provider_error`    -> { status, reason }
 *
 * The `reason` field is the redacted, non-echoing reason from
 * the controller. The `notes` field is an array of plain
 * strings (no `Note:` prefix, no note `type` / `severity`).
 * The `weak_match.summaries` field is the controller's top-3
 * curator-voice summaries (plain strings, no memory-id
 * reference); the `coverage` block carries the raw lexical
 * top-score and the supporting candidate count. No memory
 * ids are included in any shape.
 *
 * The `clarification` field appears on `no_memory`,
 * `weak_match`, and `rejected` when the controller detected
 * user-intent uncertainty that could be resolved with a
 * rephrase. Provider errors never carry clarification.
 */
export function buildRecallStructuredContent(
  result: RecallResult,
): RecallStructuredContent {
  switch (result.status) {
    case "answered": {
      const notes = (result.notes ?? [])
        .map((n) => stripNotePrefix(n))
        .filter((n) => typeof n === "string" && n.length > 0);
      const out: RecallStructuredContent = {
        status: "answered",
        answer: result.answer ?? "",
      };
      if (notes.length > 0) {
        out.notes = notes;
      }
      return out;
    }
    case "weak_match": {
      // `summaries` and `coverage` are guaranteed populated
      // by `formatOutcome` for this status. We defensively
      // default to empty arrays / zero coverage so a
      // malformed input does not leak `undefined` onto the
      // wire (the Zod schema rejects `undefined` for these
      // fields).
      const summaries = result.summaries ?? [];
      const coverage = result.coverage ?? {
        topScore: 0,
        supportingCount: 0,
      };
      const out: RecallStructuredContent = {
        status: "weak_match",
        summaries: [...summaries],
        coverage: {
          topScore: coverage.topScore,
          supportingCount: coverage.supportingCount,
        },
      };
      if (result.clarification) {
        out.clarification = result.clarification;
      }
      return out;
    }
    case "no_memory": {
      const out: RecallStructuredContent = { status: "no_memory" };
      if (result.clarification) {
        out.clarification = result.clarification;
      }
      return out;
    }
    case "rejected": {
      // The public `message` is "Rejected: <reason>". Strip the
      // "Rejected: " prefix to extract the `reason`.
      const reason = stripRejectedPrefix(result.message);
      const out: RecallStructuredContent = { status: "rejected", reason };
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
