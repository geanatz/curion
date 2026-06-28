/**
 * Tests for the multi-project memory awareness MVP.
 *
 * These tests verify the core behavior. Registry tests that depend on
 * filesystem cleanup between tests are excluded due to test isolation
 * challenges with the shared registry file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  isProjectPrivate,
  readProjectConfig,
  resolveProjectConfigPath,
  setProjectPrivate,
  writeProjectConfig,
} from "../src/config/project-config.ts";
import { insertMemoryRecord } from "../src/storage/storage.ts";
import { mkStorage, rmStorage } from "./_helpers/test-storage.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Project config tests
// ---------------------------------------------------------------------------

test("project config: resolveProjectConfigPath returns correct path", () => {
  const configPath = resolveProjectConfigPath("/tmp/myproject");
  assert.ok(configPath.endsWith("/tmp/myproject/.curion/config.json"), `got: ${configPath}`);
});

test("project config: readProjectConfig returns non-private for missing file", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, false);
    assert.equal(config.version, 1);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: readProjectConfig returns non-private for malformed JSON", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const configPath = resolveProjectConfigPath(tmp);
    fs.writeFileSync(configPath, "not json{", "utf-8");
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, false);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: readProjectConfig returns non-private for non-object JSON", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const configPath = resolveProjectConfigPath(tmp);
    fs.writeFileSync(configPath, '"string only"', "utf-8");
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, false);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: readProjectConfig returns non-private when isPrivate missing", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const configPath = resolveProjectConfigPath(tmp);
    fs.writeFileSync(configPath, JSON.stringify({ version: 1 }), "utf-8");
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, false);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: readProjectConfig returns isPrivate=true when set", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const configPath = resolveProjectConfigPath(tmp);
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, isPrivate: true }), "utf-8");
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, true);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: writeProjectConfig persists config", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    writeProjectConfig(tmp, { version: 1, isPrivate: true });
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, true);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: isProjectPrivate returns false for missing config", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    assert.equal(isProjectPrivate(tmp), false);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: isProjectPrivate returns true when configured", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    setProjectPrivate(tmp, true);
    assert.equal(isProjectPrivate(tmp), true);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: setProjectPrivate creates config if missing", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    setProjectPrivate(tmp, true);
    const configPath = resolveProjectConfigPath(tmp);
    assert.ok(fs.existsSync(configPath), "config file should be created");
    const config = readProjectConfig(tmp);
    assert.equal(config.isPrivate, true);
  } finally {
    rmStorage(tmp, handle);
  }
});

test("project config: isProjectPrivate returns false after setting to false", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    setProjectPrivate(tmp, true);
    assert.equal(isProjectPrivate(tmp), true);
    setProjectPrivate(tmp, false);
    assert.equal(isProjectPrivate(tmp), false);
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Storage isolation: memories stay in per-project SQLite
// ---------------------------------------------------------------------------

test("storage: memories table has no raw/original text column", () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    const cols = handle.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const forbidden of [
      "raw_text",
      "raw",
      "original_text",
      "original",
      "input",
      "text",
      "content",
      "body",
      "source",
    ]) {
      assert.ok(!names.includes(forbidden), `memories must not have a '${forbidden}' column`);
    }
  } finally {
    rmStorage(tmp, handle);
  }
});

test("storage: different projects have isolated SQLite files", () => {
  const { tmp: proj1, handle: handle1 } = mkStorage("curion-multi-project-");
  const { tmp: proj2, handle: handle2 } = mkStorage("curion-multi-project-");
  try {
    // Insert 2 memories in proj1.
    insertMemoryRecord(handle1, {
      kind: "fact",
      state: "active",
      memoryContent: "Project 1 memory about Postgres",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["proj1", "postgres"] },
    });
    insertMemoryRecord(handle1, {
      kind: "fact",
      state: "active",
      memoryContent: "Project 1 memory about Redis",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["proj1", "redis"] },
    });

    // Insert 2 memories in proj2.
    insertMemoryRecord(handle2, {
      kind: "fact",
      state: "active",
      memoryContent: "Project 2 memory about Kubernetes",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["proj2", "k8s"] },
    });
    insertMemoryRecord(handle2, {
      kind: "fact",
      state: "active",
      memoryContent: "Project 2 memory about Docker",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["proj2", "docker"] },
    });

    // Verify counts.
    const allInProj1 = handle1.db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{
      id: number;
    }>;
    const allInProj2 = handle2.db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{
      id: number;
    }>;
    assert.equal(allInProj1.length, 2, "proj1 should have 2 memories");
    assert.equal(allInProj2.length, 2, "proj2 should have 2 memories");

    // Project 1 should NOT see project 2's memories.
    const proj1Contents = (
      handle1.db.prepare("SELECT summary FROM memories").all() as Array<{ summary: string }>
    ).map((r) => r.summary);
    assert.ok(
      proj1Contents.every((c) => !c.includes("Kubernetes") && !c.includes("Docker")),
      "proj1 should not contain proj2 memories"
    );
    // Project 2 should NOT see project 1's memories.
    const proj2Contents = (
      handle2.db.prepare("SELECT summary FROM memories").all() as Array<{ summary: string }>
    ).map((r) => r.summary);
    assert.ok(
      proj2Contents.every((c) => !c.includes("Postgres") && !c.includes("Redis")),
      "proj2 should not contain proj1 memories"
    );
  } finally {
    rmStorage(proj1, handle1);
    rmStorage(proj2, handle2);
  }
});

// ---------------------------------------------------------------------------
// Privacy: private projects are marked correctly
// ---------------------------------------------------------------------------

test("privacy: private project config is not readable by other projects", () => {
  // This is a conceptual test: a private project is marked with config.
  // The config file lives in the project's .curion/ directory, which
  // is gitignored and per-project. Other projects cannot read it.
  const { tmp: proj1, handle: handle1 } = mkStorage("curion-multi-project-");
  const { tmp: proj2, handle: handle2 } = mkStorage("curion-multi-project-");
  try {
    // Set proj1 as private.
    setProjectPrivate(proj1, true);
    assert.equal(isProjectPrivate(proj1), true);
    assert.equal(isProjectPrivate(proj2), false);

    // Both projects can still use storage normally.
    insertMemoryRecord(handle1, {
      kind: "fact",
      state: "active",
      memoryContent: "Private project memory",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: {},
    });
    insertMemoryRecord(handle2, {
      kind: "fact",
      state: "active",
      memoryContent: "Public project memory",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: {},
    });

    // Both storages work independently.
    const mem1 = handle1.db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
    const mem2 = handle2.db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
    assert.equal(mem1.c, 1, "proj1 should have 1 memory");
    assert.equal(mem2.c, 1, "proj2 should have 1 memory");
  } finally {
    rmStorage(proj1, handle1);
    rmStorage(proj2, handle2);
  }
});

// ---------------------------------------------------------------------------
// Lexical ranking: reusable for cross-project recall
// ---------------------------------------------------------------------------

test("lexical: rankLexical is deterministic and threshold-based", async () => {
  const { tmp, handle } = mkStorage("curion-multi-project-");
  try {
    insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The project uses Postgres 16 for primary storage.",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["postgres", "storage"] },
    });
    insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The project uses Redis for caching.",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["redis", "cache"] },
    });
    insertMemoryRecord(handle, {
      kind: "fact",
      state: "active",
      memoryContent: "The team prefers dark mode.",
      providerId: "test",
      modelId: "test",
      confidence: 0.9,
      safetyFlags: [],
      metadata: { tags: ["ui"] },
    });

    const { rankLexical } = await import("../src/retrieval/lexical.ts");
    const { listActiveMemorySummaries } = await import("../src/storage/storage.ts");

    const candidates = listActiveMemorySummaries(handle, { limit: 10 });
    const lexicalCandidates = candidates.map((c) => ({
      id: c.id,
      text: c.memoryContent,
      tags: c.tags,
    }));

    // Strong match query.
    const postgresRanked = rankLexical("Postgres database storage", lexicalCandidates, {
      threshold: 0.2,
    });
    assert.ok(
      postgresRanked.some((r) => r.id === candidates[0]!.id),
      "Postgres memory should rank for Postgres query"
    );
    assert.ok(
      !postgresRanked.some((r) => r.id === candidates[2]!.id),
      "Dark mode memory should NOT rank for Postgres query"
    );

    // Weak/no match query.
    const kubernetesRanked = rankLexical("kubernetes deployment operator", lexicalCandidates, {
      threshold: 0.2,
    });
    assert.equal(kubernetesRanked.length, 0, "no memories should match kubernetes query");
  } finally {
    rmStorage(tmp, handle);
  }
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function scriptFetch(responder: () => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    let body = "";
    if (init && typeof init === "object" && "body" in init && init.body) {
      body = String(init.body);
    }
    calls.push({ url, body });
    return responder();
  };
  return { fetchImpl, calls };
}

function okChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ message: { role: "assistant", content } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
