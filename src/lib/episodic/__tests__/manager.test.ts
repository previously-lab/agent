import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../io-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io-helpers")>();
  return { ...actual, fsReadFile: vi.fn(), fsWriteFile: vi.fn(), fsListFiles: vi.fn() };
});

import { fsReadFile, fsWriteFile, fsListFiles } from "../io-helpers";
import {
  parseSlice,
  serializeSlice,
  sliceIdToRelPath,
  sliceIdToFilePath,
  sliceIdToAgentPath,
  sliceIdToPreviouslyPath,
  emptyPreviouslyTemplate,
  readPreviously,
  ensurePreviously,
  readCurrentPreviously,
  writeCurrentPreviously,
  closeSlice,
  tryLoadTodaySlice,
  loadSlice,
} from "../manager";
import {
  sliceDir,
  slicePartPath,
  slicePartPathCandidates,
  legacySlicePartPath,
  indexPathCandidates,
  readSlicePart,
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
} from "../paths";
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
    expect(md).toContain("2024-03-15T10:00:00.000Z"); // start may be quoted
  });

  it("never writes status / tags / related_slices (v0.19 R2 header slimming)", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).not.toContain("status:");
    expect(md).not.toContain("tags:");
    expect(md).not.toContain("related_slices:");
    // The close record is closed_by alone — status derives from it on read.
    expect(md).toContain("closed_by: user_explicit");
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
    // tags / status are no longer written (R2 slimming): tags parse back as
    // empty, status derives from closed_by.
    expect(parsed.tags).toEqual([]);
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
  it("builds the new-root flat core.md path for a time-bearing id (v0.19 R2)", () => {
    expect(sliceIdToFilePath("2026-07-10-1430")).toBe(
      "memory/records/2026/07/10/1430/core.md"
    );
  });

  it("builds the core.md path for a date-only id", () => {
    expect(sliceIdToFilePath("2026-07-10")).toBe(
      "memory/records/2026/07/10/core.md"
    );
  });
});

// ─── paths.ts dual-root module (v0.19 R2) ────────────────────────────────

describe("paths — dual-root constants and builders", () => {
  it("writes target the new flat records layout (no timeline/ level)", () => {
    expect(sliceDir("2026-07-10-1430")).toBe("memory/records/2026/07/10/1430");
    expect(slicePartPath("2026-07-10-1430", "core")).toBe(
      "memory/records/2026/07/10/1430/core.md"
    );
    expect(slicePartPath("2026-07-10-1430", "agent")).toBe(
      "memory/records/2026/07/10/1430/agent.md"
    );
    expect(slicePartPath("2026-07-10-1430", "previously")).toBe(
      "memory/records/2026/07/10/1430/previously.md"
    );
  });

  it("maps the legacy layout (timeline/ level; previously at slice root)", () => {
    expect(legacySlicePartPath("2026-07-10-1430", "core")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/core.md"
    );
    expect(legacySlicePartPath("2026-07-10-1430", "agent")).toBe(
      "memory/episodic/slices/2026/07/10/1430/timeline/agent.md"
    );
    expect(legacySlicePartPath("2026-07-10-1430", "previously")).toBe(
      "memory/episodic/slices/2026/07/10/1430/previously.md"
    );
  });

  it("orders read candidates new-root first, legacy on a miss", () => {
    expect(slicePartPathCandidates("2026-07-10-1430", "core")).toEqual([
      "memory/records/2026/07/10/1430/core.md",
      "memory/episodic/slices/2026/07/10/1430/timeline/core.md",
    ]);
    expect(indexPathCandidates(2026, 7)).toEqual([
      "memory/records/2026/07/_index.json",
      "memory/episodic/slices/2026/07/_index.json",
    ]);
    expect(RECORDS_ROOT).toBe("memory/records");
    expect(LEGACY_SLICES_ROOT).toBe("memory/episodic/slices");
  });
});

describe("sliceIdToAgentPath", () => {
  it("builds the new-root agent.md path", () => {
    expect(sliceIdToAgentPath("2026-07-10-1430")).toBe(
      "memory/records/2026/07/10/1430/agent.md"
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

// ─── previously.md path ─────────────────────────────────────────────────

describe("sliceIdToPreviouslyPath", () => {
  it("builds the new-root previously.md path", () => {
    expect(sliceIdToPreviouslyPath("2026-07-10-1430")).toBe(
      "memory/records/2026/07/10/1430/previously.md",
    );
  });

  it("builds the previously.md path for a date-only id", () => {
    expect(sliceIdToPreviouslyPath("2026-07-10")).toBe(
      "memory/records/2026/07/10/previously.md",
    );
  });
});

// ─── emptyPreviouslyTemplate ────────────────────────────────────────────

describe("emptyPreviouslyTemplate", () => {
  it("is a user-card (v4) template with the active slice header", () => {
    const tmpl = emptyPreviouslyTemplate("2026-07-24-1445");
    expect(tmpl).toContain("# Previously On");
    expect(tmpl).toContain("_Active slice: 2026-07-24-1445");
    expect(tmpl).toContain("Format: user card");
  });
});

// ─── readPreviously / ensurePreviously (v3 migration on read) ────────────

const LEGACY_V2_PREVIOUSLY = `# Previously On

_Active slice: 2026-07-26-1539 | Updated: 2026-07-26T15:41:34.834Z_

## 长期记忆

### User identity

- 用户名叫 LikeDreamwalker
  evidence: [2026/07/26/1539-esXr7w] | confidence: medium | updated: 2026-07-26 | obs: 1

## 短期记忆
`;

describe("readPreviously (v3 migration on read)", () => {
  beforeEach(() => {
    vi.mocked(fsReadFile).mockReset();
    vi.mocked(fsWriteFile).mockReset();
    vi.mocked(fsListFiles).mockReset();
  });

  it("migrates legacy v2 content to the v3 structure so the model never sees v2", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(LEGACY_V2_PREVIOUSLY);
    const content = await readPreviously("2026-07-26-1539");
    expect(content).toContain("## User profile");
    expect(content).toContain("## Self-model");
    expect(content).not.toContain("## 长期记忆");
    expect(content).not.toContain("## 短期记忆");
    expect(content).toContain("用户名叫 LikeDreamwalker");
  });

  it("returns an empty string when the file does not exist", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("ENOENT"));
    await expect(readPreviously("2026-07-26-1539")).resolves.toBe("");
  });

  it("persists the migration once when ensurePreviously finds a legacy file", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(LEGACY_V2_PREVIOUSLY);
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-07-26-1539");
    // Legacy v2 folds into the user-card structure (v4), keeping the identity fact.
    expect(content).toContain("Format: user card");
    expect(content).toContain("用户名叫 LikeDreamwalker");
    // live card migration + the fresh per-slice copy.
    expect(fsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite already-v3 content in ensurePreviously", async () => {
    const v3 = emptyPreviouslyTemplate("2026-07-26-1539");
    vi.mocked(fsReadFile).mockResolvedValue(v3);
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    await ensurePreviously("2026-07-26-1539");
    expect(fsWriteFile).not.toHaveBeenCalled();
  });
});


// ─── Live current card (v0.7 real-time) ────────────────────────────────

describe("live current card (current-previously.md)", () => {
  const CARD_A = emptyPreviouslyTemplate("2026-08-09-1000");
  const CARD_B = emptyPreviouslyTemplate("2026-08-09-1100");

  beforeEach(() => {
    vi.mocked(fsReadFile).mockReset();
    vi.mocked(fsWriteFile).mockReset();
    vi.mocked(fsListFiles).mockReset();
  });

  it("returns the LIVE card and copies it to the per-slice file when they differ", async () => {
    vi.mocked(fsReadFile)
      .mockResolvedValueOnce(CARD_B) // readCurrentPreviously → live card
      .mockResolvedValueOnce(CARD_A); // readPreviouslyRaw(slice) → old copy
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-08-09-1000");
    expect(content).toBe(CARD_B);
    // The stale per-slice copy is overwritten with the fresh live card.
    expect(fsWriteFile).toHaveBeenCalledTimes(1);
  });

  it("seeds the live card from a template when it does not exist", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "", created: true });
    const content = await ensurePreviously("2026-08-09-1000");
    expect(content).toContain("Format: user card");
    // live card + per-slice copy (slice has none yet).
    expect(fsWriteFile).toHaveBeenCalledTimes(2);
  });

  it("round-trips readCurrentPreviously / writeCurrentPreviously", async () => {
    vi.mocked(fsReadFile).mockResolvedValue(CARD_A);
    await writeCurrentPreviously(CARD_A);
    expect(await readCurrentPreviously()).toBe(CARD_A);
  });
});

// ─── closedBy round-trip (v0.8) ──────────────────────────────────────────

describe("closedBy round-trip", () => {
  it("persists the real close signal in frontmatter and parses it back", () => {
    const closed = { ...sampleSlice, closedBy: "time_silence" as const };
    const md = serializeSlice(closed);
    expect(md).toContain("closed_by: time_silence");
    expect(parseSlice(md).closedBy).toBe("time_silence");
  });

  it("falls back to user_explicit for legacy closed slices without closed_by", () => {
    // Legacy files carry an explicit `status: closed`; the shim derives
    // closedBy from it when closed_by is absent.
    const md = serializeSlice({ ...sampleSlice, closedBy: undefined });
    expect(md).not.toContain("closed_by");
    const legacyMd = md.replace(/^---\n/, "---\nstatus: closed\n");
    expect(parseSlice(legacyMd).closedBy).toBe("user_explicit");
  });

  it("falls back to user_explicit for an unknown closed_by value", () => {
    const md = serializeSlice({
      ...sampleSlice,
      closedBy: "capacity" as const,
    })
      .replace("closed_by: capacity", "closed_by: bogus_signal")
      .replace(/^---\n/, "---\nstatus: closed\n");
    expect(parseSlice(md).closedBy).toBe("user_explicit");
  });

  it("leaves closedBy undefined on active slices", () => {
    const parsed = parseSlice(
      serializeSlice({
        ...sampleSlice,
        status: "active" as const,
        closedBy: undefined,
      }),
    );
    expect(parsed.closedBy).toBeUndefined();
  });

  it("round-trips the idle_gap close signal", () => {
    const closed = { ...sampleSlice, closedBy: "idle_gap" as const };
    const md = serializeSlice(closed);
    expect(md).toContain("closed_by: idle_gap");
    expect(parseSlice(md).closedBy).toBe("idle_gap");
  });
});

// ─── continuesFrom round-trip (checkpoint continuation link) ─────────────

describe("continuesFrom round-trip", () => {
  it("persists the continuation link in frontmatter and parses it back", () => {
    const slice = { ...sampleSlice, continuesFrom: "2024-03-15-0930" };
    const md = serializeSlice(slice);
    expect(md).toContain("continues_from: 2024-03-15-0930");
    expect(parseSlice(md).continuesFrom).toBe("2024-03-15-0930");
  });

  it("omits continues_from when unset", () => {
    const md = serializeSlice(sampleSlice);
    expect(md).not.toContain("continues_from");
    expect(parseSlice(md).continuesFrom).toBeUndefined();
  });
});

// ─── evolutionSummary round-trip (v0.9 slice-level prompt freeze) ─────────

describe("evolutionSummary round-trip", () => {
  it("persists the birth-evolution summary in frontmatter and parses it back", () => {
    const slice = {
      ...sampleSlice,
      evolutionSummary: "sharpened the profile around work stress",
    };
    const md = serializeSlice(slice);
    expect(md).toContain(
      "evolution_summary: sharpened the profile around work stress",
    );
    expect(parseSlice(md).evolutionSummary).toBe(
      "sharpened the profile around work stress",
    );
  });

  it("omits the field when no evolution ran and reads back undefined", () => {
    const md = serializeSlice({ ...sampleSlice, evolutionSummary: undefined });
    expect(md).not.toContain("evolution_summary");
    expect(parseSlice(md).evolutionSummary).toBeUndefined();
  });
});

// ─── KNOWN LIMITATION pin: turn-header collision ─────────────────────────
//
// parseTurns' header regex (/^## Turn (\S+) — (\S+) \((\w+)\)$/gm) matches ANY
// line shaped like a turn header — including one embedded in a message body
// (e.g. the user pastes a slice excerpt). Such a line splits one real turn
// into two parsed turns. This test PINS the current (wrong) behavior so a
// future fix deliberately flips it.

describe("parseSlice — turn-header collision (KNOWN LIMITATION pin)", () => {
  it("a body line shaped like a turn header currently splits the parse", () => {
    const md = serializeSlice({
      ...sampleSlice,
      turns: [
        {
          timestamp: "2024-03-15T10:00:00.000Z",
          role: "user" as const,
          content:
            "look at this line:\n## Turn abc — 2026-01-01T00:00:00Z (user)\nisn't it odd",
          turnId: "a3fk2w",
        },
      ],
    });
    const parsed = parseSlice(md);
    // 1 real user turn + 1 phantom turn parsed out of the message body.
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[1].turnId).toBe("abc");
    expect(parsed.turns[1].timestamp).toBe("2026-01-01T00:00:00Z");
    expect(parsed.turns[1].content).toBe("isn't it odd");
  });
});

// ─── closeSlice end semantics + cross-UTC-day recovery ───────────────────

describe("closeSlice — end is the conversation's last turn, not the close time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsWriteFile).mockResolvedValue({ path: "x", created: true });
    vi.mocked(fsReadFile).mockRejectedValue(new Error("not found"));
  });

  it("stamps end with the last turn's timestamp (lazy close may run hours later)", async () => {
    const slice: TimeSlice = {
      ...sampleSlice,
      status: "active",
      end: undefined,
      tags: [],
      turns: sampleTurns,
    };
    const closed = await closeSlice(slice, "time_silence");
    expect(closed.end).toBe("2024-03-15T10:02:00.000Z");
  });

  it("falls back to now for a turn-less slice", async () => {
    const slice: TimeSlice = {
      ...sampleSlice,
      status: "active",
      end: undefined,
      tags: [],
      turns: [],
    };
    const closed = await closeSlice(slice, "capacity");
    expect(closed.end).toBeDefined();
    expect(Number.isNaN(Date.parse(closed.end!))).toBe(false);
  });
});

describe("tryLoadTodaySlice — UTC-day-boundary fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recovers a still-active slice from YESTERDAY's UTC directory", async () => {
    const now = new Date();
    const y = new Date(now.getTime() - 86_400_000);
    const dirOf = (root: string, d: Date) =>
      `${root}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    const yesterdayLegacyDir = dirOf(LEGACY_SLICES_ROOT, y);

    vi.mocked(fsListFiles).mockImplementation(async (dir: string) => {
      if (dir === yesterdayLegacyDir)
        return [{ name: "2330", path: `${yesterdayLegacyDir}/2330`, type: "dir" as const }];
      return [];
    });
    vi.mocked(fsReadFile).mockResolvedValue(
      serializeSlice({ ...sampleSlice, status: "active", end: undefined, closedBy: undefined }),
    );

    const recovered = await tryLoadTodaySlice();
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe("active");
    // Scan order: today's records root, today's legacy root, then yesterday's
    // records root, yesterday's legacy root (where the slice lives).
    expect(vi.mocked(fsListFiles).mock.calls.map((c) => c[0])).toEqual([
      dirOf(RECORDS_ROOT, now),
      dirOf(LEGACY_SLICES_ROOT, now),
      dirOf(RECORDS_ROOT, y),
      yesterdayLegacyDir,
    ]);
  });

  it("returns null when neither today nor yesterday holds an active slice", async () => {
    vi.mocked(fsListFiles).mockResolvedValue([]);
    expect(await tryLoadTodaySlice()).toBeNull();
  });
});

// ─── Dual-root mixed storage: parse equivalence (v0.19 R2) ──────────────

describe("dual-root mixed storage — parse equivalence", () => {
  const ID = "2024-03-15-1000";

  /** The same slice in the legacy on-disk format (status/tags written, no closed_by). */
  function legacyMarkdown(): string {
    return serializeSlice({ ...sampleSlice, closedBy: undefined }).replace(
      /^---\n/,
      "---\nstatus: closed\ntags:\n  - work\n  - planning\nrelated_slices: []\n",
    );
  }

  /** The same slice in the new format (closed_by alone; no status/tags/related_slices). */
  function newMarkdown(): string {
    return serializeSlice(sampleSlice); // closedBy: "user_explicit"
  }

  beforeEach(() => vi.clearAllMocks());

  it("loadSlice dual-reads: a new-root hit never touches the legacy path", async () => {
    vi.mocked(fsReadFile).mockImplementation(async (p: string) => {
      if (p === slicePartPath(ID, "core")) return newMarkdown();
      throw new Error(`unexpected read: ${p}`);
    });
    const slice = await loadSlice(ID);
    expect(slice).not.toBeNull();
    expect(vi.mocked(fsReadFile).mock.calls.map((c) => c[0])).toEqual([
      slicePartPath(ID, "core"),
    ]);
  });

  it("loadSlice falls back to the legacy root on a new-root miss", async () => {
    vi.mocked(fsReadFile).mockImplementation(async (p: string) => {
      if (p === legacySlicePartPath(ID, "core")) return legacyMarkdown();
      throw new Error(`not found: ${p}`);
    });
    const slice = await loadSlice(ID);
    expect(slice).not.toBeNull();
    expect(vi.mocked(fsReadFile).mock.calls.map((c) => c[0])).toEqual([
      slicePartPath(ID, "core"),
      legacySlicePartPath(ID, "core"),
    ]);
  });

  it("parses the legacy and new formats into an equivalent TimeSlice", async () => {
    vi.mocked(fsReadFile).mockImplementation(async (p: string) => {
      if (p === legacySlicePartPath(ID, "core")) return legacyMarkdown();
      throw new Error(`not found: ${p}`);
    });
    const fromLegacy = (await loadSlice(ID))!;

    vi.mocked(fsReadFile).mockImplementation(async (p: string) => {
      if (p === slicePartPath(ID, "core")) return newMarkdown();
      throw new Error(`not found: ${p}`);
    });
    const fromRecords = (await loadSlice(ID))!;

    // The shim aligns the derived fields: a legacy `status: closed` without
    // closed_by means user_explicit; the new format carries closed_by alone.
    expect(fromLegacy.status).toBe("closed");
    expect(fromRecords.status).toBe("closed");
    expect(fromLegacy.closedBy).toBe("user_explicit");
    expect(fromRecords.closedBy).toBe("user_explicit");
    expect(fromLegacy.turns).toEqual(fromRecords.turns);
    expect(fromLegacy.focus).toBe(fromRecords.focus);
    expect(fromLegacy.summary).toBe(fromRecords.summary);
    expect(fromLegacy.start).toBe(fromRecords.start);
    expect(fromLegacy.end).toBe(fromRecords.end);
    // tags stay READABLE off legacy headers but are never written anew.
    expect(fromLegacy.tags).toEqual(["work", "planning"]);
    expect(fromRecords.tags).toEqual([]);
  });

  it("loadSlice returns null when BOTH roots miss", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("gone"));
    expect(await loadSlice(ID)).toBeNull();
  });

  it("readSlicePart throws only when both candidates miss", async () => {
    vi.mocked(fsReadFile).mockRejectedValue(new Error("gone"));
    await expect(readSlicePart(ID, "core")).rejects.toThrow();
  });
});
