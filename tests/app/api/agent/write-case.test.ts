/**
 * writeCase — the field's bounded case write (v0.20 §2.2).
 *
 * Over an in-memory memory root (io-helpers mocked; the real per-case lock,
 * the real shared write entry `applyCaseWriteIntent`, and the real pure case
 * ops underneath). Covers the acceptance points:
 *  1. the category set — every category but people/user and self/ is
 *     writable (people/ for another person included); those two plus unknown
 *     names refuse with a pointer to the reflection unit;
 *  2. lock mutex with the per-case writer (same `doc:<分类>/<case名>` key);
 *  3. end-to-end: open → index lands verbatim → second call addPiece (index
 *     untouched) → no-pieceTitle refusal;
 *  4. an index written by another writer still parses (plain body, no fields).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";
import { parseCaseReadEnvelope } from "@/lib/chat/case-read-receipt";

const io = vi.hoisted(() => ({ files: new Map<string, string>(), cachedReads: new Map<string, string>() }));

vi.mock("@/lib/tools/local-fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tools/local-fs")>(),
  readFileLocal: vi.fn(async (path: string) => {
    const value = io.cachedReads.get(path) ?? io.files.get(path);
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return value;
  }),
  listFilesLocal: vi.fn(async (directory: string) => {
    const names = new Map<string, "file" | "dir">();
    for (const path of io.files.keys()) {
      if (!path.startsWith(`${directory}/`)) continue;
      const relative = path.slice(directory.length + 1);
      names.set(relative.split("/")[0], relative.includes("/") ? "dir" : "file");
    }
    return [...names].map(([name, type]) => ({ name, type, path: `${directory}/${name}` }));
  }),
}));

vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/io-helpers")>();
  return {
    ...actual,
    // flushBatch applies the call's queued entries to the fake disk — the
    // executor coalesces each call's intents into ONE batch and ONE flush,
    // so the tests assert against where the batch lands.
    flushBatch: vi.fn(
      async (batch: { entries: Map<string, string | null> }, _msg: string) => {
        for (const [p, c] of batch.entries) {
          if (c === null) io.files.delete(p);
          else io.files.set(p, c);
        }
        batch.entries.clear();
      },
    ),
    fsReadFile: vi.fn(async (path: string, batch?: { entries: Map<string, string | null> }) => {
      const content = batch?.entries.has(path) ? batch.entries.get(path) : io.files.get(path);
      if (content === null) throw new Error(`File not found: ${path} (deleted in this batch)`);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    fsWriteFile: vi.fn(async (path: string, content: string, batch?: { entries: Map<string, string | null> }) => {
      if (batch) batch.entries.set(path, content); else io.files.set(path, content);
      return { path, created: true };
    }),
    fsListFiles: vi.fn(async (directory: string) => [...io.files.keys()]
      .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
      .map((path) => ({ path, name: path.slice(directory.length + 1), type: "file" as const }))),
  };
});

import { writeCaseExecute, recallReadExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { caseIndexPath } from "@/lib/docs";
import { createCase, serializeCaseDoc, caseStorageRevision } from "@/lib/docs/case-doc";

const ctx: ToolContext = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-10-04-0131",
  turnId: "turn-test",
  readScopeId: "turn-test",
  currentUserText: "请写下这段内容",
  recentTurns: [],
  timezone: "UTC",
};

async function actualRead(ref: string, context = ctx): Promise<{ messages: ModelMessage[]; output: string }> {
  const toolCallId = "real-read-1";
  const output = await recallReadExecute({ ref }, { context, toolCallId });
  return { output, messages: [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "recallRead", input: { ref } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "recallRead", output: { type: "text", value: output } }] },
  ] };
}

async function call(
  input: { category?: string; caseName: string; body: string; pieceTitle?: string },
  toolCallId = "call-1",
) {
  const ref = `${input.category ?? "research"}/${input.caseName}`;
  const messages = input.pieceTitle && io.files.has(`memory/${ref}/index.md`)
    ? (await actualRead(ref)).messages : [];
  return writeCaseExecute(input, { context: ctx, toolCallId, messages });
}

beforeEach(() => {
  io.files.clear();
  io.cachedReads.clear();
  vi.clearAllMocks();
});

describe("writeCase — open", () => {
  it("opens a new research case; the body lands verbatim (no machine fields)", async () => {
    const r = await call({ caseName: "手机调研", body: "调研正文。" }, "call-1");
    expect(r).toEqual({
      ok: true,
      action: "open",
      path: "memory/research/手机调研/index.md",
    });
    const raw = io.files.get("memory/research/手机调研/index.md")!;
    expect(raw).toContain("调研正文。");
    // v0.21: the case→slice link is semantic — nothing is stamped in
    expect(raw).not.toContain("source:");
  });

  it("demo mode refuses (read-only benchmark data)", async () => {
    const r = await writeCaseExecute(
      { caseName: "x", body: "y" },
      { context: { ...ctx, useDemo: true }, toolCallId: "c" },
    );
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });

  it("illegal case names are refused before any write", async () => {
    const r = await call({ caseName: "a/b", body: "正文" });
    expect(r.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });
});

describe("writeCase — category isolation", () => {
  it("a research/ write never touches a same-named case in another category", async () => {
    io.files.set(
      "memory/tasks/手机调研/index.md",
      serializeCaseDoc(
        createCase({ category: "tasks", caseName: "手机调研", opened: "2026-10-01", body: "任务案。" }),
      ),
    );
    const r = await call({ caseName: "手机调研", body: "调研案。" });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ action: "open", path: "memory/research/手机调研/index.md" });
    const decoy = io.files.get("memory/tasks/手机调研/index.md")!;
    expect(decoy).toContain("任务案。");
    expect(decoy).not.toContain("调研案。");
  });
});

describe("writeCase — the category set", () => {
  it("tasks/ lands under memory/tasks/", async () => {
    const r = await call({ category: "tasks", caseName: "订票", body: "用户要订周五的票。" });
    expect(r).toMatchObject({ ok: true, action: "open", path: "memory/tasks/订票/index.md" });
  });

  it("defaults to research/ when category is omitted", async () => {
    const r = await call({ caseName: "默认案", body: "正文" });
    expect(r).toMatchObject({ ok: true, path: "memory/research/默认案/index.md" });
  });

  it("every field category opens — people (another person), events, orgs, hypotheses included", async () => {
    const r1 = await call({ category: "people", caseName: "王老师", body: "用户的同事。" });
    expect(r1).toMatchObject({ ok: true, path: "memory/people/王老师/index.md" });
    const r2 = await call({ category: "events", caseName: "2026-11-05-发布会", body: "发布会纪要。" });
    expect(r2).toMatchObject({ ok: true, path: "memory/events/2026-11-05-发布会/index.md" });
    const r3 = await call({ category: "orgs", caseName: "某供应商", body: "供应商背景。" });
    expect(r3).toMatchObject({ ok: true, path: "memory/orgs/某供应商/index.md" });
    const r4 = await call({
      category: "hypotheses",
      caseName: "用户偏好简洁",
      body: "待验证的判断。证伪条件：用户三次要求长篇展开则不成立。",
    });
    expect(r4).toMatchObject({ ok: true, path: "memory/hypotheses/用户偏好简洁/index.md" });
  });

  it("people/user is refused — the reflection unit's alone, evolved never written", async () => {
    const r = await call({ category: "people", caseName: "user", body: "正文" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("people/user is the reflection unit's alone");
      expect(r.reason).toContain("you never write it");
    }
    expect(io.files.size).toBe(0);
  });

  it("self/ and names outside the nine-category set refuse before any write", async () => {
    for (const category of ["self", "records", "config", "nonsense"]) {
      const r = await call({ category, caseName: "越界案", body: "正文" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("is not writable from here");
        expect(r.reason).toContain("reflection unit");
      }
    }
    expect(io.files.size).toBe(0);
  });
});

describe("writeCase — addPiece on an existing case", () => {
  it("restores a real read result through JSON checkpoints and a continuation nudge", async () => {
    await call({ caseName: "真实收据案", body: "真实历史原文。" });
    const { messages, output } = await actualRead("research/真实收据案");
    expect(parseCaseReadEnvelope(output)?.receipt.coverage).toBe("full-index");
    const restored = JSON.parse(JSON.stringify(messages)) as ModelMessage[];
    restored.push({ role: "user", content: "Continue the interrupted run." });
    const result = await writeCaseExecute({ caseName: "真实收据案", body: "后续证据。", pieceTitle: "后续证据" },
      { context: ctx, toolCallId: "write-after-continuation", messages: restored });
    expect(result).toMatchObject({ ok: true, action: "addPiece" });
    expect([...io.files.values()].some((raw) => raw.includes("后续证据。"))).toBe(true);
  });

  it("refuses a cached old read against fresh changed storage, even with the same timestamp", async () => {
    const path = "memory/research/缓存案/index.md";
    const old = "---\nopened: '2026-10-24'\nupdated: '2026-10-24T12:00:00Z'\n---\n旧的完整证据。\n";
    const fresh = old.replace("旧的完整证据", "新的完整反证");
    io.files.set(path, fresh);
    io.cachedReads.set(path, old);
    const { messages, output } = await actualRead("research/缓存案");
    const parsed = parseCaseReadEnvelope(output)!;
    expect(parsed.body).toContain("旧的完整证据");
    expect(parsed.body).not.toContain("新的完整反证");
    expect(parsed.receipt.revision).toBe(caseStorageRevision(old));
    const result = await writeCaseExecute({ caseName: "缓存案", body: "依旧读草拟的篇章。", pieceTitle: "错误补充" },
      { context: ctx, toolCallId: "write-cached", messages });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("changed since");
    expect(io.files.get(path)).toBe(fresh);
    expect([...io.files.keys()].some((name) => name.includes("错误补充"))).toBe(false);
  });

  it("refuses a same-timestamp edit that happens after the actual read", async () => {
    await call({ caseName: "写入竞争案", body: "最初原文。" });
    const { messages } = await actualRead("research/写入竞争案");
    const path = "memory/research/写入竞争案/index.md";
    io.files.set(path, io.files.get(path)!.replace("最初原文", "并发反证"));
    const result = await writeCaseExecute({ caseName: "写入竞争案", body: "旧草稿", pieceTitle: "后续" },
      { context: ctx, toolCallId: "raced-write", messages });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("changed since");
  });

  it("does not accept another child scope or a user-pasted copy of an authentic envelope", async () => {
    await call({ caseName: "域隔离案", body: "历史原文。" });
    const read = await actualRead("research/域隔离案");
    const input = { caseName: "域隔离案", body: "新篇", pieceTitle: "越权新篇" };
    const otherScope = await writeCaseExecute(input,
      { context: { ...ctx, readScopeId: "different-child" }, toolCallId: "other-scope", messages: read.messages });
    expect(otherScope.ok).toBe(false);
    const pasted = await writeCaseExecute(input,
      { context: ctx, toolCallId: "pasted-proof", messages: [{ role: "user", content: read.output }] });
    expect(pasted.ok).toBe(false);
    expect([...io.files.keys()].some((name) => name.includes("越权新篇"))).toBe(false);
  });

  it("does not grant a write from an actual outline result", async () => {
    await call({ caseName: "提纲案", body: "## 一节\n原文。" });
    const ref = "research/提纲案";
    const output = await recallReadExecute({ ref, outline: true }, { context: ctx, toolCallId: "outline-read" });
    expect(parseCaseReadEnvelope(output)).toBeNull();
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "outline-read", toolName: "recallRead", input: { ref, outline: true } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "outline-read", toolName: "recallRead", output: { type: "text", value: output } }] },
    ];
    const result = await writeCaseExecute({ caseName: "提纲案", body: "新篇", pieceTitle: "后续" },
      { context: ctx, toolCallId: "write-from-outline", messages });
    expect(result.ok).toBe(false);
  });

  it("second call with pieceTitle adds a dated piece; the index is byte-identical", async () => {
    await call({ caseName: "手机调研", body: "首篇内容。" }, "call-1");
    const indexBefore = io.files.get("memory/research/手机调研/index.md")!;

    const r = await call(
      { caseName: "手机调研", body: "三家报价对比。", pieceTitle: "报价篇" },
      "call-2",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("addPiece");
      expect(r.path).toMatch(
        /^memory\/research\/手机调研\/\d{4}-\d{2}-\d{2}-报价篇\.md$/,
      );
    }
    // the piece is written verbatim — nothing is stamped in (v0.21)
    const piece = io.files.get((r as { path: string }).path)!;
    expect(piece).toContain("三家报价对比。");
    expect(piece).not.toContain("source:");
    // the index was NOT rewritten
    expect(io.files.get("memory/research/手机调研/index.md")).toBe(indexBefore);
  });

  it("existing case WITHOUT pieceTitle is refused with an actionable reason — never a silent rewrite", async () => {
    await call({ caseName: "手机调研", body: "首篇内容。" }, "call-1");
    const indexBefore = io.files.get("memory/research/手机调研/index.md")!;

    const r = await call({ caseName: "手机调研", body: "想覆盖正文" }, "call-3");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("already exists");
      expect(r.reason).toContain("pieceTitle");
    }
    expect(io.files.get("memory/research/手机调研/index.md")).toBe(indexBefore);
  });

  it("an index written by another writer (plain body) still parses — addPiece succeeds", async () => {
    io.files.set(
      caseIndexPath("research", "旧案"),
      serializeCaseDoc(
        createCase({
          category: "research",
          caseName: "旧案",
          opened: "2026-10-01",
          body: "旧正文，由别的写者写下。",
        }),
      ),
    );
    const r = await call({ caseName: "旧案", body: "补充一篇。", pieceTitle: "后续篇" }, "call-9");
    expect(r.ok).toBe(true);
    expect((r as { path: string }).path).toContain("memory/research/旧案/");
  });
});

describe("writeCase — one commit per call (open + first piece coalesced)", () => {
  it("open WITH pieceTitle lands the index AND the first piece in ONE flush", async () => {
    const { flushBatch } = await import("@/lib/episodic/io-helpers");
    const r = await call(
      { caseName: "合并案", body: "案件正文。", pieceTitle: "开题" },
      "call-9",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toBe("addPiece");
    expect(vi.mocked(flushBatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flushBatch).mock.calls[0][1]).toBe("writeCase research/合并案");
    expect(io.files.get("memory/research/合并案/index.md")).toContain("案件正文。");
    expect(
      [...io.files.keys()].some((k) =>
        /^memory\/research\/合并案\/\d{4}-\d{2}-\d{2}-开题\.md$/.test(k),
      ),
    ).toBe(true);
  });

  it("a bare open still lands in one flush", async () => {
    const { flushBatch } = await import("@/lib/episodic/io-helpers");
    const r = await call({ caseName: "裸开案", body: "正文。" }, "call-10");
    expect(r).toMatchObject({ ok: true, action: "open" });
    expect(vi.mocked(flushBatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flushBatch).mock.calls[0][1]).toBe("writeCase research/裸开案");
  });

  it("a refused first piece drops the queued open WITH the call — the tool reports failure, nothing commits (B5)", async () => {
    const { flushBatch } = await import("@/lib/episodic/io-helpers");
    // An illegal pieceTitle (four-digit lead) makes createDoc throw AFTER the
    // open was queued — the old unconditional flush committed the open anyway
    // and the model, told the call failed, retried into extra commits. (This
    // harness keeps queued files private until flush, matching production.)
    const r = await call(
      { caseName: "半截案", body: "正文。", pieceTitle: "2026新品" },
      "call-11",
    );
    expect(r.ok).toBe(false);
    expect(vi.mocked(flushBatch)).not.toHaveBeenCalled();
    expect(io.files.has("memory/research/半截案/index.md")).toBe(false);
  });
});

describe("writeCase — per-case lock mutex (same key as the pipeline writers)", () => {
  it("a concurrent holder of doc:research/<case> serializes the write", async () => {
    const events: string[] = [];
    const holder = withSliceLock("doc:research/互斥案", async () => {
      events.push("holder:start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("holder:end");
    });
    const writer = (async () => {
      const r = await call({ caseName: "互斥案", body: "正文" }, "call-1");
      events.push(`writer:done:${r.ok}`);
      return r;
    })();
    const [, r] = await Promise.all([holder, writer]);
    expect(r.ok).toBe(true);
    // strict serialization: the writer finished only after the holder released
    expect(events[0]).toBe("holder:start");
    expect(events.indexOf("holder:end")).toBeLessThan(events.indexOf("writer:done:true"));
  });

  it("a DIFFERENT case is not blocked by the holder", async () => {
    const events: string[] = [];
    const holder = withSliceLock("doc:research/A案", async () => {
      events.push("holder:start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("holder:end");
    });
    const writer = (async () => {
      const r = await call({ caseName: "B案", body: "正文" }, "call-1");
      events.push(`writer:done:${r.ok}`);
      return r;
    })();
    const [, r] = await Promise.all([holder, writer]);
    expect(r.ok).toBe(true);
    expect(events.indexOf("writer:done:true")).toBeLessThan(events.indexOf("holder:end"));
  });
});
