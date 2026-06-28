/**
 * Answer-quality scaffold for the retrieval benchmark.
 *
 * This module is the placeholder for future answer-quality
 * evaluation. It does NOT run an LLM judge, it does NOT call
 * a provider, and it does NOT score generated answers in this
 * phase. The runner imports `buildAnswerQualityScaffold`
 * from this module and includes the returned scaffold in the
 * JSON + human reports with `enabled: false` and a stable
 * "not evaluated" note.
 *
 * Why this lives in its own file:
 *   - It is the only benchmark module that the runner
 *     imports but does not exercise in this phase. Keeping
 *     it isolated makes the disabled state easy to spot in
 *     a code review and easy to enable later by replacing
 *     `buildAnswerQualityScaffold` with a judge call.
 *   - The shape of `AnswerQualityScaffold` and
 *     `AnswerQualityEvaluation` is defined in `metrics.ts`
 *     so the type can be referenced from the runner's
 *     report interface. This file re-exports the types and
 *     adds the constructor and a small future-facing
 *     helper.
 *
 * Safety:
 *   - No credentials, no Authorization headers, no live
 *     network.
 *   - The scaffold is read-only at the consumer end; the
 *     runner only reads `enabled` and `note` to render the
 *     human report.
 *
 * Future shape (intentionally NOT implemented):
 *   - `evaluateAnswerQuality(query, generatedAnswer,
 *     sourceIds, judge): AnswerQualityEvaluation` — a
 *     provider call that returns a faithfulness label
 *     (e.g. "faithful" | "partial" | "off-topic" |
 *     "refusal") and a numeric score in [0, 1]. The
 *     function will require an injected judge so the
 *     benchmark stays pure and testable.
 *   - The runner will call it for `family !== "no-answer"`
 *     queries, populate `AnswerQualityScaffold.evaluations`
 *     with one entry per query, and aggregate the labels
 *     into a `qualityPassRate` / `qualityPartialRate` /
 *     `qualityOffTopicRate` triple in the metrics block.
 */

import type { AnswerQualityEvaluation, AnswerQualityScaffold } from "./metrics.js";

export type { AnswerQualityEvaluation, AnswerQualityScaffold };

/**
 * Construct a disabled scaffold. The runner always calls
 * this in this phase. A future phase can extend the
 * constructor to take a `judge` and return an enabled
 * scaffold; the public signature stays stable.
 */
export function buildAnswerQualityScaffold(options: { note?: string } = {}): AnswerQualityScaffold {
  return {
    enabled: false,
    provider: null,
    evaluations: null,
    note:
      options.note ??
      "answer-quality evaluation is scaffolded but disabled in this phase. " +
        "No provider / LLM judge is invoked; generated answers are not scored.",
  };
}

/**
 * Stable label for the "answer quality disabled" section of
 * the human report. A reviewer who greps the report for this
 * string can confirm the scaffold is intentionally off.
 * Exported so the report formatter and the tests share a
 * single source of truth.
 */
export const ANSWER_QUALITY_DISABLED_LABEL =
  "answer-quality: disabled (scaffold only, no LLM judge)";

/**
 * Reserved label set for future answer-quality evaluations.
 * The runner does NOT use these in this phase; they are
 * exported so a future judge implementation can hand back
 * one of the reserved labels without a stringly-typed
 * schema.
 */
export const ANSWER_QUALITY_LABELS: ReadonlySet<string> = new Set([
  "faithful",
  "partial",
  "off-topic",
  "refusal",
  "unsupported",
]);

/**
 * Helper to build a single `AnswerQualityEvaluation`. Used
 * by future judge implementations; exported now so the type
 * is round-trippable from a test.
 */
export function makeAnswerQualityEvaluation(
  queryId: string,
  label: string,
  score: number,
  reason: string
): AnswerQualityEvaluation {
  return { queryId, label, score, reason };
}
