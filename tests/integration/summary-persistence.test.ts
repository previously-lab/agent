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
  it("persists image-only submission metadata once at its final slice and keeps draft preview readable", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const service = await import("@/lib/tools/staged-images");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
    const image = await service.stageImage({ data: bytes, name: "fictional.png" });
    const reservation = await service.reserveStagedImages([{ assetId: image.assetId, ordinal: 2 }], "message-image");
    await reservation.confirm();
    const input = payload("image1");
    input.own.userText = ""; input.own.clientMessageId = "message-image"; input.own.imageAttachments = reservation.attachments;
    const first = await persistTurnSummary(input); expect(first.kind).toBe("committed");
    const second = await persistTurnSummary(input); expect(second.kind).toBe("deduped");
    const files = await recordFiles(); expect(files).toHaveLength(1);
    const { parseSlice } = await import("@/lib/episodic/manager");
    const slice = parseSlice(files[0].raw);
    const turn = slice.turns.find((entry) => entry.role === "user" && entry.clientMessageId === "message-image");
    expect(turn?.content).toBe(""); expect(turn?.attachments?.[0]).toMatchObject({ assetId: image.assetId, ordinal: 2 });
    expect(turn?.attachments?.[0].ref).toContain(slice.slice_id.replace(/-/g, "/"));
    expect((await service.readStagedImage(image.assetId)).data).toEqual(bytes);
    const binaryFiles = (await git.listFiles({ fs, dir: process.env.MEMORY_ROOT! })).filter((file) => file.includes("/attachments/"));
    expect(binaryFiles).toHaveLength(1);
  });
  it("retries a local core write failure after image bytes landed without duplicating evidence", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const { legacyMessageImages } = await import("@/lib/tools/chat-image-input");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
    const part = { type: "file" as const, mediaType: "image/png", url: `data:image/png;base64,${png}`, filename: "same.png" };
    const input = payload("retryimage");
    input.own.imageAttachments = legacyMessageImages([{ id: "m", role: "user", parts: [part, part] }]);
    const local = await import("@/lib/tools/local-fs"); const write = local.writeFileLocal;
    let interrupted = false;
    const spy = vi.spyOn(local, "writeFileLocal").mockImplementation(async (file, content) => {
      if (!interrupted && file.endsWith("/core.md")) {
        interrupted = true;
        const dir = path.join(process.env.MEMORY_ROOT!, file.replace(/^memory\//, "").replace(/core\.md$/, "attachments"));
        expect(fs.readdirSync(dir)).toHaveLength(2);
        throw new Error("fixture core disk write interrupted");
      }
      return write(file, content);
    });
    try {
      const result = await persistTurnSummary(input); expect(result.kind).toBe("committed"); expect(interrupted).toBe(true);
      const files = await recordFiles(); expect(files).toHaveLength(1);
      const { parseSlice } = await import("@/lib/episodic/manager");
      expect(parseSlice(files[0].raw).turns.find((turn) => turn.role === "user")?.attachments).toHaveLength(2);
      expect((await git.listFiles({ fs, dir: process.env.MEMORY_ROOT! })).filter((file) => file.includes("/attachments/"))).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });
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

  it("legacy regeneration without a client ID reuses the saved user turn", async () => {
    const { persistTurnSummary } = await import("@/app/api/chat/steps");
    const original = payload("legacy1", { slicing: { idleGapMinutes: 720, maxSliceMinutes: 30, maxTurnsPerSlice: 40 } });
    delete original.own.clientMessageId;
    const first = await persistTurnSummary(original);
    const sliceId = first.receipt!.records[0]!.sliceId;
    for (const turnId of ["legacyregen1", "legacyregen2"]) {
      const result = await persistTurnSummary({ ...original, sliceId, own: { ...original.own, sliceId, turnId, regenerate: true, replyText: `Answer ${turnId}` } });
      expect(result.kind).toBe("committed");
    }
    const cores = await recordFiles();
    expect(cores).toHaveLength(1);
    const { parseSlice } = await import("@/lib/episodic/manager");
    const turns = parseSlice(cores[0].raw).turns;
    expect(turns.filter((turn) => turn.role === "user")).toEqual([expect.objectContaining({ turnId: "legacy1", content: original.own.userText })]);
    expect(turns.find((turn) => turn.role === "user")?.clientMessageId).toBeUndefined();
    expect(turns.filter((turn) => turn.role === "agent")).toHaveLength(3);
    expect(turns.find((turn) => turn.turnId === "legacyregen2")?.replyTo).toBe("legacy1");
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
