import { describe, expect, it } from "vitest";
import { findImageMarkers, imageMarkerText, insertImageMarker, selectedImageMarker } from "@/lib/chat/image-markers";

describe("stable image marker bindings", () => {
  const bindings = Object.freeze([{ id: "photo-b", ordinal: 2 }, { id: "photo-a", ordinal: 1 }]);
  it("binds by assigned ordinal, preserving ids across reorder/removal and repeated references", () => {
    const text = "看〔图2〕，再看〔图1〕和〔图2〕。";
    expect(findImageMarkers(text, bindings).map(m => m.id)).toEqual(["photo-b", "photo-a", "photo-b"]);
    expect(findImageMarkers(text, bindings.slice(0, 1)).map(m => m.id)).toEqual(["photo-b", "photo-b"]);
    expect(imageMarkerText(2)).toBe("〔图2〕");
  });
  it("keeps unknown or conflicting labels as literal text", () => {
    expect(findImageMarkers("〔图1〕〔图0〕〔图03〕〔图99〕", [{ id: "a", ordinal: 1 }, { id: "b", ordinal: 1 }])).toEqual([]);
    expect(() => imageMarkerText(0)).toThrow(RangeError);
  });
  it("locates one selected marker without guessing when a passage spans two", () => {
    const text = "〔图1〕和〔图2〕";
    expect(selectedImageMarker(text, { start: 1, end: 3 }, bindings)?.id).toBe("photo-a");
    expect(selectedImageMarker(text, { start: 7, end: 7 }, bindings)?.id).toBe("photo-b");
    expect(selectedImageMarker(text, { start: 0, end: text.length }, bindings)).toBeNull();
  });
  it("inserts after selected prose without deleting it, and leaves attachments unchanged when text is removed", () => {
    expect(insertImageMarker("保留这段文字", 4, 2)).toEqual({ text: "保留这段〔图2〕文字", caret: 8 });
    expect(findImageMarkers("引用已删除", bindings)).toEqual([]);
    expect(bindings).toHaveLength(2);
  });
});
