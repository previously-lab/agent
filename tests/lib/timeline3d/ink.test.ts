import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRAND_INK,
  fnv1a,
  normalizeStrandName,
  strandColor,
  strandIndex,
  STRANDLESS_GREY,
  STRAND_PALETTE_SIZE,
  strandTint,
  STRAND_TINT_ALPHA,
  tintOf,
} from "@/lib/timeline3d/ink";

/** A sample the spec is expected to handle: agent-style English tags, CJK,
 *  near-sequential siblings, punctuation, and one-char names. */
const NAMES = [
  "fitness",
  "half-marathon",
  "personal growth",
  "speech",
  "wedding",
  "工作",
  "读书",
  "读书2",
  "project-a",
  "project-b",
  "project-c",
  "s3",
  "x",
  "a/b",
  "a.b",
  "a-b",
];

const CSS = readFileSync(
  fileURLToPath(new URL("../../../src/app/globals.css", import.meta.url)),
  "utf8",
);

/** Slice out a `selector { ... }` block, brace-balanced, skipping the selector
 *  text so a `{` inside an earlier comment cannot swallow the block. */
function readBlock(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no ${selector} block in globals.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated ${selector} block`);
}

/** The `--strand-N` values from the stylesheet, in order. */
function paletteFromCss(): { l: number; c: number; h: number }[] {
  const root = readBlock(CSS, ":root");
  const out: { l: number; c: number; h: number }[] = [];
  for (let i = 1; i <= 64; i++) {
    // The trailing colon matters: `--strand-1:` must not match `--strand-10:`.
    const m = root.match(new RegExp(`--strand-${i}:\\s*oklch\\(([^)]+)\\)`));
    if (!m) break;
    const [l, c, h] = m[1].trim().split(/\s+/).map(Number);
    out.push({ l, c, h });
  }
  return out;
}

describe("normalizeStrandName — the layer that is about the data", () => {
  it("trims, lowercases and NFKC-folds to one canonical form", () => {
    const canonical = normalizeStrandName("fitness");
    for (const variant of ["fitness", "Fitness", "  fitness  ", "FITNESS", "FiTnEsS "]) {
      expect(normalizeStrandName(variant)).toBe(canonical);
    }
  });

  it("folds the full-width forms a CJK IME produces", () => {
    // NFKC, not NFC: NFC leaves U+FF46 alone, so this pair would otherwise be
    // two strands and grow two lines for one thing.
    expect(normalizeStrandName("ｆｉｔｎｅｓｓ")).toBe("fitness");
    expect(normalizeStrandName("ＦＩＴＮＥＳＳ")).toBe("fitness");
  });

  it("leaves CJK that has no compatibility form untouched", () => {
    expect(normalizeStrandName(" 读书 ")).toBe("读书");
  });
});

describe("fnv1a — the avalanche the palette index depends on", () => {
  it("is deterministic and returns an unsigned 32-bit integer", () => {
    expect(fnv1a("fitness")).toBe(fnv1a("fitness"));
    for (const name of NAMES) {
      const h = fnv1a(name);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("separates names that differ only in their LAST character", () => {
    // djb2 (`h * 33 + c`) carries a suffix difference mostly into the low
    // bits — which is precisely the part a modulo reads — so sibling names
    // would cluster into adjacent palette slots. FNV-1a's final multiply
    // pushes the difference through the whole word.
    const hs = ["reading-1", "reading-2", "reading-3", "reading-4"].map(fnv1a);
    expect(new Set(hs).size).toBe(hs.length);
  });
});

describe("strandIndex — the one decision the module makes", () => {
  it("always lands on a palette slot", () => {
    for (const name of [...NAMES, "", "   ", "🧵", "a-much-longer-strand-name"]) {
      const i = strandIndex(name);
      expect(Number.isInteger(i)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(STRAND_PALETTE_SIZE);
    }
  });

  it("is deterministic and normalised the same way the hash is", () => {
    expect(strandIndex("fitness")).toBe(strandIndex("fitness"));
    for (const variant of ["Fitness", "  FITNESS ", "ｆｉｔｎｅｓｓ"]) {
      expect(strandIndex(variant)).toBe(strandIndex("fitness"));
    }
  });

  it("sends a nameless strand to slot 0 by decision, not by accident", () => {
    expect(strandIndex("")).toBe(0);
    expect(strandIndex("    ")).toBe(0);
  });

  it("spreads a real sample across the whole palette", () => {
    // Reuse is expected and fine, but the hash still has to be doing its job:
    // if the index ever collapsed to a couple of slots the app would look
    // monochrome. Sixty names should reach every slot.
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) seen.add(strandIndex(`strand-${i}`));
    expect(seen.size).toBe(STRAND_PALETTE_SIZE);
  });

  it("spreads near-sequential names, the case a weak hash would fail", () => {
    const slots = Array.from({ length: 9 }, (_, i) => strandIndex(`topic-${i}`));
    // Not every pair can differ (there are only ten slots) but nine siblings
    // must not pile onto two or three of them.
    expect(new Set(slots).size).toBeGreaterThanOrEqual(5);
  });
});

describe("strandColor — a reference to the CSS palette, not a colour", () => {
  it("names the palette entry the index points at (1-based in CSS)", () => {
    for (const name of NAMES) {
      expect(strandColor(name)).toBe(`var(--strand-${strandIndex(name) + 1})`);
    }
  });

  it("carries no colour of its own — the palette lives in the stylesheet", () => {
    // If a colour ever shows up in this string, the palette has been
    // duplicated out of globals.css and the two copies will drift.
    for (const name of NAMES) {
      expect(strandColor(name)).not.toContain("oklch");
    }
  });
});

describe("tintOf — the FIELD form of any strand colour", () => {
  it("wraps any colour with an alpha and changes nothing else", () => {
    for (const c of ["var(--strand-3)", STRANDLESS_GREY, BRAND_INK]) {
      expect(tintOf(c, 0.12)).toBe(`oklch(from ${c} l c h / 0.12)`);
    }
  });

  it("is what strandTint delegates to, so the two cannot drift", () => {
    for (const name of ["work", "读书", null, undefined]) {
      const base = name ? strandColor(name) : STRANDLESS_GREY;
      expect(strandTint(name, 0.5)).toBe(tintOf(base, 0.5));
    }
  });
});

describe("strandTint — the shared slice → bubble tint", () => {
  it("keeps the strand's palette entry and only adds an alpha", () => {
    expect(strandTint("work", STRAND_TINT_ALPHA)).toBe(
      `oklch(from ${strandColor("work")} l c h / ${STRAND_TINT_ALPHA})`,
    );
    expect(STRAND_TINT_ALPHA).toBeGreaterThanOrEqual(0.08);
    expect(STRAND_TINT_ALPHA).toBeLessThanOrEqual(0.12);
  });

  it("tints a null/undefined name with the strandless grey, never a hue", () => {
    expect(strandTint(null, 0.1)).toBe(`oklch(from ${STRANDLESS_GREY} l c h / 0.1)`);
    expect(strandTint(undefined, 0.1)).toBe(
      `oklch(from ${STRANDLESS_GREY} l c h / 0.1)`,
    );
  });
});

describe("the palette in globals.css", () => {
  it("has exactly STRAND_PALETTE_SIZE entries", () => {
    // The count is the contract between the module and the stylesheet: the
    // modulo is against this number, so a palette of nine would leave slot ten
    // unreachable and a palette of eleven would strand `--strand-11`.
    expect(paletteFromCss()).toHaveLength(STRAND_PALETTE_SIZE);
  });

  it("covers every slot strandColor can emit", () => {
    const entries = paletteFromCss();
    for (const name of NAMES) {
      expect(strandColor(name)).toBe(`var(--strand-${strandIndex(name) + 1})`);
    }
    expect(entries.length).toBeGreaterThanOrEqual(
      Math.max(...NAMES.map(strandIndex)) + 1,
    );
  });

  it("is built as five hues × two lightnesses, not ten even hues", () => {
    // THE design invariant. Ten hues spread over this arc would sit ~14° apart
    // and be indistinguishable — hue alone cannot carry ten categories inside
    // a narrow arc. The palette is therefore five hue pairs, and the lightness
    // step is what makes each half tellable from its partner. If someone
    // "simplifies" this back to ten even hues, this fails.
    const p = paletteFromCss();
    for (let i = 0; i < p.length; i += 2) {
      expect(p[i + 1].h).toBeCloseTo(p[i].h, 6);
      expect(Math.abs(p[i + 1].l - p[i].l)).toBeGreaterThanOrEqual(0.15);
    }
    // …and the five hue families are distinct from one another.
    const hues = p.filter((_, i) => i % 2 === 0).map((e) => e.h);
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("stays out of the blue-green and yellow-green zones", () => {
    // The user's brief: no colour that reads as impure. Hues run blue → rose
    // (245 → 357); nothing may enter the teal (~200) or olive (~90-150) bands.
    for (const { h } of paletteFromCss()) {
      expect(h).toBeGreaterThanOrEqual(240);
      expect(h).toBeLessThanOrEqual(360);
    }
  });

  it("is theme-independent — it is not redefined under .dark", () => {
    // The band's dark-mode quietening is the band's own visibility ceiling,
    // not a second palette. A `.dark` copy would be a second place to keep in
    // step, so its absence is asserted rather than assumed.
    const dark = readBlock(CSS, ".dark");
    expect(dark).not.toMatch(/--strand-\d+:/);
  });
});

describe("BRAND_INK", () => {
  it("is a plain oklch colour a canvas consumer can convert", () => {
    expect(BRAND_INK).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/);
    expect(BRAND_INK).not.toContain("var(");
  });
});
