/**
 * HQ status store (src/app/api/evolution/hq-status-store.ts) — the rolling
 * pointer behind memory/config/hq.json (v0.21 visibility layer).
 *
 * Harness mirrors tests/lib/episodic/batch-mode.test.ts: a temp cwd +
 * STORAGE=local + vi.resetModules, real filesystem all the way down — the
 * pointer lands at <tmp>/memory/config/hq.json and NEVER touches the repo's
 * real memory/. Pins the overwrite-in-place contract (no history), the
 * merge rules (recentWrites newest-first, deduped, capped), the terminal
 * status mapping (完成 / 空转 / 失败), and the tolerate-everything read
 * (missing or corrupt file → the empty pointer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;
let origStorage: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aftrbrez-hq-status-test-"));
  origCwd = process.cwd();
  origStorage = process.env.STORAGE;
  process.env.STORAGE = "local";
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  if (origStorage !== undefined) {
    process.env.STORAGE = origStorage;
  } else {
    delete process.env.STORAGE;
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function importStore() {
  return import("@/app/api/evolution/hq-status-store");
}

const POINTER_DISK_PATH = path.join("memory", "config", "hq.json");

function readOnDisk(): Record<string, unknown> | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(tmpDir, POINTER_DISK_PATH), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("readHQStatus", () => {
  it("a missing pointer is the EMPTY status, not an error", async () => {
    const { readHQStatus } = await importStore();
    expect(await readHQStatus()).toEqual({
      runId: null,
      runStartedAt: null,
      runStatus: null,
      briefsHandled: 0,
      lastDispatchAt: null,
      lastBriefPreview: null,
      recentWrites: [],
    });
  });

  it("a corrupt pointer degrades to EMPTY (a debug file must never break the read)", async () => {
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, POINTER_DISK_PATH), "{not json", "utf-8");
    const { readHQStatus } = await importStore();
    expect((await readHQStatus()).runStatus).toBeNull();
  });

  it("an older/shaped-wrong pointer normalizes field by field", async () => {
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({
        runStatus: "sideways",
        briefsHandled: "many",
        recentWrites: ["memory/self/search/index.md", 42],
        lastDispatchAt: "2026-10-04T01:31:00.000Z",
      }),
      "utf-8",
    );
    const { readHQStatus } = await importStore();
    expect(await readHQStatus()).toEqual({
      runId: null,
      runStartedAt: null,
      runStatus: null,
      briefsHandled: 0,
      lastDispatchAt: "2026-10-04T01:31:00.000Z",
      lastBriefPreview: null,
      recentWrites: ["memory/self/search/index.md"],
    });
  });
});

describe("recordHQDispatch", () => {
  it("writes the dispatch time and the brief's first line, truncated", async () => {
    const { recordHQDispatch } = await importStore();
    const long = `现场：${"很长".repeat(80)}\n第二行不进预览`;
    await recordHQDispatch(long);

    const onDisk = readOnDisk();
    expect(typeof onDisk?.lastDispatchAt).toBe("string");
    const preview = onDisk?.lastBriefPreview as string;
    expect(preview.length).toBeLessThanOrEqual(121); // 120 + the ellipsis
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("第二行");
    // overwrite-in-place: still exactly ONE pointer file, no history
    expect(onDisk?.recentWrites).toEqual([]);
  });

  it("a short brief rides whole, ellipsis-free", async () => {
    const { recordHQDispatch } = await importStore();
    await recordHQDispatch("现场：用户问起屏幕供应商。");
    expect(readOnDisk()?.lastBriefPreview).toBe("现场：用户问起屏幕供应商。");
  });
});

describe("the run lifecycle marks", () => {
  it("started → running with the start stamp; the dispatch fields survive", async () => {
    const { recordHQDispatch, recordHQRunStarted, readHQStatus } =
      await importStore();
    await recordHQDispatch("现场：一条简报。");
    await recordHQRunStarted();

    const s = await readHQStatus();
    expect(s.runStatus).toBe("running");
    expect(typeof s.runStartedAt).toBe("string");
    expect(s.lastBriefPreview).toBe("现场：一条简报。");
  });

  it("the claiming run's OWN id lands on the pointer (the pod's attach target)", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-abc");
    let s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("running");

    // finishing settles the status but KEEPS the id — a finished run's
    // stream stays replayable, so the attach target outlives the run
    await recordHQRunFinished({ handled: 1, wrote: false, errored: false });
    s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("idle");

    // the next claim overwrites it
    await recordHQRunStarted("run-def");
    expect((await readHQStatus()).runId).toBe("run-def");
  });

  it("finish maps wrote/errored to 完成 / 空转 / 失败 and the definitive count", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();

    await recordHQRunStarted();
    await recordHQRunFinished({ handled: 2, wrote: true, errored: false });
    expect((await readHQStatus()).runStatus).toBe("completed");
    expect((await readHQStatus()).briefsHandled).toBe(2);

    await recordHQRunStarted();
    await recordHQRunFinished({ handled: 1, wrote: false, errored: false });
    expect((await readHQStatus()).runStatus).toBe("idle");

    await recordHQRunStarted();
    await recordHQRunFinished({ handled: 3, wrote: true, errored: true });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("failed");
    expect(s.briefsHandled).toBe(3);
  });
});

describe("recordHQBriefOutcome", () => {
  it("merges landed writes newest-first, deduped, capped at 8", async () => {
    const { recordHQBriefOutcome, readHQStatus } = await importStore();

    await recordHQBriefOutcome({ actions: ["memory/tasks/a/index.md"] });
    await recordHQBriefOutcome({
      actions: ["memory/people/user/index.md", "memory/tasks/a/index.md"],
    });
    let s = await readHQStatus();
    expect(s.recentWrites).toEqual([
      "memory/people/user/index.md",
      "memory/tasks/a/index.md",
    ]);

    for (let i = 0; i < 10; i += 1) {
      await recordHQBriefOutcome({ actions: [`memory/tasks/case-${i}/index.md`] });
    }
    s = await readHQStatus();
    expect(s.recentWrites).toHaveLength(8);
    expect(s.recentWrites[0]).toBe("memory/tasks/case-9/index.md");
  });

  it("an idle round (no actions) does not touch the file at all", async () => {
    const { recordHQDispatch, recordHQBriefOutcome } = await importStore();
    await recordHQDispatch("现场：一条简报。");
    const before = readOnDisk();
    await recordHQBriefOutcome({ actions: [] });
    expect(readOnDisk()).toEqual(before);
  });
});
