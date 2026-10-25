import { describe, expect, it } from "vitest";
import { createMainCraftBlock, MAIN_CRAFT_HOST_RESERVED_CHARS, replaceMainCraftBlock } from "@/lib/chat/craft-prompt";
import { renderRoleSkillGuidance, SKILL_PROMPT_MAX_CHARS, type SkillEntry } from "@/lib/evolution/skill-policy";

function entries(instructionLength: number): SkillEntry[] {
  return Array.from({ length: 4 }, (_, n) => ({
    id: `bounded-rule-${n}`, ref: `self/bounded-rule-${n}/index.md`,
    role: "main", scope: { kind: "general" }, applicability: "适用条件".repeat(90),
    instruction: "规".repeat(instructionLength), summary: "规则摘要".repeat(50),
    sourceRevision: "source-v1", evidence: ["2026-10-20-1000"],
    expectedBenefit: "减少同类错误", reviewDue: "2026-11-01", revision: 1,
    state: "adopted", adoptionBoundary: "2026-10-21-1000",
    reviewEvidence: [], reviewOutcome: "pending", reviewNeeded: false,
    checkedSourceRevision: "source-v1", acknowledgedSourceRevision: "source-v1",
  }));
}

describe("main craft prompt host integration", () => {
  it("keeps full rules and wrapper overhead inside the actual main guidance budget", () => {
    // Find a legitimate four-rule fixture near the renderer's hard limit.
    // Without the host reservation, the same complete rules overflow when
    // the real craft markers and system separator are added.
    let fullest: ReturnType<typeof entries> = [];
    for (let length = 600; length <= 1200; length += 1) {
      const candidate = entries(length);
      const guidance = renderRoleSkillGuidance({ role: "main", ledger: { schemaVersion: 1, entries: candidate, operations: [] } });
      if (guidance.selectedSkillIds.length === candidate.length) fullest = candidate;
    }
    expect(fullest).toHaveLength(4);
    const ledger = { schemaVersion: 1 as const, entries: fullest, operations: [] };
    const unreserved = createMainCraftBlock(renderRoleSkillGuidance({ role: "main", ledger }).text)!;
    expect(unreserved.length + 2).toBeGreaterThan(SKILL_PROMPT_MAX_CHARS);
    const reserved = renderRoleSkillGuidance({ role: "main", ledger, hostReservedChars: MAIN_CRAFT_HOST_RESERVED_CHARS });
    const block = createMainCraftBlock(reserved.text)!;
    expect(block.length + 2).toBeLessThanOrEqual(SKILL_PROMPT_MAX_CHARS);
    expect(reserved.omissions.some((omission) => omission.reason === "budget")).toBe(true);
  });

  it("replaces the main-only craft block with the sub-agent's own guidance", () => {
    const main = createMainCraftBlock("main-only habits")!;
    expect(replaceMainCraftBlock(`Identity\n\n${main}\n\nMemory`, "search habits"))
      .toBe("Identity\n\nMemory\n\nsearch habits");
    expect(createMainCraftBlock(" ")).toBeUndefined();
  });
});
