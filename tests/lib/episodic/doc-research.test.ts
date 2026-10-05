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
} from "@/lib/episodic/flash/librarian";
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

function seedQuestions() {
  io.files.set(
    AGENT_MD,
    `${DOC_MARKER_PREFIX} {"v":1,"id":"q-1","kind":"question","title":"手机话题这一年的演变","note":"用户想要跨切片的完整链","topics":["用户手机"]}\n`,
  );
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
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                action: "updateIndex",
                category: "research",
                caseName: "已有调研",
                body: "旧进展 + 这次深挖的新发现。",
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

  it("a write on a missing case degrades to a visible skip, never throws", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              { action: "appendTail", category: "research", caseName: "不存在", line: "x" },
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
    expect(result.skipped[0]?.reason).toContain("does not exist");
  });

  it("questions are recorded even when the pass writes nothing (thin record)", async () => {
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
    expect(io.files.get(AGENT_MD)).toContain(RESEARCH_RECORD_PREFIX);
  });
});
