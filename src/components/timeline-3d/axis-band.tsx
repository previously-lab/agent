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
 * collapse or hide the band and let the content take the full width. In chat
 * view the band is narrow (`w-14`); in timeline view it is a slim strip on
 * phones (`w-10`) and expands on desktop (`md:w-44`). The width swap is a
 * 500 ms CSS transition, and the threadline weave blooms/collapses in step
 * with it via its `expanded` prop (see threadline-scene).
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "@teispace/next-themes";
import { useTranslations } from "next-intl";
import type { StackLevel } from "@/lib/timeline3d/stacks";
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
  /** When true the band occupies the collapsed chat width only. */
  narrow?: boolean;
  /** Calendar range: oldest loaded slice → today. */
  range: { oldest: string; now: string };
  /** Card-field scroll progress 0..1 — the threadline reads it per frame. */
  progressRef: React.MutableRefObject<number>;
  /** Card-field zoom level — the threadline camera reads it per frame. */
  levelRef: React.MutableRefObject<StackLevel>;
  /** Screen-Y fractions (0=top, 1=bottom) of the current view's nodes — the
   *  card field's row starts in timeline view, the chat stream's slice seam
   *  rows in chat view; the threadline converges its helices at these
   *  heights. */
  anchorsRef: React.MutableRefObject<number[]>;
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
  narrow = false,
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
    const update = () => setBandWide(el.clientWidth >= 176); // md:w-44
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={bandRef}
      className={`relative shrink-0 ${
        narrow ? "w-14" : "w-10 md:w-44"
      } ${
        reducedMotion ? "" : "transition-[width] duration-500 ease-out"
      }`}
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
        expanded={!narrow}
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
          opacity: !narrow && strand ? 1 : 0,
          transition: `opacity ${strand ? "400ms" : "200ms"} ${strand ? "600ms" : "0ms"}`,
        }}
      >
        {!narrow && strand && (
          <span className="pb-1 font-mono text-[10px] tracking-[0.15em] text-foreground">
            {strand}
            {selectedCount != null && (
              <> · {t("selected.slices", { count: selectedCount })}</>
            )}
          </span>
        )}
      </div>
      {!narrow && (
        <div className="absolute left-1 top-16 md:left-3">
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
