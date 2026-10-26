import { describe, expect, it } from "vitest";
import {
  buildConversationHref,
  buildDocumentHref,
  buildGameHref,
  buildLibraryHref,
  deskHistoryOwnsTarget,
  deskTargetEqual,
  hasHistoryEntrance,
  markDeskHistoryState,
  markOriginPanelMode,
  normalizeDeskOpenOptions,
  originPanelModeFromHistory,
  parseWorkspaceDocumentTarget,
  reduceDeskNavigation,
  requestedPanelMode,
  shouldFocusSyncedDocument,
  workspaceDocumentTarget,
  workspaceSurface,
} from "@/lib/workspace/navigation";

describe("workspace document route targets", () => {
  it("round-trips a canonical record and exact source options", () => {
    const target = workspaceDocumentTarget("records/2026-10-12-1430", {
      turnId: "turn_1-ABC",
      role: "assistant",
      edition: "original",
    });
    expect(target).not.toBeNull();
    const href = buildDocumentHref(target!, "persona=alice&view=field");
    expect(href).toContain("persona=alice");
    expect(href).not.toContain("view=field");
    expect(parseWorkspaceDocumentTarget(href)).toEqual(target);
  });

  it("builds only local conversation, selector, and game return targets", () => {
    const current = "persona=alice&doc=records/2026-10-12-1430&returnTo=https://evil.example";
    expect(buildLibraryHref(current)).toBe("/app?persona=alice&view=field");
    expect(buildLibraryHref(current, true)).toBe("/app?persona=alice&view=field&history=1");
    expect(buildConversationHref(current)).toBe("/app?persona=alice");
    expect(buildGameHref(current)).toBe("/game?persona=alice");
  });

  it("uses B's location limits and rejects malformed locations", () => {
    expect(normalizeDeskOpenOptions({ turnId: "a".repeat(128) })).toEqual({ turnId: "a".repeat(128) });
    expect(normalizeDeskOpenOptions({ turnId: "a".repeat(129) })).toBeNull();
    expect(normalizeDeskOpenOptions({ turnId: "bad turn" })).toBeNull();
    expect(normalizeDeskOpenOptions({ role: "system" as "user" })).toBeNull();
    expect(normalizeDeskOpenOptions({ edition: "future" as "current" })).toBeNull();
  });

  it("rejects storage paths, traversal, schemes, encoded separators, and duplicate target keys", () => {
    for (const ref of [
      "memory/records/2026-10-12-1430",
      "records/../2026-10-12-1430",
      "https://example.com/record",
      "records%2F2026-10-12-1430",
      "records/2026-02-30-1430",
      "records/2026-10-12-2460",
    ]) {
      expect(workspaceDocumentTarget(ref)).toBeNull();
    }
    expect(parseWorkspaceDocumentTarget("doc=records/2026-10-12-1430&doc=dossier/previously")).toBeNull();
    expect(parseWorkspaceDocumentTarget("doc=records/2026-10-12-1430&turn=a&turn=b")).toBeNull();
  });

  it("distinguishes conversation, library, reader, game, and invalid document links", () => {
    expect(workspaceSurface("/app")).toBe("conversation");
    expect(workspaceSurface("/app", "view=field")).toBe("library");
    expect(workspaceSurface("/app", "view=field&history=1")).toBe("library");
    expect(workspaceSurface("/app", "doc=records/2026-10-12-1430")).toBe("reader");
    expect(workspaceSurface("/app", "doc=https://example.com")).toBe("library");
    expect(workspaceSurface("/app", "view=game")).toBe("game");
    expect(workspaceSurface("/game")).toBe("game");
    expect(workspaceSurface("/settings")).toBe("utility");
  });

  it("compares the complete target so old options do not masquerade as a new citation", () => {
    const oldTarget = workspaceDocumentTarget("records/2026-10-12-1430", { turnId: "old" });
    const newTarget = workspaceDocumentTarget("records/2026-10-12-1430", { turnId: "new" });
    expect(deskTargetEqual(oldTarget, newTarget)).toBe(false);
    expect(deskTargetEqual(oldTarget, workspaceDocumentTarget("records/2026-10-12-1430", { turnId: "old" }))).toBe(true);
  });
});

describe("workspace history and panel intent", () => {
  it("marks owned close entries without discarding Next's history state", () => {
    const nextState = { idx: 42 };
    const marked = markDeskHistoryState(nextState, "/app?doc=dossier%2Fpreviously");
    expect(marked.idx).toBe(42);
    expect(deskHistoryOwnsTarget(marked, "/app?doc=dossier%2Fpreviously")).toBe(true);
    expect(deskHistoryOwnsTarget(marked, "/app?doc=dossier%2Fdirection")).toBe(false);
    const withMode = markOriginPanelMode(marked, "fullscreen");
    expect(originPanelModeFromHistory(withMode)).toBe("fullscreen");
  });

  it("keeps mini sends mini off the main conversation but makes jumps visible", () => {
    expect(requestedPanelMode("game", "pill", "fullscreen", "send")).toBe("pill");
    expect(requestedPanelMode("reader", "pill", "fullscreen", "send")).toBe("pill");
    expect(requestedPanelMode("conversation", "pill", "fullscreen", "send")).toBe("fullscreen");
    expect(requestedPanelMode("game", "pill", "fullscreen", "jump")).toBe("fullscreen");
    expect(requestedPanelMode("reader", "pill", "fullscreen", "jump")).toBe("fullscreen");
    expect(requestedPanelMode("game", "fullscreen", "pill", "explicit")).toBe("pill");
  });

  it("uses a semantic history entrance, never a scroll gesture", () => {
    expect(hasHistoryEntrance([{ kind: "live" }, { kind: "seam" }])).toBe(true);
    expect(hasHistoryEntrance([{ kind: "history-turn" }])).toBe(true);
    expect(hasHistoryEntrance([{ kind: "live" }, { kind: "briefing" }])).toBe(false);
  });
});

describe("reader focus versus restoration", () => {
  it("refocuses explicit reopens without conflating them with Back", () => {
    const initial = { epoch: 0, focus: false };
    const first = reduceDeskNavigation(initial, true);
    const reopened = reduceDeskNavigation(first, true);
    const back = reduceDeskNavigation(reopened, false);
    expect(first).toEqual({ epoch: 1, focus: true });
    expect(reopened).toEqual({ epoch: 2, focus: true });
    expect(back).toEqual({ epoch: 2, focus: false });
    expect(reduceDeskNavigation(back, false)).toEqual(back);
  });

  it("focuses direct and pending explicit opens but not popstate restoration", () => {
    expect(shouldFocusSyncedDocument(false, false)).toBe(true);
    expect(shouldFocusSyncedDocument(true, false)).toBe(true);
    expect(shouldFocusSyncedDocument(true, true)).toBe(true);
    expect(shouldFocusSyncedDocument(false, true)).toBe(false);
  });
});
