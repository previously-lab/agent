import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The HQ agent (v0.21 §2/§4/§5). runSubAgent is mocked — the tests DRIVE the
 * tool set HQ gets (through the same callTool helper as previously-agent's
 * tests) and assert the run contract: results-only storage (an idle round
 * writes nothing), the write tools landing through the real case machinery,
 * a substantive veto landing as prose, and HQ's freedom to run the passes in
 * any order (or skip them).
 */

// In-memory memory root (same pattern as background-runs.test.ts).
const io = vi.hoisted(() => ({ files: new Map<string, string>() }));
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

vi.mock("@/lib/episodic/slice-mutex", () => ({
  withSliceLock: vi.fn(async (_key: string, fn: () => unknown) => fn()),
}));

const episodic = vi.hoisted(() => ({
  loadSlice: vi.fn(),
  readSlicePart: vi.fn(async (sliceId: string, part: string) => {
    const v = io.files.get(`${sliceId}:${part}`);
    if (v === undefined) throw new Error(`missing ${sliceId}:${part}`);
    return v;
  }),
  slicePartPathCandidates: vi.fn(
    (sliceId: string, part: string) =>
      [`memory/records/${sliceId}/${part}.md`, `legacy/${sliceId}/${part}.md`] as [
        string,
        string,
      ],
  ),
}));
vi.mock("@/lib/episodic", () => episodic);

// The runner is mocked; the tests play HQ by calling the tools it was given.
vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: vi.fn() }));

// The composite passes are mocked at their boundaries; the case write
// machinery (applyCaseWriteIntent, makeCaseReadTool, renderManifest) stays REAL.
const passes = vi.hoisted(() => ({
  runLibrarianPass: vi.fn(),
  runDocResearchPass: vi.fn(),
  runCardEvolution: vi.fn(),
}));
vi.mock("@/lib/episodic/flash/librarian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/flash/librarian")>();
  return { ...actual, runLibrarianPass: passes.runLibrarianPass };
});
vi.mock("@/lib/episodic/flash/doc-research", () => ({
  runDocResearchPass: passes.runDocResearchPass,
}));
vi.mock("@/app/api/evolution/run-card-evolution", () => ({
  runCardEvolution: passes.runCardEvolution,
}));

vi.mock("@/lib/models/registry", () => ({
  getModel: vi.fn(() => ({ id: "test-model" })),
  getDefaultModelId: vi.fn(() => "test-model"),
}));

vi.mock("@/lib/evolution/store", () => ({
  readUserModel: vi.fn(async (): Promise<null> => null),
  writeSelfSop: vi.fn(async (agent: string, content: string) => {
    io.files.set(`memory/self/${agent}/index.md`, content);
  }),
  // detectDirectionMode (kept real) needs this from the store module.
  isDirectionTemplate: (current: string | null): boolean =>
    !current || !current.trim(),
}));

import { handleBrief } from "@/app/api/evolution/hq-agent";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";

const runSubAgentMock = vi.mocked(runSubAgent);
type RunnerOpts = Parameters<typeof runSubAgent>[0];

async function callTool(opts: RunnerOpts, name: string, args: unknown): Promise<string> {
  const t = opts.tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<string>;
  };
  return t.execute(args, { toolCallId: "test", messages: [] });
}

const DATE = "2026-08-09";
const SLICE_ID = "2026-08-09-1300";
const BRIEF = "切片 2026-08-09-1300 刚关闭，聊了换手机；mailbox 里有一条问题标记。";

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  episodic.loadSlice.mockResolvedValue({
    slice_id: SLICE_ID,
    focus: "手机话题",
    summary: "聊了换手机",
    status: "closed",
    tags: [],
    turns: [
      { timestamp: "t0", role: "user", content: "想换手机" },
      { timestamp: "t1", role: "agent", content: "预算多少" },
    ],
  });
  passes.runLibrarianPass.mockResolvedValue({ voided: [], llmRan: true, written: [], skipped: [] });
  passes.runDocResearchPass.mockResolvedValue({ ran: true, written: [], skipped: [] });
  passes.runCardEvolution.mockResolvedValue({
    ran: true,
    changed: false,
    droppedRecent: 0,
    note: "reviewed",
  });
});

describe("handleBrief (v0.21 §5)", () => {
  it("an idle round writes NOTHING — HQ reports actions:[] and no file lands", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "Checked the slice; nothing worth storing." },
      text: "",
    }));

    const outcome = await handleBrief({ brief: BRIEF, date: DATE, sliceId: SLICE_ID });

    expect(outcome).toEqual({
      actions: [],
      note: "Checked the slice; nothing worth storing.",
    });
    expect(io.files.size).toBe(0);
    // Runner wiring: forced report through hqReport, HQ outlives its passes.
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.toolChoice).toBe("required");
    expect(opts.reportToolName).toBe("hqReport");
    expect(opts.maxSteps).toBe(50);
    expect(opts.timeoutMs).toBe(300_000);
  });

  it("a substantive write lands through the real case machinery", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "手机购买调研",
        body: "用户在 2026-08-09-1300 提到想换手机，预算未定。",
      });
      expect(r).toContain("OK:");
      return {
        ok: true,
        report: { actions: ["research/手机购买调研/index.md"], note: "Opened the research case." },
        text: "",
      };
    });

    const outcome = await handleBrief({ brief: BRIEF, date: DATE, sliceId: SLICE_ID });

    expect(outcome.actions).toEqual(["research/手机购买调研/index.md"]);
    expect(outcome.error).toBeUndefined();
    const raw = io.files.get("memory/research/手机购买调研/index.md");
    expect(raw).toBeDefined();
    expect(raw).toContain("想换手机");
  });

  it("a substantive veto lands as PROSE in self/, not as a counter", async () => {
    const reason =
      "核对了 records/2026/08/09/1300：mailbox 的问题标记所指内容已在 research/手机购买调研 覆盖，决定不再开新 case。";
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", {
        action: "open",
        category: "self",
        caseName: "evolution",
        body: reason,
      });
      expect(r).toContain("OK:");
      return {
        ok: true,
        report: { actions: ["self/evolution/index.md"], note: "Vetoed the implied write; reason in self/." },
        text: "",
      };
    });

    const outcome = await handleBrief({ brief: BRIEF, date: DATE, sliceId: SLICE_ID });

    expect(outcome.error).toBeUndefined();
    const raw = io.files.get("memory/self/evolution/index.md") ?? "";
    // The reason is prose carrying its evidence — not a tally line.
    expect(raw).toContain("决定不再开新 case");
    expect(raw).toContain("records/2026/08/09/1300");
  });

  it("HQ chooses its own order — evolveUserModel alone, no archive pass", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "evolveUserModel", {
        sliceId: SLICE_ID,
        focus: "①空转；直接复核用户模型。",
      });
      expect(r).toContain("changed:");
      return {
        ok: true,
        report: { actions: [], note: "Card reviewed, unchanged." },
        text: "",
      };
    });

    const outcome = await handleBrief({ brief: BRIEF, date: DATE, sliceId: SLICE_ID });

    expect(outcome.error).toBeUndefined();
    // The case-writer and research passes were never invoked — order and
    // selection are HQ's own call.
    expect(passes.runLibrarianPass).not.toHaveBeenCalled();
    expect(passes.runDocResearchPass).not.toHaveBeenCalled();
    expect(passes.runCardEvolution).toHaveBeenCalledTimes(1);
    const cardInput = passes.runCardEvolution.mock.calls[0][0] as {
      signal: string;
      closedSliceId?: string;
      allowedSopWrites?: string[];
    };
    expect(cardInput.signal).toBe("slice_closed");
    expect(cardInput.closedSliceId).toBe(SLICE_ID);
    expect(cardInput.allowedSopWrites).toEqual(["search", "thinkdeep"]);
  });
});
