import { describe, it, expect } from "vitest";
import { applyMetadataUpdates } from "../maintenance";
import type { SliceMetadata } from "../maintenance";

function makeMeta(overrides: Partial<SliceMetadata> = {}): SliceMetadata {
  return {
    slice_id: "2024-03-15",
    focus: "Original focus",
    summary: "Original summary",
    open_loops: ["loop-1"],
    decisions: ["decision-1"],
    tags: ["work"],
    emotional_tone: "neutral",
    ...overrides,
  };
}

describe("applyMetadataUpdates", () => {
  it("does nothing when updates is null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, null);
    expect(meta.focus).toBe("Original focus");
    expect(meta.summary).toBe("Original summary");
    expect(meta.open_loops).toEqual(["loop-1"]);
    expect(meta.decisions).toEqual(["decision-1"]);
    expect(meta.tags).toEqual(["work"]);
    expect(meta.emotional_tone).toBe("neutral");
  });

  it("updates only provided fields", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: "New focus" });
    expect(meta.focus).toBe("New focus");
    expect(meta.summary).toBe("Original summary"); // unchanged
  });

  it("updates all fields when all provided", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, {
      focus: "New focus",
      summary: "New summary",
      open_loops: ["loop-2", "loop-3"],
      decisions: ["decision-2"],
      tags: ["personal"],
      emotional_tone: "positive",
    });
    expect(meta.focus).toBe("New focus");
    expect(meta.summary).toBe("New summary");
    expect(meta.open_loops).toEqual(["loop-2", "loop-3"]);
    expect(meta.decisions).toEqual(["decision-2"]);
    expect(meta.tags).toEqual(["personal"]);
    expect(meta.emotional_tone).toBe("positive");
  });

  it("clears array field when set to null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { open_loops: null });
    expect(meta.open_loops).toEqual([]);
  });

  it("clears string field when set to null", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: null });
    expect(meta.focus).toBe("");
  });

  it("does not clear field when undefined (omitted)", () => {
    const meta = makeMeta({ focus: "Keep me" });
    applyMetadataUpdates(meta, { summary: "Updated" });
    // focus is undefined in updates, should not be touched
    expect(meta.focus).toBe("Keep me");
    expect(meta.summary).toBe("Updated");
  });

  it("handles empty updates object", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, {});
    expect(meta.focus).toBe("Original focus");
  });

  it("preserves slice_id through updates", () => {
    const meta = makeMeta();
    applyMetadataUpdates(meta, { focus: "Changed" });
    expect(meta.slice_id).toBe("2024-03-15");
  });
});
