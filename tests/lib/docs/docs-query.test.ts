/**
 * Document query layer — extractSliceIds, the surviving reader-side helper
 * the doc_rework probe (§4.4) rides on.
 */
import { describe, it, expect } from "vitest";
import { extractSliceIds } from "@/lib/docs/docs-query";

describe("extractSliceIds", () => {
  it("finds slice ids embedded in prose, deduplicated", () => {
    const text =
      "证据见 2026-09-04-2130，又见 2026-09-05-1030；重申 2026-09-04-2130。";
    expect(extractSliceIds(text)).toEqual(["2026-09-04-2130", "2026-09-05-1030"]);
  });

  it("returns an empty array when the document cites no slices", () => {
    expect(extractSliceIds("没有任何引用。")).toEqual([]);
  });
});
