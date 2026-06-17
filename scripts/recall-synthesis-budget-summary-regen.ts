/**
 * Regenerate the probe summary from the (patched) JSONL, comparing
 * against the previous (restrictive-prompt) run JSONL.
 */
import fs from "node:fs";
import path from "node:path";

import {
  BENCHMARK_RECORDS,
  type BenchmarkMemoryRecord,
} from "../src/benchmark/corpus.js";
import {
  BENCHMARK_QUERIES,
  type BenchmarkQuery,
  type BenchmarkQueryFamily,
} from "../src/benchmark/queries.js";

interface RawRecord {
  config: string;
  query_id: string;
  query_family: string;
  query_text: string;
  max_tokens: number;
  model: string;
  prompt_variant: string;
  retrieval_count: number;
  retrieval_ids: number[];
  answer: string;
  char_count: number;
  word_count: number;
  sentence_count: number;
  finish_reason?: string;
  usage?: Record<string, number | undefined>;
  latency_ms: number;
  ok: boolean;
  error_kind?: string;
  error_message?: string;
  timestamp: string;
}

function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function max(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  let m = values[0]!;
  for (const v of values) if (v > m) m = v;
  return m;
}

function loadJsonl(path: string): RawRecord[] {
  const body = fs.readFileSync(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RawRecord);
}

const outDir = path.join(process.cwd(), "tmp");
const jsonlPath = path.join(outDir, "recall-synthesis-budget-probe.jsonl");
const prevPath = "/tmp/opencode/recall-synthesis-budget-probe.previous.jsonl";

const records = loadJsonl(jsonlPath);
const prevRecords = loadJsonl(prevPath);

const perConfig: Record<string, RawRecord[]> = {};
for (const r of records) {
  (perConfig[r.config] ??= []).push(r);
}
const prevPerConfig: Record<string, RawRecord[]> = {};
for (const r of prevRecords) {
  (prevPerConfig[r.config] ??= []).push(r);
}

const families: BenchmarkQueryFamily[] = [
  "orientation",
  "no-answer",
  "paraphrase",
  "temporal",
  "multi-hop",
  "exact",
];

const lines: string[] = [];
lines.push("# Recall synthesis concision — budget probe summary (relaxed-prompt run)");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Setup");
lines.push("");
lines.push("- Primary provider: `openai/gpt-oss-120b` (NVIDIA NIM, OpenAI-compatible)");
lines.push("- Fallback provider: `MiniMax-M3` (MiniMax, OpenAI-compatible)");
lines.push("- Query selection: 84 queries total (26 orientation + 16 no-answer + 12 paraphrase + 10 temporal + 10 multi-hop + 10 exact)");
lines.push("- Retrieval: lexical ranker, top-5, threshold 0.2");
lines.push("- Filter: BUDGETS=512 (new-prompt only; A skipped)");
lines.push("- 14 rate-limited B records retried with backoff (success: 14/14; one came back as `finish=length`)");
lines.push("");

// Per-config metrics for THIS run (B and B-fallback).
lines.push("## Per-config metrics (this run, BUDGETS=512)");
lines.push("");
lines.push("| config | n | ok | mean raw chars | p95 raw chars | max raw chars | mean sentences | max sentences | length truncations | errors |");
lines.push("|---|---|---|---|---|---|---|---|---|---|");
for (const k of ["B", "B-fallback"]) {
  const recs = perConfig[k] ?? [];
  const ok = recs.filter((r) => r.ok);
  const chars = ok.map((r) => r.char_count);
  const sents = ok.map((r) => r.sentence_count);
  const errs = recs.filter((r) => !r.ok).length;
  const len = recs.filter((r) => r.finish_reason === "length").length;
  lines.push(
    `| ${k} | ${recs.length} | ${ok.length} | ${mean(chars).toFixed(1)} | ${percentile(chars, 95).toFixed(0)} | ${max(chars)} | ${mean(sents).toFixed(2)} | ${max(sents)} | ${len} | ${errs} |`,
  );
}
lines.push("");

// Finish-reason distribution.
lines.push("## Finish-reason distribution (this run)");
lines.push("");
for (const k of ["B", "B-fallback"]) {
  const recs = perConfig[k] ?? [];
  const dist: Record<string, number> = {};
  for (const r of recs) {
    const fr = r.finish_reason ?? (r.ok ? "<unknown>" : `<error:${r.error_kind ?? "?"}>`);
    dist[fr] = (dist[fr] ?? 0) + 1;
  }
  lines.push(`- **${k}**: ${JSON.stringify(dist)}`);
}
lines.push("");

// Per-family char-count mean (B).
lines.push("## Per-family char-count mean (config B, this run)");
lines.push("");
lines.push("| family | n | mean raw chars | p95 raw chars | max raw chars |");
lines.push("|---|---|---|---|---|");
for (const f of families) {
  const recs = (perConfig["B"] ?? []).filter((r) => r.query_family === f && r.ok);
  if (recs.length === 0) {
    lines.push(`| ${f} | 0 | — | — | — |`);
    continue;
  }
  const c = recs.map((r) => r.char_count);
  lines.push(
    `| ${f} | ${recs.length} | ${mean(c).toFixed(1)} | ${percentile(c, 95).toFixed(0)} | ${max(c)} |`,
  );
}
lines.push("");

// Comparison to the previous (restrictive-prompt) run.
lines.push("## Comparison to previous run — relaxed-prompt vs restrictive-prompt (this run vs previous JSONL)");
lines.push("");
lines.push("| config | n (prev) | n (this) | mean chars (prev → this) | p95 chars (prev → this) | max chars (prev → this) | length trunc (prev → this) |");
lines.push("|---|---|---|---|---|---|---|");
for (const k of ["B", "B-fallback"]) {
  const prev = prevPerConfig[k] ?? [];
  const curr = perConfig[k] ?? [];
  const prevOk = prev.filter((r) => r.ok);
  const currOk = curr.filter((r) => r.ok);
  const prevChars = prevOk.map((r) => r.char_count);
  const currChars = currOk.map((r) => r.char_count);
  const prevLen = prev.filter((r) => r.finish_reason === "length").length;
  const currLen = curr.filter((r) => r.finish_reason === "length").length;
  lines.push(
    `| ${k} | ${prev.length} | ${curr.length} | ${mean(prevChars).toFixed(1)} → ${mean(currChars).toFixed(1)} | ${percentile(prevChars, 95).toFixed(0)} → ${percentile(currChars, 95).toFixed(0)} | ${max(prevChars)} → ${max(currChars)} | ${prevLen} → ${currLen} |`,
  );
}
lines.push("");

// Model-swap side-by-side (B vs B-fallback), this run.
const bRecs = perConfig["B"] ?? [];
const bfRecs = perConfig["B-fallback"] ?? [];
if (bRecs.length > 0 && bfRecs.length > 0) {
  lines.push("## Model-swap side-by-side (B primary vs B-fallback, both new relaxed prompt + max_tokens=512)");
  lines.push("");
  lines.push("B = primary (`openai/gpt-oss-120b`); B-fallback = fallback (`MiniMax-M3`).");
  lines.push("");
  lines.push("### Aggregate metrics (raw char counts)");
  lines.push("");
  lines.push("| metric | B | B-fallback |");
  lines.push("|---|---|---|");
  const bChars = bRecs.filter((r) => r.ok).map((r) => r.char_count);
  const bfChars = bfRecs.filter((r) => r.ok).map((r) => r.char_count);
  const bSent = bRecs.filter((r) => r.ok).map((r) => r.sentence_count);
  const bfSent = bfRecs.filter((r) => r.ok).map((r) => r.sentence_count);
  const bLen = bRecs.filter((r) => r.finish_reason === "length").length;
  const bfLen = bfRecs.filter((r) => r.finish_reason === "length").length;
  lines.push(`| n queries | ${bRecs.length} | ${bfRecs.length} |`);
  lines.push(`| mean raw chars | ${mean(bChars).toFixed(1)} | ${mean(bfChars).toFixed(1)} |`);
  lines.push(`| median raw chars | ${percentile(bChars, 50).toFixed(0)} | ${percentile(bfChars, 50).toFixed(0)} |`);
  lines.push(`| p50 raw chars | ${percentile(bChars, 50).toFixed(0)} | ${percentile(bfChars, 50).toFixed(0)} |`);
  lines.push(`| p75 raw chars | ${percentile(bChars, 75).toFixed(0)} | ${percentile(bfChars, 75).toFixed(0)} |`);
  lines.push(`| p90 raw chars | ${percentile(bChars, 90).toFixed(0)} | ${percentile(bfChars, 90).toFixed(0)} |`);
  lines.push(`| p95 raw chars | ${percentile(bChars, 95).toFixed(0)} | ${percentile(bfChars, 95).toFixed(0)} |`);
  lines.push(`| p99 raw chars | ${percentile(bChars, 99).toFixed(0)} | ${percentile(bfChars, 99).toFixed(0)} |`);
  lines.push(`| max raw chars | ${max(bChars)} | ${max(bfChars)} |`);
  lines.push(`| mean sentences | ${mean(bSent).toFixed(2)} | ${mean(bfSent).toFixed(2)} |`);
  lines.push(`| max sentences | ${max(bSent)} | ${max(bfSent)} |`);
  lines.push(`| finish_reason=length | ${bLen} | ${bfLen} |`);
  lines.push("");

  // Per-family breakdown.
  lines.push("### Per-family breakdown (raw chars)");
  lines.push("");
  lines.push("| family | n (B) | mean B | p95 B | max B | finish=length B | n (Bf) | mean Bf | p95 Bf | max Bf | finish=length Bf |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const f of families) {
    const bF = bRecs.filter((r) => r.query_family === f && r.ok);
    const bfF = bfRecs.filter((r) => r.query_family === f && r.ok);
    if (bF.length === 0 && bfF.length === 0) {
      lines.push(`| ${f} | 0 | — | — | — | — | 0 | — | — | — | — |`);
      continue;
    }
    const bC = bF.map((r) => r.char_count);
    const bfC = bfF.map((r) => r.char_count);
    const bFLen = bRecs.filter((r) => r.query_family === f && r.finish_reason === "length").length;
    const bfFLen = bfRecs.filter((r) => r.query_family === f && r.finish_reason === "length").length;
    lines.push(
      `| ${f} | ${bF.length} | ${mean(bC).toFixed(1)} | ${percentile(bC, 95).toFixed(0)} | ${max(bC)} | ${bFLen} | ${bfF.length} | ${mean(bfC).toFixed(1)} | ${percentile(bfC, 95).toFixed(0)} | ${max(bfC)} | ${bfFLen} |`,
    );
  }
  lines.push("");

  // Threshold-crossing distribution.
  lines.push("### Threshold-crossing distribution — RAW char counts");
  lines.push("");
  lines.push("| threshold | B (count / %) | B-fallback (count / %) |");
  lines.push("|---|---|---|");
  const thresholds = [200, 400, 600, 800, 1000, 1200, 1500];
  for (const t of thresholds) {
    const bN = bChars.filter((c) => c <= t).length;
    const bfN = bfChars.filter((c) => c <= t).length;
    const bPct = `${((bN / bChars.length) * 100).toFixed(1)}%`;
    const bfPct = `${((bfN / bfChars.length) * 100).toFixed(1)}%`;
    lines.push(`| <= ${t} chars | ${bN} / ${bPct} | ${bfN} / ${bfPct} |`);
  }
  {
    const bN = bChars.filter((c) => c > 1500).length;
    const bfN = bfChars.filter((c) => c > 1500).length;
    const bPct = `${((bN / bChars.length) * 100).toFixed(1)}%`;
    const bfPct = `${((bfN / bfChars.length) * 100).toFixed(1)}%`;
    lines.push(`| > 1500 chars | ${bN} / ${bPct} | ${bfN} / ${bfPct} |`);
  }
  lines.push("");
  lines.push(
    "User's expectations: typical target ~800 chars; 900-1200 chars is OK; <70% over 800 chars; no consistent 1500+ chars.",
  );
  lines.push(
    `On raw chars: B has ${((bChars.filter((c) => c > 800).length / bChars.length) * 100).toFixed(1)}% over 800, B-fallback has ${((bfChars.filter((c) => c > 800).length / bfChars.length) * 100).toFixed(1)}% over 800.`,
  );
  lines.push("");

  // Notable rambles.
  lines.push("### Top 5 longest raw answers (config B)");
  lines.push("");
  const topB = [...bRecs]
    .filter((r) => r.ok)
    .sort((a, b) => b.char_count - a.char_count)
    .slice(0, 5);
  for (const r of topB) {
    lines.push(
      `- ${r.query_id} (${r.query_family}, ${r.char_count} chars, ${r.sentence_count} sentences, finish=${r.finish_reason ?? "?"})`,
    );
    lines.push(`  Q: ${r.query_text}`);
    lines.push(`  A: ${r.answer.slice(0, 400).replace(/\n/g, " ")}${r.answer.length > 400 ? "…" : ""}`);
    lines.push("");
  }
}

const outPath = path.join(outDir, "recall-synthesis-budget-summary.md");
fs.writeFileSync(outPath, lines.join("\n"), "utf8");
process.stdout.write(`wrote ${outPath}\n`);
