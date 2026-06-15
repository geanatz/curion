/**
 * Phase G — curated validation scenarios for the
 * resolved-history semantics gap surfaced by Phase E.
 *
 * Validation-only. Test-local. NOT wired into production.
 *
 * The Phase F spec
 * (`docs/resolved-history-semantics-phase-f.md`) is a
 * design proposal that would close the Phase E S6
 * capability gap behind a series of follow-on phases
 * (G, H, I, J). Phase G is the **first** of those
 * follow-on phases: a curated validation matrix that
 * pins the **contract** for the future detector and
 * verifies the **current invariants** that the detector
 * must not regress.
 *
 * Two distinct axes are encoded in the scenario model
 * and the runner:
 *
 * 1. **Current-actual behavior** (what the controller
 *    returns *today*, before any Phase H/I/J work).
 *    Every scenario records an `expectedCurrent` value
 *    — the verdict the runner must observe. This is the
 *    invariant the suite actively guards. Any
 *    `expectedCurrent` mismatch is a regression and the
 *    runner records it as a `false-positive` /
 *    `false-negative` / `regression` row.
 *
 * 2. **Future-desired behavior** (what the Phase F spec
 *    proposes, behind the follow-on phases). Every
 *    scenario also records a `desiredFuture` value —
 *    the verdict a future implementation should
 *    produce. The runner reports this as a separate
 *    column in the report and increments the
 *    `documentedCapabilityGaps` count whenever
 *    `expectedCurrent !== desiredFuture`. The runner
 *    does **not** fail on a future-vs-current mismatch
 *    because the feature is not implemented yet; it
 *    records the gap honestly.
 *
 * The two axes let a reviewer see at a glance:
 *
 *   - "did the controller regress any current
 *     invariant?" (asserted as a pass/fail)
 *   - "what is the size and shape of the documented
 *     gap that the follow-on phases would close?"
 *     (counted, not asserted)
 *
 * Scenario ids follow the Phase E convention
 * (`SG1`, `SG2`, ...). The matrix mirrors the
 * `tests/_helpers/ambiguity-behavior-scenarios.ts` shape
 * where possible (row shape, relationship block, query,
 * scripted answer) so a reader can compare the two
 * suites side by side. The marker set on the row
 * `summary` field is the Phase F closed set
 * (`replaced` / `previous` / `old` / `current` /
 * `no longer` / `superseded`); the runner does not
 * require any new production code to recognise the
 * markers — it merely records the desired verdict.
 *
 * No benchmark experiment modules are imported here.
 * No raw text is stored or echoed. The "row shape"
 * entries use only the safe summary fields and the
 * post-Phase-B `metadata.relationship` block.
 *
 * The relationship pointer arrays in each scenario row
 * are declared as references to "the other row" by
 * *index* (`{ ref: "other" }`) so the runner can
 * resolve them to real ids after the rows are inserted.
 * The runner owns that resolution.
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
 * declared index (0-based). The runner resolves this to
 * a real memory id after insert.
 */
export interface RowRef {
  ref: "other";
}

/**
 * A list of either concrete ids (`number`) or row
 * references (`RowRef`). The runner resolves all
 * references post-insert.
 */
export type IdList = ReadonlyArray<number | RowRef>;

/**
 * The stored relationship metadata block shape,
 * mirroring the Phase B/Phase C write-side shape. The
 * runner writes each row via `insertMemoryRecord` and
 * then patches `metadata.relationship` directly to model
 * the post-write row shape.
 */
export interface ScenarioRelationshipBlock {
  derivedSchemaVersion?: string;
  derivedAt?: number;
  conflictsWith?: IdList;
  olderVariantsOf?: IdList;
  detectionConfidence?: number;
  // Forward-looking optional keys, per the Phase F spec
  // §6.2. Phase G does not require these to be written
  // or read; the runner treats them as **read-only**
  // evidence when present, but does not require them.
  // Phase I, behind its own approval gate, would write
  // and project them.
  supersedes?: IdList;
  supersededBy?: IdList;
  resolvedAt?: number;
}

export interface ScenarioRow {
  summary: string;
  tags?: string[];
  /** Optional post-write `metadata.relationship` block.
   *  The id lists in the block can reference other rows
   *  in the scenario by `RowRef`. The runner resolves
   *  them to concrete ids post-insert. */
  relationship?: ScenarioRelationshipBlock;
}

export type ExpectedStatus = "answered" | "no_memory" | "rejected" | "provider_error";

/**
 * The two-axis verdict the runner asserts.
 *
 *   - `expectedCurrent`: what the controller should
 *     produce **today**. The runner compares the actual
 *     projected outcome to this value; a mismatch is a
 *     `regression` / `false-positive` / `false-negative`.
 *   - `desiredFuture`: what the Phase F spec (plus the
 *     follow-on phases) would produce. The runner does
 *     **not** assert this; it only records it and
 *     counts the gap.
 *
 * The two fields share the same shape on the
 * `answered` status; the only difference is whether a
 * `note` is expected. On `no_memory` / `rejected` /
 * `provider_error` the two fields are always equal
 * (the future spec explicitly preserves these
 * branches).
 */
export interface Verdict {
  /** Does the public `message` start with a "Note: ..."
   *  prefix line? */
  warning: boolean;
  /** Detector reason surfaced. `"none"` is asserted
   *  when the detector is expected to stay silent. */
  reason:
    | "conflicting-candidates"
    | "older-variant-suspected"
    | "resolved-history"
    | "none";
  /** Public outcome status. */
  status: ExpectedStatus;
  /** Short human-readable note. The runner does not
   *  assert the exact wording (Phase F is the spec for
   *  that); it only counts this as a gap when
   *  `expectedCurrent.warning === false` and
   *  `desiredFuture.warning === true`. */
  note?: string;
}

export interface ExpectedOutcome {
  warning: boolean;
  reason?:
    | "conflicting-candidates"
    | "older-variant-suspected"
    | "resolved-history"
    | "none";
  status?: ExpectedStatus;
  /** Free-form note for the runner. Used for both
   *  current-actual and future-desired gap rows. */
  capabilityGap?: string;
}

/** Curation classification. Drives report counts. */
export type ScenarioKind =
  /** Both `expectedCurrent` and `desiredFuture` agree
   *  the controller should stay silent. The runner
   *  asserts `warning === false`. */
  | "expect-no-warning"
  /** `expectedCurrent.warning` and `desiredFuture.warning`
   *  disagree. The runner asserts current behavior and
   *  records the gap. */
  | "expect-current-no-warning"
  /** Both `expectedCurrent` and `desiredFuture` agree a
   *  Phase D-style warning should fire. The runner
   *  asserts `warning === true` and the Phase D
   *  `reason` value. */
  | "expect-warning"
  /** Future resolved-history verdict. The runner
   *  asserts the current behavior (no warning) and
   *  records the gap toward the future verdict
   *  (`warning === true` with `reason:
   *  "resolved-history"`). */
  | "expect-current-silent-future-resolved"
  /** Future resolved-history verdict is *required* for
   *  the scenario to be useful (e.g. the spec
   *  explicitly requires resolution to a current
   *  truth), but the current behavior must not regress
   *  in a way that makes a Phase D warning fire where
   *  none is documented. The runner asserts current
   *  behavior and counts the gap. */
  | "expect-current-no-warning-future-resolved"
  /** Pin for an invariant that does not produce a
   *  warning but pins API shape, status preservation,
   *  or state. */
  | "invariant-pin";

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
  /** Scripted provider answer. The controller passes
   *  this to the validated answer; the detector
   *  inspects the validated copy. For scenarios that
   *  do not call the provider (no_memory, rejected)
   *  the runner ignores this field. For
   *  `provider_error` scenarios the runner scripts a
   *  500 response and ignores this field. */
  answer: string;
  /** Expected current-actual outcome (what the runner
   *  asserts). */
  expectedCurrent: ExpectedOutcome;
  /** Expected future-desired outcome (what the runner
   *  only records / counts as a gap). */
  desiredFuture: ExpectedOutcome;
  /** When `true`, the runner asserts the public
   *  `message` / `answer` / `status` / `sourceIds`
   *  shape is the union of the documented public keys
   *  (API drift pin). Default `true`. */
  pinApiShape?: boolean;
  /** When `true`, the runner asserts the provider was
   *  called exactly the natural number of times for
   *  the expected status. Defaults:
   *    - `answered`: 1 (primary succeeds, no fallback).
   *    - `provider_error`: 2 (primary + fallback both
   *      fail; the controller does not retry beyond the
   *      fallback).
   *    - `no_memory` / `rejected`: 0 (provider is not
   *      called; the controller short-circuits before
   *      the synthesis call). */
  pinProviderCalls?: boolean;
  /** When `true`, the runner asserts that every
   *  inserted row stays `state === "active"` in
   *  storage after the recall call (locked Phase F
   *  decision §2.3: older resolved memories remain
   *  active and retrievable; the controller never
   *  transitions `state`). Default `true` for `kind`
   *  values that involve more than one row. */
  pinStateActive?: boolean;
}

// ---------------------------------------------------------------------------
// Curated scenario list (Phase F spec §7 + Phase G matrix)
// ---------------------------------------------------------------------------

export const SCENARIOS: readonly Scenario[] = [
  // -----------------------------------------------------------------------
  // SG1 — "Render was previous/old" + "Fly.io is current/replaced Render"
  //       (the canonical resolved supersession pair from the user brief).
  //
  //   After Phase J: the detector (Phase H) returns
  //   `kind: "resolved-history"`; the public `message` is prefixed with
  //   the short, conservative history note; the synthesized answer
  //   (Fly.io) is unchanged; both ids are still listed in `sourceIds`;
  //   neither row is transitioned to `superseded`. The `expectedCurrent`
  //   now matches `desiredFuture` — the gap is closed by the
  //   implementation.
  // -----------------------------------------------------------------------
  {
    id: "SG1",
    name: "explicit Render -> Fly.io pair -> resolved-history (Phase J)",
    kind: "expect-current-silent-future-resolved",
    rows: [
      {
        summary: "Render was the previous hosting platform. The current hosting platform is Fly.io.",
        tags: ["hosting"],
      },
      {
        summary: "Fly.io is the current hosting platform for production.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "Fly.io is the current hosting platform for production.",
    expectedCurrent: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F spec §4.1: detector returns kind: 'resolved-history'; " +
        "public message is prefixed with the short history-shaped note. " +
        "The synthesized answer is unchanged. Both ids remain in " +
        "sourceIds. No state transition.",
    },
    desiredFuture: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F spec §4.1: detector returns kind: 'resolved-history'; " +
        "public message is prefixed with the short history-shaped note " +
        "listing the relevant memory ids. The synthesized answer is " +
        "unchanged. Both ids remain in sourceIds. No state transition.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG2 — Single asymmetric marker only ("Render was replaced" without
  //       a current target row). The spec explicitly forbids a single
  //       marker from triggering resolution in the first version
  //       (Phase F §5.2 Pattern A requires markers on both sides, or
  //       Pattern B requires a referential block on one side). The
  //       current behavior (silent) and the future behavior (still
  //       silent, recorded as a future-unsolvable gap) agree.
  //
  //   The runner asserts no warning fires and no resolved-history
  //   verdict is produced. This pins the negative rule: a lone marker
  //   is not enough to claim resolution.
  // -----------------------------------------------------------------------
  {
    id: "SG2",
    name: "single asymmetric marker only -> must NOT resolve (current and future agree)",
    kind: "expect-no-warning",
    rows: [
      {
        summary: "Render was replaced for production hosting.",
        tags: ["hosting"],
      },
      {
        summary: "The team uses a hosting platform for the staging app.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the team use?",
    answer: "The team uses a hosting platform for the staging app.",
    expectedCurrent: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Locked Phase F decision §5.2: a single asymmetric marker " +
        "('replaced' with no companion 'current' / 'replaced' row and " +
        "no referential block) must not trigger resolution. The " +
        "detector must stay silent.",
    },
    desiredFuture: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Phase F §5.2 Pattern A requires markers on both sides. " +
        "Pattern B requires a referential block on one side. Neither " +
        "is present here. Future behavior agrees with current: stay " +
        "silent.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG3 — Recency-only pair: two rows written in id order, no explicit
  //       markers. The spec explicitly forbids recency from claiming
  //       resolution (Phase F §5.3, locked decision §2.2). The current
  //       behavior and the future behavior agree: stay silent.
  //
  //   The runner asserts no warning fires. The future spec's
  //   resolved-history verdict is explicitly NOT produced.
  // -----------------------------------------------------------------------
  {
    id: "SG3",
    name: "recency-only pair -> must NOT resolve by recency (current and future agree)",
    kind: "expect-no-warning",
    rows: [
      {
        summary: "The project uses Render for hosting.",
        tags: ["hosting"],
      },
      {
        summary: "The project uses Fly.io for hosting.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "The project uses Fly.io for hosting.",
    expectedCurrent: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Locked Phase F decision §2.2: recency is never sufficient. " +
        "Even though id(row 1) < id(row 2), the detector must not " +
        "claim row 1 is a 'previous' row. No explicit markers, no " +
        "stored pointer, no asymmetric negation -> stay silent.",
    },
    desiredFuture: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Phase F §5.3 (negative rule): the detector must not use " +
        "wall-clock time, derivedAt, id ordering, or lexical rank " +
        "order to claim resolution. Future behavior: stay silent.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG4 — Three-step timeline: Render -> Fly.io -> Railway, with
  //       explicit markers on all sides. The spec describes this as
  //       the canonical "current answer + history note sources" case
  //       (Phase F §7 example cluster, Phase F open question §11.3).
  //
  //   After Phase J: the detector (Phase H) returns
  //   `kind: "resolved-history"` for the (history, current) pair; the
  //   synthesized answer matches the current side (Railway); the
  //   public `message` carries the short history note. The three rows
  //   all stay `state = "active"`. The `expectedCurrent` now matches
  //   `desiredFuture` — the gap is closed by the implementation.
  // -----------------------------------------------------------------------
  {
    id: "SG4",
    name: "three-step Render -> Fly.io -> Railway timeline with explicit markers -> resolved-history (Phase J)",
    kind: "expect-current-silent-future-resolved",
    rows: [
      {
        summary: "Render was the previous hosting platform. It is no longer used.",
        tags: ["hosting", "history"],
      },
      {
        summary: "Fly.io replaced Render as the hosting platform. It has since been superseded.",
        tags: ["hosting", "history"],
      },
      {
        summary: "Railway is the current hosting platform for production.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "Railway is the current hosting platform for production.",
    expectedCurrent: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F: detector returns kind: 'resolved-history' with " +
        "memoryIds covering the resolved group. Synthesized answer " +
        "matches the 'current' side (Railway). All three rows stay " +
        "state = 'active' and remain retrievable.",
    },
    desiredFuture: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F: detector returns kind: 'resolved-history' with " +
        "memoryIds covering the resolved group. Synthesized answer " +
        "matches the 'current' side (Railway). All three rows stay " +
        "state = 'active' and remain retrievable.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG5 — Plain history row that does NOT conflict with the current
  //       target: a single "We used Render in 2023" row plus a
  //       non-conflicting "We use Fly.io" row. No markers, no
  //       companion "current" reference. The system must not warn
  //       ambiguity.
  //
  //   The runner asserts no warning fires. The future spec agrees:
  //   this is a "plain history" row, not a resolved-supersession
  //   pair, and the public message is byte-equal to pre-Phase-D.
  // -----------------------------------------------------------------------
  {
    id: "SG5",
    name: "plain history row, no conflict -> must not warn (current and future agree)",
    kind: "expect-no-warning",
    rows: [
      {
        summary: "We used Render for hosting in 2023. The team liked it for staging.",
        tags: ["hosting", "history"],
      },
      {
        summary: "We use Fly.io for production hosting.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "We use Fly.io for production hosting.",
    expectedCurrent: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Plain history row carries no resolution marker and does not " +
        "conflict with the current target. Phase D stays silent.",
    },
    desiredFuture: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Phase F §3.4: 'plain history' rows stay silent. No explicit " +
        "markers, no stored pointer, no companion 'current' reference " +
        "in the resolution sense -> no resolved-history verdict. " +
        "Public message is byte-equal to pre-Phase-D.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG6 — Explicit unresolved conflict: "Render is current" + "Fly.io is
  //       current" with no resolution marker on either side. The pair
  //       has a stored `conflictsWith` pointer (mutual). Phase D
  //       Rule 1 catches this and the existing Phase D warning fires.
  //
  //   The spec is explicit (§4.2): the new resolved-history path must
  //   NOT downgrade a Phase D warning into a resolved-history note. The
  //   current and future behavior agree: warning fires, reason is
  //   `conflicting-candidates`, the public message carries the Phase D
  //   note.
  //
  //   The runner asserts the Phase D warning fires and is NOT
  //   downgraded to a resolved-history note.
  // -----------------------------------------------------------------------
  {
    id: "SG6",
    name: "explicit unresolved conflict -> Phase D warning wins (current and future agree)",
    kind: "expect-warning",
    rows: [
      {
        summary: "Render is the current hosting platform.",
        tags: ["hosting"],
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.95,
        },
      },
      {
        summary: "Fly.io is the current hosting platform.",
        tags: ["hosting"],
        relationship: {
          conflictsWith: [{ ref: "other" }],
          olderVariantsOf: [],
          detectionConfidence: 0.93,
        },
      },
    ],
    query: "What is the current hosting platform?",
    answer: "Render is the current hosting platform.",
    expectedCurrent: {
      warning: true,
      reason: "conflicting-candidates",
      status: "answered",
      capabilityGap:
        "Phase D Rule 1 catches the mutual stored conflict. " +
        "Both rows claim 'current' but neither carries a " +
        "resolution marker on the 'previous' / 'replaced' side. " +
        "Phase D warning fires; the public message carries the " +
        "conflicting-candidates note.",
    },
    desiredFuture: {
      warning: true,
      reason: "conflicting-candidates",
      status: "answered",
      capabilityGap:
        "Phase F §4.2: a stored conflict pointer wins; the " +
        "resolved-history path must NOT downgrade a Phase D " +
        "warning. Future behavior agrees: warning fires with " +
        "reason: 'conflicting-candidates'.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG7 — Superseded / no-longer wording. The spec marks both
  //       `superseded` and `no longer` as closed-set markers. This
  //       scenario uses both markers to make the resolution pattern
  //       unambiguous from the safe summary alone (no referential
  //       block required, since both sides carry a marker).
  //
  //   After Phase J: the detector (Phase H) returns
  //   `kind: "resolved-history"`; the synthesized answer matches the
  //   'current' side (Fly.io); the public `message` carries the short
  //   history note. The `expectedCurrent` now matches
  //   `desiredFuture` — the gap is closed by the implementation.
  // -----------------------------------------------------------------------
  {
    id: "SG7",
    name: "superseded / no-longer wording -> resolved-history (Phase J)",
    kind: "expect-current-silent-future-resolved",
    rows: [
      {
        summary: "The old hosting platform was Render. It has been superseded by Fly.io.",
        tags: ["hosting"],
      },
      {
        summary: "Fly.io is the current hosting platform; Render is no longer used.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "Fly.io is the current hosting platform.",
    expectedCurrent: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F §5.1: closed-set markers include 'superseded' " +
        "and 'no longer'. Both sides carry markers. Pattern A " +
        "(mutual) fires. Synthesized answer matches the " +
        "'current' side (Fly.io).",
    },
    desiredFuture: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F §5.1: closed-set markers include 'superseded' " +
        "and 'no longer'. Both sides carry markers. Pattern A " +
        "(mutual) should fire. Synthesized answer matches the " +
        "'current' side (Fly.io).",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG8 — Old memories stay retrievable: a scenario that asserts
  //       every seeded row remains in the `listActiveMemorySummaries`
  //       read-back after the recall call. This is the locked
  //       decision §2.3 invariant: older resolved memories stay
  //       `state = "active"` and remain retrievable. The runner
  //       pins this on every `kind` that involves more than one
  //       row, and this dedicated scenario makes the pin explicit
  //       for the reader.
  //
  //   After Phase J: the seeded rows form a marker-based
  //   pair (row 1 carries `previous`; row 2 carries
  //   `replaced`), so the resolved-history detector (Phase H)
  //   fires and the public `message` is prefixed with the
  //   history note. The synthesized answer matches the
  //   'current' side (Fly.io). The state-activation pin
  //   continues to assert the locked decision §2.3 invariant
  //   on the *read-side* shape: no row is transitioned to
  //   `superseded`; the detector only emits a signal, not a
  //   state change. The `expectedCurrent` now matches the
  //   actually-observed behavior: warning fires, reason is
  //   `resolved-history`. The scenario is still an
  //   `invariant-pin` because the state-activation pin is
  //   the primary contract under test; the resolved-history
  //   note is a downstream consequence of the closed-set
  //   markers being present in the seeded rows.
  // -----------------------------------------------------------------------
  {
    id: "SG8",
    name: "older memories remain state=active and retrievable; resolved-history fires (Phase J invariant pin)",
    kind: "invariant-pin",
    rows: [
      {
        summary: "Render was the previous hosting platform.",
        tags: ["hosting"],
      },
      {
        summary: "Fly.io replaced Render as the hosting platform in 2024.",
        tags: ["hosting"],
      },
      {
        summary: "The team also uses AWS hosting for some side projects.",
        tags: ["hosting"],
      },
    ],
    query: "What hosting platform does the project use?",
    answer: "Fly.io is the current hosting platform.",
    expectedCurrent: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Locked Phase F decision §2.3: the controller must NOT " +
        "transition any seeded row to state = 'superseded'. " +
        "All three rows stay state = 'active' and remain " +
        "retrievable. The runner pins this by re-reading " +
        "listActiveMemorySummaries after the recall call. " +
        "After Phase J the seeded rows trigger the " +
        "resolved-history detector (row 1 carries `previous`; " +
        "row 2 carries `replaced`); the public message is " +
        "prefixed with the history note. The state-activation " +
        "invariant is the primary contract under test.",
    },
    desiredFuture: {
      warning: true,
      reason: "resolved-history",
      status: "answered",
      capabilityGap:
        "Phase F §6.1: no state transition in any follow-on " +
        "phase. The three rows continue to be state = 'active' " +
        "and retrievable. The runner continues to pin this. " +
        "Phase J: closed-set markers trigger the " +
        "resolved-history verdict; the public message is " +
        "prefixed with the history note.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG9 — no_memory / rejected / provider_error unaffected: a triple
  //       of scenarios in one entry. The runner uses the same storage
  //       across three sequential calls (or a fresh storage per call —
  //       the runner chooses the cheaper path; both are correct).
  //
  //   No warning, no resolved-history verdict, no public-message
  //   change. The four-status union is preserved.
  //
  //   To keep the scenario count simple, the runner splits this
  //   scenario into three internal sub-records (one per status) and
  //   reports each one as its own row in the matrix. The
  //   `expectedStatus` on this entry is the **first** status only;
  //   the runner iterates over the three.
  //
  //   The scenario carries a default row (matching the
  //   default `query` lexically) so the `provider_error`
  //   sub-record can drive the controller past the lexical
  //   short-circuit. The runner uses a different (non-matching)
  //   query for the `no_memory` sub-record; see
  //   `runSG9SubStatus`.
  // -----------------------------------------------------------------------
  {
    id: "SG9",
    name: "no_memory / rejected / provider_error unaffected -> no resolved-history note",
    kind: "invariant-pin",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
        tags: ["db"],
      },
    ],
    query: "What database does the project use?",
    answer: "(unused: no provider call on no_memory / rejected paths)",
    expectedCurrent: {
      warning: false,
      reason: "none",
      status: "no_memory",
      capabilityGap:
        "Phase F §4.4: the new resolved-history note must NEVER be " +
        "prefixed in these branches. The runner iterates " +
        "no_memory, rejected, and provider_error; each one keeps " +
        "the original public message verbatim.",
    },
    desiredFuture: {
      warning: false,
      reason: "none",
      status: "no_memory",
      capabilityGap:
        "Phase F §4.4: unchanged in every follow-on phase. Future " +
        "behavior agrees with current behavior: no note, no prefix, " +
        "byte-equal public message in each branch.",
    },
    pinApiShape: true,
    pinProviderCalls: false,
    pinStateActive: true,
  },

  // -----------------------------------------------------------------------
  // SG10 — Public API / result shape unchanged. This dedicated
  //        scenario is a redundant pin that asserts the public
  //        `RecallResult` shape is byte-stable across the suite.
  //        It is functionally identical to the Phase E S11 pin; the
  //        runner records it explicitly so the matrix shows the
  //        check without forcing a reader to cross-reference.
  //
  //   No warning, no resolved-history verdict, no public-message
  //   change. The four-status union is preserved.
  // -----------------------------------------------------------------------
  {
    id: "SG10",
    name: "public API/result key shape unchanged (single text param, allowed key set)",
    kind: "invariant-pin",
    rows: [
      {
        summary: "The project uses Postgres 16 for the primary store.",
        tags: ["db"],
      },
    ],
    query: "What database does the project use?",
    answer: "Postgres 16 is the primary store.",
    expectedCurrent: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Public RecallResult key set is the documented allowed set. " +
        "No new public field has been added. The runner asserts the " +
        "keys are a subset of the allowed set on every scenario.",
    },
    desiredFuture: {
      warning: false,
      reason: "none",
      status: "answered",
      capabilityGap:
        "Phase F §4.5: the new resolved-history signal is " +
        "internal-only on RecallOutcome.internalAmbiguity. The " +
        "public key set does not change. Future behavior agrees: " +
        "no new public field.",
    },
    pinApiShape: true,
    pinProviderCalls: true,
    pinStateActive: true,
  },
];

// ---------------------------------------------------------------------------
// Row-id resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolve an `IdList` of mixed concrete ids and
 * `{ ref: "other" }` references to a list of concrete
 * ids. `otherId` is the id the `RowRef` should be
 * replaced with.
 */
export function resolveIdList(
  list: IdList | undefined,
  otherId: number,
): number[] {
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const x of list) {
    if (typeof x === "number") {
      out.push(x);
    } else if (
      x !== null &&
      typeof x === "object" &&
      (x as RowRef).ref === "other"
    ) {
      out.push(otherId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report types and helper
// ---------------------------------------------------------------------------

/** Per-scenario verdict (recorded by the runner). */
export type ScenarioVerdict =
  /** Current-actual matches `expectedCurrent` AND
   *  `expectedCurrent` agrees with `desiredFuture`. */
  | "pass"
  /** Current-actual matches `expectedCurrent` AND
   *  `expectedCurrent` differs from `desiredFuture` —
   *  a documented future-desired gap. */
  | "current-gap"
  /** Current-actual disagrees with `expectedCurrent`:
   *  a regression on a current invariant. The suite
   *  fails. */
  | "regression"
  /** Unreachable in the runner: scenario could not be
   *  evaluated. The runner records the error and
   *  continues. */
  | "error";

export interface ScenarioReportRow {
  id: string;
  name: string;
  kind: ScenarioKind;
  verdict: ScenarioVerdict;
  expectedCurrentWarning: boolean;
  expectedCurrentReason: string;
  expectedCurrentStatus: ExpectedStatus;
  expectedFutureWarning: boolean;
  expectedFutureReason: string;
  expectedFutureStatus: ExpectedStatus;
  actualWarning: boolean;
  actualReason: string;
  actualStatus: ExpectedStatus;
  expectedProviderCalls: number | null;
  actualProviderCalls: number;
  /** True when `expectedCurrent.warning !==
   *  desiredFuture.warning` (i.e. the future spec wants
   *  a resolved-history note but the current
   *  implementation does not produce one). */
  documentedCapabilityGap: boolean;
  /** Capability gap note (current-actual). */
  currentCapabilityGap?: string;
  /** Capability gap note (future-desired). */
  futureCapabilityGap?: string;
  /** API drift pin: were the public `RecallResult`
   *  keys exactly the allowed set? `null` when not
   *  asserted. */
  apiDrift: boolean | null;
  /** Provider-call pin: was the provider called exactly
   *  the expected number of times (when asserted)?
   *  `null` when not asserted. */
  providerCallOk: boolean | null;
  /** State invariant pin: did every seeded row stay
   *  `state = "active"` after the recall call? `null`
   *  when not asserted. */
  stateActiveOk: boolean | null;
  /** Free-form note (e.g. the regression message). */
  note?: string;
}

export interface ValidationReport {
  totalScenarios: number;
  expectedCurrentWarningCount: number;
  actualWarningCount: number;
  futureResolvedHistoryExpectedCount: number;
  documentedCapabilityGaps: number;
  /** Number of scenarios where the controller
   *  **already** produces the future-desired
   *  resolved-history verdict (i.e. the gap is closed
   *  by current implementation). Phase G expects
   *  this to be `0` for the canonical matrix. */
  futureResolvedHistoryAchievedCount: number;
  /** Sub-count: number of scenarios that pin
   *  recency-only must-not-resolve. */
  recencyOnlyNotResolvedChecks: number;
  /** Sub-count: number of scenarios that pin
   *  explicit-unresolved-conflict must remain
   *  ambiguous. */
  explicitUnresolvedConflictChecks: number;
  /** Sub-count: number of scenarios that pin
   *  older-memories-stay-active retrievability. */
  stateActiveChecks: number;
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
  statusPreservation: {
    answered: number;
    no_memory: number;
    rejected: number;
    provider_error: number;
  };
  regressions: number;
  rows: readonly ScenarioReportRow[];
}

/** Build an empty report rows buffer. The runner
 *  mutates it. */
export function newReportRows(): ScenarioReportRow[] {
  return [];
}

/** Build the final report from a buffer of rows. */
export function buildReport(
  rows: readonly ScenarioReportRow[],
): ValidationReport {
  const expectedCurrentWarningCount = rows.filter(
    (r) => r.expectedCurrentWarning,
  ).length;
  const actualWarningCount = rows.filter((r) => r.actualWarning).length;
  const futureResolvedHistoryExpectedCount = rows.filter(
    (r) => r.expectedFutureReason === "resolved-history",
  ).length;
  const documentedCapabilityGaps = rows.filter(
    (r) => r.documentedCapabilityGap,
  ).length;
  const futureResolvedHistoryAchievedCount = rows.filter(
    (r) =>
      r.expectedFutureReason === "resolved-history" &&
      r.actualReason === "resolved-history",
  ).length;
  const recencyOnlyNotResolvedChecks = rows.filter((r) =>
    r.id === "SG3" || r.id === "SG2",
  ).length;
  const explicitUnresolvedConflictChecks = rows.filter(
    (r) => r.id === "SG6",
  ).length;
  const stateActiveChecks = rows.filter(
    (r) => r.stateActiveOk !== null,
  ).length;
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
  const statusPreservation = {
    answered: rows.filter((r) => r.actualStatus === "answered").length,
    no_memory: rows.filter((r) => r.actualStatus === "no_memory").length,
    rejected: rows.filter((r) => r.actualStatus === "rejected").length,
    provider_error: rows.filter(
      (r) => r.actualStatus === "provider_error",
    ).length,
  };
  const regressions = rows.filter((r) => r.verdict === "regression").length;
  return {
    totalScenarios: rows.length,
    expectedCurrentWarningCount,
    actualWarningCount,
    futureResolvedHistoryExpectedCount,
    documentedCapabilityGaps,
    futureResolvedHistoryAchievedCount,
    recencyOnlyNotResolvedChecks,
    explicitUnresolvedConflictChecks,
    stateActiveChecks,
    apiDriftChecks,
    providerCallChecks,
    statusPreservation,
    regressions,
    rows: [...rows],
  };
}

/** Format the report as a compact, human-readable
 *  block. Mirrors the Phase E `formatReport` shape so
 *  the two reports can be diffed side by side. */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push("Phase G / Phase J -- resolved-history validation summary");
  lines.push("=============================================");
  lines.push(`total scenarios                       : ${report.totalScenarios}`);
  lines.push(
    `future-resolved-history expected      : ${report.futureResolvedHistoryExpectedCount}`,
  );
  lines.push(
    `current capability gaps (documented)  : ${report.documentedCapabilityGaps} ` +
      `(expected 0 after Phase J; >0 means a future gap is still open)`,
  );
  lines.push(
    `future-resolved-history achieved      : ${report.futureResolvedHistoryAchievedCount} ` +
      `(expected 3 after Phase J: SG1, SG4, SG7; 0 means the future ` +
      `behavior is not yet produced by the current implementation)`,
  );
  lines.push(
    `recency-only not-resolved checks      : ${report.recencyOnlyNotResolvedChecks}`,
  );
  lines.push(
    `explicit-unresolved-conflict checks   : ${report.explicitUnresolvedConflictChecks}`,
  );
  lines.push(
    `state-active / retrievable checks     : ${report.stateActiveChecks}`,
  );
  lines.push(
    `status preservation      : answered=${report.statusPreservation.answered}, ` +
      `no_memory=${report.statusPreservation.no_memory}, ` +
      `rejected=${report.statusPreservation.rejected}, ` +
      `provider_error=${report.statusPreservation.provider_error}`,
  );
  lines.push(
    `api drift checks         : asserted=${report.apiDriftChecks.asserted}, ` +
      `passed=${report.apiDriftChecks.passed}, ` +
      `failed=${report.apiDriftChecks.failed}`,
  );
  lines.push(
    `provider-call checks     : asserted=${report.providerCallChecks.asserted}, ` +
      `passed=${report.providerCallChecks.passed}, ` +
      `failed=${report.providerCallChecks.failed}`,
  );
  lines.push(`regressions (current invariants)      : ${report.regressions}`);
  lines.push("");
  lines.push("Per-scenario verdicts:");
  for (const r of report.rows) {
    const gapTag = r.documentedCapabilityGap ? " [gap]" : "";
    const expectedCalls =
      r.expectedProviderCalls === null ? "n/a" : `${r.expectedProviderCalls}`;
    const actualCalls = `${r.actualProviderCalls}`;
    const callMatch =
      r.expectedProviderCalls === null ||
      r.expectedProviderCalls === r.actualProviderCalls
        ? "ok"
        : "MISMATCH";
    lines.push(
      `  ${r.id}  ${r.verdict.padEnd(12)} ` +
        `current=${r.expectedCurrentStatus}/${r.expectedCurrentWarning ? "warn" : "ok"} ` +
        `future=${r.expectedFutureStatus}/${r.expectedFutureWarning ? "warn" : "ok"} ` +
        `actual=${r.actualStatus}/${r.actualWarning ? "warn" : "ok"} ` +
        `reason=${r.actualReason} ` +
        `calls=${actualCalls}/${expectedCalls}(${callMatch})${gapTag}  ${r.name}`,
    );
  }
  if (report.documentedCapabilityGaps > 0) {
    lines.push("");
    lines.push("Capability gap notes (current -> future):");
    for (const r of report.rows) {
      if (!r.documentedCapabilityGap) continue;
      const cur = r.currentCapabilityGap ?? "(no current note)";
      const fut = r.futureCapabilityGap ?? "(no future note)";
      lines.push(`  ${r.id}  current: ${cur}`);
      lines.push(`  ${r.id}  future : ${fut}`);
    }
  }
  return lines.join("\n");
}

// (No re-export of `MemoryRecord` here; the runner
// imports the type directly from `src/storage` because
// it also imports other storage symbols. The helper is
// intentionally pure-data; it does not import from the
// storage module.)
