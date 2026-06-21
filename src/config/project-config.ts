/**
 * Per-project configuration file.
 *
 * Lives at `<projectRoot>/.curion/config.json`.
 *
 * Schema:
 *   {
 *     "version": 1,
 *     "isPrivate": boolean
 *   }
 *
 * Privacy model:
 *   - A private project is invisible outside itself: no memories,
 *     no labels, no hints. Its config file should exist with
 *     `isPrivate: true`.
 *   - Non-private projects (or projects with no config file)
 *     are visible to the cross-project recall system.
 *
 * Parsing rules:
 *   - Missing config file -> defaults to non-private (isPrivate: false).
 *   - Malformed JSON -> defaults to non-private (safe: we don't want
 *     to accidentally hide a project that happens to have a corrupt
 *     config file).
 *   - Malformed values -> defaults to non-private.
 */

import path from "node:path";
import fs from "node:fs";
import { resolveCurionDir, CURION_DIRNAME } from "../storage/storage.js";
import { logger } from "../logging/logger.js";

export interface ProjectConfig {
  version: number;
  isPrivate: boolean;
}

/** The expected current config schema version. */
export const CURRENT_CONFIG_VERSION = 1;

/** Default config for projects without a config file (non-private). */
const DEFAULT_CONFIG: ProjectConfig = {
  version: CURRENT_CONFIG_VERSION,
  isPrivate: false,
};

/**
 * Resolve the path to the per-project config file.
 * Does not check existence.
 */
export function resolveProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, CURION_DIRNAME, "config.json");
}

/**
 * Read and parse the per-project config file.
 *
 * Missing file, malformed JSON, unknown fields, or missing fields
 * all default to non-private (isPrivate: false). This is the safe
 * default: we do not want to accidentally hide a project due to a
 * corrupt config file.
 *
 * Does not throw.
 */
export function readProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = resolveProjectConfigPath(projectRoot);
  try {
    if (!fs.existsSync(configPath)) {
      return DEFAULT_CONFIG;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    if (raw.trim().length === 0) {
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.debug(`project config: non-object at ${configPath}, defaulting to non-private`);
      return DEFAULT_CONFIG;
    }
    const obj = parsed as Record<string, unknown>;
    // `version` field: must be a finite number; ignore if missing.
    const version =
      typeof obj.version === "number" && Number.isFinite(obj.version)
        ? Math.trunc(obj.version)
        : CURRENT_CONFIG_VERSION;
    // `isPrivate` field: must be a boolean; default to false if missing or wrong type.
    const isPrivate =
      typeof obj.isPrivate === "boolean" ? obj.isPrivate : false;
    return { version, isPrivate };
  } catch (err) {
    logger.debug(`project config: read error at ${configPath}, defaulting to non-private: ${(err as Error).message}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Write the per-project config file.
 *
 * The write is best-effort: errors are logged but not thrown,
 * so the caller cannot break the tool path on config write failures.
 */
export function writeProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const configPath = resolveProjectConfigPath(projectRoot);
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    fs.chmodSync(configPath, 0o600);
    logger.debug(`project config: wrote ${configPath}`);
  } catch (err) {
    logger.error(`project config: write failed at ${configPath}: ${(err as Error).message}`);
  }
}

/**
 * Check whether a project is marked private.
 *
 * Returns `false` (non-private) if the config file is missing,
 * malformed, or has `isPrivate: false`. Returns `true` only when
 * the config file exists, parses successfully, and explicitly
 * sets `isPrivate: true`.
 */
export function isProjectPrivate(projectRoot: string): boolean {
  return readProjectConfig(projectRoot).isPrivate;
}

/**
 * Set the private flag on a project.
 *
 * Creates the config file if it doesn't exist (with version: 1).
 * Updates `isPrivate` if the file already exists.
 */
export function setProjectPrivate(projectRoot: string, isPrivate: boolean): void {
  // Start with the existing config so we preserve any future fields.
  const existing = readProjectConfig(projectRoot);
  const updated: ProjectConfig = {
    version: CURRENT_CONFIG_VERSION,
    isPrivate,
  };
  writeProjectConfig(projectRoot, updated);
}
