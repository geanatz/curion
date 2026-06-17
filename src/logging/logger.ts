/**
 * Stderr-only logger.
 *
 * In stdio MCP runtime, stdout is reserved for MCP protocol frames.
 * Any log, debug, warning, or error MUST go to stderr.
 *
 * This module is the single allowed logging path. Tools and libraries
 * should not use `console.log` directly.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Default to `info`; can be overridden via CURION_LOG_LEVEL env var.
const envLevel = (process.env.CURION_LOG_LEVEL ?? "info").toLowerCase() as Level;
const minLevel: number = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: Level, message: string): void {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  // Single-line, JSON-ish, machine-parseable. Goes to stderr.
  process.stderr.write(`[curion] ${ts} ${level.toUpperCase()} ${message}\n`);
}

export const logger = {
  debug(msg: string): void {
    emit("debug", msg);
  },
  info(msg: string): void {
    emit("info", msg);
  },
  warn(msg: string): void {
    emit("warn", msg);
  },
  error(msg: string): void {
    emit("error", msg);
  },
  /** Test/utility: confirms the logger's write target is stderr. */
  _stream(): NodeJS.WriteStream {
    return process.stderr;
  },
};
