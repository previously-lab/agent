/**
 * runCardEvolution — the inline card-evolution step's write-back rules
 * (v0.19 R4/R5). The contract that matters: a FAILED agent errors and writes
 * nothing; a PARTIAL pass (step limit without finish) is written back like
 * any other result with the note flagged; a no-change pass writes nothing.
 * Writes land on the folded people/user/index.md (card / direction halves)
 * and self/ SOPs; the per-slice previously.md snapshot freezes the FULL
 * index.md, only when something moved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCardEvolution } from "@/app/api/evolution/run-card-evolution";
import { runPreviouslyAgent } from "@/lib/episodic/flash/previously-agent";
import { writePreviously } from "@/lib/episodic";
import {
  readUserModel,
  readUserProfile,
  writeUserModelCard,
  writeUserModelDirection,
  writeSelfSop,
  composeUserModel,
} from "@/lib/evolution/store";
import {
  newCardTemplate,
  serializeCard,
} from "@/lib/episodic/previously-format";
import type { ModelConfig } from "@/lib/models/registry";

vi.mock("@/lib/episodic/flash/previously-agent", () => ({
  runPreviouslyAgent: vi.fn(),
}));
vi.mock("@/lib/episodic", () => ({
  writePreviously: vi.fn(),
}));
// The evolution store boundary (people/user/index.md + self/ writes) is
// mocked so the tests stay hermetic — the real module would read/write
// memory/ on the local fs.
vi.mock("@/lib/evolution/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/evolution/store")>();
  return {
    ...actual,
    readUserModel: vi.fn(),
    readUserProfile: vi.fn(async () => null),
    writeUserModelCard: vi.fn(async () => {}),
    writeUserModelDirection: vi.fn(async () => {}),
    writeSelfSop: vi.fn(async () => {}),
  };
});

const runPreviouslyAgentMock = vi.mocked(runPreviouslyAgent);
const readModelMock = vi.mocked(readUserModel);
const writeCardMock = vi.mocked(writeUserModelCard);
const writeDirectionMock = vi.mocked(writeUserModelDirection);
const writeSopMock = vi.mocked(writeSelfSop);
const writeSliceMock = vi.mocked(writePreviously);

const MODEL = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  provider: "deepseek",
  providerName: "DeepSeek",
  sdk: "deepseek",
  envKey: "DEEPSEEK_API_KEY",
  capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: false,
  defaultEffort: "low",
} satisfies ModelConfig;

const SLICE = "2026-08-17-0515";
const BASE = newCardTemplate(SLICE);
const CHANGED = serializeCard({
  sliceId: SLICE,
  updated: "2026-08-17T06:00:00.000Z",
  identity: [],
  past: { profile: "", anchors: [] },
  now: [{ text: "prepping the friday interview", refs: ["2026/08/17/0515"], since: "2026-08-17" }],
  horizon: [],
  selfModel: [],
});

function baseInput() {
  return {
    model: MODEL,
    sliceId: SLICE,
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    readers: {
      readSlice: async () => "(none)",
      readAgentTimeline: async () => "(none)",
      readPreviously: async () => "(none)",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The folded model: card half = BASE, no direction half.
  readModelMock.mockResolvedValue({ card: BASE, direction: null, full: BASE });
});

describe("write-back rules", () => {
  it("a PARTIAL pass is written back with the note flagged, not treated as an error", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: CHANGED,
      reasoning: "step limit reached without finish",
      summary: "记下了你周五的面试",
      mutations: ["addNow: prepping the friday interview"],
      partial: true,
    });
    const res = await runCardEvolution(baseInput());
    expect(res.ran).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.note).toMatch(/^\[partial\] /);
    expect(res.note).toContain("step limit reached without finish");
    expect(res.partial).toBe(true);
    expect(writeCardMock).toHaveBeenCalledWith(CHANGED, undefined);
    // The snapshot freezes the FULL folded index.md, not just the card.
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, BASE, undefined);
    expect(res.summary).toBe("记下了你周五的面试");
  });

  it("a FAILED agent errors and writes nothing", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: "",
      reasoning: "Previously Agent worker unavailable",
      summary: "",
      mutations: [],
      failed: true,
    });
    const res = await runCardEvolution(baseInput());
    expect(res.ran).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.error).toBe("Previously Agent worker unavailable");
    expect(writeCardMock).not.toHaveBeenCalled();
    expect(writeSliceMock).not.toHaveBeenCalled();
  });

  it("a no-change pass writes nothing (stamps are ignored) — no card write, no snapshot", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.changed).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.note).toBe("nothing new"); // no [partial] flag on a clean pass
    expect(res.partial).toBeUndefined();
    expect(writeCardMock).not.toHaveBeenCalled();
    expect(writeSliceMock).not.toHaveBeenCalled();
  });

  it("forwards onEvolutionLine to the Previously Agent's onLine (live thinking)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const onEvolutionLine = vi.fn();
    await runCardEvolution({ ...baseInput(), onEvolutionLine });
    expect(runPreviouslyAgentMock.mock.calls[0][0].onLine).toBe(onEvolutionLine);
  });

  it("applies SOP writes through writeSelfSop and surfaces them as playbooks (v0.19 §C.2)", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "search keeps guessing",
      summary: "",
      mutations: [],
      sopWrites: [
        {
          agent: "search" as const,
          content: "Quote the records slice id before answering.",
          evidence: ["2026-08-17-0515"],
          expectedBenefit: "fewer ungrounded answers",
        },
      ],
    });
    const res = await runCardEvolution(baseInput());
    expect(writeSopMock).toHaveBeenCalledWith(
      "search",
      "Quote the records slice id before answering.",
      undefined,
    );
    expect(res.playbooks).toEqual([
      { agent: "search", summary: "fewer ungrounded answers" },
    ]);
  });

  it("omits the playbooks field when no SOP mutation landed", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.playbooks).toBeUndefined();
    expect(writeSopMock).not.toHaveBeenCalled();
  });

  it("writes a changed card to the folded model and snapshots the FULL index.md", async () => {
    // After the card write the folded model reads back with the direction
    // half carried — the snapshot must freeze the WHOLE document (§B.7).
    const FULL = composeUserModel(CHANGED, "# Direction\n\nKeep me.");
    readModelMock
      .mockResolvedValueOnce({ card: BASE, direction: null, full: BASE })
      .mockResolvedValueOnce({
        card: CHANGED,
        direction: "# Direction\n\nKeep me.",
        full: FULL,
      });
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: CHANGED,
      reasoning: "folded new identity fact",
      summary: "identity updated",
      mutations: ["addNow: prepping the friday interview"],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.changed).toBe(true);
    expect(writeCardMock).toHaveBeenCalledWith(CHANGED, undefined);
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, FULL, undefined);
  });
});

describe("the merged direction half (v1.1)", () => {
  const VALID_DIRECTION = [
    "# Portrait",
    "",
    "## Traits & cognitive style",
    "",
    "- The user prefers concrete, evidence-anchored answers. — refs: 2026-08-20-1430, 2026-08-22-1015",
    "",
    "## Triggers & rhythms",
    "",
    "## Patterns & loops",
    "",
    "## Strengths & resilience",
    "",
    "## Communication preferences",
    "",
    "## Values & boundaries",
    "",
    "# Hypotheses",
    "",
    "- [proposed 2026-08-22-1015] The user may prefer terse replies under time pressure — falsify if: the user asks for more detail when rushed",
  ].join("\n");

  function directionEvalInput() {
    return {
      current: null,
      mode: "steady" as const,
      cardSelfModel: null,
      analysis: {
        messageTags: { reuse: [], create: [] },
        semanticHint: { strands: [], reason: "" },
        memoryWorthy: false,
        emotionalSignal: { intensity: "none" as const, register: "neutral" as const, note: "" },
      },
    };
  }

  function agentResultWithProposal(doc: string) {
    return {
      updatedCard: BASE,
      reasoning: "direction moved",
      summary: "",
      mutations: [],
      direction: {
        doc,
        summary: "First direction: concreteness",
      },
    };
  }

  it("a valid proposal is written through writeUserModelDirection", async () => {
    runPreviouslyAgentMock.mockResolvedValue(agentResultWithProposal(VALID_DIRECTION));
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({
      outcome: "updated",
      summary: "First direction: concreteness",
    });
    expect(writeDirectionMock).toHaveBeenCalledWith(VALID_DIRECTION, undefined);
    // The direction move alone triggers the full-model snapshot.
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, BASE, undefined);
  });

  it("a REJECTED proposal reports outcome rejected with the reason (never a fake no_change) and writes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runPreviouslyAgentMock.mockResolvedValue(
      agentResultWithProposal("# Portrait\n\nNo skeleton, no evidence."),
    );
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction?.outcome).toBe("rejected");
    expect(res.direction?.summary).toBeTruthy(); // the validation reason
    expect(writeDirectionMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no proposal on finish → direction outcome no_change", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "direction holds",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({ outcome: "no_change" });
    expect(writeDirectionMock).not.toHaveBeenCalled();
  });

  it("the inline run's hypothesis TTL cannot retire: the retired timeline catalog leaves only the current slice id (v0.19 degradation, A2 owns the richer trail)", async () => {
    const current = `${VALID_DIRECTION}\n- [proposed 2026-08-11-0900] The user may prefer voice notes — falsify if: never used`;
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "direction holds",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution({
      ...baseInput(),
      directionEval: { ...directionEvalInput(), current },
    });
    // Only [input.sliceId] is newer than the proposed pointer — below the
    // TTL of 4 — so the expired guess survives the inline run untouched.
    expect(res.direction?.outcome).toBe("no_change");
    expect(writeDirectionMock).not.toHaveBeenCalled();
  });

  it("a write failure surfaces outcome failed — never masquerading as no_change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeDirectionMock.mockRejectedValueOnce(new Error("disk full"));
    runPreviouslyAgentMock.mockResolvedValue(agentResultWithProposal(VALID_DIRECTION));
    const res = await runCardEvolution({ ...baseInput(), directionEval: directionEvalInput() });
    expect(res.direction).toEqual({ outcome: "failed", summary: "disk full" });
    warn.mockRestore();
  });

  it("no directionEval (explicit-request path) → no direction verdict on the result", async () => {
    runPreviouslyAgentMock.mockResolvedValue({
      updatedCard: BASE,
      reasoning: "nothing new",
      summary: "",
      mutations: [],
    });
    const res = await runCardEvolution(baseInput());
    expect(res.direction).toBeUndefined();
    expect(writeDirectionMock).not.toHaveBeenCalled();
  });
});
