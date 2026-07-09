#!/usr/bin/env node
/**
 * Curion provider diagnostic.
 *
 * A small CLI that probes the configured providers and reports
 * reachability, auth, model resolution, and timing without ever
 * printing or persisting any API key value.
 *
 * Why this exists:
 *   - Operators sometimes hit a `provider_error` from the recall
 *     or remember controllers and need a fast way to answer
 *     "is MiniMax reachable, is the key still valid, is the
 *     model id correct?" without re-running the full benchmark.
 *   - The probe is tiny: 1-token completion on a fixed prompt,
 *     bounded timeout, single HTTP call per provider.
 *   - The report is safe to paste into a public issue tracker:
 *     no Authorization headers, no key material, no prompt
 *     bodies beyond the sanitized "what did the server say?"
 *     excerpt.
 *
 * What it checks (per provider):
 *   - env var presence (URL, model, key) — values are never
 *     echoed.
 *   - endpoint host + path that the request will hit.
 *   - model id that the request will use.
 *   - HTTP status, if reached.
 *   - status class: ok / missing-config / timeout / fetch-failed
 *     / auth / rate-limit / not-found / server / bad-request /
 *     malformed-response / unknown.
 *   - latency in milliseconds.
 *   - a sanitized short error message on failure.
 *
 * CLI:
 *   tsx scripts/provider-diagnostic.ts [options]
 *   npm run diagnose:providers -- [--provider minimax|nvidia-nim|both]
 *
 * Options:
 *   --provider <id>    Which provider to probe. One of:
 *                         minimax     (default; matches Curion's
 *                                      recall-synthesis fallback slot)
 *                         nvidia-nim  (matches Curion's recall-
 *                                      synthesis primary slot)
 *                         both        (probe both, sequentially)
 *   --timeout <ms>     Per-probe timeout in milliseconds. Default 15000.
 *   --max-tokens <n>   `max_tokens` cap on the probe request.
 *                      Default 1 (cheapest admissible probe). Bounded
 *                      to 1..256 to keep the diagnostic cheap. The
 *                      flag is forwarded to `probeProvider` so the
 *                      request body reflects it.
 *   --dry-run          Resolve env and print the planned request
 *                      shape, but do NOT make any HTTP call.
 *   --skip-dotenv      Do not load .env from cwd. Useful in tests
 *                      and CI where env is set by the harness.
 *   -h, --help         Show help and exit.
 *
 * Environment (Curion's existing conventions, all optional):
 *   - MiniMax (fallback slot):
 *       CURION_MINIMAX_BASE_URL, CURION_MINIMAX_MODEL
 *       CURION_PROVIDER_FALLBACK_KEY, CURION_FALLBACK_API_KEY,
 *       MINIMAX_API_KEY
 *   - NVIDIA NIM (primary slot):
 *       CURION_NIM_BASE_URL, CURION_NIM_FALLBACK_MODEL,
 *       CURION_NIM_MODELS
 *       CURION_PROVIDER_PRIMARY_KEY, CURION_PRIMARY_API_KEY,
 *       NVIDIA_NIM_API_KEY
 *
 * Exit code:
 *   0  if every probed provider returned `ok`.
 *   1  if any probe returned a non-`ok` status (any failure mode).
 *   2  on argument / config error.
 *
 * Security:
 *   - This script never logs the API key value. The key is read
 *     from `process.env` and forwarded directly to the probe;
 *     it never appears in stdout or stderr.
 *   - Server error bodies are scrubbed via the shared
 *     `sanitizeServerText` helper (Bearer, sk-, nvapi-, named
 *     JSON fields).
 *   - Transport error messages are scrubbed the same way: a
 *     runtime that embeds the request URL (with the key in a
 *     query string) in its error message would otherwise leak.
 */

import fs from "node:fs";
import path from "node:path";

import { loadDotEnv } from "../src/config/env-loader.js";
import {
  DEFAULT_DIAGNOSTIC_MAX_TOKENS,
  DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
  type DiagnosticEnvDescriptor,
  type DiagnosticProviderId,
  type ProbeProviderResult,
  formatDiagnosticReport,
  probeProvider,
  resolveDiagnosticEnv,
} from "../src/providers/provider-diagnostic.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/** Inclusive lower bound for `--max-tokens`. 1 is the cheapest probe. */
export const MIN_MAX_TOKENS = 1;

/**
 * Inclusive upper bound for `--max-tokens`. The probe is a tiny
 * diagnostic; the cap exists to keep one operator mistake (e.g.
 * `--max-tokens 1000000`) from accidentally spending a non-trivial
 * amount of tokens during a routine reachability check.
 */
export const MAX_MAX_TOKENS = 256;

export interface CliOptions {
  provider: DiagnosticProviderId | "both";
  timeoutMs: number;
  /**
   * `max_tokens` to forward to the tiny probe request. Defaults
   * to 1 so existing behavior is preserved. Bounded to
   * [MIN_MAX_TOKENS, MAX_MAX_TOKENS].
   */
  maxTokens: number;
  dryRun: boolean;
  skipDotenv: boolean;
  dotenvPath?: string;
}

function printHelp(): void {
  process.stdout.write(
    [
      "curion provider diagnostic",
      "",
      "Usage:",
      "  tsx scripts/provider-diagnostic.ts [options]",
      "  npm run diagnose:providers -- [--provider both]",
      "",
      "Options:",
      "  --provider <id>     minimax | nvidia-nim | both (default: minimax)",
      "  --timeout <ms>      Per-probe timeout in ms (default: 15000)",
      `  --max-tokens <n>    max_tokens for the probe (default: ${DEFAULT_DIAGNOSTIC_MAX_TOKENS};`,
      `                       range: ${MIN_MAX_TOKENS}..${MAX_MAX_TOKENS})`,
      "  --dry-run           Resolve env + print plan, no HTTP call",
      "  --skip-dotenv       Do not load .env from cwd",
      "  --dotenv <path>     Load .env from this path (default: cwd/.env)",
      "  -h, --help          Show this help",
      "",
      "Output:",
      "  For each probed provider, the report includes:",
      "    - env vars consulted (names only, no values)",
      "    - key presence (yes / NO)",
      "    - endpoint host + path",
      "    - model id",
      "    - status class + HTTP status (if reached)",
      "    - latency in ms",
      "    - sanitized error message (if not ok)",
      "",
      "Exit codes:",
      "  0  every probed provider returned ok",
      "  1  one or more probes failed (non-ok status)",
      "  2  argument or config error",
    ].join("\n") + "\n"
  );
}

/**
 * Parse the diagnostic CLI arguments. Pure: never reads `process`
 * other than through the caller-supplied `argv` and never calls
 * `process.exit`. Returns either:
 *
 *   - `{ opts }` on success
 *   - `{ error }` if any flag is malformed or unknown
 *
 * The caller is responsible for translating the error to stderr +
 * exit(2). Tests assert on the returned shape directly.
 */
export function parseDiagnosticCli(
  argv: readonly string[]
): { opts: CliOptions } | { error: string } {
  const opts: CliOptions = {
    provider: "minimax",
    timeoutMs: DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    maxTokens: DEFAULT_DIAGNOSTIC_MAX_TOKENS,
    dryRun: false,
    skipDotenv: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        return { error: "error: --provider requires a value" };
      }
      i++;
      if (raw !== "minimax" && raw !== "nvidia-nim" && raw !== "both") {
        return { error: `error: invalid --provider value: ${raw}` };
      }
      opts.provider = raw;
    } else if (a === "--timeout") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        return { error: "error: --timeout requires a value" };
      }
      i++;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
        return { error: "error: --timeout must be a positive integer (ms)" };
      }
      opts.timeoutMs = n;
    } else if (a === "--max-tokens") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        return { error: "error: --max-tokens requires a value" };
      }
      i++;
      // Reject non-integer-shaped strings (e.g. "1.5", "abc",
      // "1e2") so the bound check is the only validation step
      // the operator sees. trim() tolerates a stray space.
      if (!/^-?\d+$/.test(raw.trim())) {
        return { error: "error: --max-tokens must be an integer" };
      }
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < MIN_MAX_TOKENS || n > MAX_MAX_TOKENS) {
        return {
          error: `error: --max-tokens must be an integer in [${MIN_MAX_TOKENS}, ${MAX_MAX_TOKENS}]`,
        };
      }
      opts.maxTokens = n;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--skip-dotenv") {
      opts.skipDotenv = true;
    } else if (a === "--dotenv") {
      const raw = argv[i + 1];
      if (raw === undefined) {
        return { error: "error: --dotenv requires a path" };
      }
      i++;
      opts.dotenvPath = raw;
    } else {
      return { error: `error: unknown argument: ${a}` };
    }
  }
  return { opts };
}

/**
 * Thin CLI wrapper around `parseDiagnosticCli` that handles
 * `--help` and translates errors to `process.exit(2)`. Kept
 * separate from the pure parser so tests can drive `parseDiagnosticCli`
 * directly without `process.exit` side effects.
 */
function parseCli(argv: readonly string[]): CliOptions {
  // Detect --help / -h up front so we can print and exit 0 cleanly
  // without going through the parser's error path.
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }
  const parsed = parseDiagnosticCli(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  return parsed.opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));

  // 1. Optionally load .env so process.env has the operator's
  //    locally-configured keys + URLs.
  if (!opts.skipDotenv) {
    const envPath = opts.dotenvPath ?? path.join(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      process.stdout.write(`[diagnostic] no .env at ${envPath}; reading process.env only\n`);
    } else {
      const loaded = loadDotEnv({ path: envPath });
      process.stdout.write(
        `[diagnostic] .env loaded: ${loaded.keys.length} keys set (names not echoed)\n`
      );
    }
  }

  // 2. Resolve env descriptors for the requested providers.
  const providers: DiagnosticProviderId[] =
    opts.provider === "both" ? ["minimax", "nvidia-nim"] : [opts.provider];
  const descriptors: DiagnosticEnvDescriptor[] = providers.map((p) => resolveDiagnosticEnv(p));

  // 3. Dry-run path: print the planned request shape and exit 0
  //    so callers can confirm the configuration without spending
  //    any tokens.
  if (opts.dryRun) {
    const planResults: ProbeProviderResult[] = descriptors.map((d) => ({
      provider: d.provider,
      model: d.model,
      baseUrl: d.baseUrl,
      status: "missing-config",
      latencyMs: 0,
      reachedServer: false,
      errorClass: "missing-config",
      errorMessage: "dry-run: no HTTP call made",
    }));
    process.stdout.write(`${formatDiagnosticReport(descriptors, planResults)}\n`);
    process.stdout.write("\n[dry-run] no HTTP calls were made.\n");
    return;
  }

  // 4. Live probes. Sequential so the operator can read the
  //    output line-by-line; parallelism is not a goal for this
  //    diagnostic.
  const results: ProbeProviderResult[] = [];
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    const desc = descriptors[i]!;
    const key = resolveApiKey(provider);
    const result = await probeProvider({
      provider,
      baseUrl: desc.baseUrl,
      model: desc.model,
      apiKey: key ?? "",
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
    });
    results.push(result);
  }

  process.stdout.write(`${formatDiagnosticReport(descriptors, results)}\n`);

  // 5. Exit code: 0 iff every result is `ok`. A non-ok status
  //    is a real diagnostic signal the caller wants to see.
  const allOk = results.every((r) => r.status === "ok");
  if (!allOk) {
    process.exitCode = 1;
  }
}

/**
 * Resolve the API key for a provider from `process.env`. Returns
 * `undefined` when no key is configured. The value is never
 * logged; the caller passes it to `probeProvider` which keeps
 * it private.
 */
function resolveApiKey(provider: DiagnosticProviderId): string | undefined {
  if (provider === "minimax") {
    return (
      process.env.CURION_PROVIDER_FALLBACK_KEY ??
      process.env.CURION_FALLBACK_API_KEY ??
      process.env.MINIMAX_API_KEY
    );
  }
  // nvidia-nim
  return (
    process.env.CURION_PROVIDER_PRIMARY_KEY ??
    process.env.CURION_PRIMARY_API_KEY ??
    process.env.NVIDIA_NIM_API_KEY
  );
}

// ---------------------------------------------------------------------------
// CLI entry guard
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return argvPath === thisPath;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[diagnostic] FATAL ${msg}\n`);
    process.exit(1);
  });
}
