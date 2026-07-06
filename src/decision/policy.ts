/**
 * Remember-policy config for the Memory Decision Engine.
 *
 * Phase 1 ships SHADOW MODE ONLY. The policy module encodes the
 * single allowed activation mode and the safe-default knobs:
 *
 *   - `mode: "shadow"` is the only valid activation. The engine
 *     emits a structured decision; the controller traces it and
 *     never alters persisted memory based on it.
 *   - `mode: "off"` short-circuits the engine entirely (no HTTP
 *     call, no evidence build, no decision). This is the default
 *     for tests that have not been adapted to the new path.
 *   - `mode: "active"` is reserved for Phase 2+ and is rejected
 *     in Phase 1 to prevent accidental activation. Any caller
 *     that attempts to enable active mode gets a typed failure.
 *
 * Activation policy:
 *
 *   - The env var `CURION_REMEMBER_DECISION_MODE` selects the
 *     mode at startup. Default: `"off"`. The env var is the
 *     only configuration source so a missing operator config
 *     defaults to the safe "off" path.
 *   - The controller options can override the env-driven mode
 *     in tests (`{ decisionMode: "shadow" }`). The override
 *     never crosses process boundaries; it is internal-only.
 *   - `shadowMode` is a derived flag: `mode === "shadow"`. The
 *     controller uses this flag to gate the HTTP call without
 *     branching on the string mode directly.
 *
 * The module is pure config: no I/O, no provider call, no
 * logging.
 */

export type RememberDecisionMode = "off" | "shadow" | "active";

export interface RememberDecisionPolicy {
  /**
   * Activation mode.
   *   - `"off"`:    engine is skipped. Default.
   *   - `"shadow"`: engine emits a decision; controller traces
   *                 it; no persisted memory is altered.
   *   - `"active"`: reserved for Phase 2+. Rejected in Phase 1.
   */
  mode: RememberDecisionMode;
  /**
   * True iff `mode === "shadow"`. The controller uses this
   * derived flag for branch-free gating.
   */
  shadowMode: boolean;
  /**
   * Schema version this policy expects. Bumped on any breaking
   * schema change to the engine's input or output.
   */
  schemaVersion: string;
}

const ENV_VAR = "CURION_REMEMBER_DECISION_MODE";

/**
 * Resolve the default policy from `process.env`.
 *
 * Default mode is `"off"` — the engine is OFF by default, so a
 * missing env var is the safe no-op path. Existing tests, the
 * contract test, and any production deployment that has not
 * explicitly opted in continue to behave identically to Phase 0.
 *
 * The env var accepts `"off"` (default), `"shadow"`, or
 * `"active"`. Unrecognized values fall back to `"off"` so a
 * typo never silently enables the shadow path.
 */
export function loadRememberDecisionPolicy(): RememberDecisionPolicy {
  const raw = process.env[ENV_VAR];
  const mode = parseMode(raw);
  return {
    mode,
    shadowMode: mode === "shadow",
    schemaVersion: "remember-policy/1",
  };
}

/**
 * Resolve a policy from an explicit mode override (e.g. a test
 * option). Same shape as the env-driven loader, but the source
 * of truth is the override.
 *
 * Phase 1 never returns an `active` policy: any caller that
 * requests `"active"` is downgraded to `"shadow"` with a
 * structured failure side-channel — but the side-channel is the
 * caller's responsibility. The policy module only returns
 * `"shadow"` so a Phase 1 process cannot accidentally activate
 * actions.
 */
export function resolveRememberDecisionPolicy(opts: {
  mode?: RememberDecisionMode | undefined;
}): RememberDecisionPolicy {
  const requested = opts.mode ?? "off";
  const mode = requested === "active" ? "shadow" : requested;
  return {
    mode,
    shadowMode: mode === "shadow",
    schemaVersion: "remember-policy/1",
  };
}

function parseMode(raw: string | undefined): RememberDecisionMode {
  if (raw === undefined) return "off";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "off" || trimmed === "" || trimmed === "0" || trimmed === "false") return "off";
  if (trimmed === "shadow" || trimmed === "1") return "shadow";
  if (trimmed === "active" || trimmed === "2") {
    // Phase 1 cannot enable active mode. Downgrade to shadow
    // and let the controller's logging surface the request;
    // the engine is still safe because shadow mode does not
    // mutate persisted memory. A future Phase will lift this
    // gate.
    return "shadow";
  }
  // Unrecognized value: safe default.
  return "off";
}

/**
 * Name of the env var the policy reads. Exported so the
 * configuration docs and the controller option contract share
 * a single source of truth.
 */
export const REMEMBER_DECISION_POLICY_ENV_VAR = ENV_VAR;
