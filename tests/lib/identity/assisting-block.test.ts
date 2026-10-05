import { describe, it, expect } from "vitest";
import {
  ASSISTING_BLOCK_HEADER,
  buildAssistingBlock,
  splitIdentityPrompt,
} from "@/lib/identity/assisting-block";
import { buildAgentIdentityPrompt } from "@/lib/identity";

const PROFILE = {
  name: "Alan",
  addressAs: "Dream",
  timezone: "Asia/Shanghai",
  body: "AI 全栈工程师，回答请简短。",
};

describe("buildAssistingBlock", () => {
  it("returns '' for a null profile and for a profile with no content", () => {
    expect(buildAssistingBlock(null)).toBe("");
    expect(buildAssistingBlock({ name: "", body: "" })).toBe("");
  });

  it("renders the identity head lines plus the body under the header", () => {
    const block = buildAssistingBlock(PROFILE);
    expect(block.startsWith(ASSISTING_BLOCK_HEADER)).toBe(true);
    expect(block).toContain("Name: Alan");
    expect(block).toContain("Address them as: Dream");
    expect(block).toContain("Timezone: Asia/Shanghai");
    expect(block).toContain("AI 全栈工程师");
  });
});

describe("splitIdentityPrompt", () => {
  it("a prompt with no assisting tail yields assisting '' and the charter untouched", () => {
    expect(splitIdentityPrompt("THE CHARTER")).toEqual({
      charter: "THE CHARTER",
      assisting: "",
    });
  });

  it("splits at the assisting header and round-trips byte-exactly", () => {
    const full = `THE CHARTER\n\n${ASSISTING_BLOCK_HEADER}\nName: Alan\n\nbody text`;
    const { charter, assisting } = splitIdentityPrompt(full);
    expect(charter).toBe("THE CHARTER");
    expect(assisting.startsWith(ASSISTING_BLOCK_HEADER)).toBe(true);
    expect(charter).not.toContain(ASSISTING_BLOCK_HEADER);
    expect(assisting ? `${charter}\n\n${assisting}` : charter).toBe(full);
  });
});

describe("buildAgentIdentityPrompt + splitIdentityPrompt round-trip", () => {
  it("the composed prompt splits back into charter + the same assisting block", () => {
    const full = buildAgentIdentityPrompt(PROFILE);
    const { charter, assisting } = splitIdentityPrompt(full);
    expect(assisting).toBe(buildAssistingBlock(PROFILE));
    expect(`${charter}\n\n${assisting}`).toBe(full);
    // The charter leads and carries no assisting header of its own.
    expect(full.indexOf(ASSISTING_BLOCK_HEADER)).toBeGreaterThan(0);
    expect(charter).not.toContain(ASSISTING_BLOCK_HEADER);
  });

  it("a null profile composes to the bare charter — nothing to split off", () => {
    const full = buildAgentIdentityPrompt(null);
    expect(full).not.toContain(ASSISTING_BLOCK_HEADER);
    expect(splitIdentityPrompt(full)).toEqual({ charter: full, assisting: "" });
  });
});
