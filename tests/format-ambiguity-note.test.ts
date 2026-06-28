/**
 * Unit tests for the Phase D public-message ambiguity note
 * formatter.
 *
 * Scope: the pure helper `formatAmbiguityNote` in
 * `src/retrieval/ambiguity.ts`. No storage, no provider, no
 * controller, no benchmark runner. Companion to
 * `tests/ambiguity-detection.test.ts` (the Phase C detector
 * unit tests) and `tests/recall-ambiguity-internal.test.ts`
 * (the controller-level Phase C / Phase D wiring).
 *
 * Properties verified (per spec §5.4 and §8.4):
 *
 *   1. `kind: "none"` input returns the empty string. The
 *      tool layer uses the empty string as "do not prefix the
 *      public message".
 *   2. `null` / `undefined` / non-object / non-`ambiguous`
 *      inputs return the empty string (defensive).
 *   3. `conflicting-candidates` signal -> a short, calm note
 *      that names the disagreement. **No memory ids** in the
 *      public text; the `memoryIds` field is internal only.
 *   4. `older-variant-suspected` signal -> a short, softer
 *      note ("may include older variants"). No memory ids
 *      in the public text.
 *   5. The output is bounded: length <= `AMBIGUITY_NOTE_MAX_LENGTH`.
 *   6. The output never includes a `#N` memory-id
 *      reference. The id list is internal-only; the public
 *      note is prose only.
 *   7. The output never carries the substring
 *      `detectionConfidence`, `derivedAt`, `derivedSchemaVersion`,
 *      `ccm-draft-1`, `conflictsWith`, `olderVariantsOf`,
 *      `internalAmbiguity`, `ambiguity` itself, `Sources:`,
 *      or any `#\d+` token. The note is human prose only.
 *   8. The output never references raw text / raw input /
 *      query / answer.
 *   9. The function does not import benchmark experiment
 *      modules (the `formatAmbiguityNote` block of
 *      `ambiguity.ts` lives next to the detector and must
 *      not pull in benchmark code).
 *  10. The function does not throw on any input.
 *  11. Malformed `memoryIds` (non-array, mixed types,
 *      non-finite integers) collapse to the empty string so
 *      no garbled id is ever rendered (defensive).
 *
 * History note: an earlier revision of this suite pinned an
 * id-list form (`#12, #17` and "and N more" truncation).
 * That public shape was retired: memory ids are an
 * internal storage handle and are not part of the
 * user-facing surface. The public note names the
 * condition (disagreement / older variant possibility) and
 * nothing more.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import url from "node:url";

import {
  AMBIGUITY_NOTE_MAX_LENGTH,
  type AmbiguitySignal,
  formatAmbiguityNote,
} from "../src/retrieval/ambiguity.ts";

// ---------------------------------------------------------------------------
// 1. kind: "none" -> empty string
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: kind: 'none' -> empty string", () => {
  const out = formatAmbiguityNote({ kind: "none", asOf: 0 });
  assert.equal(out, "");
});

test("formatAmbiguityNote: null / undefined / non-object -> empty string", () => {
  assert.equal(formatAmbiguityNote(null), "");
  assert.equal(formatAmbiguityNote(undefined), "");
  // Non-object inputs collapse to the empty string
  // (defensive: the function must never throw on
  // `unknown`-typed boundaries).
  assert.equal(formatAmbiguityNote("ambiguous" as unknown as AmbiguitySignal), "");
  assert.equal(formatAmbiguityNote(42 as unknown as AmbiguitySignal), "");
  assert.equal(formatAmbiguityNote(true as unknown as AmbiguitySignal), "");
});

// ---------------------------------------------------------------------------
// 2. conflicting-candidates -> short, calm note (no ids)
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: conflicting-candidates -> short note, no ids in public text", () => {
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "conflicting-candidates",
    memoryIds: [12, 17],
    confidence: 0.93,
    asOf: 1,
  });
  // Note names the disagreement (does not claim a winner).
  assert.match(out, /Note: stored memories on this topic disagree\./);
  // The public note must NEVER include a `#N` memory-id
  // reference. Memory ids are an internal storage handle
  // and are not part of the user-facing surface. The
  // `memoryIds` field is still on the internal signal but
  // is dropped by this formatter.
  assert.ok(
    !/#\d+/.test(out),
    `public note must not include any #N id reference; got ${JSON.stringify(out)}`
  );
  // Bounded.
  assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
  // No raw-text / diagnostic leakage. The note must also
  // not carry the legacy "Sources:" / "and N more" tokens
  // that the previous id-list form used.
  for (const tok of [
    "detectionConfidence",
    "derivedAt",
    "derivedSchemaVersion",
    "ccm-draft-1",
    "conflictsWith",
    "olderVariantsOf",
    "internalAmbiguity",
    "Sources:",
    "and N more",
    "and 1 more",
    "and 0 more",
    "raw",
    "text",
    "input",
    "query",
  ]) {
    assert.ok(!out.includes(tok), `note must not include '${tok}'`);
  }
  // Note does not claim to have picked a winner. It flags
  // the disagreement and nothing else; it does not say
  // "returning the most recent" or "I picked" etc.
  assert.ok(
    !/most recent|chose|picked|winner/i.test(out),
    "note must not claim a current-truth selection"
  );
});

// ---------------------------------------------------------------------------
// 3. older-variant-suspected -> softer note (no ids)
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: older-variant-suspected -> softer note, no ids in public text", () => {
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "older-variant-suspected",
    memoryIds: [3, 7],
    confidence: 0.91,
    asOf: 1,
  });
  // The wording is deliberately softer because the detector
  // can only *suspect* a paraphrase relationship from the
  // stored block; it has not re-derived the paraphrase.
  assert.match(out, /Note: stored memories on this topic may include older variants\./);
  // No `#N` id references — the public note is prose only.
  assert.ok(
    !/#\d+/.test(out),
    `public note must not include any #N id reference; got ${JSON.stringify(out)}`
  );
  assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
});

// ---------------------------------------------------------------------------
// 4. Long id list: no per-id rendering, no "and N more" token
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: long id list does not render any ids and does not mention 'and N more'", () => {
  // A 12-id list used to render `#1, #2, #3, #4` and
  // `and 8 more`. The current contract drops ALL ids from
  // the public note and never emits the "and N more" token.
  // The internal `memoryIds` field still carries the full
  // bounded list for tests / structured transport, but
  // nothing leaks to the on-the-wire `text` content block.
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "conflicting-candidates",
    memoryIds: ids,
    confidence: 0.95,
    asOf: 1,
  });
  // No ids at all in the output.
  assert.ok(
    !/#\d+/.test(out),
    `public note must not include any #N id reference; got ${JSON.stringify(out)}`
  );
  // No truncation token (the previous form had "and 8 more").
  assert.ok(
    !/and \d+ more/.test(out),
    `public note must not include the legacy 'and N more' token; got ${JSON.stringify(out)}`
  );
  // The prose is exactly the same regardless of how many
  // ids the signal carries.
  assert.match(out, /Note: stored memories on this topic disagree\./);
  // Bounded total length.
  assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
  // No raw-text leakage.
  for (const tok of ["detectionConfidence", "derivedAt", "derivedSchemaVersion", "ccm-draft-1"]) {
    assert.ok(!out.includes(tok), `note must not include '${tok}'`);
  }
});

// ---------------------------------------------------------------------------
// 5. Determinism
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: deterministic for fixed input", () => {
  const sig: AmbiguitySignal = {
    kind: "ambiguous",
    reason: "conflicting-candidates",
    memoryIds: [17, 12, 3, 99],
    confidence: 0.9,
    asOf: 1,
  };
  const a = formatAmbiguityNote(sig);
  const b = formatAmbiguityNote(sig);
  assert.equal(a, b);
  // The output is now prose only — there is no id-order
  // property to assert because the public note carries no
  // ids at all. We still pin that the output is a
  // non-empty string of bounded length.
  assert.equal(typeof a, "string");
  assert.ok(a.length > 0);
  assert.ok(a.length <= AMBIGUITY_NOTE_MAX_LENGTH);
  assert.ok(!/#\d+/.test(a));
});

// ---------------------------------------------------------------------------
// 6. Defensive: garbage id arrays collapse safely
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: garbage entries inside a valid memoryIds array never render as ids (defensive)", () => {
  // A signal whose `memoryIds` array carries ONLY invalid
  // entries (NaN, negatives, non-integers, non-numbers)
  // is still a structurally-valid signal: the array is an
  // array. The public note is prose only, so the garbage
  // entries can never leak. We assert the prose is present
  // and that no garbled `#...` token is ever rendered.
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "conflicting-candidates",
    memoryIds: [
      Number.NaN,
      -1,
      0,
      Number.POSITIVE_INFINITY,
      "1" as unknown as number,
      null as unknown as number,
    ],
    confidence: 0.9,
    asOf: 1,
  });
  // The prose is still emitted; garbage in the array does
  // not silence the formatter (the only thing that would
  // silence it is a non-array `memoryIds`).
  assert.match(out, /Note: stored memories on this topic disagree\./);
  // No garbled id is ever rendered.
  assert.ok(!/#NaN/.test(out));
  assert.ok(!/#-1/.test(out));
  assert.ok(!/#0/.test(out));
  assert.ok(!/#Infinity/.test(out));
  // And no `#\d+` token at all — the prose has no id
  // reference.
  assert.ok(!/#\d+/.test(out));
  assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
});

test("formatAmbiguityNote: non-array memoryIds -> empty note (defensive)", () => {
  // A non-array `memoryIds` is a structurally-malformed
  // signal. The formatter collapses it to the empty
  // string so the public surface never sees prose that
  // could be associated with a corrupt id list. (Even
  // though the no-id form has nothing to leak, the
  // empty-string collapse keeps the contract symmetric
  // with the rest of the formatter's malformed-input
  // handling.)
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "conflicting-candidates",
    memoryIds: "not an array" as unknown as number[],
    confidence: 0.9,
    asOf: 1,
  });
  assert.equal(out, "");
  assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
});

test("formatAmbiguityNote: unknown reason -> empty string (defensive)", () => {
  const out = formatAmbiguityNote({
    kind: "ambiguous",
    reason: "not-a-real-reason" as unknown as "conflicting-candidates" | "older-variant-suspected",
    memoryIds: [1, 2],
    confidence: 0.9,
    asOf: 1,
  });
  assert.equal(out, "");
});

// ---------------------------------------------------------------------------
// 7. The formatter source does not import benchmark modules
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: source does not import benchmark experiment modules", async () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcPath = path.resolve(here, "../src/retrieval/ambiguity.ts");
  const text = await fs.readFile(srcPath, "utf8");
  const forbidden = [
    "supersedes-promote-guard",
    "supersession-edge-simulation",
    "multi-anchor-current-previous",
    "temporal-candidate-generation-probe",
    "temporal-ranking-preference",
    "temporal-truth-diagnostic",
    "paraphrase-recovery",
    "false-abstention-damage",
  ];
  for (const tok of forbidden) {
    assert.equal(
      text.includes(tok),
      false,
      `ambiguity.ts must not reference benchmark experiment module "${tok}"`
    );
  }
  // The module should not have grown a benchmark import
  // because of the Phase D formatter.
  assert.equal(
    /from\s+["'][^"']*benchmark\//.test(text),
    false,
    "ambiguity.ts must not import from src/benchmark/"
  );
});

// ---------------------------------------------------------------------------
// 8. The formatter never throws on any input
// ---------------------------------------------------------------------------

test("formatAmbiguityNote: never throws on any input", () => {
  const inputs: unknown[] = [
    null,
    undefined,
    {},
    { kind: "none" },
    { kind: "ambiguous" },
    { kind: "ambiguous", reason: "conflicting-candidates" },
    { kind: "ambiguous", reason: "older-variant-suspected", memoryIds: null },
    { kind: "ambiguous", reason: "older-variant-suspected", memoryIds: [] },
    { kind: 7 },
    { kind: "ambiguous", reason: 42, memoryIds: "x" },
    [],
    "ambiguous",
    42,
    true,
  ];
  for (const inp of inputs) {
    let out: string;
    try {
      out = formatAmbiguityNote(inp as AmbiguitySignal | null | undefined);
    } catch (err) {
      assert.fail(
        `formatAmbiguityNote must not throw; threw on ${JSON.stringify(inp)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }
    // And the result, whatever it is, must be a string and
    // bounded.
    assert.equal(typeof out, "string");
    assert.ok(out.length <= AMBIGUITY_NOTE_MAX_LENGTH);
  }
});
