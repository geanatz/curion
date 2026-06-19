/**
 * Central redaction for trace payloads.
 *
 * Goals (Phase 1 foundation):
 *   - Recursive, schema-agnostic walk over arbitrary JSON-like
 *     values. Handles nested objects, arrays, primitives, and
 *     mixtures thereof. Returns a new value; the input is never
 *     mutated.
 *   - Scrub obvious credentials / secrets that appear in:
 *       - object values whose KEY looks like a credential field
 *         (e.g. `apiKey`, `authorization`, `password`, `secret`,
 *         `token`, `bearer`, `cookie`, `set-cookie`,
 *         `private_key`, `client_secret`, ...)
 *       - string values (regex sweep over secret-shaped patterns,
 *         reusing the well-known catalogue from the safety
 *         pre-check so a value such as a free-form log line that
 *         contains a stray `sk-...` key is also caught)
 *       - URL string values: basic-auth credentials in the
 *         `user:password@host` authority are stripped.
 *   - Remove hidden reasoning / chain-of-thought fields and
 *     `<think>...</think>` blocks. The entire KEY is dropped (not
 *     redacted in place) so a downstream reader never even sees
 *     the field name. Object values for the dropped key are
 *     removed; string values are scanned for `` blocks
 *     and the block content is replaced with `<redacted>`.
 *   - Safe on unserializable / circular payloads. A `WeakSet`
 *     tracks objects already visited on the current walk path;
 *     cycles are broken by emitting the string `<circular>`.
 *     Other unserializable leaves (functions, symbols, BigInt)
 *     are stringified to a safe placeholder.
 *   - Bounded depth and breadth so a hostile payload cannot
 *     trigger runaway recursion. Defaults are generous (32 deep,
 *     4096 elements per array) but finite.
 *
 * The function is pure with respect to its input: it never reads
 * from the network, never writes to disk, never throws.
 *
 * The output is safe to feed to `JSON.stringify` and into the
 * trace storage. The trace storage layer will still wrap the
 * write in a try/catch as defense in depth, but this function
 * will not produce circular references in normal use.
 */

// ---------------------------------------------------------------------------
// Pattern catalogue
// ---------------------------------------------------------------------------

/**
 * Subset of the safety pre-check secret catalogue. We duplicate
 * the patterns (rather than import from `safety/precheck.ts`) so
 * the trace module stays standalone and unit-testable without
 * pulling in the safety pre-check's classification state.
 * Both catalogues should track each other over time; the trace
 * writer is allowed to err on the side of more redaction.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // AWS access key id (canonical 20-char body)
  /\bAKIA[0-9A-Z]{16}\b/g,
  // AWS secret access key (40 base64-ish, in context with the word "secret")
  /\baws_?secret[_a-z0-9]{0,16}\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/gi,
  // OpenAI / OpenAI-style sk- (20+ body)
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  // GitLab PAT
  /\bglpat-[A-Za-z0-9_\-]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API key
  /\bAIza[A-Za-z0-9_\-]{30,}\b/g,
  // NVIDIA NIM key
  /\bnvapi-[A-Za-z0-9_\-]{20,}\b/g,
  // Generic bearer / authorization header value
  /\bbearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi,
  // PEM private key block (header)
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  // Generic password/secret/token assignment (case-insensitive)
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

/**
 * Object keys whose VALUES should be redacted regardless of the
 * value's content. Matched case-insensitively. The list is
 * conservative: when in doubt, redact. Common credential and
 * identity fields from HTTP headers, OAuth, JWT, and the
 * OpenAI / Anthropic / NIM / Groq wire formats.
 */
const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^api[_-]?key$/i,
  /^apikey$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^id[_-]?token$/i,
  /^auth(orization)?$/i,
  /^bearer$/i,
  /^cookie$/i,
  /^set[_-]?cookie$/i,
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^secret$/i,
  /^client[_-]?secret$/i,
  /^private[_-]?key$/i,
  /^aws[_-]?access[_-]?key[_-]?id$/i,
  /^aws[_-]?secret[_-]?access[_-]?key$/i,
  /^x[_-]?api[_-]?key$/i,
  /^x[_-]?auth[_-]?token$/i,
  /^proxy[_-]?authorization$/i,
];

/**
 * Object keys whose presence means "hidden reasoning /
 * chain-of-thought / internal thinking". The KEY itself is
 * removed from the redacted output (not just the value). Matched
 * case-insensitively.
 */
const REASONING_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^reasoning$/i,
  /^reasoning[_-]?content$/i,
  /^chain[_-]?of[_-]?thought$/i,
  /^chain[_-]?thought$/i,
  /^cot$/i,
  /^thoughts?$/i,
  /^thinking$/i,
  /^hidden[_-]?reasoning$/i,
  /^internal[_-]?reasoning$/i,
  /^internal[_-]?thinking$/i,
  /^scratchpad$/i,
  /^reflect(ion)?$/i,
  /^reflection$/i,
  /^hidden[_-]?analysis$/i,
  /^analysis$/i, // best-effort: `analysis` is sometimes CoT; we drop it for trace
  /^plan$/i, // frequently a CoT carrier in some providers
];

/**
 * Free-form string patterns for reasoning / CoT in raw text.
 * `<think>...</think>` blocks are replaced with `<redacted>`.
 * `<think>` may appear with leading whitespace, line breaks, or
 * HTML escaping; we accept the common variants conservatively.
 */
const REASONING_BLOCK_RE: RegExp =
  /<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi;

/**
 * URL basic-auth credentials: `scheme://user:password@host`.
 * When the authority contains a `user:password@` segment we
 * replace it with `user:<redacted>@` so the host is still
 * visible but the password is gone. The scheme and path are
 * preserved unchanged.
 */
const URL_BASIC_AUTH_RE: RegExp =
  /([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)([^/\s?#"]+)(@)/g;

/**
 * JSON-in-string credential fields. Catches occurrences like
 * `"apiKey":"sk-abc..."` embedded in a free-form log line.
 */
const JSON_CREDENTIAL_RE: RegExp =
  /("(?:api[_-]?key|apikey|token|authorization|password|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)"\s*:\s*)"([^"]*)"/gi;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on recursion depth. A 32-deep payload is already exotic. */
const MAX_DEPTH = 32;

/** Hard cap on the number of array elements walked. */
const MAX_ARRAY_LEN = 4096;

/** Hard cap on the number of object keys walked per object. */
const MAX_OBJECT_KEYS = 512;

/** Hard cap on the number of reasoning blocks replaced per string. */
const MAX_BLOCK_REPLACEMENTS = 32;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactOptions {
  /**
   * Maximum recursion depth. Defaults to `MAX_DEPTH` (32). At or
   * beyond the cap, the value is replaced with `<redacted>`.
   */
  maxDepth?: number;
  /**
   * If true (default), strip URL basic-auth credentials from any
   * string values that parse as URLs with `user:password@`. Set
   * to false to skip URL scrubbing.
   */
  redactUrlCredentials?: boolean;
  /**
   * If true (default), strip `<think>...</think>` blocks from
   * any string values. Set to false to keep the block content.
   */
  stripThinkingBlocks?: boolean;
}

/**
 * Recursively redact an arbitrary payload. Returns a new value
 * with the same shape as the input (modulo redacted / dropped
 * fields). The function never throws; circular references and
 * unserializable leaves are surfaced as plain strings.
 */
export function redactPayload(value: unknown, options: RedactOptions = {}): unknown {
  const opts = {
    maxDepth: options.maxDepth ?? MAX_DEPTH,
    redactUrlCredentials: options.redactUrlCredentials ?? true,
    stripThinkingBlocks: options.stripThinkingBlocks ?? true,
  };
  const seen = new WeakSet<object>();
  return walk(value, 0, seen, opts);
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function walk(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  opts: Required<RedactOptions>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactStringValue(value, opts);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    // BigInt is not JSON-serializable by default. Convert to a
    // safe string so downstream storage does not choke.
    return `<bigint:${value.toString()}>`;
  }
  if (typeof value === "function") {
    return `<function:${(value as { name?: string }).name ?? "anonymous"}>`;
  }
  if (typeof value === "symbol") {
    return `<symbol:${value.toString() ?? "symbol"}>`;
  }
  if (depth >= opts.maxDepth) {
    return "<redacted:depth-cap>";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    const cap = Math.min(value.length, MAX_ARRAY_LEN);
    const out: unknown[] = new Array(cap);
    for (let i = 0; i < cap; i += 1) {
      out[i] = walk(value[i], depth + 1, seen, opts);
    }
    if (value.length > cap) {
      out.push(`<truncated:${value.length - cap} more>`);
    }
    return out;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "<circular>";
    seen.add(obj);
    return walkObject(obj, depth, seen, opts);
  }
  return `<unserializable:${typeof value}>`;
}

function walkObject(
  obj: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
  opts: Required<RedactOptions>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(obj)) {
    if (kept >= MAX_OBJECT_KEYS) {
      out["<truncated>"] = `${Object.keys(obj).length - kept} more keys`;
      break;
    }
    if (matchesAny(key, REASONING_KEY_PATTERNS)) {
      // Drop the entire key. We do not surface the value at all,
      // not even a redacted placeholder — the request was to
      // remove hidden reasoning fields entirely.
      continue;
    }
    if (matchesAny(key, SENSITIVE_KEY_PATTERNS)) {
      out[key] = "<redacted>";
      kept += 1;
      continue;
    }
    out[key] = walk(obj[key], depth + 1, seen, opts);
    kept += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// String scrubbing
// ---------------------------------------------------------------------------

function redactStringValue(
  value: string,
  opts: Required<RedactOptions>,
): string {
  if (value.length === 0) return value;
  let out = value;
  if (opts.stripThinkingBlocks) {
    out = scrubReasoningBlocks(out);
  }
  out = scrubSecretValues(out);
  if (opts.redactUrlCredentials) {
    out = scrubUrlBasicAuth(out);
  }
  out = scrubJsonCredentialFields(out);
  return out;
}

function scrubReasoningBlocks(s: string): string {
  // REASONING_BLOCK_RE has the `g` flag. We replace with a safe
  // placeholder rather than the empty string so length / position
  // diagnostics still see something was here. The cap on
  // replacements keeps pathological inputs bounded.
  let count = 0;
  return s.replace(REASONING_BLOCK_RE, () => {
    count += 1;
    if (count > MAX_BLOCK_REPLACEMENTS) return "<redacted:thinking-block-truncated>";
    return "<redacted:thinking-block>";
  });
}

function scrubSecretValues(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, "<redacted>");
  }
  return out;
}

function scrubUrlBasicAuth(s: string): string {
  // Only touch substrings that look like a URL with a basic-auth
  // authority. We avoid matching `mailto:foo@bar` or any non-URL
  // `user@host` by requiring the `://` prefix and the `@` after
  // a non-slash / non-whitespace / non-quote authority.
  return s.replace(URL_BASIC_AUTH_RE, (_m, scheme: string, auth: string, at: string) => {
    // auth is "user:password" or just "user". Only strip the
    // password; keep the user so logs still show who was used.
    const idx = auth.indexOf(":");
    if (idx < 0) return `${scheme}${auth}${at}`;
    const user = auth.slice(0, idx);
    return `${scheme}${user}:<redacted>${at}`;
  });
}

function scrubJsonCredentialFields(s: string): string {
  // `"key":"value"` -> `"key":"<redacted>"`
  return s.replace(JSON_CREDENTIAL_RE, (_m, prefix: string) => `${prefix}"<redacted>"`);
}

function matchesAny(key: string, patterns: ReadonlyArray<RegExp>): boolean {
  for (const re of patterns) {
    if (re.test(key)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Convenience helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Redact a single free-form string. Equivalent to wrapping the
 * string in `{ s: "..." }` and reading `s` back, but avoids the
 * object round-trip. Exposed for callers that already know the
 * value is a string (e.g. log line scrubber).
 */
export function redactString(value: string, options: RedactOptions = {}): string {
  const opts = {
    maxDepth: options.maxDepth ?? MAX_DEPTH,
    redactUrlCredentials: options.redactUrlCredentials ?? true,
    stripThinkingBlocks: options.stripThinkingBlocks ?? true,
  };
  return redactStringValue(value, opts);
}

/**
 * Stable list of redacted object keys (lowercased). Exposed for
 * tests and for any future introspection that wants to know
 * which keys were redacted. Order is preserved.
 */
export const SENSITIVE_KEY_PATTERNS_EXPORT = SENSITIVE_KEY_PATTERNS;
export const REASONING_KEY_PATTERNS_EXPORT = REASONING_KEY_PATTERNS;
export const REASONING_BLOCK_PATTERN_EXPORT = REASONING_BLOCK_RE;
