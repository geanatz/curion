/**
 * Structured-output parser and validator for the Memory Decision
 * Engine.
 *
 * Mirrors the parser pattern established by
 * `src/providers/structured-output.ts` (raw -> fenced ->
 * balanced -> repaired -> strict-mode normalization) but
 * validates against `RememberPolicyDecisionSchema` instead of
 * `MemoryAnalysisSchema`. Same project pattern, same hermetic
 * strategy, same repair surface; only the target schema differs.
 *
 * The adapter never throws on parse failure. It returns a
 * discriminated `ParseResult` and the caller (the adapter) maps
 * a failed parse to a typed `DecisionAdapterFailure` with
 * `kind: "invalid-output"`. The controller, in turn, treats that
 * failure as "no engine signal" and proceeds with the existing
 * deterministic remember path.
 *
 * Security:
 *   - The parser never echoes the input text in any returned
 *     field. Error strings are short path/message-style labels.
 *   - The repair pass strips fences, normalizes whitespace, and
 *     removes trailing commas inside arrays/objects. It does
 *     NOT execute any model-supplied code or untrusted regex.
 */

import { type RememberPolicyDecision, RememberPolicyDecisionSchema } from "./types.js";

export interface DecisionParseResult {
  ok: boolean;
  value?: RememberPolicyDecision | undefined;
  /** Parser-level errors (could not extract JSON, schema mismatch). */
  errors: string[];
  /** True if a repair pass was needed and succeeded. */
  repaired: boolean;
  /** Strategy that succeeded, if any. */
  strategy?: "raw" | "fenced" | "balanced" | "repaired" | undefined;
}

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;
const OBJECT_RE = /\{[\s\S]*\}/;

export function parseRememberPolicyDecision(text: string): DecisionParseResult {
  const errors: string[] = [];
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, errors: ["empty response"], repaired: false };
  }

  // Strategy 1: full text parses as JSON.
  const raw = tryParseJson(text);
  if (raw.ok && raw.value !== undefined) {
    return validate(raw.value, [], false, "raw");
  }

  // Strategy 2: extract first fenced block.
  const fencedMatch = text.match(FENCE_RE);
  if (fencedMatch && typeof fencedMatch[1] === "string") {
    const inner = fencedMatch[1].trim();
    const parsed = tryParseJson(inner);
    if (parsed.ok && parsed.value !== undefined) {
      return validate(parsed.value, [], false, "fenced");
    }
    const fencedErr = parsed.ok ? "unknown" : parsed.error;
    errors.push(`fenced block present but unparsable: ${fencedErr}`);
  }

  // Strategy 3: first balanced object.
  const balancedMatch = text.match(OBJECT_RE);
  if (balancedMatch) {
    const obj = balancedMatch[0];
    const parsed = tryParseJson(obj);
    if (parsed.ok && parsed.value !== undefined) {
      return validate(parsed.value, [], false, "balanced");
    }
    // One repair attempt: strip trailing commas and fences, retry.
    const repairedText = repairText(obj);
    const repaired = tryParseJson(repairedText);
    if (repaired.ok && repaired.value !== undefined) {
      return validate(repaired.value, [], true, "repaired");
    }
    const balancedErr = parsed.ok ? "unknown" : parsed.error;
    errors.push(`balanced object present but unparsable: ${balancedErr}`);
  } else {
    errors.push("no JSON object found in response");
  }

  return { ok: false, errors, repaired: false };
}

function validate(
  candidate: unknown,
  baseErrors: string[],
  repaired: boolean,
  strategy: NonNullable<DecisionParseResult["strategy"]>
): DecisionParseResult {
  const result = RememberPolicyDecisionSchema.safeParse(candidate);
  if (result.success) {
    return {
      ok: true,
      value: result.data,
      errors: [],
      repaired,
      strategy,
    };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
  return {
    ok: false,
    errors: [...baseErrors, ...issues],
    repaired: false,
  };
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function repairText(text: string): string {
  // Strip stray fences, normalize whitespace, remove trailing commas
  // in arrays/objects. Mirrors the parser in
  // `src/providers/structured-output.ts` (same project pattern).
  let s = text
    .replace(/```(?:json|JSON)?/g, "")
    .replace(/```/g, "")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return s;
}

// ---------------------------------------------------------------------------
// JSON Schema for strict-mode providers (Groq, future strict-mode callers)
// ---------------------------------------------------------------------------

/**
 * JSON Schema representation of `RememberPolicyDecisionSchema`
 * for providers that support strict
 * `response_format: { type: "json_schema", ... }` (Groq with
 * `openai/gpt-oss-120b`, future strict-mode callers).
 *
 * Strict-mode requirements (Groq mirrors OpenAI's rules):
 *   - `additionalProperties: false` is required at every object.
 *   - Every key in `properties` MUST also appear in `required`.
 *     Optional fields are expressed as `nullable: true` and
 *     still listed in `required`.
 *
 * Field ordering matches `RememberPolicyDecisionSchema`; the
 * `default: []` arrays in the zod schema are mirrored as `[]`
 * here so strict-mode providers that require a concrete default
 * always receive a valid shape.
 */
export const REMEMBER_POLICY_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "reason",
    "supersededIds",
    "conflictsWithIds",
    "redundantWithIds",
    "confidence",
    "notes",
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "store",
        "supersede",
        "invalidate",
        "redact",
        "clarify",
        "reject",
        "flag_conflict",
        "flag_redundant",
        "no_op",
      ],
    },
    reason: {
      type: "string",
      enum: [
        "explicit_replacement",
        "explicit_retraction",
        "paraphrase_of_existing",
        "conflict_with_existing",
        "redundant_with_existing",
        "ambiguous_or_vague",
        "mixed_sensitive",
        "secret_echoed",
        "policy_violation",
        "low_quality",
        "novel",
        "unspecified",
      ],
    },
    supersededIds: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      maxItems: 16,
      default: [],
    },
    conflictsWithIds: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      maxItems: 16,
      default: [],
    },
    redundantWithIds: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      maxItems: 16,
      default: [],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    notes: {
      type: "string",
      nullable: true,
      maxLength: 280,
    },
  },
};
