/**
 * Safe local environment loader for the prototype runner.
 *
 * Goals:
 *   - Allow the operator to keep secrets in a local `.env` file
 *     without committing it.
 *   - Never log or print secret values. Redaction helpers are
 *     exported for use by any code path that might surface env vars.
 *   - Stay dependency-free: we parse `.env` ourselves with a tiny
 *     reader. No `dotenv` is required.
 *
 * The loader is deliberately opt-in. The MCP stdio server runtime
 * (src/index.ts) does not call it; secrets come from the parent
 * process's environment, set by the operator. The prototype CLI
 * (src/prototype/runner.ts) calls it.
 */

import fs from "node:fs";
import path from "node:path";

/** Names of env vars whose values MUST never be logged. */
export const SECRET_ENV_VARS: readonly string[] = [
  "CURION_PROVIDER_PRIMARY_KEY",
  "MINIMAX_API_KEY",
  "CURION_PROVIDER_FALLBACK_KEY",
  "NVIDIA_NIM_API_KEY",
  "CURION_PROTOTYPE_PRIMARY_KEY",
  "CURION_PROTOTYPE_FALLBACK_KEY",
  "GROQ_API_KEY",
];

const SECRET_SET: Set<string> = new Set(SECRET_ENV_VARS);

/** True if the given env var name holds a secret. */
export function isSecretEnvVar(name: string): boolean {
  return SECRET_SET.has(name);
}

/**
 * Redact the value of a secret env var for safe logging.
 * The redaction preserves length and the first 2 / last 2 characters
 * when possible so logs can still be correlated, but the bulk of
 * the value is replaced with `*`.
 */
export function redactValue(name: string, value: string): string {
  if (!isSecretEnvVar(name)) return value;
  if (value.length <= 4) return "*".repeat(value.length || 1);
  return `${value.slice(0, 2)}${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

/**
 * Return a JSON-safe description of an env record with secrets
 * redacted. Useful for dry-run reports.
 */
export function describeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      out[k] = "<unset>";
    } else if (isSecretEnvVar(k)) {
      out[k] = redactValue(k, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface LoadDotEnvOptions {
  /** Path to the .env file. Defaults to `.env` in `process.cwd()`. */
  path?: string;
  /** When true, do not overwrite existing process.env values. Default true. */
  override?: boolean;
  /** Encoding of the env file. Default utf8. */
  encoding?: BufferEncoding;
  /**
   * When true, skip dotenv discovery entirely. Useful for tests that
   * need deterministic env state regardless of any `.env` file in the
   * process's current working directory. Default false.
   */
  skip?: boolean;
}

export interface LoadDotEnvResult {
  /** Path that was read (or attempted). */
  path: string;
  /** True if the file existed and was parsed. */
  loaded: boolean;
  /** Names of variables that were set. Values are not returned. */
  keys: string[];
  /** Names of variables that were skipped because already set. */
  skipped: string[];
  /** Parse error message, if any. */
  error?: string;
}

/**
 * Minimal `.env` reader. Supports:
 *   - blank lines and `#` comments
 *   - `KEY=value` and `KEY="value"` (with surrounding quotes stripped)
 *   - export prefix (`export KEY=value`)
 *   - backslash escapes for `\\` and `\"` inside quoted values
 *
 * Does not support variable interpolation. Deliberately small.
 */
export function loadDotEnv(options: LoadDotEnvOptions = {}): LoadDotEnvResult {
  const file = options.path ?? path.join(process.cwd(), ".env");
  const override = options.override ?? false;
  const encoding = options.encoding ?? "utf8";
  const result: LoadDotEnvResult = {
    path: file,
    loaded: false,
    keys: [],
    skipped: [],
  };
  if (options.skip) {
    // Test-only escape hatch: pretend the loader ran but loaded
    // nothing, so downstream presence reporting stays consistent.
    return result;
  }
  if (!fs.existsSync(file)) {
    return result;
  }
  let body: string;
  try {
    body = fs.readFileSync(file, encoding);
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let stripped = line;
    if (stripped.startsWith("export ")) stripped = stripped.slice(7).trim();
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    // Unescape simple sequences inside double-quoted values.
    val = val.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (!override && process.env[key] !== undefined) {
      result.skipped.push(key);
      continue;
    }
    process.env[key] = val;
    result.keys.push(key);
  }
  result.loaded = true;
  return result;
}

/**
 * Convenience: load `.env` if present, then return the relevant
 * prototype config. Secret values are not returned in the result;
 * only their presence is reported. Use `redactValue` on any
 * caller-side log path.
 */
export interface PrototypeConfig {
  /** True if a primary provider key is available. */
  hasPrimaryKey: boolean;
  /** True if a fallback provider key is available. */
  hasFallbackKey: boolean;
  /** Resolved MiniMax base URL. */
  minimaxBaseUrl: string;
  /** Resolved MiniMax model id. */
  minimaxModel: string;
  /** Resolved NIM base URL. */
  nimBaseUrl: string;
  /** Resolved NIM model ids (in fixed prototype order). */
  nimModels: string[];
  /** Resolved network timeout (ms). */
  timeoutMs: number;
  /** Resolved per-request max output tokens. */
  maxTokens: number;
  /** True if a Groq provider key is available. Prototype-only. */
  hasGroqKey: boolean;
  /** Resolved Groq base URL. Prototype-only. */
  groqBaseUrl: string;
  /** Resolved Groq model id. Prototype-only. */
  groqModel: string;
  /**
   * Resolved Groq reasoning effort hint (e.g. "low", "medium", "high").
   * Prototype-only; sent to Groq requests when set.
   */
  groqReasoningEffort: string;
  /** Path the loader attempted to read. */
  dotenvPath: string;
  /** True if the dotenv file was loaded successfully. */
  dotenvLoaded: boolean;
  /** Names of dotenv keys applied (no values). */
  dotenvKeys: string[];
}

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";
const DEFAULT_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_NIM_MODELS = [
  "openai/gpt-oss-120b",
  "meta/llama-3.3-70b-instruct",
] as const;
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const DEFAULT_GROQ_REASONING_EFFORT = "high";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readTrimmedString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function loadPrototypeConfig(
  options: LoadDotEnvOptions = {},
): PrototypeConfig {
  const loaded = loadDotEnv(options);
  return {
    hasPrimaryKey:
      Boolean(process.env.CURION_PROVIDER_PRIMARY_KEY) ||
      Boolean(process.env.MINIMAX_API_KEY),
    hasFallbackKey:
      Boolean(process.env.CURION_PROVIDER_FALLBACK_KEY) ||
      Boolean(process.env.NVIDIA_NIM_API_KEY),
    minimaxBaseUrl:
      process.env.CURION_MINIMAX_BASE_URL ?? DEFAULT_MINIMAX_BASE_URL,
    minimaxModel: process.env.CURION_MINIMAX_MODEL ?? DEFAULT_MINIMAX_MODEL,
    nimBaseUrl: process.env.CURION_NIM_BASE_URL ?? DEFAULT_NIM_BASE_URL,
    nimModels:
      process.env.CURION_NIM_MODELS
        ?.split(",")
        .map((m) => m.trim())
        .filter(Boolean) ?? [...DEFAULT_NIM_MODELS],
    timeoutMs: readNumber("CURION_PROTOTYPE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    maxTokens: readNumber("CURION_PROTOTYPE_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    groqBaseUrl: readTrimmedString(
      "CURION_GROQ_BASE_URL",
      DEFAULT_GROQ_BASE_URL,
    ),
    groqModel: readTrimmedString("CURION_GROQ_MODEL", DEFAULT_GROQ_MODEL),
    groqReasoningEffort: readTrimmedString(
      "CURION_GROQ_REASONING_EFFORT",
      DEFAULT_GROQ_REASONING_EFFORT,
    ),
    dotenvPath: loaded.path,
    dotenvLoaded: loaded.loaded,
    dotenvKeys: loaded.keys,
  };
}
