/**
 * Benchmark-only decision-policy evaluation CLI runner.
 *
 * A small CLI that runs the decision-policy evaluation helper
 * (`src/benchmark/decision-policy-evaluation.ts`) and writes
 * the JSON artifact under `.curion/benchmark/`.
 *
 * The runner mirrors the canonical adaptive-depth runner flag
 * style: `--artifacts <path>` overrides the JSON report
 * directory; default is `.curion/benchmark/` under cwd.
 * `--no-write` suppresses the JSON artifact (the human report
 * still prints). `--live` is the MANUAL opt-in for live-mode
 * evaluation against the real configured provider/model.
 *
 * Live-mode opt-in (BOTH required):
 *
 *   1. `CURION_DECISION_EVAL_LIVE=1` env var must be set.
 *   2. `--live` CLI flag must be passed.
 *
 * The runner refuses to enable live mode unless BOTH signals
 * are present. The harness additionally validates the pair
 * inside `runDecisionPolicyEvaluation` so a programmatic
 * caller cannot reach the live path by setting only one. A
 * user who passes `--live` without the env flag (or vice
 * versa) gets a clear error on stderr and an exit code of 1;
 * the run is NEVER started in either case. This is the
 * "impossible to run accidentally" safety contract.
 *
 * Behaviour:
 *   - Runs the full evaluation (26 scenarios in v2) in-process.
 *   - Builds the evaluation report and (optionally) writes the
 *     JSON artifact under `.curion/benchmark/`.
 *   - Prints the human summary to stdout.
 *   - Exits with code 0 on success; code 1 on any unexpected
 *     error.
 *
 * Security:
 *   - In scripted mode (default), no API keys, no Authorization
 *     headers, no live network. The scripted fetch in the helper
 *     returns canned responses in-process.
 *   - In live mode (manual opt-in), the harness invokes the
 *     real configured provider/model WITHOUT a `fetchImpl`
 *     override. This DOES make a real HTTP call and DOES
 *     incur cost / latency. The captured decision is recorded
 *     on the artifact but is NEVER applied to persisted
 *     memory or any controller state. Live mode does NOT
 *     activate the production decision engine: the existing
 *     `CURION_REMEMBER_DECISION_MODE` env var is untouched.
 *   - The seeded evidence packets carry only safe text (no
 *     secrets, no raw input fields). The controller's safety
 *     pre-check is bypassed (the harness builds packets
 *     directly); the scripted inputs are written to be safe.
 *   - No production storage is touched.
 *
 * Scope (benchmark-only):
 *   The CLI is read-only. It does not write to the production
 *   storage; the only on-disk effect is the JSON report under
 *   `.curion/benchmark/`. It does NOT modify the production
 *   `remember(text)` behavior, the public MCP API, or the
 *   existing dev-set / audit / calibration / policy / held-out
 *   / adaptive-depth-evaluation report shapes.
 *
 * Why this is a separate entry point:
 *   The adaptive-depth runner is a thin read-path harness over
 *   the recall controller. The decision-policy evaluation is a
 *   SEPARATE study with its own scenario set (the remember-
 *   policy decision vocabulary), its own code path (the
 *   decision adapter), and its own report shape. A reviewer who
 *   wants to audit the decision-policy evaluation reads this
 *   file plus `src/benchmark/decision-policy-evaluation.ts`
 *   and `tests/decision-policy-evaluation.test.ts`; the
 *   adaptive-depth runner is not part of the decision-policy
 *   read path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../config/env-loader.js";
import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  DECISION_POLICY_EVAL_LIVE_ENV,
  formatDecisionPolicyEvaluationReport,
  isLiveOptInEnv,
  runDecisionPolicyEvaluation,
  writeDecisionPolicyEvaluationReport,
} from "./decision-policy-evaluation.js";

/**
 * Env-loading helper for the decision-policy evaluation CLI.
 *
 * The decision adapter's provider config
 * (`CURION_PRIMARY_*` / `CURION_FALLBACK_*` /
 * `CURION_ADAPTER_*`) is read from `process.env` directly,
 * matching the production code path. A user running live
 * mode by hand typically keeps those vars in a local `.env`
 * (the same file the prototype runner reads). This helper
 * loads `.env` into `process.env` BEFORE mode resolution so:
 *
 *   1. `CURION_DECISION_EVAL_LIVE=1` in `.env` is visible to
 *      `isLiveOptInEnv(process.env)` at mode-resolution
 *      time.
 *   2. `CURION_PRIMARY_*` / `CURION_FALLBACK_*` in `.env` is
 *      visible to `loadDecisionAdapterConfig` (called inside
 *      `runSingleScenario`) so the live run actually has a
 *      provider to call.
 *
 * The helper is the single source of truth for "did the
 * runner load `.env` for this run?" The result is surfaced
 * on stderr so a user running live mode by hand sees the
 * load status without having to inspect process state. The
 * helper is exported so tests can drive it with a temp
 * `.env` and assert the integration end-to-end.
 *
 * Safety:
 *   - `loadDotEnv` does NOT overwrite existing `process.env`
 *     values (`override: false` by default), so a user who
 *     explicitly exports a value keeps it.
 *   - The helper returns the keys it set, not the values.
 *     A reviewer reading stderr cannot recover secret values
 *     from the load report.
 *   - The helper does NOT weaken the double opt-in. Even
 *     when the env file sets `CURION_DECISION_EVAL_LIVE=1`,
 *     live mode is unreachable without the `--live` CLI
 *     flag. The gate is enforced by `resolveEvaluationMode`
 *     and `runDecisionPolicyEvaluation` AFTER this helper
 *     runs.
 *
 * The default `.env` path is the project-pattern
 * `process.cwd()/.env` (set by `loadDotEnv`). A test or
 * alternate runner can pass `path` to point at a fixture.
 */
export function prepareDecisionPolicyEvaluationEnv(
  options: { path?: string; skip?: boolean } = {}
): {
  path: string;
  loaded: boolean;
  keyCount: number;
  keys: string[];
  skipped: string[];
  error?: string;
} {
  const result = loadDotEnv({
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.skip !== undefined ? { skip: options.skip } : {}),
  });
  return {
    path: result.path,
    loaded: result.loaded,
    keyCount: result.keys.length,
    keys: result.keys,
    skipped: result.skipped,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/**
 * Parse the decision-policy evaluation CLI args. The
 * runner's CLI surface is narrow: `--artifacts`,
 * `--no-write`, `--no-stdout`, and `--live`. A flag not
 * recognised is a hard error; the brief is explicit that the
 * decision-policy evaluation CLI is a narrow tool, not a
 * general benchmark runner.
 *
 * The parser is a thin wrapper over the shared
 * `parseBenchmarkArtifactCli` helper so the runner, the
 * adaptive-depth runner, and any future benchmark runner
 * share the same parsing semantics. The per-runner label
 * (`"decision-policy evaluation"`) is preserved verbatim
 * from the inline implementation so the existing tests'
 * error-message regex assertion (`/unknown decision-policy
 * evaluation cli flag/`) keeps passing.
 */
export function parseDecisionPolicyEvaluationCli(argv: ReadonlyArray<string>): {
  artifactsDir: string;
  noWrite: boolean;
  noStdout: boolean;
  live: boolean;
} {
  return parseBenchmarkArtifactCli(argv, {
    supportNoWrite: true,
    supportNoStdout: true,
    supportLive: true,
    contextLabel: "decision-policy evaluation",
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return argvPath === thisPath;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[curion-decision-policy-eval] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Decide which evaluation mode the runner should invoke.
 * The helper is pure: same inputs → same mode. It is the
 * single source of truth for the live-mode gating the runner
 * applies at the CLI boundary.
 *
 * Returns:
 *   - `{ kind: "live" }` when BOTH `--live` AND
 *     `CURION_DECISION_EVAL_LIVE=1` are present.
 *   - `{ kind: "scripted-misconfig", missing: [...] }` when
 *     exactly one signal is present. The runner prints a
 *     clear notice on stderr (and refuses to enable live
 *     mode) so a user who set only one signal gets an
 *     unambiguous hint rather than a silent scripted
 *     fallback.
 *   - `{ kind: "scripted" }` when neither signal is present
 *     (the default).
 */
function resolveEvaluationMode(args: {
  liveCliFlag: boolean;
  env: NodeJS.ProcessEnv;
}): { kind: "live" } | { kind: "scripted" } | { kind: "scripted-misconfig"; missing: string[] } {
  const envFlag = isLiveOptInEnv(args.env);
  if (args.liveCliFlag && envFlag) {
    return { kind: "live" };
  }
  if (args.liveCliFlag && !envFlag) {
    return {
      kind: "scripted-misconfig",
      missing: [`env ${DECISION_POLICY_EVAL_LIVE_ENV}=1`],
    };
  }
  if (!args.liveCliFlag && envFlag) {
    return {
      kind: "scripted-misconfig",
      missing: ["CLI --live flag"],
    };
  }
  return { kind: "scripted" };
}

/**
 * Main entry point. The function is async because
 * `runDecisionPolicyEvaluation` is async. The function is
 * `void main()` (not exported) because the CLI is a one-shot
 * tool: the test surface imports the helper directly.
 */
async function main(): Promise<void> {
  // Load the project's local `.env` (if present) into
  // `process.env` BEFORE resolving the run mode. The
  // decision adapter reads provider config directly from
  // `process.env`, and a user running live mode by hand
  // typically keeps `CURION_PRIMARY_*` / `CURION_FALLBACK_*`
  // (and the `CURION_DECISION_EVAL_LIVE=1` opt-in) in a
  // local `.env`. Without this load, the live path always
  // short-circuits on `missing-config` even after the
  // double opt-in is satisfied.
  //
  // Safety contract:
  //   - The load is opt-in: when no `.env` exists, the
  //     helper is a no-op.
  //   - The load does NOT overwrite values already in
  //     `process.env` (an explicitly-exported value wins).
  //   - The load does NOT weaken the double opt-in: live
  //     mode still requires BOTH `CURION_DECISION_EVAL_LIVE=1`
  //     AND `--live`. The gate is enforced AFTER this load
  //     by `resolveEvaluationMode` and inside
  //     `runDecisionPolicyEvaluation`.
  //   - The load result is logged to stderr with KEY NAMES
  //     ONLY — never values, never secret material. A
  //     reviewer reading the stderr trace cannot recover
  //     API keys from the load report.
  const envPrep = prepareDecisionPolicyEvaluationEnv();
  if (envPrep.loaded) {
    process.stderr.write(
      `[curion-decision-policy-eval] NOTICE: loaded ${envPrep.keyCount} key(s) from ${envPrep.path} (override=false; existing process.env values preserved). Key names not echoed.\n`
    );
  } else if (envPrep.error !== undefined) {
    process.stderr.write(
      `[curion-decision-policy-eval] NOTICE: failed to read ${envPrep.path}: ${envPrep.error}. Continuing with the current process.env.\n`
    );
  }
  const opts = parseDecisionPolicyEvaluationCli(process.argv.slice(2));
  const cliArgs = process.argv.slice(2);
  const mode = resolveEvaluationMode({
    liveCliFlag: opts.live,
    env: process.env,
  });

  if (mode.kind === "scripted-misconfig") {
    // The runner refuses to enable live mode unless BOTH
    // signals are present. We surface a clear notice on
    // stderr so the user sees exactly which signal is
    // missing. The run is NOT started in either case.
    process.stderr.write(
      `[curion-decision-policy-eval] NOTICE: --live was passed but ${mode.missing.join(
        " AND "
      )} is also required. Live mode is impossible to reach accidentally; falling back to scripted mode. Set ${DECISION_POLICY_EVAL_LIVE_ENV}=1 AND pass --live to enable live mode (this WILL invoke the real configured provider/model and WILL incur cost).\n`
    );
  }

  const report = await runDecisionPolicyEvaluation({
    mode: mode.kind === "live" ? "live" : "scripted",
    envOptInFlag: isLiveOptInEnv(process.env),
    cliArgs,
  });
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeDecisionPolicyEvaluationReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatDecisionPolicyEvaluationReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
