# Spec / Audit — Resolved Supersession & History Semantics (Phase F)

Status: **Phase F spec-only. No code change in this commit. The
public-message memory-id cleanup on
`experiment/public-message-hide-memory-ids` is a text-only
revision; it does not advance any of Phases G–J and explicitly
forbids Phase J from reintroducing `#N` memory-id references
into the public note (see §8.4).** Phase J has since landed on
`experiment/resolved-history-public-note-phase-j` and the
follow-on phases G, H, I, J are all implemented.
Branch: `experiment/resolved-history-semantics-phase-f`
Built on: `experiment/ambiguity-behavior-validation-phase-e` at commit `1183045`.
Owner: Worker (spec drafted by Worker; awaiting user approval before any
implementation work).

This document is a design proposal only. It must be approved before
any implementation work begins. It is **not** an implementation
plan and **not** a behaviour change.

---

## 1. Purpose & link to Phase E S6 gap

The Phase E curated behavior-validation suite (commit `1183045`,
branch `experiment/ambiguity-behavior-validation-phase-e`) drives
the Phase D public-message ambiguity flag through twelve
hand-curated scenarios. One of them, **S6 — "clarified
supersession / history-shaped case"**, is recorded as a documented
capability gap rather than a pass/fail assertion. The Phase E
helper describes S6 as follows (verbatim from
`tests/_helpers/ambiguity-behavior-scenarios.ts`):

> "Phase D does not infer resolved / current-truth semantics from
> a history-shaped pair. The detector treats the two rows as a
> normal candidate set and stays silent because neither rule
> (stored pointer, lexical safety-net with asymmetric negation)
> fires. A future revision behind an approval gate could add a
> resolved-supersession rule; this is a documented gap, not a
> regression."

S6 looks like this in shape:

- Two stored rows both relevant to the same query.
- One row carries a neutral history marker
  (e.g. *"Postgres was the project primary store; MySQL was the
  previous primary store before 2023"*).
- The other row is the current fact
  (e.g. *"Postgres is the project primary store for the active
  project"*).
- The synthesized answer matches the current fact.
- Neither the stored-pointer rule (`conflictsWith` /
  `olderVariantsOf`) nor the lexical safety-net (asymmetric
  negation) fires, so the detector returns
  `{ kind: "none" }`.
- The public `message` is byte-equal to pre-Phase-D, which is
  correct, but **silent**: the caller receives no acknowledgement
  that the older row was a neutral history note, not a live
  alternative.

The gap is not a regression. It is a missing capability. Phase F
proposes the smallest possible first step that would let the
recall path recognise a **resolved** supersession/history pair and
surface that to the caller — **without** silently picking a
current truth, **without** demoting the older row, and **without**
changing the public API surface.

This spec is consistent with the locked decisions in
`docs/conflict-currentness-metadata.md` §2 (the conservative
conflict/currentness spec) and with the Phase E S6 gap
description. It does not relax any of them.

---

## 2. User decisions locked for Phase F (do not change)

These decisions were approved before this spec was drafted. The
spec must honour all of them and must not silently relax any of
them.

1. **When explicit resolution exists, recall uses a short
   history/resolution note rather than an unresolved ambiguity
   warning or silence.** The public `message` should still tell
   the caller that one of the stored rows was a resolved history
   note, and the relevant memory ids should still be listed, but
   the wording is *history-shaped*, not *conflict-shaped*.
2. **Resolution requires explicit wording.** Explicit wording
   includes at least one of:
   `replaced`, `previous`, `old`, `current`, `no longer`,
   `superseded`. **Recency alone is never sufficient.** A row
   written earlier in time does not make it "older" in the
   resolution sense; only the explicit wording does.
3. **Older resolved memories remain active and retrievable.** The
   system does not transition the older row to
   `state = "superseded"` and does not remove it from the
   `WHERE state = 'active'` query. Older memories stay
   retrievable exactly as they are today; resolution is metadata,
   not a visibility decision.

These three decisions are the spine of the spec. Every other
section either operationalises them or constrains them.

---

## 3. Definitions

Four states the detector must distinguish. They are not
implementation states — they are *labels* the detector assigns to
the relationship between two or more stored rows in a single
candidate set.

### 3.1 Resolved supersession / resolved history

Two or more rows form a **resolved supersession** pair (or
group) when:

- All rows in the group are relevant to the query.
- At least one row carries an **explicit resolution marker**
  (see §5.1) and refers to at least one other row in the group
  using an explicit resolution marker.
- The synthesized answer matches the row that is *not* the
  "previous / replaced / older" side — i.e. the "current" side.

In a resolved group, the system has high confidence that the
older row is a **history note** rather than a live alternative.
The recall path may surface a short, conservative
"history-shaped" note (see §4) and continue to return the
synthesized answer as the `answer` field. The older row stays
active and retrievable; the group is a *relationship* finding,
not a *state transition*.

### 3.2 Unresolved conflict

Two or more rows form an **unresolved conflict** when the Phase D
detector (or any future Phase F detector) returns
`kind: "ambiguous"`, `reason: "conflicting-candidates"`. The
caller has no evidence to pick a current truth; the system must
flag the disagreement and stay neutral. This is exactly what
Phase D does today; Phase F does not change it.

### 3.3 Older variant (paraphrase-shaped)

Two or more rows form an **older variant** pair when the Phase D
detector (or any future Phase F detector) returns
`kind: "ambiguous"`, `reason: "older-variant-suspected"`. The
detector has flagged that the rows may be paraphrases of the same
fact, with one being older. The wording is deliberately softer
than a conflict because the detector has only *suspected* a
paraphrase relationship. Phase F does not change this branch;
the Phase D note wording is preserved verbatim.

### 3.4 Plain history (no resolution marker)

A row is a **plain history** row when it describes a past state
*without* using any explicit resolution marker, **or** it
describes a past state in isolation (no companion "current" row
in the candidate set). The system has no evidence to claim the
past state is resolved. It must stay silent on the past-vs-present
question and may not assert a resolution.

### 3.5 Non-history, non-conflict

Everything else: a single candidate, multiple candidates that
agree, or a candidate set that does not match any of the shapes
above. The detector returns `kind: "none"`. The public `message`
is byte-equal to pre-Phase-D.

### 3.6 Decision table

| Shape in the candidate set                                          | Detector returns                          | Public `message` behaviour             |
| ------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| Resolved supersession (explicit markers; see §5.1)                  | new `kind: "resolved-history"`            | New history-shaped note (see §4)       |
| Unresolved stored conflict (Phase D Rule 1 or Rule 3 fires)         | `kind: "ambiguous"`, `conflicting-candidates` | Unchanged Phase D note                |
| Older variant suspected (Phase D Rule 2 fires)                      | `kind: "ambiguous"`, `older-variant-suspected` | Unchanged Phase D note                |
| Plain history, no markers, no companion current row                 | `kind: "none"`                            | byte-equal pre-Phase-D                 |
| Plain history + companion current row, **no** explicit markers      | `kind: "none"`                            | byte-equal pre-Phase-D                 |
| Single candidate, or no conflict, or no markers                     | `kind: "none"`                            | byte-equal pre-Phase-D                 |

The two changes vs Phase D are the new first row and the
explicit clarification in the second-to-last row. Everything
else is the Phase D detector's behaviour, preserved.

---

## 4. Public recall behavior under locked decisions

The public MCP surface is **unchanged** in this spec. The single
`text` parameter on `recall` and the public `RecallResult`
shape are preserved. The public `message` and `answer` are the
only two fields whose wording is affected, and only on the
`status: "answered"` outcome.

### 4.1 Status: `answered` with new `kind: "resolved-history"`

When the new detector returns
`{ kind: "resolved-history"; reason: ...; memoryIds: number[]; confidence: number; asOf: number }`
on the `answered` outcome:

- The `answer` field is **unchanged**. It is the synthesized
  answer text exactly as the provider returned it.
- The public `message` is the formatted resolution note followed
  by a blank line and the synthesized answer, e.g.:

  > "Note: a stored history row has been resolved.
  >
  > The project uses Postgres 16 for the primary store."

- The note never claims a current truth about the **world**, only
  about the **stored relationship**. The wording explicitly
  refers to "a stored history row" or "a stored previous-state
  row", never to "what is true now".
- The note never echoes raw stored summaries, raw user query, or
  diagnostic substrings. The allowed substrings are bounded to
  the same diagnostic-leakage list Phase D already enforces
  (no `detectionConfidence`, no `derivedAt`, no
  `derivedSchemaVersion`, no `ccm-draft-1`, no
  `internalAmbiguity`, etc.).

### 4.2 Status: `answered` with Phase D `kind: "ambiguous"`

Unchanged from Phase D. The existing two `reason` values
(`conflicting-candidates` and `older-variant-suspected`) keep
their existing note wording. The new resolution-history path
must not "downgrade" a Phase D warning into a
resolved-history note; if the detector finds a stored conflict
pointer *and* an explicit resolution marker on the same pair, the
Phase D warning wins (the resolution is not high-confidence
because a stored conflict is also present). This is a future
revision's policy, not Phase F's, but the rule is recorded here
to keep the precedence explicit.

### 4.3 Status: `answered` with `kind: "none"`

Unchanged from Phase D. The public `message` is byte-equal to
pre-Phase-D. The new resolution-history detector does not run on
candidates that already have an `olderVariantsOf` or
`conflictsWith` pointer; it only runs on plain (or absent)
relationship blocks, so a `kind: "none"` from Phase D is
preserved as `kind: "none"` from Phase F.

### 4.4 Status: `no_memory`, `rejected`, `provider_error`

Unchanged in every case. The new resolution-history note is
never prefixed in these branches.

### 4.5 Public shape constraints

- The public `RecallResult` key set is unchanged. The new
  resolution-history signal is internal-only, on
  `RecallOutcome.internalAmbiguity`, exactly as the Phase D
  signal is internal-only.
- The `sourceIds` list is unchanged in every case. The system
  does **not** silently demote the older row; both ids remain
  listed (locked decision §2.3).
- The `status` enum is unchanged
  (`"answered" | "no_memory" | "rejected" | "provider_error"`).
- The note is bounded in length to the same
  `AMBIGUITY_NOTE_MAX_LENGTH` (240) Phase D already uses; the
  visible id list is bounded to the same
  `AMBIGUITY_NOTE_MAX_IDS` (4). A new prefix string is the only
  output change.

### 4.6 What the recall path does NOT do (first version)

- Does not re-rank.
- Does not call the provider.
- Does not write to storage.
- Does not transition `state` (§2.3).
- Does not drop or filter any source id (§4.5).
- Does not edit the `answer` text. The note is a *prefix on the
  public message* only.
- Does not downgrade a Phase D warning into a
  resolved-history note (§4.2).
- Does not use recency to claim resolution. Explicit markers
  only (§5.1).

---

## 5. Evidence rules

The detector's verdict is gated on the strongest available
evidence, in a fixed order.

### 5.1 Explicit resolution marker set

The marker set is **closed** in Phase F. Adding a new marker is
a future revision behind an approval gate; the first version
does not extend it heuristically.

| Marker (case-insensitive, whole-word)   | Effect                                            |
| --------------------------------------- | ------------------------------------------------- |
| `replaced`                              | Marks the row as the replacement side.            |
| `previous`                              | Marks the row as the previous-state side.         |
| `old`                                   | Marks the row as the older side.                  |
| `current`                               | Marks the row as the current side.                |
| `no longer`                             | Marks the row as describing a state that no longer holds. |
| `superseded`                            | Marks the row as having been superseded.          |

Notes on the marker set:

- All six markers are matched case-insensitively, as whole
  words (whitespace / punctuation boundary), and on the
  controller-normalized safe summary text — never on raw
  input.
- A single marker is not enough on its own. The detector
  requires at least one marker on each side of the pair (the
  "previous / old / superseded / no longer" side and the
  "current / replaced" side), or a single marker on one side
  that explicitly references the other side's id. The exact
  rule is fixed in §5.2.
- A row may carry multiple markers. The detector uses the
  strongest pairing (e.g. `previous` + `current` is a stronger
  signal than `old` alone).

### 5.2 Pairing rule

For two rows `r1` and `r2` in the candidate set, the detector
treats them as a resolved pair if **all** of the following hold:

- Both rows are top-K candidates for the query.
- Neither row carries a stored `conflictsWith` pointer to the
  other (if it does, the Phase D warning wins; see §4.2).
- At least one of the following two patterns holds:
  - **Pattern A (mutual).** `r1` carries a "previous / old /
    superseded / no longer" marker AND `r2` carries a
    "current / replaced" marker (or vice versa).
  - **Pattern B (referential).** One row carries a
    "current / replaced" marker and explicitly references
    the other row's id (or vice versa) by integer. The
    reference is taken from a `supersedes: [id]` or
    `supersededBy: [id]` style block (see §6 for the
    proposed metadata shape).
- The synthesized answer matches the side that is **not** the
  "previous / old / superseded / no longer" side, by token
  overlap ≥ 0.4 on content tokens (length ≥ 4). The threshold
  is a constant, exported for tests.
- The detector confidence is at least the same
  `AMBIGUITY_CONFIDENCE_THRESHOLD` (0.80) Phase D uses.

A pair that fails any of the four conditions above is **not**
treated as resolved. The detector falls through to the existing
Phase D rules. This is the safety net: if the explicit-marker
path is uncertain, the system never invents a resolution.

### 5.3 Recency rule (negative)

The detector must **not** use any of the following to claim
resolution:

- Wall-clock time of the write.
- `derivedAt` (the controller-supplied timestamp on the
  relationship block).
- Memory `id` ordering (lower id is not "older" in the
  resolution sense).
- The lexical ranker's order in the top-K.

This is the locked decision §2.2: recency is never sufficient.
The detector uses explicit wording only.

### 5.4 Provider rule (negative)

The detector must **not** call the provider in Phase F. The
resolution verdict is derived from the stored relationship
block (when present) and the safe summary text. A future
revision may add a provider-side confirmation step behind a
separate approval gate, but Phase F does not propose one and
the spec explicitly excludes it from the first version.

### 5.5 The first version is offline and deterministic

Mirroring the Phase D detector (§5.1–§5.3 of the conservative
spec), the resolution detector is a pure, offline, deterministic
function. No I/O, no clock reads, no provider calls, no storage
access, no mutation. The `asOf` field is informational and
echoed in the signal exactly as Phase D does.

---

## 6. Storage & state policy

### 6.1 No state transition in the first version

All memories remain `state = "active"`. The controller continues
to write `state: "active"` for every new record, exactly as
Phase B and the conservative spec require. The locked decision
§2.3 (older memories remain retrievable) is preserved verbatim.
The detector's verdict is metadata, not a visibility decision.

### 6.2 Optional additive metadata block (future-compatible)

The detector in the first version operates on safe summary
text + the existing `metadata.relationship` block. To support
the referential pattern in §5.2 (Pattern B) without a schema
migration, the spec proposes a **future-compatible** addition
to the `relationship` block shape:

```jsonc
{
  "relationship": {
    "derivedSchemaVersion": "ccm-draft-1",
    "derivedAt": 1718000000000,
    "conflictsWith": [12, 17],
    "olderVariantsOf": [8],
    "detectionConfidence": 0.91
    // ---- optional, added in a future phase ----
    // "supersedes":      [21],   // ids this memory supersedes
    // "supersededBy":    [22],   // ids that supersede this memory
    // "resolvedAt":      1718.., // optional resolution timestamp
  }
}
```

The first version of the detector does **not** require these
new fields. It only needs the existing shape plus the explicit
markers in the safe summary text. The new keys above are
**forward-looking**: if a future phase adds them, the
`derivedSchemaVersion` literal must be bumped, and both the
writer and the read-side projection must be updated together.
The first version does not bump the literal; it does not write
the new keys; it does not read the new keys.

### 6.3 Schema/version implication if fields are added later

If a future phase adds `supersedes` / `supersededBy` /
`resolvedAt` to the `relationship` block:

- `derivedSchemaVersion` must be bumped (e.g. to
  `"ccm-draft-2"`).
- The writer in `src/retrieval/relationship.ts` must append the
  new keys.
- The read-side projection in `listActiveMemorySummaries`
  must project the new keys onto a new optional
  `SafeMemorySummaryRelationship` extension.
- Old rows written under `"ccm-draft-1"` must still project
  cleanly: empty arrays / `0` confidence / `0` timestamp, the
  same fallback Phase B already uses for missing fields.
- A migration test must be added to `tests/contracts.test.ts`
  that seeds a `"ccm-draft-1"` row and asserts the read-side
  projection returns the empty shape.

This is recorded here so the future work has the migration
discipline pinned. Phase F does not perform the migration.

### 6.4 Storage / API impact (summary)

| Surface                                     | Phase F impact                                |
| ------------------------------------------- | --------------------------------------------- |
| `memories` table schema                     | **No change.** New keys live inside the existing `metadata` JSON blob. |
| `state` column                              | **No change.** All rows remain `active`.      |
| `remember(text)` write path                 | **No change** in Phase F.                     |
| `recall(text)` public API surface           | **No change.** Single `text` param, unchanged `RecallResult` key set. |
| `RecallOutcome` internal type               | **Add** a new `kind: "resolved-history"` to `AmbiguitySignal` (internal-only). |
| Public `message` wording                    | **Add** one new prefix line; bounded, no diagnostic leakage. |
| Public `answer` field                       | **No change.** Always the synthesized answer text. |
| `sourceIds` list                            | **No change.** Both ids stay listed.          |
| `.cortex/` directory layout                 | **No change.**                                |
| Provider HTTP / provider prompt             | **No change.** Detector is offline.           |

---

## 7. Examples and non-examples

All examples use the locked Render / Fly.io / Railway timeline
shape from the user brief. The Render → Fly.io transition is
the canonical example because the marker wording
(`replaced`) is explicit. The Railway non-example is canonical
because the wording is *implicit* (the row simply goes silent),
which is exactly the case the detector must not resolve.

### 7.1 Resolved supersession — explicit wording

Timeline (controller-normalized safe summaries):

```
id=1  tags=[hosting]
  summary: "We use Render for hosting. Fly.io replaced Render in 2024."

id=2  tags=[hosting]
  summary: "We use Fly.io for hosting the production app."
```

Query: *"Where is the app hosted?"*
Synthesized answer: *"Fly.io."*

Detector verdict:

- Row 1 carries the marker `replaced`. Row 2 carries no
  resolution marker.
- Pattern A (mutual) requires both sides. Row 2 lacks
  `current` / `replaced` / a `supersededBy` reference, so
  Pattern A fails.
- Pattern B (referential) requires row 2 to carry a
  `supersededBy: [1]` style reference. In the first version
  this block is not written, so Pattern B also fails.
- The detector must **not** resolve this pair. It returns
  `kind: "none"`. The public `message` is byte-equal to
  pre-Phase-D.

This is the current Phase D / Phase E behavior, and Phase F
preserves it. The first version is intentionally conservative:
a single `replaced` marker on the "leaving" side is **not**
enough on its own. A future revision may add a stronger
Pattern A that accepts a single asymmetric marker when the
answer text aligns with the "non-replaced" side, but that is
not Phase F.

### 7.2 Resolved supersession — both sides explicit

Timeline:

```
id=1  tags=[hosting]
  summary: "Render was the previous hosting platform. The current
            hosting platform is Fly.io."

id=2  tags=[hosting]
  summary: "Fly.io is the current hosting platform for production."
```

Query: *"Where is the app hosted?"*
Synthesized answer: *"Fly.io."*

Detector verdict:

- Row 1 carries `previous` and `current`. Row 2 carries
  `current`. Pattern A (mutual) holds: one side is
  `previous`, the other is `current`.
- Neither row carries a stored `conflictsWith` pointer.
- The synthesized answer matches the `current` side
  ("Fly.io" appears in the answer and in row 2).
- The detector returns
  `{ kind: "resolved-history", reason: "explicit-resolution",
     memoryIds: [1, 2], confidence: ≥ 0.80, asOf: <caller> }`.
- The public `message` is prefixed with the
  history-shaped note (e.g. "Note: a stored history row has
  been resolved."), followed by a blank line and the
  synthesized answer.
- The `answer` field is byte-equal to the synthesized answer.
- The `sourceIds` list is unchanged (both ids present).

### 7.3 Plain history — non-example (no markers, no companion)

Timeline:

```
id=1  tags=[hosting]
  summary: "We used Render in 2022. The team liked it."

id=2  tags=[hosting]
  summary: "We use Fly.io for production."
```

Query: *"Where is the app hosted?"*
Synthesized answer: *"Fly.io."*

Detector verdict:

- Row 1 carries no resolution marker. Row 2 carries no
  resolution marker. No explicit pairing. No stored pointer.
- The detector must **not** infer resolution from recency
  (locked decision §2.2). Row 1 is just "an older memory";
  it is not a "previous-state row" in the resolution sense.
- The detector returns `kind: "none"`. The public `message` is
  byte-equal to pre-Phase-D.

This is exactly the Phase E S6 case, and Phase F preserves
the S6 verdict (`gap` in the Phase E suite). The spec's job
is to define what would *upgrade* this case to a resolved
pair, and the answer is: explicit markers on both sides, or
a referential block on one side, with the answer text
matching the non-previous side. None of those are present
here, so the case stays `kind: "none"`.

### 7.4 Railway non-example — implicit silence

Timeline (Railway is a real provider; the wording is what
matters, not the vendor):

```
id=1  tags=[hosting]
  summary: "We use Railway for staging."

id=2  tags=[hosting, hosting-prod]
  summary: "Fly.io hosts the production app."
```

Query: *"What hosts production?"*
Synthesized answer: *"Fly.io."*

Detector verdict:

- Row 1 mentions Railway but does not say it was *replaced*,
  *previous*, *old*, *current*, *no longer*, or *superseded*.
- The detector has no evidence of resolution. It must stay
  silent. `kind: "none"`.
- Public `message` is byte-equal to pre-Phase-D.

The implication is important: a row that goes silent (no
follow-up "we replaced Railway with X") is *not* a resolved
history row. The system cannot infer a "previous" relationship
from absence. This is a deliberate design choice, and the
locked decision §2.2 makes it binding.

### 7.5 Unresolved conflict — non-resolution (Phase D wins)

Timeline:

```
id=1  tags=[db]
  summary: "Postgres is the primary store. We do not use MySQL."

id=2  tags=[db]
  summary: "MySQL is the primary store."
```

The two rows have a stored `conflictsWith` pointer (mutual),
which Phase D's Rule 1 catches. The detector must **not** also
emit a `resolved-history` note on the same pair; the Phase D
warning wins (see §4.2). Public `message` carries the existing
Phase D conflicting-candidates note; no
resolved-history prefix.

### 7.6 Older variant — non-resolution (Phase D wins)

Timeline (mirroring the Phase E S3 / S7 shape):

```
id=1  tags=[db]
  summary: "Project data is stored in Postgres on a single host."

id=2  tags=[db]
  summary: "Project data is stored in Postgres on multiple hosts."
```

The two rows carry a mutual `olderVariantsOf` pointer. Phase D's
Rule 2 catches this. The detector must not also emit a
resolved-history note. Public `message` carries the existing
Phase D older-variant note.

### 7.7 Summary of example outcomes

| # | Example                              | Detector verdict                | Public note           |
| - | ------------------------------------ | ------------------------------- | --------------------- |
| 7.1 | Render → Fly.io, marker on one side | `kind: "none"`                  | byte-equal pre-Phase-D |
| 7.2 | Both sides explicit                  | `kind: "resolved-history"`      | new history note      |
| 7.3 | No markers, companion present (S6)   | `kind: "none"`                  | byte-equal pre-Phase-D |
| 7.4 | Railway, no markers, no companion    | `kind: "none"`                  | byte-equal pre-Phase-D |
| 7.5 | Stored conflict pointer present      | `kind: "ambiguous"` (Phase D)   | unchanged Phase D note |
| 7.6 | Stored older-variant pointer present | `kind: "ambiguous"` (Phase D)   | unchanged Phase D note |

Only one of the seven cases (7.2) produces a new
public-message prefix. Everything else preserves the
Phase D behavior exactly. This is the smallest change that
satisfies the locked decisions.

---

## 8. Proposed follow-on phases after Phase F (keep separable)

The spec proposes a small, ordered sequence of follow-on
phases. Each phase is **separable**: any phase can be deferred,
rejected, or implemented independently without invalidating
the others. The order is conservative; later phases depend on
earlier ones only by name (the API surface and the schema
literal), not by code coupling.

### 8.1 Phase G — Validation cases first

Spec-only or spec + tests-only. Hand-curated validation
matrix extending the Phase E suite with cases for:

- Each row in §7.1–§7.6 above.
- The marker set in §5.1: each marker in isolation on the
  expected side, each marker mis-applied to the wrong side,
  markers split across two rows where the answer aligns with
  the "current" side, markers present but answer aligns with
  the "previous" side (must not resolve).
- A confidence-threshold sweep: pair the lowest-confidence
  inputs (just over 0.80) and the highest-confidence inputs
  (near 1.0) and assert the verdict is stable.
- A negative test: a pair with the marker set present but
  the candidate set also includes a third row that shares
  high lexical overlap — the detector must not invent a
  resolution against a third row.

The matrix drives a not-yet-written implementation, so this
phase is paired with the next one. Standalone, it pins the
contract.

### 8.2 Phase H — Pure helper / detector

Pure module, no I/O, no provider, no storage, no schema
change. Adds `detectResolvedHistory` to
`src/retrieval/ambiguity.ts` (or a sibling module) and a
`formatResolvedHistoryNote` helper. The detector is wired
into the recall controller's internal-only path, behind the
existing `internalAmbiguity` field on `RecallOutcome`. The
public `message` is **unchanged** in this phase — the
detector runs, but the new note is not yet prefixed. This
mirrors how Phase C ran `detectAmbiguity` internally before
Phase D prefixed the public message.

### 8.3 Phase I — Write / read metadata changes

Bumps `derivedSchemaVersion` to `"ccm-draft-2"`. Appends the
optional `supersedes` / `supersededBy` / `resolvedAt` keys
described in §6.2 to the `relationship` block on write.
Projects the new keys on read. Adds the migration test
described in §6.3. The Phase H detector starts using the new
keys as an additional evidence source (Pattern B in §5.2).
The public `message` is **still unchanged** in this phase
unless the user explicitly approves the prefix flip.

### 8.4 Phase J — Public note behavior

The first phase that changes the public `message` on a new
verdict. Wires `formatResolvedHistoryNote` into the
`src/tools/recall.ts` projection alongside the existing
`formatAmbiguityNote`. The note is bounded in length, the
id list is bounded, and the diagnostic-leakage list
enforced by Phase D is preserved verbatim. This is the only
phase that may regress the byte-equal-to-pre-Phase-D
property on the `answered` outcome — and only in the new
resolved-history case, not in any existing Phase D
branch. Behind the same approval gate as Phase D's prefix
flip.

**Phase J invariant (added by the
`experiment/public-message-hide-memory-ids` cleanup):**
the public `message` must **not** reintroduce `#N`
memory-id references into the public text. The
`memoryIds` array remains an internal field on the
`ResolvedHistorySignal` (and the `AmbiguitySignal`); the
public note is prose only. The `formatResolvedHistoryNote`
helper (added in Phase J) must apply the same
no-id-in-public-text contract `formatAmbiguityNote`
applies. The contract is regression-pinned in
`tests/public-message-no-ids.test.ts` and in
`tests/format-ambiguity-note.test.ts`.

### 8.5 What is explicitly NOT in any follow-on phase

- A state transition. None of Phase G–J transitions
  `state` to `superseded`. Older resolved memories stay
  `active` and retrievable (locked decision §2.3).
- A provider-side confirmation step. The detector is
  offline in all four phases.
- A change to the public `RecallResult` key set.
- A change to the public `status` enum.
- A change to `remember(text)`. The write path is
  unchanged in Phase I except for the append of new
  metadata keys.
- A benchmark re-run. The existing Phase E benchmark
  suite is the reference point; a Phase J follow-on
  benchmark re-run is a separate, optional, approval-
  gated step, mirroring the Phase E disposition.

### 8.6 Why the order matters

- **Phase G first** pins the contract before any code is
  written. The matrix in §7.1–§7.6 is the contract.
- **Phase H second** adds the pure detector. The detector
  can be reviewed and unit-tested in isolation; the public
  surface is unchanged.
- **Phase I third** adds the optional metadata keys. The
  bump to `"ccm-draft-2"` and the migration test protect
  old rows.
- **Phase J last** flips the public-message prefix. The
  byte-equal-to-pre-Phase-D invariant is preserved through
  Phase I and only relaxed in Phase J, behind an explicit
  approval gate.

The order is separable: a reviewer can approve Phases G and
H and reject I and J without invalidating the spec, or
approve G alone and ask for changes to H. The spec does
not require any of them.

---

## 9. Non-goals & approval gates

### 9.1 Non-goals (do not implement in Phase F or any of G–J)

- **No state transitions.** `state` stays `active` for every
  record. Older resolved memories stay retrievable.
- **No provider-driven relationship extraction.** The
  detector is offline in every follow-on phase.
- **No raw text storage.** The schema has no raw-text
  column and must keep that property.
- **No public API change.** The two public tools
  (`remember`, `recall`) keep their single `text`
  parameter; the public `RecallResult` key set is
  unchanged.
- **No new ambiguity reasons on the Phase D path.** Phase D
  keeps its two `reason` values verbatim.
- **No recency-based resolution.** Explicit markers only.
- **No new "winner picked" semantics.** The detector never
  picks a current truth; it only reports that an explicit
  resolution marker was found in the candidate set, in
  which case the synthesized answer is consistent with the
  non-previous side.
- **No benchmark re-run as part of any of G–J.** A
  benchmark re-run is a separate, optional,
  approval-gated step.
- **No migration of existing rows** beyond what is needed
  to add the optional metadata keys (Phase I, behind its
  own approval gate). Old `"ccm-draft-1"` rows project
  cleanly without migration.

### 9.2 Approval gates before Phase F implementation

Phase F is itself spec-only. No implementation work may begin
on the new detector or the new public-message prefix until
all of the following are explicitly approved by the user:

1. The locked decisions in §2 (especially "resolution
   requires explicit wording; recency is not sufficient").
2. The marker set in §5.1 (the closed set of six
   resolution markers).
3. The pairing rule in §5.2 (Patterns A and B).
4. The negative rules in §5.3 (no recency) and §5.4 (no
   provider inference in the first version).
5. The decision to **not** transition `state` in the first
   version (§6.1).
6. The future-compatible metadata shape in §6.2 (the new
   optional keys), even though Phase F does not write or
   read them — the spec records the migration discipline
   (§6.3) so a future bump is not a surprise.
7. The example matrix in §7, including the non-examples
   (Railway non-example in §7.4 is the canonical
   "must-not-resolve" case).
8. The follow-on phase ordering in §8, including the
   decision to keep the phases separable.

### 9.3 Approval gates before each follow-on phase

Each follow-on phase has its own approval gate:

- **Phase G** — approve the validation matrix.
- **Phase H** — approve the pure detector, the new
  internal `AmbiguitySignal` variant, and the
  byte-equal-to-pre-Phase-F public-message invariant.
- **Phase I** — approve the `derivedSchemaVersion` bump
  to `"ccm-draft-2"`, the new optional keys, the writer
  change, the read-side projection change, and the
  migration test.
- **Phase J** — approve the public-message prefix flip.
  This is the only phase that may regress the
  byte-equal-to-pre-Phase-F property on the `answered`
  outcome, and only in the new resolved-history case.

A reviewer may approve, defer, or reject any phase
independently.

---

## 10. Minimal docs update

The conservative spec status header in
`docs/conflict-currentness-metadata.md` and the architecture
contract in `docs/architecture.md` are the only two doc files
this spec touches.

### 10.1 `docs/architecture.md`

Add a single short paragraph under the v0.1 contracts
section (now titled "v0.1 contracts (frozen)"; previously
"Phase 1 contracts (frozen)"), immediately after the
existing Phase E paragraph, that links this spec as the
design proposal for the resolved-supersession / history
gap. The paragraph should:

- Link to this spec (`docs/resolved-history-semantics-phase-f.md`).
- State that Phase F is **spec-only** and adds no code, no
  schema change, no public API change, and no
  `state` transition.
- Note that the Phase E S6 "clarified supersession /
  history-shaped case" remains a `gap` verdict in the
  curated validation suite; the gap is not closed in
  Phase F.

No other change to `docs/architecture.md`. The frozen
v0.1 contracts (§"v0.1 contracts (frozen)" in
`docs/architecture.md`) are preserved verbatim.

### 10.2 `docs/conflict-currentness-metadata.md`

Add a one-line status entry in the existing status header
record:

```
- Phase F: `experiment/resolved-history-semantics-phase-f`
  — spec-only design for resolved supersession / history
  semantics. No code change. Defines a new
  `kind: "resolved-history"` `AmbiguitySignal` variant
  and a history-shaped public note that fires only on
  explicit resolution markers. Older resolved memories
  stay `active` and retrievable. The Phase E S6 gap is
  not closed in Phase F; this spec defines what *would*
  close it behind the follow-on phases G–J (§8 of the
  spec).
```

No other change to `docs/conflict-currentness-metadata.md`.
The §2 locked decisions, the §5.4 Phase D public-message
behaviour, the §6 metadata shape, the §7 state / lifecycle
policy, and the §10 follow-on phase list are all preserved
verbatim. Phase F sits beside them, not above them.

### 10.3 What is NOT changed in this commit

- No `src/` change.
- No `tests/` change.
- No `package.json` / `package-lock.json` / `tsconfig.json`
  / `.env*` change.
- No `.cortex/` change.
- No `.gitignore` change.
- No new directories.
- No new dependencies.
- No benchmark, calibration, or held-out-validation
  re-run.

The commit is a docs-only commit: two existing doc files
get a small, scoped addition, and one new spec doc is
added at the repo root of `docs/`.

---

## 11. Open questions for the user

These are explicit deferrals. The spec is internally consistent
without them, but the answers will sharpen the Phase H
implementation commit.

1. Should the marker set in §5.1 be expanded (e.g. add
   `legacy`, `migrated`, `since <year>`) before Phase H?
   The spec assumes the closed six-marker set.
2. Should Pattern A in §5.2 accept a single asymmetric
   marker (e.g. `replaced` on row 1, no marker on row 2)
   when the answer text aligns with row 2? The spec
   rejects this for the first version to stay conservative.
3. Should the new note wording mention which side is
   "current" and which is "previous" by name, or should
   it only mention the relevant memory ids and let the
   caller look them up? The spec assumes the latter (ids
   only), mirroring Phase D's note wording.
4. Is the public `message` change in Phase J acceptable as
   described in §8.4, or should the first public-message
   flip go through a separate, larger approval gate (e.g.
   a user-visible changelog entry)?

---

End of spec. Implementation is **not** authorised by this
commit. Phase F is design-only.
