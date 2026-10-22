import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import type { SummaryRunPayload } from "@/lib/chat/turn-types";

vi.mock("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "summary-fixture" }),
  setAttributes: async () => {},
  getWritable: () => ({ getWriter: () => ({ write: async () => {}, releaseLock() {} }) }),
}));
vi.mock("workflow/runtime", () => ({ getWorld: async () => ({ runs: { list: async () => { throw new Error("registry offline"); } } }) }));
vi.mock("workflow/api", () => ({ getRun: vi.fn(), start: vi.fn(), resumeHook: vi.fn() }));
vi.mock("@/lib/episodic/flash/turn-analyzer", () => ({ analyzeTurn: async () => null }));
vi.mock("@/app/api/evolution/reflection-wake", () => ({ deliverReflectionWake: async () => ({ ok: true, delivered: "rung", runId: "reflection-fixture" }) }));

let root: string;
let savedEnv: Record<string, string | undefined>;
const envKeys = ["STORAGE", "MEMORY_ROOT", "TASKS_ROOT", "SESSIONS_ROOT"];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-persistence-"));
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.STORAGE = "local";
  process.env.MEMORY_ROOT = path.join(root, "memory");
  process.env.TASKS_ROOT = path.join(root, "tasks");
  process.env.SESSIONS_ROOT = path.join(root, "sessions");
  fs.mkdirSync(process.env.MEMORY_ROOT, { recursive: true });
  await git.init({ fs, dir: process.env.MEMORY_ROOT });
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T08:00:00Z"));
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network in persistence fixture"); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function payload(turnId: string, over: Partial<SummaryRunPayload> = {}): SummaryRunPayload {
  return {
    sliceId: "new-slice:2026-10-22", burstId: "burst-1", date: "2026-10-22",
    own: { turnId, clientMessageId: `message-${turnId}`, sliceId: "new-slice:2026-10-22", at: new Date().toISOString(), userText: `Question ${turnId}`, replyText: `Answer ${turnId}`, cognition: `Thought ${turnId}`, burstId: "burst-1" },
    slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 2 },
    clientTimezone: "UTC", modelConfig: { id: "fixture", sdk: "deepseek" } as SummaryRunPayload["modelConfig"],
    useGithub: false, useDemo: false, owner: "fixture", repo: "fixture", locale: "en", ...over,
  };
}

async function recordFiles(): Promise<Array<{ file: string; raw: string }>> {
  const files = await git.listFiles({ fs, dir: process.env.MEMORY_ROOT! });
  return files.filter((file) => file.endsWith("/core.md")).map((file) => ({ file, raw: fs.readFileSync(path.join(process.env.MEMORY_ROOT!, file), "utf8") }));
}

describe("real summary persistence and Git ledger", { timeout: 30_000 }, () => {
  it("persists a fresh user-only legacy record before returning a receipt", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const input = payload("useronly");
    delete input.own.clientMessageId;
    input.own.replyText = "";
    input.own.cognition = "";
    const result = await persistTurnSummary(input);
    expect(result.kind).toBe("committed");
    expect(result.receipt?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect((await recordFiles())[0]?.raw).toContain("Question useronly");
  });

  it("different entry hints concurrently append to the same local edge without losing either answer", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const slicing = { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 };
    await persistTurnSummary(payload("seed1", { slicing }));
    const results = await Promise.all([
      persistTurnSummary(payload("left1", { sliceId: "new-slice:old-left", slicing })),
      persistTurnSummary(payload("right1", { sliceId: "new-slice:old-right", slicing })),
    ]);
    expect(results.every((result) => result.kind === "committed")).toBe(true);
    const cores = await recordFiles();
    expect(cores).toHaveLength(1);
    for (const id of ["seed1", "left1", "right1"]) {
      expect(cores[0]!.raw.match(new RegExp(`Question ${id}`, "g"))).toHaveLength(1);
      expect(cores[0]!.raw.match(new RegExp(`Answer ${id}`, "g"))).toHaveLength(1);
    }
  });

  it("replays after capacity and more than 300 commits without duplicating a record", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const firstPayload = payload("first1");
    const first = await persistTurnSummary(firstPayload);
    expect(first.kind).toBe("committed");
    expect(first.receipt?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    const firstSlice = first.receipt!.records[0]!.sliceId;
    vi.setSystemTime(new Date("2026-10-22T08:01:00Z"));
    const second = await persistTurnSummary(payload("second2", { sliceId: firstSlice }));
    expect(second.receipt!.records[0]!.sliceId).not.toBe(firstSlice);
    for (let n = 0; n < 301; n++) {
      await git.commit({ fs, dir: process.env.MEMORY_ROOT!, message: `External history ${n}`, author: { name: "Fixture", email: "fixture@example.test" } });
    }
    const replay = await persistTurnSummary(firstPayload);
    expect(replay.kind).toBe("deduped");
    expect(replay.receipt?.records).toEqual([{ sliceId: firstSlice, turnIds: ["first1"] }]);
    const cores = await recordFiles();
    expect(cores).toHaveLength(2);
    expect(cores.reduce((n, { raw }) => n + (raw.match(/## Turn first1 .*\(agent\)/g)?.length ?? 0), 0)).toBe(1);
    const log = await git.log({ fs, dir: process.env.MEMORY_ROOT! });
    expect(log.filter((c) => c.commit.message.startsWith("Summary"))).toHaveLength(2);
  });

  it("multiple regenerated answers share one user identity; a normal same-text message is distinct", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const original = payload("user1", { slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 } });
    const first = await persistTurnSummary(original);
    for (const id of ["regen1", "regen2"]) {
      const result = await persistTurnSummary({ ...original, own: { ...original.own, turnId: id, regenerate: true, replyText: `Answer ${id}` } });
      expect(result.kind).toBe("committed");
    }
    await persistTurnSummary({ ...original, own: { ...original.own, turnId: "newmsg", clientMessageId: "different-message", replyText: "New answer" } });
    const cores = await recordFiles();
    expect(cores).toHaveLength(1);
    const { parseSlice } = await import("@/lib/episodic/manager");
    const turns = parseSlice(cores[0]!.raw).turns;
    expect(turns.filter((t) => t.role === "user")).toHaveLength(2);
    expect(turns.filter((t) => t.role === "agent")).toHaveLength(4);
    expect(turns.find((t) => t.turnId === "regen2")?.replyTo).toBe("user1");
    expect(first.receipt?.commitSha).toBeTruthy();
    const { readSummaryLog } = await import("@/lib/chat/hq-log");
    expect((await readSummaryLog()).available).toBe(true);
  });
});
