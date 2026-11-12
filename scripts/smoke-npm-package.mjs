#!/usr/bin/env node
/** Smoke-test the packed npm artifact using a disposable consumer directory. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "curion-package-smoke-"));
const packDir = path.join(temp, "pack");
const consumer = path.join(temp, "consumer");

function runNpm(args, cwd) {
  assert.ok(process.env.npm_execpath, "Invoke via npm run test:package");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, "npm failed: " + (result.error?.message ?? result.stderr));
  return result.stdout;
}

try {
  fs.mkdirSync(packDir);
  fs.mkdirSync(consumer);
  const [artifact] = JSON.parse(
    runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], root)
  );
  assert.equal(artifact.name, pkg.name);
  assert.equal(artifact.version, pkg.version);
  const files = artifact.files.map((file) => file.path);
  assert.ok(files.includes("dist/index.js"), "Missing packaged entrypoint");
  assert.ok(
    !files.some((entry) => /(^|\/)(\.curion|\.env|tests|node_modules)(\/|$)/.test(entry)),
    "Unsafe package content"
  );
  runNpm(["install", "--no-audit", "--no-fund", path.join(packDir, artifact.filename)], consumer);
  const entry = path.join(consumer, "node_modules", "@geanatz", "curion", "dist", "index.js");
  for (const [flag, expected] of [
    ["--version", pkg.version],
    ["--help", "remember"],
  ]) {
    const result = spawnSync(process.execPath, [entry, flag], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, flag + " failed: " + result.stderr);
    assert.ok(result.stdout.includes(expected), flag + " missing expected output");
  }
  assert.ok(!fs.existsSync(path.join(consumer, ".curion")), "Help/version created a memory store");
  process.stdout.write(
    "PASS: packed npm artifact installs and CLI works without creating runtime state\n"
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
