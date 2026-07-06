/**
 * Scripted provider specification for the decision-policy
 * evaluation harness.
 *
 * The harness wires a `scriptedProviderSpec` directly into the
 * decision adapter via the `fetchImpl` override seam. The spec is
 * intentionally declarative so a reviewer can read a scenario
 * and predict the adapter's behaviour without tracing the
 * per-call state machine.
 *
 * Per-call state machine (mirrors `src/decision/adapter.ts`):
 *
 *   1. Primary call       — first scripted response
 *   2. Primary repair     — only when primary's response is
 *                            unparsable / schema-invalid
 *   3. Fallback call      — only when primary's response is a
 *                            hard failure (5xx / 4xx / network)
 *                            AND a fallback is configured
 *   4. Fallback repair    — only when fallback's response is
 *                            unparsable / schema-invalid
 *
 * The harness always wires BOTH primary and fallback fetchImpls
 * so the adapter's full primary → repair → fallback →
 * fallback-repair machine is exercised when the scenario asks
 * for it.
 */

/**
 * Scripted provider behaviour for a single scenario.
 *
 * Each `*Response` field is the literal text the scripted fetch
 * returns on that call (formatted as the body of a chat-
 * completions JSON response, exactly like the controller-
 * integration test stubs).
 *
 * Each `*HardFailure` field flips the scripted fetch for that
 * call to return a 503 with an empty error body, mirroring a
 * real upstream failure.
 */
export interface ScriptedProviderSpec {
  /**
   * Response body the primary provider returns on its FIRST
   * call. Omit when `primaryHardFailure` is `true`.
   */
  primaryFirstResponse?: string;
  /**
   * `true` to make the primary provider return a 5xx on its
   * first call (provider hard failure). Mutually exclusive
   * with `primaryFirstResponse`.
   */
  primaryHardFailure?: boolean;
  /**
   * Response body the primary provider returns on the SAME-
   * PROVIDER REPAIR call. Omit when
   * `primaryRepairHardFailure` is `true`. The repair call is
   * only made when the first response fails to parse / validate.
   */
  primaryRepairResponse?: string;
  /**
   * `true` to make the primary provider return a 5xx on its
   * repair call.
   */
  primaryRepairHardFailure?: boolean;
  /**
   * Fallback provider configuration. When set, the harness
   * wires the fallback into the adapter's options. When
   * omitted, no fallback is configured (the adapter returns
   * `all-providers-failed` on primary hard failure).
   */
  fallback?: {
    /** Response body the fallback provider returns on its first call. */
    firstResponse?: string;
    /** `true` to make the fallback return a 5xx on its first call. */
    hardFailure?: boolean;
    /** Response body the fallback returns on its repair call. */
    repairResponse?: string;
    /** `true` to make the fallback return a 5xx on its repair call. */
    repairHardFailure?: boolean;
  };
}
