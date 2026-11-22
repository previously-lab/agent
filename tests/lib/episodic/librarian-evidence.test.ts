import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("@/lib/deepseek/generate", async () => {
  const actual = await vi.importActual("@/lib/deepseek/generate");
  return { ...actual, streamText: ai.streamText };
});
vi.mock("@/lib/models/provider", () => ({
  createModel: vi.fn((config: unknown) => ({ _mock: config })),
}));

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failReadPath: null as string | null,
  failWrite: null as ((path: string, content: string) => boolean) | null,
}));
vi.mock("@/lib/episodic/io-helpers", () => ({
  flushBatch: vi.fn(async (batch: { entries: Map<string, string | null> }) => {
    for (const [path, content] of batch.entries) {
      if (content === null) io.files.delete(path); else io.files.set(path, content);
    }
    batch.entries.clear();
  }),
  fsReadFile: vi.fn(
    async (path: string, batch?: { entries: Map<string, string | null> }) => {
      if (io.failReadPath === path) throw new Error("injected backend read failure");
      const pending = batch?.entries.get(path);
      if (pending !== undefined) {
        if (pending === null) throw new Error(`File not found: "${path}" (deleted in this batch)`);
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
      if (io.failWrite?.(path, content)) throw new Error("injected backend write failure");
      if (batch) {
        batch.entries.set(path, content);
        return { path, created: true };
      }
      io.files.set(path, content);
      return { path, created: true };
    },
  ),
  fsListFiles: vi.fn(async (directory: string) => [...io.files.keys()]
    .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
    .map((path) => ({ path, name: path.slice(directory.length + 1), type: "file" as const }))),
}));

import {
  applyCaseWriteIntent,
  createCaseReadScope,
  makeCaseReadTool,
  makeSliceReadTool,
  readSliceEvidencePage,
  readCaseIndexForScope,
  runLibrarianPass,
} from "@/lib/episodic/flash/librarian";
import { CaseWriteRefusal, WriteRefusal } from "@/lib/docs";
import { parseCaseCurrent, caseStorageRevision, renderCaseWithCurrent, caseCurrentFreshnessWarnings } from "@/lib/docs/case-doc";
import { parseHistoryArchive } from "@/lib/docs/history-archive";
import type { ModelConfig } from "@/lib/models/registry";
import type { RunSubAgentOptions } from "@/lib/agents/sub-agent-runner";
import { encodeDialogueRecordTurn } from "@/lib/episodic/dialogue-record";
import { flushBatch } from "@/lib/episodic/io-helpers";
import { slicePartPath } from "@/lib/episodic/paths";
import { recallRead } from "@/lib/memory/facade";
import { runScenarioRecall } from "@/lib/agents/scenario-recall";
import { runAgent, zeroUsage } from "@/lib/deepseek/runner";
import { serializeTools } from "@/lib/deepseek/tools";
import type { AgentOptions } from "@/lib/deepseek/types";

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
const EXCERPT = { focus: "设备排查", summary: "长谈摘要", turnsExcerpt: "末尾八轮摘要" };

function streamWith(toolCalls: Array<{ toolName: string; input: unknown }>) {
  return {
    text: Promise.resolve(""),
    toolCalls: Promise.resolve(toolCalls),
    reasoningText: Promise.resolve(undefined),
    sources: Promise.resolve([]),
    warnings: Promise.resolve([]),
  };
}

function mockWriterRun(cases: unknown[], readRefs: string[] = []) {
  ai.streamText.mockImplementation(async (options: RunSubAgentOptions<unknown>) => {
    for (const ref of readRefs) {
      const readCase = options.tools.readCase;
      if (!readCase?.execute) throw new Error("readCase tool missing");
      await readCase.execute(
        { ref },
        { toolCallId: `read-${ref}`, messages: [], context: undefined },
      );
    }
    return streamWith([
      { toolName: "caseWriterOutput", input: { cases, reasoning: "r" } },
    ]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.files.clear();
  io.failReadPath = null;
  io.failWrite = null;
});

type SliceTool = ReturnType<typeof makeSliceReadTool>;
type SliceToolInput = Parameters<NonNullable<SliceTool["execute"]>>[0];

async function callSliceTool(tool: SliceTool, input: SliceToolInput): Promise<string> {
  if (!tool.execute) throw new Error("readSlice execute missing");
  return tool.execute(input, { toolCallId: "slice-test", messages: [], context: undefined });
}

describe("case writer user card citations", () => {
  const quote = "I replaced the failed battery today.";
  const turnId = "user-battery";
  const source = { sliceId: SLICE_ID, turnId, quote };
  const documentPath = "memory/things/battery/index.md";
  const citation = `previously:records/${SLICE_ID}?turn=${turnId}&role=user`;

  function seedUserCard(words = quote, assistantId = "assistant") {
    const meta = encodeDialogueRecordTurn({ kind: "user_input", inputId: turnId, userSeq: 1 });
    io.files.set(slicePartPath(SLICE_ID, "core"), `## Turn ${assistantId} — 2026-08-09T13:00:00Z (agent) [body-escaped v1]\n\n${words}\n\n## Turn ${turnId} — 2026-08-09T13:01:00Z (user) [dialogue ${meta}] [body-escaped v1]\n\n${words}`);
  }

  const report = { action: "open", category: "things", caseName: "battery", body: "Battery replacement confirmed.", sources: [source] };

  function mockCardWriter(cases: unknown[], index: number, caseRef?: string) {
    ai.streamText.mockImplementation(async (options: RunSubAgentOptions<unknown>) => {
      const readSlice = options.tools.readSlice;
      if (!readSlice?.execute) throw new Error("readSlice tool missing");
      await readSlice.execute({ range: { type: "turns", indices: [index] } }, {
        toolCallId: "card-source-read", messages: [], context: undefined,
      });
      if (caseRef) {
        const readCase = options.tools.readCase;
        if (!readCase?.execute) throw new Error("readCase tool missing");
        await readCase.execute({ ref: caseRef }, {
          toolCallId: "card-case-read", messages: [], context: undefined,
        });
      }
      return streamWith([{ toolName: "caseWriterOutput", input: { cases, reasoning: "r" } }]);
    });
  }

  function sourcePassages(page: string): Array<{ handle: string; turnId: string; start: number; end: number }> {
    const list = /^Verified user source passages: (\[.*\])$/m.exec(page)?.[1];
    return list ? JSON.parse(list) : [];
  }

  async function fileWithPassages(prepare: (read: (input: SliceToolInput) => Promise<string>) => Promise<unknown[]>) {
    ai.streamText.mockImplementationOnce(async (options: RunSubAgentOptions<unknown>) => {
      const read = options.tools.readSlice as SliceTool;
      const cases = await prepare((input) => callSliceTool(read, input));
      return streamWith([{ toolName: "caseWriterOutput", input: { cases, reasoning: "File the observed change." } }]);
    });
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({ model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked });
    return { batch, result, onCardLinked };
  }

  it("files different place and event accounts from one returned user passage; unissued handles cannot file", async () => {
    const words = "A bus was audible with the windows shut. Because of that I want an evening viewing.";
    seedUserCard(words, turnId);
    const corePath = slicePartPath(SLICE_ID, "core");
    const raw = io.files.get(corePath)! + "\n\n## Turn unrelated — 2026-08-09T13:02:00Z (user) [body-escaped v1]\n\nUnrelated turn.";
    io.files.set(corePath, raw);
    let handle = "";
    let excerpt = "";
    const filed = await fileWithPassages(async (read) => {
      expect(sourcePassages(await read({ range: { type: "turns", indices: [0, 2] } }))).toEqual([]);
      const range = { type: "turns" as const, indices: [1] };
      const handles = sourcePassages(await read({ range }));
      expect(handles).toHaveLength(1);
      expect(handles[0].turnId).toBe(turnId);
      handle = handles[0].handle;
      excerpt = readSliceEvidencePage(raw, { range }).content.slice(handles[0].start, handles[0].end);
      expect(excerpt.trim()).toBe(words);
      return [
        { action: "open", category: "places", caseName: "Birch House", body: "A bus could be heard through the closed windows.", sources: [handle] },
        { action: "open", category: "events", caseName: "Home search", body: "The resident wants an evening viewing because of traffic noise.", sources: [handle] },
        { ...report, sources: ["unissued-handle"] },
      ];
    });
    expect(filed.result.written).toEqual(["places/Birch House/index.md", "events/Home search/index.md"]);
    expect(filed.result.skipped.map(({ name }) => name)).toEqual(["things/battery"]);
    expect(filed.batch.entries.get("memory/places/Birch House/index.md")).toContain(citation);
    expect(filed.batch.entries.get("memory/events/Home search/index.md")).toContain(citation);
    expect(filed.onCardLinked.mock.calls).toEqual([[{ ...source, quote: excerpt }], [{ ...source, quote: excerpt }]]);

    const unread = await fileWithPassages(async () => [{ ...report, sources: [handle] }]);
    expect(unread.batch.entries.size).toBe(0);
    expect(unread.onCardLinked).not.toHaveBeenCalled();
    const changed = await fileWithPassages(async (read) => {
      const [prior] = sourcePassages(await read({ range: { type: "turns", indices: [1] } }));
      seedUserCard("The windows are open this time.", turnId);
      const [fresh] = sourcePassages(await read({ range: { type: "turns", indices: [1] } }));
      expect(fresh.handle).not.toBe(prior.handle);
      return [{ ...report, sources: [prior.handle] }];
    });
    expect(changed.batch.entries.size).toBe(0);
    expect(changed.onCardLinked).not.toHaveBeenCalled();
  });

  it("exposes only bounded, page-local passages for a long user turn", async () => {
    // Include astral characters so incorrect byte or code-point offsets cannot pass.
    seedUserCard(Array.from({ length: 800 }, (_, i) => `🟩 observation ${i}.`).join(" "));
    const raw = io.files.get(slicePartPath(SLICE_ID, "core"))!;
    const range = { type: "turns" as const, indices: [1] };
    const first = readSliceEvidencePage(raw, { range, maxChars: 512 });
    const next = { range, maxChars: 512, cursor: first.nextCursor!, revision: first.revision };
    const page = readSliceEvidencePage(raw, next);
    let excerpt = "";
    const filed = await fileWithPassages(async (read) => {
      expect(sourcePassages(await read({ range }))).toEqual([]);
      const [early] = sourcePassages(await read({ range, maxChars: 512 }));
      const [later] = sourcePassages(await read(next));
      expect(later.handle).not.toBe(early.handle);
      excerpt = page.content.slice(later.start, later.end);
      expect(excerpt).toContain("observation");
      return [{ ...report, sources: [later.handle] }];
    });
    expect(filed.result.written).toEqual(["things/battery/index.md"]);
    expect(filed.onCardLinked).toHaveBeenCalledExactlyOnceWith({ ...source, quote: excerpt });
  });

  it("queues an exact user citation in the case itself without a second file", async () => {
    seedUserCard();
    mockCardWriter([report], 1);
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({
      model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
    });
    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual(["things/battery/index.md"]);
    expect([...batch.entries.keys()]).toEqual([documentPath]);
    expect(batch.entries.get(documentPath)).toContain(citation);
    expect(batch.entries.get(documentPath)).not.toContain(quote);
    expect(onCardLinked).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("lets the native model read the original and repair a report that omitted every source", async () => {
    seedUserCard();
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const decisions = [
      { name: "caseWriterOutput", input: { cases: [{ ...report, sources: undefined }], reasoning: "Record replacement." } },
      { name: "readSlice", input: { range: { type: "turns", indices: [1] } } },
      { name: "caseWriterOutput", input: { cases: [report], reasoning: "Verified the user's original." } },
    ];
    let turn = 0;
    ai.streamText.mockImplementationOnce(async (options: AgentOptions) => {
      const result = await runAgent(options, async ({ messages }) => {
        if (turn === 1) expect(messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/source/i) });
        if (turn === 2) expect(messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining(quote) });
        const decision = decisions[turn++];
        if (!decision) throw new Error("Unexpected model invocation after the repaired report.");
        expect(batch.entries.size).toBe(0);
        const call = { id: `call-${turn}`, type: "function" as const, function: { name: decision.name, arguments: JSON.stringify(decision.input) } };
        return { message: { role: "assistant", content: null, tool_calls: [call] },
          toolCalls: [call], finishReason: "tool_calls", usage: zeroUsage() };
      });
      return streamWith(result.toolCalls);
    });
    const result = await runLibrarianPass({ model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked });
    expect(turn).toBe(decisions.length);
    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual(["things/battery/index.md"]);
    expect(batch.entries.get(documentPath)).toContain(citation);
    expect(onCardLinked).toHaveBeenCalledExactlyOnceWith(source);
  });

  it.each([
    { scope: "native-only", sourceTurnIds: [turnId], requiresSources: true },
    { scope: "native and derived", sourceTurnIds: [turnId, `${turnId}@research:fixture:1`], requiresSources: false },
  ])("advertises the filing contract for a $scope pass and accepts a genuine skip", async ({ sourceTurnIds, requiresSources }) => {
    const emptyReport = { cases: [], reasoning: "Nothing new." };
    ai.streamText.mockResolvedValueOnce(streamWith([{ toolName: "caseWriterOutput", input: emptyReport }]));
    await runLibrarianPass({ model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, sourceTurnIds, cardTurnIds: [turnId] });
    const options = ai.streamText.mock.lastCall![0] as RunSubAgentOptions<unknown>;
    const definition = options.tools.caseWriterOutput;
    const wire = serializeTools({ caseWriterOutput: definition })![0].function.parameters;
    expect(wire).toHaveProperty("properties.cases.items.properties.line.description", expect.stringContaining("appendTail"));
    const nativeAlternatives = "properties.cases.items.anyOf";
    if (requiresSources) {
      expect(wire).toHaveProperty(nativeAlternatives, expect.arrayContaining([
        { required: ["sources"] },
        { properties: { action: { const: "skip" } }, not: { required: ["currentUnderstanding"] } },
      ]));
    } else {
      expect(wire).not.toHaveProperty(nativeAlternatives);
    }
    const skip = { action: "skip", category: "things", caseName: "battery" };
    const accepted = (decision: unknown) => definition.inputSchema.safeParse({ ...emptyReport, cases: [decision] }).success;
    expect(accepted(skip)).toBe(true);
    expect(accepted({ ...skip, currentUnderstanding: { body: "Battery replaced.", evidence: [`records/${SLICE_ID}`] } })).toBe(!requiresSources);
    expect(accepted({ ...report, sources: undefined })).toBe(!requiresSources);
    expect(accepted(report)).toBe(true);
  });

  it("does not write or settle when the quote was read only from an assistant turn", async () => {
    seedUserCard();
    mockCardWriter([report], 0);
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({
      model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("not read in this pass");
    expect(batch.entries.size).toBe(0);
    expect(onCardLinked).not.toHaveBeenCalled();
  });

  it("keeps a verified native sibling when another decision lacks required content or evidence", async () => {
    seedUserCard();
    io.files.set(documentPath, "---\nopened: '2026-08-09'\n---\n\nExisting case.");
    mockCardWriter([
      { ...report, caseName: "new-battery", sources: undefined },
      { ...report, action: "skip", sources: undefined, currentUnderstanding: { body: "New view.", evidence: [`records/${SLICE_ID}`] } },
      { ...report, action: "skip", caseName: "ignored", sources: undefined },
      { ...report, action: "appendTail", body: "Wrong field for a tail." },
      { action: "appendTail", category: "things", caseName: "battery", line: "The user reports fitting the new battery.", sources: [source] },
    ], 1, "things/battery");
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({
      model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
    });
    expect(result.written).toEqual(["things/battery/index.md"]);
    expect(result.skipped).toEqual([
      { name: "things/new-battery", reason: expect.stringContaining("requires an exact user card source") },
      { name: "things/battery", reason: expect.stringContaining("requires an exact user card source") },
      { name: "things/battery", reason: expect.stringContaining("appendTail requires a line") },
    ]);
    expect([...batch.entries.keys()]).toEqual([documentPath]);
    expect(batch.entries.get(documentPath)).toContain("The user reports fitting the new battery.");
    expect(batch.entries.get(documentPath)).toContain(citation);
    expect(batch.entries.get(documentPath)).not.toContain("Wrong field for a tail.");
    expect(onCardLinked).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("retains a derived-only document's exact material receipt without citing a user card", async () => {
    seedUserCard();
    mockCardWriter([{ ...report, sources: undefined }], 1);
    const materialId = `${turnId}@research:fixture:1`;
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({
      model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [materialId], onCardLinked,
    });
    expect(result.written).toEqual(["things/battery/index.md"]);
    const receipts = [...batch.entries].filter(([path]) => path.startsWith("memory/config/document-products/"));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]![1]!)).toMatchObject({ turnIds: [materialId] });
    expect(batch.entries.get(documentPath)).not.toContain(citation);
    expect(onCardLinked).not.toHaveBeenCalled();
  });

  it("rolls back the document if its exact citation cannot be queued", async () => {
    seedUserCard();
    mockCardWriter([report], 1);
    io.failWrite = (path, content) => path === documentPath && content.includes(citation);
    const batch = { entries: new Map<string, string | null>() };
    const onCardLinked = vi.fn();
    const result = await runLibrarianPass({
      model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
      sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("injected backend write failure");
    expect(batch.entries.size).toBe(0);
    expect(onCardLinked).not.toHaveBeenCalled();
  });

  it("settles a replay of an already cited piece without replacing or duplicating it", async () => {
    seedUserCard();
    io.files.set(documentPath, "---\nopened: '2026-08-09'\n---\n\nExisting case.");
    const piece = { ...report, action: "addPiece", title: "Battery findings" };
    const file = `memory/things/battery/${DATE}-Battery findings.md`;
    mockCardWriter([piece], 1, "things/battery");
    const onCardLinked = vi.fn();
    const run = async () => {
      const batch = { entries: new Map<string, string | null>() };
      const result = await runLibrarianPass({
        model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
        sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
      });
      return { result, batch };
    };
    const first = await run();
    expect(first.result.skipped).toEqual([]);
    expect(first.batch.entries.get(file)).toContain(citation);
    expect(first.batch.entries.get(documentPath)).not.toContain(citation);
    await flushBatch(first.batch, "first piece");
    const second = await run();
    expect(second.result.skipped).toEqual([]);
    expect(second.result.written).toEqual([]);
    expect(second.batch.entries.size).toBe(0);
    expect(onCardLinked).toHaveBeenCalledTimes(2);
    expect(io.files.get(file)?.split(citation)).toHaveLength(2);
  });

  it("settles a replay of an unchanged current view without archiving the citation as a prose change", async () => {
    seedUserCard();
    const index = "---\nopened: '2026-08-09'\n---\n\nExisting case.";
    const currentPath = "memory/things/battery/_current.md";
    io.files.set(documentPath, index);
    mockCardWriter([{
      ...report, action: "reviseUnderstanding",
      currentUnderstanding: { body: "Battery confirmed working.", evidence: [`records/${SLICE_ID}`] },
    }], 1, "things/battery");
    const onCardLinked = vi.fn();
    const run = async () => {
      const batch = { entries: new Map<string, string | null>() };
      const result = await runLibrarianPass({
        model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
        sourceTurnIds: [turnId], cardTurnIds: [turnId], onCardLinked,
      });
      return { result, batch };
    };
    const first = await run();
    expect(first.result.skipped).toEqual([]);
    expect([...first.batch.entries.keys()]).toEqual([currentPath]);
    expect(first.batch.entries.get(currentPath)).toContain(citation);
    await flushBatch(first.batch, "first current view");
    const second = await run();
    expect(second.result.skipped).toEqual([]);
    expect(second.result.written).toEqual([]);
    expect(second.batch.entries.size).toBe(0);
    expect(io.files.get(documentPath)).toBe(index);
    expect(onCardLinked).toHaveBeenCalledTimes(2);
  });

  it("recalls only the case's exact user cards, including the older source after revision", async () => {
    const caseRef = "things/battery";
    const recordRef = `records/${SLICE_ID}`;
    const corePath = slicePartPath(SLICE_ID, "core");
    const secondTurnId = "user-battery-followup";
    const secondQuote = "The replacement battery is still holding a charge.";
    const unrelatedQuote = "An unrelated user message in the same slice.";
    const userTurn = (id: string, time: string, body: string) => {
      const meta = encodeDialogueRecordTurn({ kind: "user_input", inputId: id, userSeq: 1 });
      return `## Turn ${id} — 2026-08-09T${time}:00Z (user) [dialogue ${meta}] [body-escaped v1]\n\n${body}`;
    };
    io.files.set(corePath, [
      userTurn(turnId, "13:00", quote),
      userTurn("unrelated", "13:01", unrelatedQuote),
      userTurn(secondTurnId, "13:02", secondQuote),
      `## Turn ${turnId} — 2026-08-09T13:03:00Z (agent) [body-escaped v1]\n\nThe assistant's same-ID reply.`,
    ].join("\n\n"));
    const backend = {
      listMemoryFiles: vi.fn(async () => [...io.files.keys()]),
      readFile: vi.fn(async (path: string) => {
        const raw = io.files.get(path);
        if (raw === undefined) throw new Error(`File not found: ${path}`);
        return raw;
      }),
    };
    const write = async (materialId: string, index: number, op: unknown, readCase?: string) => {
      mockCardWriter([op], index, readCase);
      const batch = { entries: new Map<string, string | null>() };
      const result = await runLibrarianPass({
        model, closedSliceId: SLICE_ID, excerpt: EXCERPT, date: DATE, batch,
        sourceTurnIds: [materialId], cardTurnIds: [materialId],
      });
      expect(result.skipped).toEqual([]);
      expect(result.written).toEqual([`${caseRef}/index.md`]);
      await flushBatch(batch, "fixture");
    };
    await write(turnId, 0, report);
    const original = await recallRead(backend, { ref: caseRef });
    const originalTarget = { ref: recordRef, turnId, role: "user" };
    expect(original).toMatchObject({ kind: "content", cardTargets: [originalTarget] });
    expect(backend.readFile).not.toHaveBeenCalledWith(corePath);

    await write(secondTurnId, 2, {
      ...report, action: "updateIndex", body: "The replacement is working.",
      sources: [{ sliceId: SLICE_ID, turnId: secondTurnId, quote: secondQuote }],
    }, caseRef);
    const revised = await recallRead(backend, { ref: caseRef });
    if (revised.kind !== "content") throw new Error("Revised case was not readable");
    expect(revised.content).toContain("The replacement is working.");
    expect(revised.content).not.toContain("Battery replacement confirmed.");
    expect([...io.files.keys()].sort()).toEqual([documentPath, corePath].sort());
    expect(revised.cardTargets).toHaveLength(2);
    expect(revised.cardTargets).toEqual(expect.arrayContaining([
      originalTarget, { ref: recordRef, turnId: secondTurnId, role: "user" },
    ]));
    expect(backend.readFile).not.toHaveBeenCalledWith(corePath);

    ai.streamText.mockClear();
    backend.readFile.mockClear();
    backend.listMemoryFiles.mockClear();
    const exact = await runScenarioRecall({
      backend, targets: revised.cardTargets, question: "What did the user say about the battery?",
    });
    expect(exact.status).toBe("ok");
    expect(exact.evidence).toHaveLength(2);
    expect(exact.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...originalTarget, quote }),
      expect.objectContaining({ ref: recordRef, turnId: secondTurnId, role: "user", quote: secondQuote }),
    ]));
    expect(JSON.stringify(exact)).not.toContain(unrelatedQuote);
    expect(JSON.stringify(exact)).not.toContain("The assistant's same-ID reply.");
    expect(backend.readFile).toHaveBeenCalledExactlyOnceWith(corePath);
    expect(backend.listMemoryFiles).not.toHaveBeenCalled();
    expect(ai.streamText).not.toHaveBeenCalled();
  });
});

describe("original slice evidence", () => {
  it("carries source role/id/time when a page starts inside an assistant suggestion", async () => {
    const raw = `---\nsummary: User approved (metadata only)\n---\n## Turn a — 2026-08-09T13:00:00Z (agent)\n\n${"Proposal. ".repeat(80)}\n## Turn u — 2026-08-09T13:01:00Z (user)\n\nNo, I reject that.`;
    const first = readSliceEvidencePage(raw, { maxChars: 120 });
    const cursor = first.nextCursor!;
    const page = readSliceEvidencePage(raw, { cursor, revision: first.revision, maxChars: 120 });
    expect(page.content).not.toContain("## Turn");
    expect(page.attribution).toEqual([{ role: "assistant", turnId: "a", turnIndex: 0, timestamp: "2026-08-09T13:00:00Z", start: 0, end: 120 }]);
    const output = await callSliceTool(makeSliceReadTool({ sliceId: SLICE_ID, reader: async () => raw }), { cursor, revision: first.revision, maxChars: 120 });
    expect(output).toContain(`Source ref: records/${SLICE_ID}`);
    expect(output).toContain(JSON.stringify(page.attribution));
    expect(readSliceEvidencePage(raw, { maxChars: 30 }).attribution).toEqual([]);
  });

  it("invalid, empty, and failed pages do not authorize evidence", async () => {
    const raw = "---\n---\n\n## Turn x — 2026-08-09T13:00:00.000Z (user)\n\n真正的原话。\n";
    for (const input of [{ cursor: 999999 }, { maxChars: 2 }, { range: { type: "turns" as const, indices: [999] } }]) {
      const scope = createCaseReadScope();
      const output = await callSliceTool(makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => raw }), input);
      expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(false);
      expect(output).not.toContain("真正的原话");
    }
    const scope = createCaseReadScope();
    await callSliceTool(makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => { throw new Error("offline"); } }), {});
    expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(false);
  });

  it("binds a continuation to exact source bytes and records real coverage", async () => {
    let raw = `---\n---\n\n## Turn x — 2026-08-09T13:00:00.000Z (user)\n\n${"事实".repeat(200)}\n`;
    const scope = createCaseReadScope();
    const tool = makeSliceReadTool({ sliceId: SLICE_ID, scope, reader: async () => raw });
    const first = await callSliceTool(tool, { maxChars: 80 });
    const revision = /Source revision: ([0-9a-f]{64})/.exec(first)![1];
    const cursor = Number(/cursor=(\d+)/.exec(first)![1]);
    const proofs = scope.getEvidenceReads(`records/${SLICE_ID}`);
    expect(proofs).toMatchObject([{ revision, coverage: "range", start: 0, end: 80 }]);
    raw += "新增的用户更正。";
    const invalid = await callSliceTool(tool, { cursor, revision, maxChars: 80 });
    expect(invalid).toContain("source revision changed");
    expect(scope.getEvidenceReads(`records/${SLICE_ID}`)).toEqual(proofs);
  });

  it("makes early and long-message turning points readable with explicit continuation", async () => {
    const corePath = "memory/records/2026/08/09/1300/core.md";
    let raw = "---\nfocus: 长谈\n---\n";
    for (let i = 0; i < 12; i += 1) {
      const role = i === 10 ? "agent" : i % 2 === 0 ? "user" : "agent";
      const content = i === 0
        ? "早期转折：用户先排除了方案甲。"
        : i === 10
          ? `长消息开始 ${"证据".repeat(260)}\n\`\`\`html live\n<button>generated payload</button>\n\`\`\`\n长消息结尾：用户最终改选方案丙。`
          : `普通第 ${i} 轮`;
      raw += `\n## Turn t${i} — 2026-08-09T13:${String(i).padStart(2, "0")}:00.000Z (${role})\n\n${content}\n`;
    }
    io.files.set(corePath, raw);
    const scope = createCaseReadScope();
    const readSlice = makeSliceReadTool({ sliceId: SLICE_ID, scope });
    const pages: string[] = [];
    let cursor: number | undefined;
    let revision: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const output = await callSliceTool(readSlice, {
        range: { type: "turns", indices: [0, 10] },
        maxChars: 256,
        ...(cursor === undefined ? {} : { cursor }),
        ...(revision === undefined ? {} : { revision }),
      });
      pages.push(output);
      revision = /Source revision: ([0-9a-f]{64})/.exec(output)?.[1];
      const next = /cursor=(\d+)/.exec(output);
      cursor = next ? Number(next[1]) : undefined;
      if (cursor === undefined) break;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toContain("INCOMPLETE");
    expect(pages.at(-1)).toContain("COMPLETE");
    const all = pages.join("\n");
    expect(all).toContain("早期转折：用户先排除了方案甲");
    expect(all).toContain("长消息结尾：用户最终改选方案丙");
    expect(all).toContain("Interactive visual omitted");
    expect(all).not.toContain("generated payload");
    expect(scope.hasEvidence(`records/${SLICE_ID}`)).toBe(true);
    expect(io.files.get(corePath)).toBe(raw);
  });
});

describe("read-proof and collision guards", () => {
  it("keeps version receipts compact and detects equal-timestamp edits", async () => {
    const path = "memory/research/大案/index.md";
    io.files.set(path, `---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n${"长文".repeat(30000)}`);
    const scope = createCaseReadScope();
    const read = await readCaseIndexForScope({ category: "research", caseName: "大案", scope });
    expect(read.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(read.revision).toBe(caseStorageRevision(read.content));
    io.files.set(path, read.content + "新事实");
    await expect(applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: "大案", line: "基于旧读" }, DATE, undefined, scope))
      .rejects.toMatchObject({ code: "rewrite_conflict" });
  });

  it("does not reopen a settled body after a tail or legacy recent activity", async () => {
    for (const name of ["历史正文", "旧版尾注"]) {
      const path = `memory/research/${name}/index.md`;
      const updated = name === "旧版尾注" ? new Date().toISOString() : "2026-08-01T00:00:00Z";
      io.files.set(path, `---\nopened: '2026-08-01'\nupdated: '${updated}'\n---\n旧正文。\n\n—— 尾部 ——\n2026-08-09：旧补充。\n`);
      await applyCaseWriteIntent({ action: "appendTail", category: "research", caseName: name, line: "新补充" }, DATE);
      await expect(applyCaseWriteIntent({ action: "rewriteIndex", category: "research", caseName: name, body: "覆盖旧正文" }, DATE))
        .rejects.toMatchObject({ code: "rewrite_window_closed" });
      expect(io.files.get(path)).toContain("旧正文");
      expect(io.files.get(path)).not.toContain("覆盖旧正文");
    }
  });

  it("detects current-only concurrent edits and new case pieces", async () => {
    const indexPath = "memory/things/并发认识/index.md";
    const currentPath = "memory/things/并发认识/_current.md";
    io.files.set(indexPath, "---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n历史原文。\n");
    for (const change of ["current", "piece"]) {
      const scope = createCaseReadScope();
      await readCaseIndexForScope({ category: "things", caseName: "并发认识", scope });
      if (change === "current") io.files.set(currentPath, "他人先写的新认识。");
      else io.files.set("memory/things/并发认识/2026-08-09-新材料.md", "新材料");
      await expect(applyCaseWriteIntent({ action: "reviseUnderstanding", category: "things", caseName: "并发认识", body: "我的旧草稿", evidence: ["things/并发认识"] }, DATE, undefined, scope))
        .rejects.toMatchObject({ code: "rewrite_conflict" });
    }
  });

  it("writes actual basis and renders compact current prose before preserved history", async () => {
    const path = "memory/research/当前案/index.md";
    const historical = "---\nopened: '2026-08-01'\nupdated: '2026-08-01'\n---\n历史认识。\n";
    io.files.set(path, historical);
    io.files.set("memory/research/当前案/2026-08-08-旧材料.md", "材料原文");
    const scope = createCaseReadScope();
    const read = await readCaseIndexForScope({ category: "research", caseName: "当前案", scope });
    await applyCaseWriteIntent({ action: "reviseUnderstanding", category: "research", caseName: "当前案", body: "当前解释仍有两种可能。", evidence: ["research/当前案"] }, DATE, undefined, scope);
    const current = parseCaseCurrent(io.files.get("memory/research/当前案/_current.md")!);
    expect(current.basis?.indexRevision).toBe(read.revision);
    expect(current.basis?.pieces).toEqual([{ path: "memory/research/当前案/2026-08-08-旧材料.md", revision: null }]);
    expect(io.files.get(path)).toBe(historical);
    const rendered = renderCaseWithCurrent(historical, io.files.get("memory/research/当前案/_current.md")!);
    expect(rendered.indexOf("当前解释")).toBeLessThan(rendered.indexOf("历史认识"));
    expect(caseCurrentFreshnessWarnings(current, { indexRevision: read.revision, pieces: [] })).toContain("the case piece inventory changed after the current view's basis");
  });

  it("refuses a write after the successfully read index changes", async () => {
    const path = "memory/research/并发案/index.md";
    const original = `---\nopened: '2026-08-09'\nupdated: '${new Date().toISOString()}'\n---\n\n读前正文。\n`;
    io.files.set(path, original);
    const scope = createCaseReadScope();
    const readCase = makeCaseReadTool(undefined, scope);
    await readCase.execute!(
      { ref: "research/并发案" },
      { toolCallId: "case-read", messages: [], context: undefined },
    );
    io.files.set(path, original.replace("读前正文", "并发后的正文"));
    const refusal = await applyCaseWriteIntent(
      { action: "appendTail", category: "research", caseName: "并发案", line: "基于旧读的补充" },
      DATE,
      undefined,
      scope,
    ).catch((error) => error);
    expect(refusal).toBeInstanceOf(CaseWriteRefusal);
    expect(refusal.code).toBe("rewrite_conflict");
    expect(refusal.message).toContain("readCase");
    expect(io.files.get(path)).toContain("并发后的正文");
    expect(io.files.get(path)).not.toContain("基于旧读的补充");
  });

  it("same-piece retry noops, but same-date/title different text is refused", async () => {
    await applyCaseWriteIntent(
      { action: "open", category: "research", caseName: "碰撞案", body: "正文" },
      DATE,
    );
    const intent = {
      action: "addPiece" as const,
      category: "research" as const,
      caseName: "碰撞案",
      title: "报价篇",
      body: "原始篇文",
    };
    const first = await applyCaseWriteIntent(intent, DATE);
    const retry = await applyCaseWriteIntent(intent, DATE);
    expect(first.created).toBe(true);
    expect(retry.noop).toBe(true);
    const collision = await applyCaseWriteIntent(
      { ...intent, body: "不同的篇文" },
      DATE,
    ).catch((error) => error);
    expect(collision).toBeInstanceOf(WriteRefusal);
    expect(collision.code).toBe("already_exists");
    expect(io.files.get(first.path)).toContain("原始篇文");
    expect(io.files.get(first.path)).not.toContain("不同的篇文");
  });

  it("does not mistake an index read failure for absence when opening", async () => {
    const path = "memory/research/读失败案/index.md";
    io.failReadPath = path;
    await expect(
      applyCaseWriteIntent(
        { action: "open", category: "research", caseName: "读失败案", body: "不应落盘" },
        DATE,
      ),
    ).rejects.toThrow("injected backend read failure");
    expect(io.files.has(path)).toBe(false);
  });
});

describe("worker currentUnderstanding reports", () => {
  it("keeps the frozen index byte-identical and archives a non-user view with counterevidence", async () => {
    const indexPath = "memory/things/老设备/index.md";
    const currentPath = "memory/things/老设备/_current.md";
    const historical = "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n冻结历史：曾判断电池故障。\n";
    io.files.set(indexPath, historical);
    const manifest = { truncated: false, tree: { things: ["things/老设备/index.md"] } };
    mockWriterRun(
      [
        {
          action: "skip",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "初步解释：可能是电池故障；尚未外部验证。",
            evidence: ["things/老设备"],
          },
        },
      ],
      ["things/老设备"],
    );
    const firstResult = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest,
      date: DATE,
    });
    expect(firstResult.written).toEqual(["things/老设备/_current.md"]);
    expect(io.files.get(indexPath)).toBe(historical);

    mockWriterRun(
      [
        {
          action: "reviseUnderstanding",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "后续记录是反证。当前有两种解释：充电线接触不良或电源管理设置；仍属解释，不是外部验证。",
            evidence: ["things/老设备"],
          },
        },
      ],
      ["things/老设备"],
    );
    const secondResult = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest,
      date: DATE,
    });
    expect(secondResult.written).toEqual(["things/老设备/_current.md"]);
    expect(secondResult.skipped).toEqual([]);
    const current = parseCaseCurrent(io.files.get(currentPath)!);
    expect(current.body).toContain("后续记录是反证");
    expect(current.body).toContain("两种解释");
    expect(current.history).toBe("");
    const archive = parseHistoryArchive(io.files.get(`memory/${current.historyHead}.md`)!);
    expect(archive?.payload).toContain("初步解释：可能是电池故障");
    expect(archive?.metadata.kind).toBe("current-revision");
    expect(current.evidence).toEqual(["things/老设备"]);
    expect(current.asOf).toBe(DATE);
    expect(io.files.get(indexPath)).toBe(historical);
  });

  it("rejects an evidence ref the worker never actually read", async () => {
    io.files.set(
      "memory/things/老设备/index.md",
      "---\nopened: '2026-08-01'\nupdated: '2026-08-01T00:00:00.000Z'\n---\n\n冻结历史。\n",
    );
    mockWriterRun(
      [
        {
          action: "reviseUnderstanding",
          category: "things",
          caseName: "老设备",
          currentUnderstanding: {
            body: "把未读记录当作证据。",
            evidence: [`records/${SLICE_ID}`],
          },
        },
      ],
      ["things/老设备"],
    );
    const result = await runLibrarianPass({
      model,
      closedSliceId: SLICE_ID,
      excerpt: EXCERPT,
      manifest: { truncated: false, tree: { things: ["things/老设备/index.md"] } },
      date: DATE,
    });
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("unread or invalid evidence");
    expect(io.files.has("memory/things/老设备/_current.md")).toBe(false);
  });
});
