/**
 * Curion Local Trace — Phase 2: tool-boundary tracing.
 *
 * This module adds a small helper that turns each public
 * `remember` / `recall` MCP tool invocation into a single trace
 * run with a pair of events (input + output). The writer is the
 * same non-throwing writer the Phase 1 foundation ships, so
 * trace failures NEVER change the tool's result.
 *
 * Scope (Phase 2):
 *   - Instrument the OUTER tool handlers in `src/tools/remember.ts`
 *     and `src/tools/recall.ts`. The controller internals stay
 *     untouched. No provider I/O capture, no controller stage
 *     tracing — those belong to later phases.
 *   - Capture raw tool input (`text`) and the final public tool
 *     output / structured content / status, after redaction via
 *     the existing `writeTraceEvent` -> `redactPayload` path.
 *   - Record the run lifecycle (`in_progress` -> `ok` / `error`)
 *     and the wall-clock duration.
 *   - Respect `CURION_TRACE_ENABLED=0` from Phase 1.
 *
 * NOT in this module:
 *   - Reading the trace. Trace history is never read by
 *     `remember` / `recall`; the writer is one-way.
 *   - Changing the public result shape, status mapping, or the
 *     on-the-wire `text` / `structuredContent` projection. The
 *     tracer reads the result the handler is about to return and
 *     persists it as a `tool.output` event; it never mutates it.
 *   - Any coupling to controller internals. The helper accepts
 *     the public tool name and the raw input; it knows nothing
 *     about safety pre-checks, providers, or storage.
 */

import { isTraceEnabled } from "./trace-enabled.js";
import { updateTraceRun, writeTraceEvent, writeTraceRun } from "./trace-writer.js";

// ---------------------------------------------------------------------------
// Event kind tags
// ---------------------------------------------------------------------------

/** Kind tag for the public tool input event. */
export const TOOL_INPUT_KIND = "tool.input" as const;
/** Kind tag for the public tool output event. */
export const TOOL_OUTPUT_KIND = "tool.output" as const;
// ---------------------------------------------------------------------------
// Recall stage event kind tags (Phase 3A)
// ---------------------------------------------------------------------------
//
// The recall controller emits these stage events from inside its
// memory-read and lexical-ranking code paths. They attach to the
// SAME run opened by `startToolBoundaryTrace` so a reader can
// correlate the per-stage trace with the public `tool.input` and
// `tool.output` events at the top of the run. The vocabulary is
// owned by the trace module; the controller imports the constants
// and never hard-codes the strings.
//
// Phase 3A scope (deliberately narrow):
//   - Instrument the recall controller's memory-read and
//     lexical-ranking code paths only.
//   - Do NOT instrument the remember controller.
//   - Do NOT capture provider I/O.
//   - Do NOT add CLI / export / purge.
//
// Kind tag summary:
//   - `recall.active-memory-read`  - the count of active summaries
//                                   read from storage plus the
//                                   configured `storageLimit`.
//   - `recall.lexical-ranking`     - the query, the ranker
//                                   threshold / topK, and the
//                                   ranked candidates that passed
//                                   the threshold, with id,
//                                   rank, score, overlap, and the
//                                   summary fields the ranker had
//                                   access to (memoryContent,
//                                   kind, tags, classification,
//                                   confidence).
//   - `recall.selected-candidates` - the `topSummaries` the
//                                   controller actually fed to
//                                   the synthesis provider, with
//                                   memory id and memoryContent.
//                                   Useful to compare against
//                                   `recall.lexical-ranking` to
//                                   see which ranked candidates
//                                   were selected vs dropped.
//
// The events are emitted on the tool-boundary run id (the same
// run that carries `tool.input` and `tool.output`). The trace
// writer is the existing non-throwing writer; failures NEVER
// change the recall result.
// ---------------------------------------------------------------------------
/** Kind tag for the recall memory-read stage event. */
export const RECALL_ACTIVE_MEMORY_READ_KIND = "recall.active-memory-read" as const;
/** Kind tag for the recall lexical-ranking stage event. */
export const RECALL_LEXICAL_RANKING_KIND = "recall.lexical-ranking" as const;
/** Kind tag for the recall selected-candidates stage event. */
export const RECALL_SELECTED_CANDIDATES_KIND = "recall.selected-candidates" as const;
/** Kind tag for the recall superseded-demotion stage event. */
export const RECALL_SUPERSEDED_DEMOTION_KIND = "recall.superseded-demotion" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The set of public MCP tool names that participate in tool-boundary
 * tracing. The shape is intentionally narrow; a future phase can
 * extend the union when more tools are traced.
 */
export type TracedToolName = "remember" | "recall";

export interface StartToolBoundaryTraceOptions {
  /** The public tool name (e.g. "remember" or "recall"). */
  toolName: TracedToolName;
  /**
   * Raw tool input as received from MCP. The helper extracts the
   * single public `text` field for the `tool.input` event; other
   * top-level keys are ignored (the public tool schema is strict
   * and only accepts `text`).
   */
  input: unknown;
  /**
   * Override the wall clock for tests. Returns a ms-epoch timestamp.
   * Production callers should leave this unset; the default is
   * `Date.now`.
   */
  clock?: () => number;
}

/**
 * A handle to a tool-boundary trace run. The handle is returned by
 * `startToolBoundaryTrace` and used to record the tool's output
 * and finalize the run. Every method is safe to call; trace
 * failures NEVER throw and NEVER change the tool's result.
 *
 * The handle is a plain object with no required lifecycle: if
 * `finish` is never called, the run is left in `in_progress` state
 * with whatever events were recorded before the tool returned.
 * That is intentional — the writer's "never throw" contract means
 * the tracer can be left half-finished without breaking the
 * caller.
 */
export interface ToolBoundaryTracer {
  /** The public tool name the run is tracking. */
  readonly toolName: TracedToolName;
  /**
   * The run id assigned by the writer, or `null` if no run was
   * created (tracing disabled, writer closed, or write failed).
   * Tests use this to assert against the on-disk trace DB.
   */
  readonly runId: number | null;
  /** The wall-clock start timestamp (ms epoch). */
  readonly startedAt: number;
  /**
   * Record the public tool output. The payload is the same object
   * the handler is about to return; the writer's existing
   * `redactPayload` pass scrubs credentials / reasoning fields
   * before the row is persisted. Safe to call any number of
   * times; each call appends a new event with a monotonically
   * increasing sequence.
   */
  recordOutput(output: unknown): void;
  /**
   * Record a per-stage trace event on the SAME run as the public
   * tool boundary events. Used by the recall controller (Phase 3A)
   * to emit memory-read / lexical-ranking / selected-candidates
   * events that correlate with `tool.input` and `tool.output`.
   *
   * The kind must be a non-empty string. The payload is whatever
   * the caller chooses; it is redacted by the writer's
   * `redactPayload` pass before being persisted, so credentials
   * and reasoning fields are scrubbed. Safe to call any number of
   * times; each call appends a new event with a monotonically
   * increasing sequence. Never throws; when the tracer is a
   * no-op (disabled / writer closed) the call is silently
   * dropped.
   *
   * Phase 3A uses this for recall-only stages. Future phases can
   * add remember-side stages on the same contract.
   */
  recordStage(kind: string, payload: unknown): void;
  /**
   * Finalize the trace run. Updates the run with the end
   * timestamp, the run-level status, and a `durationMs` metadata
   * patch. Idempotent (subsequent calls are no-ops). Safe to
   * call; never throws.
   */
  finish(finalStatus: "ok" | "error"): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Begin a tool-boundary trace run. Always returns a tracer; the
 * tracer is a no-op when tracing is disabled (the
 * `CURION_TRACE_ENABLED=0` switch) or when the writer is unable
 * to open its DB. The function never throws.
 *
 * The `tool.input` event is recorded synchronously here. The
 * caller is responsible for calling `recordOutput` once the
 * controller returns, and `finish` once the handler is done.
 */
export function startToolBoundaryTrace(options: StartToolBoundaryTraceOptions): ToolBoundaryTracer {
  return new ToolBoundaryTracerImpl(options);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ToolBoundaryTracerImpl implements ToolBoundaryTracer {
  readonly toolName: TracedToolName;
  readonly runId: number | null;
  readonly startedAt: number;
  private finished = false;
  private readonly clock: () => number;

  constructor(options: StartToolBoundaryTraceOptions) {
    this.toolName = options.toolName;
    this.clock = options.clock ?? Date.now;
    this.startedAt = this.clock();
    this.runId = this.openRun();
    if (this.runId !== null) {
      // The tool.input event is captured at the boundary, using
      // the same `clock` as the run so test runs are deterministic.
      this.recordEvent(TOOL_INPUT_KIND, {
        text: extractInputText(options.input),
      });
    }
  }

  private openRun(): number | null {
    // `isTraceEnabled` is computed at call time; tests can flip
    // the env switch between cases. When disabled, the writer
    // would also short-circuit, but checking here lets the
    // tracer skip the allocation of the run-metadata object
    // entirely.
    if (!isTraceEnabled()) return null;
    return writeTraceRun({
      name: this.toolName,
      startedAt: this.startedAt,
      metadata: {
        tool: this.toolName,
        boundary: "public-tool-handler",
      },
    });
  }

  private recordEvent(kind: string, payload: unknown): void {
    if (this.runId === null) return;
    writeTraceEvent({
      runId: this.runId,
      ts: this.clock(),
      kind,
      payload,
    });
  }

  recordOutput(output: unknown): void {
    this.recordEvent(TOOL_OUTPUT_KIND, output);
  }

  recordStage(kind: string, payload: unknown): void {
    // `recordEvent` already short-circuits when `runId === null`
    // (tracing disabled / writer closed). The `kind` argument is
    // owned by the caller; the existing tool-boundary events use
    // the module-level `TOOL_INPUT_KIND` / `TOOL_OUTPUT_KIND`
    // constants and the recall-side stages use the
    // `RECALL_*_KIND` constants from this module. We intentionally
    // do NOT validate the kind string here; the writer already
    // rejects empty kinds and the constant-set ownership keeps
    // the vocabulary small. Future stages (e.g. remember-side
    // phases) can add new kind constants alongside the existing
    // ones.
    if (typeof kind !== "string" || kind.length === 0) return;
    this.recordEvent(kind, payload);
  }

  finish(finalStatus: "ok" | "error"): void {
    if (this.finished) return;
    this.finished = true;
    if (this.runId === null) return;
    const endedAt = this.clock();
    // `durationMs` is the wall-clock time the tool handler
    // took. The writer stores the run's `endedAt` separately so
    // the run row carries the exact end timestamp; the
    // `durationMs` is also surfaced in the run's metadata blob
    // for reader convenience.
    const durationMs = Math.max(0, endedAt - this.startedAt);
    updateTraceRun(this.runId, {
      endedAt,
      status: finalStatus,
      metadata: {
        tool: this.toolName,
        boundary: "public-tool-handler",
        durationMs,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the public `text` field from a raw MCP tool input. The
 * public tool schema is strict and only accepts `text`, so we do
 * NOT carry other top-level keys into the trace — anything else
 * is a programmer / SDK-validation error and we ignore it
 * defensively rather than smuggling it into the trace.
 */
function extractInputText(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  if (!("text" in input)) return "";
  const t = (input as { text: unknown }).text;
  return typeof t === "string" ? t : "";
}
