import { describe, expect, it } from "vitest";
import {
  SCREEN_CONTEXT_LIMITS,
  screenContextSchema,
} from "@/lib/chat/screen-context";
import { createScreenContextTracker } from "@/lib/chat/screen-context-tracker";

const room = {
  sliceId: "2026-10-26-1200",
  title: "Fictional reading room",
  origin: "manual" as const,
};
const paper = {
  ref: "research/fictional-hotel-notes",
  title: "Fictional hotel notes",
  page: 1,
  totalPages: 4,
  edition: "original" as const,
  excerpt: "An invented opening page.",
  origin: "manual" as const,
};
const trackerAtFixedTime = () => createScreenContextTracker(
  () => Date.parse("2026-10-26T14:00:00.000Z"),
);

describe("screen observation provenance", () => {
  it.each([
    { label: "a settled resize", page: 1 },
    { label: "background repagination", page: 2 },
  ])("does not replace the foreground task selection during $label", ({ page }) => {
    const tracker = trackerAtFixedTime();
    tracker.roomEntered(room);
    tracker.documentOpened(paper);
    tracker.taskPanelViewed();
    tracker.taskSelected({ ref: "tasks/fictional-reply", title: "A fictional reply" });
    const before = tracker.getScreenContext();

    tracker.documentObserved({
      ref: paper.ref,
      page,
      totalPages: paper.totalPages,
      edition: paper.edition,
      excerpt: "A background reader settlement.",
    });

    const after = tracker.getScreenContext();
    expect(after?.current).toEqual(before?.current);
    expect(after?.current).toMatchObject({
      kind: "task",
      view: "selection",
      ref: "tasks/fictional-reply",
    });
    expect(after?.recent).toEqual(before?.recent);
    tracker.taskPanelClosed();
    expect(tracker.getScreenContext()?.current).toMatchObject({
      kind: "document",
      ref: paper.ref,
      page,
      excerpt: "A background reader settlement.",
    });
  });

  it("does not resurrect a closed document from a late passive callback", () => {
    const tracker = trackerAtFixedTime();
    tracker.roomEntered(room);
    tracker.documentOpened(paper);
    tracker.documentClosed(paper.ref);
    const before = tracker.getScreenContext();
    expect(before?.current).toMatchObject({ kind: "room", sliceId: room.sliceId });

    tracker.documentObserved({
      ref: paper.ref,
      page: 2,
      totalPages: 4,
      edition: "original",
      excerpt: "A callback queued before the document closed.",
    });

    expect(tracker.getScreenContext()?.current).toEqual(before?.current);
    expect(tracker.getScreenContext()?.recent).toEqual(before?.recent);
  });

  it("does not restore a document after route cleanup from a late reader callback", () => {
    const tracker = trackerAtFixedTime();
    tracker.documentOpened(paper);
    tracker.routeLeft();
    const before = tracker.getScreenContext();
    expect(before?.current).toBeUndefined();

    tracker.documentObserved({
      ref: paper.ref,
      page: 2,
      totalPages: 4,
      edition: "original",
    });

    expect(tracker.getScreenContext()?.current).toBeUndefined();
    expect(tracker.getScreenContext()?.recent).toEqual(before?.recent);
  });

  it("updates the visible edition and clamps passive metadata without inventing a manual action", () => {
    const tracker = trackerAtFixedTime();
    tracker.documentOpened(paper);
    const recent = tracker.getScreenContext()?.recent;

    tracker.documentObserved({
      ref: paper.ref,
      page: 2,
      totalPages: 3,
      edition: "history",
      title: "T".repeat(SCREEN_CONTEXT_LIMITS.title + 30),
      excerpt: "E".repeat(SCREEN_CONTEXT_LIMITS.excerpt + 30),
    });

    const observed = tracker.getScreenContext();
    expect(observed?.current).toMatchObject({
      kind: "document",
      ref: paper.ref,
      page: 2,
      totalPages: 3,
      edition: "history",
      origin: "observed",
      title: "T".repeat(SCREEN_CONTEXT_LIMITS.title),
      excerpt: "E".repeat(SCREEN_CONTEXT_LIMITS.excerpt),
    });
    expect(observed?.recent).toEqual(recent);
    expect(screenContextSchema.safeParse(observed).success).toBe(true);
  });

  it("ignores passive callbacks from a different paper while the visible paper stays open", () => {
    const tracker = trackerAtFixedTime();
    tracker.documentOpened(paper);
    const before = tracker.getScreenContext();
    tracker.documentObserved({ ref: "research/another-fictional-paper", page: 3 });
    expect(tracker.getScreenContext()).toEqual(before);
  });
});
