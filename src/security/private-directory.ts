/**
 * Create a Curion data directory without exposing newly created Windows data
 * through broad permissions inherited from a parent folder.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type CommandRunner = (file: string, args: string[]) => string;

export interface PrivateDirectoryOptions {
  platform?: NodeJS.Platform;
  windowsRoot?: string;
  runCommand?: CommandRunner;
}

function defaultRunCommand(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

function protectWindowsDirectory(dir: string, options: PrivateDirectoryOptions): void {
  const root = options.windowsRoot ?? process.env.SystemRoot ?? process.env.WINDIR;
  if (!root || !path.win32.isAbsolute(root)) {
    throw new Error(
      "Windows system directory unavailable; refusing to create unprotected Curion data"
    );
  }

  const run = options.runCommand ?? defaultRunCommand;
  const whoami = path.win32.join(root, "System32", "whoami.exe");
  const icacls = path.win32.join(root, "System32", "icacls.exe");
  const identity = run(whoami, ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/\bS-\d+(?:-\d+){2,}\b/)?.[0];
  if (!sid) {
    throw new Error(
      "Cannot determine Windows account SID; refusing to create unprotected Curion data"
    );
  }

  // Grant rights first, then remove inherited ACEs. Files created after this
  // inherit only these explicit rights, even under a shared parent directory.
  run(icacls, [
    dir,
    "/grant:r",
    "*" + sid + ":(OI)(CI)F",
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  run(icacls, [dir, "/inheritance:r"]);
}

/**
 * Return true if a new Curion directory was created. Existing folders are not
 * modified or migrated, which requires a separate opt-in security procedure.
 */
export function ensurePrivateDirectory(
  dir: string,
  options: PrivateDirectoryOptions = {}
): boolean {
  if (fs.existsSync(dir)) return false;

  if ((options.platform ?? process.platform) !== "win32") {
    return fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  }

  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });

  // No data is written into this staging directory before its NTFS ACL is
  // protected. A same-directory rename preserves ACLs on Windows.
  const staged = fs.mkdtempSync(path.join(parent, ".curion-private-"));
  try {
    protectWindowsDirectory(staged, options);
    // Do not replace even an empty destination created by another process.
    if (fs.existsSync(dir)) return false;
    try {
      fs.renameSync(staged, dir);
    } catch (err) {
      // Another process may have created the destination first.
      if (fs.existsSync(dir)) return false;
      throw err;
    }
    return true;
  } finally {
    // This removes only our empty staging folder, never user data.
    if (fs.existsSync(staged)) fs.rmdirSync(staged);
  }
}
