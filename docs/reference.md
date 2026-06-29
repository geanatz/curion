# API reference

Curion exposes exactly two MCP tools. Each accepts a single `text` parameter
(string, required, non-empty). There are no kinds, states, filters,
providers, or other knobs on the public surface.

The public MCP API (the two tools, their strict input schemas, and the
public `text` / `structuredContent` surfaces) is stable and frozen.

## `remember(text: string)`

Store a piece of project memory.

Runs a local safety pre-check, the provider adapter for analysis,
controller validation, and persistence. **Raw input is never persisted** —
only controller-normalized summaries and metadata (kind, confidence, safety
flags, timestamps).

**Statuses:** `saved` | `rejected` | `provider_error`

## `recall(text: string)`

Retrieve relevant project memory.

Runs lexical retrieval over the local store, ambiguity and resolved-history
detectors, and synthesis. If semantic retrieval is enabled (see
[Configuration](configuration.md)), Curion additionally runs dense-vector
retrieval and fuses the rankings.

**Statuses:** `answered` | `weak_match` | `no_memory` | `rejected` |
`provider_error`

---

## Output shapes

Each tool returns a `text` content block (human-readable prose) and a
`structuredContent` payload (clean discriminated shape). Discriminate with
`status` on `structuredContent`.

### `structuredContent` — `recall`

```typescript
{ status: "answered",     answer: string, notes?: string }
{ status: "weak_match",   summaries: string[], coverage: { topScore: number, supportingCount: number }, clarification_needed?: ClarificationNeeded }
{ status: "no_memory",   clarification_needed?: ClarificationNeeded }
{ status: "rejected",     reason: string, clarification_needed?: ClarificationNeeded }
{ status: "provider_error", reason: string }
```

### `structuredContent` — `remember`

```typescript
{ status: "saved",              summary: string, kind: string, confidence?: number }
{ status: "rejected",           reason: string, clarification_needed?: ClarificationNeeded }
{ status: "provider_error",     reason: string }
```

### `clarification_needed`

When present on a user-intent-uncertainty status (`rejected`, `no_memory`,
`weak_match`), the agent must ask the user the `question` verbatim.
`suggestions` is an optional rephrase-hint list, present only when useful;
suggestions are aids, never assumptions. `provider_error` never carries
`clarification_needed`.

```typescript
{ question: string, suggestions?: string[] }
```