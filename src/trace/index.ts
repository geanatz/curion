/**
 * Curion Local Trace — Phase 1 foundation + Phase 2 tool-boundary
 * helper.
 *
 * Phase 1 ships the storage, the redaction layer, the
 * non-throwing writer, the off switch, and the retention helpers.
 * Phase 2 adds a small helper (`startToolBoundaryTrace`) that
 * the outer `remember` / `recall` tool handlers use to record a
 * run + input/output event pair per public tool invocation. The
 * controller internals stay untouched; the helper is the only
 * new public surface.
 *
 * The trace storage is a separate `.curion/trace.sqlite` database
 * with its own `_meta` table and the `trace_runs` / `trace_events`
 * tables. The memory DB (`.curion/curion.sqlite`) is never
 * touched by this module.
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

export {
  startToolBoundaryTrace,
  TOOL_INPUT_KIND,
  TOOL_OUTPUT_KIND,
  RECALL_ACTIVE_MEMORY_READ_KIND,
  RECALL_LEXICAL_RANKING_KIND,
  RECALL_SELECTED_CANDIDATES_KIND,
  type TracedToolName,
  type StartToolBoundaryTraceOptions,
  type ToolBoundaryTracer,
} from "./trace-tool-boundary.js";
