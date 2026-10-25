import { describe, expect, it } from "vitest";
import {
  applySkillOperation,
  emptySkillLedger,
  isSkillSourceRef,
  listDueSkillReviews,
  renderRoleSkillGuidance,
  SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS,
  SKILL_LEGACY_SOP_MAX_CHARS,
  SKILL_PROMPT_MAX_CHARS,
  SKILL_STATE_DIAGNOSTIC_MAX_CHARS,
  type SkillDraft,
  type SkillEntry,
  type SkillLedger,
} from "@/lib/evolution/skill-policy";

const BASE_DRAFT: SkillDraft = {
  id: "read-full-context",
  ref: "self/main/index.md",
  role: "main",
  scope: { kind: "general" },
  applicability: "When answering a question about an earlier conversation",
  instruction: "Read the whole slice before concluding.",
  summary: "Ground conclusions in the full context.",
  sourceRevision: "source-v1",
  evidence: ["2026-08-20-1430"],
  expectedBenefit: "Fewer premature conclusions",
  reviewDue: "2026-11-30",
};
const ADOPTION_HOST = { adoptionBoundary: "2026-10-26-1000" };

function entry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    ...BASE_DRAFT,
    revision: 1,
    state: "adopted",
    reviewEvidence: [],
    reviewOutcome: "pending",
    reviewNeeded: false,
    checkedSourceRevision: "source-v1",
    acknowledgedSourceRevision: "source-v1",
    ...overrides,
  };
}

function ledger(entries: SkillEntry[]): SkillLedger {
  return { schemaVersion: 1, entries, operations: [] };
}

function proposedAndAdopted() {
  const proposed = applySkillOperation(emptySkillLedger(), {
    kind: "propose",
    operationId: "proposal-1",
    expectedRevision: 0,
    draft: BASE_DRAFT,
  });
  if (proposed.status !== "applied") throw new Error("proposal fixture failed");
  const adopted = applySkillOperation(proposed.ledger, {
    kind: "adopt",
    operationId: "adoption-1",
    id: BASE_DRAFT.id,
    expectedRevision: 1,
    reviewDue: "2026-11-30",
  }, ADOPTION_HOST);
  if (adopted.status !== "applied") throw new Error("adoption fixture failed");
  return { proposed, adopted };
}

describe("procedural skill lifecycle", () => {
  it("records an idempotent review offer without changing the skill or its revision", () => {
    const { proposed, adopted } = proposedAndAdopted();
    const operation = {
      kind: "offer_review", operationId: "review-offer-v2", id: BASE_DRAFT.id, expectedRevision: 2,
    };
    const result = applySkillOperation(adopted.ledger, operation);
    expect(result).toMatchObject({ status: "applied", entry: adopted.entry });
    expect(result.ledger.entries).toEqual(adopted.ledger.entries);
    expect(result.ledger.operations).toHaveLength(adopted.ledger.operations.length + 1);
    expect(applySkillOperation(result.ledger, operation)).toMatchObject({ status: "replayed", ledger: result.ledger });
    expect(applySkillOperation(proposed.ledger, { ...operation, operationId: "candidate-offer", expectedRevision: 1 }))
      .toMatchObject({ status: "rejected", code: "state" });
  });
  it("requires a host boundary and rejects a model-supplied adoption boundary", () => {
    const { proposed } = proposedAndAdopted();
    const operation = {
      kind: "adopt", operationId: "other-adoption", id: BASE_DRAFT.id,
      expectedRevision: 1, reviewDue: "2026-11-30",
    };
    expect(applySkillOperation(proposed.ledger, operation))
      .toMatchObject({ status: "rejected", code: "invalid" });
    expect(applySkillOperation(proposed.ledger, {
      ...operation, adoptionBoundary: "2026-08-01-0000",
    }, ADOPTION_HOST)).toMatchObject({ status: "rejected", code: "invalid" });
  });

  it("revises the same id into an inert candidate and explicitly adopts the new version", () => {
    const { adopted } = proposedAndAdopted();
    const operation = {
      kind: "revise", operationId: "revision-1", id: BASE_DRAFT.id, expectedRevision: 2,
      changes: {
        instruction: "Check the latest correction before quoting an earlier conclusion.",
        applicability: "When the user corrects a prior interpretation",
        evidence: ["2026-10-26-1100"], sourceRevision: "source-v2",
      },
    };
    const revised = applySkillOperation(adopted.ledger, operation);
    if (revised.status !== "applied") throw new Error("revision should apply");
    expect(revised.ledger.entries).toHaveLength(1);
    expect(revised.entry).toMatchObject({
      id: BASE_DRAFT.id, state: "candidate", revision: 3,
      reviewOutcome: "pending", reviewEvidence: [], adoptionBoundary: undefined,
    });
    expect(renderRoleSkillGuidance({ role: "main", ledger: revised.ledger }).text).toBe("");
    expect(applySkillOperation(revised.ledger, operation)).toMatchObject({ status: "replayed" });
    expect(applySkillOperation(revised.ledger, { ...operation, operationId: "stale-revision" }))
      .toMatchObject({ status: "rejected", code: "stale" });
    const readopted = applySkillOperation(revised.ledger, {
      kind: "adopt", operationId: "adoption-2", id: BASE_DRAFT.id,
      expectedRevision: 3, reviewDue: "2026-12-01",
    }, { adoptionBoundary: "2026-10-26-1200" });
    if (readopted.status !== "applied") throw new Error("readoption should apply");
    const text = renderRoleSkillGuidance({ role: "main", ledger: readopted.ledger }).text;
    expect(text).toContain(operation.changes.instruction);
    expect(text).not.toContain(BASE_DRAFT.instruction);
    expect(readopted.entry.adoptionBoundary).toBe("2026-10-26-1200");
  });

  it.each([
    ["2026-08-20-1430", "evidence"],
    ["2026-10-26-1000-abcdef", "evidence"],
    ["2027-01-01-1000", "evidence"],
    ["2026-02-30-1000", "invalid"],
    ["2026-10-26-2460", "invalid"],
  ])("does not count %s as post-adoption observed success", (ref, code) => {
    const { adopted } = proposedAndAdopted();
    const result = applySkillOperation(adopted.ledger, {
      kind: "review", operationId: "positive-review", id: BASE_DRAFT.id,
      expectedRevision: 2, reviewEvidence: [ref], reviewOutcome: "positive",
      reviewedAt: "2026-10-26", reviewDue: "2026-12-01",
    }, { adoptionBoundary: "2026-10-26-1200" });
    expect(result).toMatchObject({ status: "rejected", code });
    expect(result.ledger).toEqual(adopted.ledger);
  });

  it("accepts a distinct later observed scenario as positive evidence", () => {
    const { adopted } = proposedAndAdopted();
    const result = applySkillOperation(adopted.ledger, {
      kind: "review", operationId: "positive-review", id: BASE_DRAFT.id,
      expectedRevision: 2, reviewEvidence: ["2026-10-26-1100-abcd12"],
      reviewOutcome: "positive", reviewedAt: "2026-10-26", reviewDue: "2026-12-01",
    }, { adoptionBoundary: "2026-10-26-1200" });
    expect(result).toMatchObject({ status: "applied", entry: { reviewOutcome: "positive" } });
  });
  it("injects only explicitly adopted entries, never candidates or retired entries", () => {
    const { proposed, adopted } = proposedAndAdopted();
    expect(proposed.entry.state).toBe("candidate");
    expect(renderRoleSkillGuidance({ role: "main", ledger: proposed.ledger }).text).toBe("");
    expect(adopted.entry.state).toBe("adopted");
    expect(renderRoleSkillGuidance({ role: "main", ledger: adopted.ledger }).text)
      .toContain(BASE_DRAFT.instruction);

    const retired = applySkillOperation(adopted.ledger, {
      kind: "retire",
      operationId: "retirement-1",
      id: BASE_DRAFT.id,
      expectedRevision: 2,
    });
    expect(retired.status).toBe("applied");
    expect(renderRoleSkillGuidance({ role: "main", ledger: retired.ledger }).text).toBe("");
  });

  it("replays operation ids idempotently and rejects stale per-entry revisions", () => {
    const { adopted } = proposedAndAdopted();
    const operation = {
      kind: "adopt",
      operationId: "adoption-1",
      id: BASE_DRAFT.id,
      expectedRevision: 1,
      reviewDue: "2026-11-30",
    };
    const replay = applySkillOperation(adopted.ledger, operation);
    expect(replay.status).toBe("replayed");
    expect(replay.ledger).toEqual(adopted.ledger);

    const stale = applySkillOperation(adopted.ledger, {
      kind: "retire",
      operationId: "retirement-stale",
      id: BASE_DRAFT.id,
      expectedRevision: 1,
    });
    expect(stale).toMatchObject({ status: "rejected", code: "stale" });
    expect(stale.ledger).toEqual(adopted.ledger);

    const conflict = applySkillOperation(adopted.ledger, {
      ...operation,
      reviewDue: "2026-12-01",
    });
    expect(conflict).toMatchObject({ status: "rejected", code: "conflict" });
  });

  it("requires record evidence for outcomes and retires on a negative review", () => {
    const { adopted } = proposedAndAdopted();
    const withoutEvidence = applySkillOperation(adopted.ledger, {
      kind: "review",
      operationId: "review-empty",
      id: BASE_DRAFT.id,
      expectedRevision: 2,
      reviewEvidence: [],
      reviewOutcome: "positive",
      reviewedAt: "2026-10-26",
      reviewDue: "2026-12-01",
    });
    expect(withoutEvidence).toMatchObject({ status: "rejected", code: "invalid" });
    expect(withoutEvidence.ledger).toEqual(adopted.ledger);

    const negative = applySkillOperation(adopted.ledger, {
      kind: "review",
      operationId: "review-negative",
      id: BASE_DRAFT.id,
      expectedRevision: 2,
      reviewEvidence: ["2026-08-21-1000"],
      reviewOutcome: "negative",
      reviewedAt: "2026-10-26",
      reviewDue: "2026-12-01",
    });
    if (negative.status !== "applied") throw new Error("negative review should apply");
    expect(negative.entry).toMatchObject({
      state: "retired",
      reviewOutcome: "negative",
      reviewEvidence: ["2026-08-21-1000"],
    });
    expect(negative.entry.expectedBenefit).toBe(BASE_DRAFT.expectedBenefit);
  });

  it("flags changed sources for review without adopting their content or moving the pinned instruction", () => {
    const { adopted } = proposedAndAdopted();
    const checked = applySkillOperation(adopted.ledger, {
      kind: "check_source",
      operationId: "source-check-1",
      id: BASE_DRAFT.id,
      expectedRevision: 2,
      sourceRevision: "source-v2",
    });
    if (checked.status !== "applied") throw new Error("source check should apply");
    expect(checked.entry).toMatchObject({
      reviewNeeded: true,
      sourceRevision: "source-v1",
      acknowledgedSourceRevision: "source-v1",
      checkedSourceRevision: "source-v2",
      instruction: BASE_DRAFT.instruction,
    });
    expect(listDueSkillReviews(checked.ledger, "2026-10-26").map((item) => item.id))
      .toEqual([BASE_DRAFT.id]);

    const reviewed = applySkillOperation(checked.ledger, {
      kind: "review",
      operationId: "source-review-1",
      id: BASE_DRAFT.id,
      expectedRevision: 3,
      reviewEvidence: ["2026-08-22-1000"],
      reviewOutcome: "inconclusive",
      reviewedAt: "2026-10-26",
      reviewDue: "2026-12-15",
      checkedSourceRevision: "source-v2",
    });
    if (reviewed.status !== "applied") throw new Error("source review should apply");
    expect(reviewed.entry).toMatchObject({
      state: "adopted",
      reviewNeeded: false,
      sourceRevision: "source-v1",
      acknowledgedSourceRevision: "source-v2",
      instruction: BASE_DRAFT.instruction,
    });
    const checkedAgain = applySkillOperation(reviewed.ledger, {
      kind: "check_source",
      operationId: "source-check-2",
      id: BASE_DRAFT.id,
      expectedRevision: 4,
      sourceRevision: "source-v2",
    });
    if (checkedAgain.status !== "applied") throw new Error("second source check should apply");
    expect(checkedAgain.entry.reviewNeeded).toBe(false);
  });
});

describe("bounded deterministic role rendering", () => {
  it("targets exact roles, sorts ids, and leaves task instructions behind source refs", () => {
    const state = ledger([
      entry({ id: "z-task", scope: { kind: "task", trigger: "When debugging a failed search" }, instruction: "TASK INSTRUCTION MUST NOT BE INJECTED" }),
      entry({ id: "search-only", role: "search" }),
      entry({ id: "b-general" }),
      entry({ id: "a-general" }),
      entry({ id: "candidate", state: "candidate" }),
      entry({ id: "retired", state: "retired" }),
    ]);
    const first = renderRoleSkillGuidance({ role: "main", ledger: state });
    const second = renderRoleSkillGuidance({ role: "main", ledger: state });
    expect(first).toEqual(second);
    expect(first.selectedSkillIds).toEqual(["a-general", "b-general", "z-task"]);
    expect(first.text.indexOf("a-general")).toBeLessThan(first.text.indexOf("b-general"));
    expect(first.text).toContain("references only, not active instructions");
    expect(first.text).toContain("Read original: self/main/index.md");
    expect(first.text).not.toContain("TASK INSTRUCTION MUST NOT BE INJECTED");
    expect(first.text).not.toContain("search-only");
    expect(first.text).not.toContain("candidate");
    expect(first.text).not.toContain("retired");
  });

  it("omits an oversize legacy SOP whole with an honest read-original notice", () => {
    const legacy = `LEGACY RULE START\n${"whole-rule-text\n".repeat(900)}`;
    expect(legacy.length).toBeGreaterThan(SKILL_LEGACY_SOP_MAX_CHARS);
    const rendered = renderRoleSkillGuidance({
      role: "search",
      ledger: ledger([entry({ role: "search" })]),
      legacySop: { content: legacy, ref: "agent-playbooks/search.md" },
    });
    expect(rendered.text).not.toContain("LEGACY RULE START");
    expect(rendered.text).toContain("Legacy SOP omitted");
    expect(rendered.text).toContain("no partial rule was injected");
    expect(rendered.text).toContain("Read the original: agent-playbooks/search.md");
    expect(rendered.text).toContain(BASE_DRAFT.instruction);
    expect(rendered.text.length).toBeLessThanOrEqual(SKILL_LEGACY_ROLE_PROMPT_MAX_CHARS);
  });

  it("counts complete rules, notices, diagnostics and host wrappers within the final budget", () => {
    const state = ledger(Array.from({ length: 30 }, (_, index) => entry({
      id: `rule-${String(index).padStart(2, "0")}`,
      instruction: `Complete instruction ${index}: ${"i".repeat(1150)}`,
      summary: "s".repeat(240), applicability: "a".repeat(400),
      scope: index < 15 ? { kind: "general" } : { kind: "task", trigger: "t".repeat(240) },
    })));
    const wrapper = "\n\n[BEGIN SKILLS]\n[END SKILLS]";
    const rendered = renderRoleSkillGuidance({
      role: "main", ledger: state,
      legacySop: { content: "x".repeat(13000), ref: "self/main/index.md" },
      stateDiagnostic: "D".repeat(7000), hostReservedChars: wrapper.length,
    });
    expect(rendered.text.length + wrapper.length).toBeLessThanOrEqual(SKILL_PROMPT_MAX_CHARS);
    expect(rendered.text).toContain("diagnostic truncated");
    expect(rendered.text).toContain("Legacy SOP omitted");
    expect(rendered.text).toContain("adopted general skill");
    expect(rendered.text).toContain("adopted catalogue skill");
    expect(rendered.text.match(/D/g)?.length ?? 0).toBeLessThanOrEqual(SKILL_STATE_DIAGNOSTIC_MAX_CHARS);
    for (const selected of rendered.selectedSkillIds) {
      const whole = state.entries.find((item) => item.id === selected)!;
      if (whole.scope.kind === "general") expect(rendered.text).toContain(whole.instruction);
    }
    expect(renderRoleSkillGuidance({ role: "main", stateDiagnostic: "D".repeat(7000) }).text.length)
      .toBeLessThanOrEqual(SKILL_PROMPT_MAX_CHARS);
    expect(renderRoleSkillGuidance({ role: "main", ledger: state, hostReservedChars: 6000 }).text).toBe("");
  });

  it("does not repeat an adopted rule already present in the legacy SOP", () => {
    const rendered = renderRoleSkillGuidance({
      role: "main",
      ledger: ledger([entry()]),
      legacySop: { content: BASE_DRAFT.instruction, ref: "self/main/index.md" },
    });
    expect(rendered.text.split(BASE_DRAFT.instruction)).toHaveLength(2);
    expect(rendered.omissions).toContainEqual(
      expect.objectContaining({ id: BASE_DRAFT.id, reason: "duplicate" }),
    );
  });

  it("lists due and source-flagged reviews in deterministic order", () => {
    const state = ledger([
      entry({ id: "later", reviewDue: "2026-11-01" }),
      entry({ id: "source", reviewDue: "2026-12-01", reviewNeeded: true }),
      entry({ id: "early", reviewDue: "2026-10-01" }),
      entry({ id: "retired", state: "retired", reviewDue: "2026-10-01" }),
    ]);
    expect(listDueSkillReviews(state, "2026-11-15").map((item) => item.id))
      .toEqual(["early", "later", "source"]);
  });
});

describe("skill source reference validation", () => {
  it.each(["self/沟通 规范/index.md", "self/100%/index.md", "self/2026-10-26-调查笔记/index.md"])("accepts %s", (ref) => {
    expect(isSkillSourceRef(ref)).toBe(true);
  });
  it.each([
    "self/%2e%2e%2fpeople%2fuser/index.md", "self/%252e%252e/index.md",
    "self/../index.md", "self/a..b/index.md", "self/ leading/index.md",
    "self/trailing /index.md", "self/name./index.md", "self/CON/index.md",
    "self/nul.txt/index.md", "self/COM1/index.md", "self/2026-10-26-1000/index.md",
    "self/control\u007f/index.md", "self/a:b/index.md", "people/user/index.md",
  ])("rejects %s before source I/O", (ref) => {
    expect(isSkillSourceRef(ref)).toBe(false);
  });
});
