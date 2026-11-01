import { describe, expect, it } from "vitest";
import { getComposerState } from "@/lib/chat/composer-state";

describe("manuscript composer state", () => {
  it("stays mini only while empty and unfocused", () => {
    expect(getComposerState({ focused: false, value: "", attachmentCount: 0, mentionOpen: false, isLoading: false })).toBe("idle");
    expect(getComposerState({ focused: true, value: "", attachmentCount: 0, mentionOpen: false, isLoading: false })).toBe("editing");
  });

  it.each([
    { focused: false, value: "draft", attachmentCount: 0, mentionOpen: false },
    { focused: false, value: "", attachmentCount: 1, mentionOpen: false },
    { focused: false, value: "", attachmentCount: 0, mentionOpen: true },
  ])("keeps editing active for retained composer content: %o", (input) => {
    expect(getComposerState({ ...input, isLoading: false })).toBe("editing");
  });

  it("exposes an in-flight run without disabling further composition", () => {
    expect(getComposerState({ focused: true, value: "follow-up", attachmentCount: 0, mentionOpen: false, isLoading: true })).toBe("sending");
  });
});
