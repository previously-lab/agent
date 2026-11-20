import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

let root = "";
let memory = "";
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "aftrbrez-timeline-projection-"));
  memory = join(root, "memory");
  for (const directory of [memory, join(root, "tasks"), join(root, "sessions")]) fs.mkdirSync(directory, { recursive: true });
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("MEMORY_ROOT", memory);
  vi.stubEnv("TASKS_ROOT", join(root, "tasks"));
  vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  const target = fs.realpathSync(root);
  if (dirname(target) !== fs.realpathSync(tmpdir()) || !basename(target).startsWith("aftrbrez-timeline-projection-")) throw new Error("Unexpected fixture path");
  fs.rmSync(target, { recursive: true, force: true });
});

describe("derived semantic timeline", () => {
  it("upserts one record without duplicates and reads month shards newest first", async () => {
    const { createSlice } = await import("@/lib/episodic/manager");
    const { updateTimelineProjection, readRecentTimelineFromStorage } = await import("@/lib/episodic/timeline/projection");
    const newer = createSlice("讨论新项目", "UTC", "u1");
    newer.slice_id = "2026-11-17-1758"; newer.start = "2026-11-17T17:58:00Z";
    newer.focus = "新项目"; newer.summary = "确定了第一步。";
    await updateTimelineProjection(newer);
    newer.summary = "更新了第一步。";
    await updateTimelineProjection(newer);
    const older = createSlice("旧项目", "UTC", "u2");
    older.slice_id = "2026-10-12-0800"; older.start = "2026-10-12T08:00:00Z";
    older.focus = "旧项目"; older.summary = "旧结论。";
    await updateTimelineProjection(older);
    const raw = fs.readFileSync(join(memory, "timeline/2026-11.md"), "utf8");
    expect(raw.match(/records\/2026-11-17-1758/g)).toHaveLength(1);
    expect(raw).toContain("更新了第一步。");
    expect(fs.existsSync(join(memory, "timeline/2026-10.md"))).toBe(true);
    expect((await readRecentTimelineFromStorage(10)).map(entry => entry.sliceId)).toEqual(["2026-11-17-1758", "2026-10-12-0800"]);
  });

  it("updates during record persistence and lets recallRecent use the projection instead of raw bodies", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    await projectDialogueRecords({
      inputs: [{ input: { inputId: "input-1", clientMessageId: "message-1", userSeq: 1, eventSeq: 1,
        acceptedAt: "2026-11-17T17:58:00.000Z", text: "这是一个值得回忆的新项目。" }, turnId: "u1", sliceId: "2026-11-17-1758" }],
      useGithub: false, owner: "local", repo: "local", timezone: "UTC",
    });
    const timeline = fs.readFileSync(join(memory, "timeline/2026-11.md"), "utf8");
    expect(timeline).toContain("records/2026-11-17-1758");
    expect(timeline).toContain("值得回忆的新项目");

    const { recallRecent } = await import("@/lib/memory/facade");
    const { readFileLocal, walkPathsLocal } = await import("@/lib/tools/local-fs");
    const backend = { readFile: vi.fn(readFileLocal), listMemoryFiles: () => walkPathsLocal("memory") };
    const result = await recallRecent(backend, { category: "records", n: 1 });
    expect(result).toMatchObject({ kind: "entries", entries: [{ ref: "records/2026-11-17-1758" }] });
    expect(backend.readFile.mock.calls.some(([path]) => /\/records\/.*\/core\.md$/.test(path))).toBe(false);
  });
});
