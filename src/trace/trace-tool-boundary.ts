import { isTraceEnabled } from "./trace-enabled.js";
import { updateTraceRun, writeTraceEvent, writeTraceRun } from "./trace-writer.js";

/** Event schema used by the metadata-only trace writer. */
export const TRACE_EVENT_SCHEMA_VERSION = 1 as const;

/** Public event kind tags retained for trace database compatibility. */
export const TOOL_INPUT_KIND = "tool.input" as const;
export const TOOL_OUTPUT_KIND = "tool.output" as const;
export const RECALL_ACTIVE_MEMORY_READ_KIND = "recall.active-memory-read" as const;
export const RECALL_LEXICAL_RANKING_KIND = "recall.lexical-ranking" as const;
export const RECALL_SELECTED_CANDIDATES_KIND = "recall.selected-candidates" as const;
export const RECALL_SUPERSEDED_DEMOTION_KIND = "recall.superseded-demotion" as const;

export type TracedToolName = "remember" | "recall";

export interface StartToolBoundaryTraceOptions {
  toolName: TracedToolName;
  /** Retained for MCP call-site compatibility; never persisted. */
  input: unknown;
  clock?: () => number;
}

export interface ToolBoundaryTracer {
  readonly toolName: TracedToolName;
  readonly runId: number | null;
  readonly startedAt: number;
  /** Derives only the bounded public status; never persists output content. */
  recordOutput(output: unknown): void;
  /** Persists only allowlisted metadata selected by the writer. */
  recordStage(kind: string, payload: unknown): void;
  finish(finalStatus: "ok" | "error"): void;
}

/**
 * Starts a metadata-only public-tool trace. Tracing is disabled unless
 * CURION_TRACE_ENABLED is explicitly allowlisted by isTraceEnabled().
 * The input parameter is intentionally ignored: MCP request text must not
 * enter trace storage.
 */
export function startToolBoundaryTrace(options: StartToolBoundaryTraceOptions): ToolBoundaryTracer {
  return new ToolBoundaryTracerImpl(options);
}

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
      this.recordEvent(TOOL_INPUT_KIND, {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        tool: this.toolName,
      });
    }
  }

  private openRun(): number | null {
    if (!isTraceEnabled()) return null;
    return writeTraceRun({
      name: this.toolName,
      startedAt: this.startedAt,
      metadata: {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        tool: this.toolName,
        boundary: "public-tool-handler",
      },
    });
  }

  private recordEvent(kind: string, payload: unknown): void {
    if (this.runId === null) return;
    writeTraceEvent({ runId: this.runId, ts: this.clock(), kind, payload });
  }

  recordOutput(output: unknown): void {
    this.recordEvent(TOOL_OUTPUT_KIND, {
      schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
      tool: this.toolName,
      status: extractStatus(output),
    });
  }

  recordStage(kind: string, payload: unknown): void {
    if (typeof kind !== "string" || kind.length === 0) return;
    this.recordEvent(kind, payload);
  }

  finish(finalStatus: "ok" | "error"): void {
    if (this.finished) return;
    this.finished = true;
    if (this.runId === null) return;
    const endedAt = this.clock();
    updateTraceRun(this.runId, {
      endedAt,
      status: finalStatus,
      metadata: {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        tool: this.toolName,
        boundary: "public-tool-handler",
        durationMs: Math.max(0, endedAt - this.startedAt),
      },
    });
  }
}

const OUTPUT_STATUSES = new Set([
  "saved",
  "rejected",
  "no_memory",
  "weak_match",
  "answered",
  "provider_error",
  "error",
]);

function extractStatus(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const status = (output as { status?: unknown }).status;
  return typeof status === "string" && OUTPUT_STATUSES.has(status) ? status : undefined;
}
