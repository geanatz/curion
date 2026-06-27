/**
 * Safety pre-check for `remember(text)`.
 *
 * Runs deterministic, local pattern checks against the input *before*
 * the controller ever sends the input to a provider. The goal is to
 * keep obvious unsafe or useless input from leaving the local process
 * and to keep obvious secrets out of the persisted store and out of
 * the provider request body.
 *
 * Two layers:
 *
 *   1. `classifyInput` — coarse classification. Returns one of:
 *        - "safe"                  (proceed to provider/controller)
 *        - "secret"                (clear credential-shaped string)
 *        - "raw-dump"              (large env-dump / log paste)
 *        - "vague-junk"            (low-signal, no useful content)
 *        - "mixed-safe-sensitive"  (contains BOTH safe and sensitive)
 *        - "prompt-injection"      (instruction-override / future-agent
 *                                   instruction attempt)
 *        - "unsafe-preference"     (instruction that would poison
 *                                   the safety / persistence policy)
 *        - "self-conflict"         (one input states two opposing
 *                                   project facts and needs a focused
 *                                   clarification)
 *
 *   2. `redactSummary` — used by the controller on the provider's
 *      returned summary to scrub any secret-shaped fragments that
 *      slipped through the prompt. Defense in depth: the provider
 *      is not trusted to keep secrets out of its own output.
 *
 * Conservative defaults:
 *   - When the input contains BOTH safe and sensitive fragments,
 *     classify as `mixed-safe-sensitive` and reject. Deterministic
 *     redaction of mixed input is intentionally out of scope for the
 *     MVP slice (see the spec's "safer temporary default" rule).
 *   - "secret" and "vague-junk" are hard rejects.
 *   - "raw-dump" is a hard reject if the dump is dominated by
 *     secret-shaped lines; otherwise it is a strong signal to ask
 *     for clarification. For the MVP slice, we treat it as
 *     `vague-junk` (reject) to keep secrets out of the provider.
 *   - "prompt-injection" and "unsafe-preference" are hard rejects.
 *     They are checked AFTER secret/dump detection, so an input
 *     that contains BOTH a secret and injection-style language is
 *     classified as `mixed-safe-sensitive` (or `secret` if there is
 *     no substantive safe content around the secret) — not as
 *     `prompt-injection`. The "sensitive content takes precedence
 *     over injection" rule is what keeps secrets out of provider
 *     request bodies and the persisted store. The exact class is
 *     `mixed-safe-sensitive` when the non-secret content is more
 *     than a short descriptive phrase (> 40 chars), and `secret`
 *     otherwise.
 *   - "self-conflict" is a clarification request, not a reject; the
 *     caller is asked to disambiguate without losing the content
 *     entirely.
 *
 * Benign-handoff allow-list (tuning):
 *   The injection and unsafe-preference patterns are deliberately
 *   strict about *what action* a future-agent or override
 *   instruction asks for. Phrases like "tell the next agent to
 *   read CONTRIBUTING.md first" or "set up the next agent to
 *   always check tests first" are normal project handoffs and do
 *   not match. Likewise, "the rule says: 'ignore previous
 *   instructions' should never appear in user input" is a
 *   meta-discussion of the safety policy itself; the text is
 *   documentation of what the patterns guard against, not an
 *   injection attempt. Bypass/disable-redaction phrases are also
 *   not flagged when they are clearly scoped to test runs, test
 *   fixtures, docs, or public examples (e.g. "we bypass the
 *   safety check during test runs", "we disable redaction for
 *   public docs examples only"). The same phrases WITHOUT that
 *   scope are still rejected.
 *
 * All patterns are local, deterministic regexes. No network, no
 * model call. Patterns are intentionally conservative (low false
 * negative) — they will occasionally flag benign input as a safety
 * class, which is the correct trade-off for the MVP.
 */

import { logger } from "../logging/logger.js";

/** Coarse safety classification used by the controller pre-check. */
export type SafetyClass =
  | "safe"
  | "secret"
  | "raw-dump"
  | "vague-junk"
  | "mixed-safe-sensitive"
  | "prompt-injection"
  | "unsafe-preference"
  | "self-conflict"
  // Hardening pass (clarification-field-redesign followup):
  //   - "vague-memory"          — input references an unspecified past
  //                                decision / discussion (e.g. "the thing
  //                                we decided earlier"). Carries
  //                                clarification_needed so the user can
  //                                supply the actual memory.
  //   - "replacement-correction" — input asserts a direct
  //                                correction / replacement of one
  //                                named thing by another (e.g.
  //                                "Postgres, not SQLite"). Temporal
  //                                change ("used SQLite before, but
  //                                now uses Postgres") is intentionally
  //                                NOT matched here — the existing
  //                                `self-conflict` detector handles
  //                                temporal pivots.
  | "vague-memory"
  | "replacement-correction";

/** Outcome of the pre-check. */
export interface SafetyCheckResult {
  /** Coarse classification. */
  class: SafetyClass;
  /** Short human-readable reason. Never echoes input. */
  reason: string;
  /** Set when the input contained a secret-shaped fragment. */
  containsSecret: boolean;
  /** Set when the input looks like a raw env dump or log paste. */
  looksLikeDump: boolean;
  /** Set when the input is too short or low-signal to be useful. */
  looksLikeJunk: boolean;
}

// ---------------------------------------------------------------------------
// Pattern catalogue
// ---------------------------------------------------------------------------

/**
 * Credential / secret-shaped patterns. Each pattern is conservative:
 * it requires a recognizable prefix and a minimum length, so we
 * don't false-positive on identifiers like `sk-` inside normal
 * documentation. The `REDACTED` test value is intentionally NOT in
 * the corpus so the safety scanner doesn't fight with redaction
 * tests; only the secret-shaped value should fire.
 */
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // AWS access key id (canonical 20-char body)
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-access-key" },
  // AWS secret access key (40 base64-ish, in context with the word "secret")
  {
    re: /\baws_?secret[_a-z0-9]{0,16}\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{30,}/gi,
    label: "aws-secret-key",
  },
  // OpenAI / OpenAI-style sk- (20+ body)
  { re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g, label: "openai-key" },
  // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: "github-token" },
  // GitLab PAT
  { re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g, label: "gitlab-pat" },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
  // Google API key
  { re: /\bAIza[A-Za-z0-9_\-]{30,}\b/g, label: "google-api-key" },
  // NVIDIA NIM key
  { re: /\bnvapi-[A-Za-z0-9_\-]{20,}\b/g, label: "nvidia-nim-key" },
  // Generic bearer / authorization header value
  {
    re: /\bbearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi,
    label: "bearer-token",
  },
  // PEM private key block (header)
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, label: "pem-private-key" },
  // Generic password/secret/token assignment (case-insensitive)
  {
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/gi,
    label: "credential-assignment",
  },
];

/**
 * Patterns that suggest the input is a raw env dump or a log paste
 * (a wall of `KEY=VALUE` lines, or a sequence of timestamped log
 * lines). Combined with a count heuristic below.
 */
const DUMP_HINT_PATTERNS: ReadonlyArray<RegExp> = [
  // ISO timestamp at start of a line (date + time)
  /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m,
  // Common log severity tag in brackets
  /^\s*\[(INFO|DEBUG|WARN|WARNING|ERROR|FATAL|TRACE)\]/m,
  // KEY=VALUE (uppercase env var name) — repeated 3+ times
  /^[A-Z][A-Z0-9_]{2,}=.+$/m,
  // Common log prefixes (syslog, kubectl, journald)
  /^\s*(?:[A-Z][a-z]{2} +\d+ +\d{2}:\d{2}:\d{2} |[\w\-]+\[\d+\]: )/m,
  // HTTP request/response header block (Header: value) — 3+ lines
  /^\s*[A-Za-z0-9-]{2,40}\s*:\s*[^\n]{1,200}$/m,
];

/**
 * Patterns for prompt-injection / future-agent instruction attempts.
 *
 * These are phrases where the user appears to be trying to override
 * the model's system instructions, change its role, or instruct
 * future agents to act in unsafe ways. Each pattern is anchored on a
 * distinctive verb phrase so that ordinary project documentation
 * that happens to mention "system prompt" in passing (e.g. "we
 * removed it from the system prompt") is less likely to false-fire.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // "ignore previous / prior / above / earlier instructions"
  {
    re: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier|above[\s-]mentioned|system)\s+(?:instructions|prompts|rules|directives|context)\b/i,
    label: "ignore-instructions",
  },
  // "disregard / forget / override ... instructions"
  {
    re: /\b(?:disregard|forget|override|bypass|circumvent)\s+(?:all\s+)?(?:previous|prior|above|earlier|safety|system)\s+(?:instructions|rules|guidelines|prompts|directives)\b/i,
    label: "override-instructions",
  },
  // "you are now / act as / pretend to be / role-play as"
  {
    re: /\b(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are)|role[\s-]?play\s+as|behave\s+as\s+if|switch\s+to\s+(?:the\s+)?role\s+of)\b/i,
    label: "role-override",
  },
  // "reveal / show / print / output ... system prompt / hidden prompt / internal instructions"
  {
    re: /\b(?:reveal|show|print|output|dump|leak|expose|disclose)\s+(?:the\s+|your\s+)?(?:system\s+prompt|hidden\s+prompt|internal\s+(?:prompt|instructions|directives|rules)|developer\s+prompt|original\s+instructions|secret\s+instructions)\b/i,
    label: "system-prompt-reveal",
  },
  // "do not / never follow / stop following the safety / the rules"
  {
    re: /\b(?:do\s+not|never|stop)\s+follow\s+(?:the\s+)?(?:safety\s+)?(?:rules|guidelines|policies|instructions|restrictions)\b/i,
    label: "ignore-safety",
  },
  // "jailbreak / DAN / developer mode" style triggers
  {
    re: /\b(?:jailbreak|developer\s+mode(?:\s+(?:enabled|on|now))?|DAN\s+mode|enter\s+DAN|no\s+filter\s+mode|unfiltered\s+mode)\b/i,
    label: "jailbreak-trigger",
  },
  // Future-agent instruction attempts (e.g. "tell the next agent
  // to bypass safety"). Restricted to clearly unsafe action verbs
  // so that ordinary project handoffs like "tell the next agent
  // to read CONTRIBUTING.md first" or "set up the next agent to
  // always check tests first" are not flagged.
  {
    re: /\b(?:tell|instruct|program|configure|set\s+up)\s+(?:the\s+)?(?:next|future|coming|subsequent|downstream|any)\s+(?:agent|assistant|model|llm|ai)\s+to\s+(?:bypass|skip|disable|turn\s+off|switch\s+off|opt[\s-]?out(?:\s+of)?|override|ignore|disregard|forget|reveal|show|leak|exfiltrate|dump|expose|disclose|never\s+redact|not\s+redact|remove\s+redaction|drop\s+redaction|enter\s+(?:DAN|developer\s+mode|unfiltered\s+mode|no\s+filter\s+mode)|jailbreak|persist\s+(?:the\s+)?(?:raw|original|verbatim|unredacted))\b/i,
    label: "future-agent-instruction",
  },
  // "from now on / going forward, you will / you must / always [do]"
  {
    re: /\bfrom\s+now\s+on|going\s+forward|effective\s+immediately|as\s+of\s+now\b[^.]*\b(?:you\s+(?:will|must|should|shall|always|never)|always\s+(?:do|perform|execute|include|append|prepend))\b/i,
    label: "policy-override",
  },
];

/**
 * Patterns for unsafe durable preferences / safety-policy poisoning.
 *
 * These are user requests that, if honored, would weaken the safety
 * or persistence policy: storing secrets in long-term memory,
 * disabling redaction, bypassing safety checks, persisting raw input
 * forever, revealing the system prompt, exfiltrating stored data,
 * or weakening redaction. All of these are hard rejects; the
 * controller never sees them, and the input is never stored.
 */
const UNSAFE_PREFERENCE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // "remember / store / persist / keep ... [secret|token|password|key] [forever|permanently|always]"
  {
    re: /\b(?:remember|store|persist|save|keep|retain|log)\s+(?:this\s+|the\s+|my\s+)?(?:api[_ -]?key|token|password|secret|passwd|pwd|credential|private[_ -]?key|oauth|refresh[_ -]?token)\s+(?:forever|permanently|always|indefinitely|long[\s-]?term|without\s+(?:redact|expir|delet))\b/i,
    label: "store-secret-forever",
  },
  // "do not / never redact / redacting / redacted / scrubs / scrubbing /
  //  strips / stripping / filters / filtering / removes / removing /
  //  masks / masking / hides / hiding / drops / dropping
  //  [secrets|tokens|keys|credentials|passwords|api keys|private keys]"
  // The verb stems cover the bare form and common inflections
  // (present-participle `-ing`, past-tense `-ed`, and the doubled-
  // consonant forms like `scrubbing`/`stripping`/`dropping`); the
  // noun list covers singular and plural. The closing alternation
  // on the noun side keeps the pattern from false-firing on
  // unrelated phrases like "never filter input" (no secret-shaped
  // noun after the verb). The first pattern allows up to 120 chars
  // between the verb and the noun, which catches both "stop
  // redacting the API keys in production" and short variants.
  {
    re: /\b(?:do\s+not|don'?t|never|stop|disable)\s+(?:redact(?:s|ed|ing)?|scrub(?:s|bed|bing)?|strip(?:s|ped|ping)?|filter(?:s|ed|ing)?|remov(?:es|ed|ing|e)|mask(?:s|ed|ing)?|hid(?:es|e|ing|den)|drop(?:s|ped|ping)?)\b[^.]{0,120}\b(?:secret|tokens?|keys?|passwords?|credentials?|api[_ -]?keys?|private[_ -]?keys?)\b/i,
    label: "disable-redaction",
  },
  // Tighter variant: verb directly followed by a secret-shaped noun,
  // no gap. Catches short phrases like "stop masking tokens",
  // "don't hide secrets", and "never remove api keys" where there
  // is no meaningful distance between the verb and the noun. Same
  // verb inflection coverage and noun plural coverage as the
  // looser pattern above.
  {
    re: /\b(?:do\s+not|don'?t|never|stop|disable)\s+(?:redact(?:s|ed|ing)?|scrub(?:s|bed|bing)?|strip(?:s|ped|ping)?|filter(?:s|ed|ing)?|remov(?:es|ed|ing|e)|mask(?:s|ed|ing)?|hid(?:es|e|ing|den)|drop(?:s|ped|ping)?)\s+(?:secrets?|tokens?|keys?|passwords?|credentials?|api[_ -]?keys?|private[_ -]?keys?)\b/i,
    label: "disable-redaction",
  },
  // "bypass / skip / turn off / disable [the] safety / safety check / redaction"
  {
    re: /\b(?:bypass|skip|turn\s+off|disable|switch\s+off|opt[\s-]?out\s+of|do\s+not\s+run)\s+(?:the\s+|all\s+)?(?:curion\s+)?(?:safety|safety\s+(?:check|filter|redaction|guard|fence|policy|policies|rules))(?:\s+(?:check|filter|redaction|guard|fence|policy|policies|rules))?\b/i,
    label: "bypass-safety",
  },
  // "persist / save / store raw text / input verbatim / original input"
  {
    re: /\b(?:persist|save|store|keep|retain|log)\s+(?:the\s+)?(?:raw|original|verbatim|untouched|unredacted|unfiltered|unprocessed)\s+(?:text|input|message|prompt|user\s+input)\b/i,
    label: "persist-raw-input",
  },
  // "remember ... forever / indefinitely / permanently" (broad durable policy)
  {
    re: /\bremember\s+(?:everything|all\s+(?:inputs?|messages?|user\s+(?:inputs?|messages?)))\b[^.!?\n]{0,80}?\b(?:forever|permanently|always|indefinitely|without\s+(?:expir|delet|redact))\b/i,
    label: "remember-everything-forever",
  },
  // "reveal / show / leak / exfiltrate / send out ... [system prompt / secrets / stored memories / stored data]"
  {
    re: /\b(?:reveal|show|leak|exfiltrate|send|email|post|publish|export|dump)\s+(?:the\s+|all\s+)?(?:system\s+prompt|stored\s+(?:memories?|data|secrets?)|persisted\s+(?:memories?|data|secrets?)|saved\s+(?:memories?|secrets?)|all\s+secrets?)\b/i,
    label: "exfiltrate-stored",
  },
  // "send / post / publish ... [persisted/stored data] out"
  {
    re: /\b(?:send|post|publish|email|forward|upload)\b[^.!?\n]{0,80}\b(?:persisted|stored|saved|persisted)\s+(?:memories?|data|secrets?)\b[^.!?\n]{0,40}\b(?:out|away|off|externally|to\s+(?:a\s+)?webhook|to\s+(?:a\s+)?(?:third[\s-]?party|external)\s+(?:service|server|endpoint))\b/i,
    label: "exfiltrate-stored",
  },
  // "ignore / override / disable [the] redaction"
  {
    re: /\b(?:ignore|override|disable|turn\s+off|switch\s+off)\s+(?:the\s+|all\s+)?redaction\b/i,
    label: "disable-redaction",
  },
  // "persist / save / store ... original/raw/verbatim ... text/input" (broader
  // adjective combinations, e.g. "original raw user text")
  {
    re: /\b(?:persist|save|store|keep|retain|log)\s+(?:the\s+)?(?:(?:raw|original|verbatim|untouched|unredacted|unfiltered|unprocessed)\s+){1,3}(?:text|input|message|prompt|user\s+(?:text|input)|content)\b/i,
    label: "persist-raw-input",
  },
  // "exfiltrate / leak / send out / dump / publish ... secrets / tokens / keys"
  // (broad: any "exfiltrate secrets" without requiring a "stored" qualifier)
  {
    re: /\b(?:reveal|show|leak|exfiltrate|send|email|post|publish|export|dump)\b[^.!?\n]{0,80}\b(?:secrets?|tokens?|api[_ -]?keys?|passwords?|credentials?|private[_ -]?keys?)\b[^.!?\n]{0,40}\b(?:out|away|off|externally|to\s+(?:a\s+)?webhook|to\s+(?:a\s+)?(?:third[\s-]?party|external)\s+(?:service|server|endpoint))\b/i,
    label: "exfiltrate-stored",
  },
  // "exfiltrate secrets" (no transport qualifier, but still a clear
  // policy-bypass attempt — pulling secrets out of the system)
  {
    re: /\b(?:exfiltrate|leak|publish|export|dump)\s+(?:the\s+|all\s+|any\s+)?(?:secrets?|tokens?|api[_ -]?keys?|credentials?)\b/i,
    label: "exfiltrate-secrets",
  },
  // "exfiltrate / leak on recall / when recalling" — second-order
  // policy-bypass: turn the recall tool into a secret-exfil channel
  {
    re: /\b(?:on|when|while|if|during)\s+recall(?:ing|ed)?\b[^.!?\n]{0,80}\b(?:exfiltrate|leak|dump|publish|export|send\s+out|email\s+out|post\s+out)\b/i,
    label: "exfiltrate-on-recall",
  },
  // "this memory overrides the / Curion safety policy" / "overrides
  // safety policy" — direct policy-override attempts
  {
    re: /\b(?:overrides?|override)\s+(?:the\s+|curion\s+|our\s+|all\s+)?(?:safety\s+(?:policy|policies|rules|guidelines)|curion\s+safety(?:\s+(?:policy|policies|rules|guidelines))?)\b/i,
    label: "policy-override-direct",
  },
];

/**
 * Deterministic self-conflict patterns.
 *
 * Goal: detect a *single* user message that asserts two opposing
 * declarative project facts without resolving which is canonical.
 * We do not perform semantic NLP; we only fire on narrow,
 * high-signal syntactic patterns. False negatives are acceptable
 * here: an undetected self-conflict falls through to the provider,
 * which may return a low confidence that the controller already
 * routes to `clarification_needed` via the existing
 * confidence-threshold gate.
 *
 * Pattern A — "X. Actually / Wait, / Correction: / Update: ... Y"
 *   where X and Y are both declarative, terminal-punctuated
 *   statements on the same topic (matched by shared topic words
 *   before and after the pivot phrase).
 * Pattern B — "X (also / though / but / however) Y contradicts X"
 *   style, same topic token.
 * Pattern C — "previously / earlier / old / v1 ... X. Now /
 *   currently / as of ... Y" where both X and Y are declarative.
 */
const SELF_CONFLICT_PIVOT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:actually|wait,?\s*no|wait[,.]\s*actually|correction|update[s]?:|nvm|never\s*mind)\b/i,
  /\b(?:previously|earlier|old|old\s+version|at\s+first|initially)\b/i,
  /\b(?:now|currently|as\s+of|going\s+forward|new\s+version|updated)\b/i,
];

interface SelfConflictHit {
  /** Stable label for the pivot phrase that triggered detection. */
  label: string;
}

/**
 * Run a narrow, deterministic self-conflict check. Returns a hit if
 * the input contains a single message that asserts two opposing
 * declarative project facts.
 *
 * The detector is intentionally conservative: it only fires on
 * clear "X. ... pivot ... Y" structures with shared topic tokens.
 * It is not a semantic conflict detector; it cannot understand
 * negation in natural language. The conservative behavior is
 * "miss a real conflict" rather than "fabricate a conflict from a
 * benign description".
 */
function detectSelfConflict(text: string): SelfConflictHit | null {
  // Split on a clear pivot phrase. Each candidate must be a
  // non-trivial declarative clause (>= 8 chars, contains a letter,
  // ends with sentence punctuation or a hard line break).
  //
  // The pivot phrase is followed by an optional punctuation cluster
  // (`:` `,` `-` whitespace) that we consume as part of the match.
  // We deliberately do NOT use `\b` after the alternation because
  // alternatives ending in `:` have no word boundary between the
  // `:` and the following space.
  const pivotRe = /\s*[.!?]\s+(?:actually|wait,?\s*no|wait[,.]\s*actually|correction|updates?:|update\b|nvm|never\s*mind)\b[\s,:-]*/i;
  const m = text.match(pivotRe);
  if (m && m.index !== undefined) {
    const left = text.slice(0, m.index).trim();
    const right = text.slice(m.index + m[0].length).trim();
    if (isDeclarativeClause(left) && isDeclarativeClause(right) && sharesTopicToken(left, right)) {
      return { label: "retraction-pivot" };
    }
  }
  // "previously / earlier ... X. ... now / currently / as of ... Y"
  const changeRe = /\b(previously|earlier|at\s+first|initially|old\s+version|v1)\b[\s,]{1,40}([^.!?\n]{8,200})[.!?\n]+\s*(now|currently|as\s+of|going\s+forward|new\s+version|v2|updated|latest)\b[\s,]{1,40}([^.!?\n]{8,200})[.!?\n]?/i;
  const cm = text.match(changeRe);
  if (cm) {
    const left = (cm[2] ?? "").trim();
    const right = (cm[4] ?? "").trim();
    if (isDeclarativeClause(left) && isDeclarativeClause(right) && sharesTopicToken(left, right)) {
      return { label: "temporal-change" };
    }
  }
  // "X but / however Y" where X and Y contradict at the syntactic
  // level (e.g. "uses Postgres" vs "uses MySQL"). This is a narrow
  // case: both halves must be short, declarative, and the second
  // must contain a database / library / framework name AND a
  // negation-style pivot.
  const dbRe = /\b(?:uses?|using|runs?\s+on|powered\s+by|based\s+on)\s+([A-Z][A-Za-z0-9-]{2,20})[^.!?\n]{0,80}[.!?\n][^.!?\n]{0,80}\b(?:actually|wait|but|however|though)\b[^.!?\n]{0,80}\b(?:uses?|using|runs?\s+on|powered\s+by|based\s+on)\s+([A-Z][A-Za-z0-9-]{2,20})/i;
  const dm = text.match(dbRe);
  if (dm) {
    const a = (dm[1] ?? "").trim();
    const b = (dm[2] ?? "").trim();
    if (a.length > 0 && b.length > 0 && a.toLowerCase() !== b.toLowerCase()) {
      return { label: "stacked-tech-claim" };
    }
  }
  return null;
}

function isDeclarativeClause(s: string): boolean {
  const t = s.trim();
  if (t.length < 8) return false;
  if (t.length > 400) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  // Must not start with a question word or a conjunction.
  if (/^\s*(?:and|or|but|so|because|if|when|while|that|which)\b/i.test(t)) {
    return false;
  }
  return true;
}

function sharesTopicToken(a: string, b: string): boolean {
  // Cheap topic-token overlap on a normalized alpha-only word set,
  // ignoring common stop words. We only need one overlapping token
  // of length >= 4 (long enough to be a real topic word, not a
  // shared article). Tokens are stemmed by stripping a small set
  // of common inflectional suffixes so that "deploy" / "deploying"
  // / "deployed" / "deployment" all share a topic.
  const STOP = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "any",
    "can", "had", "her", "was", "one", "our", "out", "day", "get",
    "has", "him", "his", "how", "man", "new", "now", "old", "see",
    "two", "way", "who", "boy", "did", "its", "let", "put", "say",
    "she", "too", "use", "this", "that", "with", "from", "have",
    "they", "their", "there", "what", "when", "your", "were", "been",
    "will", "would", "could", "should", "about", "into", "than",
    "then", "them", "these", "those", "because", "actually", "wait",
    "update", "correction", "previously", "earlier", "currently",
  ]);
  const stem = (w: string): string => {
    if (w.length < 5) return w;
    // Strip a small set of common inflectional suffixes. We do
    // this rather than full Porter stemming to keep the behavior
    // deterministic and easy to reason about. Conservative
    // stripping — the overlap test only needs to succeed when
    // a clear topic word is reused.
    return w.replace(
      /(?:ingly|edly|ing|edly|ed|ies|ied|ies|ly|s)$/,
      "",
    );
  };
  const toks = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 4 && !STOP.has(raw) && /^[a-z]/.test(raw)) {
        out.add(stem(raw));
      }
    }
    return out;
  };
  const ta = toks(a);
  for (const t of toks(b)) {
    if (ta.has(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vague-memory patterns (hardening pass)
// ---------------------------------------------------------------------------
//
// The existing `vague-junk` detector handles short / low-signal inputs
// (length < 4, single-char repeated, no letters, single repeated token,
// 1-5 letter word salad). It does NOT handle inputs that LOOK like a
// normal memory-verb sentence but use a demonstrative + vague noun
// as the head of the phrase (e.g. "Remember the thing we decided
// earlier.") — those are syntactically meaningful but underspecified.
//
// Conservative pattern set. Each pattern is anchored on a distinctive
// structure so that ordinary project documentation that happens to
// mention a "decision" or "point" is not flagged.
//
// The detector fires on:
//
//   1. Memory verb + demonstrative + vague noun + (optional past-tense
//      decision verb + optional temporal qualifier), with no concrete
//      content noun after the vague noun. Examples that match:
//        - "Remember the thing we decided earlier."
//        - "Save what we agreed on."
//        - "Note the decision we made."
//   2. Demonstrative + vague noun + past-tense decision verb. The
//      sentence is a request to recall an unspecified past item.
//        - "The thing we decided earlier is important."
//        - "That point we discussed should be remembered."
//
// It does NOT fire on:
//
//   - Concrete content: "Remember the Postgres migration decision."
//     (the noun after "the" is `Postgres migration decision`, not the
//     bare vague noun alone).
//   - Declarations without a memory verb and without a "we decided"
//     past-tense decision verb: "The thing about Postgres is fast."
//     (no past-tense decision verb follows the vague noun).
//   - Valid temporal facts: "Curion used SQLite before, but now uses
//     Postgres." (handled separately by `self-conflict`).
const VAGUE_MEMORY_PATTERNS: ReadonlyArray<RegExp> = [
  // Memory verb + (optional demonstrative) + vague noun. The
  // vague noun is the *last* token the memory verb governs
  // before an end-of-sentence / line break, so a sentence like
  // "Remember the thing about Postgres" still escapes — the
  // memory verb governs a full noun phrase, not just the bare
  // noun.
  /\b(?:remember|save|store|note|keep|log|record|write)\s+(?:the\s+|that\s+|this\s+|those\s+|these\s+)?(?:thing|things|stuff|something|everything)\s*(?:[.!?]|$)/i,
  // Memory verb + (optional demonstrative) + vague decision
  // noun + past-tense decision verb (e.g. "we made",
  // "we discussed"). The "decision / point / idea / plan /
  // agreement / choice / rule" noun is followed by a past-tense
  // decision verb referencing an unspecified past item.
  /\b(?:remember|save|store|note|keep|log|record|write)\s+(?:the\s+|that\s+|this\s+)?(?:decision|point|idea|plan|agreement|choice|rule)\s+(?:we|i|you|they|we'd|they'd)\s+(?:made|discussed|agreed|talked\s+about|chose|picked|decided|set|settled\s+on)\b/i,
  // Memory verb + relative pronoun "what/whatever/whichever" +
  // past-tense decision verb. The relative pronoun is a
  // placeholder for an unspecified antecedent. Examples that
  // match:
  //   - "Save what we agreed on."
  //   - "Note whatever we decided."
  //   - "Remember whichever we chose."
  /\b(?:remember|save|store|note|keep|log|record|write)\s+(?:what|whatever|whichever)\s+(?:we|i|you|they|we'd|they'd)\s+(?:discussed|agreed|talked\s+about|mentioned|decided|chose|picked|made|settled\s+on)\b/i,
  // Demonstrative + vague noun + past-tense decision verb. The
  // sentence asserts an unspecified past item ("the thing we
  // discussed", "that point we agreed on"). The pattern requires
  // the demonstrative+vague-noun to be directly followed (no
  // concrete content in between) by the past-tense decision
  // verb phrase.
  /\b(?:the|that|this|those|these)\s+(?:thing|things|stuff|something|everything)\s+(?:we|i|you|they|we'd|they'd)\s+(?:discussed|agreed|talked\s+about|mentioned|decided|chose|picked|made|settled\s+on)\b/i,
];

interface VagueMemoryHit {
  /** Stable label for the rule that triggered detection. */
  label: string;
}

/**
 * Run a narrow, deterministic vague-memory check. Returns a hit
 * when the input is dominated by demonstrative + vague-noun
 * references with no concrete content.
 *
 * Conservative: only fires on the explicit
 * "remember/save/store/note/keep/log the X we VERB-ed" pattern and
 * the "the/that/this X we VERB-ed" pattern. Does NOT fire on
 * concrete content ("the Postgres migration decision") or on
 * declarations without a past-tense decision verb ("the thing
 * about X is Y").
 */
function detectVagueMemory(text: string): VagueMemoryHit | null {
  for (const re of VAGUE_MEMORY_PATTERNS) {
    // Defensive: clone per-call so module-level regexes cannot
    // accumulate `lastIndex` between calls.
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (r.test(text)) {
      return { label: "placeholder-reference" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Replacement / correction patterns (hardening pass)
// ---------------------------------------------------------------------------
//
// The existing `self-conflict` detector handles temporal pivots
// ("X. Actually, Y" / "previously X. Now Y" / stacked-tech-claim
// "X but actually Y"). It does NOT handle direct, single-sentence
// corrections like "Curion uses Postgres, not SQLite." — those are
// not temporal pivots, they are explicit one-shot replacements.
//
// Conservative pattern set. Each pattern is anchored on a distinctive
// correction marker so that ordinary comparative / preference
// language does NOT trip:
//
//   1. `, not <Word>` (or `, but not <Word>` / `, and not <Word>`) —
//      a comma-then-correction structure. The word after "not"
//      must be a noun-shaped token (3+ chars, capitalized or
//      lowercase, optionally preceded by `the/a/an`). Examples
//      that match:
//        - "Curion uses Postgres, not SQLite."
//        - "Use the SDK, not the old client library."
//        - "Postgres, not SQLite, is the primary store."
//   2. `instead of <word>` — explicit replacement phrase. Match.
//   3. `rather than <word>` — explicit replacement phrase. Match.
//   4. `(not <word>...)` — parenthetical correction. Match.
//
// It does NOT fire on:
//
//   - Temporal pivots: "We used SQLite before, but now use Postgres."
//     (no `, not`, no `instead of`, no `rather than`, no
//     parenthetical).
//   - Negative statements without a comma: "Postgres is not SQLite."
//     ("not" is not preceded by a comma + demonstrative structure).
//   - Comparatives without replacement: "Postgres is faster than
//     SQLite." ("faster than", not "rather than").
const REPLACEMENT_CORRECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Comma + optional "but"/"and" + "not" + (optional article) +
  // word. The word after "not" must be 3+ chars to avoid false
  // fires on short adverbs ("not yet", "not now", "not quite").
  // The optional `but/and` covers ", but not X" / ", and not X".
  /,\s*(?:but\s+|and\s+)?not\s+(?:the\s+|a\s+|an\s+)?[A-Za-z]\w{2,}\b/,
  // "instead of <word>"
  /\binstead\s+of\s+\w/i,
  // "rather than <word>"
  /\brather\s+than\s+\w/i,
  // "(not <word>...)" parenthetical
  /\(\s*not\s+\w[\w\s-]*\)/,
];

interface ReplacementCorrectionHit {
  /** Stable label for the rule that triggered detection. */
  label: string;
}

/**
 * Run a narrow, deterministic replacement / correction check.
 * Returns a hit when the input asserts a direct, single-sentence
 * correction or replacement of one named thing by another.
 *
 * Conservative: only fires on the four explicit replacement
 * markers (`, not X` / `instead of X` / `rather than X` /
 * `(not X)`). Does NOT fire on temporal pivots (handled by
 * `self-conflict`), bare negations ("X is not Y"), or
 * comparatives ("faster than X").
 */
function detectReplacementCorrection(
  text: string,
): ReplacementCorrectionHit | null {
  for (const re of REPLACEMENT_CORRECTION_PATTERNS) {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (r.test(text)) {
      return { label: "explicit-replacement" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify input text by running the local pattern catalogue.
 *
 * Order of operations:
 *   1. Strip leading/trailing whitespace.
 *   2. If empty or below the junk threshold, return `vague-junk`.
 *   3. Count secret-shaped matches and dump-shaped matches.
 *   4. Decide:
 *      - if any secret hit, AND the input also has safe content
 *        (more than just the secret lines), return `mixed-safe-sensitive`.
 *      - if any secret hit, AND input is dominated by secrets,
 *        return `secret`.
 *      - else if dump-hit count is high relative to length, return
 *        `raw-dump`.
 *      - else if an injection pattern matches, return
 *        `prompt-injection`.
 *      - else if an unsafe-preference pattern matches, return
 *        `unsafe-preference`.
 *      - else if a self-conflict pattern matches, return
 *        `self-conflict`.
 *      - else return `safe`.
 *
 * Returns only a classification and a redacted reason string; the
 * input text itself is never echoed in the result or the reason.
 */
export function classifyInput(rawInput: string): SafetyCheckResult {
  const text = typeof rawInput === "string" ? rawInput : "";
  const trimmed = text.trim();
  const length = trimmed.length;

  // --- vague-junk check ---------------------------------------------
  if (length === 0) {
    return {
      class: "vague-junk",
      reason: "input is empty",
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: true,
    };
  }
  if (looksLikeJunk(trimmed)) {
    return {
      class: "vague-junk",
      reason: "input is too short or low-signal to be useful as memory",
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: true,
    };
  }

  // --- secret / dump detection --------------------------------------
  const secretHits = collectSecretHits(trimmed);
  const dumpLineHits = countDumpLineHits(trimmed);
  const lineCount = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const dumpDensity = lineCount > 0 ? dumpLineHits / lineCount : 0;

  if (secretHits.length > 0) {
    // If secrets are present AND there is also substantive non-secret
    // content (more than a short contextual phrase that just
    // describes the secret), treat as mixed and reject without
    // sending to the provider. The conservative MVP default is to
    // reject rather than attempt deterministic redaction (see
    // module header).
    const stripped = stripSecretHits(trimmed, secretHits).trim();
    const nonSecretChars = stripped.length;
    // A short phrase like "is my AWS access key" (< 40 chars)
    // describing the secret is NOT enough to be "mixed safe
    // content" — it is just contextual scaffolding around the
    // secret. We only treat as mixed when the non-secret content
    // is a meaningful paragraph of its own.
    if (nonSecretChars > 40) {
      return {
        class: "mixed-safe-sensitive",
        reason:
          "input mixes safe content with secret-shaped fragments; refusing to forward to provider",
        containsSecret: true,
        looksLikeDump: dumpDensity > 0.5,
        looksLikeJunk: false,
      };
    }
    return {
      class: "secret",
      reason: `input contains ${secretHits.length} secret-shaped fragment(s): ${summarizeLabels(secretHits)}`,
      containsSecret: true,
      looksLikeDump: dumpDensity > 0.5,
      looksLikeJunk: false,
    };
  }

  if (dumpDensity > 0.5 && lineCount >= 3) {
    return {
      class: "raw-dump",
      reason:
        "input looks like a raw log paste or env dump; please summarize the point you want remembered",
      containsSecret: false,
      looksLikeDump: true,
      looksLikeJunk: false,
    };
  }

  // --- prompt-injection / future-agent-instruction check ------------
  const injectionHits = collectInjectionHits(trimmed);
  if (injectionHits.length > 0) {
    return {
      class: "prompt-injection",
      reason: `input contains instruction-override language: ${summarizeInjectionLabels(injectionHits)}`,
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: false,
    };
  }

  // --- unsafe durable preference / safety-poisoning check ----------
  const unsafePrefHits = collectUnsafePreferenceHits(trimmed);
  if (unsafePrefHits.length > 0) {
    return {
      class: "unsafe-preference",
      reason: `input asks to weaken safety or persistence policy: ${summarizeUnsafePreferenceLabels(unsafePrefHits)}`,
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: false,
    };
  }

  // --- self-conflict (ambiguous opposing project facts) -------------
  const conflict = detectSelfConflict(trimmed);
  if (conflict) {
    return {
      class: "self-conflict",
      reason: `input contains self-conflicting project facts (${conflict.label})`,
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: false,
    };
  }

  // --- vague-memory (placeholder references) -----------------------
  // Hardening pass: an input like "Remember the thing we decided
  // earlier." references an unspecified past decision. The
  // `looksLikeJunk` detector does not catch these — they are
  // syntactically meaningful but underspecified. Reject before
  // the provider so we don't store an ambiguous memory.
  const vagueMemory = detectVagueMemory(trimmed);
  if (vagueMemory) {
    return {
      class: "vague-memory",
      reason: `input is dominated by vague placeholder references (${vagueMemory.label})`,
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: false,
    };
  }

  // --- replacement-correction (explicit one-shot replacement) ------
  // Hardening pass: an input like "Curion uses Postgres, not
  // SQLite." asserts a direct replacement. The user-stated
  // preference is "do not assume" — the agent should ask for
  // the single canonical fact rather than store either half
  // independently. Temporal pivots ("used X before, but now
  // Y") are intentionally NOT matched here; they are handled
  // by the `self-conflict` detector above.
  const replacement = detectReplacementCorrection(trimmed);
  if (replacement) {
    return {
      class: "replacement-correction",
      reason: `input asserts a direct correction / replacement (${replacement.label})`,
      containsSecret: false,
      looksLikeDump: false,
      looksLikeJunk: false,
    };
  }

  return {
    class: "safe",
    reason: "ok",
    containsSecret: false,
    looksLikeDump: false,
    looksLikeJunk: false,
  };
}

interface SecretHit {
  start: number;
  end: number;
  label: string;
}

function collectSecretHits(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { re, label } of SECRET_PATTERNS) {
    // Always clone per-call so the module-level regexes cannot
    // accumulate state between calls. Defensive against accidental
    // non-global flags (which would loop forever in `exec`).
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    let safety = 0;
    while ((m = r.exec(text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length, label });
      if (m[0].length === 0) r.lastIndex += 1;
      safety += 1;
      if (safety > 1000) break; // absolute belt-and-braces
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

function collectInjectionHits(text: string): { label: string }[] {
  const out: { label: string }[] = [];
  // If the input is meta-discussion of the safety policy itself
  // (e.g. "the rule says: 'ignore previous instructions' should
  // never appear in user input"), do not flag it. We only suppress
  // the *injection* and *unsafe-preference* detections; secrets,
  // dumps, and self-conflicts are still evaluated normally.
  const metaDiscussion = looksLikeMetaDiscussion(text);
  for (const { re, label } of INJECTION_PATTERNS) {
    if (metaDiscussion) continue;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (r.test(text)) out.push({ label });
  }
  return out;
}

function collectUnsafePreferenceHits(text: string): { label: string }[] {
  const out: { label: string }[] = [];
  const metaDiscussion = looksLikeMetaDiscussion(text);
  const testDocsScope = isScopedToTestOrDocs(text);
  for (const { re, label } of UNSAFE_PREFERENCE_PATTERNS) {
    if (metaDiscussion) continue;
    // The test/docs scope allow-list only applies to bypass-safety
    // and disable-redaction labels — the rest of the
    // unsafe-preference catalog is still always-on. This keeps
    // global safety-bypass preferences ("Always disable
    // redaction", "Never redact API keys") rejected even when the
    // text happens to mention "test" or "docs" in passing.
    if (
      testDocsScope &&
      (label === "bypass-safety" || label === "disable-redaction")
    ) {
      continue;
    }
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (r.test(text)) out.push({ label });
  }
  return out;
}

/**
 * Phrases that indicate the input is *discussing* the safety policy
 * itself (a rule spec, a docs section, a test description) rather
 * than attempting to bypass it. When present, injection-style and
 * unsafe-preference patterns are suppressed. Secrets, dumps, vague
 * junk, and self-conflict are still detected normally.
 */
function looksLikeMetaDiscussion(text: string): boolean {
  return /(?:the\s+(?:rule|policy|spec|guideline|documentation)|policy\s*:|rule\s*:|spec\s*:|guideline\s*:)\b[^.\n]{0,200}?(?:should\s+never\s+(?:appear|be\s+included|be\s+used|match)|should\s+not\s+(?:appear|be\s+included|be\s+used|match)|must\s+never\s+(?:appear|be\s+included|be\s+used|match)|never\s+(?:appear|be\s+included|be\s+used|match)\s+in\s+user\s+input)/i.test(
    text,
  );
}

/**
 * True when the text clearly restricts its scope to test runs,
 * test fixtures, docs examples, or similar. Used to allow
 * bypass-safety / disable-redaction phrases that are explicitly
 * scoped to non-production contexts. The same phrases WITHOUT
 * such a scope marker are still flagged.
 */
function isScopedToTestOrDocs(text: string): boolean {
  return /\b(?:during|for|in|within|inside|as\s+part\s+of|while\s+running|when\s+running)\s+(?:the\s+|our\s+|a\s+)?(?:test(?:\s+(?:runs?|suite|fixtures?|code|examples?|mode))?|tests|test\s+fixtures?|docs(?:\s+(?:examples?|site|build|builds))?|documentation\s+examples?|public\s+docs|example\s+only|example\s+purposes)\b/i.test(
    text,
  );
}

function stripSecretHits(text: string, hits: SecretHit[]): string {
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.start) + " " + out.slice(h.end);
  }
  return out;
}

function countMatches(text: string, patterns: ReadonlyArray<RegExp>): number {
  let total = 0;
  for (const re of patterns) {
    const m = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (m) total += 1;
  }
  return total;
}

/**
 * Count the number of non-empty lines in `text` that look like part
 * of a raw env dump or log paste (timestamp, log severity, KEY=VALUE
 * env var, syslog/journald prefix, or HTTP-style `Header: value`).
 * Each line is counted at most once even if it matches multiple
 * patterns, so the returned value is the count of distinct lines
 * that exhibit *any* dump hint.
 */
function countDumpLineHits(text: string): number {
  const lines = text.split(/\r?\n/);
  let hits = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    let matched = false;
    for (const re of DUMP_HINT_PATTERNS) {
      // Use the un-anchored pattern with the `m` flag stripped so
      // it matches anywhere on the line. The patterns are designed
      // to anchor on line start via `^\s*`, which works with `m`.
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      if (r.test(t)) {
        matched = true;
        break;
      }
    }
    if (matched) hits += 1;
  }
  return hits;
}

function summarizeLabels(hits: SecretHit[]): string {
  const labels = new Set(hits.map((h) => h.label));
  return Array.from(labels).slice(0, 4).join(",");
}

function summarizeInjectionLabels(hits: { label: string }[]): string {
  const labels = new Set(hits.map((h) => h.label));
  return Array.from(labels).slice(0, 4).join(",");
}

function summarizeUnsafePreferenceLabels(hits: { label: string }[]): string {
  const labels = new Set(hits.map((h) => h.label));
  return Array.from(labels).slice(0, 4).join(",");
}

/**
 * Lightweight low-signal check. Returns true for inputs that are too
 * short, dominated by a single non-word character, or consist of a
 * single repeated token.
 */
function looksLikeJunk(trimmed: string): boolean {
  if (trimmed.length < 4) return true;
  // 50%+ non-alphanumeric single character (e.g. "....." or "---")
  const singleCharRun = /^(.)\1+$/.test(trimmed);
  if (singleCharRun) return true;
  // No letters at all (e.g. "1234" or "123 45 67")
  if (!/[A-Za-z]/.test(trimmed)) return true;
  // All the same single word repeated (e.g. "foo foo foo")
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 3) {
    const set = new Set(tokens.map((t) => t.toLowerCase()));
    if (set.size === 1 && tokens[0].length <= 6) return true;
  }
  // Heuristic: a 3-or-fewer-letter "word salad" with no spaces (e.g. "asdf")
  if (/^[a-z]{1,5}$/i.test(trimmed) && trimmed.length <= 5) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Defense-in-depth: redact the provider's summary output
// ---------------------------------------------------------------------------

/**
 * Replace any secret-shaped substring in `summary` with
 * `"<redacted>"`. Returns the redacted text. If no secret patterns
 * match, returns `summary` unchanged. The redaction is intentionally
 * conservative: it errs on the side of redacting, never on the
 * side of preserving.
 */
export function redactSummary(summary: string): string {
  if (typeof summary !== "string" || summary.length === 0) return summary;
  let out = summary;
  for (const { re } of SECRET_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    out = out.replace(new RegExp(re.source, flags), "<redacted>");
  }
  return out;
}

/**
 * Convenience: log a pre-check decision at debug level. Never logs
 * the input text itself, only the class and the redacted reason.
 */
export function logClassification(result: SafetyCheckResult): void {
  logger.debug(`safety pre-check: class=${result.class} reason=${result.reason}`);
}
