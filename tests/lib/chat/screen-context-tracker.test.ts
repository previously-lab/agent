import { describe, expect, it } from "vitest";
import { createScreenContextTracker } from "@/lib/chat/screen-context-tracker";
import { parseScreenContext, SCREEN_CONTEXT_LIMITS } from "@/lib/chat/screen-context";

const room = (sliceId = "2026-10-26-1200") => ({
  sliceId,
  title: "The fictional lobby room",
  origin: "manual" as const,
});
const document = (origin: "manual" | "restored" | "observed" = "manual") => ({
  ref: "research/fictional-hotel-notes",
  title: "A fictional hotel notebook",
  page: 1,
  totalPages: 4,
  excerpt: "Page one of an invented document.",
  edition: "current" as const,
  origin,
});

describe("screen context tracker", () => {
  it("distinguishes no observation, restored visibility, and deliberate entry", () => {
    let clock = Date.parse("2026-10-26T14:00:00.000Z");
    const tracker = createScreenContextTracker(() => clock);
    expect(tracker.getScreenContext()).toBeUndefined();

    tracker.roomEntered({ ...room(), origin: "restored" });
    const restored = tracker.getScreenContext();
    expect(restored?.current).toMatchObject({ kind: "room", origin: "restored" });
    expect(restored?.recent).toEqual([]);

    clock += 1000;
    tracker.roomEntered(room("2026-10-26-1215"));
    const manual = tracker.getScreenContext();
    expect(manual?.current).toMatchObject({ kind: "room", origin: "manual", sliceId: "2026-10-26-1215" });
    expect(manual?.recent).toHaveLength(1);
    expect(manual?.recent[0]).toMatchObject({ kind: "room-entered", sliceId: "2026-10-26-1215" });
    expect(manual?.capturedAt).toBe("2026-10-26T14:00:01.000Z");
    expect(parseScreenContext(JSON.parse(JSON.stringify(manual)))).toEqual(manual);
  });

  it("does not treat a restored document as an open action, but records deliberate page changes", () => {
    const tracker = createScreenContextTracker();
    tracker.documentOpened(document("restored"));
    expect(tracker.getScreenContext()?.recent).toEqual([]);

    tracker.documentPageChanged({ ref: document().ref, page: 2, totalPages: 4, edition: "current", excerpt: "An invented second page." });
    const snapshot = tracker.getScreenContext();
    expect(snapshot?.current).toMatchObject({ kind: "document", page: 2, origin: "restored", excerpt: "An invented second page." });
    expect(snapshot?.recent).toHaveLength(1);
    expect(snapshot?.recent[0]).toMatchObject({ kind: "document-page-changed", ref: document().ref, page: 2, edition: "current" });
  });

  it("updates settled/restored/responsive reader state without fabricating events", () => {
    const tracker = createScreenContextTracker();
    tracker.documentOpened(document());
    tracker.documentObserved({ ref: document().ref, page: 2, totalPages: 6, edition: "original", origin: "observed" });
    tracker.documentObserved({ ref: document().ref, page: 3, totalPages: 8, edition: "original" });
    const observed = tracker.getScreenContext();
    expect(observed?.current).toMatchObject({ kind: "document", page: 3, totalPages: 8, edition: "original", origin: "observed" });
    expect(observed?.recent).toHaveLength(1);
    expect(observed?.recent[0]).toMatchObject({ kind: "document-opened", page: 1, edition: "current" });

    tracker.documentPageChanged({ ref: document().ref, page: 4, edition: "current" });
    expect(tracker.getScreenContext()?.current).toMatchObject({ page: 3, edition: "original" });
    tracker.documentPageChanged({ ref: document().ref, page: 4, edition: "original" });
    expect(tracker.getScreenContext()?.recent.at(-1)).toMatchObject({ kind: "document-page-changed", page: 4, edition: "original" });
  });

  it("keeps current/original/history page events distinct under one case ref", () => {
    const tracker = createScreenContextTracker();
    tracker.documentOpened(document("restored"));
    for (const edition of ["current", "original", "history"] as const) {
      tracker.documentObserved({ ref: document().ref, page: 1, edition });
      tracker.documentPageChanged({ ref: document().ref, page: 2, edition });
    }
    const events = tracker.getScreenContext()?.recent ?? [];
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.kind === "document-page-changed" ? event.edition : undefined)).toEqual(["current", "original", "history"]);
  });

  it("ignores stale page and close callbacks, clears stale excerpts, and restores the suspended room", () => {
    const tracker = createScreenContextTracker();
    tracker.roomEntered(room());
    tracker.documentOpened(document());
    tracker.documentPageChanged({ ref: document().ref, page: 2, edition: "current", excerpt: "Page two only." });
    tracker.documentPageChanged({ ref: "research/no-longer-visible", page: 3, excerpt: "Stale text." });
    tracker.documentPageChanged({ ref: document().ref, page: 3, edition: "current" });
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "document", page: 3 });
    expect(tracker.getScreenContext()?.current).not.toHaveProperty("excerpt");

    tracker.documentClosed("research/no-longer-visible");
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "document", ref: document().ref });
    tracker.documentClosed(document().ref);
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "room", sliceId: room().sliceId });
    expect(tracker.getScreenContext()?.recent.at(-1)).toMatchObject({ kind: "document-closed", ref: document().ref, edition: "current" });
  });

  it("distinguishes passive close cleanup from an explicit close", () => {
    const tracker = createScreenContextTracker();
    tracker.roomEntered(room());
    tracker.documentOpened(document("restored"));
    tracker.documentClosed(document().ref, { origin: "observed" });
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "room" });
    expect(tracker.getScreenContext()?.recent).toHaveLength(1);
    expect(tracker.getScreenContext()?.recent.some((event) => event.kind === "document-closed")).toBe(false);

    tracker.documentOpened(document());
    tracker.documentClosed(document().ref);
    expect(tracker.getScreenContext()?.recent.at(-1)).toMatchObject({ kind: "document-closed", ref: document().ref });
  });

  it("invalidates every suspended scene on route cleanup without deleting genuine recent events", () => {
    const tracker = createScreenContextTracker();
    tracker.roomEntered(room());
    tracker.taskPanelViewed();
    tracker.taskSelected({ ref: "tasks/fictional-reply" });
    tracker.documentOpened(document());
    const before = tracker.getScreenContext();
    expect(before?.recent.length).toBeGreaterThan(0);

    tracker.routeLeft();
    expect(tracker.getScreenContext()?.current).toBeUndefined();
    expect(tracker.getScreenContext()?.recent).toEqual(before?.recent);
    tracker.documentClosed(document().ref);
    tracker.taskPanelClosed();
    expect(tracker.getScreenContext()?.current).toBeUndefined();
    expect(tracker.getScreenContext()?.recent).toEqual(before?.recent);
  });

  it("clears a background document on room navigation instead of resurrecting it later", () => {
    const tracker = createScreenContextTracker();
    tracker.roomEntered(room());
    tracker.documentOpened(document());
    tracker.roomEntered(room("2026-10-26-1245"));
    tracker.documentClosed(document().ref);
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "room", sliceId: "2026-10-26-1245" });
    expect(tracker.getScreenContext()?.recent.some((event) => event.kind === "document-closed")).toBe(false);
    tracker.roomLeft();
    expect(tracker.getScreenContext()?.current).toBeUndefined();
  });

  it("restores task and room scenes across nested panel and document closes", () => {
    const tracker = createScreenContextTracker();
    tracker.roomEntered(room());
    tracker.taskPanelViewed();
    tracker.taskSelected({ ref: "tasks/fictional-reply", title: "A fictional reply task" });
    tracker.documentOpened({ ref: "records/2026-10-26-1200", origin: "manual" });
    tracker.documentClosed("records/2026-10-26-1200");
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "task", view: "selection", ref: "tasks/fictional-reply" });
    tracker.taskPanelClosed();
    expect(tracker.getScreenContext()?.current).toMatchObject({ kind: "room", sliceId: room().sliceId });
    expect(tracker.getScreenContext()?.recent.at(-1)).toMatchObject({ kind: "task-panel-closed" });
  });

  it("clamps or omits optional producer text, rejects invalid refs without throwing, and never truncates a ref", () => {
    const tracker = createScreenContextTracker();
    const invalidRef = `research/${"r".repeat(SCREEN_CONTEXT_LIMITS.ref + 1)}`;
    expect(() => tracker.documentOpened({ ref: invalidRef, origin: "manual" })).not.toThrow();
    expect(tracker.getScreenContext()).toBeUndefined();
    expect(() => tracker.taskSelected({ ref: "research/not-a-task" })).not.toThrow();
    expect(tracker.getScreenContext()).toBeUndefined();
    expect(() => tracker.roomEntered({ sliceId: "not-a-room", origin: "manual" })).not.toThrow();
    expect(tracker.getScreenContext()).toBeUndefined();

    tracker.documentOpened({
      ...document(),
      title: `  ${"t".repeat(SCREEN_CONTEXT_LIMITS.title + 20)}  `,
      excerpt: `  ${"x".repeat(SCREEN_CONTEXT_LIMITS.excerpt + 20)}  `,
    });
    const snapshot = tracker.getScreenContext();
    expect(snapshot?.current).toMatchObject({
      kind: "document",
      ref: document().ref,
      title: "t".repeat(SCREEN_CONTEXT_LIMITS.title),
      excerpt: "x".repeat(SCREEN_CONTEXT_LIMITS.excerpt),
    });
    expect(snapshot?.recent[0]).toMatchObject({ ref: document().ref, title: "t".repeat(SCREEN_CONTEXT_LIMITS.title) });
    expect(parseScreenContext(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);

    tracker.documentObserved({ ref: document().ref, title: "", excerpt: "" });
    expect(tracker.getScreenContext()?.current).not.toHaveProperty("title");
    expect(tracker.getScreenContext()?.current).not.toHaveProperty("excerpt");
  });

  it("deduplicates semantic events, ignores same-page repeats, and bounds history to the newest eight", () => {
    const tracker = createScreenContextTracker();
    tracker.documentOpened(document());
    tracker.documentOpened(document());
    tracker.documentPageChanged({ ref: document().ref, page: 1, edition: "current", excerpt: "Same page, settled text." });
    expect(tracker.getScreenContext()?.recent.filter((event) => event.kind === "document-opened")).toHaveLength(1);
    expect(tracker.getScreenContext()?.recent.some((event) => event.kind === "document-page-changed")).toBe(false);

    for (let index = 0; index < 12; index += 1) {
      tracker.roomEntered(room(`2026-10-26-${String(index).padStart(2, "0")}00`));
    }
    const recent = tracker.getScreenContext()?.recent ?? [];
    expect(recent).toHaveLength(8);
    expect(recent.at(-1)).toMatchObject({ kind: "room-entered", sliceId: "2026-10-26-1100" });
    expect(new Set(recent.map((event) => JSON.stringify({ ...event, at: undefined }))).size).toBe(recent.length);
  });

  it("freezes a send snapshot and keeps it unchanged after later navigation", () => {
    const tracker = createScreenContextTracker();
    tracker.documentOpened(document());
    const snapshot = tracker.getScreenContext();
    expect(snapshot).toBeDefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.current)).toBe(true);
    expect(Object.isFrozen(snapshot?.recent)).toBe(true);
    expect(Object.isFrozen(snapshot?.recent[0])).toBe(true);

    const mutable = snapshot?.current as { page: number };
    expect(() => { mutable.page = 99; }).toThrow(TypeError);
    tracker.documentPageChanged({ ref: document().ref, page: 2, edition: "current", excerpt: "A later page." });
    expect(snapshot?.current).toMatchObject({ kind: "document", page: 1, excerpt: "Page one of an invented document." });
    expect(snapshot?.recent).toHaveLength(1);
  });

  it("isolates identities and provider-like mounts, and reset clears every scoped scene and event", () => {
    const first = createScreenContextTracker();
    const second = createScreenContextTracker();
    first.documentOpened(document());
    first.taskSelected({ ref: "tasks/first-user-only" });
    expect(second.getScreenContext()).toBeUndefined();

    second.documentOpened({ ref: "research/second-user-only", origin: "restored" });
    expect(JSON.stringify(first.getScreenContext())).not.toContain("second-user-only");
    expect(JSON.stringify(second.getScreenContext())).not.toContain("first-user-only");

    first.reset();
    expect(first.getScreenContext()).toBeUndefined();
    expect(second.getScreenContext()?.current).toMatchObject({ kind: "document", ref: "research/second-user-only" });
  });
});
