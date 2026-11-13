/**
 * Memory browsing and reading over an in-memory local fs, including the
 * semantic doc_rework read tracking (recordDocRead) and mediated record refs.
 *
 * rework-signal itself is REAL; only its two sinks are mocked (the fitness
 * store append and the agent.md timeline write), so the classification chain
 * is exercised for real. No memory/ directory is touched — all paths are
 * map keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseCaseReadEnvelope, unwrapCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import type { ScenarioRecallEvidence, ScenarioRecallResult } from "@/lib/agents/scenario-recall";
import { collectThinkingReads } from "@/lib/agents/thinking-read-receipt";
import { buildThinkingProduct, permitsThinkingClaim } from "@/lib/agents/thinking-product";
import type { ModelMessage } from "@/lib/deepseek/types";
import { caseStorageRevision } from "@/lib/docs/case-doc";

const recall = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/agents/scenario-recall", () => ({ runScenarioRecall: recall.run }));
vi.mock("workflow", () => ({
  getWritable: () => ({
    getWriter: () => ({ write: vi.fn(async () => {}), releaseLock: vi.fn() }),
  }),
}));

const io = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  return { files, dirs };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: vi.fn(async (p: string) => {
    if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
    return io.files.get(p)!;
  }),
  walkPathsLocal: vi.fn(async (root: string) =>
    [...io.files.keys()].filter((path) => path.startsWith(`${root}/`)),
  ),
  listFilesLocal: async (p: string) => {
    if (!io.dirs.has(p)) throw new Error(`Directory not found: "${p}"`);
    return io.dirs.get(p)!.map((name) => ({
      name,
      // A name is a directory when the fixture registered it under io.dirs.
      type: (io.dirs.has(`${p}/${name}`) ? "dir" : "file") as "dir" | "file",
      path: `${p}/${name}`,
    }));
  },
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
  deleteFileLocal: vi.fn(async () => {}),
}));
vi.mock("@/lib/tools/readFile", () => ({
  readFile: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  readFileFresh: vi.fn(async () => {
    throw new Error("github read should not be called in local mode");
  }),
  readFileViaTree: vi.fn(async () => {
    throw new Error("github tree read should not be called in local mode");
  }),
  getRepoTree: vi.fn(async () => {
    throw new Error("github tree read should not be called in local mode");
  }),
  invalidateReadCache: vi.fn(),
}));
vi.mock("@/lib/demo/demo-fs", () => ({
  readFileDemo: vi.fn(async () => {
    throw new Error("demo read should not be called in local mode");
  }),
  listFilesDemo: vi.fn(async () => []),
}));

// rework-signal's two sinks — the probe stays real, its writes are captured.
const sinks = vi.hoisted(() => ({
  appendSignal: vi.fn(async (_signal?: unknown) => {}),
  writeAgentTimeline: vi.fn(async (_sliceId: string, _line: string) => {}),
}));
vi.mock("@/lib/evolution/store", () => ({
  appendSignal: sinks.appendSignal,
  readPlaybook: vi.fn(async () => null),
  capPlaybook: (s: string) => s,
}));
vi.mock("@/lib/episodic/manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/episodic/manager")>();
  return { ...actual, writeAgentTimeline: sinks.writeAgentTimeline };
});

import {
  recallRecentExecute,
  recallListExecute,
  recallFindExecute,
  recallSearchExecute,
  recallReadExecute,
  recallScenarioExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";
import {
  readFile as githubReadFile,
  readFileViaTree as githubReadFileViaTree,
  getRepoTree as githubGetRepoTree,
} from "@/lib/tools/readFile";
import { readFileLocal, walkPathsLocal } from "@/lib/tools/local-fs";

function makeCtx(sliceId: string): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId,
    turnId: "turn-test",
    readScopeId: "turn-test",
    currentUserText: "current user text",
    recentTurns: [],
  };
}

function opts(ctx: ToolContext) {
  return { context: ctx, toolCallId: "tc-recall" };
}

const INDEX_RAW = `---
opened: 2026-09-05
updated: 2026-09-05T13:22:10.000Z
---

手机调研 case 的正文：倾向小屏旗舰。证据见切片 2026-09-04-2130。
`;

const CORE_PATH = "memory/records/2026/09/04/2130/core.md";
const DEEP_CORE_PATH = "memory/records/2026/09/05/0900/core.md";

const CORE_RAW = `---
focus: 手机选购闲聊
start: 2026-09-04T21:30:00.000Z
---

## Turn 1 — 2026-09-04T21:30:00.000Z (user)

我想换手机，预算 5000。
`;

const DEEP_CORE_RAW = `---
focus: 别的焦点
start: 2026-09-05T09:00:00.000Z
---

## Turn 1 — 2026-09-05T09:00:00.000Z (user)

开场白。

## Turn 2 — 2026-09-05T09:01:00.000Z (agent)

${Array.from({ length: 40 }, (_, i) => `填充行 ${i + 1}`).join("\n")}
深埋关键词-企鹅在很后面的正文里。
`;

/** Register the tree dirs the facade's listing walk traverses. */
function seedDirs() {
  io.dirs.set("memory", ["research", "records"]);
  io.dirs.set("memory/research", ["手机调研"]);
  io.dirs.set("memory/research/手机调研", ["index.md"]);
  io.dirs.set("memory/records", ["2026"]);
  io.dirs.set("memory/records/2026", ["09"]);
  io.dirs.set("memory/records/2026/09", ["04", "05"]);
  io.dirs.set("memory/records/2026/09/04", ["2130"]);
  io.dirs.set("memory/records/2026/09/04/2130", ["core.md"]);
  io.dirs.set("memory/records/2026/09/05", ["0900"]);
  io.dirs.set("memory/records/2026/09/05/0900", ["core.md"]);
}

beforeEach(() => {
  recall.run.mockReset();
  io.files.clear();
  io.dirs.clear();
  vi.mocked(readFileLocal).mockClear();
  vi.mocked(walkPathsLocal).mockClear();
  sinks.appendSignal.mockClear();
  sinks.writeAgentTimeline.mockClear();
  seedDirs();
  io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
  io.files.set(CORE_PATH, CORE_RAW);
  io.files.set(DEEP_CORE_PATH, DEEP_CORE_RAW);
});

describe("recallRecentExecute", () => {
  it("renders the fixed recent template with entry lines (local walk)", async () => {
    const out = await recallRecentExecute({}, opts(makeCtx("2026-09-10-1000")));
    expect(out).toMatch(/^The \d+ most recent memory entries:/);
    expect(out).toContain("research/手机调研");
    expect(out).toContain("records/2026-09-04-2130");
  });

  it("an empty category renders the fixed nothing-here sentence", async () => {
    const out = await recallRecentExecute(
      { category: "orgs" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toBe(
      "There is nothing here yet — no orgs entries exist in this scope.",
    );
  });

  it("an unknown category renders the unavailable sentence, never throws", async () => {
    const out = await recallRecentExecute(
      { category: "bogus" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(/^This could not be read right now \(unknown category/);
    expect(out).toContain("not absence");
  });
});

describe("recallListExecute", () => {
  it("lists the public root without a storage request", async () => {
    const out = await recallListExecute({}, opts(makeCtx("2026-09-10-1000")));
    expect(out).toMatchObject({
      kind: "entries",
      entries: expect.arrayContaining([{ kind: "directory", path: "research", name: "research" }]),
    });
    expect(walkPathsLocal).not.toHaveBeenCalled();
    expect(readFileLocal).not.toHaveBeenCalled();
  });

  it("lists case documents using metadata only and returns refs that recallRead understands", async () => {
    const context = opts(makeCtx("2026-09-10-1000"));
    const out = await recallListExecute({ path: "research/手机调研" }, context);
    expect(out).toEqual({
      kind: "entries",
      total: 1,
      entries: [{ kind: "document", path: "research/手机调研/index.md", name: "index.md", ref: "research/手机调研" }],
    });
    expect(walkPathsLocal).toHaveBeenCalledOnce();
    expect(vi.mocked(walkPathsLocal).mock.calls[0]?.[0]).toBe("memory/research");
    expect(readFileLocal).not.toHaveBeenCalled();
    expect(await recallReadExecute({ ref: "research/手机调研" }, context)).toContain("倾向小屏旗舰");
  });

  it("rejects storage paths and non-public directories", async () => {
    const context = opts(makeCtx("2026-09-10-1000"));
    for (const path of ["memory/research", "records", "config", "research/手机调研/attachments"]) {
      expect(await recallListExecute({ path }, context)).toMatchObject({ kind: "invalid_scope" });
    }
    expect(walkPathsLocal).not.toHaveBeenCalled();
    expect(readFileLocal).not.toHaveBeenCalled();
  });
});

describe("recallFindExecute", () => {
  it("finds a case without a category or any content reads", async () => {
    const out = await recallFindExecute(
      { name: "手机调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatchObject({
      kind: "entries", total: 1, entries: [{ path: "research/手机调研", ref: "research/手机调研", score: 1 }],
    });
    expect(readFileLocal).not.toHaveBeenCalled();
  });

  it("returns similar names only from the specified public category", async () => {
    io.files.set("memory/people/手机/index.md", "无关内容");
    const out = await recallFindExecute(
      { name: "手机", under: "research" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatchObject({
      kind: "entries", total: 1, entries: [{ path: "research/手机调研", score: expect.any(Number) }],
    });
    expect(walkPathsLocal).toHaveBeenCalledOnce();
    expect(vi.mocked(walkPathsLocal).mock.calls[0]?.[0]).toBe("memory/research");
    expect(readFileLocal).not.toHaveBeenCalled();
  });

  it("keeps explicit slice lookup separate from public path discovery", async () => {
    const context = opts(makeCtx("2026-09-10-1000"));
    expect(await recallFindExecute({ name: "records/2026-09-04-2130" }, context)).toMatchObject({ kind: "invalid_scope" });
    expect(readFileLocal).not.toHaveBeenCalled();
    const out = await recallFindExecute({ category: "records", name: "2026-09-04" }, context);
    expect(out).toContain("records/2026-09-04-2130");
    expect(out).toContain("[navigation only; not evidence]");
    expect(out).not.toContain("我想换手机");
  });
});

describe("recallSearchExecute", () => {
  it("finds a structured document by keyword and renders the match template", async () => {
    const out = await recallSearchExecute(
      { query: "小屏旗舰" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(/^1 match\(es\) for "小屏旗舰":/);
    expect(out).toContain("research/手机调研");
  });

  it("reports an unmatched keyword without padding with recent documents or records", async () => {
    const out = await recallSearchExecute(
      { query: "绝对不存在的关键词" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toBe(
      'No content match for "绝对不存在的关键词" in this scan page.\nNo related names or paths found.',
    );
  });

  it("labels a name-only match separately and puts the closer name first", async () => {
    io.dirs.set("memory/research", ["手机调研", "Lantern", "Lantern Project"]);
    io.dirs.set("memory/research/Lantern", ["index.md"]);
    io.dirs.set("memory/research/Lantern Project", ["index.md"]);
    io.files.set("memory/research/Lantern/index.md", "Case overview");
    io.files.set("memory/research/Lantern Project/index.md", "Project overview");
    const out = await recallSearchExecute({ query: "Lantern" }, opts(makeCtx("2026-09-10-1000")));
    expect(out).toMatch(/^No content match for "Lantern" in this scan page\./);
    expect(out).toContain("Closest names or paths (navigation only):");
    expect(out).toMatch(/research\/Lantern\b[^\n]*\n[^\n]*research\/Lantern Project/);
    expect(out).not.toMatch(/手机调研|Case overview|Project overview/);
  });

  it("records bodies are scanned only when asked (scan-surface discipline)", async () => {
    // The deep keyword is absent from every structured document and slice head.
    const scoped = await recallSearchExecute(
      { query: "深埋关键词" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(scoped).toMatch(/^No content match for "深埋关键词"/);
    const withRecords = await recallSearchExecute(
      { query: "深埋关键词", includeRecords: true },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(withRecords).toMatch(/^1 match\(es\) for "深埋关键词":/);
    expect(withRecords).toContain("records/2026-09-05-0900");
    expect(withRecords).toContain("别的焦点 [navigation only; not evidence]");
    expect(withRecords).not.toContain("企鹅在很后面的正文里");
  });
});

describe("recallReadExecute", () => {
  it("thinking receipts keep the piece catalog and stale current basis out of full-read evidence", async () => {
    const ref = "research/手机调研";
    const pieceRef = `${ref}/2026-09-08-报价篇`;
    io.dirs.set("memory/research/手机调研", ["index.md", "_current.md", "2026-09-08-报价篇.md"]);
    io.files.set("memory/research/手机调研/_current.md", "---\nas_of: 2026-09-09\n---\n\n当前结论尚未记录核验基线。\n");
    io.files.set("memory/research/手机调研/2026-09-08-报价篇.md", "报价篇正文");
    const context = { ...makeCtx("2026-09-10-1000"), thinkingFlow: true };
    const out = await recallReadExecute({ ref }, { context, toolCallId: "thinking-read" });
    if (typeof out !== "string") throw new Error("Semantic read unexpectedly redirected");
    expect(out).toContain(`${pieceRef} — 报价篇`);
    expect(out).toContain("UNREAD in this run");
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "thinking-read", toolName: "recallRead", input: { ref } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "thinking-read", toolName: "recallRead",
        output: { type: "text", value: out } }] },
    ];
    const reads = collectThinkingReads(messages, context.readScopeId);
    expect(reads).toMatchObject([
      { ref, edition: "original", coverage: "full" },
      { ref, edition: "current", coverage: "stale" },
      { ref, sourceKind: "navigation", coverage: "outline", revision: expect.any(String) },
    ]);
    expect(reads.some((read) => read.ref === pieceRef)).toBe(false);
    const product = buildThinkingProduct({ text: "", messages, asOf: "2026-09-10T02:00:00.000Z",
      inputScope: { scopeKey: "fixture", workId: "work", inputIds: ["u1"], inputText: "继续调研",
        readScopeId: context.readScopeId, entityRefs: [ref] },
      report: { findings: [{ text: "当前报价已经核实。", kind: "project_fact",
        evidenceIds: reads.map((read) => read.evidenceId) }] } });
    expect(permitsThinkingClaim(product, "claim-1", "finding")).toBe(false);
  });

  it("marks a null piece basis revision as unverified even when index and inventory match", async () => {
    const ref = "research/手机调研";
    const piecePath = "memory/research/手机调研/2026-09-08-报价篇.md";
    io.dirs.set("memory/research/手机调研", ["index.md", "_current.md", "2026-09-08-报价篇.md"]);
    io.files.set(piecePath, "报价篇正文");
    io.files.set("memory/research/手机调研/_current.md", `---\nbasis:\n  index: ${caseStorageRevision(INDEX_RAW)}\n  pieces:\n    - path: ${piecePath}\n---\n\n当前结论。\n`);
    const context = { ...makeCtx("2026-09-10-1000"), thinkingFlow: true };
    const out = await recallReadExecute({ ref }, { context, toolCallId: "null-piece-basis" });
    if (typeof out !== "string") throw new Error("Semantic read unexpectedly redirected");
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "null-piece-basis", toolName: "recallRead", input: { ref } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "null-piece-basis", toolName: "recallRead",
        output: { type: "text", value: out } }] },
    ];
    expect(collectThinkingReads(messages, context.readScopeId)).toMatchObject([
      { ref, edition: "original", coverage: "full" },
      { ref, edition: "current", coverage: "stale" },
      { ref, sourceKind: "navigation", coverage: "outline", revision: expect.any(String) },
    ]);
  });

  it("keeps a thinking range receipt bound to its actual lines", async () => {
    const ref = "research/手机调研";
    const context = { ...makeCtx("2026-09-10-1000"), thinkingFlow: true };
    const out = await recallReadExecute({ ref, range: { type: "lines", start: 2, end: 3 } },
      { context, toolCallId: "ranged-thinking-read" });
    if (typeof out !== "string") throw new Error("Semantic read unexpectedly redirected");
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "ranged-thinking-read", toolName: "recallRead", input: { ref } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "ranged-thinking-read", toolName: "recallRead",
        output: { type: "text", value: out } }] },
    ];
    expect(collectThinkingReads(messages, context.readScopeId)).toMatchObject([
      { ref, coverage: "range", range: { start: 2, end: 3 } },
    ]);
  });

  it("分类/case名 → the case's index.md, whole file", async () => {
    const out = await recallReadExecute(
      { ref: "research/手机调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    if (typeof out !== "string") throw new Error("Semantic read unexpectedly redirected to recallScenario");
    expect(unwrapCaseReadEnvelope(out)).toBe(INDEX_RAW);
  });

  it("《》 marks and a .md suffix are tolerated", async () => {
    const out = await recallReadExecute(
      { ref: "《research/手机调研.md》" },
      opts(makeCtx("2026-09-10-1000")),
    );
    if (typeof out !== "string") throw new Error("Semantic read unexpectedly redirected to recallScenario");
    expect(unwrapCaseReadEnvelope(out)).toBe(INDEX_RAW);
  });

  it("semantic line ranges stay bounded and never issue a full-read receipt", async () => {
    const sentinel = "FULL_SEMANTIC_DOCUMENT_SENTINEL_NEVER_RETURN";
    const longRaw = Array.from({ length: 450 }, (_, index) =>
      index === 449 ? sentinel : `line ${index + 1}`).join("\n");
    io.files.set("memory/research/long/index.md", longRaw);
    io.dirs.set("memory/research", ["手机调研", "long"]);
    io.dirs.set("memory/research/long", ["index.md"]);

    const ranged = await recallReadExecute(
      { ref: "research/long", range: { type: "lines", start: 1, end: 2 } },
      opts(makeCtx("2026-09-10-1000")),
    );
    if (typeof ranged !== "string") throw new Error("Semantic range unexpectedly redirected to recallScenario");
    const text = ranged;
    expect(text).toContain("Lines 1-2 of research/long");
    expect(text).toContain("line 1\nline 2");
    expect(text).not.toContain("line 3");
    expect(text).not.toContain(sentinel);
    expect(parseCaseReadEnvelope(text)).toBeNull();

    const capped = await recallReadExecute(
      { ref: "research/long", range: { type: "lines", start: 1, end: 450 } },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(capped).toContain("bounded to 400 lines/16000 chars");
    expect(capped).toContain("line 400");
    expect(capped).not.toContain("line 401");
    expect(capped).not.toContain(sentinel);

    const wrongRange = await recallReadExecute(
      { ref: "research/long", range: { type: "turns", indices: [0] } },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(wrongRange).toContain('ERROR: Range type "turns" is not available for semantic document');
    expect(wrongRange).not.toContain(sentinel);
  });

  it("records/<slice id> redirects to mediated recall; an unknown semantic ref renders the fixed sentence", async () => {
    const out = await recallReadExecute(
      { ref: "records/2026-09-04-2130" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatchObject({ kind: "recallScenario_required", ref: "records/2026-09-04-2130" });
    expect(JSON.stringify(out)).not.toContain("我想换手机，预算 5000。");
    const miss = await recallReadExecute(
      { ref: "research/不存在" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(miss).toBe(
      'Nothing named "research/不存在" exists in memory — and nothing similar.',
    );
  });
});

describe("doc_rework probe (§4.4)", () => {
  const evidence: ScenarioRecallEvidence = {
    source: "original_turn",
    boundary: "legacy_header",
    turnIndex: 0,
    context: { before: "", after: "" },
    ref: "records/2026-09-04-2130",
    turnId: "1",
    role: "user",
    quote: "预算 5000",
    note: "The original turn states the budget.",
  };

  function recollection(items: ScenarioRecallEvidence[] = [evidence]): ScenarioRecallResult {
    const result: ScenarioRecallResult = {
      verification: "quote_and_source_only",
      status: items.length ? "ok" : "insufficient_evidence",
      answer: items.length ? "预算为 5000。" : "",
      evidence: items,
      coverage: { discovered: 1, searched: [], read: [evidence.ref], omitted: 0, notes: [] },
      truncated: false,
      uncertainty: [],
    };
    recall.run.mockResolvedValue(result);
    return result;
  }

  it("records each verified record once after a semantic read, including discovered refs", async () => {
    const ctx = makeCtx("2026-09-10-1100");
    io.files.set("memory/research/手机调研/index.md", `${INDEX_RAW}\n另见 2026-09-05-0900。`);
    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    const result = recollection([
      evidence,
      { ...evidence, quote: "我想换手机" },
      { ...evidence, ref: "records/2026-09-05-0900", quote: "开场白" },
    ]);

    // No input refs: the verified, discovered sources alone drive this probe.
    const out = await recallScenarioExecute({ question: "当时的预算是多少？" }, opts(ctx));

    expect(out).toBe(result);
    expect(sinks.writeAgentTimeline).toHaveBeenCalledTimes(2);
    for (const sliceId of ["2026-09-04-2130", "2026-09-05-0900"]) {
      expect(sinks.writeAgentTimeline).toHaveBeenCalledWith(ctx.sliceId,
        expect.stringContaining(`main agent read slice ${sliceId} that document "memory/research/手机调研/index.md" references`));
    }
    expect(sinks.writeAgentTimeline.mock.calls.every(([, line]) => !line.includes(evidence.quote))).toBe(true);
    expect(parseCaseReadEnvelope(JSON.stringify(out))).toBeNull();
    expect(JSON.stringify(out)).not.toContain(CORE_RAW);
  });

  it.each(["insufficient_evidence", "timeout", "cancelled", "error"] as const)(
    "does not signal from requested or read refs without verified evidence (%s)", async (status) => {
      const ctx = makeCtx("2026-09-10-1101");
      await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
      const result = recollection([]);
      result.status = status;

      await recallScenarioExecute({ question: "当时的预算是多少？", refs: [evidence.ref, evidence.ref] }, opts(ctx));

      expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
    },
  );

  it("does not signal before a semantic read or retroactively after one", async () => {
    const ctx = makeCtx("2026-09-10-1102");
    recollection();
    await recallScenarioExecute({ question: "当时的预算是多少？" }, opts(ctx));
    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("does not signal for an unrelated verified source or the active conversation", async () => {
    for (const ctx of [makeCtx("2026-09-10-1103"), makeCtx("2026-09-04-2130")]) {
      await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
      recollection(ctx.sliceId === "2026-09-04-2130" ? [evidence] : [{ ...evidence, ref: "records/2026-09-05-0900" }]);
      await recallScenarioExecute({ question: "当时的预算是多少？" }, opts(ctx));
    }
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("rejects malformed record refs and empty quotes at the audit boundary", async () => {
    const ctx = makeCtx("2026-09-10-1104");
    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    recollection([
      { ...evidence, ref: "2026-09-04-2130" },
      { ...evidence, ref: "records/2026-99-04-2130" },
      { ...evidence, ref: "research/手机调研" },
      { ...evidence, quote: " " },
    ]);
    await recallScenarioExecute({ question: "当时的预算是多少？" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("preserves the bounded recall result when the audit write fails", async () => {
    const ctx = makeCtx("2026-09-10-1105");
    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    const result = recollection();
    sinks.writeAgentTimeline.mockRejectedValueOnce(new Error("fixture audit write failed"));

    await expect(recallScenarioExecute({ question: "当时的预算是多少？" }, opts(ctx))).resolves.toBe(result);
    expect(sinks.writeAgentTimeline).toHaveBeenCalledTimes(1);
  });

  it("does not run the raw-read doc_rework probe when a record read is mediated", async () => {
    const ctx = makeCtx("2026-09-10-1000");

    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();

    const out = await recallReadExecute({ ref: "records/2026-09-04-2130" }, opts(ctx));
    expect(out).toMatchObject({ kind: "recallScenario_required" });
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("stays silent when the read slice is not referenced by any read case", async () => {
    io.files.set(
      "memory/records/2026/09/06/0900/core.md",
      "unrelated slice\n",
    );
    io.dirs.set("memory/records/2026/09", ["04", "05", "06"]);
    io.dirs.set("memory/records/2026/09/06", ["0900"]);
    io.dirs.set("memory/records/2026/09/06/0900", ["core.md"]);
    const ctx = makeCtx("2026-09-10-1001");

    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    await recallReadExecute({ ref: "records/2026-09-06-0900" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("stays silent when the slice is read before any case read", async () => {
    const ctx = makeCtx("2026-09-10-1002");
    await recallReadExecute({ ref: "records/2026-09-04-2130" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });
});

// ─── GitHub backend: recall reads route through the cached tree layer ─────
//
// The production incident this guards (recallSearchExecute at 1m6s, hourly
// quota exhausted): the GitHub branch of the read dispatch used to call the
// direct per-file `readFile` — one uncached GitHub API call per scanned
// file. Historical recall reads are display reads: they must resolve through
// `readFileViaTree` (cached tree + content-addressed blob layer), where a
// warm instance pays zero per-file API calls (the zero-underlying-calls
// property itself is covered by tests/lib/tools/readFile-tree.test.ts).
// `opts.fresh` keeps the direct read for write-feeding callers.

describe("GitHub backend routing (cached reads)", () => {
  const githubThrow = async () => {
    throw new Error("github tree read should not be called in local mode");
  };

  beforeEach(() => {
    vi.mocked(githubGetRepoTree).mockClear();
    vi.mocked(githubReadFileViaTree).mockClear();
    vi.mocked(githubReadFile).mockClear();
    // Warm tree: every seeded file is a blob entry, non-truncated — the
    // listing walk in createRecallBackend takes the cached-tree branch.
    vi.mocked(githubGetRepoTree).mockImplementation(async () => ({
      treeSha: "memsha",
      truncated: false,
      entries: [...io.files.keys()].map((p) => ({
        path: p,
        type: "blob" as const,
        sha: `sha-${p}`,
        size: io.files.get(p)!.length,
      })),
    }));
    vi.mocked(githubReadFileViaTree).mockImplementation(async (p: string) => {
      if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
      return io.files.get(p)!;
    });
    vi.mocked(githubReadFile).mockImplementation(async (p: string) => {
      if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
      return io.files.get(p)!;
    });
  });

  afterEach(() => {
    vi.mocked(githubGetRepoTree).mockImplementation(githubThrow);
    vi.mocked(githubReadFileViaTree).mockImplementation(githubThrow);
    vi.mocked(githubReadFile).mockImplementation(async () => {
      throw new Error("github read should not be called in local mode");
    });
  });

  function makeGithubCtx(sliceId: string): ToolContext {
    return {
      repo: "mem",
      owner: "me",
      useGithub: true,
      useDemo: false,
      sliceId,
      turnId: "turn-test",
      readScopeId: "turn-test",
      currentUserText: "current user text",
      recentTurns: [],
    };
  }

  it("browses only the cached GitHub tree and excludes non-public paths", async () => {
    io.files.set("memory/config/private.json", "configuration");
    io.files.set("memory/research/手机调研/attachments/private.md", "attachment");
    const context = opts(makeGithubCtx("2026-09-10-1000"));
    expect(await recallListExecute({ path: "research/手机调研" }, context)).toMatchObject({
      kind: "entries", total: 1, entries: [{ path: "research/手机调研/index.md" }],
    });
    expect(await recallFindExecute({ name: "private" }, context)).toEqual({
      kind: "entries", total: 0, entries: [],
    });
    expect(githubGetRepoTree).toHaveBeenCalledTimes(2);
    expect(githubReadFileViaTree).not.toHaveBeenCalled();
    expect(githubReadFile).not.toHaveBeenCalled();
    expect(readFileLocal).not.toHaveBeenCalled();
  });

  it("recallRecent reads slice files via readFileViaTree, never the direct read", async () => {
    const out = await recallRecentExecute({}, opts(makeGithubCtx("2026-09-10-1000")));
    expect(out).toContain("records/2026-09-04-2130");
    expect(githubReadFileViaTree).toHaveBeenCalled();
    expect(
      vi.mocked(githubReadFileViaTree).mock.calls.every(([p]) =>
        p.startsWith("memory/"),
      ),
    ).toBe(true);
    expect(githubReadFile).not.toHaveBeenCalled();
  });

  it("recallSearch scans records bodies via readFileViaTree, never the direct read", async () => {
    const out = await recallSearchExecute(
      { query: "深埋关键词", includeRecords: true },
      opts(makeGithubCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(/^1 match\(es\) for "深埋关键词":/);
    expect(githubReadFileViaTree).toHaveBeenCalled();
    expect(githubReadFile).not.toHaveBeenCalled();
  });

  it("record recallRead redirects before any backend read", async () => {
    const out = await recallReadExecute(
      { ref: "records/2026-09-04-2130" },
      opts(makeGithubCtx("2026-09-10-1000")),
    );
    expect(out).toMatchObject({ kind: "recallScenario_required", ref: "records/2026-09-04-2130" });
    expect(githubReadFileViaTree).not.toHaveBeenCalled();
    expect(githubReadFile).not.toHaveBeenCalled();
  });
});
