import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteBatch } from "@/lib/episodic/io-helpers";

const h = vi.hoisted(() => ({
  source: "github" as "github" | "local" | "demo", head: "head-a",
  headError: null as unknown, files: new Map<string, string>(), events: [] as string[],
  getHead: vi.fn(), commit: vi.fn(),
}));
vi.mock("@/lib/data-source/resolve", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data-source/resolve")>(), resolveDataSource: () => h.source,
}));
vi.mock("@/lib/capabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capabilities")>(), getRepoConfig: () => ({ owner: "fixture", repo: "fixture" }),
}));
vi.mock("@/lib/github/read-view", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/github/read-view")>(), getGitHubReadHead: h.getHead,
}));
vi.mock("@/lib/tools/batch-write", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tools/batch-write")>(), commitBatchToGitHub: h.commit,
}));
vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/episodic/io-helpers")>(),
  fsReadFile: vi.fn(async (path: string, batch?: WriteBatch) => {
    h.events.push(`read:${path}`);
    const raw = batch?.entries.has(path) ? batch.entries.get(path) : h.files.get(path);
    if (raw === undefined || raw === null) throw new Error(`File not found: ${path}`);
    return raw;
  }),
  fsWriteFile: vi.fn(async (path: string, raw: string, batch?: WriteBatch) => {
    if (batch) batch.entries.set(path, raw); else h.files.set(path, raw);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async (directory: string) => [...h.files.keys()]
    .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
    .map((path) => ({ path, name: path.slice(directory.length + 1), type: "file" as const }))),
}));

import { createBatch, flushBatch } from "@/lib/episodic/io-helpers";
import { applyCaseWriteIntent, applyCaseCurrentUnderstanding, createCaseReadScope, readCaseIndexForScope } from "@/lib/episodic/flash/librarian";

const date = "2026-10-26";
const index = "memory/research/共享案/index.md";
const old = "---\nopened: '2026-10-24'\nupdated: '2026-10-24T12:00:00Z'\n---\n历史依据。\n";
beforeEach(() => {
  vi.clearAllMocks(); h.source = "github"; h.head = "head-a"; h.headError = null; h.files.clear(); h.events = [];
  h.files.set(index, old);
  h.getHead.mockImplementation(async () => {
    h.events.push("head"); if (h.headError) throw h.headError; return { headSha: h.head };
  });
  h.commit.mockImplementation(async (entries: Array<{ path: string; content: string | null }>, _message: string, basis?: string) => {
    if (basis !== h.head) throw Object.assign(new Error("not a fast-forward"), { status: 409 });
    for (const entry of entries) {
      if (entry.content === null) h.files.delete(entry.path); else h.files.set(entry.path, entry.content);
    }
    return "committed";
  });
});

describe("case write HEAD basis", () => {
  it("pins before fresh content comparison and passes the basis to the real flush", async () => {
    const scope = createCaseReadScope();
    await readCaseIndexForScope({ category: "research", caseName: "共享案", scope });
    h.events = [];
    const batch = createBatch();
    await applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "共享案", line: "已核实的新补充。" }, date, batch, scope);
    expect(h.events[0]).toBe("head");
    expect(h.events[1]).toBe(`read:${index}`);
    expect(batch.baseHeadSha).toBe("head-a");
    await flushBatch(batch, "guarded case write");
    expect(h.commit.mock.calls[0][2]).toBe("head-a");
  });

  it("rejects a moved HEAD at flush instead of rebasing checked old bytes", async () => {
    const batch = createBatch();
    await applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "共享案", line: "旧依据的草稿" }, date, batch);
    h.head = "head-b";
    h.files.set(index, old + "并发的新证据。\n");
    await expect(flushBatch(batch, "must not rebase")).rejects.toMatchObject({ status: 409 });
    expect(h.commit.mock.calls[0][2]).toBe("head-a");
    expect(h.files.get(index)).toBe(old + "并发的新证据。\n");
    expect(batch.entries.size).toBeGreaterThan(0);
  });

  it("preserves an existing basis without requesting another HEAD", async () => {
    const batch = createBatch(); batch.baseHeadSha = "earlier-hq-basis";
    await applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "共享案", line: "补充" }, date, batch);
    expect(batch.baseHeadSha).toBe("earlier-hq-basis");
    expect(h.getHead).not.toHaveBeenCalled();
  });

  it("resolves only one HEAD for parallel different-case writes in the same batch", async () => {
    const batch = createBatch();
    await Promise.all(["甲案", "乙案"].map((caseName) => applyCaseWriteIntent({ action: "open", category: "research", caseName, body: "新原文" }, date, batch)));
    expect(h.getHead).toHaveBeenCalledTimes(1);
    expect(batch.baseHeadSha).toBe("head-a");
  });

  it("pins the direct current-understanding entry before its refresh read", async () => {
    const scope = createCaseReadScope(); const batch = createBatch();
    await applyCaseCurrentUnderstanding({ category: "research", caseName: "共享案", date, batch, scope, refreshRead: true,
      current: { body: "目前有两种解释。", evidence: ["research/共享案"] } });
    expect(h.events[0]).toBe("head");
    expect(h.getHead).toHaveBeenCalledTimes(1);
    expect(batch.baseHeadSha).toBe("head-a");
    expect(batch.entries.has("memory/research/共享案/_current.md")).toBe(true);
  });

  it("fails closed before reading or queueing content if HEAD lookup fails", async () => {
    h.headError = new Error("GitHub unavailable"); const batch = createBatch();
    await expect(applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "共享案", line: "补充" }, date, batch))
      .rejects.toThrow("GitHub unavailable");
    expect(h.events).toEqual(["head"]);
    expect(batch.entries.size).toBe(0);
  });

  it("rejects unguarded GitHub writes while keeping local/demo free of HEAD I/O", async () => {
    const intent = { action: "appendTail" as const, category: "research" as const, caseName: "共享案", line: "补充" };
    await expect(applyCaseWriteIntent(intent, date)).rejects.toThrow("explicit batch");
    expect(h.events).toEqual([]);
    for (const source of ["local", "demo"] as const) {
      h.source = source;
      await applyCaseWriteIntent(intent, date, createBatch());
    }
    expect(h.getHead).not.toHaveBeenCalled();
  });
});
