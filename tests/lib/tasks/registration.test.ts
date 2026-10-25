import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteBatch } from "@/lib/episodic/io-helpers";

const io = vi.hoisted(() => ({
  files: new Map<string, string>(), ledgerLock: false, flushes: 0,
  failPath: null as string | null, flushError: null as unknown,
  beforeFlush: null as null | ((batch: WriteBatch) => void),
  batches: [] as Array<string[]>,
}));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: () => "local" }));
vi.mock("@/lib/capabilities", () => ({ getRepoConfig: () => ({ owner: "fixture", repo: "fixture" }) }));
vi.mock("@/lib/github/read-view", () => ({ getGitHubReadHead: vi.fn() }));
vi.mock("@/lib/episodic/slice-mutex", () => ({
  withSliceLock: async (key: string, work: () => Promise<unknown>) => {
    if (key !== "task-ledger") return work();
    io.ledgerLock = true;
    try { return await work(); } finally { io.ledgerLock = false; }
  },
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  createBatch: () => ({ entries: new Map(), encodings: new Map() }),
  fsReadFile: vi.fn(async (path: string, batch?: WriteBatch) => {
    if (io.failPath === path) throw new Error("backend unavailable");
    const value = batch?.entries.has(path) ? batch.entries.get(path) : io.files.get(path);
    if (value === undefined || value === null) throw new Error(`File not found: ${path}`);
    return value;
  }),
  fsWriteFile: vi.fn(async (path: string, text: string, batch: WriteBatch) => { batch.entries.set(path, text); return { path, created: true }; }),
  flushBatch: vi.fn(async (batch: WriteBatch) => {
    expect(io.ledgerLock).toBe(true);
    io.flushes += 1; io.batches.push([...batch.entries.keys()]);
    io.beforeFlush?.(batch);
    if (io.flushError) throw io.flushError;
    for (const [path, text] of batch.entries) {
      if (text === null) io.files.delete(path); else io.files.set(path, text);
    }
    batch.entries.clear();
    return `commit-${io.flushes}`;
  }),
}));

import { registerTaskWithDocument } from "@/lib/tasks/registration";
import { TASK_LEDGER_PATH, type CreateTaskInput } from "@/lib/tasks/contracts";
import { parseTaskLedger } from "@/lib/tasks/ledger";
import { recallRead } from "@/lib/memory/facade";

const documentPath = "memory/tasks/核实到货/index.md";
const request = (): CreateTaskInput => ({
  operationId: "create-user-turn-1", now: "2026-10-26T12:00:00.000Z",
  task: { ref: "tasks/核实到货", summary: "到货后核实设备能否使用。" },
  userCommitment: { sliceId: "2026-10-26-1200", turnId: "user-turn-1", statement: "等东西到了，你再跟我确认能不能用。" },
});
beforeEach(() => { io.files.clear(); io.flushes = 0; io.batches = []; io.failPath = null; io.flushError = null; io.beforeFlush = null; io.ledgerLock = false; });

describe("task registration with its readable case document", () => {
  it("commits ledger and prose together and makes the case readable by recallRead", async () => {
    const result = await registerTaskWithDocument(request());
    expect(result).toMatchObject({ outcome: "applied", queued: false, commitSha: "commit-1", attempts: 1 });
    expect(io.batches).toEqual([[documentPath, TASK_LEDGER_PATH]]);
    expect(parseTaskLedger(io.files.get(TASK_LEDGER_PATH)!)).toMatchObject({ tasks: [{ ref: "tasks/核实到货" }] });
    const read = await recallRead({ listMemoryFiles: async () => [...io.files.keys()], readFile: async (path) => {
      const text = io.files.get(path); if (text === undefined) throw new Error(`File not found: ${path}`); return text;
    } }, { ref: "tasks/核实到货" });
    if (read.kind !== "content") throw new Error("registered case not readable");
    expect(read.content).toContain(request().task.summary);
    expect(read.content).toContain(request().userCommitment.statement);
    expect(read.content).toContain("records/2026-10-26-1200");
  });

  it("preserves an existing document byte-for-byte, including on a deduplicated retry", async () => {
    const original = "旧的自由研究文稿\r\n不能改。";
    io.files.set(documentPath, original);
    await registerTaskWithDocument(request(), "新的文稿");
    const retry = await registerTaskWithDocument(request(), "再次传入不同文稿");
    expect(retry).toMatchObject({ outcome: "deduped", queued: false, commitSha: null });
    expect(io.files.get(documentPath)).toBe(original);
    expect(io.flushes).toBe(1);
  });

  it("keeps an English commitment in English without injecting localized template prose", async () => {
    const input = request();
    input.task.summary = "Check whether the device works after delivery.";
    input.userCommitment.statement = "Ask me whether it works when the device arrives.";
    await registerTaskWithDocument(input);
    const document = io.files.get(documentPath)!;
    expect(document).toContain(input.task.summary);
    expect(document).toContain(`> ${input.userCommitment.statement}`);
    expect(document).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("does not flush queued ledger state when the document read failed", async () => {
    io.failPath = documentPath;
    await expect(registerTaskWithDocument(request())).rejects.toThrow("backend unavailable");
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
    expect(io.flushes).toBe(0);
  });

  it("does not report success or orphan a ledger on flush failure, and can retry", async () => {
    io.flushError = new Error("disk unavailable");
    await expect(registerTaskWithDocument(request())).rejects.toThrow("disk unavailable");
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
    expect(io.files.has(documentPath)).toBe(false);
    io.flushError = null;
    expect(await registerTaskWithDocument(request())).toMatchObject({ outcome: "applied", attempts: 1 });
  });

  it("replays the whole operation after a HEAD conflict and preserves a concurrently created case", async () => {
    io.beforeFlush = () => {
      io.beforeFlush = null;
      io.files.set(documentPath, "并发写者创建的文稿。");
      throw Object.assign(new Error("not a fast-forward"), { status: 409 });
    };
    const result = await registerTaskWithDocument(request());
    expect(result.attempts).toBe(2);
    expect(io.files.get(documentPath)).toBe("并发写者创建的文稿。");
    expect(io.batches[1]).toEqual([TASK_LEDGER_PATH]);
  });

  it("bounds repeated HEAD conflicts to three fresh attempts", async () => {
    io.flushError = Object.assign(new Error("not a fast-forward"), { status: 422 });
    await expect(registerTaskWithDocument(request())).rejects.toMatchObject({ code: "head_conflict" });
    expect(io.flushes).toBe(3);
    expect(io.files.has(TASK_LEDGER_PATH)).toBe(false);
  });

  it("rejects invented record paths before any queued mutation", async () => {
    const input = request(); input.userCommitment.sliceId = "../../fake/source";
    await expect(registerTaskWithDocument(input)).rejects.toMatchObject({ code: "invalid_operation" });
    expect(io.files.size).toBe(0);
    expect(io.flushes).toBe(0);
  });
});
