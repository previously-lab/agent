/**
 * Replay idempotence (acceptance D-10, design v0.19 §D.3 verification ①):
 * the same CLOSED slice processed by HQ twice must not crash and must leave
 * readable products — the second pass is an empty spin (writer-is-reader
 * dedup) or a visibly refused/duplicate write, never corruption.
 *
 * Harness copied from hq-agent.test.ts: runSubAgent is mocked and the tests
 * play HQ through the real tool set; the case write machinery
 * (applyCaseWriteIntent) stays REAL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory memory root (same pattern as hq-agent.test.ts).
const io = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  // HQ coalesces each round into ONE batch and ONE flush — mirror the
  // production shapes so the queued entries land on the fake disk.
  createBatch: () => ({
    entries: new Map<string, string | null>(),
    encodings: new Map<string, "base64">(),
  }),
  flushBatch: vi.fn(
    async (batch: { entries: Map<string, string | null> }, _msg: string) => {
      for (const [p, c] of batch.entries) {
        if (c === null) io.files.delete(p);
        else io.files.set(p, c);
      }
      batch.entries.clear();
    },
  ),
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
  runScribePass: vi.fn(),
  runDocResearchPass: vi.fn(),
  runCardEvolution: vi.fn(),
}));
vi.mock("@/lib/episodic/flash/librarian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/episodic/flash/librarian")>();
  return {
    ...actual,
    runLibrarianPass: passes.runLibrarianPass,
    runScribePass: passes.runScribePass,
  };
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
const CASE_PATH = "memory/research/手机购买调研/index.md";

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
  passes.runScribePass.mockResolvedValue({ ran: true, written: [], skipped: [] });
  passes.runDocResearchPass.mockResolvedValue({ ran: true, written: [], skipped: [] });
  passes.runCardEvolution.mockResolvedValue({
    ran: true,
    changed: false,
    droppedRecent: 0,
    note: "reviewed",
  });
});

describe("HQ replay idempotence — same closed slice processed twice (D-10)", () => {
  it("archiveSliceCases twice: the second pass is an empty spin and the first pass's product stays byte-identical", async () => {
    // The librarian pass mock behaves writer-is-reader: it writes the case the
    // first time it sees the slice and skips it as already-covered on replay.
    passes.runLibrarianPass.mockImplementation(async () => {
      if (io.files.has(CASE_PATH)) {
        return {
          voided: [],
          llmRan: true,
          written: [],
          skipped: [{ name: "手机购买调研", reason: "already covered by an earlier round" }],
        };
      }
      io.files.set(
        CASE_PATH,
        "---\nopened: '2026-08-09'\nupdated: '2026-08-09T13:00:00.000Z'\n---\n\n想换手机，预算未定。\n",
      );
      return { voided: [], llmRan: true, written: [CASE_PATH], skipped: [] };
    });

    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "archiveSliceCases", { sliceId: SLICE_ID });
      expect(r).toContain("written:");
      return { ok: true, report: { actions: [], note: r }, text: "" };
    });

    const first = await handleBrief({ date: DATE, sliceId: SLICE_ID });
    expect(first.error).toBeUndefined();
    const afterFirst = io.files.get(CASE_PATH);
    expect(afterFirst).toBeDefined();

    const second = await handleBrief({ date: DATE, sliceId: SLICE_ID });
    expect(second.error).toBeUndefined();
    // The replay's product report is readable and shows the dedup skip.
    expect(second.note).toContain("written: (none)");
    expect(second.note).toContain("already covered");
    // The first round's write is untouched by the replay.
    expect(io.files.get(CASE_PATH)).toBe(afterFirst);
  });

  it("writeCase open replayed with identical args: REJECTED (already exists), no crash, first write intact", async () => {
    const openArgs = {
      action: "open",
      category: "research",
      caseName: "手机购买调研",
      body: "用户在 2026-08-09-1300 提到想换手机，预算未定。",
    };
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", openArgs);
      return { ok: true, report: { actions: [], note: r }, text: "" };
    });

    const first = await handleBrief({ date: DATE, sliceId: SLICE_ID });
    expect(first.error).toBeUndefined();
    expect(first.note).toContain("OK:");
    const afterFirst = io.files.get(CASE_PATH);
    expect(afterFirst).toContain("想换手机");

    const second = await handleBrief({ date: DATE, sliceId: SLICE_ID });
    expect(second.error).toBeUndefined();
    expect(second.note).toContain("REJECTED:");
    expect(second.note).toContain("already exists");
    expect(io.files.get(CASE_PATH)).toBe(afterFirst);
  });

  it("addPiece replayed with identical title+date lands the SAME dated piece file (overwrite, no duplicate)", async () => {
    io.files.set(
      CASE_PATH,
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n沉淀的正文。\n",
    );
    const pieceArgs = {
      action: "addPiece",
      category: "research",
      caseName: "手机购买调研",
      title: "报价线索",
      body: "某平台报价 4999。",
    };
    const piecePaths: string[] = [];
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", pieceArgs);
      const m = r.match(/^OK: (\S+)/);
      if (m) piecePaths.push(m[1]);
      return { ok: true, report: { actions: [], note: r }, text: "" };
    });

    await handleBrief({ date: DATE, sliceId: SLICE_ID });
    await handleBrief({ date: DATE, sliceId: SLICE_ID });

    // Same date + same title resolve to the same file name — the replay
    // overwrites in place instead of piling up a duplicate entry.
    expect(piecePaths).toHaveLength(2);
    expect(piecePaths[0]).toBe(piecePaths[1]);
    expect(io.files.get(piecePaths[0])).toContain("报价 4999");
    const pieces = [...io.files.keys()].filter((p) =>
      p.startsWith("memory/research/手机购买调研/"),
    );
    expect(pieces.sort()).toEqual([CASE_PATH, piecePaths[0]].sort());
  });
});
