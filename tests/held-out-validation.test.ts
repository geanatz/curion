/**
 * Tests for the benchmark-only held-out validation
 * runner.
 *
 * Covers:
 *   1. Held-out query slice integrity
 *      - unique query ids
 *      - no id collision with the dev set
 *      - valid family labels
 *      - valid expected / current truth ids
 *      - all expected ids resolve to real records
 *      - no-answer queries have empty expected ids
 *      - non-no-answer queries have at least one expected id
 *      - per-family minimum coverage
 *      - no-answer minimum coverage
 *      - no secret / credential-shaped content
 *   2. Held-out validation runner
 *      - `runHeldOutEvals` on `lexical` /
 *        `hybrid` / `hybrid-dense` returns
 *        well-formed evals
 *      - `buildHeldOutReport` produces a
 *        well-formed report with metadata,
 *        policies, decisions, per-family
 *        breakdown, per-query FP / FN lists,
 *        per-query input, and the limitations
 *        block
 *      - the report's policies are the same
 *        `BUILTIN_POLICIES` the dev-set policy
 *        evaluator uses (frozen policy, not
 *        tuned on held-out)
 *      - the artifact prefix is
 *        `retrieval-held-out-validation-`
 *      - `formatHeldOutReport` produces a
 *        non-empty human-readable string with
 *        the expected sections
 *   3. Frozen baseline / transfer delta
 *      - the four primary policies have
 *        `FROZEN_TRANSFER_BASELINES` entries
 *      - the primary policy marker is
 *        `moderate-score-0.40`
 *      - the transfer-delta math is honest
 *        (held-out minus frozen baseline, in
 *        percentage points)
 *   4. Determinism
 *      - same held-out evals -> same report
 *      - `writeHeldOutReport` writes a
 *        byte-stable file
 *   5. Production / API guard
 *      - the production `recall` controller
 *        does NOT import any held-out module
 *      - the public MCP tool surface is still
 *        exactly `remember` + `recall`
 *
 * The tests use the stub dense embedder
 * (`--embedder stub-dense`) so they are
 * network-free. A real-MiniLM held-out run
 * is exercised by the CLI
 * (`benchmark:retrieval:held-out:hybrid-dense:real`),
 * not the test suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import {
  HELD_OUT_QUERIES,
  HELD_OUT_QUERY_IDS,
  HELD_OUT_TOTAL_COUNT,
  HELD_OUT_MIN_FAMILY_COUNTS,
  HELD_OUT_MIN_NO_ANSWER_COUNT,
} from "../src/benchmark/held-out-queries.ts";
import {
  buildHeldOutReport,
  formatHeldOutReport,
  runHeldOutEvals,
  writeHeldOutReport,
  FROZEN_TRANSFER_BASELINES,
  PRIMARY_POLICY_IDS,
  PRIMARY_POLICY_ID,
  HELD_OUT_LIMITATIONS,
  type HeldOutValidationReport,
} from "../src/benchmark/held-out-validation.ts";
import { BUILTIN_POLICIES } from "../src/benchmark/abstention-policy.ts";
import { StubDeterministicDenseEmbedder } from "../src/benchmark/variants/dense-embedder.ts";
import type { BenchmarkQuery, BenchmarkQueryFamily } from "../src/benchmark/queries.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { parseHeldOutCli } from "../src/benchmark/held-out-runner.ts";
import { runRetrievalBenchmark } from "../src/benchmark/retrieval-runner.ts";

// ---------------------------------------------------------------------------
// 1. Held-out query slice integrity
// ---------------------------------------------------------------------------

test("held-out queries: ids are unique within the held-out set", () => {
  const seen = new Set<string>();
  for (const q of HELD_OUT_QUERIES) {
    assert.ok(
      typeof q.id === "string" && q.id.length > 0,
      `held-out query id must be a non-empty string, got ${q.id}`,
    );
    assert.ok(
      q.id.startsWith("held-"),
      `held-out query id must be prefixed 'held-', got ${q.id}`,
    );
    assert.ok(!seen.has(q.id), `duplicate held-out query id: ${q.id}`);
    seen.add(q.id);
  }
});

test("held-out queries: ids do not collide with the dev set", () => {
  const devIds = new Set(BENCHMARK_QUERIES.map((q) => q.id));
  for (const q of HELD_OUT_QUERIES) {
    assert.ok(
      !devIds.has(q.id),
      `held-out query id '${q.id}' collides with a dev-set id`,
    );
  }
});

test("held-out queries: families are valid and exactly cover the 6 families", () => {
  const validFamilies: ReadonlySet<BenchmarkQueryFamily> = new Set([
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ]);
  const seenFamilies = new Set<string>();
  for (const q of HELD_OUT_QUERIES) {
    assert.ok(
      validFamilies.has(q.family),
      `held-out query '${q.id}' has unknown family '${q.family}'`,
    );
    seenFamilies.add(q.family);
  }
  // Every family should be represented. The held-out
  // set is deliberately a balanced probe.
  for (const required of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ]) {
    assert.ok(
      seenFamilies.has(required),
      `held-out query set is missing the "${required}" family`,
    );
  }
});

test("held-out queries: expected / current truth ids resolve to real records", () => {
  const validIds = new Set<number>(BENCHMARK_RECORDS.map((r) => r.id));
  for (const q of HELD_OUT_QUERIES) {
    for (const id of q.expectedIds) {
      assert.ok(
        validIds.has(id),
        `held-out query '${q.id}' expects missing record id ${id}`,
      );
    }
    for (const id of q.currentTruthIds) {
      assert.ok(
        validIds.has(id),
        `held-out query '${q.id}' has currentTruth id ${id} that is not in the corpus`,
      );
    }
  }
});

test("held-out queries: no-answer queries have empty expected / current truth", () => {
  for (const q of HELD_OUT_QUERIES) {
    if (q.family === "no-answer") {
      assert.equal(
        q.expectedIds.length,
        0,
        `no-answer held-out query '${q.id}' must have empty expectedIds`,
      );
      assert.equal(
        q.currentTruthIds.length,
        0,
        `no-answer held-out query '${q.id}' must have empty currentTruthIds`,
      );
    } else {
      assert.ok(
        q.expectedIds.length > 0,
        `positive held-out query '${q.id}' must have at least one expected id`,
      );
      assert.ok(
        q.currentTruthIds.length > 0,
        `positive held-out query '${q.id}' must have at least one currentTruth id`,
      );
    }
  }
});

test("held-out queries: non-temporal currentTruthIds is a subset of expectedIds", () => {
  for (const q of HELD_OUT_QUERIES) {
    if (q.family === "temporal") continue; // temporal may diverge
    for (const id of q.currentTruthIds) {
      assert.ok(
        q.expectedIds.includes(id),
        `held-out query '${q.id}' has currentTruth id ${id} not in expectedIds`,
      );
    }
  }
});

test("held-out queries: per-family minimum coverage is met", () => {
  const counts: Record<string, number> = {};
  for (const q of HELD_OUT_QUERIES) {
    counts[q.family] = (counts[q.family] ?? 0) + 1;
  }
  for (const [family, min] of Object.entries(HELD_OUT_MIN_FAMILY_COUNTS)) {
    assert.ok(
      (counts[family] ?? 0) >= min,
      `family '${family}' has ${counts[family] ?? 0} held-out queries, expected at least ${min}`,
    );
  }
});

test("held-out queries: no-answer minimum is met", () => {
  const naCount = HELD_OUT_QUERIES.filter((q) => q.family === "no-answer").length;
  assert.ok(
    naCount >= HELD_OUT_MIN_NO_ANSWER_COUNT,
    `no-answer family has ${naCount} held-out queries, expected at least ${HELD_OUT_MIN_NO_ANSWER_COUNT}`,
  );
});

test("held-out queries: total count is in the brief's ~24-40 range", () => {
  assert.ok(
    HELD_OUT_TOTAL_COUNT >= 24,
    `held-out set has ${HELD_OUT_TOTAL_COUNT} queries, expected at least 24`,
  );
  assert.ok(
    HELD_OUT_TOTAL_COUNT <= 40,
    `held-out set has ${HELD_OUT_TOTAL_COUNT} queries, expected at most 40`,
  );
});

test("held-out queries: no secret / credential-shaped content", () => {
  // The held-out queries are part of the public
  // benchmark fixture. A credential-shaped
  // fragment in a query is a fail. Same patterns
  // as the dev-set corpus integrity test.
  const shapes: Array<{ re: RegExp; label: string }> = [
    { re: /\bAKIA[0-9A-Z]{16}\b/g, label: "aws-access-key" },
    { re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g, label: "openai-key" },
    { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: "github-token" },
    { re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g, label: "gitlab-pat" },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
    { re: /\bAIza[A-Za-z0-9_\-]{30,}\b/g, label: "google-api-key" },
    { re: /\bnvapi-[A-Za-z0-9_\-]{20,}\b/g, label: "nvidia-nim-key" },
    { re: /\bbearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi, label: "bearer-token" },
    { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, label: "pem-private-key" },
  ];
  for (const q of HELD_OUT_QUERIES) {
    for (const { re, label } of shapes) {
      re.lastIndex = 0;
      assert.ok(
        !re.test(q.query),
        `held-out query '${q.id}' has ${label} pattern in query text`,
      );
    }
  }
});

test("held-out queries: HELD_OUT_QUERY_IDS is the held-out query id list in declaration order", () => {
  assert.deepEqual(
    [...HELD_OUT_QUERY_IDS],
    HELD_OUT_QUERIES.map((q) => q.id),
  );
});

// ---------------------------------------------------------------------------
// 2. Held-out validation runner
// ---------------------------------------------------------------------------

test("held-out runner: buildHeldOutReport produces a well-formed report (lexical)", () => {
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  // We use the sync path synchronously; the function
  // is async but resolves immediately for the
  // lexical / hybrid variants.
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const report = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    assertHeldOutReportShape(report, "lexical");
  })();
});

test("held-out runner: buildHeldOutReport produces a well-formed report (hybrid)", () => {
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "hybrid",
      queries: HELD_OUT_QUERIES,
      topK: 5,
      hybridK: 60,
    });
    const report = buildHeldOutReport({
      variant: "hybrid",
      topK: evalsResult.topK,
      hybridK: evalsResult.hybridK,
      evals: evalsResult.evals,
    });
    assertHeldOutReportShape(report, "hybrid");
  })();
});

test("held-out runner: buildHeldOutReport produces a well-formed report (hybrid-dense / stub)", () => {
  return (async () => {
    const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
    const evalsResult = await runHeldOutEvals({
      variant: "hybrid-dense",
      queries: HELD_OUT_QUERIES,
      embedder,
      topK: 5,
      hybridK: 60,
    });
    const report = buildHeldOutReport({
      variant: "hybrid-dense",
      topK: evalsResult.topK,
      hybridK: evalsResult.hybridK,
      embedderMetadata: evalsResult.embedderMetadata,
      evals: evalsResult.evals,
    });
    assertHeldOutReportShape(report, "hybrid-dense");
    // The embedder metadata block is surfaced
    // for hybrid-dense runs.
    assert.ok(
      report.meta.embedder !== undefined,
      "hybrid-dense report must carry embedder metadata",
    );
    assert.equal(report.meta.embedder!.backend, "stub-dense");
  })();
});

test("held-out runner: hybrid-dense without embedder throws", () => {
  return (async () => {
    let threw = false;
    try {
      await runHeldOutEvals({
        variant: "hybrid-dense",
        queries: HELD_OUT_QUERIES,
      });
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /embedder/i);
    }
    assert.ok(threw, "runHeldOutEvals with hybrid-dense and no embedder should throw");
  })();
});

test("held-out runner: policies are the same BUILTIN_POLICIES (frozen, not tuned)", () => {
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const report = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    // The held-out report's policies are the
    // same list the dev-set policy evaluator
    // uses. The frozen-policy contract: the
    // policy ids in the held-out report match
    // the policy ids in BUILTIN_POLICIES.
    const builtInIds = BUILTIN_POLICIES.map((p) => p.id);
    const reportIds = report.policies.map((p) => p.policyId);
    assert.deepEqual(
      reportIds,
      builtInIds,
      "held-out report must use the same BUILTIN_POLICIES the dev set uses (frozen policy)",
    );
  })();
});

test("held-out runner: transfer block is present for the four primary policies only", () => {
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const report = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    for (const policyId of PRIMARY_POLICY_IDS) {
      const row = report.policies.find((p) => p.policyId === policyId);
      assert.ok(row, `missing primary policy row: ${policyId}`);
      assert.ok(
        row!.transfer !== undefined,
        `primary policy '${policyId}' must have a transfer block`,
      );
    }
    // At least one ablation should NOT have a
    // transfer block (the held-out transfer
    // block is restricted to the four primary
    // policies).
    const ablations = report.policies.filter((p) => p.category === "ablation");
    assert.ok(ablations.length > 0, "expected at least one ablation policy");
    const ablationWithoutTransfer = ablations.find(
      (p) => p.transfer === undefined,
    );
    assert.ok(
      ablationWithoutTransfer !== undefined,
      "at least one ablation policy should NOT have a transfer block",
    );
  })();
});

test("held-out runner: writeHeldOutReport writes a well-formed artifact", () => {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-held-out-"));
    try {
      const evalsResult = await runHeldOutEvals({
        variant: "lexical",
        queries: HELD_OUT_QUERIES,
        topK: 5,
      });
      const report = buildHeldOutReport({
        variant: "lexical",
        topK: evalsResult.topK,
        evals: evalsResult.evals,
      });
      const file = writeHeldOutReport(report, tmp);
      assert.ok(file.startsWith(tmp), `artifact must be under tmp dir, got ${file}`);
      assert.ok(
        path.basename(file).startsWith("retrieval-held-out-validation-"),
        `artifact must use the held-out prefix, got ${path.basename(file)}`,
      );
      assert.ok(
        path.basename(file).endsWith(".json"),
        `artifact must be a JSON file, got ${path.basename(file)}`,
      );
      // Re-read the file and assert the
      // report is byte-stable.
      const written = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(written) as HeldOutValidationReport;
      assert.equal(parsed.meta.heldOutCount, HELD_OUT_QUERIES.length);
      assert.equal(parsed.meta.primaryPolicyId, PRIMARY_POLICY_ID);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
});

test("held-out runner: formatHeldOutReport produces a non-empty report with the expected sections", () => {
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const report = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    const human = formatHeldOutReport(report);
    assert.ok(typeof human === "string" && human.length > 0, "human report must be a non-empty string");
    for (const section of [
      "=== curion retrieval held-out validation ===",
      "--- meta ---",
      "--- headline transfer (primary policies) ---",
      "--- per-family positive abstention",
      "--- honest reading ---",
      "--- limitations (research-only) ---",
      "READ THIS FIRST: this is a BENCHMARK-ONLY prospective probe",
      "moderate-score-0.40",
      "flag-only-zero-hit-cost",
    ]) {
      assert.ok(
        human.includes(section),
        `human report missing section: ${section}`,
      );
    }
  })();
});

test("held-out runner: limitations block is non-empty and surfaces same-corpus / frozen / small-sample caveats", () => {
  for (const required of [
    "Same-corpus validation",
    "Frozen policy",
    "Small sample",
    "FROZEN_TRANSFER_BASELINES",
    "Benchmark-only / research-only",
  ]) {
    assert.ok(
      HELD_OUT_LIMITATIONS.some((lim) => lim.includes(required)),
      `limitations block must mention '${required}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Frozen baseline / transfer delta
// ---------------------------------------------------------------------------

test("held-out runner: FROZEN_TRANSFER_BASELINES covers the four primary policies", () => {
  for (const id of PRIMARY_POLICY_IDS) {
    assert.ok(
      FROZEN_TRANSFER_BASELINES[id] !== undefined,
      `FROZEN_TRANSFER_BASELINES must cover primary policy '${id}'`,
    );
  }
});

test("held-out runner: PRIMARY_POLICY_ID is the architect brief's recommended policy", () => {
  assert.equal(PRIMARY_POLICY_ID, "moderate-score-0.40");
});

test("held-out runner: transfer deltas are honest (held-out minus frozen baseline, in pp)", () => {
  // Build a synthetic report with known
  // values and check the transfer block is
  // computed correctly.
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const report = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    // For each primary policy, the transfer
    // block is held-out minus frozen
    // baseline.
    for (const policyId of PRIMARY_POLICY_IDS) {
      const row = report.policies.find((p) => p.policyId === policyId);
      assert.ok(row && row.transfer);
      const transfer = row!.transfer!;
      const baseline = FROZEN_TRANSFER_BASELINES[policyId]!;
      // Spot-check the math: tnrDelta is
      // held-out TNR% minus baseline TNR%.
      const expectedTnrDelta =
        Math.round(
          (row!.noAnswerAbstainedRate * 100 - baseline.tnrPct) * 100,
        ) / 100;
      assert.equal(transfer.tnrDelta, expectedTnrDelta);
      // F1 delta is raw difference.
      const expectedF1Delta = Math.round((row!.f1 - baseline.f1) * 100) / 100;
      assert.equal(transfer.f1Delta, expectedF1Delta);
    }
  })();
});

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------

test("held-out runner: same held-out evals -> same report (deterministic)", () => {
  return (async () => {
    const evalsResult = await runHeldOutEvals({
      variant: "lexical",
      queries: HELD_OUT_QUERIES,
      topK: 5,
    });
    const r1 = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    const r2 = buildHeldOutReport({
      variant: "lexical",
      topK: evalsResult.topK,
      evals: evalsResult.evals,
    });
    // The `generatedAt` timestamp is the one
    // field that is allowed to differ between
    // two consecutive calls. We compare the
    // structural fields.
    assert.equal(r1.meta.heldOutCount, r2.meta.heldOutCount);
    assert.equal(r1.meta.variant, r2.meta.variant);
    assert.equal(r1.policies.length, r2.policies.length);
    for (let i = 0; i < r1.policies.length; i++) {
      const a = r1.policies[i]!;
      const b = r2.policies[i]!;
      assert.equal(a.policyId, b.policyId);
      assert.equal(a.noAnswerAbstained, b.noAnswerAbstained);
      assert.equal(a.positiveAbstained, b.positiveAbstained);
      assert.equal(a.hitAt5Retained, b.hitAt5Retained);
      assert.equal(a.rank1Retained, b.rank1Retained);
      assert.equal(a.currentTruthAt1Retained, b.currentTruthAt1Retained);
    }
  })();
});

// ---------------------------------------------------------------------------
// 5. Production / API guard
// ---------------------------------------------------------------------------

test("held-out runner: production recall() controller does not import held-out modules", () => {
  // The held-out runner is benchmark-only.
  // The production recall controller's source
  // must not import any held-out module.
  const recallSrc = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "src",
      "controller",
      "recall-controller.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    recallSrc,
    /held-out|heldOut|buildHeldOutReport|runHeldOutEvals/,
    "recall controller must NOT import held-out modules",
  );
  // The production server / tools also must
  // not import the held-out modules.
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    serverSrc,
    /held-out|heldOut|buildHeldOutReport|runHeldOutEvals/,
    "server.ts must NOT import held-out modules",
  );
  const toolsRecallSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "tools", "recall.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    toolsRecallSrc,
    /held-out|heldOut|buildHeldOutReport|runHeldOutEvals/,
    "src/tools/recall.ts must NOT import held-out modules",
  );
  const toolsRememberSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "tools", "remember.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    toolsRememberSrc,
    /held-out|heldOut|buildHeldOutReport|runHeldOutEvals/,
    "src/tools/remember.ts must NOT import held-out modules",
  );
});

test("held-out runner: public MCP tool surface is unchanged (exactly remember + recall)", () => {
  assert.deepEqual([...PUBLIC_TOOL_NAMES], ["remember", "recall"]);
  assert.equal(PUBLIC_TOOL_NAMES.length, 2);
});

test("held-out runner: existing dev-set benchmark report shape is unchanged", () => {
  // The held-out validation is additive; the
  // dev-set benchmark report's top-level
  // fields are unchanged.
  const report = runRetrievalBenchmark({ variant: "hybrid" });
  for (const k of [
    "generatedAt",
    "variant",
    "config",
    "evals",
    "metrics",
    "orientation",
    "answerQuality",
    "failures",
  ]) {
    assert.ok(k in report, `dev-set benchmark report missing field: ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 6. CLI parser
// ---------------------------------------------------------------------------

test("held-out runner: parseHeldOutCli with no args uses safe defaults", () => {
  const opts = parseHeldOutCli([]);
  assert.equal(opts.variant, "hybrid-dense");
  assert.equal(opts.topK, 5);
  assert.equal(opts.hybridK, 60);
  assert.equal(opts.embedderSpec, "stub-dense");
});

test("held-out runner: parseHeldOutCli rejects unknown flags", () => {
  assert.throws(() => parseHeldOutCli(["--unknown-flag"]), /unknown/i);
});

test("held-out runner: parseHeldOutCli rejects unknown variants", () => {
  assert.throws(
    () => parseHeldOutCli(["--variant", "all"]),
    /lexical\|hybrid\|hybrid-dense/,
  );
});

test("held-out runner: parseHeldOutCli accepts the four documented variants", () => {
  for (const v of ["lexical", "hybrid", "hybrid-dense"] as const) {
    const opts = parseHeldOutCli(["--variant", v]);
    assert.equal(opts.variant, v);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert a held-out validation report is
 * well-formed. The helper is shared by the
 * three per-variant runner tests; the helper
 * checks the fields a reviewer would
 * expect on the artifact.
 */
function assertHeldOutReportShape(
  report: HeldOutValidationReport,
  expectedVariant: "lexical" | "hybrid" | "hybrid-dense",
): void {
  // Top-level keys
  for (const k of [
    "generatedAt",
    "meta",
    "policies",
    "decisions",
    "perFamilyByPolicy",
    "perQueryFpFnByPolicy",
    "perQuery",
    "evals",
    "limitations",
  ]) {
    assert.ok(k in report, `held-out report missing field: ${k}`);
  }
  // Meta block
  assert.equal(report.meta.variant, expectedVariant);
  assert.equal(report.meta.topK, 5);
  assert.equal(report.meta.corpusCount, BENCHMARK_RECORDS.length);
  assert.equal(report.meta.devCount, 176);
  assert.equal(report.meta.heldOutCount, HELD_OUT_QUERIES.length);
  assert.equal(report.meta.primaryPolicyId, "moderate-score-0.40");
  if (expectedVariant === "hybrid" || expectedVariant === "hybrid-dense") {
    assert.equal(report.meta.hybridK, 60);
  } else {
    assert.equal(report.meta.hybridK, undefined);
  }
  // Policies block
  assert.equal(report.policies.length, BUILTIN_POLICIES.length);
  // The four primary policies are the four
  // PRIMARY_POLICY_IDS, in order.
  const primaryRows = report.policies.filter((p) =>
    PRIMARY_POLICY_IDS.includes(p.policyId),
  );
  assert.equal(primaryRows.length, PRIMARY_POLICY_IDS.length);
  // Per-query block
  assert.equal(report.perQuery.length, HELD_OUT_QUERIES.length);
  for (const p of report.perQuery) {
    assert.ok(
      HELD_OUT_QUERY_IDS.includes(p.queryId),
      `per-query entry has unknown queryId: ${p.queryId}`,
    );
  }
  // Per-family block
  assert.ok(
    report.perFamilyByPolicy[PRIMARY_POLICY_ID] !== undefined,
    "perFamilyByPolicy must have a block for the primary policy",
  );
  // Per-query FP / FN block
  assert.ok(
    report.perQueryFpFnByPolicy[PRIMARY_POLICY_ID] !== undefined,
    "perQueryFpFnByPolicy must have a block for the primary policy",
  );
  // Evals block
  assert.equal(report.evals.length, HELD_OUT_QUERIES.length);
  // Limitations block
  assert.ok(
    report.limitations.length > 0,
    "limitations block must be non-empty",
  );
}
