"use client";

/**
 * TimelineScene (Rev 11) — the timeline view's RIGHT pane only (v0.11 shell
 * refactor). The left AxisBand is now a persistent shell component; this file
 * composes the CardField R3F scene plus the NOW tail marker, the floating lens
 * switcher, and atmosphere overlays.
 *
 * Catalog window, strand selection, scroll progress/zoom refs, and the calendar
 * range are owned by the shell and passed in as props so the left AxisBand can
 * read the same values.
 */
import { useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { filterByStrand, type StackLevel } from "@/lib/timeline3d/stacks";
import type { FieldRung } from "@/lib/timeline3d/units";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import { LensSwitcher } from "./lens-switcher";
import dynamic from "next/dynamic";

const CardField = dynamic(
  () => import("./card-field").then((m) => m.CardField),
  { ssr: false, loading: () => null },
);

export interface TimelineSceneProps {
  /** The loaded catalog window (oldest → newest). */
  entries: TimelineSliceEntry[];
  /** Whether entries older than the loaded window exist. */
  hasMore: boolean;
  /** Prefetch the next older window. */
  onNeedOlder: () => Promise<void>;
  /** Navigate to the chat anchored at a slice. */
  onOpenSlice: (sliceId: string, start?: string) => void;
  /** Slice id from `?at=` — the list lands on it, flashed. */
  initialAtId?: string;
  /** The current picks, in order. Empty = 核心时间线 (no filter). */
  strands: readonly string[];
  /** The shared band feed — forwarded to the left band. */
  feed: FieldFeed;
  /** True while the timeline is the visible pane and therefore owns the feed.
   *  The chat field stays mounted behind it, and two writers is what the feed
   *  exists to prevent. */
  publishing: boolean;
  /** Controlled rung owned by the shell (drives the lens switcher). */
  rung: FieldRung;
  /** Request a rung — CardField runs the anchored transition. */
  onRungChange: (rung: FieldRung) => void;
  /** Reduced-motion preference. */
  reducedMotion: boolean;
}

/** The bottom fade + NOW marker overlaid on the card field. */
function NowTail() {
  const t = useTranslations("timeline3d");
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
      <div className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-[1px]"
          style={{ backgroundColor: "var(--primary)" }}
        />
        {t("now.label")} · {t("now.sub")}
      </div>
    </>
  );
}

export function TimelineScene({
  entries,
  hasMore,
  onNeedOlder,
  onOpenSlice,
  initialAtId,
  strands,
  feed,
  publishing,
  rung,
  onRungChange,
  reducedMotion,
}: TimelineSceneProps) {
  const filtered = filterByStrand(entries, strands);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      <div className="relative h-full w-full">
        <CardField
          entries={filtered}
          hasMore={hasMore}
          onNeedOlder={onNeedOlder}
          onOpenSlice={onOpenSlice}
          initialAtId={initialAtId}
          genKey={strands.join("|") || "core"}
          reducedMotion={reducedMotion}
          feed={feed}
          publishing={publishing}
          rung={rung}
          onRungChange={onRungChange}
        />
        {/* NOW tail marker — the field's bottom is the present. */}
        <NowTail />
        {/* Floating zoom-lens control (Conversation / Slice / Day / Week). */}
        <LensSwitcher
          rung={rung}
          onSelect={onRungChange}
          reducedMotion={reducedMotion}
        />
      </div>

      <AtmosphereVignette />
    </div>
  );
}
