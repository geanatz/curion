/**
 * Semantic scoring utilities.
 *
 * Provides cosine similarity scoring for semantic retrieval.
 * All vectors are expected to be L2-normalized (from the embedder).
 * Cosine similarity = dot product of normalized vectors.
 */

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two L2-normalized vectors.
 * Returns a value in [-1, 1]. Higher is more similar.
 * Returns 0 if vectors have different dimensions.
 */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/**
 * Score candidates by cosine similarity against a query vector.
 * Returns scored candidates sorted by score descending, id descending.
 */
export function scoreSemanticCandidates(
  queryVec: ReadonlyArray<number>,
  candidates: ReadonlyArray<{ id: number; vec: ReadonlyArray<number> }>
): Array<{ id: number; score: number }> {
  const scored: Array<{ id: number; score: number }> = [];
  for (const c of candidates) {
    const score = cosineSimilarity(queryVec, c.vec);
    scored.push({ id: c.id, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });
  return scored;
}

// ---------------------------------------------------------------------------
// RRF fusion helper (replicated from hybrid.ts to keep production
// module self-contained; the benchmark hybrid.ts is benchmark-only)
// ---------------------------------------------------------------------------

const DEFAULT_RRF_K = 60;

/**
 * RRF contribution. Returns 0 if rank is null.
 */
export function rrfContribution(rank: number | null, weight: number, k: number): number {
  if (rank === null) return 0;
  if (!Number.isFinite(rank) || rank < 1) return 0;
  if (!Number.isFinite(weight) || weight < 0) return 0;
  if (!Number.isFinite(k) || k <= 0) return 0;
  if (weight === 0) return 0;
  return weight / (k + rank);
}

/**
 * Fuse lexical and semantic rankings using Reciprocal Rank Fusion.
 *
 * @param lexicalRanked - Lexical ranked list (score-desc, id-desc)
 * @param semanticRanked - Semantic ranked list (score-desc, id-desc)
 * @param weights - Per-signal weights (default 1.0 each)
 * @param k - RRF smoothing constant (default 60)
 * @param topK - Max results to return
 */
export function fuseLexicalAndSemantic(
  lexicalRanked: ReadonlyArray<{ id: number; score: number }>,
  semanticRanked: ReadonlyArray<{ id: number; score: number }>,
  weights: { lexical?: number; semantic?: number } = {},
  k: number = DEFAULT_RRF_K,
  topK = 5
): Array<{ id: number; score: number }> {
  const wLex = weights.lexical ?? 1;
  const wSem = weights.semantic ?? 1;

  // Build per-signal rank maps.
  const lexRankMap = new Map<number, { rank: number; score: number }>();
  for (let i = 0; i < lexicalRanked.length; i++) {
    const c = lexicalRanked[i]!;
    if (!lexRankMap.has(c.id)) {
      lexRankMap.set(c.id, { rank: i + 1, score: c.score });
    }
  }

  const semRankMap = new Map<number, { rank: number; score: number }>();
  for (let i = 0; i < semanticRanked.length; i++) {
    const c = semanticRanked[i]!;
    if (!semRankMap.has(c.id)) {
      semRankMap.set(c.id, { rank: i + 1, score: c.score });
    }
  }

  // Union of all candidate ids.
  const allIds = new Set<number>();
  for (const id of lexRankMap.keys()) allIds.add(id);
  for (const id of semRankMap.keys()) allIds.add(id);

  const fused: Array<{ id: number; score: number }> = [];
  for (const id of allIds) {
    const lexHit = lexRankMap.get(id);
    const semHit = semRankMap.get(id);

    const lexContrib = rrfContribution(lexHit?.rank ?? null, wLex, k);
    const semContrib = rrfContribution(semHit?.rank ?? null, wSem, k);
    const total = lexContrib + semContrib;

    // Only include candidates with at least one contribution.
    if (total > 0) {
      fused.push({ id, score: total });
    }
  }

  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.id - a.id;
  });

  return fused.slice(0, topK);
}
