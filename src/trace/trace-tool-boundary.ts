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
import {
  updateTraceRun,
  writeTraceEvent,
  writeTraceRun,
} from "./trace-writer.js";

// ---------------------------------------------------------------------------
// Event kind tags
// ---------------------------------------------------------------------------

/** Kind tag for the public tool input event. */
export const TOOL_INPUT_KIND = "tool.input" as const;
/** Kind tag for the public tool output event. */
export const TOOL_OUTPUT_KIND = "tool.output" as const;

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
export function startToolBoundaryTrace(
  options: StartToolBoundaryTraceOptions,
): ToolBoundaryTracer {
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
