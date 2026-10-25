import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "@/lib/models/registry";
import type { SkillEntry, SkillLedger } from "@/lib/evolution/skill-policy";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(), readFailure: null as string | null,
  writes: vi.fn(), flush: vi.fn(), mutate: vi.fn(),
  sop: "" as string,
  stream: vi.fn(async (_options: unknown) => ({ text: Promise.resolve("Mocked reasoning result."), warnings: Promise.resolve([]) })),
}));
vi.mock("@/lib/episodic/io-helpers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/episodic/io-helpers")>(),
  fsReadFile: vi.fn(async (path: string) => {
    if (h.readFailure === path) throw new Error("fixture storage unavailable");
    const raw = h.files.get(path);
    if (raw === undefined) throw new Error(`File not found: ${path}`);
    return raw;
  }),
  fsWriteFile: h.writes,
  flushBatch: h.flush,
}));
vi.mock("@/lib/evolution/skill-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/evolution/skill-store")>(),
  mutateSkillLedger: h.mutate,
}));
vi.mock("@/lib/evolution/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/evolution/store")>(),
  readSelfSopSnapshot: vi.fn(async () => ({ content: h.sop, origin: "current", revision: "fixture-sop-revision" })),
}));
vi.mock("@/lib/capabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capabilities")>(), isAIConfigured: () => true,
}));
vi.mock("@/lib/deepseek/generate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/deepseek/generate")>(), streamText: h.stream,
}));
vi.mock("@/lib/chat/step-timeout", () => ({
  withStepTimeout: async (work: () => Promise<unknown>) => ({ ok: true, result: await work(), elapsedMs: 1 }),
  StepTimeoutError: class StepTimeoutError extends Error {},
}));
vi.mock("workflow", () => ({
  getWritable: () => ({ getWriter: () => ({ write: async () => {}, releaseLock() {} }) }),
}));

import { selectSkillExecute, thinkDeepExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { SKILL_STATE_PATH } from "@/lib/evolution/skill-store";
import { opaqueContentRevision } from "@/lib/evolution/skill-revision";
import { renderRoleSkillGuidance, SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS } from "@/lib/evolution/skill-policy";
import { createMainCraftBlock } from "@/lib/chat/craft-prompt";

const model: ModelConfig = {
  id: "deepseek-v4-flash", name: "DeepSeek Flash", provider: "deepseek", providerName: "DeepSeek",
  sdk: "deepseek", envKey: "DEEPSEEK_API_KEY", capabilities: { thinking: true, vision: false, maxTokens: 393216 },
  defaultThinking: true, defaultEffort: "high",
};
const ctx: ToolContext = {
  repo: "local", owner: "local", useGithub: false, useDemo: false,
  sliceId: "2026-10-26-1200", turnId: "user-turn", readScopeId: "chat-user-turn",
  currentUserText: "Please reason through this.", recentTurns: [], mainModel: model,
};
const entry = (overrides: Partial<SkillEntry> = {}): SkillEntry => ({
  id: "main-grounding", ref: "self/main/index.md", role: "main", scope: { kind: "general" },
  applicability: "When answering a historical question", instruction: "PINNED instruction: read original evidence.",
  summary: "Use the original context.", sourceRevision: "original-source-revision",
  evidence: ["records/2026-10-24-1200"], expectedBenefit: "Fewer unsupported claims.", reviewDue: "2026-11-30",
  revision: 2, state: "adopted", adoptionBoundary: "2026-10-24-1230", reviewEvidence: [], reviewOutcome: "pending",
  reviewNeeded: false, checkedSourceRevision: "original-source-revision", acknowledgedSourceRevision: "original-source-revision",
  ...overrides,
});
function seed(entries: SkillEntry[]): SkillLedger {
  const ledger: SkillLedger = { schemaVersion: 1, entries, operations: [] };
  h.files.set(SKILL_STATE_PATH, JSON.stringify(ledger));
  return ledger;
}
function assertReadOnly() {
  expect(h.mutate).not.toHaveBeenCalled();
  expect(h.writes).not.toHaveBeenCalled();
  expect(h.flush).not.toHaveBeenCalled();
}
beforeEach(() => { h.files.clear(); h.readFailure = null; h.sop = ""; vi.clearAllMocks(); });

describe("main selectSkill executor", () => {
  it("shows changed source as review-needed without replacing adopted instruction or writing any state", async () => {
    const adopted = entry();
    seed([adopted]);
    const before = h.files.get(SKILL_STATE_PATH);
    const changedSource = "NEW source instruction — must not silently replace the pinned rule.";
    h.files.set("memory/self/main/index.md", changedSource);
    const result = await selectSkillExecute({ id: adopted.id }, { context: ctx, toolCallId: "select-main" });
    expect(result).toMatchObject({ status: "selected", instruction: adopted.instruction, applicability: adopted.applicability, reviewNeeded: true,
      source: { ref: adopted.ref, content: changedSource, revision: opaqueContentRevision("skill-source", adopted.ref, changedSource) } });
    expect(h.files.get(SKILL_STATE_PATH)).toBe(before);
    assertReadOnly();
  });

  it("keeps an acknowledged source read-only and does not invent a review", async () => {
    const content = "Already reviewed research procedure.";
    const revision = opaqueContentRevision("skill-source", "self/main/index.md", content);
    const adopted = entry({ sourceRevision: revision, acknowledgedSourceRevision: revision, checkedSourceRevision: revision });
    seed([adopted]); h.files.set("memory/self/main/index.md", content);
    expect(await selectSkillExecute({ id: adopted.id }, { context: ctx, toolCallId: "select-same" }))
      .toMatchObject({ status: "selected", instruction: adopted.instruction, reviewNeeded: false });
    assertReadOnly();
  });

  it("rejects candidate, retired, and other-role entries even if the id and source exist", async () => {
    for (const variant of [entry({ state: "candidate" }), entry({ state: "retired" }), entry({ role: "thinkdeep" }), entry({ role: "search" })]) {
      seed([variant]); h.files.set("memory/self/main/index.md", "not active for main");
      expect(await selectSkillExecute({ id: variant.id }, { context: ctx, toolCallId: "rejected-selection" }))
        .toMatchObject({ status: "error" });
    }
    assertReadOnly();
  });

  it("does not reset corrupt/unavailable state or pretend a missing source is selected", async () => {
    h.files.set(SKILL_STATE_PATH, "invalid JSON");
    expect(await selectSkillExecute({ id: "main-grounding" }, { context: ctx, toolCallId: "bad-state" })).toMatchObject({ status: "error" });
    h.readFailure = SKILL_STATE_PATH;
    expect(await selectSkillExecute({ id: "main-grounding" }, { context: ctx, toolCallId: "offline-state" })).toMatchObject({ status: "error" });
    h.readFailure = null; seed([entry()]);
    expect(await selectSkillExecute({ id: "main-grounding" }, { context: ctx, toolCallId: "missing-source" })).toMatchObject({ status: "error" });
    assertReadOnly();
  });
});

describe("thinkDeep skill consumer", () => {
  it("consumes only its role, strips main craft, and passes whole bounded rules to the mocked model", async () => {
    h.sop = "Legacy reasoning guidance. " + "S".repeat(11700);
    const active = Array.from({ length: 8 }, (_, index) => entry({
      id: `think-${index}`, ref: `self/think-${index}/index.md`, role: "thinkdeep",
      instruction: `BEGIN-THINK-${index} ${String(index).repeat(1100)} END-THINK-${index}`,
    }));
    const candidate = entry({ id: "candidate-think", role: "thinkdeep", state: "candidate", instruction: "CANDIDATE MUST STAY INERT" });
    const main = entry({ id: "main-only", instruction: "MAIN-ONLY skill must not leak" });
    const ledger = seed([...active, candidate, main]);
    const inherited = `Core pinned identity stays.\n\n${createMainCraftBlock("MAIN-CRAFT-MUST-NOT-LEAK")}`;
    const result = await thinkDeepExecute({ question: "Compare two explanations using supplied facts." },
      { context: { ...ctx, baseSystemPrompt: inherited }, toolCallId: "reason-with-skills" });
    expect(result).toMatchObject({ status: "completed", answer: "Mocked reasoning result." });
    expect(h.stream).toHaveBeenCalledTimes(1);
    const options = h.stream.mock.calls[0][0] as { system: string; role: string; tools?: unknown; prompt: string };
    const expected = renderRoleSkillGuidance({ role: "thinkdeep", ledger, legacySop: { content: h.sop, ref: "self/thinkdeep/index.md" } });
    expect(expected.text.length).toBeLessThanOrEqual(SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS);
    expect(expected.omissions.length).toBeGreaterThan(0);
    expect(options.system.endsWith(expected.text)).toBe(true);
    expect(options.system).toContain("Core pinned identity stays.");
    expect(options.system).not.toContain("MAIN-CRAFT-MUST-NOT-LEAK");
    expect(options.system).not.toContain(main.instruction);
    expect(options.system).not.toContain(candidate.instruction);
    for (const rule of active) {
      if (options.system.includes(`BEGIN-THINK-${rule.id.slice(-1)}`)) expect(options.system).toContain(rule.instruction);
    }
    expect(options.role).toBe("think");
    expect(options.tools).toBeUndefined();
    expect(options.prompt).toContain("Compare two explanations");
    assertReadOnly();
  });
});
