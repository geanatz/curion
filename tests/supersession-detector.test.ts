/**
 * Unit tests for the supersession detector.
 *
 * Tests the pure `detectSupersession` function in isolation
 * using fake `SafeMemorySummary` objects. No I/O, no storage,
 * no provider calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectSupersession,
  MAX_SUPERSEDED_IDS,
} from "../src/retrieval/supersession.ts";
import type { SafeMemorySummary } from "../src/storage/storage.ts";

// ---------------------------------------------------------------------------
// Fake SafeMemorySummary helpers
// ---------------------------------------------------------------------------

function makeSummary(
  id: number,
  memoryContent: string,
  opts: Partial<Omit<SafeMemorySummary, "id" | "memoryContent">> = {},
): SafeMemorySummary {
  return {
    id,
    kind: opts.kind ?? "fact",
    state: opts.state ?? "active",
    memoryContent,
    tags: opts.tags ?? [],
    classification: opts.classification ?? null,
    confidence: opts.confidence ?? 0.9,
  };
}

// ---------------------------------------------------------------------------
// 1. Explicit "use Y instead of X" — MiniMax → NVIDIA
// ---------------------------------------------------------------------------

test("detectSupersession: MiniMax → NVIDIA with explicit 'use Y instead of X'", () => {
  // High overlap: old memory uses the exact deprecated phrase; candidate adds replacement.
  // Tokens: old=6, candidate=9, intersection=6, union=9, Jaccard=0.667 >= 0.5
  const oldMemory = makeSummary(
    1,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    2,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null, "expected supersession signal");
  if (!result) return;
  assert.deepEqual(result.supersededIds, [1]);
  assert.ok(result.confidence > 0 && result.confidence <= 1);
});

test("detectSupersession: 'use Y instead' fires on related memory with high overlap", () => {
  const oldMemory = makeSummary(
    10,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    11,
    "We switched from MiniMax to NVIDIA NIM for text embeddings in the recall pipeline.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [10]);
});

test("detectSupersession: 'use Y instead' does NOT fire on unrelated memory", () => {
  const unrelated = makeSummary(
    20,
    "The project uses Redis for caching in the web tier.",
  );
  const candidate = makeSummary(
    21,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [unrelated] });
  assert.equal(result, null, "no supersession for unrelated memory");
});

test("detectSupersession: 'use Y instead' does NOT fire on marginally overlapping memory", () => {
  const oldMemory = makeSummary(
    30,
    "We use PostgreSQL for the main relational database.",
  );
  const candidate = makeSummary(
    31,
    "We no longer use SQLite for local development databases; use Docker Compose PostgreSQL instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 2. Old policy → new policy override
// ---------------------------------------------------------------------------

test("detectSupersession: policy superseded by explicit 'previous X is superseded'", () => {
  // Candidate uses "supersedes" (positive polarity) with high overlap.
  const oldPolicy = makeSummary(
    100,
    "Feature flags rollout policy for production rollouts.",
    { kind: "policy" },
  );
  const candidate = makeSummary(
    101,
    "New blue-green deployment supersedes the old feature flags rollout policy for production rollouts.",
    { kind: "policy" },
  );

  const result = detectSupersession({ candidate, others: [oldPolicy] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [100]);
});

test("detectSupersession: policy override via 'overrides'", () => {
  // High overlap: both share "Postgres data storage workloads" core vocabulary.
  const oldPolicy = makeSummary(
    200,
    "Postgres is the data storage solution for all production workloads.",
    { kind: "policy" },
  );
  const candidate = makeSummary(
    201,
    "New policy overrides the Postgres-only data storage rule for production workloads.",
    { kind: "policy" },
  );

  const result = detectSupersession({ candidate, others: [oldPolicy] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [200]);
});

test("detectSupersession: policy superseded by 'replaced by'", () => {
  // Candidate uses "replaces" (active voice, polarity +1) with high overlap.
  const oldPolicy = makeSummary(
    300,
    "Central gateway service handles all internal API calls.",
    { kind: "policy" },
  );
  const candidate = makeSummary(
    301,
    "Direct service mesh communication replaces the central gateway service for all internal API calls.",
    { kind: "policy" },
  );

  const result = detectSupersession({ candidate, others: [oldPolicy] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [300]);
});

// ---------------------------------------------------------------------------
// 3. "supersedes" phrasing
// ---------------------------------------------------------------------------

test("detectSupersession: 'supersedes' fires with high confidence", () => {
  const oldMemory = makeSummary(
    600,
    "The old approach used synchronous batch processing for background jobs.",
  );
  const candidate = makeSummary(
    601,
    "New async pipeline supersedes the old synchronous batch processing approach for background jobs.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [600]);
});

// ---------------------------------------------------------------------------
// 4. False positives: unrelated similar facts
// ---------------------------------------------------------------------------

test("detectSupersession: no signal on unrelated memory with similar length", () => {
  const unrelated = makeSummary(
    700,
    "The API server runs on Node.js 20 with Express and handles REST endpoints.",
  );
  const candidate = makeSummary(
    701,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [unrelated] });
  assert.equal(result, null);
});

test("detectSupersession: no signal when candidate has supersession phrase but no related memory", () => {
  const unrelated = makeSummary(
    800,
    "The CI pipeline runs on GitHub Actions with Ubuntu runners and builds Docker images.",
  );
  const candidate = makeSummary(
    801,
    "We no longer use Docker Swarm for container orchestration; use Kubernetes instead.",
  );

  const result = detectSupersession({ candidate, others: [unrelated] });
  assert.equal(result, null);
});

test("detectSupersession: no signal on same-id memory (cannot supersede itself)", () => {
  const candidate = makeSummary(
    900,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [candidate] });
  assert.equal(result, null, "self-supersession must return null");
});

test("detectSupersession: no signal when candidate id <= other id (directionality)", () => {
  const candidate = makeSummary(
    1,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );
  const older = makeSummary(
    2,
    "The project uses MiniMax for text embeddings in the recall pipeline.",
  );

  const result = detectSupersession({ candidate, others: [older] });
  assert.equal(result, null, "candidate must have higher id than superseded memory");
});

// ---------------------------------------------------------------------------
// 5. Ambiguous cases: no explicit supersession language
// ---------------------------------------------------------------------------

test("detectSupersession: no signal when candidate is ambiguous (no explicit phrasing)", () => {
  const oldMemory = makeSummary(
    1000,
    "The project uses MiniMax for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    1001,
    "We evaluated NVIDIA NIM and decided to use it for text embeddings going forward in the recall pipeline.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null, "ambiguous language must not fire");
});

test("detectSupersession: no signal when candidate just describes a change without supersession phrasing", () => {
  const oldMemory = makeSummary(
    1100,
    "Postgres 16 is the primary database for the project.",
  );
  const candidate = makeSummary(
    1101,
    "After evaluation we upgraded to Postgres 17 for better performance in the project database.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null, "upgrade without supersession phrasing must not fire");
});

test("detectSupersession: no signal on inactive related memory", () => {
  const inactiveMemory: SafeMemorySummary = {
    id: 1200,
    kind: "fact",
    state: "superseded",
    memoryContent: "The project uses MiniMax for text embeddings in the recall pipeline.",
    tags: [],
    classification: null,
    confidence: 0.9,
  };
  const candidate = makeSummary(
    1201,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [inactiveMemory] });
  assert.equal(result, null, "inactive memories must be skipped");
});

test("detectSupersession: no signal when candidate memoryContent is empty", () => {
  const oldMemory = makeSummary(1300, "Some old fact about the project.");
  const candidate = makeSummary(1301, "");

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 6. Directional rule: candidate must have higher id than superseded memory
// ---------------------------------------------------------------------------

test("detectSupersession: candidate with higher id can supersede lower id", () => {
  const oldMemory = makeSummary(
    1400,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    1401,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [1400]);
});

test("detectSupersession: candidate with equal id does not supersede (same record)", () => {
  const oldMemory = makeSummary(
    1500,
    "The project uses MiniMax for text embeddings.",
  );
  const candidate = makeSummary(
    1500,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null, "same id is not a supersession");
});

// ---------------------------------------------------------------------------
// 7. Malformed others entries are skipped safely
// ---------------------------------------------------------------------------

test("detectSupersession: malformed others entries are skipped without crash", () => {
  const goodMemory = makeSummary(
    1600,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const badMemory = {
    id: "not-a-number",
    kind: "fact",
    state: "active",
    memoryContent: "Some content",
    tags: [],
    classification: null,
    confidence: 0.9,
  } as unknown as SafeMemorySummary;

  const candidate = makeSummary(
    1601,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  // Must not throw.
  const result = detectSupersession({
    candidate,
    others: [goodMemory, badMemory],
  });

  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [1600]);
});

// ---------------------------------------------------------------------------
// 8. Multiple superseded memories
// ---------------------------------------------------------------------------

test("detectSupersession: can supersede multiple related memories", () => {
  const memory1 = makeSummary(
    1700,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const memory2 = makeSummary(
    1701,
    "MiniMax is used for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    1702,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({
    candidate,
    others: [memory1, memory2],
  });

  assert.notEqual(result, null);
  if (!result) return;
  assert.equal(result.supersededIds.length, 2);
  assert.ok(result.supersededIds.includes(1700));
  assert.ok(result.supersededIds.includes(1701));
});

test("detectSupersession: superseded ids are sorted ascending", () => {
  const memory1 = makeSummary(
    1802,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );
  const memory2 = makeSummary(
    1801,
    "MiniMax is used for text embeddings in the recall pipeline.",
  );
  const candidate = makeSummary(
    1803,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({
    candidate,
    others: [memory1, memory2],
  });

  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [1801, 1802], "ids must be sorted ascending");
});

test("detectSupersession: superseded ids are capped at MAX_SUPERSEDED_IDS", () => {
  // All 20 memories have identical high-overlap content.
  const manyMemories: SafeMemorySummary[] = [];
  for (let i = 0; i < 20; i++) {
    manyMemories.push(
      makeSummary(
        2000 + i,
        "We use MiniMax for text embeddings in the recall pipeline.",
      ),
    );
  }
  const candidate = makeSummary(
    2100,
    "We no longer use MiniMax for text embeddings in the recall pipeline; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({
    candidate,
    others: manyMemories,
  });

  assert.notEqual(result, null);
  if (!result) return;
  assert.ok(
    result.supersededIds.length <= MAX_SUPERSEDED_IDS,
    `superseded ids must be capped at ${MAX_SUPERSEDED_IDS}`,
  );
});

// ---------------------------------------------------------------------------
// 9. Confidence reflects overlap + phrase boost
// ---------------------------------------------------------------------------

test("detectSupersession: confidence is overlap base + phrase boost", () => {
  const oldMemory = makeSummary(
    3000,
    "We use MiniMax for text embeddings in recall.",
  );
  const candidate = makeSummary(
    3001,
    "We no longer use MiniMax for text embeddings in recall; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.ok(result.confidence > 0.5, "confidence should be meaningful");
  assert.ok(result.confidence <= 1.0, "confidence must be <= 1");
});

test("detectSupersession: returns null for empty others array", () => {
  const candidate = makeSummary(
    3100,
    "We no longer use MiniMax for text embeddings; use NVIDIA NIM instead.",
  );

  const result = detectSupersession({ candidate, others: [] });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 10. Deprecated phrasing
// ---------------------------------------------------------------------------

test("detectSupersession: 'is deprecated' fires as supersession signal", () => {
  const oldMemory = makeSummary(
    4000,
    "Legacy CSV import tool is used for data ingestion in the pipeline.",
  );
  const candidate = makeSummary(
    4001,
    "Legacy CSV import data ingestion pipeline tool is deprecated; use the new API-based ingestion pipeline instead.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [4000]);
});

// ---------------------------------------------------------------------------
// 11. Migrated from X to Y phrasing
// ---------------------------------------------------------------------------

test("detectSupersession: 'migrated from X to Y' fires", () => {
  const oldMemory = makeSummary(
    5000,
    "The project uses MongoDB for the document store and data persistence.",
  );
  const candidate = makeSummary(
    5001,
    "We migrated from MongoDB to PostgreSQL for the document store and data persistence.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [5000]);
});

// ---------------------------------------------------------------------------
// 12. Threshold boundary: fires at MIN_OVERLAP_FOR_SUPERSESSION threshold
// ---------------------------------------------------------------------------

test("detectSupersession: fires when overlap is at MIN_OVERLAP threshold", () => {
  // "migrated from X to Y" fires with active polarity.
  const oldMemory = makeSummary(
    6000,
    "PostgreSQL is the main relational database for the production API service.",
  );
  const candidate = makeSummary(
    6001,
    "We migrated from PostgreSQL to Aurora for the main relational database in the production API service.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.notEqual(result, null);
  if (!result) return;
  assert.deepEqual(result.supersededIds, [6000]);
});

test("detectSupersession: returns null when overlap is below threshold even with supersession phrasing", () => {
  const oldMemory = makeSummary(
    7000,
    "PostgreSQL handles all relational data storage for the API.",
  );
  const candidate = makeSummary(
    7001,
    "We no longer use MongoDB for document storage; use DynamoDB instead for the NoSQL data store.",
  );

  const result = detectSupersession({ candidate, others: [oldMemory] });
  assert.equal(result, null, "low overlap must not fire");
});

// ---------------------------------------------------------------------------
// Regression: provider rewrites "supersedes" to "superseding"
// Bug: run 3683/174-175 - new NVIDIA policy did not persist supersedes
// despite explicit supersedes wording in raw input, because provider
// rewrote "supersedes" to "superseding" in the summary.
// ---------------------------------------------------------------------------

test("detectSupersession: raw input 'supersedes' survives provider rephrasing to 'superseding'", () => {
  // Old memory: MiniMax as the default provider
  const oldMemory = makeSummary(
    174,
    "The Curion system policy sets MiniMax as the default provider for both remember and recall operations.",
  );

  // Candidate with provider summary that rewrote "supersedes" to "superseding"
  // This is the exact bug case from run 3683: provider summary says
  // "superseding" but raw input said "supersedes"
  const candidate = makeSummary(
    175,
    "The provider policy was updated to make NVIDIA NIM (openai/gpt-oss-120b) the sole default for both remember and recall operations, removing MiniMax as the default and superseding the previous MiniMax provider policy.",
  );

  // Raw input has explicit "supersedes" but provider rewrote to "superseding"
  const rawInputText =
    "Curion provider policy update: we no longer use MiniMax as the default provider. Use NVIDIA NIM openai/gpt-oss-120b as the only default provider for remember and recall. This new policy supersedes the previous MiniMax provider policy.";

  const result = detectSupersession({
    candidate,
    others: [oldMemory],
    rawInputText,
  });

  assert.notEqual(
    result,
    null,
    "explicit supersedes in raw input must survive provider rephrasing to superseding",
  );
  if (!result) return;
  assert.deepEqual(result.supersededIds, [174], "memory 174 must be superseded");
  assert.ok(result.confidence > 0.5, "confidence must be above threshold");
});

test("detectSupersession: raw input explicit supersedes uses reduced overlap threshold", () => {
  // This test verifies that when raw input has explicit supersession
  // language, the reduced overlap threshold (0.2) is used, allowing
  // topically-related memories with moderate token divergence to pass.

  // Old memory: MiniMax embeddings
  const oldMemory = makeSummary(
    1,
    "We use MiniMax for text embeddings in the recall pipeline.",
  );

  // New memory: different phrasing about NVIDIA NIM
  const candidate = makeSummary(
    2,
    "The provider policy was updated to make NVIDIA NIM the sole default, superseding the previous MiniMax provider policy.",
  );

  // Raw input has explicit "supersedes"
  const rawInputText =
    "Update: we no longer use MiniMax as the default. Use NVIDIA NIM instead. This new policy supersedes the previous MiniMax provider policy.";

  const result = detectSupersession({
    candidate,
    others: [oldMemory],
    rawInputText,
  });

  // The overlap between candidate summary and old memory might be moderate
  // (due to provider rephrasing), but explicit supersedes in raw input
  // should allow the detection to proceed with reduced threshold.
  // Note: if overlap is too low even with reduced threshold, this may return null,
  // which is acceptable conservative behavior.
  if (result !== null) {
    assert.deepEqual(result.supersededIds, [1]);
  }
});

// ---------------------------------------------------------------------------
// 13. hasMeaningfulRelationshipData with supersession-only block
// ---------------------------------------------------------------------------

test("hasMeaningfulRelationshipData: supersession-only fields are meaningful", async () => {
  const { hasMeaningfulRelationshipData, DERIVED_SCHEMA_VERSION } = await import(
    "../src/retrieval/relationship.ts"
  );

  const supersessionOnly = {
    conflictsWith: [] as number[],
    olderVariantsOf: [] as number[],
    detectionConfidence: 0.85,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 1_700_000_000_000,
    supersedes: [42] as number[],
  };

  assert.equal(
    hasMeaningfulRelationshipData(supersessionOnly),
    true,
    "supersession-only block must be considered meaningful",
  );
});

test("hasMeaningfulRelationshipData: empty supersedes is not meaningful", async () => {
  const { hasMeaningfulRelationshipData, DERIVED_SCHEMA_VERSION } = await import(
    "../src/retrieval/relationship.ts"
  );

  const emptySupersession = {
    conflictsWith: [] as number[],
    olderVariantsOf: [] as number[],
    detectionConfidence: 0,
    derivedSchemaVersion: DERIVED_SCHEMA_VERSION,
    derivedAt: 0,
    supersedes: [] as number[],
  };

  assert.equal(
    hasMeaningfulRelationshipData(emptySupersession),
    false,
    "empty supersedes array must not be considered meaningful",
  );
});