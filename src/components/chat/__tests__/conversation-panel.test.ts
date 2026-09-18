import { describe, expect, it } from "vitest";
import {
  isPanelHotkey,
  reducePanelMode,
  type ConversationPanelMode,
} from "../conversation-panel";

const MODES: ConversationPanelMode[] = ["pill", "dock", "fullscreen"];

describe("reducePanelMode", () => {
  it("open lifts the pill to the dock and is a no-op when already open", () => {
    expect(reducePanelMode("pill", "open")).toBe("dock");
    expect(reducePanelMode("dock", "open")).toBe("dock");
    expect(reducePanelMode("fullscreen", "open")).toBe("fullscreen");
  });

  it("toggle opens the pill and collapses either open tier", () => {
    expect(reducePanelMode("pill", "toggle")).toBe("dock");
    expect(reducePanelMode("dock", "toggle")).toBe("pill");
    expect(reducePanelMode("fullscreen", "toggle")).toBe("pill");
  });

  it("toggleFullscreen grows the dock to fullscreen and back", () => {
    expect(reducePanelMode("dock", "toggleFullscreen")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "toggleFullscreen")).toBe("dock");
    // From the pill it opens straight into fullscreen — one verb, no
    // hidden intermediate state.
    expect(reducePanelMode("pill", "toggleFullscreen")).toBe("fullscreen");
  });

  it("collapse always lands on the pill", () => {
    for (const mode of MODES) {
      expect(reducePanelMode(mode, "collapse")).toBe("pill");
    }
  });
});

describe("isPanelHotkey", () => {
  it("matches Cmd/Ctrl+J, case-insensitively", () => {
    expect(isPanelHotkey({ key: "j", metaKey: true, ctrlKey: false })).toBe(
      true,
    );
    expect(isPanelHotkey({ key: "J", metaKey: false, ctrlKey: true })).toBe(
      true,
    );
  });

  it("ignores bare J and the neighbours' chords (K = search, . = rungs)", () => {
    expect(isPanelHotkey({ key: "j", metaKey: false, ctrlKey: false })).toBe(
      false,
    );
    expect(isPanelHotkey({ key: "k", metaKey: true, ctrlKey: false })).toBe(
      false,
    );
    expect(isPanelHotkey({ key: ".", metaKey: true, ctrlKey: false })).toBe(
      false,
    );
  });
});
