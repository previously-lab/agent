import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCanonicalRecordCorePath,
  MAX_RECORD_CORE_BYTES,
  MAX_TEXT_FILE_BYTES,
  maxTextFileBytes,
} from "@/lib/episodic/record-size-limit";

const core = "memory/records/2026/11/08/1234/core.md";

describe("record text storage limits", () => {
  it("applies the bounded exception only to the canonical core path", () => {
    expect(MAX_RECORD_CORE_BYTES).toBe(8 * 1024 * 1024);
    expect(maxTextFileBytes(core)).toBe(MAX_RECORD_CORE_BYTES);
    expect(maxTextFileBytes("memory/records/2026/11/08/1234/index.md")).toBe(MAX_TEXT_FILE_BYTES);
    expect(isCanonicalRecordCorePath("memory/records/2026/11/08/12345/core.md")).toBe(false);
    expect(isCanonicalRecordCorePath("memory/records/2026/11/08/1234/../core.md")).toBe(false);
    expect(isCanonicalRecordCorePath("tasks/records/2026/11/08/1234/core.md")).toBe(false);
  });
});

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

  it("writes and reads a record core above the generic cap", async () => {
    const { writeFileLocal, readFileLocal } = await import("@/lib/tools/local-fs");
    const content = "x".repeat(1_000_001);

    await writeFileLocal(core, content);
    await expect(readFileLocal(core, { fresh: true })).resolves.toBe(content);
    await expect(writeFileLocal("memory/ordinary.md", content)).rejects.toThrow("Content too large");
  });

  it("rejects record cores above the bounded maximum", async () => {
    const { writeFileLocal } = await import("@/lib/tools/local-fs");
    await expect(writeFileLocal(core, "x".repeat(MAX_RECORD_CORE_BYTES + 1))).rejects.toThrow("Content too large");
  });
});
