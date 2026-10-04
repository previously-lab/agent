/**
 * previously-agent — the Previously Agent on the shared sub-agent runner.
 * The contract that matters: a clean finish returns the evolved card; a pass
 * that exhausts its steps WITHOUT finish returns a PARTIAL card (mutations
 * kept) instead of failing; only a hard failure retries (once, at a higher
 * temperature that breaks deterministic re-submission loops) and then fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runPreviouslyAgent,
  type PreviouslyAgentInput,
} from "@/lib/episodic/flash/previously-agent";
import { runSubAgent } from "@/lib/agents/sub-agent-runner";
import {
  newCardTemplate,
  parseCard,
  CARD_PROFILE_MAX_CHARS,
} from "@/lib/episodic/previously-format";
import type { ModelConfig } from "@/lib/models/registry";

vi.mock("@/lib/agents/sub-agent-runner", () => ({ runSubAgent: vi.fn() }));

const runSubAgentMock = vi.mocked(runSubAgent);

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

type RunnerOpts = Parameters<typeof runSubAgent>[0];

async function callTool(opts: RunnerOpts, name: string, args: unknown): Promise<string> {
  const t = opts.tools[name] as unknown as {
    execute: (a: unknown, o: unknown) => Promise<string>;
  };
  return t.execute(args, { toolCallId: "test", messages: [] });
}

function baseInput(overrides: Partial<PreviouslyAgentInput> = {}): PreviouslyAgentInput {
  return {
    signal: "new_observation",
    note: "Auto-review of latest conversation.",
    model: MODEL,
    currentSliceId: SLICE,
    previouslyContent: newCardTemplate(SLICE),
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    todayLocal: "2026-08-17",
    readSliceFn: async () => "(none)",
    readAgentTimelineFn: async () => "(none)",
    readPreviouslyFn: async () => "(none)",
    ...overrides,
  };
}

beforeEach(() => {
  runSubAgentMock.mockReset();
});

describe("runner wiring", () => {
  it("runs on the shared runner: static system, dynamic user prompt, finish as the report tool", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing new", summary: "" },
      text: "",
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBeFalsy();
    expect(out.reasoning).toBe("nothing new");

    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.model).toBe(MODEL);
    expect(opts.maxSteps).toBe(50);
    expect(opts.timeoutMs).toBe(240_000);
    expect(opts.effort).toBe("low");
    expect(opts.temperature).toBe(0.1);
    expect(opts.reportToolName).toBe("finish");
    // Static system carries the role instructions; dynamic content is in the
    // user prompt only.
    expect(opts.system).toContain("Previously Agent");
    expect(opts.system).not.toContain("## Time context");
    expect(opts.prompt).toContain("## Time context");
    expect(opts.prompt).toContain("## Current card");
    expect(opts.prompt).toContain("我周五有个面试");
  });

  it("forwards the onLine live-line callback straight to the runner", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing new", summary: "" },
      text: "",
    });
    const onLine = vi.fn();
    await runPreviouslyAgent(baseInput({ onLine }));
    expect(runSubAgentMock.mock.calls[0][0].onLine).toBe(onLine);
  });

  it("a clean finish returns the serialized card", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addNow", { text: "prepping the friday interview", refs: [SLICE] });
      return { ok: true, report: { reasoning: "added a hook", summary: "记下了面试" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.partial).toBeFalsy();
    expect(out.summary).toBe("记下了面试");
    expect(parseCard(out.updatedCard)?.now[0]?.text).toBe("prepping the friday interview");
    expect(out.mutations.some((m) => m.startsWith("addNow:"))).toBe(true);
  });
});

describe("partial output — step limit without finish", () => {
  it("returns a PARTIAL card with the mutations that landed, not failed + empty", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addNow", { text: "prepping the friday interview", refs: [SLICE] });
      // …then burns the remaining steps and never calls finish.
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBe(true);
    expect(out.reasoning).toContain("step limit reached without finish");
    expect(parseCard(out.updatedCard)?.now[0]?.text).toBe("prepping the friday interview");
    // A partial pass is a result, not a failure — no retry.
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
  });

  it("the original bug: looping on the same over-long profile force-lands within 3 tries and still returns a partial card", async () => {
    const long = "p".repeat(CARD_PROFILE_MAX_CHARS + 200);
    const toolResults: string[] = [];
    runSubAgentMock.mockImplementation(async (opts) => {
      // The model resubmits the SAME over-limit profile until the step cap.
      for (let i = 0; i < 6; i++)
        toolResults.push(await callTool(opts, "updatePastProfile", { text: long }));
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(toolResults[0]).toContain("REJECTED");
    expect(toolResults[1]).toContain("LOOP BRAKE");
    expect(toolResults[2]).toMatch(/^OK — FORCED/); // 3rd: truncated + applied
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBe(true);
    expect(parseCard(out.updatedCard)?.past.profile).toHaveLength(CARD_PROFILE_MAX_CHARS);
    expect(out.mutations.some((m) => m.startsWith("forced:"))).toBe(true);
  });
});

describe("retry on hard failure", () => {
  it("retries once at temperature 0.4 when the first attempt fails", async () => {
    runSubAgentMock
      .mockResolvedValueOnce({ ok: false, error: "model unreachable", text: "" })
      .mockResolvedValueOnce({
        ok: true,
        report: { reasoning: "recovered", summary: "" },
        text: "",
      });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.reasoning).toBe("recovered");
    expect(runSubAgentMock).toHaveBeenCalledTimes(2);
    expect(runSubAgentMock.mock.calls[0][0].temperature).toBe(0.1);
    expect(runSubAgentMock.mock.calls[1][0].temperature).toBe(0.4);
  });

  it("fails with an empty card when both attempts fail", async () => {
    runSubAgentMock.mockResolvedValue({ ok: false, error: "boom", text: "" });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBe(true);
    expect(out.updatedCard).toBe("");
    expect(runSubAgentMock).toHaveBeenCalledTimes(2);
  });
});

describe("writeSop — the v0.19 SOP mutation gate (§C.2)", () => {
  it("REJECTS every SOP write when no colleague is allowlisted (the explicit-request path)", async () => {
    let rejection = "";
    runSubAgentMock.mockImplementation(async (opts) => {
      rejection = await callTool(opts, "writeSop", {
        agent: "search",
        content: "Quote the slice id before answering.",
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "fewer ungrounded answers",
      });
      return { ok: true, report: { reasoning: "tried", summary: "" }, text: "" };
    });
    // allowedSopWrites absent entirely — the explicit memory_update channel.
    const out = await runPreviouslyAgent(baseInput());
    expect(rejection).toContain("REJECTED");
    expect(rejection).toContain("not writable this run");
    expect(out.sopWrites).toBeUndefined();
  });

  it("ACCEPTS a write for an allowlisted colleague and stages the FULL text (no cap) for the caller", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const ok = await callTool(opts, "writeSop", {
        agent: "search",
        content: "Quote the slice id before answering.",
        evidence: ["2026-08-20-1430", ""],
        expectedBenefit: "fewer ungrounded answers",
      });
      expect(ok).toContain("OK");
      return { ok: true, report: { reasoning: "done", summary: "", expectedBenefit: "fewer ungrounded answers" }, text: "" };
    });
    const out = await runPreviouslyAgent(
      baseInput({ allowedSopWrites: ["search"] }),
    );
    expect(out.sopWrites).toEqual([
      {
        agent: "search",
        content: "Quote the slice id before answering.",
        evidence: ["2026-08-20-1430"], // blank evidence entries dropped
        expectedBenefit: "fewer ungrounded answers",
      },
    ]);
    expect(out.expectedBenefit).toBe("fewer ungrounded answers");
  });

  it("the writeSop schema no longer offers the retired recall colleague", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      const t = opts.tools.writeSop as unknown as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      };
      expect(
        t.inputSchema.safeParse({
          agent: "recall",
          content: "x",
          evidence: [],
          expectedBenefit: "y",
        }).success,
      ).toBe(false);
      return { ok: true, report: { reasoning: "t", summary: "" }, text: "" };
    });
    await runPreviouslyAgent(baseInput({ allowedSopWrites: ["search", "thinkdeep"] }));
  });

  it("rejects a write for a colleague NOT allowlisted this run", async () => {
    let rejection = "";
    runSubAgentMock.mockImplementation(async (opts) => {
      rejection = await callTool(opts, "writeSop", {
        agent: "thinkdeep",
        content: "x",
        evidence: [],
        expectedBenefit: "y",
      });
      return { ok: true, report: { reasoning: "t", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({ allowedSopWrites: ["search"] }));
    expect(rejection).toContain("REJECTED");
    expect(out.sopWrites).toBeUndefined();
  });

  it("a rewrite within one pass REPLACES the earlier staged draft", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "writeSop", {
        agent: "search",
        content: "first draft",
        evidence: [],
        expectedBenefit: "a",
      });
      await callTool(opts, "writeSop", {
        agent: "search",
        content: "second draft",
        evidence: [],
        expectedBenefit: "b",
      });
      return { ok: true, report: { reasoning: "t", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({ allowedSopWrites: ["search"] }));
    expect(out.sopWrites).toHaveLength(1);
    expect(out.sopWrites![0].content).toBe("second draft");
  });

  it("the direction, SOP-allowlist and self-description context land in the USER prompt, never the system prompt", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing", summary: "" },
      text: "",
    });
    await runPreviouslyAgent(
      baseInput({
        direction: "# Direction\n\nKeep answers concrete.",
        allowedSopWrites: ["search"],
        userProfile: "我是设计师，回答请简短。",
      }),
    );
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.prompt).toContain("## Evolution direction");
    expect(opts.prompt).toContain("Keep answers concrete.");
    expect(opts.prompt).toContain("## self/ SOPs writable this run");
    expect(opts.prompt).toContain("search");
    // The retired recall colleague is advertised nowhere (review M7).
    expect(opts.system).not.toContain("recall / search / thinkdeep");
    expect(opts.prompt).toContain("## User's self-description");
    expect(opts.prompt).toContain("我是设计师，回答请简短。");
    expect(opts.system).not.toContain("SOPs writable this run");
    expect(opts.system).not.toContain("Keep answers concrete.");
    expect(opts.system).not.toContain("我是设计师");
  });

  it("the writer's prompt carries the length discipline and the self-description-wins rule", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing", summary: "" },
      text: "",
    });
    await runPreviouslyAgent(baseInput());
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.system).toContain("LENGTH DISCIPLINE");
    expect(opts.system).toContain("THE USER'S SELF-DESCRIPTION WINS");
  });
});

describe("the merged direction half (directionEval)", () => {
  const DIRECTION_EVAL: PreviouslyAgentInput["directionEval"] = {
    current: "# Portrait\n\nThe user prefers concrete answers.\n\n# Hypotheses\n\n# Evidence\n\n- 2026-08-20-1430 — x\n\n# Log",
    mode: "steady",
    cardSelfModel: "- Don't decompose emotional venting with thinkDeep",
    analysis: {
      semanticHint: { strands: [], reason: "" },
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    },
  };

  it("the direction-evaluation section rides the USER prompt (mode, current doc, legacy Self-model)", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing", summary: "" },
      text: "",
    });
    await runPreviouslyAgent(baseInput({ directionEval: DIRECTION_EVAL }));
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.prompt).toContain("## Direction evaluation (FIRST");
    expect(opts.prompt).toContain("Mode: steady");
    expect(opts.prompt).toContain("The user prefers concrete answers.");
    expect(opts.prompt).toContain("Don't decompose emotional venting");
    // The eval section REPLACES the orientation-only criteria block.
    expect(opts.prompt).not.toContain("## Evolution direction (the criteria");
    // The concrete eval DATA (current doc, mode, legacy lines) never leaks
    // into the static system prompt.
    expect(opts.system).not.toContain("The user prefers concrete answers.");
  });

  it("direction MUTATION tools edit the working copy; a moved direction rides the output", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addPortraitEntry", {
        dimension: "## Communication preferences",
        text: "The user prefers concrete, evidence-anchored answers",
        refs: ["2026-08-20-1430", "2026-08-22-1015"],
      });
      await callTool(opts, "addHypothesis", {
        text: "The user may think better late at night",
        falsify: "late-slice energy stays flat",
      });
      return {
        ok: true,
        report: {
          reasoning: "portrait moved",
          summary: "更新了画像",
          directionSummary: "Direction: new portrait entry + one guess",
        },
        text: "",
      };
    });
    const out = await runPreviouslyAgent(baseInput({ directionEval: DIRECTION_EVAL }));
    expect(out.direction?.summary).toBe("Direction: new portrait entry + one guess");
    // The old doc's lines survive untouched (mutation, not a rewrite).
    expect(out.direction?.doc).toContain("The user prefers concrete answers.");
    expect(out.direction?.doc).toContain(
      "- The user prefers concrete, evidence-anchored answers — refs: 2026-08-20-1430, 2026-08-22-1015",
    );
    // Engineering stamps the [proposed] pointer with the current slice.
    expect(out.direction?.doc).toContain(
      `- [proposed ${SLICE}] The user may think better late at night — falsify if: late-slice energy stays flat`,
    );
  });

  it("direction tools are NOT mounted when no directionEval was requested (explicit-request path)", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      expect(opts.tools.addPortraitEntry).toBeUndefined();
      expect(opts.tools.addHypothesis).toBeUndefined();
      // A stray directionSummary without the direction half is dropped.
      return {
        ok: true,
        report: { reasoning: "unsolicited", summary: "", directionSummary: "unsolicited" },
        text: "",
      };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.direction).toBeUndefined();
  });

  it("no direction tool calls → no direction on the output", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "direction holds", summary: "" },
      text: "",
    });
    const out = await runPreviouslyAgent(baseInput({ directionEval: DIRECTION_EVAL }));
    expect(out.direction).toBeUndefined();
  });
});
