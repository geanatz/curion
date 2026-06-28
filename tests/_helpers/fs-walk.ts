/**
 * Shared filesystem walker.
 *
 * Returns the relative paths of all `.ts` files under `dir`.
 * Default excludes `.d.ts` (the dominant variant across the
 * suite); pass `{ excludeDts: false }` for the inclusive variant.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function walkTs(
  dir: string,
  opts: { excludeDts?: boolean } = {},
  root: string = dir,
): string[] {
  const { excludeDts = true } = opts;
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTs(full, opts, root));
    } else if (
      entry.endsWith(".ts") &&
      (!excludeDts || !entry.endsWith(".d.ts"))
    ) {
      results.push(relative(root, full));
    }
  }
  return results;
}