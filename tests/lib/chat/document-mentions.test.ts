import { describe, expect, it } from "vitest";
import {
  findDocumentMentionRange,
  isImeKeyboardEvent,
  nextDocumentMentionIndex,
  removeDocumentMentionRange,
} from "@/lib/chat/document-mentions";

describe("document mention keyboard and IME helpers", () => {
  it("finds a typed mention and removes only its trigger text", () => {
    const value = "Compare @项目 notes and @休息 with this";
    const at = value.indexOf("@休息");
    const caret = at + "@休息".length;
    const range = findDocumentMentionRange(value, caret);
    expect(range).toEqual({ start: at, end: caret, query: "休息" });
    expect(removeDocumentMentionRange(value, range!)).toBe("Compare @项目 notes and  with this");
  });

  it("does not treat emails or oversized/newline queries as mentions", () => {
    expect(findDocumentMentionRange("person@example.com", "person@example.com".length)).toBeNull();
    expect(findDocumentMentionRange("@one\n two", 9)).toBeNull();
    expect(findDocumentMentionRange(`@${"x".repeat(121)}`, 122)).toBeNull();
    expect(findDocumentMentionRange("plain text", 5)).toBeNull();
  });

  it("wraps arrows and supports Home/End without submitting while composing", () => {
    expect(nextDocumentMentionIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(nextDocumentMentionIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextDocumentMentionIndex(2, 3, "ArrowDown")).toBe(0);
    expect(nextDocumentMentionIndex(1, 3, "Home")).toBe(0);
    expect(nextDocumentMentionIndex(1, 3, "End")).toBe(2);
    expect(nextDocumentMentionIndex(0, 0, "ArrowDown")).toBe(-1);
    expect(isImeKeyboardEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKeyboardEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKeyboardEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
