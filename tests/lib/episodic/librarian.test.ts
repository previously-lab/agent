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
  appendTopicDirectoryEntry,
  buildSliceExcerpt,
  extractDocMarkers,
  extractProcessedMarkerIds,
  runLibrarianPass,
  runScribePass,
  voidMergedTopicHomes,
  DOC_MARKER_PREFIX,
  SCRIBE_RECORD_PREFIX,
} from "@/lib/episodic/flash/librarian";
import { serializeStrandEntity } from "@/lib/episodic/strand-files";
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
const AGENT_MD = `memory/episodic/slices/2026/08/09/1300/timeline/agent.md`;

const EXCERPT = {
  focus: "挑手机",
  summary: "用户对比了三款机型。",
  turnsExcerpt: "用户: 帮我看看这三款\nagent: 对比如下…",
};

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
});

// ─── Pure marker parsing ────────────────────────────────────────────────────

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
    expect(markers[0].topics).toEqual(["用户手机"]);
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
      `${SCRIBE_RECORD_PREFIX} {"id":"t1-1","doc":"2026-08-09-手机购买调研.md"}`,
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

// ─── Mechanical merge fallout ───────────────────────────────────────────────

describe("voidMergedTopicHomes", () => {
  it("voids a legacy home into the NEW location with a dated 作废 entry", async () => {
    io.files.set(
      "memory/episodic/strands/旧手机.md",
      serializeStrandEntity({
        name: "旧手机",
        first_seen: "2026-07-01",
        last_active: "2026-08-01",
        aliases: [],
        description: "关于旧手机的讨论。",
      }),
    );
    const result = await voidMergedTopicHomes([{ from: "旧手机", to: "用户手机" }], DATE);
    expect(result.voided).toEqual(["旧手机"]);
    const raw = io.files.get("memory/docs/topic/旧手机.md")!;
    expect(raw).toContain("status: void");
    expect(raw).toContain(`## ${DATE} — 作废 — 已并入《用户手机》`);
    // history stays readable
    expect(raw).toContain("关于旧手机的讨论。");
  });

  it("skips a bare-index strand (no home anywhere)", async () => {
    const result = await voidMergedTopicHomes([{ from: "裸线索", to: "x" }], DATE);
    expect(result.voided).toEqual([]);
    expect(result.skipped).toEqual([{ name: "裸线索", reason: "no home file" }]);
    expect(io.files.size).toBe(0);
  });
});

// ─── Directory entries (名录) ───────────────────────────────────────────────

describe("appendTopicDirectoryEntry", () => {
  it("opens the home when the first document lands under a topic", async () => {
    const result = await appendTopicDirectoryEntry({
      topic: "用户手机",
      docFileName: "2026-08-09-手机购买调研.md",
      action: "开设",
      date: DATE,
    });
    expect(result.ok).toBe(true);
    const raw = io.files.get("memory/docs/topic/用户手机.md")!;
    expect(raw).toContain("# 用户手机");
    expect(raw).toContain(`## ${DATE} — 名录`);
    expect(raw).toContain("《2026-08-09-手机购买调研》开设。");
  });

  it("refuses an illegal topic name", async () => {
    const result = await appendTopicDirectoryEntry({
      topic: "2026",
      docFileName: "x.md",
      action: "开设",
      date: DATE,
    });
    expect(result.ok).toBe(false);
    expect(io.files.size).toBe(0);
  });
});

// ─── The librarian pass ─────────────────────────────────────────────────────

describe("runLibrarianPass", () => {
  it("does not call the LLM when the closed slice touched no strand", async () => {
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: { 别的主题: ["2026/08/01/0900"] },
      merges: [],
      date: DATE,
    });
    expect(result.llmRan).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("writes the homes the model chooses and stamps the evidence slice", async () => {
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "librarianOutput",
          input: {
            homes: [
              {
                strand: "用户手机",
                action: "open",
                entryTitle: "开篇",
                body: "用户开始挑选新手机，在对比三款机型。",
                asOf: "用户在挑选新手机。",
              },
              { strand: "健身", action: "skip" },
            ],
            reasoning: "手机主题值得开家。",
          },
        },
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: {
        用户手机: ["2026/08/09/1300"],
        健身: ["2026/08/09/1300", "2026/08/02/0900"],
      },
      merges: [],
      date: DATE,
    });
    expect(result.llmRan).toBe(true);
    expect(result.written).toEqual(["用户手机"]);
    const raw = io.files.get("memory/docs/topic/用户手机.md")!;
    expect(raw).toContain("用户开始挑选新手机");
    expect(raw).toContain(`（证据切片：${SLICE_ID}）`);
    expect(raw).toContain(`> 截至 ${DATE}：用户在挑选新手机。`);
    // skip means skip — no fitness home.
    expect(io.files.has("memory/docs/topic/健身.md")).toBe(false);
    // writer-is-reader: the slice content and home state were IN the prompt.
    const prompt = String(ai.streamText.mock.calls[0][0].prompt);
    expect(prompt).toContain("用户对比了三款机型。");
    expect(prompt).toContain("尚无之家");
  });

  it("ignores ops for strands the slice did not touch", async () => {
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "librarianOutput",
          input: {
            homes: [{ strand: "幻觉主题", action: "open", entryTitle: "开篇", body: "x" }],
            reasoning: "",
          },
        },
      ]),
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: { 用户手机: ["2026/08/09/1300"] },
      merges: [],
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0].reason).toContain("not a touched strand");
    expect(io.files.size).toBe(0);
  });

  it("degrades to no writes when the model call fails", async () => {
    ai.streamText.mockRejectedValue(new Error("worker down"));
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: { 用户手机: ["2026/08/09/1300"] },
      merges: [],
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(io.files.size).toBe(0);
  });
});

// ─── The scribe pass ────────────────────────────────────────────────────────

function seedAgentMd(lines: string[]) {
  io.files.set(AGENT_MD, lines.join("\n") + "\n");
}

describe("runScribePass", () => {
  it("returns ran:false when the slice has no agent.md yet", async () => {
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: {},
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("writes a sediment marker into docs/research with a 名录 entry and a processed record", async () => {
    seedAgentMd([
      `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-1","kind":"sediment","docType":"research","title":"手机购买调研","note":"对比了三款机型","topics":["用户手机"]}`,
    ]);
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            entries: [
              {
                id: "t1-1",
                entryTitle: "开篇",
                body: "问题：三款机型怎么选。本场对比了屏幕、续航和价格。",
                asOf: "三款机型各有优劣，未决定。",
              },
            ],
            reasoning: "一篇沉淀。",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: { 用户手机: ["2026/08/09/1300"] },
      date: DATE,
    });
    expect(result.written).toEqual([`${DATE}-手机购买调研.md`]);

    const doc = io.files.get(`memory/docs/research/${DATE}-手机购买调研.md`)!;
    expect(doc).toContain("问题：三款机型怎么选");
    expect(doc).toContain(`（证据切片：${SLICE_ID}）`);

    const home = io.files.get("memory/docs/topic/用户手机.md")!;
    expect(home).toContain(`《${DATE}-手机购买调研》开设。`);

    const agentMd = io.files.get(AGENT_MD)!;
    expect(agentMd).toContain(`${SCRIBE_RECORD_PREFIX} {"id":"t1-1","doc":"${DATE}-手机购买调研.md"}`);
  });

  it("writes a task marker into docs/task with the date anchor stamped mechanically", async () => {
    seedAgentMd([
      `${DOC_MARKER_PREFIX} {"v":1,"id":"t2-1","kind":"task","title":"团队 on-site","dateAnchor":"2026-09-08","note":"8 号去 on-site","topics":[]}`,
    ]);
    ai.streamText.mockResolvedValue(
      streamWith([
        {
          toolName: "scribeOutput",
          input: {
            entries: [{ id: "t2-1", entryTitle: "开篇", body: "要做什么：参加团队 on-site。状态：待办。" }],
            reasoning: "",
          },
        },
      ]),
    );
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: {},
      date: DATE,
    });
    expect(result.written).toEqual([`${DATE}-团队 on-site.md`]);
    const doc = io.files.get(`memory/docs/task/${DATE}-团队 on-site.md`)!;
    expect(doc).toContain("日期锚：2026-09-08");
    expect(doc).toContain("状态：待办");
  });

  it("does not reprocess a marker that already has a record (no LLM call)", async () => {
    seedAgentMd([
      `${DOC_MARKER_PREFIX} {"v":1,"id":"t1-1","kind":"sediment","docType":"research","title":"手机购买调研","note":"x","topics":[]}`,
      `${SCRIBE_RECORD_PREFIX} {"id":"t1-1","doc":"${DATE}-手机购买调研.md"}`,
    ]);
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: {},
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
  });

  it("leaves question markers for the research pass", async () => {
    seedAgentMd([
      `${DOC_MARKER_PREFIX} {"v":1,"id":"q-1","kind":"question","title":"过去一年手机话题怎么演变的","note":"","topics":["用户手机"]}`,
    ]);
    const result = await runScribePass({
      model,
      sliceId: SLICE_ID,
      excerpt: EXCERPT,
      strands: { 用户手机: ["2026/08/09/1300"] },
      date: DATE,
    });
    expect(result.ran).toBe(false);
    expect(ai.streamText).not.toHaveBeenCalled();
    // untouched — no record line
    expect(io.files.get(AGENT_MD)).not.toContain(SCRIBE_RECORD_PREFIX);
  });
});
