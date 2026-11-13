/**
 * Native Windows regression guard for newly created Curion data directories.
 * Runs only on Windows, with synthetic stores under os.tmpdir().
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { writeProjectConfig } from "../src/config/project-config.ts";
import { ensurePrivateDirectory } from "../src/security/private-directory.ts";
import { closeStorage, initStorage } from "../src/storage/storage.ts";
import { closeTraceStorage, initTraceStorage } from "../src/trace/trace-storage.ts";

test(
  "native NTFS: private files do not inherit broad read from a shared Windows parent",
  { skip: process.platform !== "win32" },
  (t) => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    assert.ok(systemRoot, "Windows SystemRoot is required");
    const icacls = path.win32.join(systemRoot, "System32", "icacls.exe");
    const powershell = path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "curion-native-ntfs-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const script = path.join(root, "inspect-acl.ps1");
    fs.writeFileSync(
      script,
      [
        "param([string]$Target, [string]$Mode)",
        '$ErrorActionPreference = "Stop"',
        "$acl = Get-Acl -LiteralPath $Target",
        "$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
        '$broad = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545")',
        "$readBit = [int][System.Security.AccessControl.FileSystemRights]::ReadData",
        "$found = @($rules | Where-Object {",
        "  $broad -contains $_.IdentityReference.Value -and",
        "  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and",
        "  (([int]$_.FileSystemRights -band $readBit) -ne 0)",
        "})",
        'if ($Mode -eq "control") {',
        '  if (@($found | Where-Object { $_.IdentityReference.Value -eq "S-1-1-0" }).Count -eq 0) { throw "No Everyone read on shared control" }',
        "} elseif ($found.Count -gt 0) {",
        '  throw ("Broad read remains on private Curion path: " + $Target)',
        "}",
        'if ($Mode -eq "protected" -and -not $acl.AreAccessRulesProtected) { throw "NTFS inheritance remains active on private directory" }',
      ].join("\n")
    );

    const inspect = (target: string, mode: "control" | "private" | "protected"): void => {
      execFileSync(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Target",
          target,
          "-Mode",
          mode,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 }
      );
    };

    for (const label of ["ordinary", "shared"]) {
      const projectRoot = path.join(root, label);
      fs.mkdirSync(projectRoot);
      if (label === "shared") {
        execFileSync(icacls, [projectRoot, "/grant", "*S-1-1-0:(OI)(CI)(R)"], {
          windowsHide: true,
          timeout: 10_000,
        });
        inspect(projectRoot, "control");
      }

      const storage = initStorage({ projectRoot });
      try {
        storage.db
          .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)")
          .run("synthetic", "1");
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = storage.dbPath + suffix;
          if (fs.existsSync(sidecar)) inspect(sidecar, "private");
        }
      } finally {
        closeStorage(storage);
      }

      const trace = initTraceStorage({ projectRoot });
      try {
        trace.db
          .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)")
          .run("synthetic", "1");
      } finally {
        closeTraceStorage(trace);
      }

      writeProjectConfig(projectRoot, { version: 1, isPrivate: true });
      const dataDir = path.join(projectRoot, ".curion");
      inspect(dataDir, "protected");
      for (const file of ["curion.sqlite", "trace.sqlite", "config.json"]) {
        const target = path.join(dataDir, file);
        assert.ok(fs.existsSync(target), "missing synthetic Curion file " + file);
        inspect(target, "private");
      }

      const registryDir = path.join(projectRoot, "synthetic-home", ".curion");
      assert.equal(ensurePrivateDirectory(registryDir), true);
      fs.writeFileSync(path.join(registryDir, "registry.json"), '{"projects":{}}');
      inspect(registryDir, "protected");
      inspect(path.join(registryDir, "registry.json"), "private");
    }
  }
);
