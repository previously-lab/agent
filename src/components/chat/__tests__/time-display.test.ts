import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The initial animation frame shows the origin, making an unintended ticker
// observable without relying on browser frame timing.
vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value, startValue }: { value: number; startValue: number }) =>
    React.createElement("span", { "data-ticker-target": value }, startValue),
}));

let TimeDisplay: typeof import("../time-display").TimeDisplay;
beforeAll(async () => {
  vi.stubGlobal("React", React);
  ({ TimeDisplay } = await import("../time-display"));
});
afterAll(() => vi.unstubAllGlobals());

const timestamp = new Date(2026, 9, 20, 9, 7).toISOString();
function render(props: Partial<React.ComponentProps<typeof TimeDisplay>> = {}) {
  return renderToStaticMarkup(React.createElement(TimeDisplay, { timestamp, ...props }));
}
function textContent(html: string) {
  return html.replace(/<[^>]*>/g, "");
}

describe("ordinary conversation timestamps", () => {
  it.each([
    ["full", "2026/10/20 09:07"],
    ["date", "2026/10/20"],
    ["time", "09:07"],
  ] as const)("renders the correct %s value before any animation frame", (mode, expected) => {
    const html = render({ mode });
    expect(textContent(html)).toBe(expected);
    expect(html).not.toContain("data-ticker-target");
    expect(html).not.toContain("1996");
    expect(html).toContain(`<time dateTime="${timestamp}"`);
  });

  it("keeps a machine-readable timestamp even when only the clock is visible", () => {
    const html = render({ mode: "time" });
    expect(html).toContain(`dateTime="${timestamp}"`);
    expect(textContent(html)).toBe("09:07");
  });

  it("falls back to the correct static target when the origin is invalid", () => {
    const html = render({ from: "invalid" });
    expect(textContent(html)).toBe("2026/10/20 09:07");
    expect(html).not.toContain("data-ticker-target");
  });

  it("does not render an invalid timestamp", () => {
    expect(render({ timestamp: "invalid" })).toBe("");
  });

  it("preserves rolling fields only for explicit time travel", () => {
    const from = new Date(2024, 1, 3, 4, 5).toISOString();
    const html = render({ from });
    expect(html).toContain('data-ticker-target="2026">2024</span>');
    expect(html).toContain('data-ticker-target="10">2</span>');
    expect(html).toContain('data-ticker-target="20">3</span>');
    expect(html).toContain('data-ticker-target="9">4</span>');
    expect(html).toContain('data-ticker-target="7">5</span>');
    expect(html).toContain(`dateTime="${timestamp}"`);
  });
});
