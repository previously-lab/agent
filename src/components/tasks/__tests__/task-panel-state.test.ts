import { describe, expect, it } from "vitest";
import type { TaskPanelReadyPage } from "@/lib/tasks/panel";
import {
  applyPanelResponse,
  beginPanelRequest,
  failPanelRequest,
  initialTaskPanelUiState,
  panelNextOffset,
  simulationFreezeAfterTaskPanel,
  taskPanelKeyDisposition,
} from "../task-panel-state";

function page(offset: number, hasMore: boolean): TaskPanelReadyPage {
  return {
    status: "ready",
    snapshot: `snapshot-${offset}`,
    counts: { active: 2, waiting: 0, paused: 0, finished: 0, all: 2 },
    filter: "active",
    total: 2,
    items: [{
      ref: `tasks/task-${offset}`,
      summary: "Task",
      status: "open",
      needsReview: false,
      updatedAt: "2026-10-26T12:00:00.000Z",
      evidence: [],
      pendingResults: [],
    }],
    hasMore,
    nextOffset: hasMore ? offset + 1 : null,
  };
}

describe("task panel UI state", () => {
  it("ignores stale responses and accumulates only accepted load-more pages", () => {
    const initial = initialTaskPanelUiState();
    const firstRequest = beginPanelRequest(initial, "active", true);
    expect(applyPanelResponse(firstRequest, firstRequest.requestId + 1, page(0, true))).toBeNull();
    const first = applyPanelResponse(firstRequest, firstRequest.requestId, page(0, true))!;
    expect(first.items.map((item) => item.ref)).toEqual(["tasks/task-0"]);
    expect(panelNextOffset(first)).toBe(1);

    const moreRequest = beginPanelRequest(first, "active", false);
    const more = applyPanelResponse(moreRequest, moreRequest.requestId, page(1, false))!;
    expect(more.items.map((item) => item.ref)).toEqual(["tasks/task-0", "tasks/task-1"]);
    expect(panelNextOffset(more)).toBeNull();
  });

  it("marks only the latest failure and resets cleanly for a close/open cycle", () => {
    const request = beginPanelRequest(initialTaskPanelUiState(), "waiting", true);
    expect(failPanelRequest(request, request.requestId - 1)).toBeNull();
    const failed = failPanelRequest(request, request.requestId)!;
    expect(failed.requestFailed).toBe(true);
    expect(failed.loading).toBe(false);
    expect(initialTaskPanelUiState()).toEqual({
      requestId: 0, filter: "active", loading: false,
      requestFailed: false, response: null, items: [],
    });
  });

  it("restores the exact prior simulation pause unless a transition owns it", () => {
    expect(simulationFreezeAfterTaskPanel(false, false)).toBe(false);
    expect(simulationFreezeAfterTaskPanel(true, false)).toBe(true);
    expect(simulationFreezeAfterTaskPanel(false, true)).toBe(true);
  });

  it("cannot pass paper/game navigation keys through, but preserves dialog controls", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "w", "a", "s", "d", "+", "-", "."]) {
      expect(taskPanelKeyDisposition(key)).toBe("stop-world");
    }
    expect(taskPanelKeyDisposition("Escape")).toBe("close");
    for (const key of ["Tab", "Enter", " ", "Shift"]) {
      expect(taskPanelKeyDisposition(key)).toBe("allow");
    }
  });
});
