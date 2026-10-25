import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((config: unknown) => ({ _mock: config })),
}));

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failReadPath: null as string | null,
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(
    async (path: string, batch?: { entries: Map<string, string | null> }) => {
      if (io.failReadPath === path) throw new Error("injected backend read failure");
      const pending = batch?.entries.get(path);
      if (pending !== undefined) {
        if (pending === null) throw new Error(`File not found: "${path}" (deleted in this batch)`);
        return pending;
      }
      const content = io.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  ),
  fsWriteFile: vi.fn(
    async (
      path: string,
      content: string,
      batch?: { entries: Map<string, string | null> },
    ) => {
      if (batch) {
        batch.entries.set(path, content);
        return { path, created: true };
      }
      io.files.set(path, content);
      return { path, created: true };
    },
  ),
  fsListFiles: vi.fn(async (directory: string) => [...io.files.keys()]
    .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
    .map((path) => ({ path, name: path.slice(directory.length + 1), type: "file" as const }))),
}));

import {
  applyCaseWriteIntent,
  createCaseReadScope,
  makeCaseReadTool,
  makeSliceReadTool,
  readCaseIndexForScope,
  runLibrarianPass,
} from "@/lib/episodic/flash/librarian";
import { CaseWriteRefusal, WriteRefusal } from "@/lib/docs";
import { parseCaseCurrent, caseStorageRevision, renderCaseWithCurrent, caseCurrentFreshnessWarnings } from "@/lib/docs/case-doc";
import type { ModelConfig } from "@/lib/models/registry";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";

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
const EXCERPT = { focus: "设备排查", summary: "长谈摘要", turnsExcerpt: "末尾八轮摘要" };

function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

function mockWriterRun(cases: unknown[], readRefs: string[] = []) {
  ai.streamText.mockImplementation(async (options: RunSubAgentOptions<unknown>) => {
    for (const ref of readRefs) {
      const readCase = options.tools.readCase;
      if (!readCase?.execute) throw new Error("readCase tool missing");
      await readCase.execute(
        { ref },
        { toolCallId: `read-${ref}`, messages: [], context: undefined },
      );
    }
    return streamWith([
      { toolName: "caseWriterOutput", input: { cases, reasoning: "r" } },
    ]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.failReadPath = null;
});

type SliceTool = ReturnType<typeof makeSliceReadTool>;
type SliceToolInput = Parameters<NonNullable<SliceTool["execute"]>>[0];

async function callSliceTool(tool: SliceTool, input: SliceToolInput): Promise<string> {
  if (!tool.execute) throw new Error("readSlice execute missing");
  return tool.execute(input, { toolCallId: "slice-test", messages: [], context: undefined });
}

describe("original slice evidence", () => {
  it("invalid, empty, and failed pages do not authorize evidence", async () => {
    const raw = "---\n---\n\n## Turn x — 2026-08-09T13:00:00.000Z (user)\n\n真正的原话。\n";
    for (const input of [{ cursor: 999999 }, { maxChars: 2 }, { range: { type: "turns" as const, indices: [999] } }]) {
      const scope = createCaseReadScope();
      const output = await callSliceTool(makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => raw }), input);
      expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(false);
      expect(output).not.toContain("真正的原话");
    }
    const scope = createCaseReadScope();
    await callSliceTool(makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => { throw new Error("offline"); } }), {});
    expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(false);
  });

  it("binds a continuation to exact source bytes and records real coverage", async () => {
    let raw = `---\n---\n\n## Turn x — 2026-08-09T13:00:00.000Z (user)\n\n${"事实".repeat(200)}\n`;
    const scope = createCaseReadScope();
    const tool = makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => raw });
    const first = await callSliceTool(tool, { maxChars: 80 });
    const revision = /Source revision: ([0-9a-f]{64})/.exec(first)![1];
    const cursor = Number(/cursor=(\d+)/.exec(first)![1]);
    const proofs = scope.getEvidenceReads(`records/${SLICE_ID}`);
    expect(proofs).toMatchObject([{ revision, coverage: "range", start: 0, end: 80 }]);
    raw += "新增的用户更正。";
    const invalid = await callSliceTool(tool, { cursor, revision, maxChars: 80 });
    expect(invalid).toContain("source revision changed");
    expect(scope.getEvidenceReads(`records/${SLICE_ID}`)).toEqual(proofs);
  });

  it("makes early and long-message turning points readable with explicit continuation", async () => {
    const corePath = "memory/records/2026/08/09/1300/core.md";
    let raw = "---\nfocus: 长谈\n---\n";
    for (let i = 0; i < 12; i += 1) {
      const role = i === 10 ? "agent" : i % 2 === 0 ? "user" : "agent";
      const content = i === 0
        ? "早期转折：用户先排除了方案甲。"
        : i === 10
          ? `长消息开始 ${"证据".repeat(260)}\n\`\`\`html live\n<button>generated payload</button>\n\`\`\`\n长消息结尾：用户最终改选方案丙。`
          : `普通第 ${i} 轮`;
      raw += `\n## Turn t${i} — 2026-08-09T13:${String(i).padStart(2, "0")}:00.000Z (${role})\n\n${content}\n`;
    }
    io.files.set(corePath, raw);
    const scope = createCaseReadScope();
    const readSlice = makeSliceReadTool({ sliceId: SLICE_ID, scope });
    const pages: string[] = [];
    let cursor: number | undefined;
    let revision: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const output = await callSliceTool(readSlice, {
        range: { type: "turns", indices: [0, 10] },
        maxChars: 256,
        ...(cursor === undefined ? {} : { cursor }),
        ...(revision === undefined ? {} : { revision }),
      });
      pages.push(output);
      revision = /Source revision: ([0-9a-f]{64})/.exec(output)?.[1];
      const next = /cursor=(\d+)/.exec(output);
      cursor = next ? Number(next[1]) : undefined;
      if (cursor === undefined) break;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toContain("INCOMPLETE");
    expect(pages.at(-1)).toContain("COMPLETE");
    const all = pages.join("\n");
    expect(all).toContain("早期转折：用户先排除了方案甲");
    expect(all).toContain("长消息结尾：用户最终改选方案丙");
    expect(all).toContain("Interactive visual omitted");
    expect(all).not.toContain("generated payload");
    expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(true);
    expect(io.files.get(corePath)).toBe(raw);
  });
});

describe("read-proof and collision guards", () => {
  it("keeps version receipts compact and detects equal-timestamp edits", async () => {
    const path = "memory/research/大案/index.md";
    io.files.set(path, `---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n${"长文".repeat(30000)}`);
    const scope = createCaseReadScope();
    const read = await readCaseIndexForScope({ category: "research", caseName: "大案", scope });
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(read.revision).toBe(caseStorageRevision(read.content));
    io.files.set(path, read.content + "新事实");
    await expect(applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "大案", line: "基于旧读" }, DATE, undefined, scope))
      .rejects.toMatchObject({ code: "rewrite_conflict" });
  });

  it("does not reopen a settled body after a tail or legacy recent activity", async () => {
    for (const name of ["历史正文", "旧版尾注"]) {
      const path = `memory/research/${name}/index.md`;
      const updated = name === "旧版尾注" ? new Date().toISOString() : "2026-08-01T00:00:00Z";
      io.files.set(path, `---\nopened: '2026-08-01'\nupdated: '${updated}'\n---\n旧正文。\n\n—— 尾部 ——\n2026-08-09：旧补充。\n`);
      await applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: name, line: "新补充" }, DATE);
      await expect(applyCaseWriteIntent({ action: "rewriteIndex", category: "research", caseName: name, body: "覆盖旧正文" }, DATE))
        .rejects.toMatchObject({ code: "rewrite_window_closed" });
      expect(io.files.get(path)).toContain("旧正文");
      expect(io.files.get(path)).not.toContain("覆盖旧正文");
    }
  });

  it("detects current-only concurrent edits and new case pieces", async () => {
    const indexPath = "memory/things/并发认识/index.md";
    const currentPath = "memory/things/并发认识/_current.md";
    io.files.set(indexPath, "---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n历史原文。\n");
    for (const change of ["current", "piece"]) {
      const scope = createCaseReadScope();
      await readCaseIndexForScope({ category: "things", caseName: "并发认识", scope });
      if (change === "current") io.files.set(currentPath, "他人先写的新认识。");
      else io.files.set("memory/things/并发认识/2026-08-09-新材料.md", "新材料");
      await expect(applyCaseWriteIntent({ action: "reviseUnderstanding", category: "things", caseName: "并发认识", body: "我的旧草稿", evidence: ["things/并发认识"] }, DATE, undefined, scope))
        .rejects.toMatchObject({ code: "rewrite_conflict" });
    }
  });

  it("writes actual basis and renders compact current prose before preserved history", async () => {
    const path = "memory/research/当前案/index.md";
    const historical = "---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n历史认识。\n";
    io.files.set(path, historical);
    io.files.set("memory/research/当前案/2026-08-08-旧材料.md", "材料原文");
    const scope = createCaseReadScope();
    const read = await readCaseIndexForScope({ category: "research", caseName: "当前案", scope });
    await applyCaseWriteIntent({ action: "reviseUnderstanding", category: "research", caseName: "当前案", body: "当前解释仍有两种可能。", evidence: ["research/当前案"] }, DATE, undefined, scope);
    const current = parseCaseCurrent(io.files.get("memory/research/当前案/_current.md")!);
    expect(current.basis?.indexRevision).toBe(read.revision);
    expect(current.basis?.pieces).toEqual([{ path: "memory/research/当前案/2026-08-08-旧材料.md", revision: null }]);
    expect(io.files.get(path)).toBe(historical);
    const rendered = renderCaseWithCurrent(historical, io.files.get("memory/research/当前案/_current.md")!);
    expect(rendered.indexOf("当前解释")).toBeLessThan(rendered.indexOf("历史认识"));
    expect(caseCurrentFreshnessWarnings(current, { indexRevision: read.revision, pieces: [] })).toContain("the case piece inventory changed after the current view's basis");
  });

  it("refuses a write after the successfully read index changes", async () => {
    const path = "memory/research/并发案/index.md";
    const original = `---\nopened: '2026-08-09'\nupdated: '${new Date().toISOString()}'\n---\n\n读前正文。\n`;
    io.files.set(path, original);
    const scope = createCaseReadScope();
    const readCase = makeCaseReadTool(undefined, scope);
    await readCase.execute!(
      { ref: "research/并发案" },
      { toolCallId: "case-read", messages: [], context: undefined },
    );
    io.files.set(path, original.replace("读前正文", "并发后的正文"));
    const refusal = await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "并发案", line: "基于旧读的补充" },
      DATE,
      undefined,
      scope,
    ).catch((error) => error);
    expect(refusal).toBeInstanceOf(CaseWriteRefusal);
    expect(refusal.code).toBe("rewrite_conflict");
    expect(refusal.message).toContain("readCase");
    expect(io.files.get(path)).toContain("并发后的正文");
    expect(io.files.get(path)).not.toContain("基于旧读的补充");
  });

  it("same-piece retry noops, but same-date/title different text is refused", async () => {
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "碰撞案", body: "正文" },
      DATE,
    );
    const intent = {
      action: "addPiece" as const,
      category: "research" as const,
      caseName: "碰撞案",
      title: "报价篇",
      body: "原始篇文",
    };
    const first = await applyCaseWriteIntent(intent, DATE);
    const retry = await applyCaseWriteIntent(intent, DATE);
    expect(first.created).toBe(true);
    expect(retry.noop).toBe(true);
    const collision = await applyCaseWriteIntent(
      { ...intent, body: "不同的篇文" },
      DATE,
    ).catch((error) => error);
    expect(collision).toBeInstanceOf(WriteRefusal);
    expect(collision.code).toBe("already_exists");
    expect(io.files.get(first.path)).toContain("原始篇文");
    expect(io.files.get(first.path)).not.toContain("不同的篇文");
  });

  it("does not mistake an index read failure for absence when opening", async () => {
    const path = "memory/research/读失败案/index.md";
    io.failReadPath = path;
    await expect(
      applyCaseWriteIntent(
        { action: "open", category: "research", caseName: "读失败案", body: "不应落盘" },
        DATE,
      ),
    ).rejects.toThrow("injected backend read failure");
    expect(io.files.has(path)).toBe(false);
  });
});

describe("worker currentUnderstanding reports", () => {
  it("keeps the frozen index byte-identical and archives a non-user view with counterevidence", async () => {
    const indexPath = "memory/things/老设备/index.md";
    const currentPath = "memory/things/老设备/_current.md";
    const historical = "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n冻结历史：曾判断电池故障。\n";
    io.files.set(indexPath, historical);
    const manifest = { truncated: false, tree: { things: ["things/老设备/index.md"] } };
    mockWriterRun(
      [
        {
          action: "skip",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "初步解释：可能是电池故障；尚未外部验证。",
            evidence: ["things/老设备"],
          },
        },
      ],
      ["things/老设备"],
    );
    const firstResult = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest,
      date: DATE,
    });
    expect(firstResult.written).toEqual(["things/老设备/_current.md"]);
    expect(io.files.get(indexPath)).toBe(historical);

    mockWriterRun(
      [
        {
          action: "reviseUnderstanding",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "后续记录是反证。当前有两种解释：充电线接触不良或电源管理设置；仍属解释，不是外部验证。",
            evidence: ["things/老设备"],
          },
        },
      ],
      ["things/老设备"],
    );
    const secondResult = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest,
      date: DATE,
    });
    expect(secondResult.written).toEqual(["things/老设备/_current.md"]);
    expect(secondResult.skipped).toEqual([]);
    const current = parseCaseCurrent(io.files.get(currentPath)!);
    expect(current.body).toContain("后续记录是反证");
    expect(current.body).toContain("两种解释");
    expect(current.history).toContain("初步解释：可能是电池故障");
    expect(current.history).toContain(`## ${DATE} — previous understanding`);
    expect(current.evidence).toEqual(["things/老设备"]);
    expect(current.asOf).toBe(DATE);
    expect(io.files.get(indexPath)).toBe(historical);
  });

  it("rejects an evidence ref the worker never actually read", async () => {
    io.files.set(
      "memory/things/老设备/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n冻结历史。\n",
    );
    mockWriterRun(
      [
        {
          action: "reviseUnderstanding",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "把未读记录当作证据。",
            evidence: [`records/${SLICE_ID}`],
          },
        },
      ],
      ["things/老设备"],
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: { truncated: false, tree: { things: ["things/老设备/index.md"] } },
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("unread or invalid evidence");
    expect(io.files.has("memory/things/老设备/_current.md")).toBe(false);
  });
});
