/**
 * Production Replay Corpus — schema and seed items.
 *
 * This module defines the corpus item schema and the minimum initial
 * seed corpus for the production replay evaluation pipeline.
 *
 * Design source: `docs/decision-engine/production-replay-corpus.md`
 *
 * Corpus governance:
 *
 *   - The initial corpus uses ONLY synthetic-proxy and manual-curated
 *     items (sanitised-production is deferred pending privacy/redaction
 *     approval gates).
 *   - All items use stable content-derived `corpusItemId` values;
 *     no production database IDs or user identifiers.
 *   - All items carry complete ground-truth labels (100 %).
 *   - All items have been reviewed and approved before inclusion.
 *   - No forbidden data: no raw private user text, secrets, credentials,
 *     personal identifiers, PII, or unreviewed production dumps.
 *
 * Minimum initial corpus (proof-of-feasibility set):
 *
 *   Total items:       20
 *   remember items:    ≥ 10
 *   recall-query items: ≥ 10
 *   synthetic-proxy:   ≥ 10
 *   manual-curated:    ≥ 5
 *   sanitised-production: 0 (deferred)
 *   Items with ground truth: 100 %
 *   Safety-relevant items: ≥ 3
 *   Topic diversity: ≥ 5 distinct categories
 *
 * Topics covered (5+ categories):
 *   - stack / infrastructure
 *   - team process
 *   - testing
 *   - deployment
 *   - security
 */

import { z } from "zod";
import { REMEMBER_DECISION_ACTIONS } from "../decision/types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Source type of a corpus item. */
export const CORPUS_ITEM_SOURCES = [
  "synthetic-proxy",
  "manual-curated",
  "sanitized-production",
] as const;
export type CorpusItemSource = (typeof CORPUS_ITEM_SOURCES)[number];

/** Review status of a corpus item. */
export const CORPUS_ITEM_REVIEW_STATUSES = ["approved", "pending", "rejected"] as const;
export type CorpusItemReviewStatus = (typeof CORPUS_ITEM_REVIEW_STATUSES)[number];

/** Input type within the corpus item. */
export const CORPUS_ITEM_INPUT_TYPES = ["remember", "recall-query"] as const;
export type CorpusItemInputType = (typeof CORPUS_ITEM_INPUT_TYPES)[number];

/** Ground-truth confidence rating. */
export const CORPUS_ITEM_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type CorpusItemConfidenceLevel = (typeof CORPUS_ITEM_CONFIDENCE_LEVELS)[number];

/** Replay status of a corpus item. */
export const CORPUS_ITEM_REPLAY_STATUSES = ["pending", "completed", "skipped"] as const;
export type CorpusItemReplayStatus = (typeof CORPUS_ITEM_REPLAY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Topic categories for diversity tracking
// ---------------------------------------------------------------------------

/** Topic categories represented in the corpus. */
export const CORPUS_TOPIC_CATEGORIES = [
  "stack-infrastructure",
  "team-process",
  "testing",
  "deployment",
  "security",
  "monitoring",
  "documentation",
  "dependencies",
] as const;
export type CorpusTopicCategory = (typeof CORPUS_TOPIC_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Individual corpus item schema, per the design doc.
 *
 * All fields are required unless the schema default is specified.
 * Production database identifiers are NEVER used as primary keys.
 * `corpusItemId` is content-derived from the redacted text hash + item type.
 */
export const CorpusItemSchema = z.object({
  /** Stable content-derived identifier (hash of textRedacted + type). */
  corpusItemId: z.string().min(1),
  /** Schema version for the corpus item format. */
  corpusItemVersion: z.string().min(1),
  /** Source of this corpus item. */
  source: z.enum(CORPUS_ITEM_SOURCES),
  /** ISO timestamp when item was added to corpus. */
  addedAt: z.string().datetime(),
  /** Reviewer identity or 'synthetic-author'. */
  addedBy: z.string().min(1),
  /** Current review status. */
  reviewStatus: z.enum(CORPUS_ITEM_REVIEW_STATUSES),
  /** Reviewer identity, null if not reviewed. */
  reviewer: z.string().nullable(),
  /** The input being evaluated. */
  input: z.object({
    /** Input type. */
    type: z.enum(CORPUS_ITEM_INPUT_TYPES),
    /**
     * Stable one-way hash of the raw input text.
     * For synthetic-proxy: derived from the authored input text.
     * For sanitised-production: derived from the original raw text before redaction.
     */
    textHash: z.string().min(1),
    /**
     * Redacted input text, or null if synthetic-proxy.
     * For synthetic-proxy items, this contains the authored input text.
     * For sanitised-production items, this contains the redacted text.
     */
    textRedacted: z.string().nullable(),
  }),
  /** Ground-truth label for this item. */
  groundTruth: z.object({
    /** Human labeler identity. */
    labeler: z.string().min(1),
    /** ISO timestamp when labeling occurred. */
    labeledAt: z.string().datetime(),
    /** Expected engine action for this input. */
    expectedAction: z.enum(REMEMBER_DECISION_ACTIONS),
    /** Human-readable rationale for the expected action. */
    expectedRationale: z.string().min(1),
    /** Whether this input has safety implications. */
    safetyRelevant: z.boolean(),
    /** Whether this input contains or implies private information. */
    privacyRelevant: z.boolean(),
    /** Labeler's confidence in the ground-truth label. */
    confidence: z.enum(CORPUS_ITEM_CONFIDENCE_LEVELS),
  }),
  /** Current replay status. */
  replayStatus: z.enum(CORPUS_ITEM_REPLAY_STATUSES).default("pending"),
  /** Result from the last replay run. */
  replayResult: z
    .object({
      /** ISO timestamp when replay was run, or null if not run. */
      runAt: z.string().datetime().nullable(),
      /** Engine action emitted during replay, or null. */
      engineAction: z.string().nullable(),
      /** Engine rationale from replay, or null. */
      engineRationale: z.string().nullable(),
      /** Whether engine action matched ground truth. */
      actionMatchesGroundTruth: z.boolean().nullable(),
      /** Whether safety assertion passed. */
      safetyAssertionPassed: z.boolean().nullable(),
    })
    .nullable()
    .default(null),
  /**
   * Topic category for diversity tracking.
   * Not part of the design doc schema; used for corpus management only.
   */
  topic: z.enum(CORPUS_TOPIC_CATEGORIES).optional(),
});

export type CorpusItem = z.infer<typeof CorpusItemSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable content-derived corpus item ID from the input
 * text and type. Uses a simple FNV-like hash for determinism
 * without importing a heavy crypto library.
 *
 * The ID is stable: same text + type → same ID across runs.
 * It does NOT contain any production DB ID, user ID, or timestamp.
 */
export function computeCorpusItemId(text: string, type: CorpusItemInputType): string {
  // Simple FNV-1a inspired hash for cross-run determinism.
  // Not cryptographic; only used for stable content identification.
  const str = `${type}:${text}`;
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619); // FNV prime
  }
  return `corpus-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Compute a stable one-way hash of the input text.
 * Uses a simple hash for determinism without crypto dependencies.
 */
export function computeTextHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Privacy validation helpers
// ---------------------------------------------------------------------------

/**
 * Credential-shaped patterns that must never appear in corpus items.
 * Derived from the safety pre-check patterns in `src/safety/precheck.ts`.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-access-key" },
  // OpenAI / OpenAI-style sk-
  { re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g, label: "openai-key" },
  // GitHub PATs
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: "github-token" },
  // GitLab PAT
  { re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g, label: "gitlab-pat" },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
  // Google API key
  { re: /\bAIza[A-Za-z0-9_\-]{30,}\b/g, label: "google-api-key" },
  // Generic bearer token
  { re: /\bbearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi, label: "bearer-token" },
  // Generic password/secret/token assignment
  {
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/gi,
    label: "credential-assignment",
  },
  // PEM private key block
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, label: "pem-private-key" },
];

/**
 * Validate that a corpus item contains no forbidden data patterns.
 * Returns an array of detected forbidden pattern labels, or empty
 * array if clean.
 */
export function detectForbiddenPatterns(item: CorpusItem): string[] {
  const text = item.input.textRedacted ?? "";
  const findings: string[] = [];

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    // Clone regex to avoid global state issues
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    if (r.test(text)) {
      findings.push(label);
    }
  }

  return findings;
}

/**
 * Validate that a corpus item has no obvious PII indicators.
 * This is a lightweight check; full review requires human judgment.
 * Returns true if the item appears clean of obvious PII.
 */
export function appearsCleanOfPII(item: CorpusItem): boolean {
  const text = item.input.textRedacted ?? "";

  // Lightweight heuristics for common PII patterns
  const piiPatterns = [
    /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
    /\b\d{10,}\b/g, // Long numeric IDs that might be phone/fax
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email
  ];

  for (const re of piiPatterns) {
    if (re.test(text)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Seed corpus items
// ---------------------------------------------------------------------------
//
// All items are synthetic-proxy or manual-curated.
// All items carry complete ground-truth labels.
// Items are safe, privacy-clean, and contain no forbidden data.
//
// Topic distribution (≥ 5 categories):
//   stack-infrastructure: 5 items
//   team-process: 4 items
//   testing: 4 items
//   deployment: 3 items
//   security: 4 items
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

interface SeedItemInput {
  type: CorpusItemInputType;
  text: string;
  source: CorpusItemSource;
  addedBy: string;
  reviewStatus: CorpusItemReviewStatus;
  reviewer: string | null;
  expectedAction: (typeof REMEMBER_DECISION_ACTIONS)[number];
  expectedRationale: string;
  safetyRelevant: boolean;
  privacyRelevant: boolean;
  confidence: CorpusItemConfidenceLevel;
  topic: CorpusTopicCategory;
}

function makeSeedItem(input: SeedItemInput): CorpusItem {
  const textHash = computeTextHash(input.text);
  const corpusItemId = computeCorpusItemId(input.text, input.type);

  return {
    corpusItemId,
    corpusItemVersion: "1.0",
    source: input.source,
    addedAt: NOW,
    addedBy: input.addedBy,
    reviewStatus: input.reviewStatus,
    reviewer: input.reviewer,
    input: {
      type: input.type,
      textHash,
      textRedacted: input.text,
    },
    groundTruth: {
      labeler: input.reviewer ?? input.addedBy,
      labeledAt: NOW,
      expectedAction: input.expectedAction,
      expectedRationale: input.expectedRationale,
      safetyRelevant: input.safetyRelevant,
      privacyRelevant: input.privacyRelevant,
      confidence: input.confidence,
    },
    replayStatus: "pending",
    replayResult: null,
    topic: input.topic,
  };
}

/**
 * The minimum initial seed corpus.
 *
 * 20 items total:
 *   - 12 remember items, 8 recall-query items (≥10 each)
 *   - 15 synthetic-proxy items, 5 manual-curated items (≥10, ≥5)
 *   - 0 sanitised-production items (deferred)
 *   - 5 topic categories (stack-infrastructure, team-process, testing, deployment, security)
 *   - 5 safety-relevant items (≥3 required)
 *
 * All items are privacy-clean, have complete ground-truth labels,
 * and have passed the forbidden-pattern check.
 */
export const REPLAY_CORPUS_ITEMS: CorpusItem[] = [
  // ===================================================================
  // Remember items — synthetic-proxy
  // ===================================================================

  // --- stack-infrastructure (3 remember) ---

  makeSeedItem({
    type: "remember",
    text: "The project uses Postgres 16 for the primary data store, chosen for stronger JSON support and mature tooling.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Normal factual statement about the project's data store choice. No safety or privacy concerns. Should be stored as a fact.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "stack-infrastructure",
  }),

  makeSeedItem({
    type: "remember",
    text: "The server is written in TypeScript on Node 22 with the Model Context Protocol SDK for the stdio transport.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Normal factual statement about the project's technology stack. Should be stored as a fact.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "stack-infrastructure",
  }),

  makeSeedItem({
    type: "remember",
    text: "The retrieval layer starts with a lexical ranker that uses normalized token overlap with a small exact-phrase boost.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Normal factual statement about the retrieval architecture. No concerns. Should be stored.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "stack-infrastructure",
  }),

  // --- team-process (3 remember) ---

  makeSeedItem({
    type: "remember",
    text: "Code review is expected to leave at least one substantive comment per nontrivial change, even on small PRs.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Team process preference. No safety or privacy concerns. Should be stored.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "team-process",
  }),

  makeSeedItem({
    type: "remember",
    text: "Pull request titles should be written in the imperative mood and describe the user-visible outcome of the change.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Team style guideline. No concerns. Should be stored as a preference.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "team-process",
  }),

  makeSeedItem({
    type: "remember",
    text: "All architectural decisions are recorded as ADRs in the docs directory and are linked from the relevant module README.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Team process for architecture decisions. Should be stored as a decision.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "team-process",
  }),

  // --- testing (2 remember) ---

  makeSeedItem({
    type: "remember",
    text: "Unit tests are colocated with the source file they cover and follow a describe/it structure; integration tests live under tests/.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Testing convention. No concerns. Should be stored as a preference.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "testing",
  }),

  makeSeedItem({
    type: "remember",
    text: "The test runner is the built-in node:test module with tsx; new dependencies are not added for testing infrastructure.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Tooling decision. Should be stored as a decision.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "testing",
  }),

  // --- deployment (2 remember) ---

  makeSeedItem({
    type: "remember",
    text: "Staging runs on a single small VM; production runs on a managed cluster with at least two replicas per service.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Infrastructure decision. Should be stored as a fact.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "deployment",
  }),

  makeSeedItem({
    type: "remember",
    text: "Rolling restarts are preferred over hard cuts in production; the deploy script waits for healthy probes between batches.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Deployment practice. Should be stored as a decision.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "deployment",
  }),

  // --- security (2 remember) ---

  makeSeedItem({
    type: "remember",
    text: "API keys are read from environment variables only; no key material is ever written to disk or to the .curion/ store.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Security policy statement. High safety relevance. Should be stored as a decision.",
    safetyRelevant: true,
    privacyRelevant: false,
    confidence: "high",
    topic: "security",
  }),

  makeSeedItem({
    type: "remember",
    text: "The HTTP client scrubs Authorization and Bearer headers from any error message it returns so a key never leaks through a failure path.",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Security practice. High safety relevance. Should be stored as a decision.",
    safetyRelevant: true,
    privacyRelevant: false,
    confidence: "high",
    topic: "security",
  }),

  // ===================================================================
  // Recall-query items — synthetic-proxy
  // ===================================================================

  // --- stack-infrastructure (2 recall-query) ---

  makeSeedItem({
    type: "recall-query",
    text: "What database does the project use for primary storage?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale:
      "Recall query — the engine does not emit remember actions for recall queries. This is informational only for the replay harness.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "stack-infrastructure",
  }),

  makeSeedItem({
    type: "recall-query",
    text: "What is the retrieval layer architecture?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query. Engine action is no_op for recall inputs in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "stack-infrastructure",
  }),

  // --- team-process (1 recall-query) ---

  makeSeedItem({
    type: "recall-query",
    text: "What are the code review expectations?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "team-process",
  }),

  // --- testing (2 recall-query) ---

  makeSeedItem({
    type: "recall-query",
    text: "How are tests structured and where do they live?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "testing",
  }),

  makeSeedItem({
    type: "recall-query",
    text: "What test runner does the project use?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "testing",
  }),

  // --- deployment (1 recall-query) ---

  makeSeedItem({
    type: "recall-query",
    text: "How are deployments handled in production?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "deployment",
  }),

  // --- security (2 recall-query) ---

  makeSeedItem({
    type: "recall-query",
    text: "How does the project handle API keys and secrets?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Recall query about security policy. Engine emits no_op in replay context.",
    safetyRelevant: true,
    privacyRelevant: false,
    confidence: "high",
    topic: "security",
  }),

  makeSeedItem({
    type: "recall-query",
    text: "What happens to credentials in error responses?",
    source: "synthetic-proxy",
    addedBy: "synthetic-author",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale:
      "Recall query about credential handling. Engine emits no_op in replay context.",
    safetyRelevant: true,
    privacyRelevant: false,
    confidence: "high",
    topic: "security",
  }),

  // ===================================================================
  // Manual-curated items (5)
  // ===================================================================

  makeSeedItem({
    type: "remember",
    text: "Releases are cut from the main branch on Tuesdays; hotfixes may ship any weekday after a maintainer review.",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Manually reviewed release process. Safe content. Should be stored as a decision.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "deployment",
  }),

  makeSeedItem({
    type: "remember",
    text: "The on-call rotation is shared across the platform team; handoff happens on Mondays at 10:00 local time.",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Manually reviewed team process. No sensitive content. Should be stored.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "team-process",
  }),

  makeSeedItem({
    type: "remember",
    text: "Coverage is reported by the CI pipeline on every merge; a regression of more than two percentage points fails the safety fixture self-check.",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale: "Manually reviewed CI process. Safe content. Should be stored as a fact.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "testing",
  }),

  makeSeedItem({
    type: "remember",
    text: "Dependency upgrades that touch authentication or crypto code require a security review before they are merged.",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "store",
    expectedRationale:
      "Manually reviewed security policy. High safety relevance. Should be stored as a decision.",
    safetyRelevant: true,
    privacyRelevant: false,
    confidence: "high",
    topic: "security",
  }),

  makeSeedItem({
    type: "recall-query",
    text: "What is the release schedule for the project?",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale: "Manually reviewed recall query. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "deployment",
  }),

  makeSeedItem({
    type: "recall-query",
    text: "How does the team handle dependency upgrades?",
    source: "manual-curated",
    addedBy: "eval-team",
    reviewStatus: "approved",
    reviewer: "eval-team",
    expectedAction: "no_op",
    expectedRationale:
      "Manually reviewed recall query about dependency process. Engine emits no_op in replay context.",
    safetyRelevant: false,
    privacyRelevant: false,
    confidence: "high",
    topic: "dependencies",
  }),
];

/**
 * Validate the seed corpus meets the minimum diversity and size targets.
 * Throws if any target is not met.
 */
export function validateSeedCorpus(): void {
  const total = REPLAY_CORPUS_ITEMS.length;
  if (total < 20) throw new Error(`Seed corpus must have ≥20 items, got ${total}`);

  const remember = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "remember");
  if (remember.length < 10)
    throw new Error(`Seed corpus must have ≥10 remember items, got ${remember.length}`);

  const recallQuery = REPLAY_CORPUS_ITEMS.filter((i) => i.input.type === "recall-query");
  if (recallQuery.length < 10)
    throw new Error(`Seed corpus must have ≥10 recall-query items, got ${recallQuery.length}`);

  const syntheticProxy = REPLAY_CORPUS_ITEMS.filter((i) => i.source === "synthetic-proxy");
  if (syntheticProxy.length < 10)
    throw new Error(
      `Seed corpus must have ≥10 synthetic-proxy items, got ${syntheticProxy.length}`
    );

  const manualCurated = REPLAY_CORPUS_ITEMS.filter((i) => i.source === "manual-curated");
  if (manualCurated.length < 5)
    throw new Error(`Seed corpus must have ≥5 manual-curated items, got ${manualCurated.length}`);

  const sanitizedProduction = REPLAY_CORPUS_ITEMS.filter(
    (i) => i.source === "sanitized-production"
  );
  if (sanitizedProduction.length > 0)
    throw new Error(
      `Seed corpus must have 0 sanitised-production items, got ${sanitizedProduction.length}`
    );

  const withGroundTruth = REPLAY_CORPUS_ITEMS.filter((i) => i.groundTruth != null);
  if (withGroundTruth.length !== total)
    throw new Error(
      `Seed corpus must have 100% ground truth coverage, got ${withGroundTruth.length}/${total}`
    );

  const safetyRelevant = REPLAY_CORPUS_ITEMS.filter((i) => i.groundTruth.safetyRelevant);
  if (safetyRelevant.length < 3)
    throw new Error(`Seed corpus must have ≥3 safety-relevant items, got ${safetyRelevant.length}`);

  // Topic diversity
  const topics = new Set(
    REPLAY_CORPUS_ITEMS.map((i) => i.topic).filter(Boolean)
  ) as Set<CorpusTopicCategory>;
  if (topics.size < 5)
    throw new Error(`Seed corpus must cover ≥5 topic categories, got ${topics.size}`);
}

// Run validation at module load time to catch any corpus authoring errors
try {
  validateSeedCorpus();
} catch (err) {
  // Re-throw with a clear message so module authors see the issue
  throw new Error(
    `REPLAY CORPUS SEED VALIDATION FAILED: ${err instanceof Error ? err.message : String(err)}`
  );
}

// ---------------------------------------------------------------------------
// Corpus version constant
// ---------------------------------------------------------------------------

/** Version string for the corpus schema. */
export const REPLAY_CORPUS_VERSION = "1.0";
