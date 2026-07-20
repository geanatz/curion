/**
 * Trace enable switch.
 *
 * Privacy contract: tracing is disabled by default. It is enabled only by an
 * explicit, allowlisted CURION_TRACE_ENABLED value. Disabled tracing never
 * opens the trace database or performs trace I/O.
 */
const ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/**
 * Returns true only when CURION_TRACE_ENABLED is an explicit allowlisted value.
 * Unset, empty, whitespace-only, unknown, and false-like values are disabled.
 */
export function isTraceEnabled(): boolean {
  const raw = process.env.CURION_TRACE_ENABLED;
  if (typeof raw !== "string") return false;
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}
