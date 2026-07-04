# API reference

Curion exposes exactly two MCP tools. Each accepts a single `text` parameter
(string, required, non-empty). There are no kinds, states, filters,
providers, or other knobs on the public surface.

The public MCP API (the two tools, their strict input schemas, and the
public `text` / `structuredContent` surfaces) is stable and frozen.

## Inputs and outputs at a glance

| Tool       | Input  | Statuses on `structuredContent.status`              | Side effects |
|------------|--------|----------------------------------------------------|--------------|
| `remember` | `text` | `saved` \| `rejected` \| `provider_error`          | Writes a normalized memory row to `.curion/curion.sqlite`. |
| `recall`   | `text` | `answered` \| `weak_match` \| `no_memory` \| `rejected` \| `provider_error` | None on the store. May emit a row to `.curion/trace.sqlite` for the local trace layer. |

Both tools also return a calm-prose `text` content block alongside the
structured payload. The `text` is for human display; the
`structuredContent` is the contract that agents should switch on
(`status` is the discriminator).

---

## `remember(text: string)`

Store a piece of project memory.

**Pipeline:** local safety pre-check → provider adapter (analysis) →
controller validation → persistence.

**Side effects:** writes one normalized row to the local SQLite store
(`.curion/curion.sqlite`). **Raw input text is never persisted** —
only controller-normalized summaries and metadata (kind, confidence,
safety flags, timestamps).

**Statuses:** `saved` | `rejected` | `provider_error`

## `recall(text: string)`

Retrieve relevant project memory.

**Pipeline:** lexical retrieval (token-overlap) → ambiguity and
resolved-history detectors → synthesis. If semantic retrieval is
enabled (see [Configuration](configuration.md)), Curion additionally
runs dense-vector retrieval and fuses the rankings.

**Side effects:** none on the memory store. A row may be written to
`.curion/trace.sqlite` for the local trace layer (turn it off with
`CURION_TRACE_ENABLED=0`).

**Statuses:** `answered` | `weak_match` | `no_memory` | `rejected` |
`provider_error`

---

## Output shapes

Each tool returns:

- A `text` content block (human-readable prose).
- A `structuredContent` payload (clean discriminated shape).

Discriminate with `status` on `structuredContent`. The `text` block is
purely for display and may include context the agent does not need to
parse.

### `structuredContent` — `recall`

```typescript
// status: "answered"
// `source?: "local" | "cross_project"` is declared in
// RECALL_STRUCTURED_CONTENT_SCHEMA but is NOT currently populated
// by `buildRecallStructuredContent`. Treat it as a reserved
// field / known limitation until the projection carries it
// (see "Known limitations" below).
{ status: "answered", answer: string, notes?: string[] }

// status: "weak_match"
{ status: "weak_match", summaries: string[], coverage: { topScore: number, supportingCount: number }, clarification_needed?: Clarification }

// status: "no_memory"
{ status: "no_memory", clarification_needed?: Clarification }

// status: "rejected"
{ status: "rejected", reason: string, clarification_needed?: Clarification }

// status: "provider_error"
{ status: "provider_error", reason: string }
```

Field semantics:

- **`answer`** (answered): the synthesized prose answer. Display text.
- **`notes`** (answered, optional): an array of plain strings, one per
  auxiliary note. No `Note:` prefix, no note `type` / `severity`, no
  memory ids.
- **`source`** (answered, optional, **reserved — not yet populated
  on the wire**): declared in `RECALL_STRUCTURED_CONTENT_SCHEMA`
  as `"local"` when the answer came from the current project's own
  memory (the default) or `"cross_project"` when the answer was
  promoted from a non-private cross-project match. The current
  `buildRecallStructuredContent` helper does **not** populate
  this field, so it is absent from every wire payload today.
  Clients must not switch on `structuredContent.source`; see
  [Known limitations](#known-limitations).
- **`summaries`** (weak_match): up to three curator-voice summaries
  (plain strings, no memory-id reference).
- **`coverage`** (weak_match): `topScore` is the lexical score of the
  top-ranked candidate (a ranker-confidence proxy); `supportingCount`
  is the count of candidates that passed the ranker threshold (not
  capped by the top-3 slice).
- **`reason`** (rejected, provider_error): human-readable, non-echoing
  explanation.

### `structuredContent` — `remember`

```typescript
// status: "saved"
{ status: "saved", summary: string, kind: string, confidence?: number }

// status: "rejected"
{ status: "rejected", reason: string, clarification_needed?: Clarification }

// status: "provider_error"
{ status: "provider_error", reason: string }
```

Field semantics:

- **`summary`** (saved): the normalized curator-voice summary that was
  written to the store.
- **`kind`** (saved): the controller-assigned kind label.
- **`confidence`** (saved, optional): the controller's confidence score.
  Preserved because it is already user-visible (the remember tool's
  public text includes it).

### `clarification_needed`

```typescript
{ question: string, suggestions?: string[] }
```

`clarification_needed` is an **optional field**, never a status, and
never present on `provider_error`. It appears only on outcomes that
reflect user-intent uncertainty (`rejected`, `no_memory`, `weak_match`)
when the controller detected that a rephrase would resolve it.

When `clarification_needed` is present:

- **`question`** is required and is the user-facing prompt. The agent
  must ask the user this verbatim — do not paraphrase.
- **`suggestions`** is an optional list of rephrase hints. It is
  present only when useful, and is an aid, not an assumption.

The `reason` field on the parent object is the agent-facing explanation
for **why** `clarification_needed` is set. It is intentionally **not**
duplicated inside the clarification object.

---

## Contract guarantees

### Strict object schemas (no leakage)

Both `inputSchema` and `outputSchema` are strict Zod v3 object schemas.
The MCP SDK's input validation rejects any unknown top-level key
(`text` is the only acceptable input property); the SDK's output
validation rejects any unknown field on `structuredContent` (so an
internal field like `memoryId` or `sourceIds` would be caught if it
ever leaked into the payload).

### No internal IDs on the wire

No `memoryId`, `sourceIds`, `memoryIds`, or equivalent id-bearing
field appears on any `structuredContent` status variant. The
projection layer in `src/tools/recall-projection.ts` and
`src/tools/remember-projection.ts` strips ids before the payload is
handed to the MCP SDK. The weak-match `summaries` field is plain
curator-voice prose; it does not embed id references.

This means agents cannot (and should not try to) read or write
specific memory rows directly. The only public operations are
`remember(text)` and `recall(text)`.

### No raw input on the wire

Raw `text` input is never echoed on `structuredContent`. The
`reason` field on `rejected` and `provider_error` is a redacted,
non-echoing explanation — it never includes the user's query.

### No model / provider metadata

No `modelId`, `providerId`, `safetyClass`, or similar internal field
appears on the wire. The only model-visible state is what the agent
explicitly asked for.

### Notes are plain strings

`notes` and `summaries` are plain strings. There is no note `type` /
`severity`, no `Note:` prefix, and no note `id`. Notes and summaries
are display-only — the agent should not switch on their content.

---

## Status semantics

| Status           | Tools       | Meaning (what the agent should do) |
|------------------|-------------|-------------------------------------|
| `saved`          | `remember`  | A normalized row was persisted. The `summary` / `kind` reflect what was stored. |
| `answered`       | `recall`    | A synthesized answer was produced. Display the `answer`; optionally surface `notes`. Cross-project promotion is currently signaled only via the public-text prefix `Based on cross-project memory:` (followed by a `From other projects:` section); `structuredContent.source` is reserved but not populated on the wire yet — see [Known limitations](#known-limitations). |
| `weak_match`     | `recall`    | The lexical ranker surfaced relevant stored memories, but the synthesis LLM declined to produce a confident answer. Surface the `summaries`; if `clarification_needed` is present, ask the user the `question`. |
| `no_memory`      | `recall`    | Nothing relevant was found. If `clarification_needed` is present, ask the user the `question`; otherwise the agent may either rephrase and retry or tell the user it has no relevant memory. |
| `rejected`       | both        | The input was rejected (safety / low-confidence / self-conflict on `remember`; safety on `recall`). The `reason` is the agent-facing explanation; if `clarification_needed` is present, ask the user the `question`. |
| `provider_error` | both        | The provider call failed (network, auth, rate limit, malformed response). The `reason` is the agent-facing explanation. **Never** carries `clarification_needed`. The agent should treat this as a transient infrastructure error and may retry, surface the `reason`, or both. |

`clarification_needed` only ever appears on `rejected`, `no_memory`, and
`weak_match`. `provider_error` and `saved` / `answered` never carry it.

---

## Known limitations

This section calls out gaps between the **declared schema** and the
**actual wire shape** so clients do not pin behavior the projection
does not yet implement. None of these are bugs; they are forward-
declared fields the current `buildRecallStructuredContent` projection
has not yet been updated to carry. The on-the-wire contract is the
projection output today, and the schema will be aligned to it (or the
projection will be aligned to the schema) in a future pass — both
directions are tracked here as known limitations, not source behavior
changes.

- **`recall.answered.source` is reserved in the schema but not
  populated on the wire.** `RECALL_STRUCTURED_CONTENT_SCHEMA`
  declares `source?: "local" | "cross_project"` and the tool-layer
  `RecallResult` records it (`"local"` for answers drawn from the
  current project's own memory; `"cross_project"` for answers
  promoted from a non-private cross-project recall). However,
  `buildRecallStructuredContent` (`src/tools/recall-projection.ts`)
  does **not** copy `result.source` into the `structuredContent`
  payload today, so `source` is absent from every wire response.
  Clients must treat `structuredContent.source` as a reserved
  field and must not switch on it.

  As a temporary signal, cross-project promotion **is** visible to
  humans in the public `text` content block for the affected
  `answered` recall: when local recall returns `no_memory` and a
  cross-project match is strong enough to promote the status to
  `answered`, the public `text` is prefixed with the literal line
  `Based on cross-project memory:` and is followed by a `---
  From other projects:` section listing the contributing project
  summaries. Local-memory `answered` responses do **not** carry
  that prefix. This signal is human-facing (display text only);
  it is not a stable machine-readable discriminator and clients
  should not parse it.

  The intent is for `structuredContent.source` to be carried by
  the projection in a future alignment pass; until then, treat
  this entry as a known limitation / future-alignment note.

---

## Local trace layer (background)

Curion keeps a separate, local trace database (`.curion/trace.sqlite`)
that records a `run` + `input/output` event pair per public tool
invocation, plus internal retrieval diagnostics (lexical rankings,
selected candidates, superseded demotions). The trace is **on** by
default; set `CURION_TRACE_ENABLED=0` to turn it off. Trace payloads
are redacted: raw input and sensitive keys are stripped before write.
See [Privacy & storage](privacy-storage.md#local-trace) for the full
contract.

The trace is **not** part of the public MCP surface. It is internal to
Curion and is not surfaced to agents.