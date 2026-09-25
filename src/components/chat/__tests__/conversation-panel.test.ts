import { describe, expect, it } from "vitest";
import {
  isPanelHotkey,
  reducePanelMode,
  type ConversationPanelMode,
} from "../conversation-panel";

const MODES: ConversationPanelMode[] = ["pill", "fullscreen"];

describe("reducePanelMode", () => {
  it("open expands the strip to fullscreen and is a no-op when already open", () => {
    expect(reducePanelMode("pill", "open")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "open")).toBe("fullscreen");
  });

  it("toggle flips the two tiers in both directions", () => {
    expect(reducePanelMode("pill", "toggle")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "toggle")).toBe("pill");
  });

  it("toggleFullscreen grows the strip to fullscreen and folds fullscreen back to the strip", () => {
    expect(reducePanelMode("pill", "toggleFullscreen")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "toggleFullscreen")).toBe("pill");
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
