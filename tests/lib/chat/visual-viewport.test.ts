import { describe, expect, it } from "vitest";
import { conversationViewportInsets } from "@/lib/chat/visual-viewport";

describe("conversation control viewport anchor", () => {
  it("rests at the layout viewport when no keyboard changes its visible bounds", () => {
    expect(conversationViewportInsets(390, 844)).toEqual({ right: 0, bottom: 0, height: 844 });
    expect(conversationViewportInsets(390, 844, { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 })).toEqual({ right: 0, bottom: 0, height: 844 });
  });
  it("accounts for keyboard shrink and visual viewport panning without double-counting", () => {
    expect(conversationViewportInsets(390, 844, { width: 390, height: 420, offsetLeft: 0, offsetTop: 80 })).toEqual({ right: 0, bottom: 344, height: 420 });
    expect(conversationViewportInsets(390, 420, { width: 390, height: 420, offsetLeft: 0, offsetTop: 0 })).toEqual({ right: 0, bottom: 0, height: 420 });
  });
  it("keeps the control within a panned or zoomed visual viewport and clamps overscroll", () => {
    expect(conversationViewportInsets(800, 600, { width: 400, height: 300, offsetLeft: 80, offsetTop: 100 })).toEqual({ right: 320, bottom: 200, height: 300 });
    expect(conversationViewportInsets(390, 844, { width: 390, height: 844, offsetLeft: 3, offsetTop: 12 })).toEqual({ right: 0, bottom: 0, height: 844 });
  });
});
