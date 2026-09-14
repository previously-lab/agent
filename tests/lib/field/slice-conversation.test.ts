/**
 * The pure half of SliceConversation.
 *
 * The face ITSELF is not testable here: vitest runs in a NODE environment with
 * no DOM (`vitest.config.ts`), and this component's whole observable behaviour
 * is a ResizeObserver reading `offsetHeight` off a portal-mounted element. What
 * is testable is the three decisions it makes before and around that — which
 * key a turn is drawn under, how the unit's boundary is translated into the
 * gate's vocabulary, and which measurements are allowed through. Each of them
 * has a failure mode that is silent on screen, which is why each has a test.
 */
import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/episodic/types";
import type { UnitBoundary } from "@/lib/timeline3d/boundary";
import {
  gatePropsFor,
  reportableFaceHeight,
  turnKey,
} from "@/components/field/slice-conversation";

function turn(over: Partial<Turn> = {}): Turn {
  return {
    timestamp: "2026-08-11T10:00:00.000Z",
    role: "user",
    content: "hello",
    ...over,
  };
}

describe("turnKey", () => {
  it("gives the two turns of one round different keys", () => {
    // `turnId` is shared by the round's user turn and its agent turn, so a list
    // keyed on it hands React two siblings with one key — it reconciles one
    // element for both and the round draws a single bubble twice.
    const user = turn({ turnId: "a3fk2w", role: "user", content: "the question" });
    const agent = turn({ turnId: "a3fk2w", role: "agent", content: "the answer" });
    expect(turnKey(user, 0)).not.toBe(turnKey(agent, 1));
  });

  it("keeps legacy turns apart, which carry no turn id at all", () => {
    // A slice parsed off disk before turn ids existed has none, so every such
    // turn would key as the same "legacy:user" without the index.
    const a = turn({ role: "user", content: "first" });
    const b = turn({ role: "user", content: "second" });
    expect(turnKey(a, 0)).not.toBe(turnKey(b, 2));
  });

  it("is stable for the same turn at the same index", () => {
    // The list is append-only and a closed slice is immutable, so a re-render
    // must not remount the bubbles — a remount would replay their enter
    // animation and drop the measured height the field is holding.
    const t = turn({ turnId: "a3fk2w" });
    expect(turnKey(t, 4)).toBe(turnKey(turn({ ...t }), 4));
  });
});

describe("gatePropsFor", () => {
  const boundary: UnitBoundary = {
    atIso: "2026-08-11T14:00:00.000Z",
    fromIso: "2026-08-11T10:24:00.000Z",
    focus: "the wedding speech",
    prevFocus: "shipping the parser",
  };

  it("reads the newer side as the date and the older as the previous activity", () => {
    // These two ends are named from opposite sides: the boundary names its own
    // times, the gate names the roles they play in the crossing. Swapping them
    // is silent — the gate still states one distance and one date, just about
    // the wrong pair of slices — so it is asserted rather than eyeballed.
    const props = gatePropsFor(boundary);
    expect(props.dateIso).toBe("2026-08-11T14:00:00.000Z");
    expect(props.prevActivityIso).toBe("2026-08-11T10:24:00.000Z");
  });

  it("carries each focus to its own side of the boundary", () => {
    const props = gatePropsFor(boundary);
    expect(props.focus).toBe("the wedding speech");
    expect(props.prevFocus).toBe("shipping the parser");
  });

  it("leaves a focus it does not have unset rather than empty", () => {
    // `SliceGate.usableFocus` filters blanks anyway, but an absent key is the
    // honest representation and keeps a caller's truthiness check correct.
    const props = gatePropsFor({
      atIso: "2026-08-11T14:00:00.000Z",
      fromIso: "2026-08-11T10:24:00.000Z",
    });
    expect("focus" in props).toBe(false);
    expect("prevFocus" in props).toBe(false);
  });
});

describe("reportableFaceHeight", () => {
  it("passes a real measurement through unchanged", () => {
    expect(reportableFaceHeight(742)).toBe(742);
    expect(reportableFaceHeight(1)).toBe(1);
  });

  it("refuses to report zero", () => {
    // The layout reads a non-positive height as "not measured yet" and lets the
    // unit inherit the running height. Reporting a 0 would instead state that
    // the unit is genuinely zero-tall and collapse everything below it.
    expect(reportableFaceHeight(0)).toBeNull();
  });

  it("refuses a negative or non-finite reading", () => {
    // What a detached root or a `display: none` ancestor hands back.
    expect(reportableFaceHeight(-1)).toBeNull();
    expect(reportableFaceHeight(Number.NaN)).toBeNull();
    expect(reportableFaceHeight(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
