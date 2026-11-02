import { describe, expect, it } from "vitest";
import { composerEnterIntent } from "@/lib/chat/composer-keyboard";

const enter = { key: "Enter", keyCode: 13, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

describe("manuscript keyboard intent", () => {
  it("sends with Enter or Ctrl/Cmd, keeping Shift Enter as a native newline", () => {
    expect(composerEnterIntent(enter)).toBe("submit");
    expect(composerEnterIntent({ ...enter, shiftKey: true })).toBe("native");
    expect(composerEnterIntent({ ...enter, ctrlKey: true })).toBe("submit");
    expect(composerEnterIntent({ ...enter, metaKey: true })).toBe("submit");
  });
  it("never consumes composition confirmation, even with an open mention or a send shortcut", () => {
    for (const event of [{ ...enter, isComposing: true }, { ...enter, keyCode: 229 }]) {
      expect(composerEnterIntent({ ...event, ctrlKey: true }, { mentionOpen: true })).toBe("native");
    }
    expect(composerEnterIntent(enter, { composing: true, enterBehavior: "send" })).toBe("native");
  });
  it("keeps document selection and an explicit alternative Enter policy independent", () => {
    expect(composerEnterIntent(enter, { mentionOpen: true })).toBe("select-mention");
    expect(composerEnterIntent(enter, { enterBehavior: "send" })).toBe("submit");
    expect(composerEnterIntent(enter, { enterBehavior: "newline" })).toBe("native");
    expect(composerEnterIntent({ ...enter, shiftKey: true }, { enterBehavior: "send" })).toBe("native");
  });
});
