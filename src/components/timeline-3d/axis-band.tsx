"use client";

/**
 * AxisBand — the persistent left time axis shared by the chat and timeline
 * views (v0.11 shell refactor). The strand-field braid that used to mount
 * its own canvas here (`threadline-scene.tsx`) now renders in the app's ONE
 * shared canvas (`world-canvas.tsx`, §14 merge) — this component keeps the
 * band's DOM half: the AmbientScene 2D ruler (NOW dot; year ticks currently
 * suppressed), the RulerYearLabels DOM overlay (not rendered — year scale
 * hidden by decision, kept for the redo), the ScrubLens, edge fades and the
 * jump controls.
 *
 * IT READS. IT NO LONGER CARRIES CONTROLS. The strand filter chip and the
 * strand-selection caption used to live here, and a 24-32px column whose whole
 * job is to say where in time the reader is cannot also hold a popover that
 * opens a 256px list — it hung its own label over the content. Both moved to
 * the board bar (`shell/board-bar.tsx`). What is left on the strip is the
 * scrubber, which IS a rail affordance.
 *
 * Its width comes from
 * the layout tier — 24px on phone/tablet, 32px on laptop/wide (`tiers.ts`
 * `railW`) — so the same braid is what the reader sees whether they are
 * reading the chat or the timeline; nothing about the band is a view-switch
 * affordance any more. The threadline reads its cylinder radius against that
 * live width every frame (see threadline-scene), so the geometry follows the
 * real strip rather than a constant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { useTier } from "@/hooks/use-tier";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import type { RulerRange } from "@/lib/timeline3d/ruler-math";
import {
  computeYearMarkers,
  resolveLabelledMarkers,
  RULER_LABEL_MIN_WIDTH_PX,
  RULER_LABEL_RIGHT_PX,
} from "@/lib/timeline3d/ruler-math";
import { requestSeek, type FieldFeed } from "@/lib/timeline3d/field-feed";
import { RollingField } from "@/components/chat/rolling-number";
import { ISLAND } from "@/components/layout/island";

/** Year scale (DOM labels + canvas ticks) is suppressed by decision — both
 *  views hide it for now; the NOW dot and the threadline stay. Components
 *  and code paths are kept mounted-but-inert (never rendered / never drawn)
 *  so the redo can flip this single flag. */
const SHOW_YEAR_RULER = false;

const AmbientScene = dynamic(() => import("./ambient-scene"), {
  ssr: false,
  loading: () => null,
});

/**
 * RulerYearLabels — the DOM half of the year ruler: one RollingField year
 * label per year-boundary tick (the same rolling-digits component the chat
 * side uses for time, so both read identically). Positions come from the
 * shared ruler-math strip; a rAF loop reads the feed's progress and positions the
 * label nodes IMPERATIVELY (style.top, no setState in the hot path), so the
 * labels paint in the same frame as this rAF — the tick canvas (AmbientScene)
 * reads the same progressRef in its own rAF and therefore can never be one
 * frame ahead mid-scroll. React state only mounts/unmounts label nodes when
 * the labelled year SET changes. Labels hide when the band is too narrow
 * (`RULER_LABEL_MIN_WIDTH_PX`) or when two would sit closer than MIN_LABEL_GAP_PX
 * apart (the older one loses). Theme-aware via the text-foreground token.
 */
function RulerYearLabels({
  feed,
  range,
}: {
  feed: FieldFeed;
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
      const all = computeYearMarkers(range, height, feed.progress);
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
  }, [range, feed]);

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

/**
 * CrossingDot — the mark on the core line where the boundary the reader is
 * crossing sits.
 *
 * The gate and the band were, until this, two answers to the same question
 * with nothing joining them: the right pane said "you are arriving at 10:24"
 * and the left band untwisted at some height, and nothing tied the two
 * together. One dot is enough. It is placed by a rAF reading the shared
 * `crossingRef` and written imperatively (style.transform, no setState), so it
 * paints in the same frame as the band's own frame loop rather than one behind
 * it — the same arrangement the year labels use.
 *
 * Sits on the core line, which is at x=0 in the threadline's world and
 * therefore the horizontal centre of the strip, and fades rather than pops:
 * most of the time there is no boundary on screen, and an anchor that
 * appeared instantly would read as a glitch.
 */
function CrossingDot({ feed }: { feed: FieldFeed }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let shown = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const parent = el.parentElement;
      if (!parent) return;
      const y = feed.crossing.y;
      const on = y !== null;
      if (on) {
        // The fraction is of the SHARED viewport height — the same frame the
        // anchors arrive in — so it maps straight onto the strip.
        el.style.transform = `translate(-50%, -50%) translateY(${y * parent.clientHeight}px)`;
      }
      if (on !== shown) {
        shown = on;
        el.style.opacity = on ? "1" : "0";
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [feed]);

  return (
    <div
      ref={ref}
      data-crossing-dot
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-0 opacity-0 transition-opacity duration-300 ease-out"
    >
      <span className="block size-1.5 rounded-full bg-primary ring-2 ring-background" />
    </div>
  );
}

/**
 * ScrubLens — the strip as a CONTROL rather than a readout.
 *
 * WHY HERE AND NOT A SCROLLBAR. The field has never had one: its position is a
 * number it owns and every input (wheel, one-finger drag, pinch, the lens
 * buttons) moves it by a delta. So a reader who wants a specific day has no way
 * to say so — they scrub blind until it goes past. The band is already the map
 * of that space: it knows `feed.progress`, it draws the NOW dot and the
 * crossing mark, and it is the only thing on screen that spans the whole
 * memory. A separate scrollbar would be a second coordinate system beside a
 * first one; this makes the one already drawn grabbable.
 *
 * PRESS AND DRAG, OR TAP. Both are the same gesture here — `pointerdown` seeks
 * immediately, so a tap lands where it was aimed without a drag.
 *
 * THE THUMB AND THE READOUT ARE WRITTEN IMPERATIVELY, from one rAF, for the
 * same reason `CrossingDot` is: a pointermove fires faster than a frame and a
 * React state update per move would re-render the band, the strand filter and
 * two canvases' worth of props to move a 16px pill. The loop runs only while
 * the pointer is down.
 *
 * THE READOUT NAMES THE LANDING, and it is read off `feed.anchors` AFTER the
 * field has acted on the seek — never interpolated from `progress`. Progress
 * is a fraction of PIXELS SCROLLED, and a conversation unit is thousands of
 * pixels while a card is hundreds, so progress is nowhere near linear in time.
 * A date interpolated from it would be confidently wrong; the anchor carries
 * the date the catalog actually holds.
 */
function ScrubLens({
  feed,
  bandRef,
  locale,
}: {
  feed: FieldFeed;
  bandRef: React.RefObject<HTMLDivElement | null>;
  locale: string;
}) {
  const t = useTranslations("timeline3d");
  const draggingRef = useRef(false);
  const thumbYRef = useRef(0);
  const thumbRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const lastTextRef = useRef<string | null>(null);

  const fmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }),
    [locale],
  );

  const seek = useCallback(
    (clientY: number, dragging: boolean) => {
      const el = bandRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.height <= 0) return;
      thumbYRef.current = clientY - r.top;
      requestSeek(feed, (clientY - r.top) / r.height, dragging);
    },
    [bandRef, feed],
  );

  useEffect(() => {
    let raf = 0;
    let shown = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const thumb = thumbRef.current;
      if (!thumb) return;
      const on = draggingRef.current;
      if (on !== shown) {
        shown = on;
        thumb.style.opacity = on ? "1" : "0";
        if (!on && readoutRef.current) readoutRef.current.style.opacity = "0";
        if (!on) lastTextRef.current = null;
      }
      if (!on) return;

      thumb.style.transform = `translate(-50%, -50%) translateY(${thumbYRef.current}px)`;

      // Nearest anchor to the thumb, in the band's own pixel space.
      const h = bandRef.current?.clientHeight ?? 0;
      let best: FieldAnchor | null = null;
      let bestD = Infinity;
      for (const a of feed.anchors) {
        const d = Math.abs(a.y * h - thumbYRef.current);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      const readout = readoutRef.current;
      if (!readout) return;
      const text = best?.date
        ? `${fmt.format(new Date(`${best.date}T12:00:00`))}${
            best.focus ? ` · ${best.focus}` : ""
          }`
        : "";
      if (text !== lastTextRef.current) {
        lastTextRef.current = text;
        readout.textContent = text;
      }
      readout.style.opacity = text ? "1" : "0";
      readout.style.transform = `translateY(${thumbYRef.current}px) translateY(-50%)`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [feed, bandRef, fmt]);

  const end = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // One last request with `dragging: false`, so the field knows the finger
      // is up and can resume its own easing for anything still in flight.
      seek(e.clientY, false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [seek],
  );

  /**
   * THE SAME THREE THINGS THE FIELD'S WRAPPER DOES, because this is the same
   * control: the rail and the field are two views of one scroll position, and
   * the field has taken Home/End/PageUp/PageDown/arrows since the ladder
   * landed. The rail took none — it declared `role="slider"` and then could not
   * be focused, announced no `aria-valuenow`, and answered no key. A slider a
   * keyboard cannot reach is worse than a plain div: it promises an interaction
   * that is not there.
   *
   * The steps are the field's own fractions, so the two agree about what "a
   * page" is rather than each inventing one.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === "PageUp" || e.key === "PageDown" ? 0.1 : 0.02;
      const cur = feed.progress;
      let next: number | null = null;
      switch (e.key) {
        case "ArrowUp":
        case "PageUp":
          next = cur - step;
          break;
        case "ArrowDown":
        case "PageDown":
          next = cur + step;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      requestSeek(feed, next);
    },
    [feed],
  );

  /** The slider's value, written from the frame loop — `feed.progress` is a
   *  mutable object read sixty times a second, so React never re-renders on it
   *  and an `aria-valuenow` prop would be frozen at its first value. */
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = surfaceRef.current;
      if (!el) return;
      const pct = Math.round(feed.progress * 100);
      if (pct !== last) {
        last = pct;
        el.setAttribute("aria-valuenow", String(pct));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [feed]);

  return (
    <>
      {/* The pointer surface. Above the two canvases (which set
          `pointer-events: none` inline) and below the strand-filter chip, which
          is later in the DOM and therefore wins where they overlap. */}
      <div
        ref={surfaceRef}
        data-scrub-surface
        role="slider"
        tabIndex={0}
        aria-label={t("scrubLabel")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        onKeyDown={onKeyDown}
        // `cursor-pointer`, NOT a resize cursor. The rail is a scrubber, but
        // `ns-resize` says "drag to resize a panel" — it promises a kind of
        // direct manipulation this is not, and reads as a mistake on a surface
        // whose height does not change. The hand is the honest affordance: this
        // is a thing you press.
        className="absolute inset-0 z-0 cursor-pointer touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(e.clientY, true);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          seek(e.clientY, true);
        }}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        ref={thumbRef}
        data-scrub-thumb
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 opacity-0 transition-opacity duration-150"
      >
        <span className="block h-0.5 w-5 -translate-x-1/2 rounded-full bg-primary shadow-sm" />
      </div>
      <div
        ref={readoutRef}
        data-scrub-readout
        aria-hidden
        className="pointer-events-none absolute left-full top-0 ml-2 max-w-56 truncate rounded-md bg-background/90 px-2 py-1 font-mono text-[10px] whitespace-nowrap text-foreground opacity-0 ring-1 ring-border/60 backdrop-blur-md transition-opacity duration-150"
      />

    </>
  );
}

/**
 * JumpControls — the two ENDS of the memory, one press away.
 *
 * Dragging the rail is how you AIM; these are how you LEAVE. The far ends are
 * the two places a reader most often wants and the two a drag is worst at
 * reaching, because the target shrinks to a few pixels as the content grows.
 *
 * THE BOTTOM END IS 回到现在, AN EXPLICIT JUMP (v0.13 §6) — not a scroll.
 * "Now" is the live stream, and the newest slice is not in the card stack's
 * reachable set, so at the card rungs the shell hands `onNow` and the button
 * leaves the stack for the conversation rung (cursor cleared) rather than
 * seeking. At the conversation rung there is no `onNow` and the button keeps
 * its seek-to-bottom — the chat field's live edge IS now.
 *
 * THEY FLOAT ON THE RIGHT, NOT ON THE RAIL. They used to sit on the strip
 * itself, and a 32px column holding a thumb, a readout, a crossing dot and two
 * buttons is not a rail any more — the controls were competing with the thing
 * they controlled. The rail is where time IS; the right edge is where you act
 * on it, and the zoom lens already lives there, so the two navigation controls
 * now read as one cluster instead of being scattered across the screen.
 *
 * AND THEY WEAR THE APP'S CHROME, not a squarer silhouette of their own: the
 * same frosted island every other floating control uses, so the right edge
 * reads as one family rather than a pill, a pill, and two tiles. They were
 * `rounded-md` with a ring and NO shadow, which on a light page left two
 * hairline squares that read as bare chevrons drifting over the content —
 * which is precisely how the reader described them.
 */
export function JumpControls({
  feed,
  onNow,
}: {
  feed: FieldFeed;
  /** 回到现在 as an explicit JUMP (v0.13 §6), supplied at the card rungs:
   *  the bottom control leaves the stack for the live surface instead of
   *  seeking, because "now" is the stream — the newest slice is not in the
   *  card stack's reachable set. Absent (the conversation rung, where the
   *  chat field's live edge IS now), the button keeps its seek-to-bottom. */
  onNow?: () => void;
}) {
  const t = useTranslations("timeline3d");
  const button = `${ISLAND} pointer-events-auto flex size-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`;
  return (
    <div className="pointer-events-none absolute right-3 bottom-36 z-40 flex flex-col gap-1.5 sm:right-5 sm:bottom-32">
      <button
        type="button"
        data-jump="top"
        aria-label={t("jumpTop")}
        title={t("jumpTop")}
        onClick={() => requestSeek(feed, 0)}
        className={button}
      >
        <ArrowUpToLine className="size-3.5" />
      </button>
      <button
        type="button"
        data-jump="bottom"
        aria-label={t("jumpBottom")}
        title={t("jumpBottom")}
        onClick={onNow ?? (() => requestSeek(feed, 1))}
        className={button}
      >
        <ArrowDownToLine className="size-3.5" />
      </button>
    </div>
  );
}

export interface AxisBandProps {
  /** Calendar range: oldest loaded slice → today. */
  range: { oldest: string; now: string };
  /** What the right pane publishes, every frame — see `field-feed.ts`. ONE
   *  object with ONE writer, which is why the band no longer takes a progress
   *  ref, a level ref, an anchors ref and a crossing ref separately: four
   *  props with four private ownership rules is how the band came to read
   *  whichever field rendered last. */
  feed: FieldFeed;
}

export function AxisBand({ range, feed }: AxisBandProps) {
  const locale = useLocale();

  const bandRef = useRef<HTMLDivElement>(null);
  const { spec } = useTier();

  return (
    <div
      ref={bandRef}
      // The rail's margin and width come from the layout tier, not from
      // Tailwind: `phone` narrows the strip, and a tier value has to reach the
      // canvas geometry too (see `tiers.ts`). Inline style rather than an
      // arbitrary `w-[24px]` because the number is dynamic, not authored.
      //
      // The MARGIN is the gutter between the window edge and the cable. Without
      // it the braid's outer strands land on x=0 and the band reads as bleeding
      // off the side of the page rather than sitting on it. It moves the WHOLE
      // strip (canvas included), so the cable keeps its size — insetting the
      // canvas instead would shrink the radius and pack the strands tighter,
      // which is the opposite of what the moiré needs.
      className="relative shrink-0"
      style={{ marginLeft: spec.railMargin, width: spec.railW }}
    >
      {/* The braid itself renders in the shared canvas (world-canvas.tsx),
          scissored to this strip's exact rect — what remains here is the
          band's DOM half. */}
      <AmbientScene feed={feed} range={range} />
      {SHOW_YEAR_RULER && <RulerYearLabels feed={feed} range={range} />}
      {/* Fade-out at the ruler band's edges (bottom weaker so the NOW
          dot stays visible). */}
      <CrossingDot feed={feed} />
      <ScrubLens feed={feed} bandRef={bandRef} locale={locale} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-background to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background/60 to-transparent" />
      {/* The strand filter trigger and the selection caption used to sit here.
          Both moved to the board bar: a 256 px popover and a truncating label
          do not belong in a 24-32 px column whose whole job is to say where in
          time the reader is. The strip still READS the selection — every
          picked strand lights in its own colour in the braid, which the
          shared canvas draws into this strip. */}
    </div>
  );
}
