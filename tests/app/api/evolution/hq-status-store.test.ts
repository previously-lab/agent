/**
 * HQ status store (src/app/api/evolution/hq-status-store.ts) — the rolling
 * pointer behind memory/config/hq.json (v0.21 visibility layer).
 *
 * Harness mirrors tests/lib/episodic/batch-mode.test.ts: a temp cwd +
 * STORAGE=local + vi.resetModules, real filesystem all the way down — the
 * pointer lands at <tmp>/memory/config/hq.json and NEVER touches the repo's
 * real memory/. Pins the overwrite-in-place contract (no history), the
 * merge rules (recentWrites newest-first, deduped, capped; timestamps never
 * move backwards), the terminal status mapping (完成 / 空转 / 失败) with its
 * lastError line, the immediate started mark (D2 reversed for it), the v0.30
 * 暂存/rolling-pointer landing (lastNote only from a substantive round — R1;
 * lastSeen advancing), and the tolerate-everything read (missing or corrupt
 * file → the empty pointer).
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
      lastError: null,
      lastDispatchAt: null,
      lastBriefPreview: null,
      recentWrites: [],
      lastNote: null,
      lastSeen: null,
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
        lastNote: { note: 42 },
        lastSeen: "2026-10-04-0131",
      }),
      "utf-8",
    );
    const { readHQStatus } = await importStore();
    expect(await readHQStatus()).toEqual({
      runId: null,
      runStartedAt: null,
      runStatus: null,
      briefsHandled: 0,
      lastError: null,
      lastDispatchAt: "2026-10-04T01:31:00.000Z",
      lastBriefPreview: null,
      recentWrites: ["memory/self/search/index.md"],
      lastNote: null,
      lastSeen: null,
    });
  });

  it("a staged note and the rolling pointer normalize through", async () => {
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({
        lastNote: { note: "核对了屏幕供应商案。", at: "2026-10-04T02:00:00.000Z" },
        lastSeen: { sliceId: "2026-10-04-0131", turnId: "turn-1" },
      }),
      "utf-8",
    );
    const { readHQStatus } = await importStore();
    const s = await readHQStatus();
    expect(s.lastNote).toEqual({
      note: "核对了屏幕供应商案。",
      at: "2026-10-04T02:00:00.000Z",
    });
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131", turnId: "turn-1" });
  });
});

describe("the run lifecycle marks", () => {
  it("start lands immediately — running + the start stamp on disk before any finish (D2 reversed for this mark)", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    // A legacy field from the dispatch era survives both marks untouched.
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({ lastBriefPreview: "现场：一条简报。" }),
      "utf-8",
    );
    await recordHQRunStarted();

    // Immediate: the pointer already reads running with its start stamp —
    // a run that hangs or dies here is no longer invisible behind the
    // previous run's terminal status.
    const onDisk = readOnDisk();
    expect(onDisk?.runStatus).toBe("running");
    expect(typeof onDisk?.runStartedAt).toBe("string");
    expect(onDisk?.lastBriefPreview).toBe("现场：一条简报。");

    await recordHQRunFinished({ handled: 1, wrote: true, errored: false });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("completed");
    expect(typeof s.runStartedAt).toBe("string");
    expect(s.lastBriefPreview).toBe("现场：一条简报。");
  });

  it("the claiming run's OWN id lands at start (the pod's attach target); the next run's marks overwrite it", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-abc");
    // immediate: the attach target is on disk from the claim, not the finish
    let s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("running");

    // finishing settles the status; a finished run's stream stays replayable,
    // so the attach target outlives the run
    await recordHQRunFinished({ handled: 1, wrote: false, errored: false });
    s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("idle");

    // the next claim's marks overwrite it
    await recordHQRunStarted("run-def");
    s = await readHQStatus();
    expect(s.runId).toBe("run-def");
    expect(s.runStatus).toBe("running");
    await recordHQRunFinished({ handled: 0, wrote: false, errored: false });
    s = await readHQStatus();
    expect(s.runId).toBe("run-def");
    expect(s.runStatus).toBe("idle");
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

  it("a failed finish lands the real error's first line (capped); a clean finish clears it", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();

    await recordHQRunStarted();
    await recordHQRunFinished({
      handled: 1,
      wrote: false,
      errored: true,
      error: "runSubAgent timed out after 300s\nstack line two\nstack line three",
    });
    let s = await readHQStatus();
    expect(s.runStatus).toBe("failed");
    expect(s.lastError).toBe("runSubAgent timed out after 300s");

    // a single over-long line caps at 200 + the ellipsis
    await recordHQRunStarted();
    await recordHQRunFinished({
      handled: 1,
      wrote: false,
      errored: true,
      error: "x".repeat(400),
    });
    s = await readHQStatus();
    expect(s.lastError).toHaveLength(201);

    await recordHQRunStarted();
    await recordHQRunFinished({ handled: 2, wrote: true, errored: false });
    s = await readHQStatus();
    expect(s.runStatus).toBe("completed");
    expect(s.lastError).toBeNull();
  });

  it("a settle write never moves a timestamp backwards (the 2759674fe class)", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();

    // An older run's pending slot carries its (older) start stamp…
    await recordHQRunStarted("run-old");
    // …but the file has since learned NEWER marks (another instance's run):
    // the settle write must not drag them back.
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    const newer = "2099-01-01T00:00:00.000Z";
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({ runStartedAt: newer, lastDispatchAt: newer }),
      "utf-8",
    );

    await recordHQRunFinished({ handled: 1, wrote: true, errored: false });
    const s = await readHQStatus();
    expect(s.runStartedAt).toBe(newer);
    // a legacy dispatch-era stamp the settle never touches rides through
    expect(s.lastDispatchAt).toBe(newer);
  });
});

describe("recordHQBriefOutcome", () => {
  it("accumulates each brief's landed writes and flushes them newest-first, deduped, capped at 8, in the ONE finish write", async () => {
    const { recordHQBriefOutcome, recordHQRunFinished, readHQStatus } =
      await importStore();

    await recordHQBriefOutcome({ actions: ["memory/tasks/a/index.md"] });
    await recordHQBriefOutcome({
      actions: ["memory/people/user/index.md", "memory/tasks/a/index.md"],
    });
    // deferred: nothing readable until the run settles
    expect((await readHQStatus()).recentWrites).toEqual([]);

    for (let i = 0; i < 10; i += 1) {
      await recordHQBriefOutcome({ actions: [`memory/tasks/case-${i}/index.md`] });
    }
    await recordHQRunFinished({ handled: 12, wrote: true, errored: false });
    const s = await readHQStatus();
    // Newest-first, deduped, capped at 8: the 10 case writes plus the two
    // earlier actions collapse to 11 uniques, and the cap keeps the newest 8
    // — exactly the old immediate-merge semantics, now in the one finish write.
    expect(s.recentWrites).toEqual([
      "memory/tasks/case-9/index.md",
      "memory/tasks/case-8/index.md",
      "memory/tasks/case-7/index.md",
      "memory/tasks/case-6/index.md",
      "memory/tasks/case-5/index.md",
      "memory/tasks/case-4/index.md",
      "memory/tasks/case-3/index.md",
      "memory/tasks/case-2/index.md",
    ]);
  });

  it("an idle round (no actions) does not touch the file at all", async () => {
    const { recordHQBriefOutcome } = await importStore();
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({ runStatus: "running" }),
      "utf-8",
    );
    const before = readOnDisk();
    await recordHQBriefOutcome({ actions: [] });
    expect(readOnDisk()).toEqual(before);
  });
});

describe("recordHQRunFinished — the 暂存 and the rolling pointer (v0.30 §2.3/§2.4)", () => {
  it("a finish carrying a note lands lastNote {note, at}; the seen pointer lands as lastSeen", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-1");
    await recordHQRunFinished({
      handled: 1,
      wrote: true,
      errored: false,
      note: "核对了 2026-10-04-0131，把屏幕供应商跟进写进了 research/。",
      seen: { sliceId: "2026-10-04-0131", turnId: "turn-1" },
    });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("completed");
    expect(s.lastNote?.note).toBe(
      "核对了 2026-10-04-0131，把屏幕供应商跟进写进了 research/。",
    );
    expect(typeof s.lastNote?.at).toBe("string");
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131", turnId: "turn-1" });
  });

  it("a finish WITHOUT a note never overwrites the staged note (R1: 空转不留痕); without a seen the pointer holds", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-1");
    await recordHQRunFinished({
      handled: 1,
      wrote: true,
      errored: false,
      note: "第一轮写下了一个案件。",
      seen: { sliceId: "2026-10-04-0131", turnId: "turn-1" },
    });
    const staged = (await readHQStatus()).lastNote;

    // the next run goes idle: no note rides its finish — the staged one stays
    await recordHQRunStarted("run-2");
    await recordHQRunFinished({ handled: 2, wrote: false, errored: false });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("idle");
    expect(s.lastNote).toEqual(staged);
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131", turnId: "turn-1" });
  });

  it("a later substantive note overwrites; a later seen advances the pointer", async () => {
    const { recordHQRunStarted, recordHQRunFinished, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-1");
    await recordHQRunFinished({
      handled: 1,
      wrote: true,
      errored: false,
      note: "旧暂存。",
      seen: { sliceId: "2026-10-04-0131", turnId: "turn-1" },
    });
    await recordHQRunStarted("run-2");
    await recordHQRunFinished({
      handled: 1,
      wrote: true,
      errored: false,
      note: "新暂存。",
      seen: { sliceId: "2026-10-04-0131", turnId: "turn-2" },
    });
    const s = await readHQStatus();
    expect(s.lastNote?.note).toBe("新暂存。");
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131", turnId: "turn-2" });
  });
});

describe("settleHQRunIfStale (the cancelled-run hole)", () => {
  it("settles a pointer whose running run is TERMINAL in the registry — failed, with the registry's verdict", async () => {
    const { recordHQRunStarted, recordHQBriefOutcome, settleHQRunIfStale, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-cancelled");
    await recordHQBriefOutcome({ actions: ["memory/research/x/index.md"] });

    const settled = await settleHQRunIfStale("run-cancelled", "cancelled");

    expect(settled.runStatus).toBe("failed");
    expect(settled.lastError).toContain('"cancelled"');
    expect(settled.lastError).toContain("without a finish mark");
    // on disk too, with the run's identity and start stamp preserved
    const onDisk = readOnDisk();
    expect(onDisk?.runStatus).toBe("failed");
    expect(onDisk?.runId).toBe("run-cancelled");
    expect(typeof onDisk?.runStartedAt).toBe("string");
    // a run that had only started shows no round count…
    const s = await readHQStatus();
    expect(s.runStatus).toBe("failed");
    expect(s.runId).toBe("run-cancelled");
  });

  it("never clobbers a pointer that moved on — a settled run or a NEW claim stay untouched", async () => {
    const { recordHQRunStarted, recordHQRunFinished, settleHQRunIfStale } =
      await importStore();

    // already settled: the stale check names a run the pointer no longer runs
    await recordHQRunStarted("run-a");
    await recordHQRunFinished({ handled: 1, wrote: false, errored: false });
    const settled = await settleHQRunIfStale("run-a", "cancelled");
    expect(settled.runStatus).toBe("idle");
    expect(settled.lastError).toBeNull();

    // a NEW claim in between: the route's verdict names the OLD run's id —
    // the merge's fresh read sees run-b's pointer and does not touch it
    await recordHQRunStarted("run-b");
    const still = await settleHQRunIfStale("run-a", "cancelled");
    expect(still.runStatus).toBe("running");
    expect(still.runId).toBe("run-b");
    expect(readOnDisk()?.runId).toBe("run-b");
  });
});
