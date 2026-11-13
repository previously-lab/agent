import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "previously-paths-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  process.env.STORAGE = "local";
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) process.env.STORAGE = origStorage;
  else delete process.env.STORAGE;
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function importFresh() {
  return import("@/lib/episodic/paths");
}

function writeOnDisk(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

const SLICE = "2026-08-09-1300";
const CORE = "memory/records/2026/08/09/1300/core.md";
const LEGACY_CORE = "memory/episodic/slices/2026/08/09/1300/timeline/core.md";

describe("canonical record paths", () => {
  it("builds only flat records paths", async () => {
    const { slicePartPath, RECORDS_ROOT } = await importFresh();
    expect(RECORDS_ROOT).toBe("memory/records");
    expect(slicePartPath(SLICE, "core")).toBe(CORE);
    expect(slicePartPath(SLICE, "previously")).toBe("memory/records/2026/08/09/1300/previously.md");
    expect(slicePartPath(SLICE, "agent")).toBe("memory/records/2026/08/09/1300/agent.md");
    expect(slicePartPath("2026-08-09", "core")).toBe("memory/records/2026/08/09/core.md");
  });

  it("reads and resolves the current-root file", async () => {
    writeOnDisk(CORE, "canonical content");
    writeOnDisk(LEGACY_CORE, "retired content");
    const { readSlicePart, readSlicePartResolved } = await importFresh();
    expect(await readSlicePart(SLICE, "core")).toBe("canonical content");
    expect(await readSlicePartResolved(SLICE, "core", undefined, { fresh: true })).toEqual({
      path: CORE,
      content: "canonical content",
    });
  });

  it("does not probe a retired root when the canonical record is absent", async () => {
    writeOnDisk(LEGACY_CORE, "retired content");
    const { readSlicePart, readSlicePartResolved } = await importFresh();
    await expect(readSlicePart(SLICE, "core")).rejects.toThrow();
    expect(await readSlicePartResolved(SLICE, "core")).toBeNull();
  });

  it("read-your-writes uses the pending canonical batch entry", async () => {
    const { readSlicePart } = await importFresh();
    const { createBatch, fsWriteFile } = await import("@/lib/episodic/io-helpers");
    const batch = createBatch();
    await fsWriteFile(CORE, "queued content", batch);
    expect(await readSlicePart(SLICE, "core", batch)).toBe("queued content");
  });
});
