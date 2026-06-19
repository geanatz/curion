/**
 * Curion Local Trace — Phase 1 foundation.
 *
 * This module is the single import point for trace infrastructure.
 * It does NOT add tool-call capture: there is no instrumented
 * path that writes to the trace DB from the live `remember` /
 * `recall` flow yet. The writers and the schema exist so later
 * phases can attach a small redacting interceptor to the
 * provider HTTP client and the controller layers.
 *
 * What Phase 1 ships:
 *   - A separate `.curion/trace.sqlite` database, owned by this
 *     module, with its own `_meta` table and forward-compatible
 *     `trace_runs` / `trace_events` tables. The memory DB
 *     (`.curion/curion.sqlite`) is untouched.
 *   - A `CURION_TRACE_ENABLED` off switch (default: enabled).
 *   - A central, recursive, schema-agnostic `redactPayload` that
 *     strips credentials, reasoning / CoT fields, URL basic-auth
 *     credentials, and `` blocks.
 *   - A non-throwing writer API (`writeTraceRun`,
 *     `writeTraceEvent`, `updateTraceRun`, list helpers).
 *   - Retention / purge helpers with a 30-day default window.
 *
 * Public surface — re-exported here so callers have a single
 * import.
 */

export {
  redactPayload,
  redactString,
  REASONING_BLOCK_PATTERN_EXPORT,
  REASONING_KEY_PATTERNS_EXPORT,
  SENSITIVE_KEY_PATTERNS_EXPORT,
  type RedactOptions,
} from "./trace-redaction.js";

export {
  CURION_TRACE_DB_FILENAME,
  TRACE_SCHEMA_VERSION,
  initTraceStorage,
  closeTraceStorage,
  resolveTraceDbPath,
  type TraceStorageHandle,
} from "./trace-storage.js";

export { isTraceEnabled } from "./trace-enabled.js";

export {
  getOrInitTraceWriter,
  closeTraceWriter,
  writeTraceRun,
  writeTraceEvent,
  updateTraceRun,
  listTraceRuns,
  listTraceEventsForRun,
  resetTraceWriterForTests,
  type TraceRunInput,
  type TraceRunPatch,
  type TraceRunRow,
  type TraceRunStatus,
  type TraceEventInput,
  type TraceEventRow,
} from "./trace-writer.js";

export {
  DEFAULT_TRACE_MAX_AGE_MS,
  purgeTraceRunsOlderThan,
  purgeAllTraceRuns,
  type PurgeResult,
  type PurgeOptions,
} from "./trace-retention.js";
