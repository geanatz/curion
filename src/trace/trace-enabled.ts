/**
 * Trace enable / disable switch.
 *
 * Phase 1 contract:
 *   - Tracing is ON by default. The trace storage module is
 *     lazily initialized on first use, and the writer API is a
 *     no-op when disabled.
 *   - Tracing can be turned OFF via the environment variable
 *     `CURION_TRACE_ENABLED`. The following case-insensitive
 *     values turn tracing OFF: `0`, `false`, `no`, `off`. Any
 *     other value (including the empty string) leaves tracing
 *     ON. This matches common CLI / env-flag conventions
 *     (`CURION_*_ENABLED=0` is the documented off switch).
 *   - The check is computed at call time so tests can flip the
 *     switch by mutating `process.env` between calls.
 *
 * The switch is intentionally separate from the storage handle.
 * The writer asks `isTraceEnabled()` before doing any work, so a
 * disabled trace never opens a DB connection and never touches
 * the filesystem.
 */

/** Names of environment variables whose value disables tracing. */
const OFF_VALUES: ReadonlySet<string> = new Set([
  "0",
  "false",
  "no",
  "off",
]);

/**
 * True if the trace writer should be active. Reads
 * `process.env.CURION_TRACE_ENABLED` at call time. Defaults to
 * `true` (enabled) when the variable is unset or has any value
 * other than the recognized off values.
 */
export function isTraceEnabled(): boolean {
  const raw = process.env.CURION_TRACE_ENABLED;
  if (typeof raw !== "string") return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !OFF_VALUES.has(v);
}
