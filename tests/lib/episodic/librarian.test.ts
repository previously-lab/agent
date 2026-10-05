import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((c: unknown) => ({ _mock: c })),
}));

// In-memory memory root (same pattern as the other episodic tests).
const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string) => {
    const content = io.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }),
  fsWriteFile: vi.fn(async (path: string, content: string) => {
    io.files.set(path, content);
    return { path, created: true };
  }),
  fsListFiles: vi.fn(async () => {
    throw new Error("not used in librarian tests");
  }),
}));

import {
  applyCaseWriteIntent,
  buildSliceExcerpt,
  extractDocMarkers,
  extractProcessedMarkerIds,
  runLibrarianPass,
  runScribePass,
  DOC_MARKER_PREFIX,
  SCRIBE_RECORD_PREFIX,
} from "@/lib/episodic/flash/librarian";
import { CaseWriteRefusal, parseCaseDoc } from "@/lib/docs";
import type { ModelConfig } from "@/lib/models/registry";

function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

/** One caseWriterOutput call carrying the given decisions. */
function writerCall(cases: unknown[], reasoning = "r") {
  return {
    toolName: "caseWriterOutput",
    input: { cases, reasoning },
  };
}

const model: ModelConfig = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
};

const DATE = "2026-08-09";
const SLICE_ID = "2026-08-09-1300";
const AGENT_MD = `memory/episodic/slices/2026/08/09/1300/timeline/agent.md`;

const EXCERPT = {
  focus: "挑手机",
  summary: "用户对比了三款机型。",
  turnsExcerpt: "用户: 帮我看看这三款\nagent: 对比如下…",
};

/** A manifest with one existing research case — NO tags anywhere (R2). */
const MANIFEST = {
  truncated: false,
  tree: {
    research: ["research/手机调研/index.md"],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

// ─── Pure marker parsing (§A.3.1 — unchanged) ──────────────────────────────

describe("extractDocMarkers", () => {
  it("parses well-formed marker lines and ignores everything else", () => {
    const md = [
      "## Turn abc — 2026-08-09T13:00:00Z",
      "一些认知记录。",
      `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-1","kind":"sediment","docType":"research","title":"手机购买调研","note":"对比了三款机型","topics":["用户手机"]}`,
      `${DOC_MARKER_PREFIX} 这不是 JSON`,
      `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-2","kind":"task","title":"团队 on-site","dateAnchor":"2026-09-08","note":"8 号","topics":[]}`,
      `${DOC_MARKER_PREFIX} {"v":2,"id":"bad","kind":"sediment","title":"x"}`,
    ].join("\n");
    const markers = extractDocMarkers(md);
    expect(markers).toHaveLength(2);
    expect(markers[0].id).toBe("t1-1");
    expect(markers[0].topics).toEqual(["用户手机"]); // legacy field tolerated
    expect(markers[1].kind).toBe("task");
    expect(markers[1].dateAnchor).toBe("2026-09-08");
  });

  it("collapses duplicate ids to the first occurrence", () => {
    const line = `${DOC_MARKER_PREFIX} {"v":1,"id":"dup","kind":"question","title":"x","note":"","topics":[]}`;
    expect(extractDocMarkers(`${line}\n${line}`)).toHaveLength(1);
  });
});

describe("extractProcessedMarkerIds", () => {
  it("collects ids from record lines of the given prefix", () => {
    const md = [
      `${SCRIBE_RECORD_PREFIX} {"id":"t1-1","doc":"research/手机调研"}`,
      `[doc-research] {"id":"t1-9","docs":[]}`,
      "普通文本 [doc-scribe] 不在行首不算",
    ].join("\n");
    expect(extractProcessedMarkerIds(md, SCRIBE_RECORD_PREFIX)).toEqual(new Set(["t1-1"]));
  });
});

describe("buildSliceExcerpt", () => {
  it("bounds the tail and flattens whitespace", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "agent",
      content: `第 ${i} 条\n换行`,
    }));
    const excerpt = buildSliceExcerpt({ focus: "f", summary: "s", turns });
    expect(excerpt.focus).toBe("f");
    expect(excerpt.turnsExcerpt.split("\n")).toHaveLength(8);
    expect(excerpt.turnsExcerpt).toContain("第 11 条 换行");
  });
});

// ─── The write ops (§B.3) + the v0.21 write window ──────────────────────────

describe("applyCaseWriteIntent", () => {
  it("open creates the index.md with opened = the write date and a fresh updated stamp", async () => {
    const out = await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "手机调研", body: "正文。" },
      DATE,
    );
    expect(out.created).toBe(true);
    const raw = io.files.get("memory/research/手机调研/index.md")!;
    expect(raw).toContain("opened: '2026-08-09'");
    expect(raw).toContain("正文。");
    // The mechanical stamp: ISO with a time of day, restamped on every write.
    expect(raw).toMatch(/updated: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("open on an existing case is refused (loud, visible)", async () => {
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "手机调研", body: "一" },
      DATE,
    );
    await expect(
      applyCaseWriteIntent(
        { action: "open", category: "research", caseName: "手机调研", body: "二" },
        DATE,
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("rewriteIndex lands INSIDE the window; appendTail is allowed there too (harmless)", async () => {
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "手机调研", body: "初稿。" },
      DATE,
    );
    await applyCaseWriteIntent(
      { action: "rewriteIndex", category: "research", caseName: "手机调研", body: "改后。" },
      DATE,
    );
    expect(io.files.get("memory/research/手机调研/index.md")).toContain("改后。");
    await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "手机调研", line: "补一行" },
      DATE,
    );
    expect(io.files.get("memory/research/手机调研/index.md")).toContain("补一行");
  });

  it("OUTSIDE the window: rewriteIndex is refused with a structured code; tail/piece still grow", async () => {
    io.files.set(
      "memory/research/旧案/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n沉淀的正文。\n",
    );
    const refusal = await applyCaseWriteIntent(
      { action: "rewriteIndex", category: "research", caseName: "旧案", body: "x" },
      DATE,
    ).catch((e) => e);
    expect(refusal).toBeInstanceOf(CaseWriteRefusal);
    expect(refusal.code).toBe("rewrite_window_closed");
    expect(refusal.message).toContain("appendTail");
    // …but the tail still grows, and a new piece is always allowed.
    await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "旧案", line: "价格已过时。" },
      DATE,
    );
    expect(io.files.get("memory/research/旧案/index.md")).toContain("价格已过时。");
    const piece = await applyCaseWriteIntent(
      { action: "addPiece", category: "research", caseName: "旧案", title: "报价篇", body: "篇正文。" },
      DATE,
    );
    expect(piece.created).toBe(true);
    // …and every write restamps `updated`, re-opening the window.
    expect(io.files.get("memory/research/旧案/index.md")).toMatch(
      /updated: '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    await applyCaseWriteIntent(
      { action: "rewriteIndex", category: "research", caseName: "旧案", body: "窗口重开后的整篇重写。" },
      DATE,
    );
    expect(io.files.get("memory/research/旧案/index.md")).toContain("窗口重开后的整篇重写。");
  });

  it("expectedUpdated: a moved case refuses the rewrite (rewrite_conflict); a match proceeds", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      `---\nopened: '2026-08-09'\nupdated: '${new Date().toISOString()}'\n---\n\n读过的正文。\n`,
    );
    // The stamp the caller read ≠ the stamp on disk → structured refusal.
    const conflict = await applyCaseWriteIntent(
      {
        action: "rewriteIndex",
        category: "research",
        caseName: "手机调研",
        body: "基于旧读的重写。",
        expectedUpdated: "2026-08-09T00:00:00.000Z",
      },
      DATE,
    ).catch((e) => e);
    expect(conflict).toBeInstanceOf(CaseWriteRefusal);
    expect(conflict.code).toBe("rewrite_conflict");
    expect(conflict.message).toContain("Re-read");
    expect(io.files.get("memory/research/手机调研/index.md")).toContain("读过的正文。"); // untouched
    // The stamp the caller actually read (quotes tolerated) → the rewrite lands.
    const disk = parseCaseDoc(io.files.get("memory/research/手机调研/index.md")!, {
      category: "research",
      caseName: "手机调研",
      fileName: "index.md",
    });
    await applyCaseWriteIntent(
      {
        action: "rewriteIndex",
        category: "research",
        caseName: "手机调研",
        body: "基于新读的重写。",
        expectedUpdated: `'${disk.updated}'`,
      },
      DATE,
    );
    expect(io.files.get("memory/research/手机调研/index.md")).toContain("基于新读的重写。");
  });

  it("addPiece writes a dated piece whose opened comes from the name (same-source)", async () => {
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "手机调研", body: "正文。" },
      DATE,
    );
    const out = await applyCaseWriteIntent(
      { action: "addPiece", category: "research", caseName: "手机调研", title: "报价篇", body: "篇正文。" },
      DATE,
    );
    expect(out.path).toBe("memory/research/手机调研/2026-08-09-报价篇.md");
    const raw = io.files.get(out.path)!;
    expect(raw).toContain("opened: '2026-08-09'");
  });

  it("an illegal case name is refused before anything touches disk", async () => {
    await expect(
      applyCaseWriteIntent(
        { action: "open", category: "research", caseName: "1234-数字开头", body: "x" },
        DATE,
      ),
    ).rejects.toThrow(/illegal case name/);
    expect(io.files.size).toBe(0);
  });

  it("open refuses a hypotheses case whose body carries no falsification condition (§B.6)", async () => {
    await expect(
      applyCaseWriteIntent(
        { action: "open", category: "hypotheses", caseName: "用户偏好小屏", body: "猜测：用户偏好小屏手机。" },
        DATE,
      ),
    ).rejects.toThrow(/no falsification condition/);
    expect(io.files.size).toBe(0); // refused before anything touches disk
    // The same test the research pass uses: 证伪 / falsif.
    await applyCaseWriteIntent(
      {
        action: "open",
        category: "hypotheses",
        caseName: "用户偏好小屏",
        body: "猜测：用户偏好小屏手机。证伪条件：用户下次主动选择 6.7 寸以上机型。",
      },
      DATE,
    );
    expect(io.files.get("memory/hypotheses/用户偏好小屏/index.md")).toContain("证伪条件");
    // Other categories open freely — the gate is hypotheses-only.
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "普通调研", body: "没有证伪字样也行。" },
      DATE,
    );
  });

  it("appendTail collapses a multi-line line to ONE line and records the collapse as a warning", async () => {
    io.files.set(
      "memory/research/旧案/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n沉淀的正文。\n",
    );
    const out = await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "旧案", line: "第一行\n第二行  缩进" },
      DATE,
    );
    const raw = io.files.get("memory/research/旧案/index.md")!;
    expect(raw).toContain("第一行 第二行 缩进");
    expect(raw).not.toContain("第一行\n第二行");
    // The collapse is recorded, not silent.
    expect(out.warnings?.join(" ")).toContain("collapsed to one line");
    // An already-one-line line lands clean, with no warning.
    const clean = await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "旧案", line: "本来就一行。" },
      DATE,
    );
    expect(clean.warnings).toBeUndefined();
    // A whitespace-only line has nothing to append once flattened.
    await expect(
      applyCaseWriteIntent(
        { action: "appendTail", category: "research", caseName: "旧案", line: "  \n  " },
        DATE,
      ),
    ).rejects.toThrow(/empty once flattened/);
  });
});

// ─── The case-writer pass (边界 run ①) ─────────────────────────────────────

describe("runLibrarianPass — judges from the manifest, NO tags (R3a)", () => {
  it("opens a NEW case the writer judges this slice touched", async () => {
    ai.streamText.mockResolvedValue(
      streamWith([
        writerCall([
          {
            action: "open",
            category: "research",
            caseName: "充电器调研",
            body: "用户顺便问了充电器兼容性。",
          },
        ]),
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.llmRan).toBe(true);
    expect(result.written).toEqual(["research/充电器调研/index.md"]);
    const raw = io.files.get("memory/research/充电器调研/index.md")!;
    expect(raw).toContain("opened: '2026-08-09'");
    // evidence stamped mechanically
    expect(raw).toContain(`(refs: ${SLICE_ID})`);
  });

  it("updateIndex on an EXISTING in-window case rewrites its 正文", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      `---\nopened: '2026-08-01'\nupdated: '${new Date().toISOString()}'\n---\n\n旧认识。\n`,
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        writerCall([
          {
            action: "updateIndex",
            category: "research",
            caseName: "手机调研",
            body: "旧认识 + 这片的新结论。",
          },
        ]),
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual(["research/手机调研/index.md"]);
    const raw = io.files.get("memory/research/手机调研/index.md")!;
    expect(raw).toContain("旧认识 + 这片的新结论。");
    expect(raw).not.toContain("status:"); // new shape: opened + updated only
  });

  it("updateIndex on an out-of-window case is SKIPPED with the structured refusal (visible)", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n沉淀的旧认识。\n",
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        writerCall([
          {
            action: "updateIndex",
            category: "research",
            caseName: "手机调研",
            body: "想整篇重写。",
          },
        ]),
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("outside its write window");
    // The settled 正文 is untouched.
    expect(io.files.get("memory/research/手机调研/index.md")).toContain("沉淀的旧认识。");
  });

  it("structurally refuses a write to a case that is NOT in the manifest (writer never read it)", async () => {
    ai.streamText.mockResolvedValue(
      streamWith([
        writerCall([
          { action: "updateIndex", category: "research", caseName: "清单外", body: "x" },
        ]),
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("not in the manifest");
    expect(io.files.size).toBe(0);
  });

  it("refuses open on an existing case; skip is a legal empty run", async () => {
    ai.streamText.mockResolvedValue(
      streamWith([
        writerCall([
          { action: "open", category: "research", caseName: "手机调研", body: "x" },
          { action: "skip", category: "research", caseName: "别的", body: "y" },
        ]),
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped.map((s) => s.reason).join(" ")).toContain("already exists");
  });

  it("an empty decision list is a legal 空转", async () => {
    ai.streamText.mockResolvedValue(streamWith([writerCall([], "nothing worth writing")]));
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.llmRan).toBe(true);
    expect(result.written).toEqual([]);
    expect(io.files.size).toBe(0);
  });

  it("a failed LLM run degrades to a skipped item, never throws", async () => {
    ai.streamText.mockRejectedValue(new Error("provider down"));
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.llmRan).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("provider down");
  });
});

// ─── The scribe pass (书记段序 7) ──────────────────────────────────────────

describe("runScribePass — case model, no strands", () => {
  it("opens a tasks/ case from a task marker, date anchor stamped mechanically", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-2","kind":"task","title":"团队 on-site","dateAnchor":"2026-09-08","note":"8 号","topics":[]}`,
      ].join("\n"),
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            entries: [{ id: "t1-2", body: "去团队 on-site，准备演示材料。" }],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.written).toEqual(["tasks/团队 on-site/index.md"]);
    const raw = io.files.get("memory/tasks/团队 on-site/index.md")!;
    expect(raw).toContain("日期锚：2026-09-08");
    expect(raw).toContain(`(refs: ${SLICE_ID})`);
    // mailbox bookkeeping — the marker is recorded so it never double-writes
    expect(io.files.get(AGENT_MD)).toContain(SCRIBE_RECORD_PREFIX);
  });

  it("an OUT-OF-WINDOW entry with a multi-line body lands as ONE collapsed tail line (never corrupts the tail)", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"m3","kind":"sediment","title":"封case","note":"","topics":[]}`,
      ].join("\n"),
    );
    io.files.set(
      "memory/research/封case/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-05T00:00:00.000Z'\n---\n\n封口的正文。\n\n—— 尾部 ——\n2026-08-05：结案。\n",
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            // A multi-line body (the failure mode: extra lines used to drop
            // into preserved on re-parse).
            entries: [{ id: "m3", body: "第一行\n第二行\n\n第四行" }],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.written).toEqual(["research/封case/index.md"]);
    const sealed = io.files.get("memory/research/封case/index.md")!;
    // The whole stamped entry collapsed into ONE dated line.
    expect(sealed).toContain(`2026-08-09：第一行 第二行 第四行 (refs: ${SLICE_ID})`);
    // A re-parse finds a clean tail — nothing degrades into preserved.
    const reparsed = parseCaseDoc(sealed, {
      category: "research",
      caseName: "封case",
      fileName: "index.md",
    });
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.tail.map((t) => t.text)).toEqual([
      "结案。",
      `第一行 第二行 第四行 (refs: ${SLICE_ID})`,
    ]);
  });

  it("an entity sediment maps to its case category (object → things/)", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-3","kind":"sediment","docType":"entity","entityKind":"object","title":"旧手机","note":"","topics":[]}`,
      ].join("\n"),
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: { entries: [{ id: "t1-3", body: "用户还有一台旧手机作备用机。" }], reasoning: "r" },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.written).toEqual(["things/旧手机/index.md"]);
  });

  it("rewrites an IN-WINDOW case (rewriteIndex) and appends a dated line to an OUT-OF-WINDOW one", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"m1","kind":"sediment","title":"活case","note":"","topics":[]}`,
        `${DOC_MARKER_PREFIX} {"v":1,"id":"m2","kind":"sediment","title":"封case","note":"","topics":[]}`,
      ].join("\n"),
    );
    io.files.set(
      "memory/research/活case/index.md",
      `---\nopened: '2026-08-01'\nupdated: '${new Date().toISOString()}'\n---\n\n还在写的草稿。\n`,
    );
    io.files.set(
      "memory/research/封case/index.md",
      // A historical sealed doc (closed retired, parse-tolerated): its last
      // write predates the window either way, so the tail is the only growth.
      "---\nopened: '2026-08-01'\nupdated: '2026-08-05T00:00:00.000Z'\nclosed: '2026-08-05'\n---\n\n封口的正文。\n\n—— 尾部 ——\n2026-08-05：结案。\n",
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            entries: [
              { id: "m1", body: "草稿 + 新情况。" },
              { id: "m2", body: "封口后的一条补充。" },
            ],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.written).toHaveLength(2);
    const living = io.files.get("memory/research/活case/index.md")!;
    expect(living).toContain("草稿 + 新情况。");
    expect(living).not.toContain("status:");
    const sealed = io.files.get("memory/research/封case/index.md")!;
    expect(sealed).toContain("封口的正文。"); // sealed 正文 untouched
    expect(sealed).toContain("封口后的一条补充。");
  });

  it("already-processed markers are not re-written (mailbox record)", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-1","kind":"sediment","title":"x","note":"","topics":[]}`,
        `${SCRIBE_RECORD_PREFIX} {"id":"t1-1","doc":"research/x"}`,
      ].join("\n"),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
    expect(io.files.size).toBe(1); // only the agent.md itself
  });

  it("证据·大段文字 (§C.1): a marker carrying `body` opens the case with the FULL text + origin stamped", async () => {
    const longText = "第一行原文。\n\n第二行原文，很长——用户粘贴的全部内容都在这里，逐字保留。";
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"t9-1","kind":"sediment","title":"配置参考","note":"存下这个","topics":[],"body":${JSON.stringify(longText)}}`,
      ].join("\n"),
    );
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            entries: [{ id: "t9-1", body: "用户粘贴的一段配置资料，值得长期留存。" }],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      date: DATE,
    });
    expect(result.written).toEqual(["research/配置参考/index.md"]);
    const raw = io.files.get("memory/research/配置参考/index.md")!;
    // 出处 stamped at the head of the original-text block
    expect(raw).toContain(`用户于 ${DATE} 在切片 ${SLICE_ID} 粘贴`);
    // the FULL text is carried verbatim — not the one-line note
    expect(raw).toContain("第二行原文，很长——用户粘贴的全部内容都在这里，逐字保留。");
    expect(raw).toContain(`(refs: ${SLICE_ID})`);
  });
});
