/**
 * Post-process the recall-synthesis budget probe JSONL to compute
 * metrics AFTER applying the controller's reasoning-strip pass.
 *
 * The raw probe records include the model's full output, which can
 * contain `<think>...</think>` reasoning blocks. The recall
 * controller's `validateAnswer` strips these blocks before
 * applying the 800-character cap. This script re-runs the same
 * strip pass on the recorded answers and recomputes the metrics,
 * so the report reflects what actually reaches the public `text`
 * field.
 *
 * Usage:
 *   npx tsx scripts/recall-synthesis-budget-postprocess.ts
 *
 * Output:
 *   tmp/recall-synthesis-budget-postprocess.md
 *   (overwrites the postprocess summary; the original probe
 *    JSONL is read-only)
 */

import fs from "node:fs";
import path from "node:path";

interface RawRecord {
  config: "A" | "B" | "B-fallback" | "C" | "C-fallback";
  query_id: string;
  query_family: string;
  query_text: string;
  max_tokens: number;
  model: string;
  prompt_variant: "old" | "new";
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

interface PostRecord {
  config: RawRecord["config"];
  query_id: string;
  query_family: string;
  raw_char_count: number;
  stripped_char_count: number;
  stripped_word_count: number;
  stripped_sentence_count: number;
  stripped_first_100: string;
  finish_reason?: string;
}

// Mirror the controller's strip pass (src/controller/recall-controller.ts
// `stripReasoningBlocks`). Keep this in sync with the production code.
function stripReasoningBlocks(answer: string): string {
  if (typeof answer !== "string" || answer.length === 0) return answer;
  let text = answer;
  text = text.replace(
    /<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi,
    "",
  );
  const leadingLabelMatch = text.match(
    /^\s*(?:Reasoning|Thought)\s*:\s*([\s\S]{0,2000}?)(?:\n\s*\n|\n\s*$)/i,
  );
  if (leadingLabelMatch && leadingLabelMatch.index !== undefined) {
    const before = text.slice(0, leadingLabelMatch.index);
    const tail = text.slice(
      leadingLabelMatch.index + leadingLabelMatch[0].length,
    );
    if (tail.trim().length >= 1) {
      text = (before + tail).trimStart();
    }
  }
  return text;
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

interface ConfigStats {
  config: RawRecord["config"];
  count: number;
  meanRawChars: number;
  meanStrippedChars: number;
  p95StrippedChars: number;
  maxStrippedChars: number;
  meanStrippedSentences: number;
  maxStrippedSentences: number;
  meanRawSentences: number;
  trimmedToEmptyCount: number;
  trimmedShortCount: number; // stripped, <= 10 chars
  strippedOver800Count: number; // stripped answer that would still hit 800 cap
  strippedOver200Count: number; // stripped answer that would hit 200 chars
  finishReasonLengthCount: number;
}

function statsFor(
  label: RawRecord["config"],
  recs: ReadonlyArray<PostRecord>,
  rawRecs: ReadonlyArray<RawRecord>,
): ConfigStats {
  const strippedChars = recs.map((r) => r.stripped_char_count);
  const strippedSentences = recs.map((r) => r.stripped_sentence_count);
  const rawChars = rawRecs.map((r) => r.char_count);
  const rawSentences = rawRecs.map((r) => r.sentence_count);
  const trimmedToEmpty = recs.filter((r) => r.stripped_char_count === 0).length;
  const trimmedShort = recs.filter(
    (r) => r.stripped_char_count > 0 && r.stripped_char_count <= 10,
  ).length;
  const over800 = recs.filter((r) => r.stripped_char_count > 800).length;
  const over200 = recs.filter((r) => r.stripped_char_count > 200).length;
  const lengthFinish = rawRecs.filter((r) => r.finish_reason === "length").length;
  return {
    config: label,
    count: recs.length,
    meanRawChars: mean(rawChars),
    meanStrippedChars: mean(strippedChars),
    p95StrippedChars: percentile(strippedChars, 95),
    maxStrippedChars: max(strippedChars),
    meanStrippedSentences: mean(strippedSentences),
    maxStrippedSentences: max(strippedSentences),
    meanRawSentences: mean(rawSentences),
    trimmedToEmptyCount: trimmedToEmpty,
    trimmedShortCount: trimmedShort,
    strippedOver800Count: over800,
    strippedOver200Count: over200,
    finishReasonLengthCount: lengthFinish,
  };
}

function main(): void {
  const outDir = path.join(process.cwd(), "tmp");
  const jsonlPath = path.join(outDir, "recall-synthesis-budget-probe.jsonl");
  if (!fs.existsSync(jsonlPath)) {
    process.stderr.write(`error: ${jsonlPath} does not exist\n`);
    process.exit(2);
  }
  const body = fs.readFileSync(jsonlPath, "utf8");
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  const rawRecs: RawRecord[] = lines.map((l) => JSON.parse(l) as RawRecord);

  const postRecs: PostRecord[] = rawRecs.map((r) => {
    const stripped = stripReasoningBlocks(r.answer);
    return {
      config: r.config,
      query_id: r.query_id,
      query_family: r.query_family,
      raw_char_count: r.char_count,
      stripped_char_count: stripped.length,
      stripped_word_count: countWords(stripped),
      stripped_sentence_count: countSentences(stripped),
      stripped_first_100: stripped.slice(0, 100),
      finish_reason: r.finish_reason,
    };
  });

  const perConfig: Record<RawRecord["config"], PostRecord[]> = {
    A: postRecs.filter((r) => r.config === "A"),
    B: postRecs.filter((r) => r.config === "B"),
    "B-fallback": postRecs.filter((r) => r.config === "B-fallback"),
    C: postRecs.filter((r) => r.config === "C"),
    "C-fallback": postRecs.filter((r) => r.config === "C-fallback"),
  };
  const perRaw: Record<RawRecord["config"], RawRecord[]> = {
    A: rawRecs.filter((r) => r.config === "A"),
    B: rawRecs.filter((r) => r.config === "B"),
    "B-fallback": rawRecs.filter((r) => r.config === "B-fallback"),
    C: rawRecs.filter((r) => r.config === "C"),
    "C-fallback": rawRecs.filter((r) => r.config === "C-fallback"),
  };
  const sA = statsFor("A", perConfig.A, perRaw.A);
  const sB = statsFor("B", perConfig.B, perRaw.B);
  const sBFallback = statsFor("B-fallback", perConfig["B-fallback"], perRaw["B-fallback"]);
  const sC = statsFor("C", perConfig.C, perRaw.C);
  const sCFallback = statsFor("C-fallback", perConfig["C-fallback"], perRaw["C-fallback"]);

  // The "primary" config: B (new + 512, the production target) is
  // preferred, then B-fallback, then C, then A, then C-fallback.
  // Falls back to the first one with data if the preferred config
  // is absent.
  const configOrder: RawRecord["config"][] = ["B", "B-fallback", "C", "A", "C-fallback"];
  const statsByConfig = new Map<RawRecord["config"], ConfigStats>([
    ["A", sA],
    ["B", sB],
    ["B-fallback", sBFallback],
    ["C", sC],
    ["C-fallback", sCFallback],
  ]);
  const presentConfigs = configOrder.filter(
    (k) => (perConfig[k]?.length ?? 0) > 0,
  );
  const primaryLabel =
    presentConfigs[0] ?? "C"; // legacy default for old JSONLs
  const sPrimary = statsByConfig.get(primaryLabel) ?? sC;

  const out: string[] = [];
  out.push("# Recall synthesis concision — POST-STRIP metrics");
  out.push("");
  out.push(
    "These metrics are computed AFTER applying the controller's `stripReasoningBlocks`",
  );
  out.push(
    "pass (`<think>...</think>` and leading `Reasoning:` / `Thought:` blocks removed).",
  );
  out.push(
    "This is the length the controller's 800-character cap actually evaluates against.",
  );
  out.push("");
  out.push(`Primary config for the verdict below: **${primaryLabel}** (production target is B; the first config with data is used when B is absent).`);
  out.push("");
  out.push("## Post-strip metrics per config");
  out.push("");
  out.push(
    "| config | n | mean raw chars | mean stripped chars | p95 stripped chars | max stripped chars | mean stripped sentences | max stripped sentences | trimmed to empty | trimmed short (1-10) | stripped >800 | stripped >200 | length finish_reason |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const k of configOrder) {
    const recs = perConfig[k];
    if (!recs || recs.length === 0) continue;
    const s = statsByConfig.get(k)!;
    out.push(
      `| ${s.config} | ${s.count} | ${s.meanRawChars.toFixed(1)} | ${s.meanStrippedChars.toFixed(1)} | ${s.p95StrippedChars.toFixed(0)} | ${s.maxStrippedChars} | ${s.meanStrippedSentences.toFixed(2)} | ${s.maxStrippedSentences} | ${s.trimmedToEmptyCount} | ${s.trimmedShortCount} | ${s.strippedOver800Count} | ${s.strippedOver200Count} | ${s.finishReasonLengthCount} |`,
    );
  }
  out.push("");
  out.push(`## Pass/fail verdict (config ${primaryLabel} — POST-STRIP)`);
  out.push("");
  const cP95 = sPrimary.p95StrippedChars;
  const cMax = sPrimary.maxStrippedChars;
  const cP95Pass = cP95 <= 750;
  const cMaxPass = cMax <= 1000;
  const cOver800 = sPrimary.strippedOver800Count;
  const cLengthTrunc = sPrimary.finishReasonLengthCount;
  const cSentencePass = (() => {
    const recs = perConfig[primaryLabel] ?? [];
    const sents = recs.map((r) => r.stripped_sentence_count);
    if (sents.length === 0) return 0;
    const short = sents.filter((n) => n <= 3).length;
    return (short / sents.length) * 100;
  })();
  const cSentencePassBool = cSentencePass >= 95;
  const verdict = (label: string, pass: boolean, detail: string) =>
    `- **${pass ? "PASS" : "FAIL"}** — ${label}: ${detail}`;
  out.push(verdict(
    `zero finish_reason=length under ${primaryLabel}`,
    cLengthTrunc === 0,
    `${cLengthTrunc} truncations`,
  ));
  out.push(verdict(
    `p95 stripped chars <= 750 under ${primaryLabel}`,
    cP95Pass,
    `p95 = ${cP95.toFixed(0)} stripped chars`,
  ));
  out.push(verdict(
    `max stripped chars <= 1000 under ${primaryLabel}`,
    cMaxPass,
    `max = ${cMax} stripped chars`,
  ));
  out.push(verdict(
    `>=95% of ${primaryLabel} answers <= 3 sentences (stripped)`,
    cSentencePassBool,
    `${cSentencePass.toFixed(1)}% short`,
  ));
  out.push(verdict(
    `zero stripped answers > 800 chars under ${primaryLabel}`,
    cOver800 === 0,
    `${cOver800} would still hit the 800 cap`,
  ));
  out.push("");
  out.push(`## Per-family post-strip metrics (config ${primaryLabel})`);
  out.push("");
  const families = [
    "orientation",
    "no-answer",
    "paraphrase",
    "temporal",
    "multi-hop",
    "exact",
  ];
  out.push("| family | n | mean stripped chars | p95 stripped chars | max stripped chars |");
  out.push("|---|---|---|---|---|");
  for (const f of families) {
    const recs = (perConfig[primaryLabel] ?? []).filter(
      (r) => r.query_family === f,
    );
    if (recs.length === 0) {
      out.push(`| ${f} | 0 | — | — | — |`);
      continue;
    }
    const c = recs.map((r) => r.stripped_char_count);
    out.push(
      `| ${f} | ${recs.length} | ${mean(c).toFixed(1)} | ${percentile(c, 95).toFixed(0)} | ${max(c)} |`,
    );
  }
  if (perConfig.A.length > 0) {
    out.push("");
    out.push("## Per-family post-strip metrics (config A — old prompt, baseline)");
    out.push("");
    out.push("| family | n | mean stripped chars | p95 stripped chars | max stripped chars |");
    out.push("|---|---|---|---|---|");
    for (const f of families) {
      const recs = perConfig.A.filter((r) => r.query_family === f);
      if (recs.length === 0) {
        out.push(`| ${f} | 0 | — | — | — |`);
        continue;
      }
      const c = recs.map((r) => r.stripped_char_count);
      out.push(
        `| ${f} | ${recs.length} | ${mean(c).toFixed(1)} | ${percentile(c, 95).toFixed(0)} | ${max(c)} |`,
      );
    }
  }
  out.push("");
  out.push(`## Top 5 longest stripped answers (config ${primaryLabel})`);
  out.push("");
  const topStripped = [...(perConfig[primaryLabel] ?? [])]
    .sort((a, b) => b.stripped_char_count - a.stripped_char_count)
    .slice(0, 5);
  for (const r of topStripped) {
    out.push(`- ${r.query_id} (${r.query_family}, raw=${r.raw_char_count} chars, stripped=${r.stripped_char_count} chars, sentences=${r.stripped_sentence_count})`);
    out.push(`  preview: ${r.stripped_first_100.replace(/\n/g, " ")}…`);
  }
  out.push("");
  out.push(`## Top 5 shortest stripped answers (config ${primaryLabel}, non-empty)`);
  out.push("");
  const botStripped = [...(perConfig[primaryLabel] ?? [])]
    .filter((r) => r.stripped_char_count > 0)
    .sort((a, b) => a.stripped_char_count - b.stripped_char_count)
    .slice(0, 5);
  for (const r of botStripped) {
    out.push(`- ${r.query_id} (${r.query_family}, raw=${r.raw_char_count} chars, stripped=${r.stripped_char_count} chars, sentences=${r.stripped_sentence_count})`);
    out.push(`  preview: ${r.stripped_first_100.replace(/\n/g, " ")}…`);
  }

  // -------------------------------------------------------------------------
  // Model-swap side-by-side (B vs B-fallback) — POST-STRIP
  //
  // Same comparison as the summary's side-by-side, but for the
  // post-strip char counts. The brief specifically asks for the
  // threshold-crossing table on BOTH raw and post-strip; raw lives
  // in the summary, post-strip lives here.
  // -------------------------------------------------------------------------
  const bRecsPost = perConfig["B"] ?? [];
  const bFallbackRecsPost = perConfig["B-fallback"] ?? [];
  if (bRecsPost.length > 0 && bFallbackRecsPost.length > 0) {
    out.push("");
    out.push("## Model-swap side-by-side — POST-STRIP (B primary vs B-fallback, both new prompt + max_tokens=512)");
    out.push("");
    out.push("B = new default primary (`openai/gpt-oss-120b`); B-fallback = new fallback (`MiniMax-M3`).");
    out.push("These are the char counts the user actually sees on the wire (after reasoning-block stripping).");
    out.push("");

    const bStripped = bRecsPost.map((r) => r.stripped_char_count);
    const bfStripped = bFallbackRecsPost.map((r) => r.stripped_char_count);
    const bSents = bRecsPost.map((r) => r.stripped_sentence_count);
    const bfSents = bFallbackRecsPost.map((r) => r.stripped_sentence_count);
    const bRaw = perRaw["B"] ?? [];
    const bfRaw = perRaw["B-fallback"] ?? [];
    const bLenTrunc = bRaw.filter((r) => r.finish_reason === "length").length;
    const bfLenTrunc = bfRaw.filter((r) => r.finish_reason === "length").length;

    out.push("### Aggregate metrics (POST-STRIP)");
    out.push("");
    out.push("| metric | B | B-fallback |");
    out.push("|---|---|---|");
    out.push(`| n queries | ${bRecsPost.length} | ${bFallbackRecsPost.length} |`);
    out.push(`| mean stripped chars | ${mean(bStripped).toFixed(1)} | ${mean(bfStripped).toFixed(1)} |`);
    out.push(`| median stripped chars | ${percentile(bStripped, 50).toFixed(0)} | ${percentile(bfStripped, 50).toFixed(0)} |`);
    out.push(`| p50 stripped chars | ${percentile(bStripped, 50).toFixed(0)} | ${percentile(bfStripped, 50).toFixed(0)} |`);
    out.push(`| p75 stripped chars | ${percentile(bStripped, 75).toFixed(0)} | ${percentile(bfStripped, 75).toFixed(0)} |`);
    out.push(`| p90 stripped chars | ${percentile(bStripped, 90).toFixed(0)} | ${percentile(bfStripped, 90).toFixed(0)} |`);
    out.push(`| p95 stripped chars | ${percentile(bStripped, 95).toFixed(0)} | ${percentile(bfStripped, 95).toFixed(0)} |`);
    out.push(`| p99 stripped chars | ${percentile(bStripped, 99).toFixed(0)} | ${percentile(bfStripped, 99).toFixed(0)} |`);
    out.push(`| max stripped chars | ${max(bStripped)} | ${max(bfStripped)} |`);
    out.push(`| mean sentences | ${mean(bSents).toFixed(2)} | ${mean(bfSents).toFixed(2)} |`);
    out.push(`| max sentences | ${max(bSents)} | ${max(bfSents)} |`);
    out.push(`| finish_reason=length | ${bLenTrunc} | ${bfLenTrunc} |`);
    out.push("");

    // Threshold-crossing distribution (post-strip).
    out.push("### Threshold-crossing distribution — POST-STRIP char counts");
    out.push("");
    out.push("| threshold | B (count / %) | B-fallback (count / %) |");
    out.push("|---|---|---|");
    const thresholds = [400, 800, 1000, 1200, 1500];
    for (const t of thresholds) {
      const bN = bStripped.filter((c) => c <= t).length;
      const bfN = bfStripped.filter((c) => c <= t).length;
      const bPct = bStripped.length === 0 ? "—" : `${((bN / bStripped.length) * 100).toFixed(1)}%`;
      const bfPct = bfStripped.length === 0 ? "—" : `${((bfN / bfStripped.length) * 100).toFixed(1)}%`;
      out.push(`| <= ${t} chars | ${bN} / ${bPct} | ${bfN} / ${bfPct} |`);
    }
    {
      const bN = bStripped.filter((c) => c > 1500).length;
      const bfN = bfStripped.filter((c) => c > 1500).length;
      const bPct = bStripped.length === 0 ? "—" : `${((bN / bStripped.length) * 100).toFixed(1)}%`;
      const bfPct = bfStripped.length === 0 ? "—" : `${((bfN / bfStripped.length) * 100).toFixed(1)}%`;
      out.push(`| > 1500 chars | ${bN} / ${bPct} | ${bfN} / ${bfPct} |`);
    }
    out.push("");
    out.push(
      "User's expectations: typical target ~800 chars; 900-1200 chars is OK; <70% over 800 chars; no consistent 1500+ chars.",
    );
    out.push(
      `On stripped chars: B has ${bStripped.length === 0 ? "n/a" : ((bStripped.filter((c) => c > 800).length / bStripped.length) * 100).toFixed(1)}% over 800, B-fallback has ${bfStripped.length === 0 ? "n/a" : ((bfStripped.filter((c) => c > 800).length / bfStripped.length) * 100).toFixed(1)}% over 800.`,
    );
  }

  const outPath = path.join(outDir, "recall-synthesis-budget-postprocess.md");
  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  process.stdout.write(`wrote ${outPath}\n`);
}

main();
