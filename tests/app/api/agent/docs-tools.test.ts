/**
 * Document tools (v0.15 design §4.2/§4.4) — listDocs/readDoc executors and
 * the doc_rework probe, end to end over an in-memory local fs.
 *
 * rework-signal itself is REAL; only its two sinks are mocked (the fitness
 * store append and the agent.md timeline write), so the classification chain
 * recordDocRead → checkDocRework → logReworkSignal("doc_rework") is exercised
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
      type: "file" as const,
      path: `${p}/${name}`,
    }));
  },
  writeFileLocal: vi.fn(async () => ({ path: "", created: false })),
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
  listDocsExecute,
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

const DOC_PATH = "memory/docs/research/2026-09-05-手机购买调研.md";
const DOC_RAW = `---
status: active
opened: 2026-09-05
updated: 2026-09-12
---
# 手机购买调研

> 截至 2026-09-12：倾向小屏旗舰。

## 2026-09-05 — 开篇
证据见切片 2026-09-04-2130。
`;

const CORE_PATH =
  "memory/episodic/slices/2026/09/04/2130/timeline/core.md";

beforeEach(() => {
  io.files.clear();
  io.dirs.clear();
  sinks.appendSignal.mockClear();
  sinks.writeAgentTimeline.mockClear();
});

describe("listDocsExecute", () => {
  it("lists a kind directory in birth order (local mode)", async () => {
    io.dirs.set("memory/docs/research", [
      "2026-09-20-充电器调研.md",
      "2026-09-05-手机购买调研.md",
    ]);
    const r = await listDocsExecute({ kind: "research" }, opts(makeCtx("2026-09-10-1000")));
    expect(r).toEqual({
      kind: "research",
      files: ["2026-09-05-手机购买调研.md", "2026-09-20-充电器调研.md"],
    });
  });

  it("returns a visible note (not an error) for an empty kind", async () => {
    const r = await listDocsExecute({ kind: "hypothesis" }, opts(makeCtx("2026-09-10-1000")));
    expect(r).toHaveProperty("files", []);
    expect((r as { note?: string }).note).toContain("hypothesis");
  });

  it("rejects a kind outside the closed set with a visible error", async () => {
    const r = await listDocsExecute(
      { kind: "memex" as never },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("memex");
  });
});

describe("readDocExecute", () => {
  it("reads the whole document by file name and records its slice refs", async () => {
    io.files.set(DOC_PATH, DOC_RAW);
    const r = await readDocExecute(
      { fileName: "2026-09-05-手机购买调研" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).not.toHaveProperty("error");
    if ("error" in r) return;
    expect(r.kind).toBe("research");
    expect(r.status).toBe("active");
    expect(r.updated).toBe("2026-09-12");
    expect(r.content).toBe(DOC_RAW);
  });

  it("returns a visible dead-link error without throwing", async () => {
    const r = await readDocExecute(
      { fileName: "2026-01-01-不存在" },
      opts(makeCtx("2026-09-10-1000")),
    );
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("死链");
  });
});

describe("doc_rework probe (§4.4)", () => {
  it("logs doc_rework when readSlice opens a slice a readDoc referenced", async () => {
    io.files.set(DOC_PATH, DOC_RAW);
    io.files.set(CORE_PATH, "slice 2026-09-04-2130 core\n\nturn content\n");
    const ctx = makeCtx("2026-09-10-1000");

    await readDocExecute({ fileName: "2026-09-05-手机购买调研" }, opts(ctx));
    expect(sinks.appendSignal).not.toHaveBeenCalled();

    const out = await readSliceExecute({ sliceId: "2026-09-04-2130" }, opts(ctx));
    expect(out).toContain("turn content");
    expect(sinks.appendSignal).toHaveBeenCalledTimes(1);
    const signal = sinks.appendSignal.mock.calls[0][0] as {
      type: string;
      detail: string;
    };
    expect(signal.type).toBe("doc_rework");
    expect(signal.detail).toContain("2026-09-04-2130");
    expect(signal.detail).toContain("2026-09-05-手机购买调研.md");
    expect(sinks.writeAgentTimeline).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the read slice is not referenced by any read doc", async () => {
    io.files.set(DOC_PATH, DOC_RAW);
    io.files.set(
      "memory/episodic/slices/2026/09/06/0900/timeline/core.md",
      "unrelated slice\n",
    );
    const ctx = makeCtx("2026-09-10-1001");

    await readDocExecute({ fileName: "2026-09-05-手机购买调研" }, opts(ctx));
    await readSliceExecute({ sliceId: "2026-09-06-0900" }, opts(ctx));
    expect(sinks.appendSignal).not.toHaveBeenCalled();
  });

  it("stays silent when readSlice runs before any readDoc", async () => {
    io.files.set(CORE_PATH, "slice core\n");
    const ctx = makeCtx("2026-09-10-1002");
    await readSliceExecute({ sliceId: "2026-09-04-2130" }, opts(ctx));
    expect(sinks.appendSignal).not.toHaveBeenCalled();
  });

  it("never classifies the ongoing conversation slice as doc_rework", async () => {
    io.files.set(DOC_PATH, DOC_RAW.replace("2026-09-04-2130", "2026-09-10-1003"));
    io.files.set(
      "memory/episodic/slices/2026/09/10/1003/timeline/core.md",
      "current slice\n",
    );
    const ctx = makeCtx("2026-09-10-1003");
    await readDocExecute({ fileName: "2026-09-05-手机购买调研" }, opts(ctx));
    await readSliceExecute({ sliceId: "2026-09-10-1003" }, opts(ctx));
    expect(sinks.appendSignal).not.toHaveBeenCalled();
  });
});
