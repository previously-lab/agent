/**
 * The memory-read facade executors (v0.36) — recallRecent / recallFind /
 * recallSearch / recallRead over an in-memory local fs, including the
 * doc_rework probe chain (recordDocRead → checkDocRework → logDocReworkSignal)
 * which now rides on recallRead.
 *
 * rework-signal itself is REAL; only its two sinks are mocked (the fitness
 * store append and the agent.md timeline write), so the classification chain
 * is exercised for real. No memory/ directory is touched — all paths are
 * map keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const io = vi.hoisted(() => {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  return { files, dirs };
});

vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (p: string) => {
    if (!io.files.has(p)) throw new Error(`File not found: "${p}"`);
    return io.files.get(p)!;
  },
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
  recallFindExecute,
  recallSearchExecute,
  recallReadExecute,
  type ToolContext,
} from "@/app/api/agent/tool-executors";

function makeCtx(sliceId: string): ToolContext {
  return {
    repo: "local",
    owner: "local",
    useGithub: false,
    useDemo: false,
    sliceId,
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
  io.files.clear();
  io.dirs.clear();
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

describe("recallFindExecute", () => {
  it("finds a case by name and renders the single-entry template", async () => {
    const out = await recallFindExecute(
      { category: "research", name: "手机调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(/^The 1 most recent research entries:/);
    expect(out).toContain("research/手机调研");
  });

  it("a miss renders the fixed not-found sentence with near misses", async () => {
    const out = await recallFindExecute(
      { category: "research", name: "手机" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(
      /^Nothing named "手机" exists in research\. Closest matches: research\/手机调研\./,
    );
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

  it("zero hits on a non-empty scope render the fixed fallback sentence", async () => {
    const out = await recallSearchExecute(
      { query: "绝对不存在的关键词" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toMatch(
      /^Nothing matches "绝对不存在的关键词"\. Here are the \d+ most recent entries instead:/,
    );
  });

  it("records bodies are scanned only when asked (scan-surface discipline)", async () => {
    // The deep keyword is absent from every structured document and slice head.
    const scoped = await recallSearchExecute(
      { query: "深埋关键词" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(scoped).toMatch(/^Nothing matches "深埋关键词"/);
    const withRecords = await recallSearchExecute(
      { query: "深埋关键词", includeRecords: true },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(withRecords).toMatch(/^1 match\(es\) for "深埋关键词":/);
    expect(withRecords).toContain("records/2026-09-05-0900");
  });
});

describe("recallReadExecute", () => {
  it("分类/case名 → the case's index.md, whole file", async () => {
    const out = await recallReadExecute(
      { ref: "research/手机调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toBe(INDEX_RAW);
  });

  it("《》 marks and a .md suffix are tolerated", async () => {
    const out = await recallReadExecute(
      { ref: "《research/手机调研.md》" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toBe(INDEX_RAW);
  });

  it("records/<slice id> → the slice core; an unknown ref renders the fixed sentence", async () => {
    const out = await recallReadExecute(
      { ref: "records/2026-09-04-2130" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(out).toContain("我想换手机，预算 5000。");
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
  it("logs doc_rework when recallRead opens a slice a case read referenced", async () => {
    const ctx = makeCtx("2026-09-10-1000");

    await recallReadExecute({ ref: "research/手机调研" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();

    const out = await recallReadExecute({ ref: "records/2026-09-04-2130" }, opts(ctx));
    expect(out).toContain("我想换手机");
    // v0.19 R4/R5: signals land as the agent.md audit line (+ run log), not
    // the retired fitness store.
    expect(sinks.writeAgentTimeline).toHaveBeenCalledTimes(1);
    const line = sinks.writeAgentTimeline.mock.calls[0][1] as string;
    expect(line).toContain("doc_rework");
    expect(line).toContain("2026-09-04-2130");
    expect(line).toContain("memory/research/手机调研/index.md");
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
