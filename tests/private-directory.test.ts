import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ensurePrivateDirectory } from "../src/security/private-directory.ts";

function fixture(t: { after: (fn: () => void) => void }): { root: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curion-private-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, ".curion") };
}

test("private directory: POSIX new directory uses 0700 without Windows commands", (t) => {
  const { dir } = fixture(t);
  let commands = 0;
  assert.equal(
    ensurePrivateDirectory(dir, {
      platform: "linux",
      runCommand: () => {
        commands++;
        throw new Error("no Windows commands on Linux");
      },
    }),
    true
  );
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(commands, 0);
  assert.equal(ensurePrivateDirectory(dir, { platform: "linux" }), false);
});

test("private directory: Windows new dir is staged, granted SID rights and de-inherited before rename", (t) => {
  const { root, dir } = fixture(t);
  const calls: Array<{ file: string; args: string[] }> = [];
  const runCommand = (file: string, args: string[]): string => {
    calls.push({ file, args });
    if (file.toLowerCase().endsWith("whoami.exe")) return '"user","S-1-5-21-11-22-33-1001"\r\n';
    return "";
  };
  assert.equal(
    ensurePrivateDirectory(dir, {
      platform: "win32",
      windowsRoot: "C:\\Windows",
      runCommand,
    }),
    true
  );
  assert.equal(calls.length, 3);
  assert.match(calls[0].file, /whoami\.exe$/i);
  assert.match(calls[1].file, /icacls\.exe$/i);
  assert.match(calls[2].file, /icacls\.exe$/i);
  assert.ok(calls[1].args.includes("/grant:r"));
  assert.ok(calls[1].args.includes("*S-1-5-21-11-22-33-1001:(OI)(CI)F"));
  assert.ok(calls[1].args.includes("*S-1-5-18:(OI)(CI)F"));
  assert.ok(calls[1].args.includes("*S-1-5-32-544:(OI)(CI)F"));
  assert.ok(calls[2].args.includes("/inheritance:r"));
  assert.equal(calls[1].args[0], calls[2].args[0]);
  assert.notEqual(calls[1].args[0], dir);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.readdirSync(root).filter((p) => p.startsWith(".curion-private-")).length, 0);
});

test("private directory: an existing Windows folder is not reprotected or modified", (t) => {
  const { dir } = fixture(t);
  fs.mkdirSync(dir);
  let called = false;
  assert.equal(
    ensurePrivateDirectory(dir, {
      platform: "win32",
      windowsRoot: "C:\\Windows",
      runCommand: () => {
        called = true;
        throw new Error("should not run");
      },
    }),
    false
  );
  assert.equal(called, false);
});

test("private directory: failed Windows icacls prevents creation of final data directory", (t) => {
  const { root, dir } = fixture(t);
  assert.throws(
    () =>
      ensurePrivateDirectory(dir, {
        platform: "win32",
        windowsRoot: "C:\\Windows",
        runCommand: (file, args) => {
          if (file.toLowerCase().endsWith("whoami.exe")) return '"user","S-1-5-21-11-22-33-1001"';
          if (args.includes("/inheritance:r")) throw new Error("simulated ACL failure");
          return "";
        },
      }),
    /simulated ACL failure/
  );
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readdirSync(root).filter((p) => p.startsWith(".curion-private-")).length, 0);
});

test("private directory: missing SID refuses to create data", (t) => {
  const { dir } = fixture(t);
  assert.throws(
    () =>
      ensurePrivateDirectory(dir, {
        platform: "win32",
        windowsRoot: "C:\\Windows",
        runCommand: () => '"unknown","invalid"',
      }),
    /SID/
  );
  assert.equal(fs.existsSync(dir), false);
});
