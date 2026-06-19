/**
 * Tests for the benchmark-only stemmed lexical variant.
 *
 * Coverage:
 *   1. tokenizeStemmed basic cases:
 *      - "USES" is lowercased and the length guard prevents
 *        the `s` suffix from being stripped.
 *      - "the" and "for" are stopwords and are dropped.
 *      - "16" is a pure-digit token and is dropped.
 *   2. Length guard: tokens shorter than 5 characters are
 *      NOT stemmed (e.g. "tree" stays as "tree", "uses"
 *      stays as "uses"). The spec pins the guard at 5.
 *   3. Stopword recheck after stemming:
 *      - "using" -> "us" is filtered because the result is
 *        too short to be a content token (length < 3).
 *      - "use" is in STOP_WORDS and is filtered even though
 *        it is not shortened by the stemmer.
 *   4. Stem first-match-wins behavior:
 *      - "stopped" -> "stopp" (the `ed` suffix matches
 *        before any shorter alternative would).
 *      - "friendly" -> "friend" (the `ly` suffix matches
 *        before any shorter alternative would).
 *   5. Smoke: a small ranker call returns the newer id for a
 *      known inflection query, demonstrating that the ranker
 *      end-to-end (tokenizeStemmed -> overlap score -> top-K)
 *      inherits the lexical ranker's stability contract.
 *
 * These tests are benchmark-only. They do NOT touch the
 * production `rankLexical` path, the public MCP surface, or
 * the project storage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenizeStemmed } from "../src/retrieval/lexical.ts";
import {
  rankLexicalStemmed,
  scoreStemmedCandidate,
  scoreStemmedCandidateDetailed,
} from "../src/benchmark/variants/lexical-stemmed.ts";

// ---------------------------------------------------------------------------
// 1. tokenizeStemmed basic cases
// ---------------------------------------------------------------------------

test("tokenizeStemmed: lowercases, drops stopwords and pure-digit tokens, and runs the length guard on 'uses'", () => {
  // The phrase is chosen so it exercises the same path the
  // existing `tokenize` test covers, plus a token that WOULD
  // be over-stemmed if the length guard were missing
  // ("cores" -> "core", which is correct; and the `uses`
  // check, which is correct because the length guard
  // prevents stripping the trailing `s`).
  const toks = tokenizeStemmed(
    "The project USES Postgres 16 cores for the testing",
  );
  // "USES" lowercased to "uses"; the length guard (4 < 5)
  // prevents the `s` suffix from being stripped.
  assert.ok(toks.includes("uses"), `'uses' should survive unchanged, got ${JSON.stringify(toks)}`);
  // "the" and "for" are in STOP_WORDS and are dropped.
  assert.ok(!toks.includes("the"));
  assert.ok(!toks.includes("for"));
  // "16" is a pure-digit token and is dropped.
  assert.ok(!toks.includes("16"));
  // "project" has no suffix match -> not stemmed.
  assert.ok(toks.includes("project"));
  // "postgres" ends with "s" and is long enough -> "postgre".
  assert.ok(toks.includes("postgre"), `'postgre' expected (postgres -> postgre), got ${JSON.stringify(toks)}`);
  // "cores" ends with "s" and is long enough -> "core".
  assert.ok(toks.includes("core"), `'core' expected (cores -> core), got ${JSON.stringify(toks)}`);
  // "testing" ends with "ing" and is long enough -> "test".
  assert.ok(toks.includes("test"), `'test' expected (testing -> test), got ${JSON.stringify(toks)}`);
});

// ---------------------------------------------------------------------------
// 2. Length guard: short tokens are not stemmed
// ---------------------------------------------------------------------------

test("tokenizeStemmed: length guard prevents stemming of short tokens", () => {
  // "tree" is 4 chars (< 5), so the length guard prevents
  // any suffix strip. "tree" is not a stopword, so it
  // survives unchanged.
  const toks1 = tokenizeStemmed("tree");
  assert.deepEqual(toks1, ["tree"]);

  // "uses" is 4 chars (< 5), so the length guard prevents
  // stripping the trailing `s`. The test from the spec
  // description ("'go' stays") uses "go" as an illustrative
  // example; "go" is dropped by the underlying tokenize
  // step (length < 3) so it never reaches the stemmer. We
  // assert both that "go" is NOT in the output and that a
  // 4-char non-stopword word IS in the output unchanged.
  const toks2 = tokenizeStemmed("go uses");
  assert.ok(!toks2.includes("go"), `"go" is dropped by the underlying tokenize (length < 3), got ${JSON.stringify(toks2)}`);
  assert.ok(toks2.includes("uses"), `"uses" must survive the length guard, got ${JSON.stringify(toks2)}`);

  // "house" is 5 chars (>= 5) and ends with "e" which is
  // NOT in the suffix list, so "house" is NOT stemmed.
  const toks3 = tokenizeStemmed("house");
  assert.deepEqual(toks3, ["house"]);

  // "running" is 7 chars (>= 5) and ends with "ing" -> "runn".
  // "runn" is not a stopword and length >= 3, so it survives.
  const toks4 = tokenizeStemmed("running");
  assert.deepEqual(toks4, ["runn"]);
});

// ---------------------------------------------------------------------------
// 3. Stopword recheck after stemming
// ---------------------------------------------------------------------------

test("tokenizeStemmed: stopword recheck drops 'us' (from 'using') and 'use' (stopword)", () => {
  // "using" -> "us" via the `ing` suffix. "us" is 2 chars,
  // which is below the content-token floor (3), so it is
  // filtered. This is the test described as "'using' -> 'us'
  // filtered as not a content token".
  const toks1 = tokenizeStemmed("using");
  assert.deepEqual(toks1, []);

  // "use" survives the underlying tokenize but is in
  // STOP_WORDS, so it is dropped. The stemmer does not
  // shorten "use" (length 3 < 5), but the stopword recheck
  // catches it.
  const toks2 = tokenizeStemmed("use");
  assert.deepEqual(toks2, []);

  // "use the using" -> everything is dropped.
  const toks3 = tokenizeStemmed("use the using");
  assert.deepEqual(toks3, []);
});

// ---------------------------------------------------------------------------
// 4. Stem first-match-wins behavior
// ---------------------------------------------------------------------------

test("tokenizeStemmed: first-match-wins for the suffix alternation", () => {
  // "stopped" ends with "ed" (not "ing"), so the regex
  // strips "ed" and leaves "stopp". "stopp" is not a
  // stopword and length >= 3, so it survives.
  const toks1 = tokenizeStemmed("stopped");
  assert.deepEqual(toks1, ["stopp"]);

  // "friendly" ends with "ly" (not "ed", "ing", or "s"),
  // so the regex strips "ly" and leaves "friend".
  const toks2 = tokenizeStemmed("friendly");
  assert.deepEqual(toks2, ["friend"]);

  // "applied" ends with "ied" (the "ied" alternative is
  // listed in the regex; "plied" is not a stem). "applied"
  // -> "appl". The alternation order ensures the longest
  // matching suffix wins.
  const toks3 = tokenizeStemmed("applied");
  assert.deepEqual(toks3, ["appl"]);

  // "bigger" does not end with any of the listed suffixes,
  // so it is NOT stemmed. This is a deliberate non-result:
  // the spec's suffix list is intentionally narrow.
  const toks4 = tokenizeStemmed("bigger");
  assert.deepEqual(toks4, ["bigger"]);
});

// ---------------------------------------------------------------------------
// 5. Smoke: ranker end-to-end with a known inflection query
// ---------------------------------------------------------------------------

test("rankLexicalStemmed: returns the newer id for a known inflection query", () => {
  // Query uses the inflected form "friendly"; candidate 1
  // uses the base form "friend" (only). Without stemming
  // the overlap is 0; with stemming the overlap is 1/1.
  // The candidate is newer (id=2) so the ranker must
  // return it.
  const r = rankLexicalStemmed("friendly", [
    { id: 1, text: "the project is hostile" },
    { id: 2, text: "we have a friend on the team" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, 2);
  // Score is 1/1 = 1.0 (full coverage after stemming).
  assert.equal(r[0]!.score, 1);
});

test("rankLexicalStemmed: ties on score are broken by descending id (newer memory wins)", () => {
  // Two candidates with the same stemmed tokens. The score
  // is identical (1/1 = 1.0 for the query "friend" against
  // either candidate). The tie-break must put the newer id
  // (2) first.
  const r = rankLexicalStemmed("friend", [
    { id: 1, text: "we have a friend on the team" },
    { id: 2, text: "we have a friend on the team" },
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual(
    r.map((x) => x.id),
    [2, 1],
  );
});

test("rankLexicalStemmed: returns an empty array for a query that stems to nothing", () => {
  // "the and for" stems to [] (all stopwords).
  const r = rankLexicalStemmed("the and for", [
    { id: 1, text: "postgres storage" },
  ]);
  assert.deepEqual(r, []);
});

test("rankLexicalStemmed: respects the topK option", () => {
  const candidates = [
    { id: 1, text: "we have a friend on the team" },
    { id: 2, text: "a friend helped us" },
    { id: 3, text: "the friend is here" },
  ];
  const r = rankLexicalStemmed("friend", candidates, { topK: 2 });
  assert.equal(r.length, 2);
});

test("rankLexicalStemmed: respects the threshold option", () => {
  // Query has 2 stems ("friend", "team"); candidate shares
  // 1 ("friend"). Score = 1/2 = 0.5. A threshold of 0.9
  // filters this candidate out.
  const r = rankLexicalStemmed(
    "friendly team",
    [{ id: 1, text: "we have a friend on the project" }],
    { threshold: 0.9 },
  );
  assert.deepEqual(r, []);
});

test("scoreStemmedCandidate: returns 0 for no overlap after stemming", () => {
  // "friendly" stems to ["friend"]; "hostile" does NOT
  // stem to "friend", so the overlap is 0.
  const s = scoreStemmedCandidate("friendly", "the cat is hostile");
  assert.equal(s, 0);
});

test("scoreStemmedCandidateDetailed: returns the overlap count alongside the score", () => {
  // "friendly dogs" -> ["friend", "dogs"] ("dogs" has
  // length 4 < 5, so the length guard prevents stripping
  // the trailing "s").
  // "we have a friend and dogs here" -> ["friend", "dogs",
  // "here"] ("have", "and" are stopwords; "we", "a" are
  // dropped by length).
  // Overlap: 2/2 ("friend" and "dogs" both match). Score:
  // 1.0.
  const d = scoreStemmedCandidateDetailed(
    "friendly dogs",
    "we have a friend and dogs here",
  );
  assert.equal(d.overlap, 2);
  assert.equal(d.score, 1);
});
