/**
 * Shared test storage helpers.
 *
 * These functions create and tear down isolated storage handles
 * for tests that need to exercise the controller / storage layer
 * without touching the developer's real `~/.curion/` directory.
 *
 * The `mkStorage` helper accepts an optional prefix (default
 * `"curion-test-"`) so tests that want descriptive `os.tmpdir()`
 * labels can supply their own. Body shape (initStorage + handle)
 * and teardown (close db + rmSync) come from the canonical
 * `tests/recall-mvp.test.ts` implementation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type StorageHandle, initStorage } from "../../src/storage/storage.ts";

export function mkStorage(prefix = "curion-test-"): { tmp: string; handle: StorageHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const handle = initStorage({ projectRoot: tmp });
  return { tmp, handle };
}

export function rmStorage(tmp: string, handle: StorageHandle): void {
  try {
    handle.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
