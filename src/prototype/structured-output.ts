/**
 * Structured-output parser and validator for the prototype.
 *
 * The prototype runner asks providers to return JSON inside a fenced
 * block, and validates the result against a zod schema for the
 * expected `memory-analysis` shape.
 *
 * Strategy:
 *   1. Locate the JSON in the response. We try:
 *      a) the full response if it parses as JSON,
 *      b) the first ```json ... ``` fenced block,
 *      c) the first balanced `{ ... }` substring.
 *   2. Validate against the schema. If validation fails, attempt one
 *      repair pass that strips stray code fences, trailing commas, and
 *      leading/trailing junk outside the first balanced object.
 *   3. Return a normalized result. Raw content is never stored by
 *      the runner; only the parsed value and metadata are kept.
 */

import { z } from "zod";

/**
 * Memory-analysis output schema. The prototype uses this as a stable
 * shape the runner can validate every model against.
 *
 * The shape is intentionally narrow:
 *   - A short summary string.
 *   - A confidence score in [0, 1].
 *   - A list of tags (strings).
 *   - An optional list of entities.
 *   - An optional classification label.
 */
export const MemoryAnalysisSchema = z.object({
  summary: z.string().min(1, "summary must be a non-empty string"),
  confidence: z
    .number()
    .min(0, "confidence must be >= 0")
    .max(1, "confidence must be <= 1"),
  tags: z.array(z.string().min(1)).max(16, "at most 16 tags"),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.string().min(1),
      }),
    )
    .max(32, "at most 32 entities")
    .optional()
    .default([]),
  classification: z.string().min(1).optional(),
});

export type MemoryAnalysis = z.infer<typeof MemoryAnalysisSchema>;

export interface ParseResult {
  ok: boolean;
  value?: MemoryAnalysis;
  /** Parser-level errors (could not extract JSON, schema mismatch). */
  errors: string[];
  /** True if a repair pass was needed and succeeded. */
  repaired: boolean;
  /** Strategy that succeeded, if any. */
  strategy?: "raw" | "fenced" | "balanced" | "repaired";
}

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;
const OBJECT_RE = /\{[\s\S]*\}/;

export function parseMemoryAnalysis(text: string): ParseResult {
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
    // Inner was not valid JSON; fall through to balanced.
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
    errors.push(
      `balanced object present but unparsable: ${balancedErr}`,
    );
  } else {
    errors.push("no JSON object found in response");
  }

  return { ok: false, errors, repaired: false };
}

/**
 * Normalize a strict-mode response payload before schema validation.
 *
 * Groq's strict `json_schema` mode requires every property in
 * `required` to be present in the response. Optional fields are
 * expressed as `nullable: true`, so the model returns
 * `entities: null` and `classification: null` when there is nothing
 * to report. The zod schema treats those fields as optional with
 * sensible defaults (an empty array and "absent" respectively), so
 * we translate `null` into the equivalent absent/empty value here.
 *
 *   - `entities: null`     -> `entities: []`
 *   - `classification: null` -> key removed (becomes `undefined`)
 *
 * Existing behavior is preserved:
 *   - missing fields keep their zod defaults,
 *   - non-null valid values pass through unchanged,
 *   - non-null invalid values (e.g. wrong type) still fail the
 *     schema check.
 */
function normalizeStrictModeShape(candidate: unknown): unknown {
  if (candidate === null || typeof candidate !== "object") return candidate;
  const obj = candidate as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  if (out.entities === null) {
    out.entities = [];
  }
  if (out.classification === null) {
    delete out.classification;
  }
  return out;
}

function validate(
  candidate: unknown,
  baseErrors: string[],
  repaired: boolean,
  strategy: NonNullable<ParseResult["strategy"]>,
): ParseResult {
  const normalized = normalizeStrictModeShape(candidate);
  const result = MemoryAnalysisSchema.safeParse(normalized);
  if (result.success) {
    return {
      ok: true,
      value: result.data,
      errors: [],
      repaired,
      strategy,
    };
  }
  const issues = result.error.issues.map(
    (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
  );
  return {
    ok: false,
    errors: [...baseErrors, ...issues],
    repaired: false,
  };
}

function tryParseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function repairText(text: string): string {
  // Strip stray fences, normalize whitespace, remove trailing commas
  // in arrays/objects.
  let s = text
    .replace(/```(?:json|JSON)?/g, "")
    .replace(/```/g, "")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
  s = s.replace(/,(\s*[}\]])/g, "$1");
  return s;
}

/**
 * Build a prompt fragment that asks the model to return a single JSON
 * object matching the schema. The runner wraps this around each
 * fixture's text.
 */
export function buildStructuredPrompt(userText: string): string {
  return [
    "Return EXACTLY one JSON object. No prose, no markdown, no code fences.",
    "The object MUST match this TypeScript shape:",
    '{',
    '  "summary": string,        // 1-2 sentence summary of the input',
    '  "confidence": number,     // 0..1, your confidence in the summary',
    '  "tags": string[],         // up to 8 short tags',
    '  "entities"?: {name: string, kind: string}[], // optional named entities',
    '  "classification"?: string // optional short label',
    '}',
    "",
    "Wrap the JSON in a ```json ... ``` block. Do not include any other text.",
    "",
    "INPUT:",
    JSON.stringify(userText),
  ].join("\n");
}

/**
 * JSON Schema representation of `MemoryAnalysisSchema` for
 * providers that support strict `response_format: { type:
 * "json_schema", json_schema: { ... } }` (e.g. Groq with
 * `openai/gpt-oss-120b`).
 *
 * Strict-mode requirements (Groq mirrors OpenAI's rules):
 *   - `additionalProperties: false` is required at every object.
 *   - Every key in `properties` MUST also appear in `required`.
 *     Optional fields are expressed as `nullable: true` and
 *     still listed in `required`.
 *
 * The schema mirrors the zod `MemoryAnalysisSchema` semantics:
 *   - `summary`: non-empty string
 *   - `confidence`: number in [0, 1]
 *   - `tags`: array of non-empty strings, at most 16
 *   - `entities`: optional array of `{name, kind}`, at most 32
 *   - `classification`: optional non-empty string
 *
 * The runner uses this with `strict: true` for Groq only. Other
 * providers (MiniMax, NIM) continue to use the prompt-delimited
 * JSON path.
 */
export const MEMORY_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "confidence", "tags", "entities", "classification"],
  properties: {
    summary: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    tags: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1 },
    },
    entities: {
      // Optional but always present in strict mode -> nullable.
      type: "array",
      nullable: true,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind"],
        properties: {
          name: { type: "string", minLength: 1 },
          kind: { type: "string", minLength: 1 },
        },
      },
    },
    classification: {
      // Optional but always present in strict mode -> nullable.
      type: "string",
      nullable: true,
      minLength: 1,
    },
  },
};
