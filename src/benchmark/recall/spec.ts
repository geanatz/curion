/**
 * Scripted provider specification for the recall-policy
 * evaluation harness.
 *
 * The recall-policy evaluation harness (v1) wires a
 * scripted `fetch` override into the benchmark-only recall-
 * policy adapter and uses `ScriptedRecallProviderSpec` to
 * declare the canned response shape per scenario. The
 * harness deliberately keeps the spec narrow so a
 * reviewer reading a scenario can predict the adapter's
 * behaviour without tracing the per-call state machine.
 *
 * The recall-policy adapter (benchmark-only) follows the
 * existing production recall adapter's primary → repair →
 * fallback → fallback-repair state machine. The harness
 * honors that:
 *
 *   1. Primary call       — returns the canned `primaryResponse`
 *                           (or hard-failure on `primaryHardFailure`).
 *   2. Primary repair     — only invoked when the primary
 *                           response fails to parse / validate
 *                           (i.e. is not a valid `RecallPolicyDecision`
 *                           JSON shape). Returns `repairResponse`.
 *   3. Fallback call      — only when the primary call's HTTP
 *                           response was a hard failure (5xx / 4xx /
 *                           transport error) AND a `fallback` slot is
 *                           configured. Returns `fallback.firstResponse`.
 *   4. Fallback repair    — only when the fallback response fails
 *                           to parse / validate. Returns
 *                           `fallback.repairResponse`.
 *
 * The benchmark-only adapter is intentionally simpler than
 * the decision-policy adapter (which carries an openai /
 * anthropic branching and a wider repair contract). The
 * recall adapter is plain-text-but-still-structured: it asks
 * the model for a JSON `RecallPolicyDecision` object and
 * parses it with the canonical parser / repair helper.
 *
 * Why this lives in `src/benchmark/recall/spec.ts` (not in
 * `src/decision/`):
 *
 *   The decision-policy schemas live in
 *   `src/decision/types.ts` because they are part of the
 *   Phase-1 Shadow engine contract. The recall-policy
 *   evaluation does NOT have a production engine yet —
 *   this benchmark ships ahead of one. The schemas and the
 *   adapter live strictly under `src/benchmark/recall/` so a
 *   production import-guard test catches accidental leakage.
 *   A future Phase that adds a production recall-policy
 *   adapter can lift these schemas into a server-internal
 *   module, at which point the harness migrates to consume
 *   that module.
 */

/**
 * A single canned provider response for the
 * recall-policy evaluation harness. The `*Response`
 * fields are the literal text the scripted fetch
 * returns. The `*HardFailure` fields flip the scripted
 * fetch for that call to a 503 with an empty error body,
 * mirroring a real upstream failure.
 */
export interface ScriptedRecallProviderSpec {
  /**
   * Response body the primary provider returns on its
   * FIRST call. Mutually exclusive with `primaryHardFailure`.
   * The body is the standard chat-completions JSON
   * envelope; the harness extracts the assistant message
   * content verbatim and parses it against
   * `RecallPolicyDecisionSchema`.
   */
  primaryResponse?: string;
  /**
   * `true` to make the primary provider return a 5xx
   * on its first call (provider hard failure). Mutually
   * exclusive with `primaryResponse`.
   */
  primaryHardFailure?: boolean;
  /**
   * Response body the primary provider returns on the
   * SAME-PROVIDER REPAIR call. The repair call only runs
   * when the first response failed to parse / validate.
   */
  repairResponse?: string;
  /**
   * Fallback provider configuration. When set, the
   * adapter restarts on the fallback after the primary
   * hard-fails. When omitted, no fallback is configured
   * and the adapter returns `provider_error` on primary
   * hard failure.
   */
  fallback?: {
    /** Fallback first call response body. */
    firstResponse?: string;
    /** `true` to make the fallback return a 5xx. */
    hardFailure?: boolean;
    /** Fallback repair call response body. */
    repairResponse?: string;
  };
}
