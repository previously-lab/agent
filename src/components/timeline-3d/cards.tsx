"use client";

/**
 * Rev 9 timeline cards (doc/design/v0.10.0 §R9.1) — the card is a FIXED-SIZE
 * playing card ("档案卡"): same face at every zoom level, in a few JS-side
 * responsive width tiers (`cardGeometryFor` — the 3D card field reads the
 * same numbers, CSS-only breakpoints can't feed WebGL).
 *
 * Face layout: corner index row (color square + date + time · turn count) →
 * serif focus title (two lines) → tone in italic serif → strand color
 * squares; a 2px strand-colored spine on the left edge. Paper feel: subtle
 * noise grain + a top light-falloff gradient + a hairline frame.
 *
 * The card FACE lives here; the pile's sheets are real 3D geometry (see
 * `row-group.tsx`), so nothing in this file draws a stack.
 */
import { useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { strandColor } from "@/lib/timeline3d/ink";
import { strandAccent } from "@/lib/timeline3d/layout";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import {
  type CardGeometry,
} from "@/lib/timeline3d/stacks";
import "./timeline-3d.css";

// ─── Shared bits ────────────────────────────────────────────────────────────

/** Sharp corner square — the site's signature punctuation mark. */
export function ColorSquare({
  color,
  className = "size-1.5",
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-[1px] ${className}`}
      // Dynamic: the strand colour arrives as a JS string per strand.
      style={{ backgroundColor: color }}
    />
  );
}

/** "HH:MM" local time; "" for unparseable input. */
export function hhmm(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Fallback card title when the slice is still dry: "08-17 14:02". */
function dateTimeLabel(entry: TimelineSliceEntry): string {
  return `${entry.date.slice(5)} ${hhmm(entry.start)}`.trim();
}

/** One accent per card: the first strand's color (grey when strandless). */
function accentOf(entry: TimelineSliceEntry): string {
  return strandAccent(entry.strands);
}

/** Paper grain lives in timeline-3d.css (`.tl-noise`) — the SVG turbulence
    tile is a static data URI, not render-time state. */

// ─── The card face (one face for every level) ───────────────────────────────

function CardFace({
  entry,
  /** Corner index label: the slice's date (L0) or the group label (L1/L2). */
  label,
  geo,
  flash,
  /** Stack count badge (L1/L2). */
  count,
}: {
  entry: TimelineSliceEntry;
  label: string;
  geo: CardGeometry;
  flash?: boolean;
  count?: number;
}) {
  const t = useTranslations("timeline3d.card");
  const accent = accentOf(entry);
  const dry = !entry.focus;
  return (
    // Dynamic size: the tier's fixed card geometry (geo.cardW/H) — JS-side
    // responsive geometry the CSS-only breakpoints can't feed.
    <span
      className={`relative block overflow-hidden rounded-xl bg-card text-left ring-1 transition-[box-shadow,ring-color] duration-200 ${
        flash
          ? "tl-flash ring-primary/70"
          : "ring-foreground/10 group-hover:ring-foreground/25"
      }`}
      style={{ width: geo.cardW, height: geo.cardH }}
    >
      {/* Top light falloff + paper grain. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
      <span
        aria-hidden
        className="tl-noise pointer-events-none absolute inset-0 text-foreground opacity-[0.035] dark:opacity-[0.05]"
      />
      {/* The strand spine. `accent` is the slice's strand colour (JS); 0.85
          keeps the 2px bar below full strength. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[2px] opacity-85"
        style={{ backgroundColor: accent }}
      />

      <span className="relative flex h-full flex-col px-4 pb-3.5 pt-3">
        {/* Corner index. */}
        <span className="flex items-center gap-1.5 font-mono text-[10px] leading-none tracking-[0.16em] text-muted-foreground">
          <ColorSquare color={accent} />
          {label}
          <span className="ml-auto flex items-center gap-2 tracking-[0.08em]">
            {entry.turn_count != null && (
              <span className="text-foreground/55">
                {t("turns", { count: entry.turn_count })}
              </span>
            )}
            {count != null && count > 1 && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 font-semibold text-foreground/70">
                ×{count}
              </span>
            )}
          </span>
        </span>

        {/* Title — the focus sentence, or a big date for a dry slice. */}
        <span
          className={`mt-3 line-clamp-2 font-serif leading-snug tracking-tight text-card-foreground ${
            dry ? "text-[19px]" : "text-[16.5px]"
          }`}
        >
          {entry.focus || dateTimeLabel(entry)}
        </span>

        <span className="mt-auto" />

        {/* Tone, set like a margin note. */}
        {entry.tone && (
          <span className="mb-1.5 text-right font-serif text-[11.5px] italic leading-none text-muted-foreground/85">
            {entry.tone}
          </span>
        )}

        {/* Strand squares. */}
        {entry.strands.length > 0 && (
          <span className="flex items-center gap-1">
            {entry.strands.slice(0, 5).map((name) => (
              <ColorSquare key={name} color={strandColor(name)} className="size-1" />
            ))}
          </span>
        )}
      </span>
    </span>
  );
}
