"use client";

/**
 * TimelineScene (Rev 11) — the timeline view's RIGHT pane only (v0.11 shell
 * refactor). The left AxisBand is now a persistent shell component; this file
 * composes the CardField R3F scene (WebGL present) or the StackList DOM
 * fallback (WebGL absent) plus the NOW tail marker, the floating lens
 * switcher, and atmosphere overlays.
 *
 * Catalog window, strand selection, scroll progress/zoom refs, and the calendar
 * range are owned by the shell and passed in as props so the left AxisBand can
 * read the same values.
 */
import { useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import { filterByStrand, type StackLevel } from "@/lib/timeline3d/stacks";
import {
  AtmosphereBackdrop,
  AtmosphereVignette,
  TIMELINE_KEYFRAMES,
} from "./atmosphere";
import { StackList } from "./stack-list";
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
  onOpenSlice: (sliceId: string) => void;
  /** Slice id from `?at=` — the list lands on it, flashed. */
  initialAtId?: string;
  /** Currently selected strand, if any. */
  strand: string | null;
  /** Card-field scroll progress 0..1 — forwarded to the left band. */
  progressRef: React.MutableRefObject<number>;
  /** Card-field zoom level — forwarded to the left band. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** Controlled zoom level owned by the shell (drives the lens switcher). */
  level: StackLevel;
  /** Request a zoom level — CardField runs the anchored transition. */
  onLevelChange: (level: StackLevel) => void;
  /** Card-field row-start screen-Y fractions — forwarded to the left band
   *  so the threadline converges its helices at the row starts. */
  anchorsRef: React.MutableRefObject<number[]>;
  /** Reduced-motion preference. */
  reducedMotion: boolean;
  /** WebGL capability from the shell; false forces the StackList fallback. */
  webgl: boolean;
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
  strand,
  progressRef,
  levelRef,
  level,
  onLevelChange,
  anchorsRef,
  reducedMotion,
  webgl,
}: TimelineSceneProps) {
  const filtered = filterByStrand(entries, strand);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <style>{TIMELINE_KEYFRAMES}</style>
      <AtmosphereBackdrop />

      <div className="relative h-full w-full">
        {webgl ? (
          <>
            <CardField
              entries={filtered}
              hasMore={hasMore}
              onNeedOlder={onNeedOlder}
              onOpenSlice={onOpenSlice}
              initialAtId={initialAtId}
              genKey={strand ?? "core"}
              reducedMotion={reducedMotion}
              progressRef={progressRef}
              levelRef={levelRef}
              level={level}
              onLevelChange={onLevelChange}
              anchorsRef={anchorsRef}
            />
            {/* NOW tail marker — the field's bottom is the present. */}
            <NowTail />
            {/* Floating zoom-lens control (Slice / Day / Week). */}
            <LensSwitcher
              level={level}
              onSelect={onLevelChange}
              reducedMotion={reducedMotion}
            />
          </>
        ) : (
          <StackList
            entries={filtered}
            hasMore={hasMore}
            onNeedOlder={onNeedOlder}
            initialAtId={initialAtId}
            genKey={strand ?? "core"}
          />
        )}
      </div>

      <AtmosphereVignette />
    </div>
  );
}
