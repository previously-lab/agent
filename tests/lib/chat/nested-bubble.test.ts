/**
 * Episode wire contracts (v0.30 §3, batch B) — the two vocabularies in
 * nested-bubble.ts are the episode's whole wire surface, and both sides
 * (E's steps writing frames, the client store replaying them; the messages
 * route and inner runs posting to the inbox hook) code against these
 * normalizers. Pins: the happy shapes round-trip, and malformed input
 * degrades to null instead of throwing (a replayed/foreign chunk must not
 * kill the reader).
 */
import { describe, it, expect } from "vitest";
import {
  NESTED_BUBBLE_CHUNK,
  episodeInboxToken,
  normalizeNestedBubble,
  normalizeEpisodeInboxEvent,
} from "@/lib/chat/nested-bubble";

describe("normalizeNestedBubble — the E→client lifecycle frame", () => {
  it("accepts each lifecycle status", () => {
    for (const status of ["queued", "running", "done", "failed"] as const) {
      const frame = normalizeNestedBubble({ replyTo: "u1", turnId: "nu1", status });
      expect(frame).toEqual({ replyTo: "u1", turnId: "nu1", status });
    }
  });

  it("carries text and doneAt when present, drops empty strings", () => {
    const done = normalizeNestedBubble({
      replyTo: "u1",
      turnId: "nu1",
      status: "done",
      text: "the answer",
      doneAt: "2026-07-14T10:01:00.000Z",
    });
    expect(done).toEqual({
      replyTo: "u1",
      turnId: "nu1",
      status: "done",
      text: "the answer",
      doneAt: "2026-07-14T10:01:00.000Z",
    });
    // empty-string optionals are dropped, not carried
    expect(
      normalizeNestedBubble({ replyTo: "u1", turnId: "nu1", status: "queued", text: "" }),
    ).toEqual({ replyTo: "u1", turnId: "nu1", status: "queued" });
  });

  it("carries runId and anchorId when present (v0.31), drops empty strings", () => {
    expect(
      normalizeNestedBubble({
        replyTo: "u1",
        turnId: "nu1",
        status: "running",
        runId: "run-child-1",
        anchorId: "msg-client-1",
      }),
    ).toEqual({
      replyTo: "u1",
      turnId: "nu1",
      status: "running",
      runId: "run-child-1",
      anchorId: "msg-client-1",
    });
    expect(
      normalizeNestedBubble({
        replyTo: "u1",
        turnId: "nu1",
        status: "queued",
        runId: "",
        anchorId: "",
      }),
    ).toEqual({ replyTo: "u1", turnId: "nu1", status: "queued" });
  });

  it("degrades malformed input to null, never throws", () => {
    expect(normalizeNestedBubble(null)).toBeNull();
    expect(normalizeNestedBubble(undefined)).toBeNull();
    expect(normalizeNestedBubble("data-nested-bubble")).toBeNull();
    expect(normalizeNestedBubble({})).toBeNull();
    // missing / empty required fields
    expect(normalizeNestedBubble({ replyTo: "", turnId: "nu1", status: "done" })).toBeNull();
    expect(normalizeNestedBubble({ replyTo: "u1", status: "done" })).toBeNull();
    // an unknown status is foreign — not a frame of ours
    expect(
      normalizeNestedBubble({ replyTo: "u1", turnId: "nu1", status: "streaming" }),
    ).toBeNull();
  });

  it("the chunk type constant is the wire name the client store keys on", () => {
    expect(NESTED_BUBBLE_CHUNK).toBe("data-nested-bubble");
  });
});

describe("episodeInboxToken — the route's whole addressing (D2)", () => {
  it("derives from the run id alone", () => {
    expect(episodeInboxToken("run_abc")).toBe("episode:run_abc");
  });
});

describe("normalizeEpisodeInboxEvent — one hook, two kinds (D2)", () => {
  it("arrived: the route's wake-up tap carries only the turnId", () => {
    expect(normalizeEpisodeInboxEvent({ kind: "arrived", turnId: "u2" })).toEqual({
      kind: "arrived",
      turnId: "u2",
    });
    expect(normalizeEpisodeInboxEvent({ kind: "arrived" })).toBeNull();
    expect(normalizeEpisodeInboxEvent({ kind: "arrived", turnId: "" })).toBeNull();
  });

  it("bubble: the inner run's terminal report carries the full answer", () => {
    expect(
      normalizeEpisodeInboxEvent({
        kind: "bubble",
        turnId: "nu2",
        replyTo: "u2",
        text: "answer text",
        finishReason: "stop",
      }),
    ).toEqual({
      kind: "bubble",
      turnId: "nu2",
      replyTo: "u2",
      text: "answer text",
      finishReason: "stop",
    });
  });

  it("bubble defaults: non-string text becomes empty, missing finishReason is 'error'", () => {
    expect(
      normalizeEpisodeInboxEvent({ kind: "bubble", turnId: "nu2", replyTo: "u2" }),
    ).toEqual({
      kind: "bubble",
      turnId: "nu2",
      replyTo: "u2",
      text: "",
      finishReason: "error",
    });
  });

  it("degrades foreign payloads to null, never throws", () => {
    expect(normalizeEpisodeInboxEvent(null)).toBeNull();
    expect(normalizeEpisodeInboxEvent("bubble")).toBeNull();
    expect(normalizeEpisodeInboxEvent({})).toBeNull();
    expect(normalizeEpisodeInboxEvent({ kind: "ping" })).toBeNull();
    // bubble without its routing fields is unusable
    expect(normalizeEpisodeInboxEvent({ kind: "bubble", turnId: "nu2" })).toBeNull();
    expect(normalizeEpisodeInboxEvent({ kind: "bubble", replyTo: "u2" })).toBeNull();
  });
});
