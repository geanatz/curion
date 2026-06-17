/**
 * Targeted retry for failed (rate-limited) B records from the
 * recall-synthesis budget probe. Patches the JSONL in place so the
 * summary + postprocess can run on a complete dataset.
 */
import fs from "node:fs";
import path from "node:path";

import {
  chatCompletion,
  type ChatMessage,
} from "../src/providers/http-client.js";
import {
  BENCHMARK_QUERIES,
  type BenchmarkQuery,
} from "../src/benchmark/queries.js";
import {
  BENCHMARK_RECORDS,
  type BenchmarkMemoryRecord,
} from "../src/benchmark/corpus.js";
import {
  rankLexical,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOP_K,
  type LexicalCandidate,
} from "../src/retrieval/lexical.js";
import {
  RECALL_DEFAULT_PRIMARY_BASE_URL,
  RECALL_DEFAULT_PRIMARY_MODEL,
  RECALL_DEFAULT_TIMEOUT_MS,
} from "../src/providers/recall-synthesis.js";
import { loadPrototypeConfig } from "../src/config/env-loader.js";

// Mirror the new user prompt in production + probe.
function buildNewUserPrompt(
  query: string,
  memories: ReadonlyArray<BenchmarkMemoryRecord>,
): string {
  const lines: string[] = [];
  lines.push("Answer the QUERY using only the MEMORIES below.");
  lines.push(
    "Write a useful recall result. Include the relevant details from the memories that answer the query — names, decisions, dates, file paths, branches, and concrete specifics — not just a compressed summary.",
  );
  lines.push(
    "For broad orientation queries, identify the main themes and include the specific entities, decisions, and constraints that support each theme.",
  );
  lines.push(
    "Use multiple sentences when the query covers multiple topics or memories. Use as many sentences as needed to cover the relevant material; do not artificially compress.",
  );
  lines.push(
    "Write in continuous prose. Do not include memory IDs, bullets, headings, code blocks, raw logs, or instruction commentary.",
  );
  lines.push("Do not invent details that are not in the memories.");
  lines.push(
    "If the memories do not answer the query, say: I don't have that information in memory.",
  );
  lines.push("");
  lines.push("MEMORIES (id: summary):");
  for (const m of memories) {
    const kind = m.kind ? ` [${m.kind}]` : "";
    lines.push(`- #${m.id}${kind}: ${m.summary}`);
  }
  lines.push("");
  lines.push("QUERY:");
  lines.push(JSON.stringify(query));
  return lines.join("\n");
}

function countSentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function computeRetrieval(query: string): {
  topCandidates: ReadonlyArray<BenchmarkMemoryRecord>;
  scores: ReadonlyArray<{ id: number; score: number }>;
} {
  const candidates: LexicalCandidate[] = BENCHMARK_RECORDS.map((r) => ({
    id: r.id,
    text: r.summary,
    ...(r.tags ? { tags: r.tags } : {}),
  }));
  const scored = rankLexical(query, candidates, {
    threshold: DEFAULT_RELEVANCE_THRESHOLD,
    topK: DEFAULT_TOP_K,
  });
  if (scored.length === 0) {
    const fallback = BENCHMARK_RECORDS.slice(0, DEFAULT_TOP_K);
    return {
      topCandidates: fallback,
      scores: fallback.map((r, i) => ({ id: r.id, score: 0 - i })),
    };
  }
  const byId = new Map(BENCHMARK_RECORDS.map((r) => [r.id, r]));
  const top = scored
    .map((s) => byId.get(s.id))
    .filter((r): r is BenchmarkMemoryRecord => Boolean(r));
  return {
    topCandidates: top,
    scores: scored.map((s) => ({ id: s.id, score: s.score })),
  };
}

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
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  latency_ms: number;
  ok: boolean;
  error_kind?: string;
  error_message?: string;
  timestamp: string;
}

async function main(): Promise<void> {
  const protoCfg = loadPrototypeConfig();
  if (!protoCfg.hasPrimaryKey) {
    process.stderr.write("error: no primary provider API key in .env\n");
    process.exit(2);
  }
  process.stdout.write(`dotenv loaded=${protoCfg.dotenvLoaded}\n`);

  const jsonlPath = path.join(process.cwd(), "tmp", "recall-synthesis-budget-probe.jsonl");
  if (!fs.existsSync(jsonlPath)) {
    process.stderr.write(`error: ${jsonlPath} not found\n`);
    process.exit(2);
  }
  const body = fs.readFileSync(jsonlPath, "utf8");
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  const records: RawRecord[] = lines.map((l) => JSON.parse(l) as RawRecord);

  // Find failed B records.
  const failed = records.filter(
    (r) => r.config === "B" && !r.ok && r.error_kind === "rate-limit",
  );
  process.stdout.write(`failed B records (rate-limit): ${failed.length}\n`);
  if (failed.length === 0) {
    process.stdout.write("nothing to retry\n");
    return;
  }

  const failedIds = new Set(failed.map((r) => r.query_id));
  const queriesById = new Map<string, BenchmarkQuery>();
  for (const q of BENCHMARK_QUERIES) queriesById.set(q.id, q);

  const baseUrl = process.env.CURION_NIM_BASE_URL ?? RECALL_DEFAULT_PRIMARY_BASE_URL;
  const model = process.env.CURION_NIM_FALLBACK_MODEL ?? RECALL_DEFAULT_PRIMARY_MODEL;
  const apiKey =
    process.env.CURION_PROVIDER_PRIMARY_KEY ?? process.env.NVIDIA_NIM_API_KEY ?? "";
  const timeoutMs = Number.parseInt(
    process.env.CURION_PROTOTYPE_TIMEOUT_MS ?? `${RECALL_DEFAULT_TIMEOUT_MS}`,
    10,
  ) || RECALL_DEFAULT_TIMEOUT_MS;

  const newSystem =
    "You write project-memory recall answers for another coding agent. Use only the provided memories. Answer in plain text only.";

  const patched: RawRecord[] = [];
  for (const old of failed) {
    const q = queriesById.get(old.query_id);
    if (!q) {
      process.stderr.write(`warn: no query for ${old.query_id}, skipping\n`);
      continue;
    }
    const retrieval = computeRetrieval(q.query);
    const userPrompt = buildNewUserPrompt(q.query, retrieval.topCandidates);
    const messages: ChatMessage[] = [
      { role: "system", content: newSystem },
      { role: "user", content: userPrompt },
    ];

    let attempt = 0;
    let success = false;
    let lastOutcome: RawRecord | null = null;
    while (attempt < 4 && !success) {
      attempt += 1;
      // Stagger retries to give the rate limiter time to clear.
      if (attempt > 1) {
        const backoff = 1500 * attempt;
        process.stdout.write(`  retry ${attempt}/4 for ${old.query_id} after ${backoff}ms\n`);
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        // First attempt: small polite delay.
        await new Promise((r) => setTimeout(r, 500));
      }
      const t0 = Date.now();
      const r = await chatCompletion(
        { model, messages, temperature: 0, maxTokens: old.max_tokens },
        {
          baseUrl,
          apiKey,
          timeoutMs,
          providerLabel: `${model}#probe-retry`,
        },
      );
      const t1 = Date.now();
      if (!r.ok) {
        process.stderr.write(
          `  ${old.query_id} attempt ${attempt} failed: ${r.error.kind} ${r.error.message}\n`,
        );
        lastOutcome = {
          ...old,
          ok: false,
          error_kind: r.error.kind,
          error_message: r.error.message,
          latency_ms: t1 - t0,
          timestamp: new Date().toISOString(),
        };
        continue;
      }
      const answer = r.response.content;
      const rec: RawRecord = {
        ...old,
        answer,
        char_count: answer.length,
        word_count: countWords(answer),
        sentence_count: countSentences(answer),
        finish_reason: r.response.finishReason,
        usage: r.response.usage
          ? {
              promptTokens: r.response.usage.promptTokens,
              completionTokens: r.response.usage.completionTokens,
              totalTokens: r.response.usage.totalTokens,
            }
          : undefined,
        latency_ms: r.response.latencyMs,
        ok: true,
        error_kind: undefined,
        error_message: undefined,
        timestamp: new Date().toISOString(),
        retrieval_count: retrieval.topCandidates.length,
        retrieval_ids: retrieval.topCandidates.map((c) => c.id),
      };
      lastOutcome = rec;
      success = true;
    }
    if (success && lastOutcome && lastOutcome.ok) {
      patched.push(lastOutcome);
      process.stdout.write(
        `  ${old.query_id} ok chars=${lastOutcome.char_count} sentences=${lastOutcome.sentence_count} finish=${lastOutcome.finish_reason}\n`,
      );
    } else {
      process.stderr.write(`  ${old.query_id} all retries exhausted\n`);
      if (lastOutcome) patched.push(lastOutcome);
    }
  }

  // Replace failed records in the JSONL with their patched versions.
  const replaced = new Map<string, RawRecord>();
  for (const p of patched) replaced.set(p.query_id, p);
  const out: RawRecord[] = [];
  let replacedCount = 0;
  for (const r of records) {
    if (r.config === "B" && failedIds.has(r.query_id) && replaced.has(r.query_id)) {
      out.push(replaced.get(r.query_id)!);
      replacedCount += 1;
    } else {
      out.push(r);
    }
  }
  process.stdout.write(
    `replaced ${replacedCount} failed records; new record count: ${out.length}\n`,
  );

  // Atomic write: write to a temp file, then rename.
  const tmpPath = jsonlPath + ".tmp";
  const stream = fs.createWriteStream(tmpPath, { encoding: "utf8" });
  for (const r of out) {
    stream.write(JSON.stringify(r) + "\n");
  }
  await new Promise<void>((resolve) => stream.end(resolve));
  fs.renameSync(tmpPath, jsonlPath);
  process.stdout.write(`patched JSONL: ${jsonlPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`retry failed: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
