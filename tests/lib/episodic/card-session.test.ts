/**
 * card-session — the mutation layer behind the Previously Agent's write tools.
 * The contract that matters: invalid writes are REJECTED with actionable
 * feedback (the agent retries), nothing is ever silently truncated, and
 * untouched entries survive by construction.
 */
import { describe, it, expect } from "vitest";
import {
  createCardSession,
  serializeSession,
  sameCardSubstance,
  sessionSetIdentity,
  sessionUpdatePastProfile,
  sessionAddPastAnchor,
  sessionRemovePastAnchor,
  sessionAddNow,
  sessionRemoveNow,
  sessionPromoteNowToPast,
} from "@/lib/episodic/card-session";
import {
  newCardTemplate,
  parseCard,
  serializeCard,
} from "@/lib/episodic/previously-format";

const SLICE = "2026-08-17-0515";
const TODAY = "2026-08-17";
const REFS = ["2026/08/17/0515"];

function session(base?: string) {
  return createCardSession(base ?? newCardTemplate(SLICE), SLICE, TODAY, "2026-08-17T06:00:00.000Z");
}

describe("createCardSession", () => {
  it("parses a v5 card into the working document", () => {
    const base = serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: ["Name: Alan"],
      past: { profile: "A full-stack engineer.", anchors: [] },
      now: [{ text: "Prepping an interview", refs: REFS, since: "2026-08-15" }],
      horizon: [],
      selfModel: [],
    });
    const s = session(base);
    expect(s.doc.identity).toEqual(["Name: Alan"]);
    expect(s.doc.now[0].text).toBe("Prepping an interview");
    // Stamps re-anchor to the current slice.
    expect(s.doc.sliceId).toBe(SLICE);
  });

  it("starts EMPTY for unparseable (v3 free-form) content — the agent rebuilds via mutations", () => {
    const s = session("## User profile\n\n### Identity & background\n一些自由文本");
    expect(s.doc.identity).toEqual([]);
    expect(s.doc.past.profile).toBe("");
    expect(s.doc.now).toEqual([]);
  });
});

describe("setIdentity", () => {
  it("replaces an existing field in place", () => {
    const s = session();
    expect(sessionSetIdentity(s, "name", "Alan")).toMatch(/^OK/);
    expect(sessionSetIdentity(s, "name", "袁艺")).toMatch(/^OK/);
    expect(s.doc.identity).toEqual(["Name: 袁艺"]);
  });

  it("preserves a full identity value", () => {
    const s = session();
    const res = sessionSetIdentity(s, "name", "x".repeat(301));
    expect(res).toMatch(/^OK/);
    expect(s.doc.identity[0]).toBe("Name: " + "x".repeat(301));
  });
});

describe("updatePastProfile", () => {
  it("accepts a paragraph within the cap", () => {
    const s = session();
    expect(sessionUpdatePastProfile(s, "Alan is a full-stack engineer in Beijing.")).toMatch(/^OK/);
    expect(s.doc.past.profile).toContain("full-stack engineer");
  });

  it("round-trips the paragraph beyond the old cap", () => {
    const s = session();
    const long = "a".repeat(2500);
    const res = sessionUpdatePastProfile(s, long);
    expect(res).toMatch(/^OK/);
    expect(parseCard(serializeSession(s))?.past.profile).toBe(long);
  });

  it("rejects emptying the profile", () => {
    const s = session();
    sessionUpdatePastProfile(s, "existing profile");
    expect(sessionUpdatePastProfile(s, "")).toContain("REJECTED");
    expect(s.doc.past.profile).toBe("existing profile");
  });
});

describe("addNow / removeNow / promoteNowToPast", () => {
  it("adds newest-first and defaults since to the user's local today", () => {
    const s = session();
    sessionAddNow(s, "first hook", REFS, "2026-08-10");
    sessionAddNow(s, "second hook", REFS);
    expect(s.doc.now.map((r) => r.text)).toEqual(["second hook", "first hook"]);
    expect(s.doc.now[0].since).toBe(TODAY);
  });

  it("rejects missing or malformed refs", () => {
    const s = session();
    expect(sessionAddNow(s, "hook", [])).toContain("refs are required");
    expect(sessionAddNow(s, "hook", ["not-a-ref"])).toContain("malformed ref");
    expect(s.doc.now).toEqual([]);
  });

  it("accepts dash-form slice ids as refs and normalizes them to slash form", () => {
    // v0.8.1 regression: slice ids are dash-form (YYYY-MM-DD-HHMM) everywhere
    // the worker sees them, but refs used to require slash form — a verbatim
    // citation bounced as "malformed" and looped.
    const s = session();
    const res = sessionAddNow(s, "hook", ["2026-08-17-0515", "2026-08-16-0900-abc123"]);
    expect(res).toMatch(/^OK/);
    expect(s.doc.now[0].refs).toEqual(["2026/08/17/0515", "2026/08/16/0900-abc123"]);
  });

  it("rejects a duplicate entry", () => {
    const s = session();
    sessionAddNow(s, "prepping the friday interview", REFS);
    expect(sessionAddNow(s, "Prepping the Friday interview", REFS)).toContain("already on the card");
  });

  it("keeps all sourced items beyond the old count", () => {
    const s = session();
    for (let i = 0; i < 5; i++) sessionAddNow(s, `hook ${i}`, REFS);
    const res = sessionAddNow(s, "one too many", REFS);
    expect(res).toMatch(/^OK/);
    expect(s.doc.now).toHaveLength(6);
  });

  it("removeNow no-match error lists the current entries", () => {
    const s = session();
    sessionAddNow(s, "prepping the interview", REFS);
    const res = sessionRemoveNow(s, "nonexistent");
    expect(res).toContain("REJECTED");
    expect(res).toContain("prepping the interview");
  });

  it("promoteNowToPast moves the item keeping its refs", () => {
    const s = session();
    sessionAddNow(s, "interview done — offered the role", REFS);
    expect(sessionPromoteNowToPast(s, "interview done")).toMatch(/^OK/);
    expect(s.doc.now).toEqual([]);
    expect(s.doc.past.anchors[0]).toEqual({ text: "interview done — offered the role", refs: REFS });
  });

  it("promotion preserves anchors beyond the old cap", () => {
    const s = session();
    for (let i = 0; i < 8; i++) sessionAddPastAnchor(s, `durable fact ${i}`, REFS);
    sessionAddNow(s, "a hook", REFS);
    expect(sessionPromoteNowToPast(s, "a hook")).toMatch(/^OK/);
    expect(s.doc.past.anchors).toHaveLength(9);
    expect(s.doc.now).toHaveLength(0);
  });

  it("promotion moves a legacy OVER-LENGTH Now item — a move is not a new write", () => {
    // v0.8.1: the anchor length cap used to validate the EXISTING text, so a
    // legacy over-length Now item could never be promoted — an escapeless
    // rejection loop for content the agent didn't author.
    const base = serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: [],
      past: { profile: "p", anchors: [] },
      now: [{ text: "x".repeat(400), refs: REFS, since: "2026-08-01" }],
      horizon: [],
      selfModel: [],
    });
    const s = session(base);
    expect(sessionPromoteNowToPast(s, "xxx")).toMatch(/^OK/);
    expect(s.doc.now).toEqual([]);
    expect(s.doc.past.anchors[0].text).toHaveLength(400);
  });
});

describe("serialization + substance comparison", () => {
  it("round-trips through serializeCard/parseCard", () => {
    const s = session();
    sessionSetIdentity(s, "name", "Alan");
    sessionAddNow(s, "prepping the interview", REFS, "2026-08-15");
    const out = serializeSession(s);
    const parsed = parseCard(out);
    expect(parsed?.identity).toEqual(["Name: Alan"]);
    expect(parsed?.now[0].text).toBe("prepping the interview");
    expect(parsed?.now[0].since).toBe("2026-08-15");
  });

  it("sameCardSubstance ignores the sliceId/updated stamps", () => {
    const doc = {
      sliceId: "a",
      updated: "t1",
      identity: ["Name: Alan"],
      past: { profile: "p", anchors: [] },
      now: [],
      horizon: [],
      selfModel: [],
    };
    expect(
      sameCardSubstance(doc, { ...doc, sliceId: "b", updated: "t2" }),
    ).toBe(true);
    expect(
      sameCardSubstance(doc, { ...doc, past: { profile: "changed", anchors: [] } }),
    ).toBe(false);
  });

  it("a mutation-free session serializes back to the same substance as the base", () => {
    const base = serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: ["Name: Alan"],
      past: { profile: "profile text", anchors: [{ text: "anchor", refs: REFS }] },
      now: [{ text: "hook", refs: REFS, since: "2026-08-15" }],
      horizon: [{ text: "loop", by: "2026-08-20", refs: REFS }],
      selfModel: [],
    });
    const s = session(base);
    expect(sameCardSubstance(parseCard(base), parseCard(serializeSession(s)))).toBe(true);
  });

  it("a legacy Self-model section still PARSES (read tolerance) but never re-serializes", () => {
    // The card format dropped Self-model; old cards on disk still carry it.
    // parseCard keeps filling doc.selfModel (so the direction migration can
    // read the legacy lines), but the writer never emits the section again —
    // so the strip registers as a substance change.
    const legacy = `${serializeCard({
      sliceId: "2026-08-16-0900",
      updated: "2026-08-16T09:00:00.000Z",
      identity: ["Name: Alan"],
      past: { profile: "profile text", anchors: [] },
      now: [],
      horizon: [],
      selfModel: [],
    })}\n## Self-model\n\n- Don't decompose emotional venting\n`;
    const parsed = parseCard(legacy);
    expect(parsed?.selfModel).toEqual(["Don't decompose emotional venting"]);
    const s = session(legacy);
    expect(serializeSession(s)).not.toContain("## Self-model");
    expect(sameCardSubstance(parsed, parseCard(serializeSession(s)))).toBe(false);
  });
});

it("keeps rejecting ungrounded writes until corrected without forcing the session to end", () => {
  const s = session();
  for (let attempt = 0; attempt < 4; attempt++) expect(sessionAddNow(s, "hook", [])).toContain("refs are required");
  expect(sessionAddNow(s, "hook", REFS)).toMatch(/^OK/);
  expect(s.doc.now).toHaveLength(1);
});
