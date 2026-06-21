/**
 * Central project registry / address book.
 *
 * - Lives at `~/.curion/registry.json`.
 * - Tracks known projects by absolute projectRoot path.
 * - Stores only registry metadata: displayName (basename), firstSeenAt,
 *   lastSeenAt timestamps.
 * - NO memory content is ever stored in the registry.
 *
 * Privacy model:
 *   - Private projects are NOT tracked in the registry (they are
 *     identified by the per-project config file, not here).
 *   - The registry only knows about non-private projects that
 *     Curion has run in.
 *   - A project becomes "known" when Curion successfully runs
 *     `remember` or `recall` there and the project is not private.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { logger } from "../logging/logger.js";

const REGISTRY_DIRNAME = ".curion";
const REGISTRY_FILENAME = "registry.json";

export interface RegistryEntry {
  /** Absolute path to the project root. Used as the key. */
  projectRoot: string;
  /** Human-readable display name (directory basename). */
  displayName: string;
  /** Unix ms timestamp when the project was first registered. */
  firstSeenAt: number;
  /** Unix ms timestamp when the project was last seen/updated. */
  lastSeenAt: number;
}

export interface Registry {
  /** Entries keyed by absolute projectRoot path. */
  projects: Record<string, RegistryEntry>;
}

/** Default empty registry structure. */
const EMPTY_REGISTRY: Registry = { projects: {} };

/**
 * Resolve the path to the central registry file.
 * Creates the `~/.curion/` directory with mode 0700 if missing.
 *
 * Does not create the registry file itself.
 */
export function resolveRegistryPath(): { dir: string; file: string } {
  const dir = path.join(os.homedir(), REGISTRY_DIRNAME);
  const file = path.join(dir, REGISTRY_FILENAME);
  return { dir, file };
}

/**
 * Ensure the `~/.curion/` directory exists with mode 0700.
 * Idempotent and best-effort: failures are logged and ignored.
 */
export function ensureRegistryDir(): void {
  const { dir } = resolveRegistryPath();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      logger.info(`created registry directory at ${dir}`);
    } else {
      // Ensure correct permissions even if directory already exists.
      fs.chmodSync(dir, 0o700);
    }
  } catch (err) {
    logger.debug(`ensureRegistryDir: ${(err as Error).message}`);
  }
}

/**
 * Read and parse the central registry.
 *
 * Malformed or missing registry is treated as empty — the caller
 * should use the return value directly without additional guards.
 *
 * Does not throw on parse errors or IO errors; returns the empty
 * registry instead.
 */
export function readRegistry(): Registry {
  const { file } = resolveRegistryPath();
  try {
    if (!fs.existsSync(file)) {
      return EMPTY_REGISTRY;
    }
    const raw = fs.readFileSync(file, "utf-8");
    if (raw.trim().length === 0) {
      return EMPTY_REGISTRY;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).projects === "object"
    ) {
      return parsed as Registry;
    }
    logger.warn("registry: malformed top-level structure, treating as empty");
    return EMPTY_REGISTRY;
  } catch (err) {
    logger.warn(`registry: read error, treating as empty: ${(err as Error).message}`);
    return EMPTY_REGISTRY;
  }
}

/**
 * Write the registry atomically (temp file + rename).
 *
 * The write is best-effort: errors are logged but not thrown,
 * so the caller cannot break the tool path on registry write
 * failures.
 */
export function writeRegistry(registry: Registry): void {
  const { dir, file } = resolveRegistryPath();
  try {
    ensureRegistryDir();
    // Atomic write: write to temp file then rename.
    const tmpFile = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2), "utf-8");
    // Set restrictive permissions on the temp file before rename.
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, file);
    logger.debug(`registry: wrote ${Object.keys(registry.projects).length} entries`);
  } catch (err) {
    logger.error(`registry: write failed: ${(err as Error).message}`);
  }
}

/**
 * Register (or update) a project in the central registry.
 *
 * - If the project is already registered, updates `lastSeenAt`.
 * - If the project is new, creates an entry with `firstSeenAt = lastSeenAt`.
 * - The entry is keyed by the absolute `projectRoot`.
 * - Display name is derived from `path.basename(projectRoot)`.
 *
 * Does NOT track private projects — the caller is responsible for
 * checking `isProjectPrivate` before calling this.
 */
export function registerProject(projectRoot: string): void {
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    logger.debug(`registerProject: non-absolute path skipped: ${projectRoot}`);
    return;
  }
  const registry = readRegistry();
  const now = Date.now();
  const displayName = path.basename(projectRoot);
  if (registry.projects[projectRoot]) {
    registry.projects[projectRoot].lastSeenAt = now;
    // Update displayName in case the directory was renamed.
    registry.projects[projectRoot].displayName = displayName;
  } else {
    registry.projects[projectRoot] = {
      projectRoot,
      displayName,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }
  writeRegistry(registry);
}

/**
 * Remove a project from the central registry.
 *
 * Silently succeeds if the project is not registered.
 */
export function unregisterProject(projectRoot: string): void {
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    return;
  }
  const registry = readRegistry();
  if (registry.projects[projectRoot]) {
    delete registry.projects[projectRoot];
    writeRegistry(registry);
  }
}

/**
 * List all registered project entries.
 *
 * Returns an array of RegistryEntry in no particular order.
 * Returns empty array if the registry is missing or malformed.
 *
 * Test hook: when `setListRegisteredProjectsStub` has been called,
 * the stub is used instead of the real registry, enabling isolated
 * unit tests that are not affected by the developer's real
 * `~/.curion/registry.json`.
 */
export function listRegisteredProjects(): RegistryEntry[] {
  if (listRegisteredProjectsStub !== null) {
    return listRegisteredProjectsStub();
  }
  const registry = readRegistry();
  return Object.values(registry.projects);
}

// ---------------------------------------------------------------------------
// Test stubs
// ---------------------------------------------------------------------------

/**
 * Test hook: override `listRegisteredProjects` for isolated unit tests.
 * Production code does not call this.
 */
let listRegisteredProjectsStub: (() => RegistryEntry[]) | null = null;

/**
 * Test hook: override `listRegisteredProjects`.
 * Production code does not call this.
 */
export function setListRegisteredProjectsStub(
  stub: () => RegistryEntry[],
): void {
  listRegisteredProjectsStub = stub;
}

/**
 * Test hook: reset `listRegisteredProjects` to the real implementation.
 * Production code does not call this.
 */
export function resetListRegisteredProjectsStub(): void {
  listRegisteredProjectsStub = null;
}
