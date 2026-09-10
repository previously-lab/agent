"use client";

/**
 * AmbientScene (Rev 15, "the Ruler") — the timeline's LEFT band: a minimal,
 * engraved year ruler. A single tick per year boundary runs from NOW upward,
 * extending past the data window when necessary so the ruler always reads as
 * a ruler (the tick path is currently suppressed by decision — only the NOW
 * dot draws — and re-enables via SHOW_YEAR_TICKS). The axis is anchored at
 * the RIGHT edge of the band so the left side stays clear for the 3D thread
 * bundle; ticks extend leftward from the axis. The engraved month/day ladder
 * of Rev 14 is gone — year labels are DOM (RollingField) via the axis-band
 * overlay (also suppressed); this canvas draws tick marks and the NOW dot
 * only (all strip math lives in `@/lib/timeline3d/ruler-math` and is shared
 * with that overlay). No strands, no spine, no cylinder hatch
 * (all replaced by ThreadlineScene). Pointer-transparent; loaded via
 * next/dynamic ssr:false.
 */
import { useEffect, useRef } from "react";
import { useTheme } from "@teispace/next-themes";
import {
  computeYearMarkers,
  RULER_AXIS_MARGIN_PX,
  YEAR_TICK_WIDTH,
} from "@/lib/timeline3d/ruler-math";

export interface AmbientSceneProps {
  /** Card-field scroll progress 0..1 (0 = oldest/top, 1 = now/bottom).
   *  Written by the card field every frame; read here without re-renders. */
  progressRef: React.MutableRefObject<number>;
  /** Visible date range of the catalog. `oldest` is the earliest loaded
   *  slice's `date`; `now` is the current calendar date. */
  range: { oldest: string; now: string };
}

const CORE_HEX = "#0066FF";
const NOW_RADIUS = 3;

/** Year ticks are suppressed by decision (both views hide the year scale);
 *  the NOW dot below stays. Kept as a flag so the redo re-enables the tick
 *  path in one place. */
const SHOW_YEAR_TICKS = false;

function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dark: boolean,
  progress: number,
  range: { oldest: string; now: string },
) {
  ctx.clearRect(0, 0, width, height);

  // Axis anchored at the right edge of the band; ticks extend left.
  const axisXPx = Math.round(Math.max(2, width - RULER_AXIS_MARGIN_PX)) + 0.5;
  const yearTickW = Math.min(YEAR_TICK_WIDTH, Math.max(8, axisXPx - 4));

  const ink = dark ? "229,231,235" : "31,41,55";
  const tickAlpha = dark ? 0.7 : 0.65;

  const markers = SHOW_YEAR_TICKS
    ? computeYearMarkers(range, height, progress)
    : null;
  if (markers) {
    ctx.lineWidth = 1;
    for (const m of markers) {
      const yPx = Math.round(m.y) + 0.5;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${ink},${tickAlpha})`;
      ctx.moveTo(axisXPx, yPx);
      ctx.lineTo(axisXPx - yearTickW, yPx);
      ctx.stroke();
    }
  }

  // NOW dot — fixed at the bottom of the band, on the right axis.
  ctx.beginPath();
  ctx.fillStyle = CORE_HEX;
  ctx.arc(axisXPx, height - 10, NOW_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

export default function AmbientScene({
  progressRef,
  range,
}: AmbientSceneProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

  const argsRef = useRef({
    dark,
    range,
  });
  argsRef.current = { dark, range };

  const lastDrawnRef = useRef<{
    width: number;
    height: number;
    dark: boolean;
    progress: number;
    range: { oldest: string; now: string };
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = Math.min(
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
        2,
      );
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width, height, dpr };
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { width, height } = sizeRef.current;
      if (width === 0 || height === 0) return;
      const { dark: d, range: r } = argsRef.current;
      const progress = progressRef.current;
      const last = lastDrawnRef.current;
      if (
        last &&
        last.width === width &&
        last.height === height &&
        last.dark === d &&
        last.progress === progress &&
        last.range === r
      ) {
        return;
      }
      lastDrawnRef.current = {
        width,
        height,
        dark: d,
        progress,
        range: r,
      };
      drawRuler(ctx, width, height, d, progress, r);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // refs are stable; drawing inputs are read from argsRef each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
