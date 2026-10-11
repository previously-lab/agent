/**
 * Dual-root read order (acceptance D-11, design v0.19 §D.1): the records root
 * moved from `memory/episodic/slices/...` to `memory/records/...`; reads
 * dual-probe new-root-first with legacy fallback, writes go to the new root
 * only, and in-place backfill writes must land on the root the read hit
 * (`readSlicePartResolved` reports it).
 *
 * Runs against the LOCAL filesystem backend in a temp dir (the
 * batch-mode.test.ts pattern) so the probe order is exercised for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-paths-test-"));
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
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
const NEW_CORE = "memory/records/2026/08/09/1300/core.md";
const LEGACY_CORE = "memory/episodic/slices/2026/08/09/1300/timeline/core.md";

describe("slicePartPathCandidates (probe order)", () => {
  it("lists the new root first, the legacy root on a miss", async () => {
    const { slicePartPathCandidates } = await importFresh();
    expect(slicePartPathCandidates(SLICE, "core")).toEqual([
      NEW_CORE,
      LEGACY_CORE,
    ]);
  });

  it("legacy previously.md sits flat (no timeline/ level); the new root is flat for every part", async () => {
    const { slicePartPathCandidates } = await importFresh();
    expect(slicePartPathCandidates(SLICE, "previously")).toEqual([
      "memory/records/2026/08/09/1300/previously.md",
      "memory/episodic/slices/2026/08/09/1300/previously.md",
    ]);
    expect(slicePartPathCandidates(SLICE, "agent")).toEqual([
      "memory/records/2026/08/09/1300/agent.md",
      "memory/episodic/slices/2026/08/09/1300/timeline/agent.md",
    ]);
  });

  it("maps a legacy 3-segment slice id to a day directory (robustness)", async () => {
    const { slicePartPathCandidates } = await importFresh();
    expect(slicePartPathCandidates("2026-08-09", "core")).toEqual([
      "memory/records/2026/08/09/core.md",
      "memory/episodic/slices/2026/08/09/timeline/core.md",
    ]);
  });
});

describe("readSlicePart (dual-root read)", () => {
  it("a new-root hit wins when BOTH roots hold the part (probe order = priority, no legacy read needed)", async () => {
    writeOnDisk(NEW_CORE, "new-root content");
    writeOnDisk(LEGACY_CORE, "legacy content");
    const { readSlicePart } = await importFresh();
    expect(await readSlicePart(SLICE, "core")).toBe("new-root content");
  });

  it("falls back to the legacy root on a new-root miss", async () => {
    writeOnDisk(LEGACY_CORE, "legacy content");
    const { readSlicePart } = await importFresh();
    expect(await readSlicePart(SLICE, "core")).toBe("legacy content");
  });

  it("throws when neither root holds the part (same contract as a plain missing-file read)", async () => {
    const { readSlicePart } = await importFresh();
    await expect(readSlicePart(SLICE, "core")).rejects.toThrow();
  });

  it("read-your-writes: a pending batch write at the new-root path is what the read returns", async () => {
    writeOnDisk(LEGACY_CORE, "legacy content");
    const { readSlicePart } = await importFresh();
    const { createBatch, fsWriteFile } = await import(
      "@/lib/episodic/io-helpers"
    );
    const batch = createBatch();
    await fsWriteFile(NEW_CORE, "queued new content", batch);
    expect(await readSlicePart(SLICE, "core", batch)).toBe(
      "queued new content",
    );
  });
});

describe("readSlicePartResolved (the in-place backfill contract)", () => {
  it("reports the NEW-root path on a new-root hit", async () => {
    writeOnDisk(NEW_CORE, "new-root content");
    writeOnDisk(LEGACY_CORE, "legacy content");
    const { readSlicePartResolved } = await importFresh();
    expect(await readSlicePartResolved(SLICE, "core")).toEqual({
      path: NEW_CORE,
      content: "new-root content",
    });
  });

  it("reports the LEGACY-root path when only the legacy root holds the part (backfill lands in place)", async () => {
    writeOnDisk(LEGACY_CORE, "legacy content");
    const { readSlicePartResolved } = await importFresh();
    expect(await readSlicePartResolved(SLICE, "core")).toEqual({
      path: LEGACY_CORE,
      content: "legacy content",
    });
  });

  it("returns null when neither root holds the part", async () => {
    const { readSlicePartResolved } = await importFresh();
    expect(await readSlicePartResolved(SLICE, "core")).toBeNull();
  });
});
