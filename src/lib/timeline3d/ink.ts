/**
 * Strand ink — which of the ten strand colours a name gets (v0.11).
 *
 * THE PALETTE LIVES IN CSS (`--strand-1` … `--strand-10`, globals.css), not
 * here. This module only decides WHICH one a strand is, and it is deliberately
 * the smallest thing that can do that: hash the name, take it modulo ten. The
 * colours themselves are a design asset — a designer edits them in one place
 * and every surface in the app follows, including the WebGL band, which reads
 * the custom property back off the document.
 *
 * COLOURS REPEAT, ON PURPOSE. An earlier revision generated a hue from the
 * name across the whole colour wheel, so no two strands could ever collide.
 * That was the wrong goal. Two facts kill it:
 *
 *   - Roughly ten is the ceiling on how many categorical colours a person can
 *     tell apart at all (ColorBrewer, and Seaborn's default palette is ten).
 *     Past that, "never collides" buys nothing — the eye has already given up.
 *   - Spanning the wheel to keep ten colours apart drags in the blue-greens
 *     and yellow-greens, and those are exactly the hues that read as impure.
 *
 * So the palette is a hand-picked arc, and two strands drawing the same colour
 * is an expected outcome rather than a bug. Colour is a recognition AID here,
 * never the identifier: every coloured mark sits beside the strand's name in
 * text, and the band's lines are told apart by their seat around the core and
 * their depth, not by hue.
 *
 * NORMALISATION IS THE PART THAT MATTERS. Before hashing, a name is trimmed,
 * NFKC-folded and lowercased. "Fitness", "fitness " and "ｆｉｔｎｅｓｓ" are ONE
 * strand and must be one colour. The agent's tag casing drifts between turns;
 * without this the same strand quietly forks into two colours and grows a
 * second line in the band.
 *
 * NFKC rather than NFC, deliberately: NFC only COMPOSES (é stays one codepoint
 * either way), it does not fold the full-width forms a CJK IME produces —
 * U+FF46 stays U+FF46 and would hash as a different strand. NFKC does fold
 * them, which is the failure this layer exists to stop. The cost is the other
 * direction: two names that are compatibility-equivalent but textually
 * distinct ("①" and "1") collapse to one colour. For a tag that is the right
 * trade — the fork being prevented is real, the collision it risks is
 * pathological.
 */

/** How many colours the palette has. Keep in step with globals.css. */
export const STRAND_PALETTE_SIZE = 10;

/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** The strandless grey — a slice with no strands gets no palette colour. */
export const STRANDLESS_GREY = "oklch(0.556 0 0)";

/** Default alpha for strand-tinted surfaces (chat user bubbles) — 8–12%
 *  reads as a tint in both light and dark themes. */
export const STRAND_TINT_ALPHA = 0.12;

/** The brand blue as a concrete colour, for the places that need "the brand"
 *  as a paintable value rather than a token (canvas consumers). */
export const BRAND_INK = "oklch(0.6 0.23 260)";

/**
 * The canonical form of a strand name for hashing: trimmed, NFKC, lowercased.
 * See the file header for why NFKC and not NFC.
 *
 * Everything that colours by strand must go through this — including any
 * lookup side. A caller that hashes a raw name gets a different colour from
 * one that normalised, and the bug shows up as two colours for one strand.
 */
export function normalizeStrandName(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

/**
 * FNV-1a, 32-bit, over UTF-16 code units. Chosen for its avalanche: djb2
 * (`h * 33 + c`) carries a suffix difference mostly into the low bits, so
 * nearby names would cluster into nearby palette slots.
 */
export function fnv1a(input: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Math.imul keeps the multiply in 32-bit lanes; `>>> 0` makes it unsigned.
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which palette entry a strand gets, 0-based — the one decision this module
 * makes. Stable for a given name forever, and identical on the server and the
 * client, so a strand never changes colour between a render and a hydration.
 *
 * A nameless strand goes to slot 0 rather than to an accident of FNV's offset
 * basis surviving the modulo; the empty name is a caller error, and a defined
 * answer is easier to debug than an arbitrary one.
 */
export function strandIndex(name: string): number {
  const normalized = normalizeStrandName(name);
  if (normalized.length === 0) return 0;
  return fnv1a(normalized) % STRAND_PALETTE_SIZE;
}

/**
 * A strand's colour as a CSS value, for anything that paints — card accents,
 * strand chips, bubble tints, the filter swatch.
 *
 * It returns a VAR REFERENCE, not a resolved colour: the palette is defined
 * once in globals.css and this only names which entry to use. That keeps the
 * colours editable in one place, and it means a consumer needs no idea which
 * theme is live — CSS resolves it.
 *
 * Callers that must hand a real colour to something which cannot resolve a
 * variable (the three.js band, a hex conversion) resolve it off the document
 * instead; see `resolveStrandInk` in threadline-scene.
 */
export function strandColor(name: string): string {
  return `var(--strand-${strandIndex(name) + 1})`;
}

/**
 * ANY strand colour, turned into a low-alpha tint — the FIELD form, for
 * surfaces that are a background rather than a mark.
 *
 * A palette entry at full strength is a mark: a chip, a swatch, a line. Spread
 * across a paragraph-sized bubble it stops being a label and becomes a slab of
 * colour, and a column of cards reads as a colour chart rather than a
 * timeline. Every large area in the app therefore paints this instead, and the
 * alpha argument is the one knob that decides how much of the page a strand
 * colour is allowed to occupy.
 *
 * Takes a COLOUR (anything `strandColor` returned, or the strandless grey) so
 * a caller that already holds one does not have to look the name up again.
 */
export function tintOf(color: string, alpha: number): string {
  return `oklch(from ${color} l c h / ${alpha})`;
}

/**
 * A strand NAME's low-alpha tint — `tintOf` for callers that have the name
 * rather than the colour. A null/undefined name is the strandless grey: a
 * slice with no strands must tint as no-strand, never as whatever colour the
 * empty string hashes to.
 */
export function strandTint(
  name: string | null | undefined,
  alpha: number,
): string {
  return tintOf(name ? strandColor(name) : STRANDLESS_GREY, alpha);
}
