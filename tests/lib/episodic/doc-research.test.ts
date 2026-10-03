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
const STRANDS = { 用户手机: ["2026/08/09/1300"] };

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

describe("runDocResearchPass", () => {
  it("is question-driven: no agent.md, no pass, no LLM", async () => {
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: STRANDS,
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
      strands: STRANDS,
      date: DATE,
    });
    expect(result.ran).toBe(false);
  });

  it("writes a research doc with the evidence stamp, a 名录 entry, and a processed record", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                kind: "research",
                mode: "open",
                title: "手机话题演变调研",
                entryTitle: "开篇",
                body: "问题：手机话题这一年怎么演变的。缘起：用户 8 月 9 日提问。",
                asOf: "调查开始。",
                topics: ["用户手机"],
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
      strands: STRANDS,
      date: DATE,
    });
    expect(result.written).toEqual([`${DATE}-手机话题演变调研.md`]);
    const doc = io.files.get(`memory/docs/research/${DATE}-手机话题演变调研.md`)!;
    expect(doc).toContain("问题：手机话题这一年怎么演变的");
    expect(doc).toContain(`（证据切片：${SLICE_ID}）`);
    const home = io.files.get("memory/docs/topic/用户手机.md")!;
    expect(home).toContain(`《${DATE}-手机话题演变调研》开设。`);
    expect(io.files.get(AGENT_MD)).toContain(`${RESEARCH_RECORD_PREFIX} {"id":"q-1"`);
    // read-before-write: the named topic's home state was IN the prompt.
    const prompt = String(ai.streamText.mock.calls[0][0].prompt);
    expect(prompt).toContain("主题之家 用户手机");
  });

  it("refuses a hypothesis without a falsification condition", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                kind: "hypothesis",
                mode: "open",
                title: "用户会在双十二换机",
                entryTitle: "开篇",
                body: "猜测：用户会在双十二换机。",
                topics: [],
              },
            ],
            reasoning: "",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: STRANDS,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0].reason).toContain("falsification");
    expect(io.files.has(`memory/docs/hypothesis/${DATE}-用户会在双十二换机.md`)).toBe(false);
    // the question is still recorded as seen (single-shot per boundary)
    expect(io.files.get(AGENT_MD)).toContain(RESEARCH_RECORD_PREFIX);
  });

  it("cannot append to a document that does not exist", async () => {
    seedQuestions();
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "docResearchOutput",
          input: {
            writes: [
              {
                kind: "research",
                mode: "append",
                target: "2026-01-01-幽灵文档.md",
                entryTitle: "更新",
                body: "新发现。",
                topics: [],
              },
            ],
            reasoning: "",
          },
        },
      ]),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: STRANDS,
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0].reason).toContain("missing document");
  });

  it("does not rerun a question that already has a record", async () => {
    io.files.set(
      AGENT_MD,
      [
        `${DOC_MARKER_PREFIX} {"v":1,"id":"q-1","kind":"question","title":"x","note":"","topics":[]}`,
        `${RESEARCH_RECORD_PREFIX} {"id":"q-1","docs":[]}`,
        "",
      ].join("\n"),
    );
    const result = await runDocResearchPass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: STRANDS,
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });
});
