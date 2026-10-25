import { describe, expect, it } from "vitest";
import { SHARED_SUBAGENT_BASE } from "@/lib/agents/prompts";

describe("SHARED_SUBAGENT_BASE", () => {
  it("does not treat generated presentation as evidence about the user", () => {
    expect(SHARED_SUBAGENT_BASE).toContain("Generated HTML/JavaScript");
    expect(SHARED_SUBAGENT_BASE).toContain("sample data");
    expect(SHARED_SUBAGENT_BASE).toContain("controls and their default values");
    expect(SHARED_SUBAGENT_BASE).toContain("local UI state");
    expect(SHARED_SUBAGENT_BASE).toContain("[Interactive visual omitted]");
    expect(SHARED_SUBAGENT_BASE).toContain("Confirm actual facts from user statements and surrounding prose");
  });
});
