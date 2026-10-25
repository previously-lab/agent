import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
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
  fsListFiles: vi.fn(async (path: string) => {
    const prefix = `${path}/`;
    return [...io.files.keys()]
      .filter((p) => p.startsWith(prefix))
      .map((p) => {
        const rest = p.slice(prefix.length);
        return {
          name: rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest,
          type: (rest.includes("/") ? "dir" : "file") as "dir" | "file",
          path: p,
        };
      });
  }),
}));

import { runDocResearchPass } from "@/lib/episodic/flash/doc-research";
import {
  DOC_MARKER_PREFIX,
  RESEARCH_RECORD_PREFIX,
  extractProcessedMarkerIds,
} from "@/lib/episodic/flash/librarian";
import type { ModelConfig } from "@/lib/models/registry";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";

function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

function mockResearchRun(writes: unknown[], readRefs: string[] = []) {
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
      { toolName: "docResearchOutput", input: { writes, reasoning: "r" } },
    ]);
  });
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
const AGENT_MD = "memory/episodic/slices/2026/08/09/1300/timeline/agent.md";
const EXCERPT = { focus: "f", summary: "s", turnsExcerpt: "用户: 深查一下手机话题" };
const MANIFEST = { truncated: false, tree: { research: ["research/已有调研/index.md"] } };

function seedQuestions(ids = ["q-1"]) {
  io.files.set(
    AGENT_MD,
    ids.map((id) => `${DOC_MARKER_PREFIX} ${JSON.stringify({
      v: 1, id, kind: "question", title: "手机话题这一年的演变",
      note: "用户想要跨切片的完整链", topics: ["用户手机"],
    })}\n`).join(""),
  );
}

function researchRecords(): Array<{ id: string; docs: string[] }> {
  return (io.files.get(AGENT_MD) ?? "").split("\n")
    .filter((line) => line.startsWith(`${RESEARCH_RECORD_PREFIX} `))
    .map((line) => JSON.parse(line.slice(RESEARCH_RECORD_PREFIX.length)));
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

describe("runDocResearchPass — case model", () => {
  it("is question-driven: no agent.md, no pass, no LLM", async () => {
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("ignores sediment/task markers (they are the scribe's)", async () => {
    io.files.set(
      AGENT_MD,
      `${DOC_MARKER_PREFIX} {"v":1,"id":"s-1","kind":"sediment","docType":"research","title":"x","note":"","topics":[]}\n`,
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("opens a research case with the evidence stamp + a processed record", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                action: "open",
                category: "research",
                caseName: "手机话题演变调研",
                body: "问题：手机话题这一年怎么演变的。缘起：用户 8 月 9 日提问。",
              },
            ],
            reasoning: "记录足够开一篇。",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.ran).toBe(true);
    expect(result.written).toEqual(["research/手机话题演变调研/index.md"]);
    expect(result.productsByQuestion).toEqual([{
      markerId: "q-1",
      caseRef: "research/手机话题演变调研",
      productRef: "research/手机话题演变调研/index.md",
      outcome: "written",
    }]);
    const raw = io.files.get("memory/research/手机话题演变调研/index.md")!;
    expect(raw).toContain("opened: '2026-08-09'");
    expect(raw).toContain(`(refs: ${SLICE_ID})`);
    // The question is recorded as processed — never re-seen.
    expect(io.files.get(AGENT_MD)).toContain(RESEARCH_RECORD_PREFIX);
  });

  it("updates an existing in-window case via rewriteIndex", async () => {
    seedQuestions();
    io.files.set(
      "memory/research/已有调研/index.md",
      `---\nopened: '2026-08-01'\nupdated: '${new Date().toISOString()}'\n---\n\n旧进展。\n`,
    );
    mockResearchRun(
      [
        {
          action: "updateIndex",
          category: "research",
          caseName: "已有调研",
          body: "旧进展 + 这次深挖的新发现。",
        },
      ],
      ["research/已有调研"],
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual(["research/已有调研/index.md"]);
    const raw = io.files.get("memory/research/已有调研/index.md")!;
    expect(raw).toContain("旧进展 + 这次深挖的新发现。");
    expect(raw).not.toContain("status:");
  });

  it("REFUSES a hypothesis without a falsification condition (§B.6)", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                action: "open",
                category: "hypotheses",
                caseName: "用户偏好小屏",
                body: "用户可能偏好小屏手机。",
              },
              {
                action: "open",
                category: "hypotheses",
                caseName: "用户偏好小屏-有证伪",
                body: "猜测：用户偏好小屏手机。证伪条件：用户下次主动选择 6.7 寸以上机型。",
              },
            ],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual(["hypotheses/用户偏好小屏-有证伪/index.md"]);
    expect(result.skipped.map((s) => s.reason).join(" ")).toContain("falsification");
    expect(io.files.has("memory/hypotheses/用户偏好小屏/index.md")).toBe(false);
  });

  it("ACCEPTS an English hypothesis stating 'falsify if: …' (the gate reads both languages)", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                action: "open",
                category: "hypotheses",
                caseName: "小屏偏好-en",
                body: "Guess: the user prefers compact phones — falsify if: they next choose a 6.7-inch-plus model on their own.",
              },
            ],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual(["hypotheses/小屏偏好-en/index.md"]);
    const raw = io.files.get("memory/hypotheses/小屏偏好-en/index.md")!;
    expect(raw).toContain("falsify if:");
    expect(raw).toContain(`(refs: ${SLICE_ID})`);
  });

  it("the question run may only OPEN research/ or hypotheses/ cases", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              { action: "open", category: "things", caseName: "新物品", body: "x" },
            ],
            reasoning: "r",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("research/ or hypotheses/");
  });

  it("refuses a write when its own target has no successful read proof", async () => {
    seedQuestions();
    mockResearchRun(
      [{ action: "appendTail", category: "research", caseName: "不存在", line: "x" }],
      ["research/不存在"],
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("no successful full index read");
  });

  it("keeps an unanswered question actionable when the record is too thin", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: { writes: [], reasoning: "记录太薄，先不写。" },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: MANIFEST,
      date: DATE,
    });
    expect(result.ran).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.productsByQuestion).toEqual([]);
    expect(io.files.get(AGENT_MD)).not.toContain(RESEARCH_RECORD_PREFIX);
    await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(ai.streamText).toHaveBeenCalledTimes(2);
  });

  it("credits and processes only the question whose mapped write was accepted", async () => {
    seedQuestions(["q-1", "q-2"]);
    mockResearchRun([
      { action: "open", category: "research", caseName: "第一问结果", body: "第一问有足够证据。", questionIds: ["q-1"] },
      { action: "appendTail", category: "research", caseName: "第二问缺证据", line: "不能凭空写。", questionIds: ["q-2"] },
    ]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });

    expect(result.productsByQuestion).toEqual([{
      markerId: "q-1", caseRef: "research/第一问结果",
      productRef: "research/第一问结果/index.md", outcome: "written",
    }]);
    expect(researchRecords()).toEqual([{ id: "q-1", docs: ["research/第一问结果/index.md"] }]);
    expect([...extractProcessedMarkerIds(io.files.get(AGENT_MD)!, RESEARCH_RECORD_PREFIX)]).toEqual(["q-1"]);
    expect(result.skipped).toHaveLength(1);

    // q-2 is the next run's only current question; compatibility inference
    // must attach its successful result to q-2, never back to q-1.
    mockResearchRun([{ action: "open", category: "research", caseName: "第二问结果", body: "后来获得了证据。" }]);
    const next = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(next.productsByQuestion.map((product) => product.markerId)).toEqual(["q-2"]);
    expect(researchRecords()).toEqual([
      { id: "q-1", docs: ["research/第一问结果/index.md"] },
      { id: "q-2", docs: ["research/第二问结果/index.md"] },
    ]);
  });

  it("does not credit a refused mapped intent or mark its question processed", async () => {
    seedQuestions();
    mockResearchRun([{ action: "appendTail", category: "research", caseName: "缺少读回", line: "模型声称已经知道。", questionIds: ["q-1"] }]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(result.productsByQuestion).toEqual([]);
    expect(result.written).toEqual([]);
    expect(researchRecords()).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("no successful full index read");
  });

  it("rejects an intent containing any unknown question id before writing", async () => {
    seedQuestions(["q-1", "q-2"]);
    mockResearchRun([{ action: "open", category: "research", caseName: "无效映射", body: "不能落盘。", questionIds: ["q-1", "not-in-agenda"] }]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(result.productsByQuestion).toEqual([]);
    expect(io.files.has("memory/research/无效映射/index.md")).toBe(false);
    expect(researchRecords()).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("not-in-agenda");
  });

  it("allows one accepted product explicitly shared by multiple questions", async () => {
    seedQuestions(["q-1", "q-2"]);
    mockResearchRun([{ action: "open", category: "research", caseName: "共同结果", body: "两问共享的证据与解释。", questionIds: ["q-1", "q-2", "q-1"] }]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(result.written).toEqual(["research/共同结果/index.md"]);
    expect(result.productsByQuestion).toEqual(["q-1", "q-2"].map((markerId) => ({
      markerId, caseRef: "research/共同结果", productRef: "research/共同结果/index.md", outcome: "written",
    })));
    expect(researchRecords()).toEqual(["q-1", "q-2"].map((id) => ({ id, docs: ["research/共同结果/index.md"] })));
  });

  it("never guesses a multi-question mapping from an otherwise accepted write", async () => {
    seedQuestions(["q-1", "q-2"]);
    mockResearchRun([{ action: "open", category: "research", caseName: "未归属结果", body: "没有说明回答了哪一问。" }]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(result.written).toEqual(["research/未归属结果/index.md"]);
    expect(result.productsByQuestion).toEqual([]);
    expect(researchRecords()).toEqual([]);
  });

  it("returns an accepted identical product as existing after a successful target read", async () => {
    seedQuestions();
    io.files.set("memory/research/已有调研/index.md", `---\nopened: '${DATE}'\nupdated: '${new Date().toISOString()}'\n---\n已有研究。\n`);
    const body = `已经写定的结果。\n\n(refs: ${SLICE_ID})`;
    io.files.set(`memory/research/已有调研/${DATE}-结果篇.md`, `---\nopened: '${DATE}'\nupdated: '${new Date().toISOString()}'\n---\n${body}\n`);
    mockResearchRun([{ action: "addPiece", category: "research", caseName: "已有调研", title: "结果篇", body: "已经写定的结果。", questionIds: ["q-1"] }], ["research/已有调研"]);
    const result = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(result.written).toEqual([]);
    expect(result.productsByQuestion).toEqual([{
      markerId: "q-1", caseRef: "research/已有调研",
      productRef: `research/已有调研/${DATE}-结果篇.md`, outcome: "existing",
    }]);
    expect(researchRecords()).toEqual([{ id: "q-1", docs: [`research/已有调研/${DATE}-结果篇.md`] }]);
  });

  it("does not rerun an already processed marker or allow it in another question's mapping", async () => {
    seedQuestions();
    io.files.set(AGENT_MD, `${io.files.get(AGENT_MD)}${RESEARCH_RECORD_PREFIX} {"id":"q-1","docs":["research/已完成/index.md"]}\n`);
    const done = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(done).toMatchObject({ ran: false, productsByQuestion: [] });
    expect(ai.streamText).not.toHaveBeenCalled();

    io.files.set(AGENT_MD, `${io.files.get(AGENT_MD)}${DOC_MARKER_PREFIX} {"v":1,"id":"q-2","kind":"question","title":"另一问","note":""}\n`);
    mockResearchRun([{ action: "open", category: "research", caseName: "过期映射", body: "不能回答旧 marker。", questionIds: ["q-1"] }]);
    const next = await runDocResearchPass({ model, sliceId: SLICE_ID, excerpt: EXCERPT, date: DATE });
    expect(next.productsByQuestion).toEqual([]);
    expect(io.files.has("memory/research/过期映射/index.md")).toBe(false);
    expect(researchRecords()).toHaveLength(1);
  });
});
