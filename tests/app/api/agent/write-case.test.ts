/**
 * writeCase — the reply segment's ONE bounded write (v0.20 §2.2).
 *
 * Over an in-memory memory root (io-helpers mocked; the real per-case lock,
 * the real shared write entry `applyCaseWriteIntent`, and the real pure case
 * ops underneath). Covers the four acceptance points:
 *  1. research/-only with no free path (behavioral — the tool takes no
 *     category input and writes land only under memory/research/);
 *  2. lock mutex with the per-case writer (same `doc:<分类>/<case名>` key);
 *  3. end-to-end: open → stamped index → second call addPiece (index
 *     untouched) → no-pieceTitle refusal;
 *  4. legacy tolerance: an index written without a `source:` line parses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/io-helpers")>();
  return {
    ...actual,
    fsReadFile: vi.fn(async (path: string) => {
      const content = io.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    fsWriteFile: vi.fn(async (path: string, content: string) => {
      io.files.set(path, content);
      return { path, created: true };
    }),
  };
});

import { writeCaseExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { withSliceLock } from "@/lib/episodic/slice-mutex";
import { caseIndexPath } from "@/lib/docs";
import { createCase, serializeCaseDoc } from "@/lib/docs/case-doc";

const ctx: ToolContext = {
  repo: "local",
  owner: "local",
  useGithub: false,
  useDemo: false,
  sliceId: "2026-10-04-0131",
  recentTurns: [],
  timezone: "UTC",
};

function call(
  input: { caseName: string; body: string; pieceTitle?: string },
  toolCallId = "call-1",
) {
  return writeCaseExecute(input, { context: ctx, toolCallId });
}

beforeEach(() => {
  io.files.clear();
  vi.clearAllMocks();
});

describe("writeCase — open", () => {
  it("opens a new research case; the evidence stamp is the first line of the body", async () => {
    const r = await call({ caseName: "手机调研", body: "调研正文。" }, "call-1");
    expect(r).toEqual({
      ok: true,
      action: "open",
      path: "memory/research/手机调研/index.md",
    });
    const raw = io.files.get("memory/research/手机调研/index.md")!;
    expect(raw).toContain("source: 2026-10-04-0131#call-1\n\n调研正文。");
    // the stamp precedes the body text
    expect(raw.indexOf("source: 2026-10-04-0131#call-1")).toBeLessThan(
      raw.indexOf("调研正文。"),
    );
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

describe("writeCase — the research/ boundary", () => {
  it("writes never leave research/ — a same-named case in another category is untouched", async () => {
    // The tool exposes NO category parameter; this seeds a decoy and proves
    // the write lands under memory/research/ regardless.
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

describe("writeCase — addPiece on an existing case", () => {
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
    // the piece carries THIS call's stamp
    const piece = io.files.get((r as { path: string }).path)!;
    expect(piece).toContain("source: 2026-10-04-0131#call-2\n\n三家报价对比。");
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

  it("legacy index (no source line) still parses — addPiece succeeds", async () => {
    io.files.set(
      caseIndexPath("research", "旧案"),
      serializeCaseDoc(
        createCase({
          category: "research",
          caseName: "旧案",
          opened: "2026-10-01",
          body: "旧正文，没有 source 行。",
        }),
      ),
    );
    const r = await call({ caseName: "旧案", body: "补充一篇。", pieceTitle: "后续篇" }, "call-9");
    expect(r.ok).toBe(true);
    expect((r as { path: string }).path).toContain("memory/research/旧案/");
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
