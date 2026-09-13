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
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import type { CrossingMark } from "@/components/chat/conversation-field";
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
  /** Card-field scroll progress 0..1 — forwarded to the left band. */
  progressRef: React.MutableRefObject<number>;
  /** Card-field zoom level — forwarded to the left band. A `StackLevel` for
   *  the reason on `CardFieldProps.levelRef`: the band scales by the GROUPING,
   *  and the two finest rungs share one. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** Controlled rung owned by the shell (drives the lens switcher). */
  rung: FieldRung;
  /** Request a rung — CardField runs the anchored transition. */
  onRungChange: (rung: FieldRung) => void;
  /** Card-field row-start anchors (screen-Y fraction + the row's strands) —
   *  forwarded to the left band so it winds each strand at the row starts. */
  anchorsRef: React.MutableRefObject<FieldAnchor[]>;
  /** Where the announcing row boundary sits (screen-Y fraction), for the left
   *  band's anchor dot. */
  crossingRef: React.MutableRefObject<CrossingMark>;
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
  progressRef,
  levelRef,
  rung,
  onRungChange,
  anchorsRef,
  crossingRef,
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
          progressRef={progressRef}
          levelRef={levelRef}
          rung={rung}
          onRungChange={onRungChange}
          anchorsRef={anchorsRef}
          crossingRef={crossingRef}
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
