/**
 * Provider diagnostic.
 *
 * A small, dependency-free probe used by `scripts/provider-diagnostic.ts`
 * to answer the question "is provider X reachable, authenticated, and
 * serving the configured model right now?" without printing or
 * persisting any secret material.
 *
 * Scope (deliberately small):
 *   - One provider per probe call.
 *   - OpenAI-compatible `/chat/completions` request shape, modeled
 *     after `src/providers/http-client.ts` (the same shape Curion's
 *     memory-analysis and recall-synthesis adapters send).
 *   - Single, tiny user message with a fixed short prompt that asks
 *     the model to echo back a single word. `max_tokens` is capped
 *     at 1 so the request is the cheapest request the provider
 *     admits. No sensitive content is ever included.
 *   - Hard timeout via `AbortController`. The timer is cleared on
 *     every successful or failed path.
 *   - Pure helpers for env resolution, payload construction, status
 *     classification, and result formatting so the diagnostic can
 *     be exercised in tests without touching the network.
 *
 * Security:
 *   - API key values are NEVER returned in any field of the probe
 *     result or in any error message. The probe accepts the key as
 *     a private argument and never logs it.
 *   - The `DiagnosticEnvDescriptor` returned to callers contains
 *     only booleans (presence) and the host/path of the endpoint,
 *     plus the model id. No key material crosses the boundary.
 *   - Server error bodies are scrubbed via the same defensive
 *     patterns used in `http-client.ts` (`Bearer ...`, `sk-...`,
 *     `nvapi-...`, named JSON fields) before being included in the
 *     sanitized error message.
 *
 * Classification:
 *   The probe outcome is reduced to a small, stable set of status
 *   classes so a caller (and a test) can branch on the result
 *   without parsing prose:
 *
 *     "ok"                 - 200 OK and the response shape parsed.
 *     "missing-config"     - key, URL, or model not configured.
 *     "timeout"            - AbortController fired before response.
 *     "fetch-failed"       - transport-layer error (DNS, TLS, refused).
 *     "auth"               - HTTP 401 or 403.
 *     "rate-limit"         - HTTP 429.
 *     "not-found"          - HTTP 404 (e.g. unknown model id).
 *     "server"             - HTTP 5xx.
 *     "bad-request"        - HTTP 4xx other than 401/403/404/429.
 *     "malformed-response" - 200 OK but body missing
 *                            choices[0].message.content or non-JSON.
 *     "unknown"            - HTTP status outside the above ranges.
 */

import { sanitizeServerText } from "./http-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Providers the diagnostic knows how to probe. */
export type DiagnosticProviderId = "minimax" | "nvidia-nim";

/**
 * Status classification for a single probe outcome. Stable string
 * literal so callers (and tests) can branch on the value.
 */
export type DiagnosticStatus =
  | "ok"
  | "missing-config"
  | "timeout"
  | "fetch-failed"
  | "auth"
  | "rate-limit"
  | "not-found"
  | "server"
  | "bad-request"
  | "malformed-response"
  | "unknown";

/**
 * Safe description of a provider's environment configuration. No
 * secret values are included; only the *presence* of each piece is
 * reported. Returned by `resolveDiagnosticEnv`.
 */
export interface DiagnosticEnvDescriptor {
  /** Provider id (informational). */
  provider: DiagnosticProviderId;
  /** Resolved base URL (without trailing slash). */
  baseUrl: string;
  /** Resolved model id (informational). */
  model: string;
  /**
   * True iff a non-empty API key is configured for this provider.
   * The key value is NEVER included in the descriptor.
   */
  keyPresent: boolean;
  /** Host portion of `baseUrl`, lowercased, without port. */
  host: string;
  /** Path that will be requested (`/chat/completions`). */
  path: string;
  /** True iff all required config (key + URL + model) is present. */
  ready: boolean;
  /**
   * Names of env vars that were consulted to resolve this
   * descriptor. Useful for the report header so the operator
   * can see which slot the probe used. Values are never returned.
   */
  envVars: readonly string[];
}

/** Options accepted by `probeProvider`. */
export interface ProbeProviderOptions {
  /** Provider id. */
  provider: DiagnosticProviderId;
  /** Resolved base URL (e.g. `https://api.minimax.io/v1`). */
  baseUrl: string;
  /** Model id (e.g. `MiniMax-M3`). */
  model: string;
  /** API key. NEVER logged or returned. */
  apiKey: string;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
  /** Optional fetch override (used by tests). */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for the tiny diagnostic prompt. Defaults to
   * the neutral `"Reply with the single word: pong"`. Kept
   * override-able so tests can assert the exact body.
   */
  userPrompt?: string;
  /**
   * Optional override for the `max_tokens` cap on the request.
   * Defaults to 1 so the probe stays the cheapest request the
   * provider admits.
   */
  maxTokens?: number;
  /**
   * Optional AbortSignal that, when fired, will cancel the
   * probe. The internal timeout uses its own `AbortController`
   * and is composed with this signal via the platform `fetch`
   * standard behavior (signals are forwarded by the runtime).
   * Provided for callers that want to bound a batch of probes.
   */
  outerSignal?: AbortSignal;
}

/** Result of a single provider probe. */
export interface ProbeProviderResult {
  provider: DiagnosticProviderId;
  model: string;
  baseUrl: string;
  status: DiagnosticStatus;
  /** HTTP status code if the server returned one. */
  httpStatus?: number | undefined;
  /** Elapsed wall-clock time of the probe (ms). */
  latencyMs: number;
  /**
   * True iff a server returned a response (i.e. the request
   * passed transport). False for `missing-config`, `timeout`,
   * `fetch-failed`.
   */
  reachedServer: boolean;
  /**
   * Truncated preview of the response content on success. Never
   * longer than 120 chars and never includes the API key.
   */
  contentPreview?: string | undefined;
  /**
   * Sanitized error message for any non-`ok` outcome. The key
   * value (and other secret-shaped patterns) are scrubbed before
   * this is populated.
   */
  errorMessage?: string | undefined;
  /**
   * Classification of any thrown / abort error. Mirrors the
   * numeric HTTP class for HTTP statuses; for transport errors
   * the value is `"fetch-failed"` or `"timeout"`.
   */
  errorClass: DiagnosticStatus;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default diagnostic prompt. Deliberately tiny and non-sensitive:
 * the model is asked to echo a fixed token so the response is
 * cheap, deterministic, and contains no information about the
 * operator or the project.
 */
export const DEFAULT_DIAGNOSTIC_PROMPT = "Reply with the single word: pong";

/** Default per-probe timeout in ms. Short to keep the diagnostic snappy. */
export const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 15_000;

/** Default `max_tokens` for the probe. 1 is the cheapest admissible budget. */
export const DEFAULT_DIAGNOSTIC_MAX_TOKENS = 1;

/** The path the probe always requests. */
export const DIAGNOSTIC_CHAT_COMPLETIONS_PATH = "/chat/completions";

/** Maximum length of the returned `contentPreview`. */
const CONTENT_PREVIEW_MAX = 120;

// ---------------------------------------------------------------------------
// Provider-specific env resolution
// ---------------------------------------------------------------------------

interface ProviderEnvSpec {
  provider: DiagnosticProviderId;
  baseUrlEnvVars: readonly string[];
  modelEnvVars: readonly string[];
  keyEnvVars: readonly string[];
  /** Default base URL when none of the env vars are set. */
  defaultBaseUrl: string;
  /** Default model id when none of the env vars are set. */
  defaultModel: string;
  /** Human-readable label for the report (no secret value). */
  label: string;
}

const MINIMAX_SPEC: ProviderEnvSpec = {
  provider: "minimax",
  baseUrlEnvVars: [
    "CURION_MINIMAX_BASE_URL",
    "CURION_FALLBACK_BASE_URL",
    "CURION_PROVIDER_FALLBACK_BASE_URL",
  ],
  modelEnvVars: ["CURION_MINIMAX_MODEL", "CURION_FALLBACK_MODEL", "CURION_PROVIDER_FALLBACK_MODEL"],
  keyEnvVars: ["CURION_PROVIDER_FALLBACK_KEY", "CURION_FALLBACK_API_KEY", "MINIMAX_API_KEY"],
  defaultBaseUrl: "https://api.minimax.io/v1",
  defaultModel: "MiniMax-M3",
  label: "MiniMax (fallback)",
};

const NIM_SPEC: ProviderEnvSpec = {
  provider: "nvidia-nim",
  baseUrlEnvVars: [
    "CURION_NIM_BASE_URL",
    "CURION_PRIMARY_BASE_URL",
    "CURION_PROVIDER_PRIMARY_BASE_URL",
  ],
  modelEnvVars: [
    "CURION_NIM_FALLBACK_MODEL",
    "CURION_NIM_MODELS",
    "CURION_PRIMARY_MODEL",
    "CURION_PROVIDER_PRIMARY_MODEL",
  ],
  keyEnvVars: ["CURION_PROVIDER_PRIMARY_KEY", "CURION_PRIMARY_API_KEY", "NVIDIA_NIM_API_KEY"],
  defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  // NIM default model is the same one Curion's recall-synthesis
  // primary slot uses (see scripts/recall-synthesis-budget-probe.ts).
  defaultModel: "openai/gpt-oss-120b",
  label: "NVIDIA NIM (primary)",
};

const SPECS: Record<DiagnosticProviderId, ProviderEnvSpec> = {
  minimax: MINIMAX_SPEC,
  "nvidia-nim": NIM_SPEC,
};

/** Public accessor for tests that want to assert the spec wiring. */
export function getProviderSpec(provider: DiagnosticProviderId): ProviderEnvSpec {
  return SPECS[provider];
}

// ---------------------------------------------------------------------------
// Env resolution (pure)
// ---------------------------------------------------------------------------

/**
 * Read a single env var. Returns `undefined` if missing or empty.
 * Pure: takes an `env` bag so tests can drive it deterministically.
 */
function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const v = env[name];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the first non-empty value across the given env var
 * names. Pure: takes an `env` bag. The order of `names` is the
 * precedence order (first non-empty wins).
 */
function firstNonEmpty(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[]
): { value: string | undefined; varName: string | undefined } {
  for (const n of names) {
    const v = readEnv(env, n);
    if (v !== undefined) return { value: v, varName: n };
  }
  return { value: undefined, varName: undefined };
}

/**
 * Build the env var name list consulted for a provider, in the
 * order they would be tried. Used in the report so the operator
 * can see which slot the probe used without echoing values.
 */
export function describeConsultedEnvVars(
  spec: ProviderEnvSpec,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...spec.baseUrlEnvVars, ...spec.modelEnvVars, ...spec.keyEnvVars]) {
    if (readEnv(env, n) !== undefined && !seen.has(n)) {
      out.push(n);
      seen.add(n);
    }
  }
  return out;
}

/**
 * Extract just the host portion of a URL. Returns an empty string
 * when the URL is malformed; the caller treats that as a
 * `missing-config` failure rather than throwing.
 */
export function urlHost(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Strip a trailing slash from a URL so concatenation with the
 * chat-completions path is clean.
 */
export function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve a provider's env to a safe descriptor. No key value is
 * returned; only the boolean `keyPresent`.
 *
 * Pure: takes the env bag explicitly so tests are deterministic.
 * The default `readEnv` parameter reads `process.env` for the
 * script-level caller; production code passes an explicit bag.
 */
export function resolveDiagnosticEnv(
  provider: DiagnosticProviderId,
  env: Readonly<Record<string, string | undefined>> = process.env as Record<
    string,
    string | undefined
  >
): DiagnosticEnvDescriptor {
  const spec = SPECS[provider];
  const baseUrlPick = firstNonEmpty(env, spec.baseUrlEnvVars);
  const modelPick = firstNonEmpty(env, spec.modelEnvVars);
  const keyPick = firstNonEmpty(env, spec.keyEnvVars);

  const baseUrl = baseUrlPick.value ?? spec.defaultBaseUrl;
  const model = modelPick.value ?? spec.defaultModel;
  const keyPresent = keyPick.value !== undefined;

  const host = urlHost(baseUrl);
  const ready = Boolean(baseUrl) && Boolean(model) && keyPresent;

  return {
    provider,
    baseUrl,
    model,
    keyPresent,
    host,
    path: DIAGNOSTIC_CHAT_COMPLETIONS_PATH,
    ready,
    envVars: describeConsultedEnvVars(spec, env),
  };
}

// ---------------------------------------------------------------------------
// Payload construction (pure)
// ---------------------------------------------------------------------------

/** Construct the tiny chat-completions body the probe sends. Pure. */
export function buildProbeRequestBody(opts: {
  model: string;
  userPrompt: string;
  maxTokens: number;
}): Record<string, unknown> {
  return {
    model: opts.model,
    messages: [{ role: "user", content: opts.userPrompt }],
    temperature: 0,
    max_tokens: opts.maxTokens,
    stream: false,
  };
}

// ---------------------------------------------------------------------------
// Status classification (pure)
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP status code into a stable `DiagnosticStatus`.
 * Pure. Exported for tests.
 */
export function classifyHttpStatus(status: number): DiagnosticStatus {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate-limit";
  if (status >= 500 && status <= 599) return "server";
  if (status >= 400 && status <= 499) return "bad-request";
  return "unknown";
}

/**
 * Classify an unknown thrown error into a transport-level
 * `DiagnosticStatus`. Pure: inspects the error message only.
 *
 * Heuristics:
 *   - message contains "abort" + "timeout" / "timed out" -> timeout
 *   - message contains "fetch failed" / "failed to fetch" / "econnrefused" /
 *     "enotfound" / "eai_again" / "etimedout" / "network request failed" /
 *     "getaddrinfo" -> fetch-failed
 *   - anything else: fetch-failed (default for transport errors)
 *
 * We intentionally do NOT try to disambiguate TLS vs. DNS vs. refused
 * at this layer. All transport-level failures collapse into the
 * single `fetch-failed` class so a caller can branch on it; the
 * detail is in `errorMessage`.
 */
export function classifyTransportError(err: unknown): DiagnosticStatus {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("aborted") || lower.includes("abort")) {
    // `AbortController.abort("timeout")` shows up here. We treat
    // any abort-with-reason that names "timeout" as a timeout
    // outcome; the message-only path is the fallback.
    if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
    return "timeout";
  }
  if (
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("etimedout") ||
    lower.includes("network request failed") ||
    lower.includes("getaddrinfo") ||
    lower.includes("socket hang up")
  ) {
    return "fetch-failed";
  }
  return "fetch-failed";
}

/**
 * Classify a 200 OK body whose shape is unexpected (e.g. missing
 * `choices[0].message.content` or non-JSON content). Pure.
 */
export function classifyMalformedBody(
  bodyText: string,
  contentType: string | null
): {
  isMalformed: boolean;
  reason: "non-json" | "missing-content" | "ok";
} {
  const ct = (contentType ?? "").toLowerCase();
  if (!ct.includes("json") && ct.length > 0) {
    return { isMalformed: true, reason: "non-json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { isMalformed: true, reason: "non-json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { isMalformed: true, reason: "non-json" };
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { isMalformed: true, reason: "missing-content" };
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return { isMalformed: true, reason: "missing-content" };
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return { isMalformed: true, reason: "missing-content" };
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    return { isMalformed: true, reason: "missing-content" };
  }
  return { isMalformed: false, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Probe runner (does the network call)
// ---------------------------------------------------------------------------

/**
 * Probe a single provider. Returns a `ProbeProviderResult`. Never
 * throws on expected failure modes; transport errors are caught
 * and classified.
 *
 * The key is passed in by the caller and is never returned in any
 * field of the result. The key IS used to construct the
 * `Authorization: Bearer <key>` header (just like every other
 * OpenAI-compatible call in the project).
 */
export async function probeProvider(opts: ProbeProviderOptions): Promise<ProbeProviderResult> {
  const start = Date.now();
  const userPrompt = opts.userPrompt ?? DEFAULT_DIAGNOSTIC_PROMPT;
  const maxTokens = opts.maxTokens ?? DEFAULT_DIAGNOSTIC_MAX_TOKENS;

  // Missing-config gate. Key presence is reported here as a
  // structured result so the caller can print a clear line for
  // the operator without having to inspect `errorMessage`.
  if (!opts.apiKey || !opts.baseUrl || !opts.model) {
    return {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      status: "missing-config",
      latencyMs: Date.now() - start,
      reachedServer: false,
      errorClass: "missing-config",
      errorMessage: missingConfigReason(opts),
    };
  }

  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const url = `${baseUrl}${DIAGNOSTIC_CHAT_COMPLETIONS_PATH}`;
  const body = JSON.stringify(
    buildProbeRequestBody({
      model: opts.model,
      userPrompt,
      maxTokens,
    })
  );

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), opts.timeoutMs);
  // Compose the outer signal (if any) so a caller that bounds a
  // batch of probes can cancel all of them at once. When the
  // outer signal fires, we abort the inner controller too so the
  // timeout timer is cleaned up via the same path.
  if (opts.outerSignal) {
    if (opts.outerSignal.aborted) {
      ac.abort(opts.outerSignal.reason);
    } else {
      opts.outerSignal.addEventListener("abort", () => ac.abort(opts.outerSignal!.reason), {
        once: true,
      });
    }
  }
  const f = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
        accept: "application/json",
      },
      body,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const classification = classifyTransportError(err);
    // The transport error message may include the key as a URL
    // query string (some runtimes embed it in fetch errors).
    // Scrub defensively before returning.
    const safeMsg = sanitizeServerText(err instanceof Error ? err.message : String(err), [
      opts.apiKey,
    ]);
    const reason = ac.signal.aborted ? "timeout" : classification;
    return {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      status: reason,
      latencyMs,
      reachedServer: false,
      errorClass: reason,
      errorMessage: `${opts.provider}: ${reason} after ${latencyMs}ms: ${safeMsg}`,
    };
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    const status = classifyHttpStatus(res.status);
    const safeText = sanitizeServerText(text, [opts.apiKey]);
    return {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      status,
      httpStatus: res.status,
      latencyMs,
      reachedServer: true,
      errorClass: status,
      errorMessage: `${opts.provider}: HTTP ${res.status} (${status}): ${safeText || "<no body>"}`,
    };
  }

  // 200 OK — try to parse the body and classify the shape.
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    return {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      status: "malformed-response",
      httpStatus: res.status,
      latencyMs,
      reachedServer: true,
      errorClass: "malformed-response",
      errorMessage: `${opts.provider}: HTTP 200 but could not read body: ${(err as Error).message}`,
    };
  }
  const ct = res.headers.get("content-type");
  const malformed = classifyMalformedBody(text, ct);
  if (malformed.isMalformed) {
    const safeText = sanitizeServerText(text, [opts.apiKey]);
    return {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      status: "malformed-response",
      httpStatus: res.status,
      latencyMs,
      reachedServer: true,
      errorClass: "malformed-response",
      errorMessage: `${opts.provider}: HTTP 200 but response shape invalid (${malformed.reason}): ${safeText}`,
    };
  }

  // Extract a short preview of the assistant content for the
  // operator. Truncate to CONTENT_PREVIEW_MAX chars and scrub
  // any secret-shaped patterns (a paranoid defensive pass; the
  // model echoing the prompt shouldn't contain anything secret,
  // but a hijacked upstream could).
  let preview = "";
  try {
    const parsed = JSON.parse(text);
    const first = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
    const content = first?.message?.content;
    if (typeof content === "string") preview = content;
  } catch {
    preview = "";
  }
  const safePreview = sanitizeServerText(preview, [opts.apiKey]);
  const trimmedPreview =
    safePreview.length > CONTENT_PREVIEW_MAX
      ? `${safePreview.slice(0, CONTENT_PREVIEW_MAX)}...`
      : safePreview;

  return {
    provider: opts.provider,
    model: opts.model,
    baseUrl: opts.baseUrl,
    status: "ok",
    httpStatus: res.status,
    latencyMs,
    reachedServer: true,
    errorClass: "ok",
    contentPreview: trimmedPreview || undefined,
  };
}

/**
 * Build the user-visible `errorMessage` for a `missing-config`
 * outcome. Names the specific piece that is missing so the
 * operator can fix it without re-reading the report header.
 */
function missingConfigReason(opts: ProbeProviderOptions): string {
  const missing: string[] = [];
  if (!opts.apiKey) missing.push("api key");
  if (!opts.baseUrl) missing.push("base url");
  if (!opts.model) missing.push("model");
  return `${opts.provider}: missing-config (${missing.join(", ") || "no opts"})`;
}

// ---------------------------------------------------------------------------
// Report formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Format a single probe result as a short human-readable block.
 * Pure: takes a result and an env descriptor and joins fields.
 * No secrets are referenced; only the boolean `keyPresent` and
 * the host/path/model id.
 */
export function formatProbeReport(
  desc: DiagnosticEnvDescriptor,
  result: ProbeProviderResult
): string {
  const lines: string[] = [];
  const label = SPECS[result.provider].label;
  lines.push(`=== ${label} ===`);
  lines.push(`  env:        ${desc.envVars.length > 0 ? desc.envVars.join(", ") : "<defaults>"}`);
  lines.push(`  key present:${desc.keyPresent ? " yes" : " NO (missing)"}`);
  lines.push(`  endpoint:   ${desc.host || "<invalid url>"}${desc.path}`);
  lines.push(`  model:      ${result.model}`);
  lines.push(
    `  status:     ${result.status}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""}`
  );
  lines.push(`  latency:    ${result.latencyMs}ms`);
  lines.push(`  reached:    ${result.reachedServer ? "yes" : "no"}`);
  if (result.status === "ok" && result.contentPreview !== undefined) {
    lines.push(`  preview:    ${JSON.stringify(result.contentPreview)}`);
  }
  if (result.errorMessage) {
    // Single-line, indented. The message itself is already
    // sanitized by `probeProvider`; we just trim it for the
    // report so the block fits on one screen.
    lines.push(`  error:      ${result.errorMessage}`);
  }
  return lines.join("\n");
}

/**
 * Format the top-level report: env snapshot + per-provider probe
 * blocks. Pure.
 */
export function formatDiagnosticReport(
  descriptors: ReadonlyArray<DiagnosticEnvDescriptor>,
  results: ReadonlyArray<ProbeProviderResult>
): string {
  const lines: string[] = [];
  lines.push("=== curion provider diagnostic ===");
  lines.push(`generated at: ${new Date().toISOString()}`);
  lines.push("");
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i];
    const r = results[i];
    if (!d || !r) continue;
    lines.push(formatProbeReport(d, r));
    lines.push("");
  }
  // Summary line: one per result, easy to grep.
  lines.push("--- summary ---");
  for (const r of results) {
    const label = SPECS[r.provider].label;
    lines.push(
      `  ${r.provider.padEnd(11)} ${r.status.padEnd(20)} ${r.latencyMs}ms${r.httpStatus !== undefined ? ` HTTP ${r.httpStatus}` : ""} (${label})`
    );
  }
  return lines.join("\n");
}
