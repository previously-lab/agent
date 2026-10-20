import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The HQ agent (v0.21 §2/§4/§5). runSubAgent is mocked — the tests DRIVE the
 * tool set HQ gets (through the same callTool helper as previously-agent's
 * tests) and assert the run contract: results-only storage (an idle round
 * writes nothing), the write tools landing through the real case machinery,
 * a substantive veto landing as prose, and HQ's freedom to run the passes in
 * any order (or skip them).
 */

// In-memory memory root (same pattern as background-runs.test.ts).
const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** The batch the in-flight round created — the read-your-writes tests
   *  reach into the queue directly (e.g. to queue a delete). */
  batchRef: { current: null as null | { entries: Map<string, string | null> } },
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  // HQ coalesces each round into ONE batch and ONE flush — mirror the
  // production shapes so the queued entries land on the fake disk.
  createBatch: () => {
    const batch = {
      entries: new Map<string, string | null>(),
      encodings: new Map<string, "base64">(),
    };
    io.batchRef.current = batch;
    return batch;
  },
  commitReflectionRound: vi.fn(
    async (batch: { entries: Map<string, string | null> }, _message: string) => {
      // mirror the real contract (io-helpers): a round WITH queued writes
      // applies them; a clean EMPTY round lands a no-op empty commit (the
      // local fake disk has no git ledger).
      for (const [p, c] of batch.entries) {
        if (c === null) io.files.delete(p);
        else io.files.set(p, c);
      }
      batch.entries.clear();
    },
  ),
  flushBatch: vi.fn(
    async (batch: { entries: Map<string, string | null> }, _msg: string) => {
      for (const [p, c] of batch.entries) {
        if (c === null) io.files.delete(p);
        else io.files.set(p, c);
      }
      batch.entries.clear();
    },
  ),
  fsReadFile: vi.fn(
    async (path: string, batch?: { entries: Map<string, string | null> }) => {
      // Mirror the real fsReadFile contract (io-helpers.ts): the pending
      // queue is consulted FIRST — a queued write reads back, a queued
      // delete throws the "deleted in this batch" error. The read-your-writes
      // tests below depend on this fidelity.
      const pending = batch?.entries.get(path);
      if (pending !== undefined) {
        if (pending === null) {
          throw new Error(`File not found: "${path}" (deleted in this batch)`);
        }
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
      // Mirror the real fsWriteFile: a batched write QUEUES, never lands
      // directly — the flush applies the queue.
      if (batch) {
        batch.entries.set(path, content);
        return { path, created: true };
      }
      io.files.set(path, content);
      return { path, created: true };
    },
  ),
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
  closeSlice: vi.fn(
    async (
      slice: {
        status: string;
        closedBy?: string;
        end?: string;
        turns: Array<{ timestamp: string }>;
      },
      signal: string,
    ) => {
      // the real closeSlice (manager.ts): status + closed_by + end = last
      // turn's timestamp, then persist. The mock mutates in place — the
      // tests' loadSlice hands out the SAME object, so a second markOrphan
      // call observes the close.
      slice.status = "closed";
      slice.closedBy = signal;
      slice.end = slice.turns.at(-1)?.timestamp ?? "now";
      return slice;
    },
  ),
  readSlicePart: vi.fn(
    async (
      sliceId: string,
      part: string,
      batch?: { entries: Map<string, string | null> },
    ) => {
      // Mirror the real dual-root read with the batch threaded (paths from
      // the slicePartPathCandidates mock below).
      for (const p of [
        `memory/records/${sliceId}/${part}.md`,
        `legacy/${sliceId}/${part}.md`,
      ]) {
        const pending = batch?.entries.get(p);
        if (pending !== undefined) {
          if (pending === null) throw new Error(`missing ${sliceId}:${part}`);
          return pending;
        }
      }
      const v = io.files.get(`${sliceId}:${part}`);
      if (v === undefined) throw new Error(`missing ${sliceId}:${part}`);
      return v;
    },
  ),
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
  // detectDirectionMode (kept real) needs this from the store module.
  isDirectionTemplate: (current: string | null): boolean =>
    !current || !current.trim(),
}));

import { handleBrief } from "@/app/api/evolution/hq-agent";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import { withSliceLock } from "@/lib/episodic/slice-mutex";

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
/** The v0.34 R2 docket input (§5.3) — one sealed boundary slice in scope,
 *  no beat due, no agenda. The tests vary the tools, not the docket. */
const DOCKET = {
  date: DATE,
  cursor: null,
  scope: [{ sliceId: SLICE_ID, turnIds: ["a1b2c3"], closedBy: "idle_gap" as const }],
  evolutionDue: false,
  evolutionReasons: [],
  agendaDue: [],
};

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

describe("handleBrief (v0.21 §5)", () => {
  it("an idle round writes NOTHING — HQ reports actions:[] and no file lands", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "Checked the slice; nothing worth storing." },
      text: "",
    }));

    const outcome = await handleBrief(DOCKET);

    expect(outcome).toEqual({
      actions: [],
      note: "Checked the slice; nothing worth storing.",
    });
    expect(io.files.size).toBe(0);
    // v0.39 #19 — 空轮也是恰好 1 次提交: the empty batch still lands ONE
    // commit carrying ONLY the trailer (空转零文件写入、日志留一行).
    const { commitReflectionRound } = await import("@/lib/episodic/io-helpers");
    expect(vi.mocked(commitReflectionRound)).toHaveBeenCalledTimes(1);
    const message = vi.mocked(commitReflectionRound).mock.calls[0][1];
    expect(message).toContain("Reflection round — 2026-08-09");
    expect(message).toContain("seen: 2026-08-09-1300#a1b2c3"); // turn-level water level (v0.42)
    // Runner wiring: forced report through hqReport; NO wall-clock budget
    // (v0.34 修订 A — execution budgets are deleted repo-wide; the round's
    // bounds are the step cap and the platform wall).
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.toolChoice).toBe("required");
    expect(opts.reportToolName).toBe("hqReport");
    expect(opts.maxSteps).toBe(50);
    expect("timeoutMs" in opts).toBe(false);
  });

  it("a substantive write lands through the real case machinery", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "手机购买调研",
        body: "用户在 2026-08-09-1300 提到想换手机，预算未定。",
      });
      expect(r).toContain("OK — 已记录，随本轮一次落盘");
      return {
        ok: true,
        report: { actions: ["research/手机购买调研/index.md"], note: "Opened the research case." },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.actions).toEqual(["research/手机购买调研/index.md"]);
    expect(outcome.error).toBeUndefined();
    const raw = io.files.get("memory/research/手机购买调研/index.md");
    expect(raw).toBeDefined();
    expect(raw).toContain("想换手机");
  });

  it("writeCase: rewriteIndex is window-gated; expectedUpdated guards against a moved case", async () => {
    const fresh = new Date().toISOString();
    io.files.set(
      "memory/research/手机购买调研/index.md",
      `---\nopened: '2026-08-01'\nupdated: '${fresh}'\n---\n\n读过的正文。\n`,
    );
    io.files.set(
      "memory/research/旧案/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n沉淀的正文。\n",
    );
    runSubAgentMock.mockImplementation(async (opts) => {
      // Out of window, no stamp → structured refusal pointing at the tail.
      const r1 = await callTool(opts, "writeCase", {
        action: "rewriteIndex",
        category: "research",
        caseName: "旧案",
        body: "x",
      });
      expect(r1).toContain("REJECTED:");
      expect(r1).toContain("outside its write window");
      // In window but the case moved since the read → conflict refusal.
      const r2 = await callTool(opts, "writeCase", {
        action: "rewriteIndex",
        category: "research",
        caseName: "手机购买调研",
        body: "基于旧读的重写。",
        expectedUpdated: "2026-08-09T00:00:00.000Z",
      });
      expect(r2).toContain("REJECTED:");
      expect(r2).toContain("moved since you read it");
      // In window with the stamp actually read → the rewrite lands.
      const r3 = await callTool(opts, "writeCase", {
        action: "rewriteIndex",
        category: "research",
        caseName: "手机购买调研",
        body: "基于新读的重写。",
        expectedUpdated: fresh,
      });
      expect(r3).toContain("OK — 已记录，随本轮一次落盘");
      // …and the out-of-window case still grows by dated tail lines.
      const r4 = await callTool(opts, "writeCase", {
        action: "appendTail",
        category: "research",
        caseName: "旧案",
        line: "价格已过时。",
      });
      expect(r4).toContain("OK — 已记录，随本轮一次落盘");
      return {
        ok: true,
        report: { actions: ["research/手机购买调研/index.md"], note: "Window guards verified." },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(io.files.get("memory/research/手机购买调研/index.md")).toContain("基于新读的重写。");
    expect(io.files.get("memory/research/旧案/index.md")).toContain("沉淀的正文。"); // 正文 untouched
    expect(io.files.get("memory/research/旧案/index.md")).toContain("价格已过时。");
    // The write-window discipline rides the tool surface itself.
    const writeCaseTool = runSubAgentMock.mock.calls[0][0].tools.writeCase as unknown as {
      description: string;
    };
    expect(writeCaseTool.description).toContain("Write-window discipline");
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
      expect(r).toContain("OK — 已记录，随本轮一次落盘");
      return {
        ok: true,
        report: { actions: ["self/evolution/index.md"], note: "Vetoed the implied write; reason in self/." },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

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

    const outcome = await handleBrief(DOCKET);

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
    // The merged run serializes on the process-wide evolution lock, same as
    // the field's turn pipeline.
    expect(vi.mocked(withSliceLock)).toHaveBeenCalledWith("evolution", expect.any(Function));
  });

  it("a LIVING slice gets the neutral field_report signal — never told the slice closed", async () => {
    episodic.loadSlice.mockResolvedValue({
      slice_id: SLICE_ID,
      focus: "进行中",
      summary: "",
      status: "active",
      tags: [],
      turns: [{ timestamp: "t0", role: "user", content: "还在聊" }],
    });
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "evolveUserModel", { sliceId: SLICE_ID, focus: "living 片复核。" });
      return { ok: true, report: { actions: [], note: "reviewed" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    const cardInput = passes.runCardEvolution.mock.calls[0][0] as {
      signal: string;
      closedSliceId?: string;
    };
    expect(cardInput.signal).toBe("field_report");
    // no closedSliceId — the agent must not enter the deep whole-slice review
    expect(cardInput.closedSliceId).toBeUndefined();
  });

  it("writeCase refuses people/user — the user model is evolveUserModel's, other people/* stay legal", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const refused = await callTool(opts, "writeCase", {
        action: "open",
        category: "people",
        caseName: "user",
        body: "试图往用户模型里写 frontmatter。",
      });
      expect(refused).toContain("REJECTED:");
      expect(refused).toContain("evolveUserModel");
      const legal = await callTool(opts, "writeCase", {
        action: "open",
        category: "people",
        caseName: "同事小林",
        body: "2026-08-09-1300 提到的同事。",
      });
      expect(legal).toContain("OK — 已记录，随本轮一次落盘");
      return { ok: true, report: { actions: [], note: "guard verified" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // nothing ever landed on the user model path
    expect(io.files.has("memory/people/user/index.md")).toBe(false);
    expect(io.files.get("memory/people/同事小林/index.md")).toContain("提到的同事");
  });

  it("writeSelfSop rewrites under the evolution lock", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeSelfSop", {
        agent: "search",
        content: "2026-08-09：读回失败先读回再引用（证据 2026-08-09-1300）。",
      });
      expect(r).toContain("OK — 已记录，随本轮一次落盘: memory/self/search/index.md");
      return { ok: true, report: { actions: [], note: "sop rewritten" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(vi.mocked(withSliceLock)).toHaveBeenCalledWith("evolution", expect.any(Function));
    expect(io.files.get("memory/self/search/index.md")).toContain("2026-08-09");
  });

  it("setAgenda rewrites self/agenda.md under the evolution lock, riding the round batch", async () => {
    const agenda =
      "- [due: 2026-08-12] 复查 hypotheses/手机调研假设（据片 2026-08-09-1300）\n";
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "setAgenda", { content: agenda });
      expect(r).toContain("OK — 已记录，随本轮一次落盘: memory/self/agenda.md");
      // Inside the tool the write is QUEUED, not landed — the round's one
      // flush applies it (the same batch discipline as every write tool).
      expect(io.files.has("memory/self/agenda.md")).toBe(false);
      return { ok: true, report: { actions: [], note: "agenda rewritten" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // the writeSelfSop discipline, copied: the process-wide evolution lock…
    expect(vi.mocked(withSliceLock)).toHaveBeenCalledWith("evolution", expect.any(Function));
    // …and the flush landed the queued rewrite at the agenda's own path.
    expect(io.files.get("memory/self/agenda.md")).toBe(agenda);
    // The format contract rides the tool surface itself.
    const agendaTool = runSubAgentMock.mock.calls[0][0].tools.setAgenda as unknown as {
      description: string;
    };
    expect(agendaTool.description).toContain("[due: YYYY-MM-DD]");
    expect(agendaTool.description).toContain("据片");
    expect(agendaTool.description).toContain("work pad, not a ledger");
    // …and the role prompt announces the agenda next to the craft notes.
    expect(runSubAgentMock.mock.calls[0][0].system).toContain("Your agenda — notes to yourself");
  });

  it("修订 C: disposition is reportable (schema-gated) and surfaces on the outcome", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      // The schema accepts the enum and the omitted default…
      const reportTool = opts.tools.hqReport as unknown as {
        inputSchema: { parse: (v: unknown) => unknown };
      };
      expect(() => reportTool.inputSchema.parse({ actions: [], note: "x" })).not.toThrow();
      expect(() =>
        reportTool.inputSchema.parse({ actions: [], note: "x", disposition: "superseded" }),
      ).not.toThrow();
      expect(() =>
        reportTool.inputSchema.parse({ actions: [], note: "x", disposition: "completed" }),
      ).not.toThrow();
      // …and rejects anything outside it — the vocabulary is enumerated.
      expect(() =>
        reportTool.inputSchema.parse({ actions: [], note: "x", disposition: "tired" }),
      ).toThrow();
      return {
        ok: true,
        report: {
          actions: [],
          note: "superseded: 又封了一片，本轮前提作废；放弃前未落盘。",
          disposition: "superseded" as const,
        },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(outcome.disposition).toBe("superseded");
    // The role prompt states when superseded is legitimate — a premise
    // overturned, never "tired, start over" (宁少勿滥).
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.system).toContain("SUPERSEDED");
    expect(opts.system).toContain("premise overturned");
    const reportTool = opts.tools.hqReport as unknown as { description: string };
    expect(reportTool.description).toContain("superseded");
  });

  it("a report WITHOUT disposition surfaces none — the backward-compatible default is completed", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "a normal round" },
      text: "",
    }));

    const outcome = await handleBrief(DOCKET);

    // Exact shape: no disposition key at all — old consumers read it as completed.
    expect(outcome).toEqual({ actions: [], note: "a normal round" });
    expect("disposition" in outcome).toBe(false);
    // no evolution pass ran → no evolved flag either
    expect("evolved" in outcome).toBe(false);
  });

  it("v0.34 R2 (§5.3): the DOCKET builds the user prompt — material, cursor, evolution verdict, and due agenda items delivered with the round", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "checked" },
      text: "",
    }));

    await handleBrief({
      date: DATE,
      cursor: "2026-08-09-1200",
      scope: [
        { sliceId: SLICE_ID, turnIds: ["a1b2c3"], closedBy: "idle_gap" },
        { sliceId: "2026-08-09-1400", turnIds: ["d4e5f6"], closedBy: "time_cap" },
      ],
      evolutionDue: true,
      evolutionReasons: ["conversation_boundary", "daily_rollover"],
      agendaDue: [
        { due: "2026-08-09", text: "复查 hypotheses/手机调研假设（据片 2026-08-09-1300）" },
      ],
    });

    const prompt = runSubAgentMock.mock.calls[0][0].prompt as string;
    // the material: every scoped slice named with its owed turns + close cause…
    expect(prompt).toContain("2026-08-09-1300: turns a1b2c3 (closed by idle_gap)");
    expect(prompt).toContain("2026-08-09-1400: turns d4e5f6 (closed by time_cap)");
    // …the cursor the range starts after…
    expect(prompt).toContain("2026-08-09-1200");
    // …the evolution verdict with its enumerated reasons…
    expect(prompt).toContain("evolution beat is DUE this round");
    expect(prompt).toContain("conversation_boundary, daily_rollover");
    // …and the due agenda item RIDING this round (delivery really happens)
    expect(prompt).toContain("due items ride WITH this round");
    expect(prompt).toContain("[due: 2026-08-09] 复查 hypotheses/手机调研假设");
  });

  it("v0.34 R2 (§4.2): an evolution pass that TRULY ran flags the outcome `evolved` — even when the model changed nothing; an unreadable slice never counts", async () => {
    // changed:false — the pass still RAN, the beat still stamps
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "evolveUserModel", { sliceId: SLICE_ID, focus: "复核。" });
      return { ok: true, report: { actions: [], note: "reviewed" }, text: "" };
    });
    let outcome = await handleBrief(DOCKET);
    expect(outcome.evolved).toBe(true);

    // the slice unreadable — the pass never ran: no flag
    episodic.loadSlice.mockRejectedValue(new Error("missing"));
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "nothing to do" },
      text: "",
    }));
    outcome = await handleBrief(DOCKET);
    expect("evolved" in outcome).toBe(false);
  });

  it("archiveSliceCases runs the case-writer AND the scribe over the same slice", async () => {
    passes.runScribePass.mockResolvedValue({
      ran: true,
      written: ["tasks/团队on-site/index.md"],
      skipped: [{ id: "t1-2", reason: "illegal case name" }],
    });
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "archiveSliceCases", { sliceId: SLICE_ID });
      expect(r).toContain("queued (lands when this round commits): (none)");
      expect(r).toContain("scribe queued (lands when this round commits): tasks/团队on-site/index.md");
      expect(r).toContain("scribe skipped: t1-2 (illegal case name)");
      return {
        ok: true,
        report: { actions: ["tasks/团队on-site/index.md"], note: "Archived the slice." },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // Both passes ran, over the SAME slice — the scribe consumes the slice's
    // sediment/task markers here (its only production caller).
    expect(passes.runLibrarianPass).toHaveBeenCalledTimes(1);
    expect(passes.runScribePass).toHaveBeenCalledTimes(1);
    const writerInput = passes.runLibrarianPass.mock.calls[0][0] as {
      closedSliceId: string;
      excerpt: { focus: string };
      date: string;
    };
    const scribeInput = passes.runScribePass.mock.calls[0][0] as {
      sliceId: string;
      excerpt: { focus: string };
      date: string;
    };
    expect(writerInput.closedSliceId).toBe(SLICE_ID);
    expect(scribeInput.sliceId).toBe(SLICE_ID);
    expect(writerInput.excerpt.focus).toBe("手机话题");
    expect(scribeInput.excerpt.focus).toBe("手机话题");
    expect(scribeInput.date).toBe(DATE);
  });

  it("markOrphan seals an orphaned ACTIVE slice (closed_by: context_lost), idempotently", async () => {
    // An active slice past the date window: the conversation long ended, the
    // close never fired, and findStaleActiveSlice only scans the last two
    // days — HQ is its only closer (T-08).
    const orphan = {
      slice_id: SLICE_ID,
      focus: "旧对话",
      summary: "",
      status: "active",
      tags: [],
      turns: [{ timestamp: "2026-08-09T13:20:00.000Z", role: "user", content: "最后一句" }],
    };
    episodic.loadSlice.mockResolvedValue(orphan);
    runSubAgentMock.mockImplementation(async (opts) => {
      const r1 = await callTool(opts, "markOrphan", { sliceId: SLICE_ID });
      expect(r1).toContain(`closed: ${SLICE_ID}`);
      expect(r1).toContain("context_lost");
      expect(r1).toContain("2026-08-09T13:20:00.000Z"); // end = last turn's stamp
      // Second call: the same object now reads closed → no-op, NO rewrite.
      const r2 = await callTool(opts, "markOrphan", { sliceId: SLICE_ID });
      expect(r2).toContain("no-op");
      expect(r2).toContain("context_lost");
      expect(episodic.closeSlice).toHaveBeenCalledTimes(1);
      // the close rides the round batch (third arg) — one commit per round
      expect(episodic.closeSlice).toHaveBeenCalledWith(
        orphan,
        "context_lost",
        expect.anything(),
      );
      return {
        ok: true,
        report: { actions: [`records/${SLICE_ID} sealed`], note: "Sealed the orphan." },
        text: "",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // the capability is announced on the tool surface and in the role prompt
    const opts = runSubAgentMock.mock.calls[0][0];
    const markOrphanTool = opts.tools.markOrphan as unknown as { description: string };
    expect(markOrphanTool.description).toContain("context_lost");
    expect(opts.system).toContain("orphan");
  });

  it("markOrphan on an already-closed slice is a no-op — closed_by named, never rewritten", async () => {
    episodic.loadSlice.mockResolvedValue({
      slice_id: SLICE_ID,
      focus: "",
      summary: "",
      status: "closed",
      closedBy: "idle_gap",
      tags: [],
      turns: [{ timestamp: "t0", role: "user", content: "x" }],
    });
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "markOrphan", { sliceId: SLICE_ID });
      expect(r).toContain("no-op");
      expect(r).toContain("idle_gap");
      return { ok: true, report: { actions: [], note: "already closed" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
  });

  it("markOrphan on an unreadable slice reports and writes nothing", async () => {
    episodic.loadSlice.mockRejectedValue(new Error("missing"));
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "markOrphan", { sliceId: SLICE_ID });
      expect(r).toContain("unreadable");
      return { ok: true, report: { actions: [], note: "nothing marked" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
  });

  // The 2026-10-16 live-lock: a malformed slice id rode to the round-end
  // flush and poisoned the whole commit (the trailer never landed, the
  // cursor held, the next round retried the same scope). The gate must
  // refuse BEFORE any read, write, or lock — a string, never a throw.
  // ("2026-13-99-9999" is range-nonsense but SHAPE-valid — parseSliceId's
  // contract is the four-segment shape; that id passes the gate and degrades
  // through the unreadable path below, still without a write.)
  const MALFORMED_IDS = [
    "2026-10-16 01:31",
    "2026-10-16-0131/core.md",
    "../escape",
    "2026-10-16",
    "",
  ];

  it("markOrphan / readRound refuse a malformed slice id at the gate — no throw, no read, no queued write", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      for (const id of MALFORMED_IDS) {
        const m = await callTool(opts, "markOrphan", { sliceId: id });
        expect(m).toContain("rejected");
        expect(m).toContain("YYYY-MM-DD-HHMM");
        expect(m).toContain("survey");
        if (id) expect(m).toContain(id); // the refusal echoes what was passed
        const r = await callTool(opts, "readRound", { sliceId: id });
        expect(r).toContain("rejected");
        expect(r).not.toContain("cannot read");
      }
      // The gate fires BEFORE the load: nothing was read, closed, or queued.
      expect(episodic.loadSlice).not.toHaveBeenCalled();
      expect(episodic.readSlicePart).not.toHaveBeenCalled();
      expect(io.batchRef.current!.entries.size).toBe(0);
      return { ok: true, report: { actions: [], note: "all refused" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    // an idle round: nothing queued, nothing on the fake disk
    expect(io.files.size).toBe(0);
  });

  it("a shape-valid but nonexistent id (2026-13-99-9999) degrades unreadable — the pre-gate load judgment, never a throw or a write", async () => {
    episodic.loadSlice.mockResolvedValue(null);
    runSubAgentMock.mockImplementation(async (opts) => {
      const m = await callTool(opts, "markOrphan", { sliceId: "2026-13-99-9999" });
      expect(m).toContain("unreadable");
      const r = await callTool(opts, "readRound", { sliceId: "2026-13-99-9999" });
      expect(r).toContain("cannot read");
      expect(io.batchRef.current!.entries.size).toBe(0);
      return { ok: true, report: { actions: [], note: "degraded" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect(episodic.closeSlice).not.toHaveBeenCalled();
    expect(io.files.size).toBe(0);
  });

  it("the three slice passes (archive / evolve / research) refuse a malformed id the same way", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const archive = await callTool(opts, "archiveSliceCases", { sliceId: "../escape" });
      expect(archive).toContain("rejected");
      const evolve = await callTool(opts, "evolveUserModel", { sliceId: "../escape", focus: "x" });
      expect(evolve).toContain("rejected");
      const research = await callTool(opts, "researchSliceQuestions", { sliceId: "../escape" });
      expect(research).toContain("rejected");
      // The passes (and the evolution lock) never ran — no evolution beat.
      expect(passes.runLibrarianPass).not.toHaveBeenCalled();
      expect(passes.runScribePass).not.toHaveBeenCalled();
      expect(passes.runDocResearchPass).not.toHaveBeenCalled();
      expect(passes.runCardEvolution).not.toHaveBeenCalled();
      expect(io.batchRef.current!.entries.size).toBe(0);
      return { ok: true, report: { actions: [], note: "passes refused" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    expect("evolved" in outcome).toBe(false);
  });

  it("the role prompt bans the builder's vantage point from self/ writes", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "idle" },
      text: "",
    }));

    await handleBrief(DOCKET);

    const opts = runSubAgentMock.mock.calls[0][0];
    // The investigator's-account discipline lives in the static role prompt…
    expect(opts.system).toContain("investigator's account");
    expect(opts.system).toContain("工程侧");
    // …and on the writeSelfSop tool surface itself. SOPs are exempt from the
    // document write window (mutation-style whole rewrites) — the surface
    // carries the SOP doctrine instead.
    const sopTool = opts.tools.writeSelfSop as unknown as { description: string };
    expect(sopTool.description).toContain("工程侧");
    expect(sopTool.description).toContain("short guidance, not an archive");
    expect(sopTool.description).not.toContain("Write-window discipline");
  });

  it("v0.42 §5 d. an UNEXPECTED throw after tools queued → the queued writes land as a DEGRADED commit, the cursor holds (NO seen line)", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      // The unit produced a write, then the platform blew up mid-round —
      // before any hqReport, before the settle.
      await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "降级落盘",
        body: "出错前已产出的写。",
      });
      throw new Error("platform step exploded");
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toContain("platform step exploded");
    // the landed write rides as actions (memory/-stripped, report style)
    expect(outcome.actions).toEqual(["research/降级落盘/index.md"]);
    const { commitReflectionRound } = await import("@/lib/episodic/io-helpers");
    expect(vi.mocked(commitReflectionRound)).toHaveBeenCalledTimes(1);
    const message = vi.mocked(commitReflectionRound).mock.calls[0][1] as string;
    expect(message).toContain("Reflection round — 2026-08-09"); // the SAME prefix
    expect(message).toContain("degraded commit"); // the degradation named in the body
    expect(message).not.toContain("seen:"); // 游标不动 — the absence of the line
    expect(io.files.get("memory/research/降级落盘/index.md")).toContain("出错前已产出的写。");
  });

  it("a TIMED-OUT round still reports the writes it landed — the flush survives the failure", async () => {
    // The observed production shape (2026-10-14): the sub-agent hits the
    // step-timeout AFTER its tools queued writes; the flush lands them, and
    // the round must not report actions:[] — a failed round with landed
    // writes is not an empty round.
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "手机购买调研",
        body: "超时前落的一笔。",
      });
      expect(r).toContain("OK — 已记录，随本轮一次落盘");
      return {
        ok: false,
        timedOut: true,
        text: "partial",
        error: "Sub-agent did not finish within 300s.",
      };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBe("Sub-agent did not finish within 300s.");
    // the landed write rides as actions (memory/-stripped, report style)…
    expect(outcome.actions).toEqual(["research/手机购买调研/index.md"]);
    // …the note stays empty (lastNote is the unit's OWN account — R1)…
    expect(outcome.note).toBe("");
    // …and the write genuinely landed (the flush ran before the error return).
    expect(io.files.get("memory/research/手机购买调研/index.md")).toContain("超时前落的一笔");
  });

  it("a failed round whose FLUSH failed reports NO writes — nothing landed, nothing claimed", async () => {
    const { commitReflectionRound } = await import("@/lib/episodic/io-helpers");
    vi.mocked(commitReflectionRound).mockRejectedValueOnce(new Error("disk full"));
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "手机购买调研",
        body: "丢掉的写。",
      });
      return { ok: false, timedOut: true, text: "", error: "boom" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBe("boom");
    expect(outcome.actions).toEqual([]);
    expect(io.files.size).toBe(0);
  });
});


describe("read-your-writes — the round's batch rides every read (v0.37 §5)", () => {
  it("writeCase(open) → readCase reads the QUEUED case back — no dead link on a case this round created", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const ok = await callTool(opts, "writeCase", {
        action: "open",
        category: "research",
        caseName: "手机购买调研",
        body: "队列里的正文。",
      });
      expect(ok).toContain("已记录，随本轮一次落盘");
      // Before the fix this was a dead link: the case is neither on disk nor
      // in any cache — only the queue knows it.
      const read = await callTool(opts, "readCase", { ref: "research/手机购买调研" });
      expect(read).toContain("队列里的正文。");
      expect(read).not.toContain("dead link");
      // Inside the round the write is queued, not landed…
      expect(io.files.has("memory/research/手机购买调研/index.md")).toBe(false);
      return { ok: true, report: { actions: [], note: "ryw" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // …and the round's flush committed it.
    expect(io.files.get("memory/research/手机购买调研/index.md")).toContain("队列里的正文。");
  });

  it("writeCase(appendTail) → readCase sees the tail line IN THE SAME ROUND (was: stale body)", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n旧正文。\n",
    );
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "writeCase", {
        action: "appendTail",
        category: "research",
        caseName: "手机调研",
        line: "本轮回补的尾行。",
      });
      const read = await callTool(opts, "readCase", { ref: "research/手机调研" });
      expect(read).toContain("旧正文。");
      expect(read).toContain("本轮回补的尾行。");
      return { ok: true, report: { actions: [], note: "ryw" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
  });

  it("a queued DELETE reads back as 「deleted in this round」 — not a dead link, not stale bytes", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n旧正文。\n",
    );
    runSubAgentMock.mockImplementation(async (opts) => {
      io.batchRef.current!.entries.set("memory/research/手机调研/index.md", null);
      const read = await callTool(opts, "readCase", { ref: "research/手机调研" });
      expect(read).toContain("deleted in this round");
      expect(read).not.toContain("dead link");
      expect(read).not.toContain("旧正文。");
      return { ok: true, report: { actions: [], note: "ryw" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
    // the queued delete rode the round's flush — the file is gone
    expect(io.files.has("memory/research/手机调研/index.md")).toBe(false);
  });

  it("readRound reads this round's QUEUED slice bytes before the disk", async () => {
    io.files.set(`${SLICE_ID}:core`, "盘上旧文。");
    runSubAgentMock.mockImplementation(async (opts) => {
      io.batchRef.current!.entries.set(
        `memory/records/${SLICE_ID}/core.md`,
        "本轮队列里的新文。",
      );
      const r = await callTool(opts, "readRound", { sliceId: SLICE_ID });
      // The complete round comes back in one call: the queued core text under
      // its labeled section, and the missing side-parts degraded to notes.
      expect(r).toContain("## core — the conversation");
      expect(r).toContain("本轮队列里的新文。");
      expect(r).not.toContain("盘上旧文。");
      expect(r).toContain("agent not found");
      return { ok: true, report: { actions: [], note: "ryw" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
  });

  it("readRound returns the complete round — core + agent + previously in one call", async () => {
    io.files.set(`${SLICE_ID}:core`, "用户的话。\n");
    io.files.set(`${SLICE_ID}:agent`, "agent 的思考。\n");
    io.files.set(`${SLICE_ID}:previously`, "当时的卡片。\n");
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "readRound", { sliceId: SLICE_ID });
      expect(r).toContain("## core — the conversation");
      expect(r).toContain("用户的话。");
      expect(r).toContain("## agent — the field's thinking and work");
      expect(r).toContain("agent 的思考。");
      expect(r).toContain("## previously — the user-card snapshot of that moment");
      expect(r).toContain("当时的卡片。");
      return { ok: true, report: { actions: [], note: "full round" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
  });

  it("survey returns a compact semantic index — never a raw file tree, config/ never exposed", async () => {
    io.files.set(
      "memory/research/手机调研/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n正文。\n",
    );
    io.files.set("memory/research/手机调研/2026-08-09-报价篇.md", "篇正文。\n");
    io.files.set("memory/records/2026/08/09/1300/core.md", "记录。\n");
    io.files.set("memory/config/settings.json", "{}");
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "survey", {});
      // cases fold to one line with piece counts + dates…
      expect(r).toContain("research/ — 1 case");
      expect(r).toContain("手机调研 — 1 piece, latest 2026-08-09");
      // …records collapse to round ids with newest first…
      expect(r).toContain("records/ — 1 round (2026-08-09-1300");
      expect(r).toContain("- 2026-08-09-1300");
      // …and the system config file never surfaces.
      expect(r).not.toContain("settings.json");
      expect(r).not.toContain("config/");
      return { ok: true, report: { actions: [], note: "surveyed" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
  });
});

describe("the batch-threading mechanical audit (v0.37 §5 — 漏接即红)", () => {
  const readSrc = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const hqSrc = readSrc("../../../../src/app/api/evolution/hq-agent.ts");
  const ctxSrc = readSrc("../../../../src/app/api/evolution/hq-context.ts");

  it("every HQ read assembly point threads the round's batch", () => {
    // readRound → readSlicePart; readCase → makeCaseReadTool; the four
    // loadSlice pre-reads (markOrphan / archiveSliceCases / evolveUserModel /
    // researchSliceQuestions); the user-model read; the card readers.
    expect(hqSrc).toContain("readSlicePart(sliceId, part, batch)");
    expect(hqSrc).toContain("makeCaseReadTool(batch)");
    expect(hqSrc).toContain("readUserModel(batch)");
    expect(hqSrc).toContain("buildRunCardReaders(batch)");
    expect(hqSrc.match(/loadSlice\(sliceId, batch\)/g)?.length).toBe(4);
  });

  it("the card readers pass the batch to BOTH dual-root probes", () => {
    expect(ctxSrc).toContain("fsReadFile(primary, batch)");
    expect(ctxSrc).toContain("fsReadFile(fallback, batch)");
  });
});


describe("queued vs committed wording + the memory-is-git contract (v0.37 §7-1, §2.3)", () => {
  it("every HQ writer surface carries the contract sentence; the role prompt does too", async () => {
    runSubAgentMock.mockImplementation(async () => ({
      ok: true,
      report: { actions: [], note: "idle" },
      text: "",
    }));

    await handleBrief(DOCKET);

    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.system).toContain("Memory is a git tree, not a database");
    for (const name of ["writeCase", "writeSelfSop", "setAgenda"] as const) {
      const t = opts.tools[name] as unknown as { description: string };
      expect(t.description).toContain("Memory is a git tree, not a database");
    }
  });

  it("the pass summaries say queued, not written — 'written' is claimed only after a commit", async () => {
    passes.runLibrarianPass.mockResolvedValue({
      voided: [],
      llmRan: true,
      written: ["research/手机话题/index.md"],
      skipped: [],
    });
    passes.runScribePass.mockResolvedValue({ ran: true, written: [], skipped: [] });
    runSubAgentMock.mockImplementation(async (opts) => {
      const r = await callTool(opts, "archiveSliceCases", { sliceId: SLICE_ID });
      expect(r).toContain("queued (lands when this round commits): research/手机话题/index.md");
      expect(r).not.toMatch(/^written:/m);
      return { ok: true, report: { actions: [], note: "x" }, text: "" };
    });

    const outcome = await handleBrief(DOCKET);

    expect(outcome.error).toBeUndefined();
  });
});
