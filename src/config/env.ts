/**
 * Environment configuration. Reads from process.env only.
 *
 * No secrets are stored in this repo. Documented in `docs/env.md`.
 */

export interface CortexEnv {
  /** Minimum log level for the stderr logger. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** API key for the primary provider (MiniMax). */
  primaryKey?: string;
  /** API key for the fallback provider (NVIDIA NIM). */
  fallbackKey?: string;
  /** Project root override. Default: process.cwd(). */
  projectRoot?: string;
}

function readLevel(): CortexEnv["logLevel"] {
  const raw = (process.env.CORTEX_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export function loadEnv(): CortexEnv {
  return {
    logLevel: readLevel(),
    primaryKey: process.env.CORTEX_PROVIDER_PRIMARY_KEY ?? process.env.MINIMAX_API_KEY,
    fallbackKey: process.env.CORTEX_PROVIDER_FALLBACK_KEY ?? process.env.NVIDIA_NIM_API_KEY,
    projectRoot: process.env.CORTEX_PROJECT_ROOT,
  };
}
