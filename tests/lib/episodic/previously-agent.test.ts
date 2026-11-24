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
  const input: PreviouslyAgentInput = {
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
  if (input.allowedSopWrites && !input.sopSnapshots) {
    input.sopSnapshots = Object.fromEntries(input.allowedSopWrites.map((agent) => [agent, {
      agent,
      origin: "legacy" as const,
      content: `Old ${agent} SOP — preserve this unrelated rule.`,
      revision: `test-${agent}-revision-1`,
    }]));
  }
  return input;
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
    expect(opts).not.toHaveProperty('maxSteps');
    // v0.34 修订 A: no execution budget — the runner installs no timeout hooks.
    expect("timeoutMs" in opts).toBe(false);
    expect(opts.role).toBe("summary");
    expect(opts).not.toHaveProperty("temperature");
    expect(opts.reportToolName).toBe("finish");
    // Static system carries the role instructions; dynamic content is in the
    // user prompt only.
    expect(opts.system).toContain("Previously Agent");
    expect(opts.system).not.toContain("## Time context");
    expect(opts.prompt).toContain("## Time context");
    expect(opts.prompt).toContain("## Current card");
    expect(opts.prompt).toContain("我周五有个面试");
  });

  it("keeps commitments in the task system and mounts no Horizon mutation tools", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      expect(opts.tools.addHorizon).toBeUndefined();
      expect(opts.tools.resolveHorizon).toBeUndefined();
      expect(opts.system).toContain("Commitments, deadlines, awaited replies");
      expect(opts.system).toContain("Never create or maintain a Horizon section");
      expect(opts.system).not.toContain("`addHorizon(text");
      return { ok: true, report: { reasoning: "task state stays out of the card", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({
      recentTurns: [{ role: "user", content: "提醒我周五续护照。" }],
    }));
    expect(out.failed).toBeFalsy();
    expect(out.mutations).toEqual([]);
  });

  it("projects only assistant formatting copy in recent turns without mutating them", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing new", summary: "" },
      text: "",
    });
    const agent = `agent before\n\`\`\`html live\n${"<button>generated</button>\n".repeat(30)}\`\`\`\nagent after`;
    const user = "user native\n```html live\n<button>user example</button>\n```";
    const recentTurns = [
      { role: "user", content: user },
      { role: "assistant", content: agent },
    ];
    const snapshot = recentTurns.map((turn) => ({ ...turn }));

    await runPreviouslyAgent(baseInput({ recentTurns, closedSliceId: SLICE }));

    const opts = runSubAgentMock.mock.calls[0][0];
    const conversation = JSON.parse(opts.prompt!.split("## Recent Conversation (your window into what changed)\n\n")[1]);
    expect(conversation).toMatchObject([
      { role: "user", content: user },
      { role: "assistant", content: "agent before\n[Interactive visual omitted]agent after" },
    ]);
    expect(opts.prompt).not.toContain("<button>generated</button>");
    expect(opts.prompt).toContain("conversation excerpt is below");
    expect(opts.prompt).not.toContain("full conversation is below");
    expect(recentTurns).toEqual(snapshot);
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

describe("partial output when the model omits its report", () => {
  it("returns a PARTIAL card with the mutations that landed, not failed + empty", async () => {
    runSubAgentMock.mockImplementation(async (opts) => {
      await callTool(opts, "addNow", { text: "prepping the friday interview", refs: [SLICE] });
      // …then burns the remaining steps and never calls finish.
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.failed).toBeFalsy();
    expect(out.partial).toBe(true);
    expect(out.reasoning).toContain("the model ended without submitting its report");
    expect(parseCard(out.updatedCard)?.now[0]?.text).toBe("prepping the friday interview");
    // A partial pass is a result, not a failure — no retry.
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the full profile submitted by a pass that ended before filing its report", async () => {
    const long = "p".repeat(2600);
    runSubAgentMock.mockImplementation(async opts => {
      expect(await callTool(opts, "updatePastProfile", { text: long })).toContain("OK");
      return { ok: true, report: undefined, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(out.partial).toBe(true);
    expect(parseCard(out.updatedCard)?.past.profile).toBe(long);
  });
});

describe("retry on hard failure", () => {
  it("retries once with the same fixed profile when the first attempt fails", async () => {
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
    expect(runSubAgentMock.mock.calls[0][0].role).toBe("summary");
    expect(runSubAgentMock.mock.calls[1][0].role).toBe("summary");
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
        applicability: "When citing prior conversations",
      });
      return { ok: true, report: { reasoning: "tried", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput());
    expect(rejection).toContain("REJECTED");
    expect(rejection).toContain("not writable this run");
    expect(out.sopWrites).toBeUndefined();
  });

  it("shows the FULL old SOP and stages applicability plus its recorded revision", async () => {
    const oldSop = `# Legacy search SOP\n\n${"whole old rule\n".repeat(100)}`;
    runSubAgentMock.mockImplementation(async (opts) => {
      expect(opts.prompt).toContain(oldSop);
      expect(opts.prompt).toContain("effective origin: legacy");
      const ok = await callTool(opts, "writeSop", {
        agent: "search",
        content: "Quote the slice id before answering.",
        evidence: ["2026-08-20-1430", ""],
        expectedBenefit: "fewer ungrounded answers",
        applicability: "When citing prior conversations",
      });
      expect(ok).toContain("OK");
      return { ok: true, report: { reasoning: "done", summary: "", expectedBenefit: "fewer ungrounded answers" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({
      allowedSopWrites: ["search"],
      sopSnapshots: {
        search: { agent: "search", origin: "legacy", content: oldSop, revision: "legacy-revision-1" },
      },
    }));
    expect(out.sopWrites).toEqual([
      {
        agent: "search",
        content: "Quote the slice id before answering.",
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "fewer ungrounded answers",
        applicability: "When citing prior conversations",
        baseRevision: "legacy-revision-1",
      },
    ]);
    expect(out.expectedBenefit).toBe("fewer ungrounded answers");
  });

  it("rejects empty or malformed evidence, expected benefit, or applicability", async () => {
    const rejections: string[] = [];
    runSubAgentMock.mockImplementation(async (opts) => {
      for (const args of [
        { evidence: [], expectedBenefit: "benefit", applicability: "when searching" },
        { evidence: ["nonsense"], expectedBenefit: "benefit", applicability: "when searching" },
        { evidence: ["2026-02-30-1000"], expectedBenefit: "benefit", applicability: "when searching" },
        { evidence: ["2026-10-26-2460"], expectedBenefit: "benefit", applicability: "when searching" },
        { evidence: ["2026-08-20-1430"], expectedBenefit: " ", applicability: "when searching" },
        { evidence: ["2026-08-20-1430"], expectedBenefit: "benefit", applicability: " " },
      ]) {
        rejections.push(await callTool(opts, "writeSop", {
          agent: "search",
          content: "Whole replacement rule.",
          ...args,
        }));
      }
      return { ok: true, report: { reasoning: "done", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({ allowedSopWrites: ["search"] }));
    expect(rejections).toHaveLength(6);
    expect(rejections.every((rejection) => rejection.includes("REJECTED"))).toBe(true);
    expect(out.sopWrites).toBeUndefined();
  });

  it("rejects a write without the recorded full-read basis", async () => {
    let rejection = "";
    runSubAgentMock.mockImplementation(async (opts) => {
      rejection = await callTool(opts, "writeSop", {
        agent: "search",
        content: "Whole replacement rule.",
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "benefit",
        applicability: "when searching",
      });
      return { ok: true, report: { reasoning: "done", summary: "" }, text: "" };
    });
    const out = await runPreviouslyAgent(baseInput({
      allowedSopWrites: ["search"],
      sopSnapshots: {},
    }));
    expect(rejection).toContain("no recorded full read basis");
    expect(out.sopWrites).toBeUndefined();
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
          evidence: ["2026-08-20-1430"],
          expectedBenefit: "y",
          applicability: "when searching",
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
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "y",
        applicability: "when thinking deeply",
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
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "a",
        applicability: "when searching",
      });
      await callTool(opts, "writeSop", {
        agent: "search",
        content: "second draft",
        evidence: ["2026-08-20-1430"],
        expectedBenefit: "b",
        applicability: "when searching",
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

  it("the SOP style discipline bans the builder's vantage point — in the role prompt and next to the offer", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing", summary: "" },
      text: "",
    });
    await runPreviouslyAgent(baseInput({ allowedSopWrites: ["search"] }));
    const opts = runSubAgentMock.mock.calls[0][0];
    // The static role prompt carries the investigator's-account discipline…
    expect(opts.system).toContain("investigator's account");
    expect(opts.system).toContain("Keep implementation commentary out of the case");
    // …and the dynamic section offering the SOP writes repeats it.
    expect(opts.prompt).toContain("## self/ SOPs writable this run");
    expect(opts.prompt).toContain("Keep implementation commentary out of the case");
  });
});

describe("the merged direction half (directionEval)", () => {
  const DIRECTION_EVAL: PreviouslyAgentInput["directionEval"] = {
    current: "# Portrait\n\nThe user prefers concrete answers.\n\n# Hypotheses\n\n# Evidence\n\n- 2026-08-20-1430 — x\n\n# Log",
    mode: "steady",
    cardSelfModel: "- Don't decompose emotional venting with thinkDeep",
    analysis: {
      memoryWorthy: true,
      emotionalSignal: { intensity: "none", register: "neutral", note: "" },
    },
  };

  it("allows an unchanged hypothesis pool on a memory question", async () => {
    runSubAgentMock.mockResolvedValue({ ok: true, report: { reasoning: "nothing new", summary: "" }, text: "" });
    const out = await runPreviouslyAgent(baseInput({
      recentTurns: [{ role: "user", content: "我们第一次聊了什么？" }],
      directionEval: DIRECTION_EVAL,
    }));
    const opts = runSubAgentMock.mock.calls[0]![0];
    expect(opts.tools.addHypothesis).toBeDefined();
    expect(opts.system).toContain("A single memory question or an unanswered reply establishes no enduring motive or preference");
    expect(opts.system).toContain("Leave the pool empty or unchanged");
    expect([opts.system, opts.prompt].join("\n")).not.toMatch(/refill|toward 10/i);
    expect(out.direction).toBeUndefined();
    expect(out.mutations).toEqual([]);
  });

  it("the direction-evaluation section rides the USER prompt (mode, current doc, legacy Self-model)", async () => {
    runSubAgentMock.mockResolvedValue({
      ok: true,
      report: { reasoning: "nothing", summary: "" },
      text: "",
    });
    await runPreviouslyAgent(baseInput({ directionEval: DIRECTION_EVAL }));
    const opts = runSubAgentMock.mock.calls[0][0];
    expect(opts.prompt).toContain("## Direction evaluation (alongside the retrospective card)");
    expect(opts.prompt).toContain("Mode: steady");
    expect(opts.prompt).toContain("The user prefers concrete answers.");
    expect(opts.prompt).toContain("Don't decompose emotional venting");
    // The eval section REPLACES the orientation-only criteria block.
    expect(opts.prompt).not.toContain("## Evolution direction (the criteria");
    // The concrete eval DATA (current doc, mode, legacy lines) never leaks
    // into the static system prompt.
    expect(opts.system).not.toContain("The user prefers concrete answers.");
  });

  it("direction MUTATION tools use original user evidence and preserve earlier entries", async () => {
    const refs = ["2026-08-12-1430", "2026-08-15-1015"];
    runSubAgentMock.mockImplementation(async (opts) => {
      for (const sliceId of refs) await callTool(opts, "readSlice", { sliceId });
      await callTool(opts, "addPortraitEntry", {
        dimension: "## Communication preferences",
        text: "The user prefers concrete, evidence-anchored answers",
        refs,
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
    const out = await runPreviouslyAgent(baseInput({
      directionEval: DIRECTION_EVAL,
      readSliceFn: async (id) => JSON.stringify({ source: { kind: "conversation_record", ref: `records/${id}` },
        turns: [{ role: "user", sourceRole: "user", content: "I used the figures in that comparison." }] }),
    }));
    expect(out.direction?.summary).toBe("Direction: new portrait entry + one guess");
    // The old doc's lines survive untouched (mutation, not a rewrite).
    expect(out.direction?.doc).toContain("The user prefers concrete answers.");
    expect(out.direction?.doc).toContain(
      "- The user prefers concrete, evidence-anchored answers — refs: 2026-08-12-1430, 2026-08-15-1015",
    );
    // Engineering stamps the [proposed] pointer with the current slice.
    expect(out.direction?.doc).toContain(
      `- [proposed ${SLICE}] The user may think better late at night — falsify if: late-slice energy stays flat`,
    );
  });

  it("requires a verified user quotation for a confirmed claim from one situation", async () => {
    runSubAgentMock.mockImplementation(async opts => {
      const entry = { dimension: "## Triggers & rhythms", text: "More prone to waking at sudden sounds.", refs: [SLICE] };
      expect(await callTool(opts, "addPortraitEntry", entry)).toContain("REJECTED");
      expect(await callTool(opts, "addPortraitEntry", { ...entry, selfDescription: "Loud music never bothers me" })).toContain("REJECTED");
      expect(await callTool(opts, "addPortraitEntry", { ...entry, selfDescription: "Sudden sounds wake me up wherever I sleep." })).toContain("OK");
      return { ok: true, report: { reasoning: "Stated sleep pattern.", summary: "Updated." }, text: "" };
    });
    const result = await runPreviouslyAgent(baseInput({ directionEval: DIRECTION_EVAL, recentTurns: [
      { role: "assistant", content: "Loud music never bothers me" },
      { role: "user", content: "Sudden sounds wake me up wherever I sleep." },
    ] }));
    expect(result.direction?.doc).toContain("More prone to waking at sudden sounds.");
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
