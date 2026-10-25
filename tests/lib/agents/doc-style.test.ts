import { describe, expect, it } from "vitest";
import { DOC_EPISTEMIC_RULE, DOC_HOUSE_STYLE } from "@/lib/agents/doc-style";

describe("shared memory-document epistemic contract", () => {
  it("separates evidence classes while allowing grounded interpretation and concern", () => {
    expect(DOC_EPISTEMIC_RULE).toContain("user reported");
    expect(DOC_EPISTEMIC_RULE).toContain("record directly shows");
    expect(DOC_EPISTEMIC_RULE).toContain("external source verified");
    expect(DOC_EPISTEMIC_RULE).toContain("your interpretation");
    expect(DOC_EPISTEMIC_RULE).toContain("what remains unknown");
    expect(DOC_EPISTEMIC_RULE).toContain("competing explanations");
    expect(DOC_EPISTEMIC_RULE).toContain("honest first-person concern");
    expect(DOC_EPISTEMIC_RULE).toContain("Do not perform emotion");
    expect(DOC_EPISTEMIC_RULE).toContain("not only people");
    expect(DOC_EPISTEMIC_RULE).toContain("user's raw records");
    expect(DOC_HOUSE_STYLE).toContain(DOC_EPISTEMIC_RULE);
    expect(DOC_HOUSE_STYLE).not.toContain("No speculation");
  });
});
