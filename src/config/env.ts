/**
 * Environment configuration. Reads from process.env only.
 *
 * No secrets are stored in this repo.
 */

export interface CurionEnv {
  /** Minimum log level for the stderr logger. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** API key for the primary provider (MiniMax). */
  primaryKey?: string;
  /** API key for the fallback provider (NVIDIA NIM). */
  fallbackKey?: string;
  /** Project root override. Default: process.cwd(). */
  projectRoot?: string;
}

function readLevel(): CurionEnv["logLevel"] {
  const raw = (process.env.CURION_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

export function loadEnv(): CurionEnv {
  return {
    logLevel: readLevel(),
    primaryKey: process.env.CURION_PROVIDER_PRIMARY_KEY ?? process.env.MINIMAX_API_KEY,
    fallbackKey: process.env.CURION_PROVIDER_FALLBACK_KEY ?? process.env.NVIDIA_NIM_API_KEY,
    projectRoot: process.env.CURION_PROJECT_ROOT,
  };
}
