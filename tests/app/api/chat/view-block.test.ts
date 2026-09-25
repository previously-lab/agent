/**
 * View injection (v0.13 §5 视野注入) — the contract tests.
 *
 * Two separate pieces, pinned separately:
 *
 *  - STABLE LAYER — SPACE_FICTION_BLOCK: a constant inside
 *    assembleSystemPrompt (turn-workflow.ts), stating the product's fiction
 *    once plus the lobby default. It must sit in the L0 prefix (right after
 *    the identity) and never vary per turn.
 *  - PER-TURN BLOCK — buildViewBlock (view-block.ts): ONE compact "[当前] …"
 *    line for the two surfaces (room / card), rendered from the same sources
 *    the surfaces derive from. It is injected into the OUTBOUND tail of the
 *    last user message (appendBridgeTimeSuffix, pinned by
 *    machine-context.test.ts) — never the user text, never persisted.
 *
 * The request field travels as `view` (route → startTurn → TurnInput) and is
 * gated by sanitizeView: malformed shapes drop the field entirely, exactly
 * like the lobby default, so a bad client degrades to NO block, never a
 * broken one.
 */
import { describe, it, expect } from "vitest";
import type { TimelineIndex } from "@/lib/episodic";
import {
  assembleSystemPrompt,
  SPACE_FICTION_BLOCK,
} from "@/app/api/chat/turn-workflow";
import { buildViewBlock } from "@/app/api/chat/view-block";
import { sanitizeView } from "@/app/api/chat/start-turn";

const IDENTITY = "THE CHARTER";
const PREVIOUSLY = "# Previously card";
const SLICE_HEAD =
  "## This slice — snapshot at its start\n- Slice started: 02 Aug 2026, 14:32 (Asia/Shanghai, UTC+8)";
const TIMELINE = "## Timeline (recent)\n- **2026-08-01-1115** (08-01 Fri) 回顾";
const STRANDS = "## Memory topics\n\nKnown topics: rust";

function buildPrompt(): string {
  return assembleSystemPrompt({
    identityPrompt: IDENTITY,
    previouslyContent: PREVIOUSLY,
    sliceHeadBlock: SLICE_HEAD,
    timelineBrief: TIMELINE,
    strandsBlock: STRANDS,
    demoNotice: "",
    overdueBlock: "",
    dateAnchor: "2026-08-09",
  });
}

describe("SPACE_FICTION_BLOCK (stable identity layer, v0.13 §5)", () => {
  it("sits in the L0 prefix, right after the identity, and states the fiction + the lobby default", () => {
    const s = buildPrompt();
    expect(s.indexOf(SPACE_FICTION_BLOCK)).toBeGreaterThan(s.indexOf(IDENTITY));
    // It precedes every volatile layer.
    expect(s.indexOf(SPACE_FICTION_BLOCK)).toBeLessThan(s.indexOf(PREVIOUSLY));
    expect(SPACE_FICTION_BLOCK).toContain("谁都不生存在这个空间里");
    expect(SPACE_FICTION_BLOCK).toContain("包括 Previously 自己");
    expect(SPACE_FICTION_BLOCK).toContain("同一块屏幕");
    expect(SPACE_FICTION_BLOCK).toContain("没有这块时，用户通常在大厅");
    expect(SPACE_FICTION_BLOCK).toContain("没有选中任何时间片");
  });
});

describe("sanitizeView (the view request field)", () => {
  it("accepts a well-formed room and card view", () => {
    expect(sanitizeView({ sliceId: "2026-09-13-1530", surface: "room" })).toEqual({
      sliceId: "2026-09-13-1530",
      surface: "room",
    });
    expect(sanitizeView({ sliceId: "2026-09-13-1530", surface: "card" })).toEqual({
      sliceId: "2026-09-13-1530",
      surface: "card",
    });
  });

  it("drops everything malformed — the lobby default (no block) is the fallback", () => {
    expect(sanitizeView(undefined)).toBeUndefined();
    expect(sanitizeView(null)).toBeUndefined();
    expect(sanitizeView("2026-09-13-1530")).toBeUndefined();
    expect(sanitizeView({})).toBeUndefined();
    expect(sanitizeView({ sliceId: "2026-09-13-1530" })).toBeUndefined();
    expect(sanitizeView({ surface: "room" })).toBeUndefined();
    expect(
      sanitizeView({ sliceId: "2026-09-13-1530", surface: "lobby" }),
    ).toBeUndefined();
    // A slice id that parseSliceId rejects can be neither rendered nor
    // described — the whole field goes.
    expect(
      sanitizeView({ sliceId: "not-a-slice", surface: "room" }),
    ).toBeUndefined();
    expect(
      sanitizeView({ sliceId: "2026-9-13-1530", surface: "room" }),
    ).toBeUndefined();
  });
});

const INDEX: TimelineIndex = {
  _schema: 1,
  updated_at: "2026-09-13T16:00:00.000Z",
  slice_count: 2,
  needs_marking: 0,
  slices: [
    {
      id: "2026-09-13-1400",
      date: "2026-09-13",
      start: "2026-09-13T14:00:00.000Z",
      end: "2026-09-13T14:30:00.000Z",
      status: "closed",
      focus: "回顾编码进展",
      summary: "",
      tags: ["rust"],
      strands: [],
      open_loops: [],
      decisions: [],
      needs_marking: false,
    },
    {
      id: "2026-09-13-1530",
      date: "2026-09-13",
      start: "2026-09-13T15:30:00.000Z",
      end: "2026-09-13T16:00:00.000Z",
      status: "closed",
      focus: "讨论视野注入",
      summary: "",
      tags: ["编码", "回顾"],
      strands: ["aftrbrez"],
      open_loops: [],
      decisions: [],
      needs_marking: false,
    },
  ],
};

describe("buildViewBlock (per-turn block, v0.13 §5)", () => {
  it("room surface: the design's template, slice time rendered locally", () => {
    const block = buildViewBlock({
      view: { sliceId: "2026-09-13-1530", surface: "room" },
      timezone: "UTC",
      locale: "zh",
      index: INDEX,
    });
    expect(block.startsWith("\n\n[当前] 用户正处于时间片 2026-09-13 15:30（2026-09-13-1530）的房间内 —— ")).toBe(true);
    expect(block.trimEnd().endsWith("。")).toBe(true);
    // One clause only — no newlines inside the block.
    expect(block.trim().split("\n")).toHaveLength(1);
    // The local zone is honored.
    const sh = buildViewBlock({
      view: { sliceId: "2026-09-13-1530", surface: "room" },
      timezone: "Asia/Shanghai",
      locale: "zh",
      index: INDEX,
    });
    expect(sh).toContain("2026-09-13 23:30");
  });

  it("card surface: plain data facts — tags, strands, gap to the previous slice", () => {
    const block = buildViewBlock({
      view: { sliceId: "2026-09-13-1530", surface: "card" },
      timezone: "UTC",
      locale: "zh",
      index: INDEX,
    });
    expect(block).toContain("[当前] 用户正在看时间片 2026-09-13 15:30（2026-09-13-1530）的卡片 —— ");
    expect(block).toContain("标签：编码、回顾");
    expect(block).toContain("线索：aftrbrez");
    expect(block).toContain("距前一片约 60 分钟");
  });

  it("card surface: a slice with no strand membership names the core timeline; an unknown slice names its state instead of inventing facts", () => {
    const core = buildViewBlock({
      view: { sliceId: "2026-09-13-1400", surface: "card" },
      timezone: "UTC",
      locale: "zh",
      index: INDEX,
    });
    expect(core).toContain("核心时间线");
    const active = buildViewBlock({
      view: { sliceId: "2026-09-13-1700", surface: "card" },
      timezone: "UTC",
      locale: "zh",
      index: INDEX,
    });
    expect(active).toContain("目录尚无条目");
  });

  it("english locale renders both surfaces in the model's working language", () => {
    const room = buildViewBlock({
      view: { sliceId: "2026-09-13-1530", surface: "room" },
      timezone: "UTC",
      locale: "en",
      index: INDEX,
    });
    expect(room).toContain(
      "[Current] The user is standing in the room of time slice 2026-09-13 15:30 (2026-09-13-1530) — ",
    );
    const card = buildViewBlock({
      view: { sliceId: "2026-09-13-1530", surface: "card" },
      timezone: "UTC",
      locale: "en",
      index: INDEX,
    });
    expect(card).toContain(
      "[Current] The user is looking at the card of time slice 2026-09-13 15:30 (2026-09-13-1530) — ",
    );
    expect(card).toContain("tags: 编码, 回顾");
    expect(card).toContain("~60 min after the previous slice");
  });
});
