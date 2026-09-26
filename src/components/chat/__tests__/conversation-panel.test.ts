import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPanelHotkey,
  reducePanelMode,
  SUBTITLE_LINE_HEIGHT_PX,
  type ConversationPanelMode,
} from "../conversation-panel";

// The geometry constants this suite used to import moved into globals.css
// (and Tailwind tokens) when the inline styles they fed were re-homed — the
// pins moved with them, read straight back out of the stylesheet.
const GLOBALS_CSS = readFileSync("src/app/globals.css", "utf8");

const MODES: ConversationPanelMode[] = ["pill", "fullscreen"];

describe("subtitle geometry", () => {
  it("pins the FPS-radio layout: capped block, fixed label column, 20px lines", () => {
    // The block must stay a dialogue strip, never full-bleed, and the body
    // must start at a fixed x past the label column (the w-28 token, 112px,
    // plus the gap-3 body gap, 12px — both in conversation-panel.tsx).
    const blockMax = /--subtitle-block-max:\s*(\d+)px/.exec(GLOBALS_CSS);
    expect(blockMax).not.toBeNull();
    expect(Number(blockMax![1])).toBe(660);
    expect(Number(blockMax![1])).toBeGreaterThan(112 + 12);
    expect(SUBTITLE_LINE_HEIGHT_PX).toBe(20);
  });

  it("pins the user's warm-grey ink as an oklch value", () => {
    const ink = /--subtitle-user-ink:\s*(oklch\([^)]*\))/.exec(GLOBALS_CSS);
    expect(ink).not.toBeNull();
    // Neutral-warm: low chroma, hue in the yellow band.
    const [l, c, h] = ink![1].slice(6, -1).split(/\s+/);
    expect(Number.parseFloat(c)).toBeLessThan(0.05);
    expect(Number.parseFloat(h)).toBeGreaterThan(40);
    expect(Number.parseFloat(h)).toBeLessThan(110);
    expect(Number.parseFloat(l)).toBeGreaterThan(0.4);
    expect(Number.parseFloat(l)).toBeLessThan(0.8);
  });
});

describe("reducePanelMode", () => {
  it("open expands the pill to fullscreen and is a no-op when already open", () => {
    expect(reducePanelMode("pill", "open")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "open")).toBe("fullscreen");
  });

  it("toggle flips the two tiers in both directions", () => {
    expect(reducePanelMode("pill", "toggle")).toBe("fullscreen");
    expect(reducePanelMode("fullscreen", "toggle")).toBe("pill");
  });

  it("toggleFullscreen grows the pill to fullscreen and folds fullscreen back to the pill", () => {
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
