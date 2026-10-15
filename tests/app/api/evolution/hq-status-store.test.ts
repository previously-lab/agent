/**
 * HQ status store (src/app/api/evolution/hq-status-store.ts) — the rolling
 * pointer behind memory/config/hq.json (v0.21 visibility layer; v0.34 R1).
 *
 * Harness mirrors tests/lib/episodic/batch-mode.test.ts: a temp cwd +
 * STORAGE=local + vi.resetModules, real filesystem all the way down — the
 * pointer lands at <tmp>/memory/config/hq.json and NEVER touches the repo's
 * real memory/. Pins the overwrite-in-place contract (no history), the
 * merge rules (recentWrites newest-first, deduped, capped; timestamps never
 * move backwards), the v0.34 R1 PER-ROUND immediate settlement
 * (recordReflectionRoundSettled — the D2 accumulate-and-flush-at-finish
 * batching retired with the resident run: briefsHandled ticks every round,
 * lastError lands a failure's first line and clears on a clean round,
 * lastNote stages only from a substantive round (空转不留痕), the cursor
 * advances only on a clean round), the retirement terminal
 * (recordReflectionRunRetired → "retired"), the immediate started mark, and
 * the tolerate-everything read (missing or corrupt file → the empty pointer).
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

  it("a staged note and the rolling pointer normalize through (a legacy turnId rides along)", async () => {
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

  it("the new terminal \"retired\" (v0.34 修订 B) normalizes through", async () => {
    fs.mkdirSync(path.join(tmpDir, "memory", "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, POINTER_DISK_PATH),
      JSON.stringify({ runStatus: "retired", briefsHandled: 7 }),
      "utf-8",
    );
    const { readHQStatus } = await importStore();
    const s = await readHQStatus();
    expect(s.runStatus).toBe("retired");
    expect(s.briefsHandled).toBe(7);
  });
});

describe("the generation lifecycle marks", () => {
  it("start lands immediately — running + the start stamp on disk before any round (the resident run's finish may be days away)", async () => {
    const { recordHQRunStarted, recordReflectionRunRetired, readHQStatus } =
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
    // previous generation's terminal status.
    const onDisk = readOnDisk();
    expect(onDisk?.runStatus).toBe("running");
    expect(typeof onDisk?.runStartedAt).toBe("string");
    expect(onDisk?.lastBriefPreview).toBe("现场：一条简报。");

    await recordReflectionRunRetired({ rounds: 1 });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("retired");
    expect(typeof s.runStartedAt).toBe("string");
    expect(s.lastBriefPreview).toBe("现场：一条简报。");
  });

  it("the claiming run's OWN id lands at start (the pod's attach target); the next generation's marks overwrite it", async () => {
    const { recordHQRunStarted, recordReflectionRunRetired, readHQStatus } =
      await importStore();
    await recordHQRunStarted("run-abc");
    // immediate: the attach target is on disk from the claim, not the finish
    let s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("running");

    // retiring settles the status; a retired run's stream stays replayable,
    // so the attach target outlives the generation
    await recordReflectionRunRetired({ rounds: 2 });
    s = await readHQStatus();
    expect(s.runId).toBe("run-abc");
    expect(s.runStatus).toBe("retired");

    // the successor's claim overwrites it (and resets the round count)
    await recordHQRunStarted("run-def");
    s = await readHQStatus();
    expect(s.runId).toBe("run-def");
    expect(s.runStatus).toBe("running");
    expect(s.briefsHandled).toBe(0);
  });

  it("a settle write never moves a timestamp backwards (the 2759674fe class)", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    // An older generation claimed the mailbox…
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

    await recordReflectionRoundSettled({ actions: ["memory/research/x/index.md"] });
    const s = await readHQStatus();
    expect(s.runStartedAt).toBe(newer);
    // a legacy dispatch-era stamp the settle never touches rides through
    expect(s.lastDispatchAt).toBe(newer);
  });
});

describe("recordReflectionRoundSettled — per-round immediate settlement (v0.34 R1)", () => {
  it("every round writes IMMEDIATELY and ticks the count — no finish wait (the resident run may never finish within a read's lifetime)", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({ actions: ["memory/tasks/a/index.md"] });
    // immediate: readable NOW, not at the run's finish (D2 batching retired)
    let s = await readHQStatus();
    expect(s.recentWrites).toEqual(["memory/tasks/a/index.md"]);
    expect(s.briefsHandled).toBe(1);

    await recordReflectionRoundSettled({
      actions: ["memory/people/user/index.md", "memory/tasks/a/index.md"],
    });
    s = await readHQStatus();
    expect(s.recentWrites).toEqual([
      "memory/people/user/index.md",
      "memory/tasks/a/index.md",
    ]);
    expect(s.briefsHandled).toBe(2);

    for (let i = 0; i < 10; i += 1) {
      await recordReflectionRoundSettled({
        actions: [`memory/tasks/case-${i}/index.md`],
      });
    }
    s = await readHQStatus();
    // Newest-first, deduped, capped at 8.
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
    expect(s.briefsHandled).toBe(12);
  });

  it("a failed round lands the real error's first line (capped); a clean round clears it", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({
      actions: [],
      error: "runSubAgent timed out\nstack line two\nstack line three",
    });
    let s = await readHQStatus();
    expect(s.lastError).toBe("runSubAgent timed out");

    // a single over-long line caps at 200 + the ellipsis
    await recordReflectionRoundSettled({ actions: [], error: "x".repeat(400) });
    s = await readHQStatus();
    expect(s.lastError).toHaveLength(201);

    await recordReflectionRoundSettled({ actions: [] });
    s = await readHQStatus();
    expect(s.lastError).toBeNull();
  });

  it("lastNote stages only from a SUBSTANTIVE round (空转不留痕); a later substantive note overwrites", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({
      actions: ["memory/research/x/index.md"],
      note: "核对了 2026-10-04-0131，把屏幕供应商跟进写进了 research/。",
    });
    const staged = (await readHQStatus()).lastNote;
    expect(staged?.note).toBe(
      "核对了 2026-10-04-0131，把屏幕供应商跟进写进了 research/。",
    );
    expect(typeof staged?.at).toBe("string");

    // an idle round (no writes) never overwrites the staged note
    await recordReflectionRoundSettled({ actions: [] });
    expect((await readHQStatus()).lastNote).toEqual(staged);

    // a round that wrote but said nothing never overwrites it either
    await recordReflectionRoundSettled({ actions: ["memory/research/y/index.md"] });
    expect((await readHQStatus()).lastNote).toEqual(staged);

    // the next substantive round overwrites
    await recordReflectionRoundSettled({
      actions: ["memory/research/w/index.md"],
      note: "新暂存。",
    });
    expect((await readHQStatus()).lastNote?.note).toBe("新暂存。");
  });

  it("the cursor (lastSeen) advances ONLY on a clean round — a failed round leaves it so the next lap re-reads from the same edge", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({
      actions: [],
      seen: { sliceId: "2026-10-04-0131" },
    });
    let s = await readHQStatus();
    // a deliberate idle (no error) DOES advance the cursor
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131" });

    await recordReflectionRoundSettled({
      actions: [],
      error: "boom",
      seen: { sliceId: "2026-10-04-0200" },
    });
    s = await readHQStatus();
    expect(s.lastError).toBe("boom");
    // failed round: the cursor holds — content past it is NOT silently skipped
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0131" });

    await recordReflectionRoundSettled({
      actions: ["memory/research/x/index.md"],
      seen: { sliceId: "2026-10-04-0200" },
    });
    s = await readHQStatus();
    expect(s.lastSeen).toEqual({ sliceId: "2026-10-04-0200" });
    expect(s.lastError).toBeNull();
  });

  it("the generation's started mark resets the round count (briefsHandled is per-generation)", async () => {
    const { recordHQRunStarted, recordReflectionRoundSettled, readHQStatus } =
      await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({ actions: [] });
    await recordReflectionRoundSettled({ actions: [] });
    expect((await readHQStatus()).briefsHandled).toBe(2);

    await recordHQRunStarted("run-2");
    expect((await readHQStatus()).briefsHandled).toBe(0);
  });
});

describe("recordReflectionRunRetired — the generation's ONLY clean terminal (修订 B)", () => {
  it("settles \"retired\" with the definitive count; lastError is NOT touched (retirement is not a failure)", async () => {
    const {
      recordHQRunStarted,
      recordReflectionRoundSettled,
      recordReflectionRunRetired,
      readHQStatus,
    } = await importStore();

    await recordHQRunStarted("run-1");
    await recordReflectionRoundSettled({ actions: [], error: "boom" });
    expect((await readHQStatus()).lastError).toBe("boom");

    await recordReflectionRunRetired({ rounds: 1 });
    const s = await readHQStatus();
    expect(s.runStatus).toBe("retired");
    expect(s.briefsHandled).toBe(1);
    // the failure line survives retirement — the NEW generation's first clean
    // round is what clears it
    expect(s.lastError).toBe("boom");

    // the successor's started mark lands seconds later
    await recordHQRunStarted("run-2");
    const next = await readHQStatus();
    expect(next.runStatus).toBe("running");
    expect(next.runId).toBe("run-2");
  });
});

describe("settleHQRunIfStale (the cancelled-run hole)", () => {
  it("settles a pointer whose running run is TERMINAL in the registry — failed, with the registry's verdict", async () => {
    const {
      recordHQRunStarted,
      recordReflectionRoundSettled,
      settleHQRunIfStale,
      readHQStatus,
    } = await importStore();
    await recordHQRunStarted("run-cancelled");
    await recordReflectionRoundSettled({ actions: ["memory/research/x/index.md"] });

    const settled = await settleHQRunIfStale("run-cancelled", "cancelled");

    expect(settled.runStatus).toBe("failed");
    expect(settled.lastError).toContain('"cancelled"');
    expect(settled.lastError).toContain("without a finish mark");
    // on disk too, with the run's identity and start stamp preserved
    const onDisk = readOnDisk();
    expect(onDisk?.runStatus).toBe("failed");
    expect(onDisk?.runId).toBe("run-cancelled");
    expect(typeof onDisk?.runStartedAt).toBe("string");
    const s = await readHQStatus();
    expect(s.runStatus).toBe("failed");
    expect(s.runId).toBe("run-cancelled");
  });

  it("never clobbers a pointer that moved on — a retired generation or a NEW claim stay untouched", async () => {
    const { recordHQRunStarted, recordReflectionRunRetired, settleHQRunIfStale } =
      await importStore();

    // already settled: the stale check names a run the pointer no longer runs
    await recordHQRunStarted("run-a");
    await recordReflectionRunRetired({ rounds: 1 });
    const settled = await settleHQRunIfStale("run-a", "cancelled");
    expect(settled.runStatus).toBe("retired");
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
