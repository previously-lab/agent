import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ getArrivalState: vi.fn(), getSlicePageWithContent: vi.fn() }));
vi.mock("@/lib/episodic/actions", () => actions);
import { getConversationWindow } from "@/lib/episodic/conversation-window";

describe("bounded conversation history", () => {
  beforeEach(() => vi.clearAllMocks());
  it("reads exactly one preceding slice when the current conversation resumes", async () => {
    const arrival = { mode: "resume", sliceId: "2026-11-07-1200", start: "2026-11-07T12:00:00Z", turns: [] };
    actions.getArrivalState.mockResolvedValue(arrival);
    actions.getSlicePageWithContent.mockResolvedValue({ slices: [{ id: "previous" }], hasMore: true });
    expect(await getConversationWindow("user")).toEqual({ arrival, previous: [{ id: "previous" }] });
    expect(actions.getSlicePageWithContent).toHaveBeenCalledExactlyOnceWith(arrival.sliceId, 1, "user");
  });
  it("loads only the latest closed record for a new conversation, even when older pages exist", async () => {
    actions.getArrivalState.mockResolvedValue({ mode: "briefing" });
    actions.getSlicePageWithContent.mockResolvedValue({ slices: [{ id: "last" }], hasMore: true });
    expect((await getConversationWindow("user")).previous).toEqual([{ id: "last" }]);
    expect(actions.getSlicePageWithContent).toHaveBeenCalledExactlyOnceWith(null, 1, "user");
  });
  it("does not replace an unreadable record with deeper history", async () => {
    actions.getArrivalState.mockResolvedValue({ mode: "briefing" });
    actions.getSlicePageWithContent.mockResolvedValue({ slices: [], hasMore: true });
    expect((await getConversationWindow()).previous).toEqual([]);
    expect(actions.getSlicePageWithContent).toHaveBeenCalledTimes(1);
  });
});
