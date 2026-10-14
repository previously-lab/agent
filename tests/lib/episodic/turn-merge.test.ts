/**
 * Tests for the turn-merge self-heal (B2) — re-parse the remote slice,
 * append missing turns by turnId, union tags/loops, re-serialize.
 */
import { describe, it, expect } from "vitest";
import {
  mergeTurnsWithRemote,
  mergeDiskTurnsIntoSlice,
} from "@/lib/episodic/turn-merge";
import { serializeSlice, parseSlice } from "@/lib/episodic/manager";
import type { TimeSlice, Turn } from "@/lib/episodic/types";

function makeTurn(turnId: string, content: string, role: "user" | "agent" = "user"): Turn {
  return {
    timestamp: "2026-08-16T10:00:00.000Z",
    role,
    content,
    turnId,
  };
}

function makeSlice(overrides: Partial<TimeSlice>): TimeSlice {
  return {
    slice_id: "2026-08-16-1000",
    focus: "API design",
    status: "active",
    start: "2026-08-16T09:55:00.000Z",
    timezone: "UTC",
    summary: "",
    open_loops: [],
    decisions: [],
    tags: [],
    related_slices: [],
    loops: [],
    turns: [],
    estimatedTokens: 0,
    ...overrides,
  };
}

describe("mergeTurnsWithRemote", () => {
  it("appends local turns the remote is missing (keyed by turnId)", () => {
    const shared = makeTurn("t1", "hello");
    const remoteTurn = makeTurn("t2", "remote answer", "agent");
    const remote = serializeSlice(
      makeSlice({ turns: [shared, remoteTurn] }),
    );
    const local = makeSlice({
      turns: [shared, makeTurn("t3", "follow-up")],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));

    expect(merged.turns.map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);
    // No duplication of the shared turn.
    expect(merged.turns.filter((t) => t.turnId === "t1")).toHaveLength(1);
  });

  it("is a no-op when the remote already has every turn", () => {
    const turns = [makeTurn("t1", "a"), makeTurn("t2", "b", "agent")];
    const remote = serializeSlice(makeSlice({ turns }));
    const local = makeSlice({ turns: [...turns] });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.turns).toHaveLength(2);
  });

  it("unions loop pointers without duplicates (tags are no longer persisted)", () => {
    const remote = serializeSlice(makeSlice({ loops: ["loop-1"] }));
    const local = makeSlice({
      turns: [makeTurn("t1", "x")],
      loops: ["loop-1", "loop-2"],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.loops).toEqual(["loop-1", "loop-2"]);
  });

  it("keeps the REMOTE frontmatter (close marking etc. wins over our stale copy)", () => {
    // Closed state persists as closed_by alone (v0.19 R2) — status derives.
    const remote = serializeSlice(
      makeSlice({ focus: "updated remotely", closedBy: "user_explicit", turns: [] }),
    );
    const local = makeSlice({ focus: "stale focus", turns: [makeTurn("t1", "x")] });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.focus).toBe("updated remotely");
    expect(merged.status).toBe("closed");
  });

  it("dedupes legacy turns without turnId by content fingerprint", () => {
    // A genuinely legacy (numeric-label) remote body — parseSlice gives the
    // turn no turnId, so the merge falls back to the content fingerprint.
    const remote = [
      "---",
      "slice_id: 2026-08-16-1000",
      "status: active",
      "---",
      "",
      "## Turn 1 — 2026-08-16T09:00:00.000Z (user)",
      "",
      "legacy turn body",
    ].join("\n");
    const local = makeSlice({
      turns: [
        {
          timestamp: "2026-08-16T09:00:00.000Z",
          role: "user",
          content: "legacy turn body",
        },
      ],
    });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.turns).toHaveLength(1);
  });

  it("keeps a turn's AGENT answer distinct from its USER entry (shared turnId)", () => {
    // The identity key carries the role: a turn's user entry and its agent
    // answer share one turnId. A turnId-only key makes the heal drop the
    // answer when the remote already holds the user entry.
    const u1 = makeTurn("T1", "q");
    const a1 = makeTurn("T1", "a", "agent");
    const remote = serializeSlice(makeSlice({ turns: [u1] }));
    const local = makeSlice({ turns: [u1, a1] });

    const merged = parseSlice(mergeTurnsWithRemote(remote, local));
    expect(merged.turns.map((t) => `${t.role}:${t.turnId}`)).toEqual([
      "user:T1",
      "agent:T1",
    ]);
  });
});

describe("mergeDiskTurnsIntoSlice", () => {
  it("appends disk-only turns to the in-memory slice (the route-append race)", () => {
    const shared = makeTurn("t1", "hello");
    const inMemory = makeSlice({ turns: [shared] });
    const diskRaw = serializeSlice(
      makeSlice({
        turns: [shared, makeTurn("m2", "nested question"), makeTurn("m3", "another")],
      }),
    );

    const added = mergeDiskTurnsIntoSlice(inMemory, diskRaw);

    expect(added).toBe(2);
    expect(inMemory.turns.map((t) => t.turnId)).toEqual(["t1", "m2", "m3"]);
  });

  it("is a no-op when the disk already matches memory", () => {
    const turns = [makeTurn("t1", "a"), makeTurn("t2", "b", "agent")];
    const inMemory = makeSlice({ turns: [...turns] });
    const diskRaw = serializeSlice(makeSlice({ turns }));

    expect(mergeDiskTurnsIntoSlice(inMemory, diskRaw)).toBe(0);
    expect(inMemory.turns).toHaveLength(2);
  });

  it("keeps the IN-MEMORY frontmatter (a fresh close marking wins over disk)", () => {
    const inMemory = makeSlice({ focus: "fresh mark", turns: [makeTurn("t1", "x")] });
    const diskRaw = serializeSlice(
      makeSlice({ focus: "stale focus", turns: [makeTurn("t1", "x"), makeTurn("m2", "y")] }),
    );

    mergeDiskTurnsIntoSlice(inMemory, diskRaw);

    expect(inMemory.focus).toBe("fresh mark");
    expect(inMemory.turns).toHaveLength(2);
  });

  it("unions loop pointers without duplicates", () => {
    const inMemory = makeSlice({ loops: ["loop-1"], turns: [makeTurn("t1", "x")] });
    const diskRaw = serializeSlice(
      makeSlice({ loops: ["loop-1", "loop-2"], turns: [makeTurn("t1", "x")] }),
    );

    expect(mergeDiskTurnsIntoSlice(inMemory, diskRaw)).toBe(0);
    expect(inMemory.loops).toEqual(["loop-1", "loop-2"]);
  });

  it("the parallel-burst race: a sibling's agent answer survives the merge (v0.33 regression)", () => {
    // Deterministic replay of the phase-3 real-machine loss. Two runs share
    // one slice; each finalizes from the snapshot it loaded at housekeeping:
    //   turn1 hk loads [u1]; turn2 hk appends u2 to disk;
    //   turn1 finalizes: merges u2, appends a1, writes [u1,u2,a1];
    //   turn2 finalizes from ITS stale base [u1,u2]: the disk merge must
    //   union a1 in — with a turnId-only key, a1 collides with u1's key and
    //   the snapshot write silently erases turn1's answer.
    const u1 = makeTurn("T1", "我中午吃了包子");
    const u2 = makeTurn("T2", "更正：吃的是饺子");
    const a1 = makeTurn("T1", "包子的历史长答…", "agent");
    const a2 = makeTurn("T2", "收到，是饺子…", "agent");

    // turn1's finalize: base [u1], disk already holds u2.
    const turn1Slice = makeSlice({ turns: [u1] });
    mergeDiskTurnsIntoSlice(
      turn1Slice,
      serializeSlice(makeSlice({ turns: [u1, u2] })),
    );
    turn1Slice.turns.push(a1);
    const diskAfterTurn1 = serializeSlice(turn1Slice);
    expect(parseSlice(diskAfterTurn1).turns).toHaveLength(3);

    // turn2's finalize from its stale base [u1,u2] — the moment that lost a1.
    const turn2Slice = makeSlice({ turns: [u1, u2] });
    const added = mergeDiskTurnsIntoSlice(turn2Slice, diskAfterTurn1);
    turn2Slice.turns.push(a2);

    expect(added).toBe(1); // a1 merged in, not eaten by the u1 key collision
    expect(turn2Slice.turns.map((t) => `${t.role}:${t.turnId}`)).toEqual([
      "user:T1",
      "user:T2",
      "agent:T1",
      "agent:T2",
    ]);
  });
});
