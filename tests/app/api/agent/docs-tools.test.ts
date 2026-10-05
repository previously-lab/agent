/**
 * Case-tree tools (v0.19 §A.2.1/§B.2) — listTree / two-segment readDoc
 * executors and the doc_rework probe, end to end over an in-memory local fs.
 *
 * rework-signal itself is REAL; only its two sinks are mocked (the fitness
 * store append and the agent.md timeline write), so the classification chain
 * recordDocRead → checkDocRework → logDocReworkSignal is exercised
 * for real. No memory/ directory is touched — all paths are map keys.
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
  listTreeExecute,
  readDocExecute,
  readSliceExecute,
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
  return { context: ctx, toolCallId: "tc-docs" };
}

const INDEX_RAW = `---
opened: 2026-09-05
---

手机调研 case 的正文：倾向小屏旗舰。证据见切片 2026-09-04-2130。
`;

const CORE_PATH =
  "memory/records/2026/09/04/2130/core.md";

beforeEach(() => {
  io.files.clear();
  io.dirs.clear();
  sinks.appendSignal.mockClear();
  sinks.writeAgentTimeline.mockClear();
});

describe("listTreeExecute", () => {
  it("lists the whole memory tree grouped by top-level category (local walk)", async () => {
    io.dirs.set("memory", ["research", "records", "config", "tasks"]);
    io.dirs.set("memory/research", ["手机调研"]);
    io.dirs.set("memory/research/手机调研", ["index.md", "2026-09-08-报价篇.md"]);
    io.dirs.set("memory/tasks", ["8号on-site"]);
    io.dirs.set("memory/tasks/8号on-site", ["index.md"]);
    io.dirs.set("memory/config", ["settings.json"]);
    io.dirs.set("memory/records", ["2026"]);
    io.dirs.set("memory/records/2026", ["09"]);
    io.dirs.set("memory/records/2026/09", ["04"]);
    io.dirs.set("memory/records/2026/09/04", ["2130"]);
    io.dirs.set("memory/records/2026/09/04/2130", ["core.md", "agent.md", "previously.md"]);

    const r = await listTreeExecute({}, opts(makeCtx("2026-09-10-1000")));
    expect(r.truncated).toBe(false);
    // Grouped by top level; doc paths verbatim, ascending.
    expect(r.tree["research"]).toEqual([
      "research/手机调研/2026-09-08-报价篇.md",
      "research/手机调研/index.md",
    ]);
    expect(r.tree["tasks"]).toEqual(["tasks/8号on-site/index.md"]);
    // records collapses to slice dirs — the three files inside are machinery.
    expect(r.tree["records"]).toEqual(["records/2026/09/04/2130"]);
  });

  it("mechanically filters config/ — new root and the legacy settings file — out of every group", async () => {
    io.dirs.set("memory", ["config", "research", "user"]);
    io.dirs.set("memory/config", ["settings.json", "nested"]);
    io.dirs.set("memory/config/nested", ["deep.json"]);
    io.dirs.set("memory/research", ["手机调研"]);
    io.dirs.set("memory/research/手机调研", ["index.md"]);
    io.dirs.set("memory/user", ["config.json", "profile.md"]);

    const r = await listTreeExecute({}, opts(makeCtx("2026-09-10-1000")));
    expect(r.tree["config"]).toBeUndefined();
    expect(Object.keys(r.tree)).not.toContain("config");
    const all = Object.values(r.tree).flat();
    expect(all.every((p) => !p.startsWith("config/"))).toBe(true);
    // The pre-v0.19 settings file is the same engineering state under an old
    // name — filtered too. The user's own profile.md beside it stays listed.
    expect(all).not.toContain("user/config.json");
    expect(all).toContain("user/profile.md");
  });

  it("returns an empty tree when memory/ does not exist yet", async () => {
    const r = await listTreeExecute({}, opts(makeCtx("2026-09-10-1000")));
    expect(r).toEqual({ truncated: false, tree: {} });
  });
});

describe("readDocExecute (two-segment)", () => {
  it("分类/case名 → the case's index.md, with opened/closed parsed", async () => {
    io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
    const r = await readDocExecute(
      { ref: "research/手机调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).not.toHaveProperty("error");
    if ("error" in r) return;
    expect(r.path).toBe("memory/research/手机调研/index.md");
    expect(r.opened).toBe("2026-09-05");
    expect(r.closed).toBeNull();
    expect(r.content).toBe(INDEX_RAW);
  });

  it("分类/case名/篇名 → the dated piece", async () => {
    const piece = "---\nopened: 2026-09-08\n---\n\n报价篇正文。\n";
    io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
    io.files.set("memory/research/手机调研/2026-09-08-报价篇.md", piece);
    const r = await readDocExecute(
      { ref: "research/手机调研/2026-09-08-报价篇" },
      opts(makeCtx("2026-09-10-1000")),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.path).toBe("memory/research/手机调研/2026-09-08-报价篇.md");
    expect(r.opened).toBe("2026-09-08");
    expect(r.content).toBe(piece);
  });

  it("《》 marks and a .md suffix are tolerated", async () => {
    io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
    const r = await readDocExecute(
      { ref: "《research/手机调研.md》" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).not.toHaveProperty("error");
  });

  it("falls back to the legacy roots for a bare pre-case name (§D.1 双根)", async () => {
    const legacy = "---\nstatus: active\nopened: 2026-08-01\nupdated: 2026-08-02\n---\n\n旧主题之家。\n";
    io.files.set("memory/docs/topic/用户手机.md", legacy);
    const r = await readDocExecute(
      { ref: "用户手机" },
      opts(makeCtx("2026-09-10-1000")),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.path).toBe("memory/docs/topic/用户手机.md");
    expect(r.content).toBe(legacy);
    // Legacy three-field headers are tolerated with a warning, never a crash.
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("returns a visible dead-link error when nothing resolves — never throws", async () => {
    const r = await readDocExecute(
      { ref: "research/不存在" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).toHaveProperty("error");
    if ("error" in r) {
      expect(r.error).toContain("dead link");
      expect(r.error).toContain("listTree");
    }
  });

  it("rejects an unparseable reference as a visible error", async () => {
    const r = await readDocExecute({ ref: "research/1234-数字开头" }, opts(makeCtx("2026-09-10-1000")));
    expect(r).toHaveProperty("error");
  });
});

describe("doc_rework probe (§4.4)", () => {
  it("logs doc_rework when readSlice opens a slice a readDoc referenced", async () => {
    io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
    io.files.set(CORE_PATH, "slice 2026-09-04-2130 core\n\nturn content\n");
    const ctx = makeCtx("2026-09-10-1000");

    await readDocExecute({ ref: "research/手机调研" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();

    const out = await readSliceExecute({ sliceId: "2026-09-04-2130" }, opts(ctx));
    expect(out).toContain("turn content");
    // v0.19 R4/R5: signals land as the agent.md audit line (+ run log), not
    // the retired fitness store.
    expect(sinks.writeAgentTimeline).toHaveBeenCalledTimes(1);
    const line = sinks.writeAgentTimeline.mock.calls[0][1] as string;
    expect(line).toContain("doc_rework");
    expect(line).toContain("2026-09-04-2130");
    expect(line).toContain("memory/research/手机调研/index.md");
  });

  it("stays silent when the read slice is not referenced by any read doc", async () => {
    io.files.set("memory/research/手机调研/index.md", INDEX_RAW);
    io.files.set("memory/records/2026/09/06/0900/core.md", "unrelated slice\n");
    const ctx = makeCtx("2026-09-10-1001");

    await readDocExecute({ ref: "research/手机调研" }, opts(ctx));
    await readSliceExecute({ sliceId: "2026-09-06-0900" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });

  it("stays silent when readSlice runs before any readDoc", async () => {
    io.files.set(CORE_PATH, "slice core\n");
    const ctx = makeCtx("2026-09-10-1002");
    await readSliceExecute({ sliceId: "2026-09-04-2130" }, opts(ctx));
    expect(sinks.writeAgentTimeline).not.toHaveBeenCalled();
  });
});
