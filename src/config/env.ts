/**
 * Environment configuration. Reads from process.env only.
 *
 * No secrets are stored in this repo.
 *
 * Per the NVIDIA-only stance, the primary provider slot is
 * associated with NVIDIA NIM (canonical alias `NVIDIA_NIM_API_KEY`).
 * The fallback slot is the only place the MiniMax provider can
 * occupy (`MINIMAX_API_KEY`), and only when the operator has
 * explicitly opted in by setting the env var. The field names
 * below are role-named (primary / fallback) and intentionally
 * NOT provider-named so the labels stay honest as the role
 * assignment changes.
 */

export interface CurionEnv {
  /** Minimum log level for the stderr logger. */
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * API key for the primary provider slot. The default
   * production assignment is NVIDIA NIM, so the canonical alias
   * `NVIDIA_NIM_API_KEY` lands here. The role-named alias
   * `CURION_PROVIDER_PRIMARY_KEY` wins when both are set.
   */
  primaryKey?: string;
  /**
   * API key for the fallback provider slot. Empty by default
   * (the slot is opt-in). The canonical alias for the only
   * opt-in fallback, MiniMax, is `MINIMAX_API_KEY`; the
   * role-named alias is `CURION_PROVIDER_FALLBACK_KEY`.
   */
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
    // Role-named alias wins over the canonical alias; the
    // canonical alias is the NVIDIA NIM key under the
    // NVIDIA-only stance.
    primaryKey:
      process.env.CURION_PROVIDER_PRIMARY_KEY ??
      process.env.NVIDIA_NIM_API_KEY,
    // Fallback slot is opt-in. The canonical alias is the
    // MiniMax key; the role-named alias is
    // `CURION_PROVIDER_FALLBACK_KEY`.
    fallbackKey:
      process.env.CURION_PROVIDER_FALLBACK_KEY ??
      process.env.MINIMAX_API_KEY,
    projectRoot: process.env.CURION_PROJECT_ROOT,
  };
}
