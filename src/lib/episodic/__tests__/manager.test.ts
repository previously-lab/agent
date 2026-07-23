import { describe, it, expect } from "vitest";
import {
  parseSlice,
  serializeSlice,
  toIndexEntry,
  sliceIdToRelPath,
  sliceIdToFilePath,
  sliceIdToTimelineDir,
  sliceIdToAgentPath,
  sliceIdToLegacyFilePath,
} from "../manager";
import type { TimeSlice, Turn } from "../types";

// ─── Sample data ───────────────────────────────────────────────────────

const sampleTurns: Turn[] = [
  { timestamp: "2024-03-15T10:00:00.000Z", role: "user", content: "Hello, let's discuss the project.", turnId: "a3fk2w" },
  { timestamp: "2024-03-15T10:01:00.000Z", role: "agent", content: "Sure! What aspect of the project?", turnId: "a3fk2w" },
  { timestamp: "2024-03-15T10:02:00.000Z", role: "user", content: "The timeline and deliverables.", turnId: "b4gl3x" },
];

const sampleSlice: TimeSlice = {
  slice_id: "2024-03-15-1000",
  focus: "Project planning discussion",
  status: "closed",
  start: "2024-03-15T10:00:00.000Z",
  end: "2024-03-15T10:30:00.000Z",
  timezone: "America/Chicago",
  summary: "Discussed project timeline and deliverables for the corridor outreach program.",
  open_loops: ["Need to confirm budget numbers", "Follow up with Sharon about workshop schedule"],
  decisions: ["Use color-coded checklist format", "Schedule next review for Friday"],
  tags: ["work", "planning", "corridor-project"],
  related_slices: ["2024-03-08"],
  loops: [],
  emotional_tone: "neutral",
  turns: sampleTurns,
  estimatedTokens: 500,
  closedBy: "user_explicit",
};

// ─── serializeSlice ────────────────────────────────────────────────────

describe("serializeSlice", () => {
  it("produces valid markdown with YAML frontmatter", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("---");
    expect(md).toContain("2024-03-15"); // slice_id may be quoted
    expect(md).toContain("focus: Project planning discussion");
    expect(md).toContain("status: closed");
    expect(md).toContain("2024-03-15T10:00:00.000Z"); // start may be quoted
  });

  it("includes all turn headers in body with turnId labels", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("## Turn a3fk2w — 2024-03-15T10:00:00.000Z (user)");
    expect(md).toContain("## Turn a3fk2w — 2024-03-15T10:01:00.000Z (agent)");
    expect(md).toContain("## Turn b4gl3x — 2024-03-15T10:02:00.000Z (user)");
  });

  it("includes turn content after headers", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("Hello, let's discuss the project.");
    expect(md).toContain("Sure! What aspect of the project?");
  });

  it("includes list fields in frontmatter", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).toContain("open_loops:");
    expect(md).toContain("  - Need to confirm budget numbers");
    expect(md).toContain("decisions:");
    expect(md).toContain("  - Use color-coded checklist format");
    expect(md).toContain("tags:");
    expect(md).toContain("  - work");
  });

  it("omits undefined end field", () => {
    const noEnd = { ...sampleSlice, end: undefined };
    const md = serializeSlice(noEnd);
    expect(md).not.toContain("end:");
  });

  it("omits empty string fields", () => {
    const empty = { ...sampleSlice, focus: "", summary: "" };
    const md = serializeSlice(empty);
    // focus and summary are empty strings, should be omitted
    expect(md).not.toContain("focus: ");
    expect(md).not.toContain("summary: ");
  });

  it("handles slice with no turns", () => {
    const empty = { ...sampleSlice, turns: [] };
    const md = serializeSlice(empty);
    expect(md).toContain("---");
    // Body should be empty
    const parts = md.split("---\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── parseSlice ────────────────────────────────────────────────────────

describe("parseSlice", () => {
  it("roundtrips: serialize → parse returns equivalent data", () => {
    const md = serializeSlice(sampleSlice);
    const parsed = parseSlice(md);

    expect(parsed.slice_id).toBe(sampleSlice.slice_id);
    expect(parsed.focus).toBe(sampleSlice.focus);
    expect(parsed.status).toBe(sampleSlice.status);
    expect(parsed.start).toBe(sampleSlice.start);
    expect(parsed.end).toBe(sampleSlice.end);
    expect(parsed.timezone).toBe(sampleSlice.timezone);
    expect(parsed.summary).toBe(sampleSlice.summary);
    expect(parsed.open_loops).toEqual(sampleSlice.open_loops);
    expect(parsed.decisions).toEqual(sampleSlice.decisions);
    expect(parsed.tags).toEqual(sampleSlice.tags);
    expect(parsed.emotional_tone).toBe(sampleSlice.emotional_tone);
  });

  it("roundtrips turns correctly with turnId", () => {
    const md = serializeSlice(sampleSlice);
    const parsed = parseSlice(md);

    expect(parsed.turns).toHaveLength(sampleTurns.length);
    expect(parsed.turns[0].timestamp).toBe(sampleTurns[0].timestamp);
    expect(parsed.turns[0].role).toBe(sampleTurns[0].role);
    expect(parsed.turns[0].content).toBe(sampleTurns[0].content);
    expect(parsed.turns[0].turnId).toBe("a3fk2w");
    expect(parsed.turns[1].turnId).toBe("a3fk2w");
    expect(parsed.turns[2].turnId).toBe("b4gl3x");
  });

  it("parses em-dash turn headers correctly", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Message one

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Message two
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[1].role).toBe("agent");
  });

  it("handles empty body (no turns)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: empty slice
open_loops: []
decisions: []
tags: []
---
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(0);
  });

  it("handles multi-paragraph turn content", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Paragraph one.

Paragraph two.

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Single paragraph.
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].content).toContain("Paragraph one.");
    expect(parsed.turns[0].content).toContain("Paragraph two.");
  });

  it("defaults missing frontmatter fields", () => {
    const md = `---
slice_id: 2024-01-01
status: active
start: "2024-01-01T00:00:00.000Z"
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Hello
`;
    const parsed = parseSlice(md);
    expect(parsed.focus).toBe("");
    expect(parsed.summary).toBe("");
    expect(parsed.open_loops).toEqual([]);
    expect(parsed.decisions).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.timezone).toBe("UTC");
  });

  it("preserves markdown content in turns", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Here is a **bold** statement and a [link](https://example.com).

- list item 1
- list item 2
`;
    const parsed = parseSlice(md);
    expect(parsed.turns[0].content).toContain("**bold**");
    expect(parsed.turns[0].content).toContain("[link](https://example.com)");
    expect(parsed.turns[0].content).toContain("- list item 1");
  });
});

// ─── toIndexEntry ──────────────────────────────────────────────────────

describe("toIndexEntry", () => {
  it("uses full slice_id as id (YYYY-MM-DD-HHMM format)", () => {
    const entry = toIndexEntry(sampleSlice);
    expect(entry.id).toBe("2024-03-15-1000");
  });

  it("copies metadata fields correctly", () => {
    const entry = toIndexEntry(sampleSlice);
    expect(entry.focus).toBe(sampleSlice.focus);
    expect(entry.summary).toBe(sampleSlice.summary);
    expect(entry.tags).toEqual(sampleSlice.tags);
    expect(entry.status).toBe(sampleSlice.status);
    expect(entry.start).toBe(sampleSlice.start);
    expect(entry.open_loops).toEqual(sampleSlice.open_loops);
    expect(entry.decisions).toEqual(sampleSlice.decisions);
  });
});

// ─── sliceIdToRelPath / sliceIdToFilePath ──────────────────────────────

describe("sliceIdToRelPath", () => {
  it("maps a time-bearing id to a day-directory + HHMM path", () => {
    expect(sliceIdToRelPath("2026-07-10-1430")).toBe("2026/07/10/1430");
  });

  it("falls back to the legacy day path for a date-only id", () => {
    expect(sliceIdToRelPath("2026-07-10")).toBe("2026/07/10");
  });
});

describe("sliceIdToFilePath", () => {
  it("builds the core.md path under timeline/ for a time-bearing id", () => {
    expect(sliceIdToFilePath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/core.md"
    );
  });

  it("builds the core.md path for a date-only id", () => {
    expect(sliceIdToFilePath("2026-07-10")).toBe(
      "memory/episodic/slices/2026/07/10/timeline/core.md"
    );
  });
});

// ─── New directory-based path functions ────────────────────────────────

describe("sliceIdToTimelineDir", () => {
  it("builds the timeline directory path", () => {
    expect(sliceIdToTimelineDir("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline"
    );
  });
});

describe("sliceIdToAgentPath", () => {
  it("builds the agent.md path", () => {
    expect(sliceIdToAgentPath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/agent.md"
    );
  });
});

describe("sliceIdToLegacyFilePath", () => {
  it("builds the old flat .md path", () => {
    expect(sliceIdToLegacyFilePath("2026-07-10-1430")).toBe(
      "memory/episodic/slices/2026/07/10/1430.md"
    );
  });
});

// ─── Backward-compatible parsing ───────────────────────────────────────

describe("parseSlice — backward compatibility", () => {
  it("parses legacy turn headers (numeric index, no turnId)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Old format message

## Turn 2 — 2024-01-01T00:01:00.000Z (agent)

Old format reply
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].role).toBe("user");
    expect(parsed.turns[0].turnId).toBeUndefined();
    expect(parsed.turns[1].role).toBe("agent");
    expect(parsed.turns[1].turnId).toBeUndefined();
    expect(parsed.turns[0].content).toBe("Old format message");
  });

  it("parses new-format turn headers (base64url turnId)", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn a3fk2w — 2024-01-01T00:00:00.000Z (user)

New format message

## Turn b4gl3x — 2024-01-01T00:01:00.000Z (agent)

New format reply
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].turnId).toBe("a3fk2w");
    expect(parsed.turns[1].turnId).toBe("b4gl3x");
  });

  it("handles mixed old and new format turn headers", () => {
    const md = `---
slice_id: 2024-01-01
status: closed
start: "2024-01-01T00:00:00.000Z"
timezone: UTC
summary: test
open_loops: []
decisions: []
tags: []
---

## Turn 1 — 2024-01-01T00:00:00.000Z (user)

Legacy turn

## Turn x7_y9z — 2024-01-01T00:01:00.000Z (agent)

New turn
`;
    const parsed = parseSlice(md);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].turnId).toBeUndefined();  // legacy numeric
    expect(parsed.turns[1].turnId).toBe("x7_y9z");   // new base64url
  });
});

