"use client";

/**
 * AxisBand — the persistent left time axis shared by the chat and timeline
 * views (v0.11 shell refactor). Composes the ThreadlineScene R3F DNA weave,
 * the AmbientScene 2D ruler (NOW dot; year ticks currently suppressed), the
 * RulerYearLabels DOM overlay (not rendered — year scale hidden by decision,
 * kept for the redo), the StrandFilter chip, edge fades, and the
 * strand-selection caption.
 *
 * The band renders ONLY when WebGL is available; without it the caller should
 * omit the band and let the content take the full width. It is ONE fixed
 * width — a 32 px strip (`w-8`) — in both views and at every breakpoint, so
 * the same braid is what the user sees whether they are reading the chat or
 * the timeline; nothing about the band is a view-switch affordance any more.
 * The threadline reads its cylinder radius against that live width every
 * frame (see threadline-scene), so the geometry follows the real strip rather
 * than a constant.
 *
 * `showChrome` is the only thing the caller still varies: it gates the two
 * overlays that need horizontal room — the strand filter chip and the
 * selection caption. See `AxisBandProps`.
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@teispace/next-themes";
import { useTranslations } from "next-intl";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import type { RulerRange } from "@/lib/timeline3d/ruler-math";
import {
  computeYearMarkers,
  resolveLabelledMarkers,
  RULER_LABEL_MIN_WIDTH_PX,
  RULER_LABEL_RIGHT_PX,
} from "@/lib/timeline3d/ruler-math";
import type { StrandListItem } from "@/lib/episodic/actions";
import { RollingField } from "@/components/chat/rolling-number";
import { StrandFilter } from "./strand-filter";

/** Year scale (DOM labels + canvas ticks) is suppressed by decision — both
 *  views hide it for now; the NOW dot and the threadline stay. Components
 *  and code paths are kept mounted-but-inert (never rendered / never drawn)
 *  so the redo can flip this single flag. */
const SHOW_YEAR_RULER = false;

const AmbientScene = dynamic(() => import("./ambient-scene"), {
  ssr: false,
  loading: () => null,
});
const ThreadlineScene = dynamic(() => import("./threadline-scene"), {
  ssr: false,
  loading: () => null,
});

/**
 * RulerYearLabels — the DOM half of the year ruler: one RollingField year
 * label per year-boundary tick (the same rolling-digits component the chat
 * side uses for time, so both read identically). Positions come from the
 * shared ruler-math strip; a rAF loop reads progressRef and positions the
 * label nodes IMPERATIVELY (style.top, no setState in the hot path), so the
 * labels paint in the same frame as this rAF — the tick canvas (AmbientScene)
 * reads the same progressRef in its own rAF and therefore can never be one
 * frame ahead mid-scroll. React state only mounts/unmounts label nodes when
 * the labelled year SET changes. Labels hide when the band is too narrow
 * (`w-14` chat width) or when two would sit closer than MIN_LABEL_GAP_PX
 * apart (the older one loses). Theme-aware via the text-foreground token.
 */
function RulerYearLabels({
  progressRef,
  range,
}: {
  progressRef: React.MutableRefObject<number>;
  range: RulerRange;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<{ year: number; y: number }[]>([]);
  const labelRefs = useRef(new Map<number, HTMLDivElement | null>());
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const height = el.clientHeight;
      if (el.clientWidth < RULER_LABEL_MIN_WIDTH_PX || height === 0) {
        labelRefs.current.forEach((node) => {
          if (node && node.style.display !== "none") node.style.display = "none";
        });
        if (lastKeyRef.current !== "") {
          lastKeyRef.current = "";
          setLabels([]);
        }
        return;
      }
      const all = computeYearMarkers(range, height, progressRef.current);
      const labelled = all ? resolveLabelledMarkers(all, height) : [];
      const live = new Set<number>();
      for (const m of labelled) {
        live.add(m.year);
        const node = labelRefs.current.get(m.year);
        if (node) {
          if (node.style.display === "none") node.style.display = "";
          node.style.top = `${m.y}px`;
        }
      }
      labelRefs.current.forEach((node, year) => {
        if (node && !live.has(year) && node.style.display !== "none") {
          node.style.display = "none";
        }
      });
      const key = labelled.map((m) => m.year).join("|");
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key;
        setLabels(labelled.map((m) => ({ year: m.year, y: m.y })));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [range, progressRef]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      {labels.map((m) => (
        <div
          key={m.year}
          ref={(node) => {
            if (node) labelRefs.current.set(m.year, node);
            else labelRefs.current.delete(m.year);
          }}
          className="absolute"
          style={{
            right: RULER_LABEL_RIGHT_PX,
            top: m.y,
            transform: "translateY(-50%)",
          }}
        >
          <span className="font-mono text-[9px] leading-none text-foreground/80">
            <RollingField value={m.year} digits={4} />
          </span>
        </div>
      ))}
    </div>
  );
}

export interface AxisBandProps {
  /** Whether the band renders its own overlay chrome — the strand filter chip
   *  and the selection caption. These are timeline-view affordances and they
   *  need horizontal room; the strip is a fixed 32 px (see the width note in
   *  the file header), so the caller decides, and the band renders fully
   *  without them. Does NOT affect the band's width or its braid. */
  showChrome?: boolean;
  /** Calendar range: oldest loaded slice → today. */
  range: { oldest: string; now: string };
  /** Card-field scroll progress 0..1 — the threadline reads it per frame. */
  progressRef: React.MutableRefObject<number>;
  /** Card-field zoom level — the threadline camera reads it per frame. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** The current view's nodes as screen-Y fractions (0=top, 1=bottom) plus
   *  the strands each carries — the card field's row starts in timeline view,
   *  the chat stream's slice seam rows in chat view; the band winds its strand
   *  lines at these heights. */
  anchorsRef: React.MutableRefObject<FieldAnchor[]>;
  /** Currently selected strand, if any. */
  strand: string | null;
  /** Strand list for the filter chip. */
  strandList: StrandListItem[];
  /** Full set of strand names drawn by the threadline (capped). */
  ambientStrands: string[];
  /** Count of slices carrying the selected strand (for the caption). */
  selectedCount: number | null;
  /** Reduced-motion preference passed to the threadline. */
  reducedMotion: boolean;
  /** Strand selection callback. */
  onSelectStrand: (strand: string | null) => void;
}

export function AxisBand({
  showChrome = false,
  range,
  progressRef,
  levelRef,
  anchorsRef,
  strand,
  strandList,
  ambientStrands,
  selectedCount,
  reducedMotion,
  onSelectStrand,
}: AxisBandProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const t = useTranslations("timeline3d");

  // The drop shadow under the thread bundle only exists on the wide desktop
  // band; on a slim strip (phone timeline, or the collapsed chat band) the
  // same blur would smear across the whole width and its clipped right edge
  // reads as a hard dark seam against the card field. Measure the actual band
  // width and skip the shadow entirely unless the band is wide.
  const bandRef = useRef<HTMLDivElement>(null);
  const [bandWide, setBandWide] = useState(false);
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return;
    const update = () => setBandWide(el.clientWidth >= 90); // md:w-24
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={bandRef}
      // `ml-1.5` is the gutter between the window edge and the cable. Without
      // it the braid's outer strands land on x=0 and the band reads as
      // bleeding off the side of the page rather than sitting on it. The
      // margin moves the WHOLE strip (canvas included), so the cable keeps its
      // size — insetting the canvas instead would shrink the radius and pack
      // the strands tighter, which is the opposite of what the moiré needs.
      className="relative ml-1.5 w-8 shrink-0"
    >
      {/* Soft drop shadow behind the 3D thread bundle. Rendered only on the
          wide desktop band: on a slim strip (phone timeline, or the collapsed
          chat band) the blurred gradient spans nearly the whole width and
          smears the weave into one soft blob — the narrow-band look must stay
          crisp. */}
      {bandWide && (
        <div
          className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 transition-[width,filter,opacity] duration-700 ease-out"
          style={{
            width: bandWide ? (strand ? "34%" : "58%") : strand ? "44%" : "60%",
            maxWidth: bandWide ? (strand ? 70 : 130) : strand ? 36 : 44,
            transform: bandWide ? "translateX(-38%)" : "translateX(-50%)",
            background: dark
              ? "radial-gradient(ellipse 38% 88% at 32% 42%, rgba(0,0,0,0.28), transparent)"
              : "radial-gradient(ellipse 38% 88% at 32% 42%, rgba(0,0,0,0.16), transparent)",
            filter: `blur(${bandWide ? (strand ? 16 : 26) : strand ? 9 : 13}px)`,
            opacity: dark ? (bandWide ? 0.4 : 0.3) : bandWide ? 0.9 : 0.7,
          }}
        />
      )}
      <ThreadlineScene
        strands={ambientStrands}
        selected={strand}
        progressRef={progressRef}
        range={range}
        levelRef={levelRef}
        anchorsRef={anchorsRef}
        reducedMotion={reducedMotion}
      />
      <AmbientScene progressRef={progressRef} range={range} />
      {SHOW_YEAR_RULER && <RulerYearLabels progressRef={progressRef} range={range} />}
      {/* Fade-out at the ruler band's edges (bottom weaker so the NOW
          dot stays visible). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-background to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/60 to-transparent" />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-2"
        style={{
          opacity: showChrome && strand ? 1 : 0,
          transition: `opacity ${strand ? "400ms" : "200ms"} ${strand ? "600ms" : "0ms"}`,
        }}
      >
        {showChrome && strand && (
          <span className="pb-1 font-mono text-[10px] tracking-[0.15em] text-foreground">
            {strand}
            {selectedCount != null && (
              <> · {t("selected.slices", { count: selectedCount })}</>
            )}
          </span>
        )}
      </div>
      {/* Centred in the strip, not left-aligned: the trigger is a compact
          square (see StrandFilter), and the strip has no room for a labelled
          control — the old pill was 127 px wide inside a 32 px band and hung
          its label over the content. */}
      {showChrome && (
        <div className="absolute inset-x-0 top-16 flex justify-center">
          <StrandFilter
            strands={strandList}
            selected={strand}
            onSelect={onSelectStrand}
          />
        </div>
      )}
    </div>
  );
}
