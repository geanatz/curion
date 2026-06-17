#!/usr/bin/env tsx
/**
 * Probe: measure `remember(text)` summary lengths under whatever
 * cap `DEFAULT_MAX_SUMMARY_LENGTH` is currently set to, with real
 * provider calls, in an isolated temp DB.
 *
 * Why this exists
 * ---------------
 * The controller's `DEFAULT_MAX_SUMMARY_LENGTH` cap was raised
 * from 500 chars. ~34% of the user's live stored memories
 * (.curion/curion.sqlite) were truncated at 500 with a "…" marker.
 * This script probes whether the current cap is sufficient, by
 * calling the real controller on a representative input set, in a
 * temp dir, and measuring the resulting summary lengths.
 *
 * What it does
 * ------------
 *  1. Loads `.env` via `loadDotEnv` (controller reads process.env
 *     directly; nothing else auto-loads it).
 *  2. Builds a 25-input set mixing recall-shaped queries and
 *     substantive project-memory inputs.
 *  3. Initializes a fresh storage handle in a temp directory
 *     (NEVER touches the production .curion/curion.sqlite).
 *  4. Calls `runRememberController` on each input. Captures the
 *     outcome, summary, confidence, model id.
 *  5. Writes:
 *       tmp/remember-summary-cap-probe.jsonl  - per-input records
 *       tmp/remember-summary-cap-probe.md     - human report
 *
 * Safety / non-goals
 * ------------------
 *  - No DB writes to the production store. All writes go to a
 *    temp dir created by `fs.mkdtempSync`.
 *  - No mocking of the provider. The real adapter runs against
 *    MiniMax primary / NVIDIA NIM fallback per the controller's
 *    default config. Consumes real API credits (~$0.03 typical).
 *  - No changes to src/. This is a measurement script only.
 *
 * Run via:
 *   npx tsx scripts/remember-summary-cap-probe.ts
 * or
 *   npm run probe:remember-cap
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runRememberController,
  DEFAULT_MAX_SUMMARY_LENGTH,
} from "../src/controller/remember-controller.ts";
import { initStorage, closeStorage } from "../src/storage/storage.ts";
import { loadDotEnv } from "../src/config/env-loader.ts";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface ProbeInput {
  id: string;
  /** Short tag classifying the input shape. */
  kind: "recall-query" | "short" | "medium" | "long";
  text: string;
}

const INPUTS: ProbeInput[] = [
  // ---- 5 recall-style queries (verbatim from src/benchmark/queries.ts) ----
  {
    id: "q-db",
    kind: "recall-query",
    text: "What database does the project use?",
  },
  {
    id: "q-runtime",
    kind: "recall-query",
    text: "What language and runtime does the server use?",
  },
  {
    id: "q-storage-location",
    kind: "recall-query",
    text: "Where is the project storage located on disk?",
  },
  {
    id: "q-ci",
    kind: "recall-query",
    text: "What does the CI pipeline do?",
  },
  {
    id: "q-shipping",
    kind: "recall-query",
    text: "How do we ship changes to users safely?",
  },

  // ---- 5 short project-memory inputs (1-2 sentences) ----
  {
    id: "s-postgres-version",
    kind: "short",
    text: "We standardized on Postgres 16 for the primary store.",
  },
  {
    id: "s-branch-per-experiment",
    kind: "short",
    text: "Curion's git workflow uses one branch per experiment, branched from main.",
  },
  {
    id: "s-mcp-tools",
    kind: "short",
    text: "Curion exposes exactly two MCP public tools: `remember(text)` and `recall(text)`.",
  },
  {
    id: "s-local-storage",
    kind: "short",
    text: "Project-local memory is stored in `.curion/curion.sqlite` inside the project root.",
  },
  {
    id: "s-pinned-deps",
    kind: "short",
    text: "Production code never reads the .env file; secrets come from the parent process's environment.",
  },

  // ---- 10 medium project-memory inputs (2-4 sentences) ----
  {
    id: "m-rename-2026",
    kind: "medium",
    text:
      "Session 9 (2026-06-16): renamed the project from `cortex-mcp-v2` to `Curion`. " +
      "Old repo at /home/geanatz/Repos/other/cortex-mcp-old; new repo at /home/geanatz/Repos/curion. " +
      "Renamed package metadata, src tree, tests, benchmark, env, tsconfig, gitignore, opencode config. " +
      "Populated the new memory store with high-signal info from 8 archived session transcripts.",
  },
  {
    id: "m-recall-mvp",
    kind: "medium",
    text:
      "Session 1 of Curion produced the recall MVP: a `recall(text)` tool that returns the top-K " +
      "memory summaries ranked by token overlap with the query. " +
      "The MVP uses lexical scoring only — no FTS5, no vector, no hybrid. " +
      "Confidence threshold of 0.5 gates whether a result is returned or a `no_relevant_memory` " +
      "response is emitted.",
  },
  {
    id: "m-embedder-tbd",
    kind: "medium",
    text:
      "Session 4 carryover: no production embedder is selected yet. " +
      "Options on the table are transformersjs (Qwen3) and embeddinggemma. " +
      "Decision is deferred until retrieval-quality benchmarks show a clear winner. " +
      "Until then, lexical baseline is the default and hybrid retrieval is gated behind a feature flag.",
  },
  {
    id: "m-abstention-policy",
    kind: "medium",
    text:
      "Session 5 production-like findings identified a 'score-or-sufficiency-insufficient' " +
      "abstention policy as the recall contract. " +
      "The policy returns no_relevant_memory when (a) top score is below the calibrated threshold " +
      "OR (b) the candidate set is too thin to support a confident answer. " +
      "Calibration runs use the dense-vector and hybrid variants in CI.",
  },
  {
    id: "m-weak-match",
    kind: "medium",
    text:
      "Curion Fix A introduces a fifth recall status called `weak_match` on the experimental branch. " +
      "The status is returned when the top score is below the main threshold but above a " +
      "lower 'suggestive' threshold, so the user gets a hedged hint rather than a flat refusal. " +
      "Public contract: a `weak_match` is structured identically to a normal hit, with a `confidence` " +
      "field below 0.5 and a `note` explaining the partial match.",
  },
  {
    id: "m-narrative-prompt",
    kind: "medium",
    text:
      "Curion write-path prompt change: the synthesis prompt now asks for a 1-3 sentence " +
      "narrative memory that preserves the useful context from the input. " +
      "It explicitly forbids curator framings like 'The user asked' or 'This memory captures'. " +
      "Concrete terms (file names, branch names, feature names, decisions, constraints) should be " +
      "preserved when present.",
  },
  {
    id: "m-fts5-sync",
    kind: "medium",
    text:
      "Storage fix on main (a9a54af): the `memories_fts` virtual table now stays in sync with `memories` " +
      "via AFTER INSERT/UPDATE/DELETE triggers. " +
      "Previously, FTS5 would silently drift when rows were updated by `updateMemoryMetadata`. " +
      "A backfill routine repairs the FTS index on first run after upgrade; from then on the " +
      "triggers keep it consistent.",
  },
  {
    id: "m-test-isolation",
    kind: "medium",
    text:
      "The remember-safety test is now isolated from the real production DB. " +
      "Each test creates a fresh `mkdtempSync` directory and calls `initStorage({ projectRoot: tmp })`, " +
      "so test runs cannot pollute or read `.curion/curion.sqlite`. " +
      "Cleanup uses `rmStorage` which closes the handle and recursively removes the temp dir.",
  },
  {
    id: "m-eval-pipeline",
    kind: "medium",
    text:
      "Curion's evaluation pipeline is split into per-experiment runners under `src/benchmark/`. " +
      "Each runner is a thin CLI wrapper around a typed runner module, with a `npm run benchmark:retrieval:*` " +
      "alias in package.json. " +
      "Calibration runs use the `--calibrate` flag and persist their artifacts to `src/benchmark/data/`. " +
      "Per-experiment tests under `tests/*.test.ts` re-assert the contracts using the persisted artifacts.",
  },
  {
    id: "m-handover-format",
    kind: "medium",
    text:
      "Session handover format: each session produces a `HANDOVER.md` in the repo root with a session " +
      "header, what was completed, what changed, what was decided, and links to the archived " +
      "transcripts under `.archive/sessions/`. " +
      "The handover is the source of truth for resuming work without re-reading the full transcripts. " +
      "Stored memories are a separate, condensed feed for the AI agent — they never duplicate the handover.",
  },

  // ---- 5 long project-memory inputs (likely to produce long summaries) ----
  {
    id: "l-resolved-history-spec",
    kind: "long",
    text:
      "Technical specification (Phase F) for Curion's resolved-history and supersession model: " +
      "every memory has a `state` field with one of three values — `active`, `superseded`, or `invalidated`. " +
      "When a new memory contradicts an existing one, the controller writes the new one as `active` and " +
      "promotes the old one to `superseded` in the same transaction. " +
      "The supersession edge is captured in a `supersedes` field in the metadata block, " +
      "with a `supersedes_id` and `supersedes_reason`. " +
      "Recall filters out non-`active` rows by default but exposes them via a separate `recall_history` " +
      "tool for audit purposes. " +
      "Invalidation is reserved for safety pre-check hits that should never have been stored; the " +
      "audit log retains the original summary and the reason for invalidation. " +
      "The full state machine and the transactional guarantees are documented in " +
      "`docs/spec/resolved-history.md`.",
  },
  {
    id: "l-rename-session",
    kind: "long",
    text:
      "Full account of the Session 9 rename work: " +
      "the user (geanatz) asked for the project to be renamed from `cortex-mcp-v2` to `Curion`, " +
      "the old repo at `/home/geanatz/Repos/cortex-mcp` to be moved aside, and the new Curion " +
      "memory store to be populated with high-signal information from the 8 archived session " +
      "transcripts (~73,879 lines total). " +
      "Worker executed the `mv` first, then renamed the directory, updated package.json " +
      "(name, description, bin entry), and propagated the new name through the src tree, tests, " +
      "benchmark suite, opencode config, .env.example, tsconfig, and .gitignore. " +
      "All 12 source files containing the old name were edited in this pass. " +
      "Then 16 high-signal memories were written to the new store via `remember(text)` over " +
      "multiple rounds, each calling the real LLM to produce a 1-3 sentence narrative summary. " +
      "The HANDOVER.md file in the new repo root is the canonical pointer for resuming this work " +
      "without re-reading the 8 archived transcripts. " +
      "The rename is reversible by reverting the commit and restoring the old repo, but no " +
      "downstream code depends on the old name, so the cutover is final.",
  },
  {
    id: "l-eval-disciplines",
    kind: "long",
    text:
      "The Curion evaluation pipeline covers four orthogonal disciplines. " +
      "(1) Retrieval: `benchmark:retrieval:*` runs the ranker over the benchmark query corpus " +
      "and reports hit@K, MRR, nDCG@K, and per-family breakdowns. " +
      "Lexical, FTS5, vector-dense, and hybrid-rrf are the supported variants. " +
      "(2) Abstention: `benchmark:retrieval:abstention-policy` and `:abstention-audit` " +
      "validate that the recall controller returns `no_relevant_memory` exactly when the policy " +
      "says it should, and never when a relevant memory exists in the top-K. " +
      "(3) Calibration: `benchmark:retrieval:calibrate` measures precision/recall trade-offs as a " +
      "function of the score threshold, with the artifact written to " +
      "`src/benchmark/data/calibration-*.json`. " +
      "(4) Held-out: `benchmark:retrieval:held-out` uses a separate query set that was not used " +
      "for any hyperparameter tuning, so the reported numbers are an honest out-of-sample estimate. " +
      "Each discipline has its own test file in `tests/*.test.ts` that re-asserts the contracts " +
      "without re-running the LLM.",
  },
  {
    id: "l-synthesis-history",
    kind: "long",
    text:
      "The synthesis prompt for `remember(text)` has gone through four iterations. " +
      "Phase 1 (initial): 'Summarize the input in 1-2 sentences.' Produced terse, often " +
      "information-poor summaries that dropped concrete terms. " +
      "Phase 2: 'Write a narrative memory in 1-3 sentences that preserves the useful context.' " +
      "Better, but the model drifted into curator framings like 'The user noted that…'. " +
      "Phase 3: added the negative constraint 'Do not start with The user asked or This memory " +
      "captures'. The drift went away but the model occasionally hallucinated details not in the " +
      "input, so the 'Do not invent details' constraint was added. " +
      "Phase 4 (current): same instructions but with `max_tokens=512` and the soft '1-3 sentence' " +
      "guidance loosened to allow the LLM to use up to the controller's summary cap. " +
      "The 500-char cap was identified as the binding constraint for ~34% of stored memories. " +
      "This probe raises the cap to 2000 to confirm the cap, not the prompt, was the binding " +
      "constraint.",
  },
  {
    id: "l-storage-schema",
    kind: "long",
    text:
      "Curion's storage layer uses a single SQLite file at `.curion/curion.sqlite` inside the " +
      "project root. The schema has one primary table `memories(id, kind, created_at, summary, " +
      "state, provider_id, model_id, confidence, safety_flags, metadata, updated_at)` plus an " +
      "FTS5 virtual table `memories_fts` indexed on the `summary` column. " +
      "Triggers keep `memories_fts` in sync with `memories` on every insert/update/delete. " +
      "The `summary` column is TEXT, unbounded — there is no DB-level cap. " +
      "The 500-char (now 2000-char) cap lives in the controller, not the schema. " +
      "An `embeddings` table holds 1024-dim vectors keyed by memory id, used by the vector and " +
      "hybrid retrieval variants. " +
      "A `_meta` table records the schema version and the last successful migration. " +
      "All writes go through the `insertMemoryRecord` and `updateMemoryMetadata` helpers, which " +
      "are the only places that know about the trigger semantics.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count sentences by splitting on `[.!?]+`. */
function countSentences(s: string): number {
  if (!s) return 0;
  const parts = s.split(/[.!?]+/).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length;
}

function percent(x: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((x / total) * 100).toFixed(1) + "%";
}

function fmtMs(ms: number): string {
  return ms.toFixed(0) + "ms";
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface PerInputRecord {
  id: string;
  kind: ProbeInput["kind"];
  input_length: number;
  outcome_status: string;
  outcome_reason: string | null;
  outcome_safety_class: string | null;
  provider_id: string | null;
  model_id: string | null;
  confidence: number | null;
  summary_length: number;
  truncated: boolean;
  sentence_count: number;
  summary_preview: string;
  summary_full: string;
  duration_ms: number;
}

async function main(): Promise<void> {
  // 1. Load .env so the controller's process.env reads work.
  const envResult = loadDotEnv({ path: path.join(process.cwd(), ".env") });
  if (!envResult.loaded) {
    console.error(
      "[probe] ERROR: .env not found in cwd; cannot load provider API keys.",
    );
    process.exit(1);
  }
  const hasPrimary = Boolean(
    process.env.CURION_PROVIDER_PRIMARY_KEY ?? process.env.MINIMAX_API_KEY,
  );
  const hasFallback = Boolean(
    process.env.CURION_PROVIDER_FALLBACK_KEY ?? process.env.NVIDIA_NIM_API_KEY,
  );
  if (!hasPrimary || !hasFallback) {
    console.error(
      `[probe] ERROR: provider keys missing. primary=${hasPrimary} fallback=${hasFallback}`,
    );
    process.exit(1);
  }
  console.log(
    `[probe] .env loaded: ${envResult.keys.length} keys. Primary + fallback keys present.`,
  );

  // 2. Make a temp dir for an isolated storage handle.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "curion-cap-probe-"));
  console.log(`[probe] temp storage root: ${tmpRoot}`);
  let handle;
  try {
    handle = initStorage({ projectRoot: tmpRoot });
  } catch (err) {
    console.error(`[probe] ERROR: initStorage failed: ${(err as Error).message}`);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  }

  // 3. Run the probe.
  const records: PerInputRecord[] = [];
  let totalDurationMs = 0;
  console.log(`[probe] running ${INPUTS.length} inputs against real provider...`);

  for (let i = 0; i < INPUTS.length; i++) {
    const inp = INPUTS[i]!;
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await runRememberController(handle, inp.text);
    } catch (err) {
      const ms = Date.now() - t0;
      totalDurationMs += ms;
      console.error(
        `[probe] input #${i + 1} ${inp.id} threw: ${(err as Error).message}`,
      );
      records.push({
        id: inp.id,
        kind: inp.kind,
        input_length: inp.text.length,
        outcome_status: "thrown",
        outcome_reason: (err as Error).message,
        outcome_safety_class: null,
        provider_id: null,
        model_id: null,
        confidence: null,
        summary_length: 0,
        truncated: false,
        sentence_count: 0,
        summary_preview: "",
        summary_full: "",
        duration_ms: ms,
      });
      continue;
    }
    const ms = Date.now() - t0;
    totalDurationMs += ms;

    if (outcome.status === "saved") {
      const rec = outcome.record;
      const summary = rec.summary;
      records.push({
        id: inp.id,
        kind: inp.kind,
        input_length: inp.text.length,
        outcome_status: "saved",
        outcome_reason: null,
        outcome_safety_class: null,
        provider_id: rec.providerId,
        model_id: rec.modelId,
        confidence: rec.confidence,
        summary_length: summary.length,
        truncated: summary.endsWith("\u2026"),
        sentence_count: countSentences(summary),
        summary_preview: summary.slice(0, 200),
        summary_full: summary,
        duration_ms: ms,
      });
      console.log(
        `[probe] #${i + 1} ${inp.id} (${inp.kind}) saved: ` +
          `summary_len=${summary.length} truncated=${summary.endsWith("\u2026")} ` +
          `sentences=${countSentences(summary)} confidence=${rec.confidence} ` +
          `model=${rec.modelId} ${fmtMs(ms)}`,
      );
    } else {
      // Non-saved outcomes: no summary produced.
      const reason =
        "reason" in outcome ? (outcome.reason as string) : "(no reason)";
      const safetyClass =
        outcome.status === "rejected" ? outcome.safetyClass : null;
      records.push({
        id: inp.id,
        kind: inp.kind,
        input_length: inp.text.length,
        outcome_status: outcome.status,
        outcome_reason: reason,
        outcome_safety_class: safetyClass,
        provider_id: null,
        model_id: null,
        confidence: null,
        summary_length: 0,
        truncated: false,
        sentence_count: 0,
        summary_preview: "",
        summary_full: "",
        duration_ms: ms,
      });
      console.log(
        `[probe] #${i + 1} ${inp.id} (${inp.kind}) ` +
          `NOT SAVED: status=${outcome.status} reason=${reason} ${fmtMs(ms)}`,
      );
    }
  }

  // 4. Close + clean temp storage.
  closeStorage(handle);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  console.log(`[probe] temp storage cleaned up. Total wall: ${totalDurationMs}ms.`);

  // 5. Aggregate stats (only over saved outcomes).
  const saved = records.filter((r) => r.outcome_status === "saved");
  const summaryLengths = saved.map((r) => r.summary_length);
  const truncatedCount = saved.filter((r) => r.truncated).length;
  const atCapCount = saved.filter((r) => r.summary_length === DEFAULT_MAX_SUMMARY_LENGTH).length;
  const notSaved = records.filter((r) => r.outcome_status !== "saved");

  // "What would have been truncated at the old 500 cap?"
  // Anything with summary_length > 500 is a candidate (truncateAtBoundary
  // would slice and append "…"). At 500 exactly it was NOT truncated
  // (500 <= 500 -> returned as-is).
  const wouldTruncateAt500 = saved.filter(
    (r) => r.summary_length > 500 && !r.truncated,
  ).length;
  const actuallyTruncatedAtCap = truncatedCount;

  // 6. Write JSONL.
  const outJsonl = path.join(process.cwd(), "tmp", "remember-summary-cap-probe.jsonl");
  fs.mkdirSync(path.dirname(outJsonl), { recursive: true });
  const jsonlBody = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(outJsonl, jsonlBody);
  console.log(`[probe] JSONL: ${outJsonl}`);

  // 7. Write Markdown report.
  const outMd = path.join(process.cwd(), "tmp", "remember-summary-cap-probe.md");
  const lines: string[] = [];
  lines.push(`# Remember summary cap probe (${DEFAULT_MAX_SUMMARY_LENGTH} chars)`);
  lines.push("");
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Inputs: ${INPUTS.length} (5 recall-query, 5 short, 10 medium, 5 long)`);
  lines.push(`Saved: ${saved.length} / ${INPUTS.length}`);
  lines.push(`Not saved: ${notSaved.length}`);
  if (notSaved.length > 0) {
    for (const r of notSaved) {
      lines.push(`  - ${r.id}: ${r.outcome_status} (${r.outcome_reason ?? ""})`);
    }
  }
  lines.push(`Total wall time: ${totalDurationMs}ms`);
  lines.push("");
  lines.push("## Summary length stats (saved outcomes only)");
  lines.push("");
  lines.push(`- n = ${summaryLengths.length}`);
  lines.push(`- mean   = ${mean(summaryLengths).toFixed(1)} chars`);
  lines.push(`- median = ${median(summaryLengths).toFixed(1)} chars`);
  lines.push(`- p95    = ${p95(summaryLengths).toFixed(1)} chars`);
  lines.push(`- min    = ${Math.min(...summaryLengths)} chars`);
  lines.push(`- max    = ${Math.max(...summaryLengths)} chars`);
  lines.push(`- truncated (ends in \u2026) = ${truncatedCount} / ${saved.length} ` +
    `(${percent(truncatedCount, saved.length)})`);
  lines.push(`- at exactly ${DEFAULT_MAX_SUMMARY_LENGTH} chars (hard cap) = ${atCapCount} / ${saved.length} ` +
    `(${percent(atCapCount, saved.length)})`);
  lines.push("");
  lines.push("## Comparison to old 500-char cap");
  lines.push("");
  lines.push(
    "- At the OLD cap of 500, ~34% of stored memories were truncated (39/119 in " +
      "`.curion/curion.sqlite`).",
  );
  lines.push(
    `- At the NEW cap of ${DEFAULT_MAX_SUMMARY_LENGTH}, this probe produced: ${actuallyTruncatedAtCap} / ${saved.length} truncated ` +
      `(${percent(actuallyTruncatedAtCap, saved.length)}).`,
  );
  lines.push(
    `- Of the saved summaries, ${wouldTruncateAt500} / ${saved.length} have length > 500 ` +
      `(${percent(wouldTruncateAt500, saved.length)}); these would have been truncated at the old cap.`,
  );
  lines.push(
    `- Effective "untruncated" coverage at ${DEFAULT_MAX_SUMMARY_LENGTH}: ${saved.length - actuallyTruncatedAtCap} / ${saved.length} ` +
      `(${percent(saved.length - actuallyTruncatedAtCap, saved.length)}).`,
  );
  lines.push("");

  lines.push("## Per-input table");
  lines.push("");
  lines.push("| id | kind | input_len | summary_len | truncated | sentences | confidence | model | ms |");
  lines.push("|---|---|---:|---:|:---:|---:|---:|---|---:|");
  for (const r of records) {
    lines.push(
      `| ${r.id} | ${r.kind} | ${r.input_length} | ${r.summary_length} | ` +
        `${r.truncated ? "\u2026" : ""} | ${r.sentence_count} | ` +
        `${r.confidence !== null ? r.confidence.toFixed(2) : "-"} | ` +
        `${r.model_id ?? "-"} | ${r.duration_ms} |`,
    );
  }
  lines.push("");

  lines.push("## Sample summaries (first 200 chars each)");
  lines.push("");
  for (const r of saved.slice(0, 8)) {
    lines.push(`### ${r.id} (${r.kind}, len=${r.summary_length}, sentences=${r.sentence_count})`);
    lines.push("");
    lines.push("```");
    lines.push(r.summary_preview);
    lines.push("```");
    lines.push("");
  }
  lines.push("");

  lines.push("## Full summaries");
  lines.push("");
  for (const r of saved) {
    lines.push(`### ${r.id} (${r.kind}, len=${r.summary_length})`);
    lines.push("");
    lines.push("```");
    lines.push(r.summary_full);
    lines.push("```");
    lines.push("");
  }

  fs.writeFileSync(outMd, lines.join("\n"));
  console.log(`[probe] Markdown: ${outMd}`);

  // 8. Print headline to stdout.
  console.log("");
  console.log("=== HEADLINE ===");
  console.log(`saved = ${saved.length} / ${INPUTS.length}`);
  console.log(
    `summary length: mean=${mean(summaryLengths).toFixed(1)} ` +
      `median=${median(summaryLengths).toFixed(1)} ` +
      `p95=${p95(summaryLengths).toFixed(1)} ` +
      `max=${Math.max(...summaryLengths)}`,
  );
  console.log(
    `truncated at ${DEFAULT_MAX_SUMMARY_LENGTH} (\u2026): ${truncatedCount} / ${saved.length} ` +
      `(${percent(truncatedCount, saved.length)})`,
  );
  console.log(
    `would have been truncated at old 500-cap: ${wouldTruncateAt500} / ${saved.length} ` +
      `(${percent(wouldTruncateAt500, saved.length)})`,
  );
}

main().catch((err) => {
  console.error("[probe] FATAL:", err);
  process.exit(1);
});
