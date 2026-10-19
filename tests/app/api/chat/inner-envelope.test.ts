/**
 * Inner-turn envelope + merge brief + the drain's unanswered scan (v0.30 §3.2,
 * batch B). All pure — these pin the envelope's mechanical shape (verbatim
 * user text, D5 truncation, the target block), the wrap-up brief's honesty
 * (a failed instance is STATED), and findEpisodeUnanswered's pairing rules
 * (same-turnId agent turns AND replyTo bubbles both answer; the outer turn
 * is excluded; the regenerate fallback is the episode-start stamp).
 */
import { describe, it, expect } from "vitest";
import {
  buildInnerEnvelope,
  buildMergeSummaryBrief,
  findEpisodeUnanswered,
  MAX_INSTANCE_TEXT_CHARS,
  MAX_MERGE_TEXT_CHARS,
  type EnvelopeUserTurn,
} from "@/app/api/chat/inner-envelope";
import type { TimeSlice } from "@/lib/episodic";

const T = (turnId: string, text: string, timestamp = "2026-07-14T10:00:00.000Z"): EnvelopeUserTurn => ({
  turnId,
  timestamp,
  text,
});

describe("buildInnerEnvelope — the inner run's single user message (§3.2)", () => {
  it("carries every queued message verbatim, oldest first", () => {
    const pending = [T("u1", "first *question*"), T("u2", "second\nmultiline")];
    const env = buildInnerEnvelope({
      sliceId: "2026-07-14-1000",
      pending,
      instances: [],
      target: pending[1],
    });
    expect(env).toContain("### Message u1 (arrived 2026-07-14T10:00:00.000Z)\nfirst *question*");
    expect(env).toContain("### Message u2 (arrived 2026-07-14T10:00:00.000Z)\nsecond\nmultiline");
    expect(env.indexOf("### Message u1")).toBeLessThan(env.indexOf("### Message u2"));
  });

  it("the target block quotes the served message and names the slice pointer", () => {
    const target = T("u2", "what about the deploy?");
    const env = buildInnerEnvelope({
      sliceId: "2026-07-14-1000",
      pending: [T("u1", "earlier"), target],
      instances: [],
      target,
    });
    expect(env).toContain('## Your target\nMessage u2 (arrived 2026-07-14T10:00:00.000Z):\n"""\nwhat about the deploy?\n"""');
    expect(env).toContain('recallRead (ref "records/2026-07-14-1000"');
    expect(env).toContain("Answer ONLY that message");
  });

  it("an empty instance table says so; a running instance is a status word only (D5)", () => {
    const withNone = buildInnerEnvelope({
      sliceId: "s",
      pending: [T("u1", "q")],
      instances: [],
      target: T("u1", "q"),
    });
    expect(withNone).toContain("- (no other instances yet)");

    const withRunning = buildInnerEnvelope({
      sliceId: "s",
      pending: [T("u1", "q"), T("u2", "q2")],
      instances: [{ replyTo: "u1", turnId: "nu1", status: "running", text: "HALF-WRITTEN" }],
      target: T("u2", "q2"),
    });
    expect(withRunning).toContain("- message u1: running (instance nu1)");
    // a running instance's partial text NEVER rides the envelope (D5)
    expect(withRunning).not.toContain("HALF-WRITTEN");
  });

  it("a done instance's answer rides truncated at MAX_INSTANCE_TEXT_CHARS (D5)", () => {
    const long = "x".repeat(MAX_INSTANCE_TEXT_CHARS + 50);
    const env = buildInnerEnvelope({
      sliceId: "s",
      pending: [T("u1", "q"), T("u2", "q2")],
      instances: [{ replyTo: "u1", turnId: "nu1", status: "done", text: long }],
      target: T("u2", "q2"),
    });
    expect(env).toContain(`- message u1: done — "${"x".repeat(MAX_INSTANCE_TEXT_CHARS)}…"`);
    expect(env).not.toContain(long);
  });
});

describe("buildMergeSummaryBrief — the wrap-up nudge (§3.4/§3.6)", () => {
  it("pairs each result with its question excerpt, done answers carried fuller", () => {
    const brief = buildMergeSummaryBrief([
      { question: T("u1", "the deploy question with\nnewlines"), status: "done", text: "shipped it" },
      { question: T("u2", "the billing question"), status: "failed" },
    ]);
    expect(brief).toContain('### On "the deploy question with newlines" (message u1) — answered\nshipped it');
    // a failure is STATED, never smoothed over (§3.6)
    expect(brief).toContain('### On "the billing question" (message u2) — NOT answered (the instance failed)');
    expect(brief).toContain("plainly name anything that did not get answered");
  });

  it("done answers truncate at MAX_MERGE_TEXT_CHARS", () => {
    const long = "y".repeat(MAX_MERGE_TEXT_CHARS + 100);
    const brief = buildMergeSummaryBrief([
      { question: T("u1", "q"), status: "done", text: long },
    ]);
    expect(brief).toContain("y".repeat(MAX_MERGE_TEXT_CHARS) + "…");
    expect(brief).not.toContain(long);
  });
});

describe("findEpisodeUnanswered — the drain's disk reconciliation (D1/D2 兜底)", () => {
  const STARTED = "2026-07-14T10:00:00.000Z";
  const sliceOf = (turns: TimeSlice["turns"]): Pick<TimeSlice, "turns"> => ({ turns });

  it("a user turn after the outer turn with no agent naming it is unanswered", () => {
    const s = sliceOf([
      { timestamp: "t0", role: "user", content: "first", turnId: "outer1" },
      { timestamp: "t1", role: "agent", content: "reply", turnId: "outer1" },
      { timestamp: "t2", role: "user", content: "queued", turnId: "u2" },
    ]);
    expect(findEpisodeUnanswered(s, "outer1", STARTED)).toEqual([
      { turnId: "u2", timestamp: "t2", text: "queued" },
    ]);
  });

  it("the standard round pairing answers by shared turnId; a bubble answers by replyTo", () => {
    const s = sliceOf([
      { timestamp: "t0", role: "user", content: "first", turnId: "outer1" },
      { timestamp: "t1", role: "user", content: "answered-by-round", turnId: "u2" },
      { timestamp: "t2", role: "agent", content: "r", turnId: "u2" },
      { timestamp: "t3", role: "user", content: "answered-by-bubble", turnId: "u3" },
      { timestamp: "t4", role: "agent", content: "bubble", turnId: "nu3", replyTo: "u3" },
      { timestamp: "t5", role: "user", content: "still-open", turnId: "u4" },
    ]);
    expect(findEpisodeUnanswered(s, "outer1", STARTED).map((t) => t.turnId)).toEqual(["u4"]);
  });

  it("the outer turn itself never re-enters the set (its agent turn lands only at finalize)", () => {
    const s = sliceOf([
      { timestamp: "t0", role: "user", content: "first", turnId: "outer1" },
    ]);
    expect(findEpisodeUnanswered(s, "outer1", STARTED)).toEqual([]);
  });

  it("turns at or before the anchor stay out — older unanswered business is reflection's", () => {
    const s = sliceOf([
      { timestamp: "t0", role: "user", content: "ancient-open", turnId: "old1" },
      { timestamp: "t1", role: "user", content: "first", turnId: "outer1" },
      { timestamp: "t2", role: "user", content: "queued", turnId: "u2" },
    ]);
    expect(findEpisodeUnanswered(s, "outer1", STARTED).map((t) => t.turnId)).toEqual(["u2"]);
  });

  it("regenerate fallback: no anchor on disk → the episode-start stamp gates freshness", () => {
    const s = sliceOf([
      { timestamp: "2026-07-14T09:59:00.000Z", role: "user", content: "before-start", turnId: "u0" },
      { timestamp: "2026-07-14T10:00:00.000Z", role: "user", content: "at-start", turnId: "u1" },
      { timestamp: "2026-07-14T10:01:00.000Z", role: "user", content: "after-start", turnId: "u2" },
    ]);
    // outer1 never landed (regenerate) → only arrivals stamped at/after STARTED count
    expect(findEpisodeUnanswered(s, "outer1", STARTED).map((t) => t.turnId)).toEqual(["u1", "u2"]);
  });

  it("a turn without a turnId is skipped; agent turns never enter the set", () => {
    const s = sliceOf([
      { timestamp: "t0", role: "user", content: "first", turnId: "outer1" },
      { timestamp: "t1", role: "user", content: "idless" },
      { timestamp: "t2", role: "agent", content: "some reply", turnId: "zzz" },
    ]);
    expect(findEpisodeUnanswered(s, "outer1", STARTED)).toEqual([]);
  });
});
