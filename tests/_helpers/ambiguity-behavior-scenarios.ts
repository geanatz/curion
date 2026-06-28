/**
 * Phase E — curated behavior-validation scenarios for the
 * recall-side ambiguity warning behavior.
 *
 * Validation-only. Test-local. NOT wired into production.
 * The scenario list and the report helper live here so the
 * companion runner (`tests/ambiguity-behavior-validation.test.ts`)
 * can stay focused on driving the controller and asserting
 * per-scenario behavior.
 *
 * The scenarios are intentionally hand-curated (not generated)
 * to exercise the specific behavior of the Phase D warning and
 * the four-status public message. The report helper aggregates
 * pass/fail, false positives / negatives, reason counts, and
 * a small API/provider-drift check; the runner prints it as a
 * compact summary at the end of the suite so a reader can see
 * the headline results without scrolling through the per-case
 * pass lines.
 *
 * No benchmark experiment modules are imported here. No raw
 * text is stored or echoed. The "row shape" entries use only
 * the safe summary fields and the post-Phase-B
 * `metadata.relationship` block (the same shape the
 * `tests/recall-ambiguity-internal.test.ts` helper builds).
 *
 * The relationship pointer arrays in each scenario row are
 * declared as references to "the other row" by *index* (e.g.
 * `{ ref: "other" }`) so the runner can resolve them to real
 * ids after the rows are inserted. The runner owns that
 * resolution.
 */

// (No imports of production modules here. The helper is
// intentionally pure-data so it can be type-checked and
// reviewed in isolation, and so the runner can keep the
// production import surface narrow.)

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

/**
 * Reference to another row in the same scenario by its
 * declared index (0-based). The runner resolves this to a
 * real memory id after insert.
 */
export interface RowRef {
  ref: "other";
}

/**
 * A list of either concrete ids (`number`) or row references
 * (`RowRef`). The runner resolves all references post-insert.
 */
export type IdList = ReadonlyArray<number | RowRef>;

/**
 * The stored relationship metadata block shape, mirroring the
 * Phase B/Phase C write-side shape. The runner writes each row
 * via `insertMemoryRecord` and then patches
 * `metadata.relationship` directly to model the post-write
 * row shape.
 */
export interface ScenarioRelationshipBlock {
  derivedSchemaVersion?: string;
  derivedAt?: number;
  conflictsWith?: IdList;
  olderVariantsOf?: IdList;
  detectionConfidence?: number;
}

export interface ScenarioRow {
  summary: string;
  tags?: string[];
  /** Optional post-write `metadata.relationship` block. The
   *  id lists in the block can reference other rows in the
   *  scenario by `RowRef`. The runner resolves them to
   *  concrete ids post-insert. */
  relationship?: ScenarioRelationshipBlock;
}

export type ExpectedStatus = "answered" | "no_memory" | "rejected" | "provider_error";

/**
 * Per-scenario expected outcome.
 *
 *   - `expectedWarning`: `true` means the public `message`
 *     MUST be prefixed with the "Note: ..." ambiguity line;
 *     `false` means the public `message` MUST be byte-equal
 *     to the synthesized answer (no note, no prefix).
 *   - `expectedReason`: the ambiguity reason the detector is
 *     expected to surface, if any. `"none"` is asserted when
 *     the detector is expected to stay silent.
 *   - `expectedStatus`: the public outcome status the
 *     controller should surface. Defaults to `"answered"`
 *     for the common case; the runner uses the value as-is.
 *   - `capabilityGap`: a free-form note that marks the
 *     scenario as a documented capability gap rather than a
 *     pass/fail. The report helper surfaces it explicitly so
 *     the reader can distinguish "validated behavior" from
 *     "documented gap".
 */
export interface ExpectedOutcome {
  warning: boolean;
  reason?: "conflicting-candidates" | "older-variant-suspected" | "none";
  status?: ExpectedStatus;
  capabilityGap?: string;
}

/** Curation classification. Drives report counts. */
export type ScenarioKind =
  | "expect-warning"
  | "expect-no-warning"
  | "expect-byte-equal"
  | "capability-gap";

export interface Scenario {
  /** Stable short id used in report rows. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Curation classification. */
  kind: ScenarioKind;
  /** Pre-seeded stored rows. */
  rows: readonly ScenarioRow[];
  /** Query to drive the recall controller with. */
  query: string;
  /** Scripted provider answer. The controller passes this
   *  to the validated answer; the detector inspects the
   *  validated copy. For scenarios that do not call the
   *  provider (no_memory, rejected) the runner ignores this
   *  field. For `provider_error` scenarios the runner
   *  scripts a 500 response and ignores this field. */
  answer: string;
  /** Expected outcome. */
  expected: ExpectedOutcome;
  /** When `true`, the runner asserts the public `message` /
   *  `answer` / `status` / `sourceIds` shape is the union
   *  of the documented public keys (API drift pin). Default
   *  `true`. */
  pinApiShape?: boolean;
  /** When `true`, the runner asserts the provider was
   *  called exactly the natural number of times for the
   *  expected status. Defaults:
   *    - `answered`: 1 (primary succeeds, no fallback).
   *    - `provider_error`: 2 (primary + fallback both fail;
   *      the controller does not retry beyond the fallback).
   *    - `no_memory` / `rejected`: 0 (provider is not
   *      called; the controller short-circuits before the
   *      synthesis call).
   *  When `false`, the runner does not pin the call count
   *  (still records the actual count in the report). */
  pinProviderCalls?: boolean;
}

// ---------------------------------------------------------------------------
// Curated scenario list (spec §5.4, 12 scenarios)
// ---------------------------------------------------------------------------

export const SCENARIOS: readonly Scenario[] = [
  // -----------------------------------------------------------------------
  // 1. Unresolved stored conflict: mutual high-confidence conflictsWith.
  // -----------------------------------------------------------------------
  {
    id: "S1",
    name: "stored mutual conflictsWith above threshold -> warning, reason conflicting-candidates",
    kind: "expect-warning",
    rows: [
      {
        summary: "Postgres stores project data reliably",
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.95,
        },
      },
      {
        summary: "Postgres stores project data reliably since 2023",
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.93,
        },
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres stores project data reliably.",
    expected: {
      warning: true,
      reason: "conflicting-candidates",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 2. Lexical / asymmetric-negation safety-net: no stored block, two
  //    near-identical summaries with asymmetric negation, answer
  //    aligned with the non-negating side.
  // -----------------------------------------------------------------------
  {
    id: "S2",
    name: "lexical asymmetric negation + answer alignment -> warning, reason conflicting-candidates",
    kind: "expect-warning",
    rows: [
      {
        summary: "Zesty lemon tart is on the office menu every Friday",
        // No stored block; detector must use lexical safety-net path.
      },
      {
        summary: "Zesty lemon tart is not on the office menu",
      },
    ],
    query: "Is the zesty lemon tart on the office menu today?",
    answer: "Zesty lemon tart is on the office menu.",
    expected: {
      warning: true,
      reason: "conflicting-candidates",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 3. Mutual olderVariantsOf: stored reciprocal pointer above threshold.
  // -----------------------------------------------------------------------
  {
    id: "S3",
    name: "mutual olderVariantsOf above threshold -> warning, reason older-variant-suspected",
    kind: "expect-warning",
    rows: [
      {
        summary: "Postgres stores project data reliably",
        relationship: {
          conflictsWith: [],
          olderVariantsOf: [{ ref: "other" }],
          detectionConfidence: 0.95,
        },
      },
      {
        summary: "Postgres stores project data reliably since 2023",
        relationship: {
          conflictsWith: [],
          olderVariantsOf: [{ ref: "other" }],
          detectionConfidence: 0.93,
        },
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres is the primary store.",
    expected: {
      warning: true,
      reason: "older-variant-suspected",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 4. One-way older variant: only one row's stored block points at
  //    the other. Detector stays silent.
  // -----------------------------------------------------------------------
  {
    id: "S4",
    name: "one-way olderVariantsOf -> no warning",
    kind: "expect-no-warning",
    rows: [
      {
        summary: "Postgres stores project data reliably",
        // No relationship block. The other row will point at
        // this one; without reciprocity the detector stays
        // silent.
      },
      {
        summary: "Postgres stores project data reliably since 2023",
        relationship: {
          olderVariantsOf: [{ ref: "other" }],
          conflictsWith: [],
          detectionConfidence: 0.95,
        },
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres is the primary store.",
    expected: {
      warning: false,
      reason: "none",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 5. No ambiguity: single row, no relationship block, no asymmetric
  //    negation. Public message must be byte-equal to the synthesized
  //    answer.
  // -----------------------------------------------------------------------
  {
    id: "S5",
    name: "no ambiguity -> public message byte-equal pre-Phase-D",
    kind: "expect-byte-equal",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
      },
    ],
    query: "What database does the project use?",
    answer: "The project uses Postgres 16 for the primary store.",
    expected: {
      warning: false,
      reason: "none",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 6. Clarified supersession / history-shaped case. Phase D does not
  //    introduce resolved / current-truth semantics. We mark the
  //    scenario as a documented capability gap. When a stored conflict
  //    pointer is also present, the warning still fires; when only
  //    neutral history rows are present, no special resolved behavior
  //    is asserted and the detector is expected to stay silent.
  //
  //    The two rows below are deliberately constructed so the
  //    lexical ranker keeps both as relevant to the query (both
  //    mention "Postgres" and "primary store" with the same
  //    core noun phrase), they have NO asymmetric negation
  //    (so the lexical safety-net path stays silent), and the
  //    stored `relationship` block carries NO mutual pointer
  //    (so the structural-pointer path stays silent). The
  //    detector must therefore return `kind: "none"`, which is
  //    the documented behavior: Phase D does not infer a
  //    "current truth" or "resolved" semantic from a
  //    history-shaped pair of rows.
  // -----------------------------------------------------------------------
  {
    id: "S6",
    name: "clarified supersession / history-shaped case -> documented capability gap",
    kind: "capability-gap",
    rows: [
      {
        summary:
          "Postgres was the project primary store; MySQL was the previous primary store before 2023",
      },
      {
        summary: "Postgres is the project primary store for the active project",
      },
    ],
    query: "What is the project primary store?",
    answer: "Postgres is the project primary store.",
    expected: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Phase D does not infer resolved / current-truth semantics from a " +
        "history-shaped pair. The detector treats the two rows as a normal " +
        "candidate set and stays silent because neither rule (stored " +
        "pointer, lexical safety-net with asymmetric negation) fires. A " +
        "future revision behind an approval gate could add a " +
        "resolved-supersession rule; this is a documented gap, not a " +
        "regression.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 7. Older variants still plausible and unresolved: stored
  //    reciprocal olderVariantsOf but no answer alignment / no
  //    shared lexical claim. The detector still fires on the
  //    stored-pointer path; the public message still carries the
  //    warning.
  // -----------------------------------------------------------------------
  {
    id: "S7",
    name: "older variants still plausible (mutual olderVariantsOf) -> warning, reason older-variant-suspected",
    kind: "expect-warning",
    rows: [
      {
        summary: "Project data is stored in Postgres on a single host",
        relationship: {
          conflictsWith: [],
          olderVariantsOf: [{ ref: "other" }],
          detectionConfidence: 0.95,
        },
      },
      {
        summary: "Project data is stored in Postgres on multiple hosts",
        relationship: {
          conflictsWith: [],
          olderVariantsOf: [{ ref: "other" }],
          detectionConfidence: 0.93,
        },
      },
    ],
    query: "How is project data stored?",
    answer: "Project data is stored in Postgres on multiple hosts.",
    expected: {
      warning: true,
      reason: "older-variant-suspected",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 8. no_memory unaffected: empty storage -> no provider call,
  //    `no_memory` status, public message is the exact
  //    `NO_RELEVANT_MEMORY` placeholder with no note prefix.
  // -----------------------------------------------------------------------
  {
    id: "S8",
    name: "no_memory -> public message byte-equal NO_RELEVANT_MEMORY, no note",
    kind: "expect-byte-equal",
    rows: [],
    query: "When is the company picnic?",
    answer: "(unused: no provider call on no_memory path)",
    expected: {
      warning: false,
      reason: "none",
      status: "no_memory",
    },
    pinApiShape: true,
    pinProviderCalls: false,
  },

  // -----------------------------------------------------------------------
  // 9. rejected unaffected: secret-shaped query -> public message is
  //    `Rejected: ...` with no note prefix; provider is not called.
  // -----------------------------------------------------------------------
  {
    id: "S9",
    name: "rejected (secret-shaped query) -> public message 'Rejected: ...', no note",
    kind: "expect-byte-equal",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
      },
    ],
    query: "AKIAIOSFODNN7EXAMPLE",
    answer: "(unused: provider is not called on rejected path)",
    expected: {
      warning: false,
      reason: "none",
      status: "rejected",
    },
    pinApiShape: true,
    pinProviderCalls: false,
  },

  // -----------------------------------------------------------------------
  // 10. provider_error unaffected: scripted 500 -> public message is
  //     `Provider error: ...` with no note prefix.
  // -----------------------------------------------------------------------
  {
    id: "S10",
    name: "provider_error -> public message 'Provider error: ...', no note",
    kind: "expect-byte-equal",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
      },
    ],
    query: "What database does the project use?",
    answer: "(unused: provider returns 500 in this scenario)",
    expected: {
      warning: false,
      reason: "none",
      status: "provider_error",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 11. Public API / result key shape unchanged. The expected
  //     outcome here is exercised implicitly by every other
  //     scenario; this dedicated scenario is a redundant pin that
  //     asserts the public `RecallResult` shape explicitly.
  // -----------------------------------------------------------------------
  {
    id: "S11",
    name: "public API/result key shape unchanged (single text param, allowed key set)",
    kind: "expect-byte-equal",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres 16 is the primary store.",
    expected: {
      warning: false,
      reason: "none",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },

  // -----------------------------------------------------------------------
  // 12. Provider-call behavior unchanged: even when a warning is
  //     expected, the provider is still called exactly once (no
  //     short-circuit). This scenario is functionally identical to
  //     S1; the report records it as a dedicated provider-call pin
  //     so the matrix shows the check explicitly.
  // -----------------------------------------------------------------------
  {
    id: "S12",
    name: "warning fires but provider is still called exactly once (no short-circuit)",
    kind: "expect-warning",
    rows: [
      {
        summary: "Postgres stores project data reliably",
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.95,
        },
      },
      {
        summary: "Postgres stores project data reliably since 2023",
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.93,
        },
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres is the primary store.",
    expected: {
      warning: true,
      reason: "conflicting-candidates",
      status: "answered",
    },
    pinApiShape: true,
    pinProviderCalls: true,
  },
];

// ---------------------------------------------------------------------------
// Row-id resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve an `IdList` of mixed concrete ids and `{ ref: "other" }`
 * references to a list of concrete ids. `otherId` is the id
 * the `RowRef` should be replaced with.
 */
export function resolveIdList(list: IdList | undefined, otherId: number): number[] {
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const x of list) {
    if (typeof x === "number") {
      out.push(x);
    } else if (x !== null && typeof x === "object" && (x as RowRef).ref === "other") {
      out.push(otherId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report types and helper
// ---------------------------------------------------------------------------

/** Per-scenario verdict (recorded by the runner). */
export type ScenarioVerdict = "pass" | "false-positive" | "false-negative" | "gap";

export interface ScenarioReportRow {
  id: string;
  name: string;
  kind: ScenarioKind;
  verdict: ScenarioVerdict;
  expectedWarning: boolean;
  actualWarning: boolean;
  expectedReason: string;
  actualReason: string;
  expectedStatus: ExpectedStatus;
  actualStatus: ExpectedStatus;
  expectedProviderCalls: number | null;
  actualProviderCalls: number;
  capabilityGap?: string;
  /** API drift pin: were the public `RecallResult` keys
   *  exactly the allowed set? `null` when not asserted. */
  apiDrift: boolean | null;
  /** Provider-call pin: was the provider called exactly
   *  the expected number of times (when asserted)?
   *  `null` when not asserted. */
  providerCallOk: boolean | null;
  /** Free-form note (e.g. "scenario pinned API drift only"). */
  note?: string;
}

export interface ValidationReport {
  totalScenarios: number;
  expectedWarningCount: number;
  actualWarningCount: number;
  falsePositives: number;
  falseNegatives: number;
  warningReasonCounts: Record<string, number>;
  statusPreservation: {
    answered: number;
    no_memory: number;
    rejected: number;
    provider_error: number;
  };
  apiDriftChecks: {
    asserted: number;
    passed: number;
    failed: number;
  };
  providerCallChecks: {
    asserted: number;
    passed: number;
    failed: number;
  };
  capabilityGaps: number;
  rows: readonly ScenarioReportRow[];
}

/** Build an empty report rows buffer. The runner mutates it. */
export function newReportRows(): ScenarioReportRow[] {
  return [];
}

/** Build the final report from a buffer of rows. */
export function buildReport(rows: readonly ScenarioReportRow[]): ValidationReport {
  const expectedWarningCount = rows.filter((r) => r.expectedWarning).length;
  const actualWarningCount = rows.filter((r) => r.actualWarning).length;
  const falsePositives = rows.filter((r) => r.verdict === "false-positive").length;
  const falseNegatives = rows.filter((r) => r.verdict === "false-negative").length;
  const warningReasonCounts: Record<string, number> = {};
  for (const r of rows) {
    if (!r.actualWarning) continue;
    const k = r.actualReason;
    warningReasonCounts[k] = (warningReasonCounts[k] ?? 0) + 1;
  }
  const statusPreservation = {
    answered: rows.filter((r) => r.actualStatus === "answered").length,
    no_memory: rows.filter((r) => r.actualStatus === "no_memory").length,
    rejected: rows.filter((r) => r.actualStatus === "rejected").length,
    provider_error: rows.filter((r) => r.actualStatus === "provider_error").length,
  };
  const apiAsserted = rows.filter((r) => r.apiDrift !== null);
  const apiDriftChecks = {
    asserted: apiAsserted.length,
    passed: apiAsserted.filter((r) => r.apiDrift === true).length,
    failed: apiAsserted.filter((r) => r.apiDrift === false).length,
  };
  const callAsserted = rows.filter((r) => r.providerCallOk !== null);
  const providerCallChecks = {
    asserted: callAsserted.length,
    passed: callAsserted.filter((r) => r.providerCallOk === true).length,
    failed: callAsserted.filter((r) => r.providerCallOk === false).length,
  };
  const capabilityGaps = rows.filter((r) => r.verdict === "gap").length;
  return {
    totalScenarios: rows.length,
    expectedWarningCount,
    actualWarningCount,
    falsePositives,
    falseNegatives,
    warningReasonCounts,
    statusPreservation,
    apiDriftChecks,
    providerCallChecks,
    capabilityGaps,
    rows: [...rows],
  };
}

/** Format the report as a compact, human-readable block. */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push("Phase E -- ambiguity behavior validation summary");
  lines.push("==============================================");
  lines.push(`total curated scenarios   : ${report.totalScenarios}`);
  lines.push(`expected-warning count   : ${report.expectedWarningCount}`);
  lines.push(`actual-warning count     : ${report.actualWarningCount}`);
  lines.push(`false positives          : ${report.falsePositives}`);
  lines.push(`false negatives          : ${report.falseNegatives}`);
  lines.push(
    `warning reason counts    : ${
      Object.keys(report.warningReasonCounts).length === 0
        ? "(none)"
        : Object.entries(report.warningReasonCounts)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
    }`
  );
  lines.push(
    `status preservation      : answered=${report.statusPreservation.answered}, ` +
      `no_memory=${report.statusPreservation.no_memory}, ` +
      `rejected=${report.statusPreservation.rejected}, ` +
      `provider_error=${report.statusPreservation.provider_error}`
  );
  lines.push(
    `api drift checks         : asserted=${report.apiDriftChecks.asserted}, ` +
      `passed=${report.apiDriftChecks.passed}, ` +
      `failed=${report.apiDriftChecks.failed}`
  );
  lines.push(
    `provider-call checks     : asserted=${report.providerCallChecks.asserted}, ` +
      `passed=${report.providerCallChecks.passed}, ` +
      `failed=${report.providerCallChecks.failed}`
  );
  lines.push(`documented capability gaps: ${report.capabilityGaps}`);
  lines.push("");
  lines.push("Per-scenario verdicts:");
  for (const r of report.rows) {
    const gapTag = r.capabilityGap !== undefined ? " [gap]" : "";
    const expectedCalls = r.expectedProviderCalls === null ? "n/a" : `${r.expectedProviderCalls}`;
    const actualCalls = `${r.actualProviderCalls}`;
    const callMatch =
      r.expectedProviderCalls === null || r.expectedProviderCalls === r.actualProviderCalls
        ? "ok"
        : "MISMATCH";
    lines.push(
      `  ${r.id}  ${r.verdict.padEnd(15)} ` +
        `expected=${r.expectedStatus}/${r.expectedWarning ? "warn" : "ok"} ` +
        `actual=${r.actualStatus}/${r.actualWarning ? "warn" : "ok"} ` +
        `reason=${r.actualReason} ` +
        `calls=${actualCalls}/${expectedCalls}(${callMatch})${gapTag}  ${r.name}`
    );
  }
  if (report.capabilityGaps > 0) {
    lines.push("");
    lines.push("Capability gap notes:");
    for (const r of report.rows) {
      if (r.capabilityGap === undefined) continue;
      lines.push(`  ${r.id}  ${r.capabilityGap}`);
    }
  }
  return lines.join("\n");
}

// (No re-export of `MemoryRecord` here; the runner imports
// the type directly from `src/storage` because it also
// imports other storage symbols. The helper is intentionally
// pure-data; it does not import from the storage module.)
