/**
 * Provider prototype runner.
 *
 * A small CLI that exercises the approved providers against the
 * P1..P6 structured-output fixtures, in dry-run and live modes.
 *
 * Providers compared by default:
 *   - minimax    (MiniMax, primary)
 *   - nvidia-nim (NVIDIA NIM, fallback; two candidate models)
 *   - groq       (Groq, prototype-only comparison candidate)
 *
 * Behavior:
 *   - In dry-run (default if --live is not set), it never hits the
 *     network. It reports:
 *       * which providers and models are configured,
 *       * which env keys are present (without printing values),
 *       * which fixtures will be run.
 *   - In --live mode, it makes real chat-completion calls using
 *     OpenAI-compatible endpoints. If a key is missing, the
 *     affected provider is skipped with a clean "missing-config"
 *     note. If --only is set, the runner restricts experiments to
 *     the named providers or models.
 *
 * Groq specifics (prototype-only):
 *   - The OpenAI-compatible base URL defaults to
 *     `https://api.groq.com/openai/v1` and is overridable via
 *     `CORTEX_GROQ_BASE_URL`.
 *   - The default model is `openai/gpt-oss-120b`, overridable via
 *     `CORTEX_GROQ_MODEL`.
 *   - The default reasoning effort is `high`, overridable via
 *     `CORTEX_GROQ_REASONING_EFFORT`.
 *   - Groq attempts use a strict `response_format: { type:
 *     "json_schema", json_schema: { schema, strict: true, name } }`
 *     payload built from `MEMORY_ANALYSIS_JSON_SCHEMA`. The schema
 *     satisfies Groq's strict-mode rules (`additionalProperties:
 *     false`; every property in `required`).
 *   - `reasoning_effort` is sent in the request body for Groq
 *     only. MiniMax and NIM requests do NOT include it.
 *   - Groq is NOT consumed by the production provider adapter.
 *     It is a prototype comparison only.
 *
 * Output:
 *   - A human-readable summary is printed to stdout (the runner is
 *     NOT the MCP stdio server; the stdio runtime in src/index.ts
 *     is untouched).
 *   - A sanitized JSON report is written under `.cortex/prototype/`
 *     (or another path given by --artifacts). The report contains
 *     only the structured fields listed below; raw prompts and raw
 *     responses are truncated to a short redacted snippet.
 *
 * Security:
 *   - No API key values are ever written to the report.
 *   - No Authorization header value is logged.
 *   - The runner redaction uses the helpers in
 *     `src/config/env-loader.ts`. `GROQ_API_KEY` is in the secret
 *     set so `describeEnv` / `redactValue` mask it.
 */

import fs from "node:fs";
import path from "node:path";

import {
  loadPrototypeConfig,
  redactValue,
  type PrototypeConfig,
} from "../config/env-loader.js";
import { PROTOTYPE_FIXTURES } from "./fixtures.js";
import {
  buildStructuredPrompt,
  MEMORY_ANALYSIS_JSON_SCHEMA,
  parseMemoryAnalysis,
  type MemoryAnalysis,
  type ParseResult,
} from "./structured-output.js";
import {
  chatCompletion,
  type ChatCompletionResponse,
  type ChatMessage,
  type ChatResponseFormat,
  type ProviderError,
} from "../providers/http-client.js";

export type ProviderId = "minimax" | "nvidia-nim" | "groq";

export interface RunnerOptions {
  /** Live HTTP calls. Default false (dry-run). */
  live: boolean;
  /** Restrict experiments to a subset of providers. */
  onlyProviders?: ProviderId[];
  /** Restrict experiments to a subset of fixture ids. */
  onlyFixtures?: string[];
  /** Restrict NIM experiments to a subset of model ids. */
  onlyNimModels?: string[];
  /** Override artifact directory. */
  artifactsDir?: string;
  /** Fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Override env file path. */
  dotenvPath?: string;
  /** Skip dotenv discovery entirely. Default false. */
  dotenvSkip?: boolean;
  /** Override per-request max output tokens. Default 1024. */
  maxTokens?: number;
  /**
   * Override Groq's reasoning effort. When unset, the value from
   * `cfg.groqReasoningEffort` is used. Pass an empty string to
   * disable sending `reasoning_effort` to Groq for a run.
   */
  groqReasoningEffortOverride?: string;
  /**
   * Disable strict `response_format: { type: "json_schema" }` for
   * Groq and use prompt-delimited JSON instead. Defaults to false
   * (strict is preferred). Tests can flip this when they want to
   * observe the prompt-only path.
   */
  groqDisableStrictJsonSchema?: boolean;
}

export interface ProviderAttempt {
  provider: ProviderId;
  model: string;
  fixture: string;
  ok: boolean;
  parse: ParseResult;
  error?: ProviderError;
  latencyMs?: number;
  /** First 200 chars of the model's raw content, truncated. */
  rawSnippet?: string;
  /** Number of repair attempts applied. */
  repairsApplied: number;
  /** max_tokens used for the request, if live. */
  maxTokens?: number;
  /**
   * Reasoning effort sent to the provider for this attempt, if any.
   * Only set for providers that advertise the parameter (Groq).
   */
  reasoningEffort?: string;
  /**
   * Response_format type used for this attempt. Reported for
   * transparency: "json_object", "text", or "json_schema".
   */
  responseFormatType: "json_object" | "text" | "json_schema";
}

export interface ExperimentReport {
  generatedAt: string;
  mode: "dry-run" | "live";
  config: {
    minimaxBaseUrl: string;
    minimaxModel: string;
    nimBaseUrl: string;
    nimModels: string[];
    groqBaseUrl: string;
    groqModel: string;
    groqReasoningEffort: string;
    timeoutMs: number;
    maxTokens: number;
    hasPrimaryKey: boolean;
    hasFallbackKey: boolean;
    hasGroqKey: boolean;
    dotenvLoaded: boolean;
    dotenvKeyCount: number;
  };
  attempts: ProviderAttempt[];
  summary: {
    total: number;
    parsed: number;
    parseFailed: number;
    repaired: number;
    skipped: number;
    byProvider: Record<string, { total: number; parsed: number }>;
  };
}

const ARTIFACT_DIRNAME = "prototype";
const ARTIFACT_FILE_PREFIX = "prototype-report";
const ALL_PROVIDERS: readonly ProviderId[] = ["minimax", "nvidia-nim", "groq"];

function isProviderId(s: string): s is ProviderId {
  return (ALL_PROVIDERS as readonly string[]).includes(s);
}

export function parseCli(argv: string[]): RunnerOptions {
  const opts: RunnerOptions = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") opts.live = true;
    else if (a === "--dry-run") opts.live = false;
    else if (a === "--only-provider" && argv[i + 1]) {
      const ids = argv[++i].split(",").map((s) => s.trim()).filter(isProviderId);
      opts.onlyProviders = ids;
    } else if (a === "--only-fixture" && argv[i + 1]) {
      opts.onlyFixtures = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--only-nim-model" && argv[i + 1]) {
      opts.onlyNimModels = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--artifacts" && argv[i + 1]) {
      opts.artifactsDir = argv[++i];
    } else if (a === "--max-tokens" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--max-tokens requires a positive integer (got "${argv[i]}")`);
      }
      opts.maxTokens = n;
    } else if (a === "--groq-reasoning-effort" && argv[i + 1]) {
      // Allow empty string to clear the value for a single run.
      opts.groqReasoningEffortOverride = argv[++i];
    } else if (a === "--no-groq-strict-schema") {
      opts.groqDisableStrictJsonSchema = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(
    [
      "cortex-mcp-v2 provider prototype runner",
      "",
      "Usage:",
      "  node --import tsx src/prototype/runner.ts [options]",
      "  tsx src/prototype/runner.ts [options]",
      "",
      "Options:",
      "  --dry-run                      Report configuration and exit (default).",
      "  --live                         Make real HTTP calls. Requires API keys.",
      "  --only-provider                Comma list, e.g. minimax,nvidia-nim,groq",
      "  --only-fixture                 Comma list, e.g. P1,P3,P6",
      "  --only-nim-model               Comma list of NIM model ids",
      "  --artifacts <path>             Override artifacts directory",
      "  --max-tokens <n>               Per-request max output tokens (default 1024)",
      "  --groq-reasoning-effort <val>  Override CORTEX_GROQ_REASONING_EFFORT (Groq only).",
      "                                 Pass an empty string to disable sending the param.",
      "  --no-groq-strict-schema        Use prompt-delimited JSON for Groq (skip strict json_schema).",
      "  -h, --help                     Show this help",
      "",
      "Environment:",
      "  See .env.example for the full list. The runner loads .env",
      "  from the current working directory if present.",
    ].join("\n") + "\n",
  );
}

export function resolveArtifactsDir(
  cfg: PrototypeConfig,
  options: RunnerOptions,
): string {
  const root = options.artifactsDir
    ? path.resolve(options.artifactsDir)
    : path.join(process.cwd(), ".cortex", ARTIFACT_DIRNAME);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function snippet(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function envRedactionLine(cfg: PrototypeConfig): string {
  // Only the *presence* of keys is reported. Values are not returned.
  return [
    `dotenv path:        ${cfg.dotenvPath}`,
    `dotenv loaded:      ${cfg.dotenvLoaded}`,
    `dotenv keys set:    ${cfg.dotenvKeys.length} (names not echoed)`,
    `primary key:        ${cfg.hasPrimaryKey ? "present" : "MISSING"}`,
    `fallback key:       ${cfg.hasFallbackKey ? "present" : "MISSING"}`,
    `groq key:           ${cfg.hasGroqKey ? "present" : "MISSING"}`,
    `minimax base url:   ${cfg.minimaxBaseUrl}`,
    `minimax model:      ${cfg.minimaxModel}`,
    `nim base url:       ${cfg.nimBaseUrl}`,
    `nim models:         ${cfg.nimModels.join(", ")}`,
    `groq base url:      ${cfg.groqBaseUrl}`,
    `groq model:         ${cfg.groqModel}`,
    `groq reason effort: ${cfg.groqReasoningEffort}`,
    `timeout ms:         ${cfg.timeoutMs}`,
    `max tokens:         ${cfg.maxTokens}`,
  ].join("\n");
}

function selectProviders(opts: RunnerOptions): ProviderId[] {
  if (!opts.onlyProviders || opts.onlyProviders.length === 0) {
    return [...ALL_PROVIDERS];
  }
  return ALL_PROVIDERS.filter((p) => opts.onlyProviders!.includes(p));
}

function selectFixtures(opts: RunnerOptions): typeof PROTOTYPE_FIXTURES[number][] {
  if (!opts.onlyFixtures || opts.onlyFixtures.length === 0) return [...PROTOTYPE_FIXTURES];
  const wanted = new Set(opts.onlyFixtures);
  return PROTOTYPE_FIXTURES.filter((f) => wanted.has(f.id));
}

function selectNimModels(opts: RunnerOptions, cfg: PrototypeConfig): string[] {
  if (!opts.onlyNimModels || opts.onlyNimModels.length === 0) return cfg.nimModels;
  const wanted = new Set(opts.onlyNimModels);
  return cfg.nimModels.filter((m) => wanted.has(m));
}

/**
 * Run one attempt against a provider+model+fixture. Returns a
 * normalized ProviderAttempt. Never throws.
 */
async function runOneAttempt(
  provider: ProviderId,
  model: string,
  fixtureId: string,
  text: string,
  cfg: PrototypeConfig,
  options: RunnerOptions,
): Promise<ProviderAttempt> {
  // Resolve the per-provider request metadata up front so it is
  // available in the dry-run attempt too (and shows up in the
  // human / artifact report before any network call is made).
  const requestOverrides = buildProviderRequestOverrides(
    provider,
    cfg,
    options,
  );
  const baseAttempt: ProviderAttempt = {
    provider,
    model,
    fixture: fixtureId,
    ok: false,
    parse: { ok: false, errors: [], repaired: false },
    repairsApplied: 0,
    responseFormatType:
      requestOverrides.responseFormat === "text"
        ? "text"
        : requestOverrides.responseFormat === "json_object"
          ? "json_object"
          : "json_schema",
    ...(requestOverrides.reasoningEffort
      ? { reasoningEffort: requestOverrides.reasoningEffort }
      : {}),
  };

  if (options.live !== true) {
    // Dry-run path: no real call was made. We report the attempt as
    // "planned" but not parsed, so the summary's parsed/parseFailed
    // counters stay honest. The error stays undefined.
    return {
      ...baseAttempt,
      parse: { ok: false, errors: ["dry-run: no live call made"], repaired: false },
    };
  }

  const apiKey = readKey(provider);
  if (!apiKey) {
    return {
      ...baseAttempt,
      error: {
        kind: "missing-config",
        message: `${provider}: no api key configured`,
        reachedServer: false,
      },
    };
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a structured-output assistant. You must return exactly one JSON object, optionally wrapped in a ```json ... ``` block. No other text.",
    },
    { role: "user", content: buildStructuredPrompt(text) },
  ];

  // CLI flag wins; otherwise the env/loader-resolved default.
  const maxTokens = options.maxTokens ?? cfg.maxTokens;

  const result = await chatCompletion(
    {
      model,
      messages,
      temperature: 0,
      maxTokens,
      ...requestOverrides,
    },
    {
      baseUrl: providerBaseUrl(provider, cfg),
      apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: options.fetchImpl,
      providerLabel: `${provider}/${model}`,
    },
  );

  if (!result.ok) {
    return { ...baseAttempt, error: result.error, maxTokens };
  }

  const rawContent = result.response.content;
  const parsed = parseMemoryAnalysis(rawContent);
  const repairsApplied = parsed.repaired ? 1 : 0;
  return {
    ...baseAttempt,
    ok: parsed.ok,
    parse: parsed,
    latencyMs: result.response.latencyMs,
    rawSnippet: snippet(rawContent, 200),
    repairsApplied,
    maxTokens,
  };
}

/**
 * Build the per-provider request-body overrides (response_format,
 * reasoning_effort). Centralized so that:
 *   - MiniMax and NIM do NOT receive `reasoning_effort` (they
 *     ignore / may reject unknown parameters).
 *   - Groq uses a strict `json_schema` payload by default, and
 *     includes `reasoning_effort` only if the resolved value is
 *     non-empty.
 */
function buildProviderRequestOverrides(
  provider: ProviderId,
  cfg: PrototypeConfig,
  options: RunnerOptions,
): { responseFormat: ChatResponseFormat; reasoningEffort?: string } {
  if (provider === "groq") {
    const responseFormat: ChatResponseFormat = options.groqDisableStrictJsonSchema
      ? "json_object"
      : {
          kind: "json_schema",
          schema: MEMORY_ANALYSIS_JSON_SCHEMA,
          strict: true,
          name: "memory_analysis",
        };
    const effort = resolveGroqReasoningEffort(cfg, options);
    if (effort) {
      return { responseFormat, reasoningEffort: effort };
    }
    return { responseFormat };
  }
  return { responseFormat: "json_object" };
}

function resolveGroqReasoningEffort(
  cfg: PrototypeConfig,
  options: RunnerOptions,
): string {
  if (options.groqReasoningEffortOverride !== undefined) {
    return options.groqReasoningEffortOverride.trim();
  }
  return cfg.groqReasoningEffort.trim();
}

function providerBaseUrl(provider: ProviderId, cfg: PrototypeConfig): string {
  if (provider === "minimax") return cfg.minimaxBaseUrl;
  if (provider === "nvidia-nim") return cfg.nimBaseUrl;
  return cfg.groqBaseUrl;
}

function readKey(provider: ProviderId): string | undefined {
  if (provider === "minimax") {
    return (
      process.env.CORTEX_PROVIDER_PRIMARY_KEY ??
      process.env.MINIMAX_API_KEY
    );
  }
  if (provider === "nvidia-nim") {
    return (
      process.env.CORTEX_PROVIDER_FALLBACK_KEY ??
      process.env.NVIDIA_NIM_API_KEY
    );
  }
  return process.env.GROQ_API_KEY;
}

export function buildReport(
  attempts: ProviderAttempt[],
  cfg: PrototypeConfig,
  options: RunnerOptions,
): ExperimentReport {
  const byProvider: Record<string, { total: number; parsed: number }> = {};
  let parsed = 0;
  let parseFailed = 0;
  let repaired = 0;
  let skipped = 0;
  for (const a of attempts) {
    if (a.error?.kind === "missing-config") {
      skipped += 1;
    } else if (a.parse.ok) {
      parsed += 1;
      if (a.parse.repaired) repaired += 1;
    } else {
      parseFailed += 1;
    }
    const k = `${a.provider}/${a.model}`;
    const cur = byProvider[k] ?? { total: 0, parsed: 0 };
    cur.total += 1;
    if (a.parse.ok) cur.parsed += 1;
    byProvider[k] = cur;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: options.live ? "live" : "dry-run",
    config: {
      minimaxBaseUrl: cfg.minimaxBaseUrl,
      minimaxModel: cfg.minimaxModel,
      nimBaseUrl: cfg.nimBaseUrl,
      nimModels: cfg.nimModels,
      groqBaseUrl: cfg.groqBaseUrl,
      groqModel: cfg.groqModel,
      groqReasoningEffort: cfg.groqReasoningEffort,
      timeoutMs: cfg.timeoutMs,
      maxTokens: cfg.maxTokens,
      hasPrimaryKey: cfg.hasPrimaryKey,
      hasFallbackKey: cfg.hasFallbackKey,
      hasGroqKey: cfg.hasGroqKey,
      dotenvLoaded: cfg.dotenvLoaded,
      dotenvKeyCount: cfg.dotenvKeys.length,
    },
    attempts: attempts.map(sanitizeAttempt),
    summary: {
      total: attempts.length,
      parsed,
      parseFailed,
      repaired,
      skipped,
      byProvider,
    },
  };
}

function sanitizeAttempt(a: ProviderAttempt): ProviderAttempt {
  // Ensure no key value ever lands in the artifact. The runner only
  // stores provider/model/parse/latency/snippet/error; this guard
  // is here in case future fields leak. We also cap the snippet
  // length to a small bound.
  return {
    provider: a.provider,
    model: a.model,
    fixture: a.fixture,
    ok: a.ok,
    parse: {
      ok: a.parse.ok,
      value: a.parse.value,
      errors: a.parse.errors.slice(0, 8),
      repaired: a.parse.repaired,
      strategy: a.parse.strategy,
    },
    error: a.error
      ? {
          kind: a.error.kind,
          status: a.error.status,
          message: redactServerMessage(a.error.message),
          reachedServer: a.error.reachedServer,
        }
      : undefined,
    latencyMs: a.latencyMs,
    rawSnippet: a.rawSnippet ? a.rawSnippet.slice(0, 200) : undefined,
    repairsApplied: a.repairsApplied,
    maxTokens: a.maxTokens,
    reasoningEffort: a.reasoningEffort,
    responseFormatType: a.responseFormatType,
  };
}

function redactServerMessage(msg: string): string {
  // Belt-and-braces: scrub any "Bearer ..." token if it accidentally
  // ends up in a server message, then truncate.
  const noBearer = msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [REDACTED]");
  return noBearer.length > 240 ? `${noBearer.slice(0, 240)}...` : noBearer;
}

export function writeReport(report: ExperimentReport, dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX}-${report.mode}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

export function formatHumanReport(
  report: ExperimentReport,
  cfg: PrototypeConfig,
): string {
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 provider prototype runner ===");
  lines.push(`mode:         ${report.mode}`);
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config (secrets redacted) ---");
  lines.push(envRedactionLine(cfg));
  lines.push("");
  lines.push("--- experiments ---");
  if (report.attempts.length === 0) {
    lines.push("(no attempts — check --only-* filters)");
  }
  for (const a of report.attempts) {
    const status = a.parse.ok
      ? a.parse.repaired
        ? "OK (repaired)"
        : "OK"
      : a.error
        ? `SKIP (${a.error.kind})`
        : "FAIL";
    const latency = typeof a.latencyMs === "number" ? `${a.latencyMs}ms` : "n/a";
    const summary = a.parse.value?.summary ?? "-";
    const rfTag = a.responseFormatType ? ` rf=${a.responseFormatType}` : "";
    const effortTag = a.reasoningEffort ? ` re=${a.reasoningEffort}` : "";
    lines.push(
      `  [${a.fixture}] ${a.provider}/${a.model} -> ${status} (${latency})${rfTag}${effortTag} summary="${truncate(summary, 60)}"`,
    );
    if (a.parse.errors.length > 0) {
      lines.push(`     parse errors: ${a.parse.errors.join("; ")}`);
    }
    if (a.error) {
      lines.push(`     error: ${a.error.kind} ${a.error.status ?? ""} ${a.error.message}`);
    }
  }
  lines.push("");
  lines.push("--- summary ---");
  lines.push(`  total:     ${report.summary.total}`);
  lines.push(`  parsed:    ${report.summary.parsed}`);
  lines.push(`  parse-fail:${report.summary.parseFailed}`);
  lines.push(`  repaired:  ${report.summary.repaired}`);
  lines.push(`  skipped:   ${report.summary.skipped} (missing config)`);
  for (const [k, v] of Object.entries(report.summary.byProvider)) {
    lines.push(`  ${k}: ${v.parsed}/${v.total} parsed`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/**
 * Public entry point used by the CLI and by tests.
 */
export async function runExperiments(
  options: RunnerOptions,
): Promise<ExperimentReport> {
  const cfg = loadPrototypeConfig({
    ...(options.dotenvPath ? { path: options.dotenvPath } : {}),
    ...(options.dotenvSkip ? { skip: true } : {}),
  });
  const providers = selectProviders(options);
  const fixtures = selectFixtures(options);
  const nimModels = selectNimModels(options, cfg);
  const attempts: ProviderAttempt[] = [];

  if (options.live && !cfg.hasPrimaryKey && providers.includes("minimax")) {
    // Make the missing config visible early.
    process.stderr.write(
      "[cortex-prototype] minimax key missing; live calls to minimax will be skipped\n",
    );
  }
  if (options.live && !cfg.hasFallbackKey && providers.includes("nvidia-nim")) {
    process.stderr.write(
      "[cortex-prototype] nvidia-nim key missing; live calls to nvidia-nim will be skipped\n",
    );
  }
  if (options.live && !cfg.hasGroqKey && providers.includes("groq")) {
    process.stderr.write(
      "[cortex-prototype] groq key missing; live calls to groq will be skipped\n",
    );
  }

  for (const provider of providers) {
    if (provider === "minimax") {
      for (const fx of fixtures) {
        attempts.push(
          await runOneAttempt(
            "minimax",
            cfg.minimaxModel,
            fx.id,
            fx.text,
            cfg,
            options,
          ),
        );
      }
    } else if (provider === "nvidia-nim") {
      for (const model of nimModels) {
        for (const fx of fixtures) {
          attempts.push(
            await runOneAttempt("nvidia-nim", model, fx.id, fx.text, cfg, options),
          );
        }
      }
    } else {
      // groq: prototype-only comparison candidate. One attempt per fixture.
      for (const fx of fixtures) {
        attempts.push(
          await runOneAttempt(
            "groq",
            cfg.groqModel,
            fx.id,
            fx.text,
            cfg,
            options,
          ),
        );
      }
    }
  }

  return buildReport(attempts, cfg, options);
}

// --- CLI entry point ------------------------------------------------------
// Only run when invoked directly. When imported by tests, this is a no-op.
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
    process.stderr.write(`[cortex-prototype] FATAL ${msg}\n`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const cfg = loadPrototypeConfig({});
  const report = await runExperiments(opts);
  const dir = resolveArtifactsDir(cfg, opts);
  const file = writeReport(report, dir);
  process.stdout.write(formatHumanReport(report, cfg) + "\n");
  process.stdout.write(`\nartifact written: ${file}\n`);
}

// Re-export the chat-completion result types so the prototype layer
// has a single import surface.
export type { ChatCompletionResponse, MemoryAnalysis };

// Re-export so the redaction helper stays available to scripts
// that import from the prototype surface.
export { redactValue };
