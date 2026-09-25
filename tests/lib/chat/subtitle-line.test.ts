import { describe, it, expect } from "vitest";
import {
  foldSubtitleLine,
  foldSubtitleLineLatest,
  collapseSubtitleWhitespace,
  truncateSubtitleText,
  SUBTITLE_LINE_MAX,
  type AnyPart,
  type SubtitleSource,
} from "@/lib/chat/subtitle-line";

// foldSubtitleLine is the pure stream→subtitle reducer behind the permanent
// pill strip (design v0.13 §4). These tests pin the hard product rules: only
// spoken words ever become text, tool/reasoning activity surfaces only as
// status, streaming growth is a deterministic fold, and truncation keeps the
// text inside the two-line budget with an honest `truncated` flag.

function part(p: AnyPart): AnyPart {
  return p;
}

describe("foldSubtitleLine — skipping parts", () => {
  it("never shows reasoning content in the text", () => {
    const line = foldSubtitleLine(
      [
        part({ type: "reasoning", text: "Let me think about this carefully..." }),
        part({ type: "text", text: "The answer is simple." }),
      ],
      "assistant",
    );
    expect(line.text).toBe("The answer is simple.");
    expect(line.text).not.toContain("think");
  });

  it("never shows tool names, inputs or outputs in the text", () => {
    const line = foldSubtitleLine(
      [
        part({
          type: "tool-recall",
          toolCallId: "t1",
          toolName: "recall",
          state: "output-available",
          input: { query: "solar panels" },
          output: { slices: [] },
        }),
        part({ type: "text", text: "I checked your notes." }),
      ],
      "assistant",
    );
    expect(line.text).toBe("I checked your notes.");
    expect(line.text).not.toContain("recall");
  });

  it("ignores data-tool-progress narration even though it is streamed text", () => {
    const line = foldSubtitleLine(
      [
        part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "running" }),
        part({
          type: "data-tool-progress",
          data: { toolCallId: "t1", text: "Searching slice 2024-11-02…", stage: "running" },
        }),
      ],
      "assistant",
    );
    expect(line.text).toBe("");
  });

  it("ignores housekeeping phases, evolution chunks and terminal status parts", () => {
    const line = foldSubtitleLine(
      [
        part({ type: "data-phase", data: { phase: "slice", running: true, compact: true } }),
        part({ type: "data-evolution", data: { status: "running", step: "reviewing" } }),
        part({ type: "data-turn-status", data: { status: "interrupted", error: "boom" } }),
      ],
      "assistant",
    );
    expect(line.text).toBe("");
    expect(line.status).toBeNull();
  });
});

describe("foldSubtitleLine — status ladder", () => {
  it("reports thinking while only reasoning has arrived", () => {
    const line = foldSubtitleLine(
      [part({ type: "reasoning", text: "hmm…" })],
      "assistant",
    );
    expect(line).toMatchObject({ text: "", status: { kind: "thinking" } });
  });

  it("reports reading with the distinct tool-call count once tools start", () => {
    // The AI SDK emits several parts per call across its lifecycle — the
    // count must be per toolCallId, not per part.
    const line = foldSubtitleLine(
      [
        part({ type: "reasoning", text: "hmm…" }),
        part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "input-streaming" }),
        part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "output-available" }),
        part({ type: "tool-readFile", toolCallId: "t2", toolName: "readFile", state: "running" }),
      ],
      "assistant",
    );
    expect(line.status).toEqual({ kind: "reading", count: 2 });
  });

  it("drops status to null as soon as any text exists", () => {
    const line = foldSubtitleLine(
      [
        part({ type: "reasoning", text: "hmm…" }),
        part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "running" }),
        part({ type: "text", text: "So — " }),
        part({ type: "text", text: "here's what I found." }),
      ],
      "assistant",
    );
    expect(line).toMatchObject({
      text: "So — here's what I found.",
      status: null,
    });
  });

  it("returns null status before anything has happened", () => {
    expect(foldSubtitleLine([], "assistant").status).toBeNull();
  });
});

describe("foldSubtitleLine — streaming growth is a fold", () => {
  it("yields the same line for every prefix of the same stream", () => {
    const full = [
      part({ type: "reasoning", text: "thinking…" }),
      part({ type: "text", text: "Hello " }),
      part({ type: "text", text: "world, " }),
      part({ type: "text", text: "this grew." }),
    ];
    const grown: ReturnType<typeof foldSubtitleLine>[] = [];
    for (let i = 1; i <= full.length; i++) {
      grown.push(foldSubtitleLine(full.slice(0, i), "assistant"));
    }
    const finalLine = foldSubtitleLine(full, "assistant");
    expect(grown[grown.length - 1]).toEqual(finalLine);
    // Growth is prefix-preserving: while untruncated, each step's text starts
    // with the previous step's text, and the final line equals a one-shot fold.
    for (let i = 1; i < grown.length; i++) {
      if (!grown[i].truncated) {
        expect(grown[i].text.startsWith(grown[i - 1].text)).toBe(true);
      }
    }
  });

  it("handles the bridge authoritative re-emit replacing advisory text", () => {
    const line = foldSubtitleLine(
      [
        part({ type: "text", text: "Advisory draft that " }),
        part({
          type: "text",
          text: "the result wins.",
          providerMetadata: { "previously-bridge": { authoritative: true } },
        }),
      ],
      "assistant",
    );
    expect(line.text).toBe("the result wins.");
  });
});

describe("foldSubtitleLine — character budget and truncation", () => {
  it("collapses newlines and whitespace runs into one line", () => {
    const line = foldSubtitleLine(
      [
        part({
          type: "text",
          text: "First paragraph.\n\nSecond   paragraph\twith   spaces.\n\n\nThird.",
        }),
      ],
      "assistant",
    );
    expect(line.text).toBe("First paragraph. Second paragraph with spaces. Third.");
    expect(line.truncated).toBe(false);
  });

  it("truncates past the cap and sets truncated", () => {
    const long = "word ".repeat(60).trim(); // ~300 chars
    const line = foldSubtitleLine([part({ type: "text", text: long })], "assistant");
    expect(line.text.length).toBeLessThanOrEqual(SUBTITLE_LINE_MAX);
    expect(line.truncated).toBe(true);
  });

  it("keeps a two-line opening whole under the raised cap", () => {
    // The pill subtitle wraps to at most two ~75-character mono lines, so the
    // cap was raised past the old one-line 120: an opening of 121–150 chars
    // must survive intact, and only text beyond the cap is cut.
    const text = "word ".repeat(28).trim(); // 139 chars
    const line = foldSubtitleLine([part({ type: "text", text })], "assistant");
    expect(line.text).toBe(text);
    expect(line.truncated).toBe(false);
  });

  it("does not cut mid-word when a boundary is within slack of the cap", () => {
    const text = `${"a".repeat(SUBTITLE_LINE_MAX - 10)} boundaryword tail that pushes past`;
    const { text: cut, truncated } = truncateSubtitleText(text);
    expect(truncated).toBe(true);
    // The cut landed before "boundaryword" (its start is at MAX-20+1, inside
    // the slack window), so the line must not end mid-word.
    expect(cut.endsWith("boundaryword")).toBe(false);
    expect(/\s/.test(cut)).toBe(false);
  });

  it("keeps short text untruncated", () => {
    const line = foldSubtitleLine([part({ type: "text", text: "Hi." })], "assistant");
    expect(line).toMatchObject({ text: "Hi.", truncated: false, status: null });
  });

  it("strips dangling punctuation left by a word-boundary cut", () => {
    const text = `${"x".repeat(SUBTITLE_LINE_MAX - 10)}. more words here`;
    const { text: cut } = truncateSubtitleText(text);
    expect(cut.endsWith(".")).toBe(false);
  });
});

describe("foldSubtitleLine — speakers", () => {
  it("labels user messages as user", () => {
    const line = foldSubtitleLine(
      [part({ type: "text", text: "Where was I?" })],
      "user",
    );
    expect(line.speaker).toBe("user");
  });

  it("labels assistant output as persona", () => {
    const line = foldSubtitleLine(
      [part({ type: "text", text: "You were here." })],
      "assistant",
    );
    expect(line.speaker).toBe("persona");
  });

  it("counts user attachment file parts as no spoken words", () => {
    const line = foldSubtitleLine(
      [part({ type: "file", mediaType: "image/png", url: "data:…" })],
      "user",
    );
    expect(line).toMatchObject({ speaker: "user", text: "", status: null });
  });
});

describe("foldSubtitleLine — determinism", () => {
  it("folds the same stream to the same line, every time", () => {
    const parts = [
      part({ type: "reasoning", text: "r" }),
      part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "running" }),
      part({ type: "text", text: "Deterministic " }),
      part({ type: "text", text: "output." }),
    ];
    const a = foldSubtitleLine(parts, "assistant");
    const b = foldSubtitleLine(parts.map((p) => ({ ...p })), "assistant");
    expect(a).toEqual(b);
  });
});

describe("foldSubtitleLineLatest — the strip shows the newest message WITH speakable text", () => {
  const msg = (role: string, parts: AnyPart[]): SubtitleSource => ({
    role,
    parts,
  });

  it("returns null for an empty message list", () => {
    expect(foldSubtitleLineLatest([])).toBeNull();
  });

  it("folds the newest message when it has text", () => {
    const line = foldSubtitleLineLatest([
      msg("user", [part({ type: "text", text: "Where was I?" })]),
      msg("assistant", [part({ type: "text", text: "You were here." })]),
    ]);
    expect(line).toMatchObject({ speaker: "persona", text: "You were here." });
  });

  it("walks back past a data-only newest message to the newest message with text", () => {
    // The failing first-load case: the newest entry carries only tool /
    // housekeeping traffic while an older turn still has words on record —
    // the strip must quote the older turn, not go blank.
    const line = foldSubtitleLineLatest([
      msg("user", [part({ type: "text", text: "And then?" })]),
      msg("assistant", [part({ type: "text", text: "The next morning…" })]),
      msg("assistant", [
        part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "running" }),
        part({ type: "data-turn-status", data: { status: "done" } }),
      ]),
    ]);
    expect(line).toMatchObject({ speaker: "persona", text: "The next morning…" });
  });

  it("walks back past an attachment-only user message", () => {
    const line = foldSubtitleLineLatest([
      msg("assistant", [part({ type: "text", text: "I see the photo." })]),
      msg("user", [part({ type: "file", mediaType: "image/png", url: "data:…" })]),
    ]);
    expect(line).toMatchObject({ speaker: "persona", text: "I see the photo." });
  });

  it("shows the in-flight turn's status when nothing has text yet", () => {
    // The walk's only fallback: nothing speakable ANYWHERE (the user's
    // latest was an attachment, the assistant's latest is tool traffic) —
    // then the newest fold wins, which is how a reading prefix surfaces.
    const line = foldSubtitleLineLatest([
      msg("user", [part({ type: "file", mediaType: "image/png", url: "data:…" })]),
      msg("assistant", [part({ type: "tool-recall", toolCallId: "t1", toolName: "recall", state: "running" })]),
    ]);
    expect(line).toMatchObject({ text: "", status: { kind: "reading", count: 1 } });
  });

  it("shows thinking when the newest turn has reasoning and nothing else", () => {
    const line = foldSubtitleLineLatest([
      msg("assistant", [part({ type: "reasoning", text: "hmm…" })]),
    ]);
    expect(line).toMatchObject({ text: "", status: { kind: "thinking" } });
  });

  it("renders an empty line only when the whole list is silent", () => {
    const line = foldSubtitleLineLatest([
      msg("assistant", [
        part({ type: "data-phase", data: { phase: "slice", running: true, compact: true } }),
      ]),
    ]);
    expect(line).toMatchObject({ text: "", status: null });
  });
});

describe("collapseSubtitleWhitespace / truncateSubtitleText", () => {
  it("trims and collapses", () => {
    expect(collapseSubtitleWhitespace("  a\n\n b\t c  ")).toBe("a b c");
  });

  it("hard-cuts when no boundary is within slack", () => {
    const text = "x".repeat(SUBTITLE_LINE_MAX + 50);
    const { text: cut, truncated } = truncateSubtitleText(text);
    expect(truncated).toBe(true);
    expect(cut.length).toBe(SUBTITLE_LINE_MAX);
  });

  it("respects a custom max", () => {
    const { text, truncated } = truncateSubtitleText("hello world, again", 11);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(11);
    expect(text).toBe("hello");
  });
});
