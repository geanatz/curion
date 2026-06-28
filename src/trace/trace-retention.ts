/**
 * Trace retention / purge helpers.
 *
 * Phase 1 contract:
 *   - Default retention window is 30 days (30 * 24 * 60 * 60 *
 *     1000 ms). Helpers accept a custom `maxAgeMs` so tests can
 *     shrink the window without time mocking.
 *   - Helpers are best-effort / non-throwing. A failure (DB
 *     unavailable, write error) is logged and surfaces as
 *     `{ runsDeleted: 0, eventsDeleted: 0 }` — the same shape
 *     callers get when nothing matched.
 *   - Deletion is by run, not by event. `trace_events.run_id`
 *     has `ON DELETE CASCADE`, so removing a row from
 *     `trace_runs` removes all of its events. The returned
 *     `eventsDeleted` is the pre-cascade count from the run
 *     rows we are about to delete.
 *   - Helpers read the wall clock via `Date.now()` at call time
 *     so the threshold is the current moment minus `maxAgeMs`.
 *     A run is "old" if its `started_at` is strictly less than
 *     the cutoff (we use `<` so a run that started exactly at
 *     the cutoff is preserved).
 *   - No CLI. Helpers are exported so the eventual CLI or a
 *     scheduled task can call them; this module does not add
 *     any user-facing surface.
 */

import { logger } from "../logging/logger.js";
import type { StorageConfig } from "./trace-storage.js";
import { closeTraceWriter, getOrInitTraceWriter } from "./trace-writer.js";

/** Default retention: 30 days, in milliseconds. */
export const DEFAULT_TRACE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PurgeResult {
  /** Number of run rows deleted. Always >= 0. */
  runsDeleted: number;
  /** Number of event rows that were deleted (cascaded). Always >= 0. */
  eventsDeleted: number;
}

export interface PurgeOptions {
  /** Override the retention window (ms). */
  maxAgeMs?: number;
  /**
   * Override the `Date.now()` reference. Used by tests that
   * need a deterministic cutoff. Default: `Date.now()`.
   */
  now?: () => number;
  /**
   * When `true`, close the writer handle after the purge runs.
   * Default `false`. Set to `true` for one-shot CLI / scheduled
   * tasks; leave `false` for callers that want the writer
   * handle to stay open for subsequent writes.
   */
  closeAfter?: boolean;
}

/**
 * Delete all trace runs whose `started_at` is older than
 * `maxAgeMs` (default 30 days). Returns the number of runs and
 * events deleted. Never throws.
 */
export function purgeTraceRunsOlderThan(
  options: PurgeOptions = {},
  config: StorageConfig = {}
): PurgeResult {
  const empty: PurgeResult = { runsDeleted: 0, eventsDeleted: 0 };
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TRACE_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    logWarn(`trace retention: invalid maxAgeMs ${maxAgeMs}`);
    return empty;
  }
  const cutoff = now() - maxAgeMs;
  let handle: ReturnType<typeof getOrInitTraceWriter> = null;
  try {
    handle = getOrInitTraceWriter(config);
  } catch (err) {
    logWarn(`trace retention: failed to open writer: ${(err as Error).message}`);
    return empty;
  }
  if (!handle) {
    // Tracing is disabled, the handle is closed, or the DB
    // could not be opened. Returning the empty result is the
    // safe no-op.
    return empty;
  }
  try {
    // Count first so the caller's `eventsDeleted` is honest
    // (the actual cascade is performed by the FK action, not
    // by us; we only see the count of runs we are about to
    // delete and the count of their events at that instant).
    const runsToDelete = handle.db
      .prepare(`SELECT id FROM trace_runs WHERE started_at < ?`)
      .all(cutoff) as Array<{ id: number }>;
    if (runsToDelete.length === 0) {
      return empty;
    }
    const ids = runsToDelete.map((r) => r.id);
    // Count events for those runs BEFORE the cascade. We use a
    // safe integer-safe list binding (one placeholder per id)
    // so SQLite never sees a single enormous IN list.
    const placeholders = ids.map(() => "?").join(",");
    const eventCountRow = handle.db
      .prepare(`SELECT COUNT(*) AS c FROM trace_events WHERE run_id IN (${placeholders})`)
      .get(...ids) as { c: number };
    const eventsDeleted = Number(eventCountRow.c) || 0;
    const info = handle.db
      .prepare(`DELETE FROM trace_runs WHERE id IN (${placeholders})`)
      .run(...ids);
    return {
      runsDeleted: info.changes,
      eventsDeleted,
    };
  } catch (err) {
    logWarn(`trace retention: purge failed: ${(err as Error).message}`);
    return empty;
  } finally {
    if (options.closeAfter) {
      try {
        closeTraceWriter();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Delete ALL trace runs and (via cascade) all trace events.
 * Convenience for tests and for a future "purge everything"
 * CLI command. Returns the same `PurgeResult` shape as
 * `purgeTraceRunsOlderThan`. Never throws.
 */
export function purgeAllTraceRuns(
  options: Omit<PurgeOptions, "maxAgeMs"> = {},
  config: StorageConfig = {}
): PurgeResult {
  const empty: PurgeResult = { runsDeleted: 0, eventsDeleted: 0 };
  let handle: ReturnType<typeof getOrInitTraceWriter> = null;
  try {
    handle = getOrInitTraceWriter(config);
  } catch (err) {
    logWarn(`trace retention: failed to open writer: ${(err as Error).message}`);
    return empty;
  }
  if (!handle) return empty;
  try {
    const eventCountRow = handle.db.prepare(`SELECT COUNT(*) AS c FROM trace_events`).get() as {
      c: number;
    };
    const eventsDeleted = Number(eventCountRow.c) || 0;
    const info = handle.db.prepare(`DELETE FROM trace_runs`).run();
    return {
      runsDeleted: info.changes,
      eventsDeleted,
    };
  } catch (err) {
    logWarn(`trace retention: purgeAll failed: ${(err as Error).message}`);
    return empty;
  } finally {
    if (options.closeAfter) {
      try {
        closeTraceWriter();
      } catch {
        // ignore
      }
    }
  }
}

function logWarn(msg: string): void {
  try {
    logger.warn(msg);
  } catch {
    // ignore
  }
}
