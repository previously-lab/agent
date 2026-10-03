"use client";

/**
 * FrameCard (American Psycho layout) — the time-slice card is a LANDSCAPE
 * BUSINESS CARD (~1.7:1), and its face takes the skeleton read off the
 * four cards in the film: only the CENTRE block is centred, the corners
 * are pinned; letter-spacing runs inversely to size; no rules, no boxes,
 * no fills — type on a bare field. One face at every zoom level: the top
 * card of a stack is ALWAYS the full original slice card (no summaries),
 * whether it sits alone or heads a pile.
 *
 * The four blocks, in the reference's positions:
 *   top-left   the turn count — a bare figure, no label (the "212 555 6342")
 *   top-right  the strand — a small quiet INK chip + the strand name,
 *              right-aligned as its own block, with a smaller line
 *              beneath it (the continued-from date, when there is one —
 *              the "Mergers and Acq.")
 *   centre     WHEN — the date, large and serif (the "PATRICK BATEMAN"),
 *              and the clock one size down beneath it (the "Vice
 *              President"), the pair sitting slightly ABOVE true centre
 *   bottom     the focus — one small line, the widest tracking, spanning
 *              nearly the full width (the address line)
 * Clicking the card opens the conversation — the full read lives there.
 *
 * THE RECESSED TYPE rides exactly the two centre strings — the date and
 * the clock: `text-shadow-paper-recess`, ONE shadow, single-sided and
 * blurred (a lone light lip at the lower-right — see globals.css): the
 * zero-blur pair ghosted, and the gradient-in-glyph alternative never
 * paints under the field's 3D transforms. No highlight sits under the
 * strokes to double their weight and close the counters at these sizes;
 * body text and all CJK stay FLAT ink. Everything else about the
 * material is unchanged:
 *
 * MATERIAL — two surfaces, not four mechanisms (卡纸方案):
 *   PAPER is the sheet: `bg-paper bg-paper-grain-card`, the SAME stock as
 *   the board, grain untouched. INK is anything printed: it sits ON TOP
 *   of the sheet, much flatter, with a slightly DENSER EDGE (dot gain).
 *   Nothing sinks in, nothing stands out — the old relief vocabulary
 *   (shadow-paper-sink / -raise, bg-paper-plate) is gone from this face.
 *   SEPARATION IS THE CONTACT SHADOW, not elevation: one thick sheet held
 *   off the board by its own thickness, shadow in the crevice at the
 *   edge — `shadow-paper-contact`, never the wide floating-panel lift.
 *
 * INK COLOUR IS QUIET: the strand chip is a low-chroma TINT of the
 * strand colour with a same-hue denser edge (dot gain), never a
 * saturated fill — a screen of solid blocks reads as a colour chart,
 * which the repo already recorded as the failure to avoid.
 *
 * Layout (all sizes in em; root font-size derives from the card's short
 * edge via `cardEmFor`, so the face scales with the responsive geometry
 * tiers).
 */
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { tintOf } from "@/lib/timeline3d/ink";
import { strandAccent } from "@/lib/timeline3d/layout";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import type { FrameGeometry, StackRow } from "@/lib/timeline3d/stacks";
import { cardEmFor, weekLabelFor } from "@/lib/timeline3d/stacks";
import { hhmm } from "./cards";
import { useSliceTurns } from "./slice-content";
import "./timeline-3d.css";

/** Translated strings, passed in from OUTSIDE the R3F Canvas — drei Html
 *  renders in the Canvas's own React root, so next-intl context does not
 *  reach components rendered here (no hooks allowed inside). The card
 *  wears four: the centre date (the locale's own long form — "2026年7月
 *  31日" / "July 31, 2026"), the turn count, and the continued-from line. */
export interface FrameCardTexts {
  /** "2026年7月31日" / "July 31, 2026" — the centre "name". */
  date(d: Date): string;
  /** "N 轮" / "N turns". */
  turns(count: number): string;
  /** "续自 {{date}}" / "cont. {{date}}". */
  continuedFrom(date: string): string;
}

/** "HH:MM" already lives in cards.tsx; group label format matches the DOM
 *  fallback cards so e2e aria-labels stay identical. */
function groupLabel(row: StackRow, locale: string): string {
  const d = row.top.date;
  if (row.level === 2) return weekLabelFor(d, locale);
  const date = new Date(`${d}T12:00:00`);
  const weekday = dateTimeFormat(locale, { weekday: "short" }).format(
    date,
  );
  return `${d.slice(5, 10).replace("-", "/")} ${weekday}`;
}

function accentOf(entry: TimelineSliceEntry): string {
  return strandAccent(entry.strands);
}

function continuedDate(id: string | undefined): string | null {
  if (!id) return null;
  return `${id.slice(5, 7)}/${id.slice(8, 10)}`;
}

export interface FrameCardProps {
  entry: TimelineSliceEntry;
  geo: FrameGeometry;
  flash?: boolean;
  texts: FrameCardTexts;
}

export function FrameCard({
  entry,
  geo,
  flash,
  texts,
}: FrameCardProps) {
  const accent = accentOf(entry);
  // The card's root em — what every `em` inside this face resolves
  // against (`cardEmFor` owns the formula AND its bounds).
  const em = cardEmFor(geo);

  const contDate = continuedDate(entry.continues_from);
  const startD = new Date(entry.start);
  // The company line: the FIRST strand only — a calling card names one
  // company. The chip is ink (a low-chroma tint of the strand colour),
  // its edge a same-hue step denser than the fill (dot gain).
  const strandName = entry.strands[0];
  const chipTint = tintOf(accent, 0.14);
  const chipEdge = tintOf(accent, 0.38);

  return (
    // Dynamic: tier card size + the frame's own em (zoom-driven root font
    // size — every inner measurement is em-relative to it).
    <div
      className={`bg-paper bg-paper-grain-card shadow-paper-contact relative block overflow-hidden rounded-[0.9em] text-left ${
        flash ? "tl-flash" : ""
      }`}
      style={{
        width: geo.cardW,
        height: geo.cardH,
        fontSize: em,
      }}
    >
      <div className="relative flex h-full flex-col px-[1.3em] pb-[0.9em] pt-[0.85em]">
        {/* The pinned corners — only the centre block is centred. */}
        <div className="flex items-start justify-between gap-[1em]">
          {/* Top-left — the turn count: a bare figure, letter-spaced, no
              label. An empty span when the count is not known yet, so the
              corner pair keeps its justify-between geometry. */}
          <span className="font-mono text-[0.62em] leading-none tracking-[0.16em] text-foreground/60 tabular-nums">
            {entry.turn_count != null ? texts.turns(entry.turn_count) : ""}
          </span>

          {/* Top-right — the strand: the quiet ink chip + name,
              right-aligned as its own block, with the smaller
              continued-from line beneath it ("Mergers and Acq."). */}
          {strandName || contDate ? (
            <span className="flex flex-col items-end gap-[0.4em] text-right">
              {strandName && (
                <span
                  className="inline-flex shrink-0 items-center gap-[0.4em] rounded-[0.35em] px-[0.55em] py-[0.3em]"
                  // Dynamic, both: the strand colour arrives as JS per slice —
                  // the fill as a low-chroma tint, the edge a same-hue step
                  // denser (dot gain). Ink on paper, never a saturated slab.
                  style={{
                    backgroundColor: chipTint,
                    boxShadow: `inset 0 0 0 1px ${chipEdge}`,
                  }}
                >
                  <span
                    aria-hidden
                    className="inline-block size-[0.42em] shrink-0 rounded-[2px]"
                    style={{ backgroundColor: accent }}
                  />
                  <span className="font-sans text-[0.58em] leading-none tracking-[0.1em] text-foreground/75">
                    {strandName}
                  </span>
                </span>
              )}
              {contDate && (
                <span className="font-sans text-[0.52em] leading-none tracking-[0.16em] text-muted-foreground">
                  ↳ {texts.continuedFrom(contDate)}
                </span>
              )}
            </span>
          ) : (
            <span />
          )}
        </div>

        {/* The centre — the identifying thing is WHEN: the date, large and
            serif, the clock one size down beneath it. The pair sits
            slightly ABOVE true centre (the region's bottom padding lifts
            it). These two strings are the only recessed type on the card;
            every tracking runs inverse to size — the biggest is freely
            spaced, the smallest is opened right up. */}
        <div className="flex flex-1 flex-col items-center justify-center pb-[0.8em]">
          <div className="font-serif font-light text-[1.55em] leading-none tracking-[0.06em] text-card-foreground text-shadow-paper-recess">
            {texts.date(startD)}
          </div>
          <div className="mt-[0.5em] font-mono text-[0.66em] leading-none tracking-[0.3em] text-foreground/60 tabular-nums text-shadow-paper-recess">
            {hhmm(entry.start)}
          </div>
        </div>

        {/* The foot — the focus: one small line, the widest tracking on
            the card, spanning nearly the full width. */}
        <div className="line-clamp-1 font-sans text-[0.62em] leading-relaxed tracking-[0.2em] text-foreground/70">
          {entry.focus || `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim()}
        </div>
      </div>
    </div>
  );
}

/**
 * Self-loading face wrapper for the 3D card field.
 *
 * Content fetching used to live in `CardField` and was passed down through a
 * `Map<string, ContentSlot>` prop; that caused the whole scene to re-render on
 * every resolve and made the field flicker while scrolling. `SliceCardFace`
 * keeps `FrameCard` a pure presentational component and moves the subscription
 * to the per-card level via `useSliceTurns`.
 *
 * The calling card renders NONE of the turn content — but the READ stays
 * warm: the conversation surface and the deep link rely on the per-card
 * subscription pattern, and re-adding any content to the face must not
 * re-plumb the data flow.
 */
export function SliceCardFace({
  entry,
  geo,
  flash,
  texts,
}: {
  entry: TimelineSliceEntry;
  geo: FrameGeometry;
  flash?: boolean;
  texts: FrameCardTexts;
}) {
  useSliceTurns(entry.id);
  return (
    <FrameCard
      entry={entry}
      geo={geo}
      flash={flash}
      texts={texts}
    />
  );
}

/** Accessible label for a frame card (matches the DOM fallback cards). */
export function frameCardLabel(
  row: StackRow,
  locale: string,
): { label: string; aria: string } {
  if (row.level === 0) {
    const label =
      `${row.top.date.slice(5).replace("-", "/")} ${hhmm(row.top.start)}`.trim();
    return { label, aria: label };
  }
  const label = groupLabel(row, locale);
  return { label, aria: `${label} · ${row.count}` };
}
