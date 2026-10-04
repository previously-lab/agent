import { describe, it, expect } from "vitest";
import {
  foldSubtitleActivity,
  foldSubtitleLineLatest,
  type AnyPart,
  type SubtitleSource,
} from "@/lib/chat/subtitle-line";

// foldSubtitleActivity is the pure stream→caption reducer behind the pill's
// subtitle (the 2026-10-04 contract). These tests pin the hard rules: the
// subtitle captions WHAT THE AGENT IS DOING as ONE discrete block at a time,
// the latest activity signal wins (blocks replace, never grow), the reply's
// words never become the caption, and a closed turn folds to null.

function part(p: AnyPart): AnyPart {
  return p;
}

describe("foldSubtitleActivity — the activity ladder", () => {
  it("reads reasoning as thinking", () => {
    const line = foldSubtitleActivity([
      part({ type: "reasoning", text: "Let me think about this carefully..." }),
    ]);
    expect(line).toEqual({ activity: "thinking", count: 0 });
  });

  it("reads webSearch and webFetch as searching", () => {
    for (const toolName of ["webSearch", "webFetch"]) {
      const line = foldSubtitleActivity([
        part({ type: `tool-${toolName}`, toolCallId: "t1", toolName, state: "running" }),
      ]);
      expect(line?.activity).toBe("searching");
    }
  });

  it("reads the memory-read tools as recalling (the shared isRecallTool table)", () => {
    // One memory read lights "recalling" — the user-facing （正在回忆）.
    for (const toolName of [
      "readSlice",
      "readDoc",
      "readTimelineWindow",
      "listSlices",
      "listStrands",
      "listDocs",
    ]) {
      const line = foldSubtitleActivity([
        part({ type: `tool-${toolName}`, toolCallId: "t1", toolName, state: "running" }),
      ]);
      expect(line?.activity).toBe("recalling");
    }
  });

  it("reads thinkDeep as thinking", () => {
    const line = foldSubtitleActivity([
      part({ type: "tool-thinkDeep", toolCallId: "t1", toolName: "thinkDeep", state: "running" }),
    ]);
    expect(line?.activity).toBe("thinking");
  });

  it("reads non-memory tools as reading, counting DISTINCT tool calls", () => {
    // The AI SDK emits several parts per call across its lifecycle — the
    // count must be per toolCallId, not per part. (Memory-read tools are
    // "recalling", not "reading" — the fixtures here are the residual set.)
    const line = foldSubtitleActivity([
      part({ type: "tool-currentTime", toolCallId: "t1", toolName: "currentTime", state: "input-streaming" }),
      part({ type: "tool-currentTime", toolCallId: "t1", toolName: "currentTime", state: "output-available" }),
      part({ type: "tool-viewImage", toolCallId: "t2", toolName: "viewImage", state: "running" }),
    ]);
    expect(line).toEqual({ activity: "reading", count: 2 });
  });

  it("derives the tool name from the part type when toolName is absent", () => {
    const line = foldSubtitleActivity([
      part({ type: "tool-webSearch", toolCallId: "t1", state: "running" }),
    ]);
    expect(line?.activity).toBe("searching");
  });

  it("reads data-phase as housekeeping and data-evolution as evolving", () => {
    expect(
      foldSubtitleActivity([
        part({ type: "data-phase", data: { phase: "slice", running: true, compact: true } }),
      ])?.activity,
    ).toBe("housekeeping");
    expect(
      foldSubtitleActivity([
        part({ type: "data-evolution", data: { status: "running", step: "reviewing" } }),
      ])?.activity,
    ).toBe("evolving");
  });

  it("reads streamed text as replying — the words themselves never surface", () => {
    const line = foldSubtitleActivity([
      part({ type: "text", text: "The answer is simple." }),
    ]);
    expect(line?.activity).toBe("replying");
    expect(JSON.stringify(line)).not.toContain("answer");
  });

  it("ignores whitespace-only text", () => {
    const line = foldSubtitleActivity([
      part({ type: "reasoning", text: "hmm…" }),
      part({ type: "text", text: "  \n " }),
    ]);
    expect(line?.activity).toBe("thinking");
  });
});

describe("foldSubtitleActivity — blocks REPLACE each other", () => {
  it("lets the latest signal win across a whole turn", () => {
    const stream = [
      part({ type: "reasoning", text: "hmm…" }),
      part({ type: "tool-readSlice", toolCallId: "t1", toolName: "readSlice", state: "running" }),
      part({ type: "tool-webSearch", toolCallId: "t2", toolName: "webSearch", state: "running" }),
      part({ type: "text", text: "Here's what I found." }),
    ];
    const expected = ["thinking", "recalling", "searching", "replying"];
    for (let i = 1; i <= stream.length; i++) {
      expect(foldSubtitleActivity(stream.slice(0, i))?.activity).toBe(expected[i - 1]);
    }
  });

  it("is a pure fold: the same stream folds to the same block, every time", () => {
    const parts = [
      part({ type: "reasoning", text: "r" }),
      part({ type: "tool-readDoc", toolCallId: "t1", toolName: "readDoc", state: "running" }),
    ];
    const a = foldSubtitleActivity(parts);
    const b = foldSubtitleActivity(parts.map((p) => ({ ...p })));
    expect(a).toEqual(b);
  });
});

describe("foldSubtitleActivity — silence and closing", () => {
  it("ignores data-tool-progress narration entirely", () => {
    const line = foldSubtitleActivity([
      part({ type: "tool-readSlice", toolCallId: "t1", toolName: "readSlice", state: "running" }),
      part({
        type: "data-tool-progress",
        data: { toolCallId: "t1", text: "Searching slice 2024-11-02…", stage: "running" },
      }),
    ]);
    expect(line?.activity).toBe("recalling");
  });

  it("reads a brand-new assistant message (no parts) as thinking", () => {
    expect(foldSubtitleActivity([])).toEqual({ activity: "thinking", count: 0 });
  });

  it("returns null once the turn has closed (data-turn-status: done)", () => {
    const line = foldSubtitleActivity([
      part({ type: "reasoning", text: "hmm…" }),
      part({ type: "text", text: "Done." }),
      part({ type: "data-turn-status", data: { status: "done" } }),
    ]);
    expect(line).toBeNull();
  });

  it("keeps the last activity on a non-done terminal status (the caller's gate owns that)", () => {
    const line = foldSubtitleActivity([
      part({ type: "tool-readDoc", toolCallId: "t1", toolName: "readDoc", state: "running" }),
      part({ type: "data-turn-status", data: { status: "interrupted", error: "boom" } }),
    ]);
    expect(line?.activity).toBe("recalling");
  });
});

describe("foldSubtitleLineLatest — the newest LIVE turn speaks", () => {
  const live = (role: string, parts: AnyPart[]): SubtitleSource => ({
    role,
    parts,
    live: true,
  });
  const history = (role: string, parts: AnyPart[]): SubtitleSource => ({
    role,
    parts,
    live: false,
  });

  it("returns null for an empty list", () => {
    expect(foldSubtitleLineLatest([])).toBeNull();
  });

  it("returns null when nothing is live — history never captions activity", () => {
    const line = foldSubtitleLineLatest([
      history("assistant", [part({ type: "text", text: "You were here." })]),
    ]);
    expect(line).toBeNull();
  });

  it("reads a just-launched turn (newest live message is the user's) as thinking", () => {
    const line = foldSubtitleLineLatest([
      live("user", [part({ type: "text", text: "Where was I?" })]),
    ]);
    expect(line).toEqual({ activity: "thinking", count: 0 });
  });

  it("folds the newest live assistant message", () => {
    const line = foldSubtitleLineLatest([
      live("user", [part({ type: "text", text: "And then?" })]),
      live("assistant", [
        part({ type: "tool-webSearch", toolCallId: "t1", toolName: "webSearch", state: "running" }),
      ]),
    ]);
    expect(line?.activity).toBe("searching");
  });

  it("skips history entries between live messages", () => {
    const line = foldSubtitleLineLatest([
      history("assistant", [part({ type: "text", text: "Old words." })]),
      live("assistant", [part({ type: "reasoning", text: "hmm…" })]),
    ]);
    expect(line?.activity).toBe("thinking");
  });

  it("returns null when the newest live turn has closed", () => {
    const line = foldSubtitleLineLatest([
      live("user", [part({ type: "text", text: "Hi." })]),
      live("assistant", [
        part({ type: "text", text: "Hello." }),
        part({ type: "data-turn-status", data: { status: "done" } }),
      ]),
    ]);
    expect(line).toBeNull();
  });
});
