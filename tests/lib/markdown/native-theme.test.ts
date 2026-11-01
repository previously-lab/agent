import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { NATIVE_UTILITY_CLASSES, readNativeStyles, selectNativeStyleRules, subscribeNativeStyles } from "@/lib/markdown/native-theme";
import { readNativeTheme } from "@/lib/markdown/native-document";

afterEach(() => vi.unstubAllGlobals());

function rule(cssText: string, selectorText?: string, children?: CSSRule[]): CSSRule {
  return { cssText, ...(selectorText ? { selectorText } : {}), ...(children ? { cssRules: children } : {}) } as CSSRule;
}

function fakeDocument(rules: CSSRule[]) {
  return { styleSheets: [{ cssRules: rules }], adoptedStyleSheets: [], head: null } as unknown as Document;
}

describe("native compiled styles", () => {
  it("selects supported utilities and their layers, excluding layouts, imports and font requests", () => {
    const styles = selectNativeStyleRules([
      rule("@layer theme, base, components, utilities;"),
      rule("@layer theme { :root { --spacing: .25rem; } }", undefined, []),
      rule("@property --tw-border-style { syntax: '*'; inherits: false; initial-value: solid; }"),
      rule("@font-face { font-family: remote; src: url(https://example.invalid/font); }"),
      rule("@import url(https://example.invalid/css);"),
      rule("@layer utilities {}", undefined, [
        rule(".bg-primary { background: var(--primary); }", ".bg-primary"),
        rule(".bg-primary-extra { display: none; }", ".bg-primary-extra"),
        rule("@media (width >= 40rem) {}", undefined, [rule(".sm\\:grid-cols-2 { grid-template-columns: repeat(2, 1fr); }", ".sm\\:grid-cols-2")]),
        rule(".hover\\:bg-primary\\/90 { &:hover { background: var(--primary); } }", ".hover\\:bg-primary\\/90"),
      ]),
      rule(".desk-shell { position: fixed; }", ".desk-shell"),
    ]);
    expect(styles).toContain("@layer utilities");
    expect(styles).toContain("@media (width >= 40rem)");
    expect(styles).toContain(".hover\\:bg-primary\\/90");
    expect(styles).toContain("@property");
    expect(styles).not.toMatch(/example\.invalid|desk-shell|primary-extra/);
  });

  it("shares the cached snapshot across frames and rebuilds when sheets change", () => {
    const first = rule(".bg-primary { background: var(--primary); }", ".bg-primary");
    Object.defineProperty(first, "cssText", { configurable: true, get: () => ".bg-primary { background: var(--primary); }" });
    const cssRead = vi.spyOn(first, "cssText", "get");
    const doc = fakeDocument([first]);
    const snapshot = readNativeStyles(doc);
    const reads = cssRead.mock.calls.length;
    expect(readNativeStyles(doc)).toBe(snapshot);
    expect(cssRead).toHaveBeenCalledTimes(reads);
    const rules = doc.styleSheets[0].cssRules as unknown as CSSRule[];
    rules.push(rule(".text-foreground { color: var(--foreground); }", ".text-foreground"));
    expect(readNativeStyles(doc).id).not.toBe(snapshot.id);
  });

  it("invalidates a same-size stylesheet edit, but not a root theme class mutation", () => {
    let callback: MutationCallback = () => {};
    class ElementStub { closest() { return this; } }
    vi.stubGlobal("Element", ElementStub);
    vi.stubGlobal("MutationObserver", class { constructor(fn: MutationCallback) { callback = fn; } observe() {} });
    const doc = fakeDocument([rule(".bg-primary { background: red; }", ".bg-primary")]);
    Object.assign(doc, { head: { addEventListener: vi.fn() } });
    const changed = vi.fn();
    const unsubscribe = subscribeNativeStyles(changed, doc);
    const before = readNativeStyles(doc);
    (doc.styleSheets[0].cssRules as unknown as CSSRule[])[0] = rule(".bg-primary { background: blue; }", ".bg-primary");
    callback([{ target: new ElementStub(), addedNodes: [], removedNodes: [] } as unknown as MutationRecord], {} as MutationObserver);
    expect(changed).toHaveBeenCalledOnce();
    const after = readNativeStyles(doc);
    expect(after.id).not.toBe(before.id);
    expect(readNativeStyles(doc)).toBe(after);
    unsubscribe();
  });

  it("does not request inaccessible cross-origin stylesheets", () => {
    const doc = fakeDocument([]);
    Object.defineProperty(doc.styleSheets[0], "cssRules", { get() { throw new Error("SecurityError"); } });
    expect(readNativeStyles(doc).cssText).toBe("@layer theme, base, components, utilities;\n");
  });

  it("compiles every promised utility with the real Tailwind engine and app theme", async () => {
    const require = createRequire(import.meta.url);
    const root = resolve(import.meta.dirname, "../../..");
    const globals = readFileSync(resolve(root, "src/app/globals.css"), "utf8");
    expect(globals).toContain('@source "../lib/markdown/native-theme.ts"');
    const theme = globals.match(/@theme inline\s*\{[\s\S]*?\n\}/)?.[0];
    expect(theme).toBeTruthy();
    const engine = await compile(`@import "tailwindcss";\n${theme}`, {
      loadStylesheet: async (id, base) => {
        const path = id === "tailwindcss" ? require.resolve("tailwindcss/index.css") : resolve(base, id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
    const css = engine.build(NATIVE_UTILITY_CLASSES);
    for (const name of NATIVE_UTILITY_CLASSES) {
      expect(css, name).toContain(`.${name.replace(/([^a-zA-Z0-9_-])/g, "\\$1")}`);
    }
    expect(css).toContain("background-color: var(--primary)");
    expect(css).toContain("color: var(--foreground)");
    // PostCSS is the parser used by the installed Tailwind PostCSS plugin.
    const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss") as {
      parse(css: string): { nodes: Node[] };
    };
    interface Node { type: string; selector?: string; nodes?: Node[]; toString(): string }
    const asRules = (nodes: Node[]): CSSRule[] => nodes.filter((node) => node.type === "rule" || node.type === "atrule")
      .map((node) => rule(node.toString(), node.selector, node.nodes ? asRules(node.nodes) : undefined));
    const shared = selectNativeStyleRules(asRules(postcss.parse(css).nodes));
    expect(shared).toContain(".bg-primary");
    expect(shared.length).toBeLessThan(65_536);
    console.info(`[native-theme] ${NATIVE_UTILITY_CLASSES.length} supported utilities; compiled ${Buffer.byteLength(css)} bytes; shared ${Buffer.byteLength(shared)} bytes`);
  });
});

describe("native surface tokens", () => {
  it("inherits a light paper surface under a dark root, resolving font chains", () => {
    const surface = {} as Element;
    const values = {
      "--paper": "paper-surface", "--background": "paper-surface", "--card-foreground": "paper-ink",
      "--foreground": "paper-ink", "--primary": "app-brand", "--border": "paper-border",
      "--font-serif": "var(--font-body)", "--font-body": "Georgia, serif",
    };
    const styles = Object.assign(Object.keys(values), {
      colorScheme: "light", fontFamily: "var(--font-serif)",
      getPropertyValue: (name: string) => values[name as keyof typeof values] ?? "",
    });
    const computed = vi.fn(() => styles);
    vi.stubGlobal("getComputedStyle", computed);
    vi.stubGlobal("document", { documentElement: { classList: { contains: () => true } } });
    const theme = readNativeTheme("paper", surface);
    expect(computed).toHaveBeenCalledWith(surface);
    expect(theme).toMatchObject({ background: "paper-surface", foreground: "paper-ink", brand: "app-brand", colorScheme: "light", fontBody: "Georgia, serif", fontHeading: "Georgia, serif" });
    expect(theme.cssVariables).toMatchObject({ "--primary": "app-brand", "--background": "paper-surface" });
    readNativeTheme("chat");
    expect(computed).toHaveBeenLastCalledWith(document.documentElement);
  });
});
