import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";
import type { ModelConfig } from "@/lib/models/registry";
import type { WriteBatch } from "@/lib/episodic/io-helpers";

const h = vi.hoisted(() => ({ files: new Map<string, string>(), run: vi.fn(), flush: vi.fn(), failWrite: "" }));
vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: h.run }));
vi.mock("@/lib/data-source/resolve", async (original) => ({ ...await original<typeof import("@/lib/data-source/resolve")>(), resolveDataSource: () => "local" }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string, batch?: WriteBatch) => {
    const raw = batch?.entries.has(path) ? batch.entries.get(path) : h.files.get(path);
    if (raw == null) throw new Error(`ENOENT: ${path}`);
    return raw;
  }),
  fsWriteFile: vi.fn(async (path: string, raw: string, batch?: WriteBatch) => {
    if (path === h.failWrite) throw new Error("fixture queue failed");
    if (batch) batch.entries.set(path, raw); else h.files.set(path, raw);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async (dir: string) => [...h.files.keys()]
    .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
    .map((path) => ({ path, name: path.slice(dir.length + 1), type: "file" }))),
  flushBatch: h.flush,
}));

import { applyCaseWriteIntent, createCaseReadScope, makeCaseReadTool, runScribePass } from "@/lib/episodic/flash/librarian";
import { parseCaseCurrent, parseCaseDoc } from "@/lib/docs/case-doc";

const sliceId = "2026-10-02-1200";
const date = "2026-10-02";
const root = "memory/research/工作灯";
const index = `${root}/index.md`;
const piece = `${root}/2026-10-01-供电试验.md`;
const pieceRef = "research/工作灯/2026-10-01-供电试验";
const mailbox = "memory/records/2026/10/02/1200/agent.md";
const original = "---\nopened: '2026-10-01'\nupdated: '2026-10-01T00:00:00Z'\n---\n旧的开题记录。\n";
const model = {} as ModelConfig; // The runner is replaced, so no provider can be called.
const input = { model, sliceId, date, excerpt: { focus: "工作灯", summary: "试验资料", turnsExcerpt: "用户尚未选择方案。" } };

function marker(extra: Record<string, unknown> = {}) {
  h.files.set(mailbox, `[doc-marker] ${JSON.stringify({ v: 1, id: "m", kind: "sediment", title: "工作灯", ...extra })}\n`);
}
function respond(entry: Record<string, unknown>, reads: string[] = [], afterRead?: () => void) {
  h.run.mockImplementation(async (options: RunSubAgentOptions<unknown>) => {
    for (const ref of reads) {
      await options.tools.readCase.execute!({ ref }, { toolCallId: "read", messages: [], context: undefined });
    }
    afterRead?.();
    return { ok: true, report: { entries: [{ id: "m", ...entry }], reasoning: "fixture" } };
  });
}
beforeEach(() => {
  vi.clearAllMocks(); h.files.clear(); h.failWrite = "";
  h.files.set(index, original); h.files.set(piece, "已有供电试验：两种方案均未被用户采纳。\n"); marker();
  h.flush.mockImplementation(async (batch: WriteBatch) => {
    for (const [path, raw] of batch.entries) {
      if (raw === null) h.files.delete(path); else h.files.set(path, raw);
    }
    batch.entries.clear(); return "fixture-commit";
  });
});

describe("scribe document organization", () => {
  it("lists exact unread pieces without manufacturing a read receipt", async () => {
    const scope = createCaseReadScope();
    const read = makeCaseReadTool(undefined, scope).execute!;
    const text = await read({ ref: "research/工作灯" }, { toolCallId: "r", messages: [], context: undefined });
    expect(text).toContain(pieceRef);
    expect(text).toContain("UNREAD in this run");
    expect(scope.hasEvidence(pieceRef)).toBe(false);
    await read({ ref: pieceRef }, { toolCallId: "p", messages: [], context: undefined });
    const again = await read({ ref: "research/工作灯" }, { toolCallId: "r2", messages: [], context: undefined });
    expect(again).toContain("full read in this run");
  });

  it("does not clear a covered marker from an unread directory entry", async () => {
    respond({ action: "covered", coveredRef: pieceRef, reason: "已经写过" });
    const result = await runScribePass(input);
    expect(result.skipped[0]?.reason).toContain("successful full readCase");
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("completes a verified covered marker without another document write or model rerun", async () => {
    const before = new Map(h.files);
    respond({ action: "covered", coveredRef: pieceRef, reason: "这篇试验记录覆盖同一问题，且仍注明未采纳" }, [pieceRef]);
    const result = await runScribePass(input);
    expect(result).toMatchObject({ written: [], skipped: [] });
    expect(h.files.get(index)).toBe(before.get(index));
    expect(h.files.get(piece)).toBe(before.get(piece));
    expect(h.files.get(mailbox)).toContain('"outcome":"covered"');
    expect(h.files.get(mailbox)).toContain(pieceRef);
    h.run.mockClear();
    expect((await runScribePass(input)).ran).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("rejects covered when that specific document changed after the read", async () => {
    respond({ action: "covered", coveredRef: pieceRef, reason: "试验已记录" }, [pieceRef], () => h.files.set(piece, "并发纠正了试验条件。"));
    expect((await runScribePass(input)).skipped[0]?.reason).toContain("changed since");
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
  });

  it("leaves a skipped marker pending without pretending that a document covers it", async () => {
    respond({ action: "skip", reason: "当前证据不足" });
    expect((await runScribePass(input)).written).toEqual([]);
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("rejects legacy settled prose and explicit multi-line tails with a recovery path", async () => {
    respond({ body: "重复论证。".repeat(500) });
    expect((await runScribePass(input)).skipped[0]?.reason).toContain("Replan");
    respond({ action: "appendTail", line: "第一部分\n\n第二部分" });
    expect((await runScribePass(input)).skipped[0]?.reason).toContain("addPiece");
    expect(h.files.get(index)).toBe(original);
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
  });

  it("preserves long source lines in a piece and adds only navigation to settled history", async () => {
    const source = "\n  原文缩进\n\n```text\n  value = 7\n```\n末行空格  \n";
    marker({ body: source });
    respond({ action: "addPiece", title: "供电资料", body: "待核对的试验资料；用户尚未选择。" }, [pieceRef]);
    const result = await runScribePass(input);
    expect(result.skipped).toEqual([]);
    expect(h.files.get(`${root}/${date}-供电资料.md`)).toContain(source);
    const after = parseCaseDoc(h.files.get(index)!, { category: "research", caseName: "工作灯", fileName: "index.md" });
    expect(after.body).toBe("旧的开题记录。");
    expect(after.updated).toBe("2026-10-01T00:00:00Z");
    expect(after.tail).toHaveLength(1);
    expect(after.tail[0].text).toContain("[供电资料](previously:");
    expect(h.files.get(index)).not.toContain("value = 7");
    expect(h.files.get(mailbox)).toContain("[doc-scribe]");
    expect(h.flush).toHaveBeenCalledTimes(1);
  });

  it("requires a separate overview when opening a case with its first piece", async () => {
    h.files.delete(index); h.files.delete(piece);
    respond({ action: "addPiece", title: "供电试验", body: "试验全文。" });
    expect((await runScribePass(input)).skipped[0]?.reason).toContain("overviewBody");
    expect(h.files.has(index)).toBe(false);
    respond({ action: "addPiece", title: "供电试验", body: "试验全文。", overviewBody: "按读者问题归档工作灯资料。" });
    expect((await runScribePass(input)).skipped).toEqual([]);
    expect(h.files.get(index)).toContain("按读者问题归档");
    expect(h.files.get(index)).not.toContain("试验全文");
    expect(h.files.get(`${root}/${date}-供电试验.md`)).toContain("试验全文");
  });

  it("can revise only current understanding without appending another historical essay", async () => {
    respond({ action: "reviseUnderstanding", currentUnderstanding: { body: "两种解释均待核实；没有用户决定。", evidence: ["research/工作灯"] } });
    expect((await runScribePass(input)).skipped).toEqual([]);
    expect(h.files.get(index)).toBe(original);
    expect(parseCaseCurrent(h.files.get(`${root}/_current.md`)!).body).toContain("没有用户决定");
    expect(h.files.get(mailbox)).toContain("[doc-scribe]");
  });

  it.each([index, mailbox])("does not publish orphan content when queueing %s fails", async (path) => {
    h.failWrite = path;
    respond({ action: "addPiece", title: "新试验", body: "新试验正文。" });
    const result = await runScribePass(input);
    expect(result.written).toEqual([]);
    expect(h.files.has(`${root}/${date}-新试验.md`)).toBe(false);
    expect(h.files.get(index)).toBe(original);
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
  });

  it("discards a piece and navigation if its companion current view has unread evidence", async () => {
    respond({ action: "addPiece", title: "新试验", body: "新试验正文。", currentUnderstanding: { body: "不受支持的更新。", evidence: ["records/2026-10-01-1300"] } });
    expect((await runScribePass(input)).skipped[0]?.reason).toContain("unread");
    expect(h.files.has(`${root}/${date}-新试验.md`)).toBe(false);
    expect(h.files.get(index)).toBe(original);
    expect(h.files.get(mailbox)).not.toContain("[doc-scribe]");
  });

  it("merges the accepted publication into the existing batch without flushing unrelated work", async () => {
    const batch: WriteBatch = { entries: new Map([["memory/research/别案/index.md", "other pending work"]]) };
    respond({ action: "addPiece", title: "新试验", body: "新试验正文。" });
    expect((await runScribePass({ ...input, batch })).skipped).toEqual([]);
    expect(batch.entries.get("memory/research/别案/index.md")).toBe("other pending work");
    expect(batch.entries.has(`${root}/${date}-新试验.md`)).toBe(true);
    expect(batch.entries.get(index)).toContain("[新试验]");
    expect(batch.entries.get(mailbox)).toContain("[doc-scribe]");
    expect(h.files.get(index)).toBe(original);
    expect(h.flush).not.toHaveBeenCalled();
  });

  it("does not duplicate a navigation line on an identical piece retry", async () => {
    const intent = { action: "addPiece" as const, category: "research" as const, caseName: "工作灯", title: "新试验", body: "新试验正文。" };
    await applyCaseWriteIntent(intent, date);
    const after = h.files.get(index);
    expect((await applyCaseWriteIntent(intent, date)).noop).toBe(true);
    expect(h.files.get(index)).toBe(after);
  });
});
