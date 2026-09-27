"use client";

/**
 * FrameCard (paper-and-ink rework) — the time-slice card is a LANDSCAPE
 * BUSINESS CARD (~1.7:1), not a dossier. One face at every zoom level:
 * the top card of a stack is ALWAYS the full original slice card (no
 * summaries), whether it sits alone or heads a pile.
 *
 * FOUR ELEMENTS, AND NO MORE — it is a calling card, not a transcript:
 *   the "name"    the slice's focus — serif, light weight, large
 *   the "title"   when it happened — mono, small, letter-spaced
 *   the "company" the strand — a small quiet INK chip + sans label
 *   one quiet line  turn count, and continued-from if it exists
 * Clicking the card opens the conversation — the full read lives there.
 * The ledger rows, the previously excerpt and the turn bubbles are GONE
 * from the face (the turn/previously READ stays warm in `SliceCardFace`,
 * but none of it renders on the card).
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
 * THE PRINTED-IN TEXT EFFECT rides exactly two strings — the serif focus
 * and the timecode: `text-shadow-paper-in`, a 1px near-white highlight
 * at the stroke's foot, light from the same upper-left as everything
 * else. 1px, no blur — wider stops reading as an edge and becomes a
 * smudge. Body text and all CJK stay FLAT ink: a highlight under every
 * stroke doubles the stroke weight and closes the counters at these
 * sizes.
 *
 * INK COLOUR IS QUIET: the strand chip is a low-chroma TINT of the
 * strand colour with a same-hue denser edge (dot gain), never a
 * saturated fill — a screen of solid blocks reads as a colour chart,
 * which the repo already recorded as the failure to avoid.
 *
 * Layout (all sizes in em; root font-size derives from the card's short
 * edge via `cardEmFor`, so the face scales with the responsive geometry
 * tiers): the name sits upper-left large, the title beneath it, the
 * company chip and the quiet line share the foot.
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
 *  reach components rendered here (no hooks allowed inside). The calling
 *  card wears only two: the turn count and the continued-from line. */
export interface FrameCardTexts {
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
  const dry = !entry.focus;
  // The card's root em — what every `em` inside this face resolves
  // against (`cardEmFor` owns the formula AND its bounds).
  const em = cardEmFor(geo);

  const contDate = continuedDate(entry.continues_from);
  const startD = new Date(entry.start);
  const dateText = `${startD.getFullYear()}/${startD.getMonth() + 1}/${startD.getDate()} ${hhmm(entry.start)}`;
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
      {/* Top light falloff — the sheet's own lighting, not an element. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />

      <div className="relative flex h-full flex-col px-[1.3em] pb-[0.9em] pt-[0.85em]">
        {/* The "name" — the slice's focus. Serif, light, large, and one of
            the TWO strings allowed the printed-in edge. */}
        <div
          className={`line-clamp-2 font-serif font-light leading-[1.12] tracking-tight text-card-foreground text-shadow-paper-in ${
            dry ? "text-[1.5em]" : "text-[1.32em]"
          }`}
        >
          {entry.focus || `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim()}
        </div>

        {/* The "title" — when it happened. Mono, small, letter-spaced,
            flat except the printed-in edge. */}
        <div className="mt-[0.5em] font-mono text-[0.6em] leading-none tracking-[0.16em] text-foreground/55">
          <span className="tabular-nums text-shadow-paper-in">{dateText}</span>
        </div>

        <span className="mt-auto" />

        {/* The foot: the "company" chip (left) and the one quiet line
            (right). */}
        <div className="flex items-end justify-between gap-[1em]">
          {strandName ? (
            <span
              className="inline-flex max-w-[55%] shrink-0 items-center gap-[0.4em] rounded-[0.35em] px-[0.55em] py-[0.3em]"
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
              <span className="truncate font-sans text-[0.58em] leading-none tracking-[0.08em] text-foreground/75">
                {strandName}
              </span>
            </span>
          ) : (
            <span />
          )}
          <span className="flex shrink-0 items-center gap-[0.9em] font-sans lining-nums text-[0.58em] leading-none tracking-[0.08em] text-muted-foreground">
            {contDate && <span>↳ {texts.continuedFrom(contDate)}</span>}
            {entry.turn_count != null && (
              <span>{texts.turns(entry.turn_count)}</span>
            )}
          </span>
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
