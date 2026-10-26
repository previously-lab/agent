import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions, ToolCall } from "@/lib/deepseek/types";

const native = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", () => ({ streamText: native.streamText }));
vi.mock("workflow", () => ({ getWritable: vi.fn() }));
vi.mock("@/lib/evolution/store", () => ({ readSelfSopSnapshot: vi.fn() }));
vi.mock("@/lib/evolution/skill-store", () => ({ readSkillLedger: vi.fn() }));
vi.mock("@/lib/chat/step-timeout", () => ({
  withStepTimeout: vi.fn(async (work: () => Promise<unknown>) => ({ ok: true, result: await work(), elapsedMs: 0 })),
}));

import { runScenarioRecall, type ScenarioRecallInput, type ScenarioRecallResult } from "@/lib/agents/scenario-recall";
import type { RecallBackend } from "@/lib/memory/facade";
import { serializeSlice } from "@/lib/episodic/manager";
import { parseTurns } from "@/lib/episodic/turn-parser";
import type { TimeSlice } from "@/lib/episodic/types";

const REF = "records/2026-10-20-0930";
const OTHER_REF = "records/2026-10-19-1800";
const PATH = "memory/records/2026/10/20/0930/core.md";
const OTHER_PATH = "memory/records/2026/10/19/1800/core.md";
const USER_QUOTE = "I will leave at 08:30 on 2026-10-21.";
const ASSISTANT_QUOTE = "I noted the departure time you gave.";

function core(user = USER_QUOTE, assistant = ASSISTANT_QUOTE): string {
  return `---\nfocus: Departure planning\nsummary: A generated summary with 99:99 must not become evidence.\n---\n## Turn u1 — 2026-10-20T09:30:00.000Z (user)\n\n${user}\n\n## Turn a1 — 2026-10-20T09:31:00.000Z (assistant)\n\n${assistant}\n\n\`\`\`html live\n<button data-value="08:30">Generated 99:99 value</button>\n\`\`\`\n`;
}

function serializedConversation(turns: TimeSlice["turns"]): string {
  return serializeSlice({
    slice_id: "2026-10-20-0930",
    focus: "Departure planning",
    status: "closed",
    start: "2026-10-20T09:30:00.000Z",
    timezone: "UTC",
    summary: "Derived timeline summary",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns,
    estimatedTokens: 0,
    closedBy: "user_explicit",
  });
}

type ModelHandler = (options: AgentOptions) => Promise<ToolCall[]> | ToolCall[];
type SearchOutput = {
  matches: Array<{
    ref: string;
    excerpts: Array<{
      turnIndex: number;
      turnId?: string;
      role: string;
      matchOffset: number;
      snippetStart: number;
      snippetEnd: number;
      snippet: string;
    }>;
  }>;
};
type ReadOutput = {
  turns: Array<{
    turnIndex: number;
    turnId?: string;
    role: string;
    content: string;
    charOffset: number;
    endOffset: number;
    contentTruncated?: boolean;
  }>;
  omittedTurns: number;
  truncated: boolean;
  next: { startTurn: number; charOffset: number } | null;
  error?: string;
};
type ListOutput = { refs: string[]; total: number; truncated: boolean };

function mockModel(handler: ModelHandler): void {
  native.streamText.mockImplementation(async (options: AgentOptions) => {
    const calls = await handler(options);
    return {
      text: Promise.resolve(""),
      reasoningText: Promise.resolve(""),
      toolCalls: Promise.resolve(calls),
      sources: Promise.resolve([]),
      warnings: Promise.resolve([]),
    };
  });
}

function report(
  answer: string,
  evidence: Array<Record<string, unknown>> = [],
  uncertainty: string[] = [],
): ToolCall[] {
  return [{ toolCallId: "report", toolName: "scenarioRecallReport", input: { answer, evidence, uncertainty } }];
}

async function execute<T = unknown>(options: AgentOptions, name: string, input: unknown): Promise<T> {
  const definition = options.tools?.[name];
  if (!definition?.execute) throw new Error(`Missing executable tool ${name}`);
  return await definition.execute(input, {
    toolCallId: `call-${name}`,
    messages: [],
    context: undefined,
    abortSignal: options.abortSignal,
  }) as T;
}

function fixture(files: Record<string, string>): {
  backend: RecallBackend;
  readFile: ReturnType<typeof vi.fn>;
  listMemoryFiles: ReturnType<typeof vi.fn>;
} {
  const readFile = vi.fn(async (path: string): Promise<string> => {
    if (!(path in files)) throw new Error(`File not found: ${path}`);
    return files[path]!;
  });
  const listMemoryFiles = vi.fn(async (): Promise<string[]> => Object.keys(files));
  return { backend: { readFile, listMemoryFiles }, readFile, listMemoryFiles };
}

function inputFor(backend: RecallBackend, overrides: Partial<ScenarioRecallInput> = {}): ScenarioRecallInput {
  return {
    question: "What exact departure time did the user give, and who stated it?",
    backend,
    timeoutMs: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("record-only scenario recollection", () => {
  it("conditions on the question, searches then reads raw records, and returns exact role-bound evidence", async () => {
    const original = core();
    const { backend, readFile } = fixture({
      [PATH]: original,
      "memory/research/departure/index.md": USER_QUOTE,
      "memory/people/user/index.md": "Generated profile claim",
    });
    mockModel(async (options) => {
      expect(options.role).toBe("recall");
      expect(options.prompt).toContain("What exact departure time did the user give");
      expect(Object.keys(options.tools ?? {}).sort()).toEqual([
        "listRecords", "readRecord", "scenarioRecallReport", "searchRecords",
      ]);
      const found = await execute<SearchOutput>(options, "searchRecords", { query: "08:30" });
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]).toMatchObject({ ref: REF, excerpts: [{ turnId: "u1", role: "user" }] });
      const read = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(read.turns[0]).toMatchObject({ turnId: "u1", role: "user", content: expect.stringContaining(USER_QUOTE) });
      expect(read.turns[1].content).toContain(ASSISTANT_QUOTE);
      expect(read.turns[1].content).toContain("[Interactive visual omitted]");
      expect(read.turns[1].content).not.toContain("Generated 99:99 value");
      return report("The user gave 08:30; the assistant separately acknowledged it.", [
        { ref: REF, turnId: "u1", role: "user", quote: USER_QUOTE, note: "Exact user departure time" },
        { ref: REF, turnId: "a1", role: "assistant", quote: ASSISTANT_QUOTE, note: "Assistant acknowledgement" },
      ]);
    });

    const result = await runScenarioRecall(inputFor(backend));
    expect(result).toMatchObject({ status: "ok", truncated: false });
    expect(result.evidence).toEqual([
      expect.objectContaining({ ref: REF, turnId: "u1", role: "user", quote: USER_QUOTE }),
      expect.objectContaining({ ref: REF, turnId: "a1", role: "assistant", quote: ASSISTANT_QUOTE }),
    ]);
    expect(result.coverage.read).toEqual([REF]);
    expect(readFile).toHaveBeenCalledWith(PATH);
    expect(readFile).not.toHaveBeenCalledWith("memory/research/departure/index.md");
    expect(result).not.toHaveProperty("receipt");
    expect(result).not.toHaveProperty("write");
    expect(original).toContain("Generated 99:99 value");
    expect(native.streamText).toHaveBeenCalledTimes(1);
  });

  it("rejects forged quotes, wrong roles and turns, summaries, unread refs, and generated HTML values", async () => {
    const { backend } = fixture({ [PATH]: core(), [OTHER_PATH]: core("Another original statement") });
    mockModel(async (options) => {
      await execute<ReadOutput>(options, "readRecord", { ref: REF });
      return report("Only the first claim has verified support.", [
        { ref: REF, turnId: "u1", role: "user", quote: USER_QUOTE },
        { ref: REF, turnId: "u1", role: "assistant", quote: USER_QUOTE },
        { ref: REF, turnId: "a1", role: "user", quote: USER_QUOTE },
        { ref: REF, turnId: "u1", role: "user", quote: "I will leave at 09:00." },
        { ref: REF, turnId: "u1", role: "user", quote: "A generated summary with 99:99 must not become evidence." },
        { ref: REF, turnId: "a1", role: "assistant", quote: "Generated 99:99 value" },
        { ref: OTHER_REF, turnId: "u1", role: "user", quote: "Another original statement" },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend));
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ role: "user", turnId: "u1", quote: USER_QUOTE });
    expect(result.uncertainty.join(" ")).toContain("6 unverified evidence item(s)");
    expect(result.uncertainty.join(" ")).toContain("derived answer was suppressed");
  });

  it("suppresses an evidence-backed narrative when every supplied citation is forged", async () => {
    const { backend } = fixture({ [PATH]: core() });
    mockModel(async (options) => {
      await execute<ReadOutput>(options, "readRecord", { ref: REF });
      return report("The user definitely promised 99:99.", [
        { ref: REF, turnId: "a1", role: "assistant", quote: "Generated 99:99 value" },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend));
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [] });
    expect(result.uncertainty.join(" ")).toContain("discarded");
  });

  it("refuses document refs, arbitrary paths and encoded traversal without calling the backend reader", async () => {
    const { backend, readFile } = fixture({ [PATH]: core() });
    const direct = await runScenarioRecall(inputFor(backend, { refs: ["research/departure"] }));
    expect(direct.status).toBe("error");
    expect(direct.error).toContain("Refused non-record ref");
    expect(native.streamText).not.toHaveBeenCalled();

    mockModel(async (options) => {
      for (const ref of ["people/user", "memory/records/2026/10/20/0930/core.md", "records/../../people/user", "records%2f..%2fpeople%2fuser"]) {
        const read = await execute<ReadOutput>(options, "readRecord", { ref });
        expect(read.error).toContain("Refused");
      }
      return report("No original evidence was read.");
    });
    const result = await runScenarioRecall(inputFor(backend));
    expect(result.status).toBe("insufficient_evidence");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("enumerates only original record refs and honors the inclusive time window", async () => {
    const { backend } = fixture({
      [PATH]: core(),
      [OTHER_PATH]: core("Earlier"),
      "memory/research/x/index.md": "not a record",
      "memory/records/2026/10/20/0930/agent.md": "not core conversation",
    });
    mockModel(async (options) => {
      const listed = await execute<ListOutput>(options, "listRecords", { after: "2026-10-20", before: "2026-10-20" });
      expect(listed).toMatchObject({ refs: [REF], total: 1, truncated: false });
      const read = await execute<ReadOutput>(options, "readRecord", { ref: OTHER_REF });
      expect(read.error).toContain("Refused");
      return report("The requested window has no verified answer.", [], ["The other record was outside the window."]);
    });
    const result = await runScenarioRecall(inputFor(backend, { after: "2026-10-20", before: "2026-10-20" }));
    expect(result.status).toBe("insufficient_evidence");
    expect(result.uncertainty).toContain("The other record was outside the window.");
  });

  it("enforces the backend read cap and reports bounded coverage instead of absence", async () => {
    const files: Record<string, string> = {};
    for (let day = 1; day <= 13; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      files[`memory/records/2026/10/${String(day).padStart(2, "0")}/0900/core.md`] = core("Nothing relevant here");
      files[`memory/records/2026/10/${String(day).padStart(2, "0")}/0900/core.md`] = files[`memory/records/2026/10/${String(day).padStart(2, "0")}/0900/core.md`]!.replaceAll("2026-10-20", date);
    }
    const { backend, readFile } = fixture(files);
    mockModel(async (options) => {
      await execute<SearchOutput>(options, "searchRecords", { query: "unfindable" });
      await execute<SearchOutput>(options, "searchRecords", { query: "unfindable" });
      await execute<SearchOutput>(options, "searchRecords", { query: "unfindable" });
      const capped = await execute<ReadOutput>(options, "readRecord", { ref: "records/2026-10-01-0900" });
      expect(capped.error).toContain("read cap exhausted");
      return report("The bounded scan did not recover enough evidence.", [], ["Thirteen candidates exceeded the read budget."]);
    });
    const result: ScenarioRecallResult = await runScenarioRecall(inputFor(backend));
    expect(readFile).toHaveBeenCalledTimes(12);
    expect(result).toMatchObject({ status: "insufficient_evidence", truncated: true });
    expect(result.coverage.searched).toHaveLength(12);
    expect(result.coverage.read).toEqual([]);
    expect(result.coverage.discovered).toBe(13);
    expect(result.coverage.omitted).toBe(13);
    expect(result.uncertainty.join(" ")).toContain("bounded or truncated");
    expect(result.answer).not.toContain("never happened");
  });

  it("reads production user/agent pairs with shared ids and strips native HTML only from assistant views", async () => {
    const raw = serializedConversation([
      {
        timestamp: "2026-10-20T09:30:00.000Z",
        role: "user",
        turnId: "shared-turn",
        content: `${USER_QUOTE}\n\n\`\`\`html live\n<button>User supplied source</button>\n\`\`\``,
      },
      {
        timestamp: "2026-10-20T09:31:00.000Z",
        role: "agent",
        turnId: "shared-turn",
        content: `${ASSISTANT_QUOTE}\n\n\`\`\`html live\n<button>Agent generated value</button>\n\`\`\``,
      },
    ]);
    expect(raw).toContain("(user)");
    expect(raw).toContain("(agent)");
    const { backend } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      const read = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(read.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(read.turns.map((turn) => turn.turnId)).toEqual(["shared-turn", "shared-turn"]);
      expect(read.turns[0].content).toContain("User supplied source");
      expect(read.turns[1].content).toContain(ASSISTANT_QUOTE);
      expect(read.turns[1].content).toContain("[Interactive visual omitted]");
      expect(read.turns[1].content).not.toContain("Agent generated value");
      return report("Both original roles are grounded.", [
        { ref: REF, turnId: "shared-turn", role: "user", quote: USER_QUOTE },
        { ref: REF, turnId: "shared-turn", role: "assistant", quote: ASSISTANT_QUOTE },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(result).toMatchObject({ status: "ok", truncated: false });
    expect(result.evidence).toEqual([
      expect.objectContaining({ turnId: "shared-turn", role: "user", quote: USER_QUOTE }),
      expect.objectContaining({ turnId: "shared-turn", role: "assistant", quote: ASSISTANT_QUOTE }),
    ]);
    expect(result.coverage.read).toEqual([REF]);
  });

  it("never promotes a search result or summary into evidence without readRecord", async () => {
    const { backend } = fixture({ [PATH]: core() });
    mockModel(async (options) => {
      const found = await execute<SearchOutput>(options, "searchRecords", { query: "08:30" });
      expect(found.matches[0].ref).toBe(REF);
      return report("This search-only narrative must not be grounded.", [
        { ref: REF, turnId: "u1", role: "user", quote: USER_QUOTE },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend));
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [] });
    expect(result.coverage.searched).toEqual([REF]);
    expect(result.coverage.read).toEqual([]);
    expect(result.uncertainty.join(" ")).toContain("successful readRecord view");
  });

  it("accepts a visible prefix quote while marking a long-turn read truncated", async () => {
    const visible = "VISIBLE PREFIX: 08:30.";
    const hidden = "HIDDEN TAIL: 99:99.";
    const raw = core(`${visible}${"x".repeat(5_000)}${hidden}`);
    const { backend } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      const read = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(read.truncated).toBe(true);
      expect(read.turns[0].content).toHaveLength(4_000);
      expect(read.turns[0].content).toContain(visible);
      expect(read.turns[0].content).not.toContain(hidden);
      return report("Only the visible prefix supports this answer.", [
        { ref: REF, turnId: "u1", role: "user", quote: visible },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(result).toMatchObject({ status: "ok", truncated: true });
    expect(result.evidence).toEqual([expect.objectContaining({ quote: visible, role: "user" })]);
    expect(result.coverage.read).toEqual([REF]);
    expect(result.uncertainty.join(" ")).toContain("clipped or omitted turns");
    expect(raw).toContain(hidden);
  });

  it("rejects a quote from the hidden tail of a clipped turn", async () => {
    const hidden = "HIDDEN TAIL: 99:99.";
    const raw = core(`${"VISIBLE PREFIX ".repeat(20)}${"x".repeat(5_000)}${hidden}`);
    const { backend } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      await execute<ReadOutput>(options, "readRecord", { ref: REF });
      return report("The hidden tail cannot support this narrative.", [
        { ref: REF, turnId: "u1", role: "user", quote: hidden },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [], truncated: true });
    expect(result.uncertainty.join(" ")).toContain("derived answer was suppressed");
  });

  it("rejects a fully omitted later turn at the 16000-character view cap", async () => {
    const turns: TimeSlice["turns"] = Array.from({ length: 5 }, (_, index) => ({
      timestamp: `2026-10-20T09:3${index}:00.000Z`,
      role: "user",
      turnId: `turn-${index}`,
      content: `turn-${index} ${"x".repeat(3_992)}`,
    }));
    const raw = serializedConversation(turns);
    expect(parseTurns(raw).turns.map((turn) => turn.content.length)).toEqual([4_000, 4_000, 4_000, 4_000, 4_000]);
    const { backend } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      const read = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(read.turns).toHaveLength(4);
      expect(read.omittedTurns).toBe(1);
      expect(read.truncated).toBe(true);
      return report("The omitted fifth turn cannot ground this answer.", [
        { ref: REF, turnId: "turn-4", role: "user", quote: "turn-4" },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [], truncated: true });
    expect(result.coverage.read).toEqual([REF]);
    expect(result.uncertainty.join(" ")).toContain("clipped or omitted turns");
    expect(raw).toContain("turn-4");
  });

  it("locates and cites a late commitment only after targeted continued reading", async () => {
    const commitment = "I promise to submit the revised budget at 17:45.";
    const raw = core(`${"filler ".repeat(800)}${commitment}`);
    const { backend } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      const found = await execute<SearchOutput>(options, "searchRecords", { query: commitment });
      const hit = found.matches[0].excerpts[0];
      expect(hit.turnIndex).toBe(0);
      expect(hit.matchOffset).toBeGreaterThan(5_000);
      expect(hit.snippetStart).toBeGreaterThan(0);
      expect(hit.snippet).toContain(commitment);
      const initial = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(initial.turns[0].content).not.toContain(commitment);
      expect(initial.next).toEqual({ startTurn: 0, charOffset: 3_999 });
      return report("The first view cannot ground the late commitment.", [
        { ref: REF, turnId: "u1", role: "user", quote: commitment },
      ]);
    });
    const withheld = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(withheld).toMatchObject({ status: "insufficient_evidence", answer: "", evidence: [], truncated: true });

    mockModel(async (options) => {
      const found = await execute<SearchOutput>(options, "searchRecords", { query: commitment });
      const hit = found.matches[0].excerpts[0];
      const targeted = await execute<ReadOutput>(options, "readRecord", {
        ref: REF,
        startTurn: hit.turnIndex,
        charOffset: Math.max(0, hit.matchOffset - 32),
        turnCount: 1,
      });
      expect(targeted.turns[0].content).toContain(commitment);
      expect(targeted.turns[0].charOffset).toBe(hit.matchOffset - 32);
      return report("The targeted original fragment grounds the commitment.", [
        { ref: REF, turnId: "u1", role: "user", quote: commitment },
      ]);
    });
    const recovered = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(recovered).toMatchObject({ status: "ok", truncated: true });
    expect(recovered.evidence).toEqual([expect.objectContaining({ role: "user", turnId: "u1", quote: commitment })]);
    expect(raw).toContain(commitment);
  });

  it("follows next to a later whole turn beyond the 16000-character initial view", async () => {
    const turns: TimeSlice["turns"] = Array.from({ length: 5 }, (_, index) => ({
      timestamp: `2026-10-20T09:3${index}:00.000Z`,
      role: "user",
      turnId: `turn-${index}`,
      content: `turn-${index} ${"x".repeat(3_992)}`,
    }));
    const raw = serializedConversation(turns);
    const { backend, readFile } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      const initial = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(initial.next).toEqual({ startTurn: 4, charOffset: 0 });
      const continued = await execute<ReadOutput>(options, "readRecord", {
        ref: REF,
        startTurn: initial.next!.startTurn,
        charOffset: initial.next!.charOffset,
        turnCount: 1,
      });
      expect(continued.turns).toHaveLength(1);
      expect(continued.turns[0]).toMatchObject({ turnIndex: 4, turnId: "turn-4", charOffset: 0 });
      expect(continued.next).toBeNull();
      return report("The continued view grounds the fifth turn.", [
        { ref: REF, turnId: "turn-4", role: "user", quote: "turn-4" },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(result).toMatchObject({ status: "ok", truncated: true });
    expect(result.evidence).toEqual([expect.objectContaining({ turnId: "turn-4", quote: "turn-4" })]);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(raw).toContain("turn-4");
  });

  it("does not let targeted continuation bypass the global tool-call cap", async () => {
    const raw = core("x".repeat(50_000));
    const { backend, readFile } = fixture({ [PATH]: raw });
    mockModel(async (options) => {
      let cursor = { startTurn: 0, charOffset: 0 };
      for (let call = 0; call < 12; call += 1) {
        const view = await execute<ReadOutput>(options, "readRecord", { ref: REF, ...cursor, turnCount: 1 });
        expect(view.turns[0].content.length).toBeLessThanOrEqual(4_000);
        expect(view.next).not.toBeNull();
        cursor = view.next!;
      }
      const capped = await execute<ReadOutput>(options, "readRecord", { ref: REF, ...cursor, turnCount: 1 });
      expect(capped.error).toContain("Tool call cap exhausted (12)");
      return report("The worker stopped at its hard bound.", [], ["Continuation remained incomplete."]);
    });
    const result = await runScenarioRecall(inputFor(backend, { refs: [REF] }));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "insufficient_evidence", evidence: [], truncated: true });
    expect(result.uncertainty.join(" ")).toContain("Continuation remained incomplete.");
  });

  it("keeps out-of-window records out of discovered and omitted coverage", async () => {
    const { backend } = fixture({ [PATH]: core(), [OTHER_PATH]: core("Unrelated earlier conversation") });
    mockModel(async (options) => {
      const listed = await execute<ListOutput>(options, "listRecords", {});
      expect(listed).toMatchObject({ refs: [REF], total: 1, truncated: false });
      await execute<ReadOutput>(options, "readRecord", { ref: REF });
      return report("The sole in-window record was read.", [
        { ref: REF, turnId: "u1", role: "user", quote: USER_QUOTE },
      ]);
    });
    const result = await runScenarioRecall(inputFor(backend, {
      refs: [REF], after: "2026-10-20", before: "2026-10-20",
    }));
    expect(result).toMatchObject({ status: "ok", truncated: false });
    expect(result.coverage).toMatchObject({ discovered: 1, read: [REF], omitted: 0 });
  });

  it("returns an explicit error when record enumeration fails", async () => {
    const backend: RecallBackend = {
      listMemoryFiles: vi.fn(async () => { throw new Error("tree unavailable"); }),
      readFile: vi.fn(async () => core()),
    };
    mockModel(async (options) => {
      await expect(execute(options, "listRecords", {})).rejects.toThrow("tree unavailable");
      return report("A miss must not be inferred from this failure.");
    });
    const result = await runScenarioRecall(inputFor(backend));
    expect(result).toMatchObject({ status: "error", answer: "", evidence: [], truncated: true });
    expect(result.error).toContain("reads failed");
    expect(result.uncertainty.join(" ")).toContain("record enumeration: tree unavailable");
  });

  it("returns cancellation before model invocation and cancellation during a raw read", async () => {
    const { backend } = fixture({ [PATH]: core() });
    const first = new AbortController();
    first.abort();
    const cancelled = await runScenarioRecall(inputFor(backend, { signal: first.signal }));
    expect(cancelled).toMatchObject({ status: "cancelled", answer: "", evidence: [], truncated: true });
    expect(native.streamText).not.toHaveBeenCalled();

    const during = new AbortController();
    const readFile = vi.fn(async (): Promise<string> => {
      during.abort();
      return core();
    });
    mockModel(async (options) => {
      await execute<ReadOutput>(options, "readRecord", { ref: REF });
      return report("unreachable");
    });
    const interrupted = await runScenarioRecall(inputFor(
      { readFile, listMemoryFiles: vi.fn(async () => [PATH]) },
      { signal: during.signal },
    ));
    expect(interrupted).toMatchObject({ status: "cancelled", answer: "", evidence: [], truncated: true });
    expect(interrupted.error).toContain("cancelled");
  });

  it("distinguishes model timeout and original-record read failure from an honest miss", async () => {
    const { backend } = fixture({ [PATH]: core() });
    native.streamText.mockRejectedValue(new DOMException("fixture deadline", "TimeoutError"));
    const timeout = await runScenarioRecall(inputFor(backend));
    expect(timeout).toMatchObject({ status: "timeout", answer: "", evidence: [], truncated: true });
    expect(timeout.error).toContain("timed out");

    const unavailable: RecallBackend = {
      listMemoryFiles: vi.fn(async () => [PATH]),
      readFile: vi.fn(async () => { throw new Error("permission denied"); }),
    };
    mockModel(async (options) => {
      const read = await execute<ReadOutput>(options, "readRecord", { ref: REF });
      expect(read.error).toContain("permission denied");
      return report("The original record could not be read.");
    });
    const failed = await runScenarioRecall(inputFor(unavailable));
    expect(failed).toMatchObject({ status: "error", answer: "", evidence: [], truncated: true });
    expect(failed.error).toContain("reads failed");
    expect(failed.uncertainty.join(" ")).toContain("permission denied");

    mockModel(() => report("I could not recover enough original evidence for that question."));
    const miss = await runScenarioRecall(inputFor(backend));
    expect(miss).toMatchObject({ status: "insufficient_evidence", answer: "I could not recover enough original evidence for that question.", evidence: [] });
    expect(miss.status).not.toBe("ok");
  });
});
