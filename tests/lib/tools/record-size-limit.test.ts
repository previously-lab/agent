import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const core = "memory/records/2026/11/08/1234/core.md";

describe("local record storage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aftrbrez-record-limit-"));
    vi.stubEnv("STORAGE", "local");
    vi.stubEnv("PREVIOUSLY_MODE", "cloud");
    vi.stubEnv("MEMORY_ROOT", join(root, "memory"));
    vi.stubEnv("TASKS_ROOT", join(root, "tasks"));
    vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["memory/ordinary.md", 1_500_000],
    [core, 8 * 1024 * 1024 + 1],
  ] as const)("round-trips text beyond the former limit at %s", async (path, length) => {
    const { writeFileLocal, readFileLocal } = await import("@/lib/tools/local-fs");
    const content = "x".repeat(length);
    await writeFileLocal(path, content);
    await expect(readFileLocal(path, { fresh: true })).resolves.toBe(content);
  });
});
