"use client";

/**
 * CardField (Rev 12) — the timeline's right field: the cards ARE the scene.
 * One R3F canvas renders the current zoom level's rows as big film-frame
 * cards on the z=0 plane; each stack (L1/L2) is a real 3D deck — the top
 * card is the full original slice card (never a summary), and 1–6 backing
 * sheets of the SAME size/radius/color cascade behind it (`backingSheets`
 * tiers in stacks.ts) so a pile reads as thick without rendering its count.
 *
 * - Virtualized: only rows near the viewport mount (a handful of cards; the
 *   catalog may hold thousands). Scroll state lives in refs — React only
 *   re-renders when the visible range or the level changes.
 * - Scroll: wheel / one-finger drag move through time (bottom = NOW); the
 *   shared `progressRef` reports 0..1 to the ambient threadline. Nearing the
 *   top edge prefetches the older catalog window (`onNeedOlder`), and a
 *   prepend shifts the scroll offset so the world never jumps.
 * - Zoom: ctrl/cmd+wheel or two-finger pinch steps L0 slice ↔ L1 day ↔
 *   L2 week; clicking a stack steps one level finer, anchored on it. The
 *   level is semi-controlled: the shell owns it (for the floating lens
 *   switcher) and every change — gesture, card click, or switcher — runs
 *   through the same anchored transition. Every level change captures a transition snapshot: the new rows fly from their
 *   OLD slot positions (or from the stack they were swallowed by) to their
 *   NEW slots, while cards that disappear into a coarser stack fly into that
 *   pile as leaving cards. Filter changes and initial mount keep the existing
 *   anchor-pile deal fallback.
 * - Card faces are drei Html (real DOM in 3D — perspective comes free from
 *   the camera); backing sheets are real R3F meshes with paper tone + rim so
 *   scroll-driven camera drift produces visible parallax between layers.
 *
 * Rev 12 data-flow change: slice turn content used to be hoisted into this
 * component as `Map<string, ContentSlot>` and batched via `onRangeChange`.
 * Every fetch resolve re-rendered the whole FieldScene → RowGroup tree and
 * made the field flicker while scrolling. Content loading is now per-card
 * inside `SliceCardFace` (via `useSliceTurns`); the outer components only
 * pass the row/entry array and never re-render for data resolves.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useLocale, useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  DEFAULT_LEVEL,
  frameGeometryFor,
  framePitchFor,
  groupForLevel,
  indexForAnchor,
  type FrameGeometry,
  type StackLevel,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import {
  FIELD_FOV,
  camZFor,
  clipPlanesFor,
  worldScaleFor,
} from "@/lib/timeline3d/camera";
import {
  anchorScrollFor,
  visibleRangeFor,
} from "@/lib/timeline3d/field-offsets";
import { layoutFor } from "@/lib/timeline3d/units";
import { boundaryBetween } from "@/lib/timeline3d/boundary";
import {
  armedGate,
  gateBands,
  type GateBand,
  type GateSignal,
} from "@/lib/chat/field-blocks";
import type { CrossingMark } from "@/components/chat/conversation-field";
import { FrameCardTexts, frameCardLabel } from "./frame-card";
import { RowGroup } from "./row-group";
import { BoundaryRow } from "./boundary-row";
import { LeavingCard } from "./leaving-card";
import type { DealOrigin, FieldRig, LeavingItem } from "./field-rig";

export interface CardFieldProps {
  /** Catalog window, already strand-filtered (oldest → newest). */
  entries: TimelineSliceEntry[];
  hasMore: boolean;
  onNeedOlder: () => void;
  /** L0 card click → dock the reading panel. `start` (the row top's ISO
   *  start) rides along so the chat jump never needs a catalog fetch. */
  onOpenSlice: (sliceId: string, start?: string) => void;
  /** ?at= deep link: land at L0 on this slice, flashed. */
  initialAtId?: string;
  /** Identity of the current filter — a change re-plays the deal. */
  genKey?: string;
  reducedMotion: boolean;
  /** Written every frame: scroll progress 0..1 (0 = oldest, 1 = now). */
  progressRef: React.MutableRefObject<number>;
  /** Optional ref the ambient threadline reads for zoom linkage. */
  levelRef?: React.MutableRefObject<StackLevel>;
  /** Controlled zoom level (lifted to the shell for the lens switcher). When
   *  provided, every level change — gesture, card click, or external — still
   *  runs through the same transition path and is echoed via onLevelChange. */
  level?: StackLevel;
  onLevelChange?: (level: StackLevel) => void;
  /** Written every frame: the visible row starts at the current level as
   *  screen-Y fractions (0=top, 1=bottom) plus the strands each row carries —
   *  the band winds its strand lines at these heights. */
  anchorsRef?: React.MutableRefObject<FieldAnchor[]>;
  /** Where the announcing row boundary sits (screen-Y fraction), for the left
   *  band's anchor dot. */
  crossingRef?: React.MutableRefObject<CrossingMark>;
}

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Ctrl+wheel deltaY px per level step; pinch threshold; idle reset. */
const ZOOM_STEP_PX = 120;
const PINCH_STEP_PX = 90;
const ZOOM_ACCUM_IDLE_MS = 350;
/** Entering this zone from below (px from the content top) prefetches older. */
const TOP_ZONE_PX = 320;
/** Deal-in: seconds; stagger per row of distance from the anchor. */
const DEAL_DURATION = 0.55;
const DEAL_STAGGER = 0.05;
/** Mounts within this window after a level/filter change play the deal. */
const GEN_WINDOW_MS = 650;
/** Stagger for leaving cards stacking into a pile, seconds per depth step. */
const LEAVING_STAGGER_S = 0.03;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Find the old row that visually contained `sliceId` (top or buried). */
function findOldSlot(
  sliceId: string,
  rows: StackRow[],
): { index: number; isTop: boolean } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.top.id === sliceId) return { index: i, isTop: true };
    if (row.entries.some((e) => e.id === sliceId))
      return { index: i, isTop: false };
  }
  return null;
}

/** The offset table for a row list at a level. Rows no longer advance by a
 *  fixed amount — every row but the last reserves a boundary region after its
 *  face — so nothing may compute a position as `index * pitch` any more. */
function layoutForRows(
  rows: StackRow[],
  level: StackLevel,
  geo: FrameGeometry,
) {
  return layoutFor(
    rows.length,
    () => geo.cardH,
    (i) => i < rows.length - 1,
    framePitchFor(level, geo),
  );
}

/** Scroll offset that centers `anchorIdx` in the field, clamped to content. */
function centeredScrollForAnchor(
  tops: readonly number[],
  anchorIdx: number,
  cardH: number,
  fieldH: number,
): number {
  const max = Math.max(0, (tops[tops.length - 1] ?? 0) - fieldH);
  return anchorScrollFor(tops, anchorIdx, cardH, fieldH / 2, 0, max);
}

/** Row keys visible (including virtual-scroll margin) at a given scroll. */
function visibleKeysFor(
  tops: readonly number[],
  rows: StackRow[],
  pitch: number,
  cardH: number,
  fieldH: number,
  scrollPx: number,
): Set<string> {
  const set = new Set<string>();
  for (const i of visibleRangeFor(
    tops,
    rows.length,
    scrollPx,
    fieldH,
    cardH * 1.2,
    pitch,
  )) {
    if (rows[i]) set.add(rows[i].key);
  }
  return set;
}

/** Build the list of cards that get swallowed when zooming out.
 *  Only cards in the old visible window participate. */
function buildLeaving(
  fromRows: StackRow[],
  fromTops: readonly number[],
  fromScroll: number,
  fromPitch: number,
  fromCardH: number,
  toRows: StackRow[],
  fieldH: number,
): LeavingItem[] {
  // Only cards in the old VISIBLE window participate, by the shared rule.
  const first = visibleRangeFor(
    fromTops,
    fromRows.length,
    fromScroll,
    fieldH,
    fromCardH * 1.2,
    fromPitch,
  )[0] ?? 0;
  const lastRange = visibleRangeFor(
    fromTops,
    fromRows.length,
    fromScroll,
    fieldH,
    fromCardH * 1.2,
    fromPitch,
  );
  const last = lastRange[lastRange.length - 1] ?? -1;
  const newTops = new Set(toRows.map((r) => r.top.id));
  const toRowById = new Map<string, { key: string; depth: number }>();
  for (const row of toRows) {
    for (let i = 0; i < row.entries.length; i++) {
      toRowById.set(row.entries[i].id, { key: row.key, depth: i });
    }
  }
  const items: LeavingItem[] = [];
  for (let i = first; i <= last; i++) {
    const row = fromRows[i];
    if (!row) continue;
    const fromYpx = (fromTops[i] ?? 0) + fromCardH / 2 - fromScroll;
    for (const entry of row.entries) {
      if (newTops.has(entry.id)) continue;
      const target = toRowById.get(entry.id);
      if (!target) continue;
      items.push({
        id: entry.id,
        slice: entry,
        fromYpx,
        toRowKey: target.key,
        depth: target.depth,
      });
    }
  }
  return items;
}

// ─── The scene: scroll physics + visible-range virtualization ───────────────

interface FieldSceneProps {
  rows: StackRow[];
  geo: FrameGeometry;
  level: StackLevel;
  rig: React.MutableRefObject<FieldRig>;
  hasMore: boolean;
  onNeedOlder: () => void;
  progressRef: React.MutableRefObject<number>;
  reducedMotion: boolean;
  flashId: string | null;
  onActivate: (row: StackRow) => void;
  arias: Map<string, string>;
  texts: FrameCardTexts;
  leaving: LeavingItem[];
  onLeavingDone: (id: string) => void;
  anchorsRef?: React.MutableRefObject<FieldAnchor[]>;
  crossingRef?: React.MutableRefObject<CrossingMark>;
}

function FieldScene({
  rows,
  geo,
  level,
  rig,
  hasMore,
  onNeedOlder,
  progressRef,
  reducedMotion,
  flashId,
  onActivate,
  arias,
  texts,
  leaving,
  onLeavingDone,
  anchorsRef,
  crossingRef,
}: FieldSceneProps) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  const pitch = framePitchFor(level, geo);
  /** The card-to-card advance minus the face — the room the PILE cascades
   *  into. Deliberately NOT the row's full extent: the boundary region below
   *  each row is a new kind of space, and letting the sheets spread into it
   *  would make the pile read bigger than it does today as a side effect of
   *  adding the boundary. */
  const pileGap = pitch - geo.cardH;

  // WHERE EVERY ROW SITS, boundary included (v0.13). The card rungs used
  // `index * pitch`; they now share the running offset table with the
  // conversation rung, which is what lets one field carry both — a card row
  // declares its height (`geo.cardH`, a formula), a conversation row measures
  // its text, and `layoutFor` is the only place that difference is known.
  //
  // Every row but the LAST closes a boundary: nothing follows the newest slice
  // to cross, which is also why the conversation's last block has no gate.
  const layout = useMemo(
    () => layoutFor(rows.length, () => geo.cardH, (i) => i < rows.length - 1, pitch),
    [rows.length, geo.cardH, pitch],
  );
  const tops = layout.tops;

  // The clip planes follow the viewport, because the camera DISTANCE does
  // (`camera.ts`): at `camZ = 1.87·viewH` R3F's default `far = 1000` is nearer
  // than the camera itself on any field taller than ~536 px, which puts the
  // whole scene outside the frustum. A layout effect, so the projection is
  // corrected before the frame the size change would be painted in.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const { near, far } = clipPlanesFor(size.height);
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, size.height]);

  const prevTopRef = useRef<number | null>(null);
  // The boundary mechanism's per-frame scratch: the band list is refilled in
  // place, the arm signals are MUTABLE OBJECTS kept per row (each gate is its
  // own React root, so arming must not travel as a prop), and `dirRef` is the
  // direction the reader is travelling — which decides which side of a
  // boundary speaks. All three are the conversation field's arrangement.
  const bandsRef = useRef<GateBand[]>([]);
  const signalsRef = useRef(new Map<string, GateSignal>());
  const signalFor = useCallback((key: string): GateSignal => {
    let signal = signalsRef.current.get(key);
    if (!signal) {
      signal = { armed: false, dir: "past" };
      signalsRef.current.set(key, signal);
    }
    return signal;
  }, []);
  const dirRef = useRef<"past" | "future">("past");
  const lastScrollRef = useRef(0);
  // The visible range is STATE (drives which RowGroups mount), mirrored in a
  // ref so the frame loop can compare without a stale closure. Reading a ref
  // during render would leave stale rows mounted after a level change when no
  // state update happens to re-render.
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const rangeRef = useRef<[number, number]>([0, -1]);
  const prevRowsRef = useRef<StackRow[]>(rows);
  const prevRangeFirstKeyRef = useRef<string | null>(null);

  // Render-time range realignment on rows change: keep the viewport anchored to
  // the same row keys so React does not remount the visible RowGroups.
  if (prevRowsRef.current !== rows) {
    const [oldFirst, oldLast] = rangeRef.current;
    const oldKey = prevRangeFirstKeyRef.current;
    if (oldKey != null && oldFirst >= 0 && oldLast >= oldFirst) {
      const newFirst = rows.findIndex((r) => r.key === oldKey);
      if (newFirst >= 0) {
        const newLast = Math.min(
          rows.length - 1,
          newFirst + (oldLast - oldFirst),
        );
        const newRange: [number, number] = [newFirst, newLast];
        rangeRef.current = newRange;
        setRange(newRange);
      }
    }
    prevRowsRef.current = rows;
  }
  prevRangeFirstKeyRef.current = rows[rangeRef.current[0]]?.key ?? null;

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const rigNow = rig.current;
    const max = Math.max(0, layout.total - size.height);
    rigNow.target = THREE.MathUtils.clamp(rigNow.target, 0, max);

    if (reducedMotion) {
      rigNow.current = rigNow.target;
    } else {
      rigNow.current +=
        (rigNow.target - rigNow.current) * Math.min(1, 1 - Math.exp(-dt * 9));
      if (Math.abs(rigNow.target - rigNow.current) < 0.05) {
        rigNow.current = rigNow.target;
      }
    }

    // Top-zone EDGE trigger: only a real scroll up into the zone prefetches.
    const prevTop = prevTopRef.current;
    prevTopRef.current = rigNow.target;
    if (
      prevTop != null &&
      prevTop > TOP_ZONE_PX &&
      rigNow.target <= TOP_ZONE_PX &&
      hasMore
    ) {
      onNeedOlder();
    }

    progressRef.current = max > 0 ? rigNow.current / max : 1;

    // Row-start anchors for the threadline's strand field: every visible row
    // at the CURRENT level is one anchor (L0 slice / L1 day / L2 week), as a
    // screen-Y fraction of the shared field height, carrying the row's own
    // strands so the band winds them at exactly this height (v0.11 §2.3).
    if (anchorsRef) {
      const h = size.height;
      const scroll = rigNow.current;
      const list: FieldAnchor[] = [];
      for (let i = 0; i < rows.length; i++) {
        const centerPy = (tops[i] ?? 0) + geo.cardH / 2 - scroll;
        if (centerPy < -geo.cardH || centerPy > h + geo.cardH) continue;
        // `span` is the row's own height: the band sizes each knot to the
        // content it marks, so the twist spans the card and unwinds in the gap
        // after it.
        list.push({
          y: centerPy / h,
          strands: rows[i].strands,
          span: geo.cardH / h,
        });
        if (list.length >= 24) break;
      }
      anchorsRef.current = list;
    }

    // The boundary the reader is crossing, for the band's anchor dot. The card
    // view's boundaries are the GAPS between rows — the same regions the band
    // unwinds in — so the mark is the midpoint of a gap rather than a row's
    // own centre. Same rule as the conversation field's gates: the nearest
    // boundary on screen announces, and none does when the reader is mid-row.
    // ONE ARMED BOUNDARY, the same rule at every rung: each boundary answers
    // for itself (it speaks only when it is actually in view, so a boundary
    // nowhere near the reader cannot claim to be crossing), several in view
    // resolve to the one nearest the middle, and the mark the band draws is
    // that boundary's own band midpoint.
    //
    // This replaces a rule that measured the GAP between rows — a spacing, not
    // a statement, and a different geometry from the conversation's gate
    // midpoint. With a real boundary region both rungs mark the same thing.
    const bands = gateBands(
      bandsRef.current,
      rows.length,
      (i) => i < rows.length - 1,
      tops,
      pitch,
      false, // the card rungs have no window head; the present is at the bottom
    );
    const armed = armedGate(bands, rigNow.current, size.height, 0);
    let armedBand: GateBand | null = null;
    for (const band of bands) {
      const isArmed = band.index === armed;
      if (isArmed) armedBand = band;
      const signal = signalFor(rows[band.index].key);
      if (signal.armed !== isArmed) signal.armed = isArmed;
      if (isArmed && signal.dir !== dirRef.current) signal.dir = dirRef.current;
    }
    if (crossingRef) {
      crossingRef.current.y = armedBand
        ? (armedBand.top + armedBand.height / 2 - rigNow.current) / size.height
        : null;
    }

    // Scroll-driven camera drift: translate the camera slightly, then TURN it
    // back onto the card column (lookAt x=0) so the z=0 faces stay horizontally
    // centered while sheets at different depths shift by different amounts
    // (real parallax). A pure translation (lookAt(cx,cy,0)) would keep the axis
    // parallel to z and drag the whole card plane sideways — don't do that.
    // The offsets are authored against the old fixed camera and scaled by
    // `worldScaleFor`, so the turn stays the same ANGLE (atan(0.42/9) = 2.67°)
    // and the parallax it produces is the same at every viewport height.
    const camZ = camZFor(size.height);
    const worldScale = worldScaleFor(size.height);
    if (!reducedMotion) {
      const p = progressRef.current; // 0..1 (0 = oldest/top, 1 = newest/bottom)
      const cx = (p - 0.5) * 2 * 0.42 * worldScale; // ±0.42 old world units
      const cy = (p - 0.5) * 2 * 0.14 * worldScale; // ±0.14 old world units
      camera.position.set(cx, cy, camZ);
      camera.lookAt(0, cy, 0);
    } else {
      camera.position.set(0, 0, camZ);
      camera.lookAt(0, 0, 0);
    }

    // Which way the reader is travelling, for the boundary that speaks. Read
    // off the eased position rather than the input, so a flick that has not
    // settled yet does not flip the side mid-crossing.
    if (rigNow.current !== lastScrollRef.current) {
      dirRef.current = rigNow.current < lastScrollRef.current ? "past" : "future";
      lastScrollRef.current = rigNow.current;
    }

    // Visible-range virtualization (React state changes only when it does) —
    // the shared rule, so a card row and a conversation block mount by the same
    // arithmetic. The margin is what keeps a row's measurement from being
    // thrown away the moment it leaves the viewport.
    const margin = geo.cardH * 1.2;
    const nextVisible = visibleRangeFor(
      tops,
      rows.length,
      rigNow.current,
      size.height,
      margin,
      pitch,
    );
    const first = nextVisible[0] ?? 0;
    const last = nextVisible[nextVisible.length - 1] ?? -1;
    if (first !== rangeRef.current[0] || last !== rangeRef.current[1]) {
      rangeRef.current = [first, last];
      setRange([first, last]);
    }
  });

  const rowIndexMap = useMemo(
    () => new Map(rows.map((r, i) => [r.key, i])),
    [rows],
  );

  const [first, last] = range;
  const visible = rows.slice(first, last + 1);

  return (
    <>
      {visible.map((row, vi) => {
        const index = first + vi;
        const topPx = tops[index] ?? 0;
        // Every row but the last closes a boundary, and the closing row owns
        // it — the region `layoutFor` reserved after this row's face.
        const boundary =
          index < rows.length - 1
            ? boundaryBetween(row.top, rows[index + 1]?.top)
            : null;
        return (
          <group key={row.key}>
            <RowGroup
              row={row}
              index={index}
              topPx={topPx}
              geo={geo}
              pileGap={pileGap}
              rig={rig}
              reducedMotion={reducedMotion}
              flash={flashId != null && row.entries.some((e) => e.id === flashId)}
              onActivate={onActivate}
              ariaLabel={arias.get(row.key) ?? ""}
              texts={texts}
            />
            {boundary && (
              <BoundaryRow
                topPx={topPx + geo.cardH}
                width={geo.cardW}
                boundary={boundary}
                signal={signalFor(row.key)}
                rig={rig}
              />
            )}
          </group>
        );
      })}
      {leaving.map((item) => (
        <LeavingCard
          key={item.id}
          item={item}
          rowIndexMap={rowIndexMap}
          level={level}
          geo={geo}
          rig={rig}
          reducedMotion={reducedMotion}
          texts={texts}
          onDone={onLeavingDone}
        />
      ))}
    </>
  );
}

// ─── The field: DOM wrapper owns gestures, level, anchor, deal state ──

export function CardField({
  entries,
  hasMore,
  onNeedOlder,
  onOpenSlice,
  initialAtId,
  genKey = "",
  reducedMotion,
  progressRef,
  levelRef,
  level: levelProp,
  onLevelChange,
  anchorsRef,
  crossingRef,
}: CardFieldProps) {
  const t = useTranslations("timeline3d");
  const locale = useLocale();
  const texts = useMemo<FrameCardTexts>(
    () => ({
      turns: (count: number) => t("card.turns", { count }),
      user: t("turns.user"),
      agent: t("turns.agent"),
      duration: (min: number) => t("card.duration", { min }),
      no: (date: string, time: string) => t("card.no", { date, time }),
      tone: t("card.tone"),
      decided: t("card.decided"),
      open: t("card.open"),
      strands: t("card.strands"),
      listSeparator: t("card.listSeparator"),
      continuedFrom: (date: string) => t("card.continuedFrom", { date }),
      fr: (date: string) => t("card.fr", { date }),
    }),
    [t],
  );
  const [innerLevel, setInnerLevel] = useState<StackLevel>(
    initialAtId ? 0 : DEFAULT_LEVEL,
  );
  const level = levelProp ?? innerLevel;
  const applyLevel = useCallback(
    (next: StackLevel) => {
      setInnerLevel(next);
      onLevelChange?.(next);
    },
    [onLevelChange],
  );
  useEffect(() => {
    if (levelRef) levelRef.current = level;
  }, [level, levelRef]);
  const [flashId, setFlashId] = useState<string | null>(initialAtId ?? null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fieldSize, setFieldSize] = useState({ w: 0, h: 0 });
  const [leaving, setLeaving] = useState<LeavingItem[]>([]);

  const rig = useRef<FieldRig>({
    target: 0,
    current: 0,
    anchorIndex: 0,
    genAt: performance.now(),
    hoverKey: null,
    dealOrigins: null,
    dealEligible: null,
  });
  const pendingAnchorRef = useRef<string | null>(initialAtId ?? null);
  const initDoneRef = useRef(false);
  const prevFirstKeyRef = useRef<string | null>(null);

  const rows = useMemo(() => groupForLevel(entries, level), [entries, level]);
  const geo = useMemo(
    () => frameGeometryFor(fieldSize.w || 1280, fieldSize.h || 800),
    [fieldSize],
  );
  // The outer component needs the same offset table the scene does: the scroll
  // transitions (level change, filter change, the initial land, a deep link)
  // all resolve a row's position, and none of them may do it as
  // `index * pitch` any more.
  const tops = useMemo(
    () => layoutForRows(rows, level, geo).tops,
    [rows, level, geo],
  );

  // Render-time prepend compensation: shift the scroll rig synchronously so the
  // next frame's RowGroup positions use the corrected offset, avoiding a
  // one-frame jump before the useEffect could run.
  if (rows.length > 0) {
    const firstKey = rows[0]?.key ?? null;
    const prevFirst = prevFirstKeyRef.current;
    if (prevFirst && prevFirst !== firstKey && !pendingAnchorRef.current) {
      const added = rows.findIndex((r) => r.key === prevFirst);
      if (added > 0) {
        const pitch = framePitchFor(level, geo);
        rig.current.target += added * pitch;
        rig.current.current += added * pitch;
        rig.current.genAt = 0;
        rig.current.dealEligible = null;
      }
    }
    prevFirstKeyRef.current = firstKey;
  }

  const arias = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.key, frameCardLabel(row, locale).aria);
    return map;
  }, [rows, locale]);

  // ── Field size (ResizeObserver) ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setFieldSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() =>
      setFieldSize({ w: el.clientWidth, h: el.clientHeight }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The threadline only converges while the field is mounted; clear the
  // anchors on unmount (view switch) so the weave relaxes back to straight.
  useEffect(() => {
    if (!anchorsRef) return;
    return () => {
      anchorsRef.current = [];
    };
  }, [anchorsRef]);

  // ── Generation bookkeeping: bump the deal clock on level/filter change ──
  const genTrackRef = useRef<{ level: StackLevel; genKey: string } | null>(null);
  if (
    genTrackRef.current === null ||
    genTrackRef.current.level !== level ||
    genTrackRef.current.genKey !== genKey
  ) {
    genTrackRef.current = { level, genKey };
    rig.current.genAt = performance.now();
    rig.current.dealEligible = visibleKeysFor(
      tops,
      rows,
      framePitchFor(level, geo),
      geo.cardH,
      fieldSize.h || 800,
      rig.current.current,
    );
  }

  // Filter changes are not level transitions: clear stale deal origins
  // so rows fall back to the anchor-pile deal.
  const lastGenKeyRef = useRef<string>(genKey);
  useEffect(() => {
    if (lastGenKeyRef.current !== genKey) {
      lastGenKeyRef.current = genKey;
      rig.current.dealOrigins = null;
      setLeaving([]);
    }
  }, [genKey]);

  // ── Start a real level transition (snapshot + leaving cards) ──
  const startTransition = useCallback(
    (
      fromLevel: StackLevel,
      toLevel: StackLevel,
      anchorId: string | null,
    ) => {
      pendingAnchorRef.current = anchorId;
      if (reducedMotion) {
        rig.current.dealOrigins = null;
        rig.current.dealEligible = null;
        setLeaving([]);
        return;
      }
      const fromRows = groupForLevel(entries, fromLevel);
      const toRows = groupForLevel(entries, toLevel);
      const fromPitch = framePitchFor(fromLevel, geo);
      const toPitch = framePitchFor(toLevel, geo);
      const fromTops = layoutForRows(fromRows, fromLevel, geo).tops;
      const toTops = layoutForRows(toRows, toLevel, geo).tops;
      const fromCardH = geo.cardH;
      const toCardH = geo.cardH;
      const scroll = rig.current.current;
      const fieldH = fieldSize.h || 800;

      const worldScale = worldScaleFor(fieldH);
      const dealOrigins = new Map<string, DealOrigin>();

      const anchorIdx = anchorId ? indexForAnchor(toRows, anchorId) : -1;
      if (anchorIdx >= 0) rig.current.anchorIndex = anchorIdx;
      const newCurrent =
        anchorIdx >= 0
          ? centeredScrollForAnchor(toTops, anchorIdx, toCardH, fieldH)
          : scroll;
      // Pre-apply the post-transition scroll so the first rendered frame
      // already uses the same current that RowGroup will animate toward.
      rig.current.current = newCurrent;
      rig.current.target = newCurrent;

      for (let newIdx = 0; newIdx < toRows.length; newIdx++) {
        const row = toRows[newIdx];
        const old = findOldSlot(row.top.id, fromRows);
        if (old == null) continue;
        const newCenterPy = (toTops[newIdx] ?? 0) + toCardH / 2 - newCurrent;
        const oldCenterPy = (fromTops[old.index] ?? 0) + fromCardH / 2 - scroll;
        dealOrigins.set(row.key, {
          // `dy` is a screen-px distance, already a world distance (camera.ts);
          // `dz` is authored against the old camera and scales with it.
          dy: newCenterPy - oldCenterPy,
          dz: -0.45 * worldScale,
        });
      }

      rig.current.dealOrigins = dealOrigins;
      rig.current.genAt = performance.now();
      rig.current.dealEligible = visibleKeysFor(
        toTops,
        toRows,
        toPitch,
        toCardH,
        fieldH,
        newCurrent,
      );

      setLeaving(
        fromLevel < toLevel
          ? buildLeaving(
              fromRows,
              fromTops,
              scroll,
              fromPitch,
              fromCardH,
              toRows,
              fieldH,
            )
          : [],
      );
    },
    [entries, geo, fieldSize.h, reducedMotion],
  );

  // ── Anchor / scroll position after rows change (level, filter, paging) ──
  useEffect(() => {
    if (rows.length === 0) return;
    const pitch = framePitchFor(level, geo);
    const max = Math.max(0, rows.length * pitch - fieldSize.h);

    // Prepend compensation now runs synchronously during render (above).

    const anchorId = pendingAnchorRef.current;
    if (anchorId != null) {
      pendingAnchorRef.current = null;
      const idx = indexForAnchor(rows, anchorId);
      if (idx >= 0) {
        rig.current.anchorIndex = idx;
        const pos = centeredScrollForAnchor(tops, idx, geo.cardH, fieldSize.h);
        rig.current.target = pos;
        rig.current.current = pos;
        rig.current.genAt = performance.now();
        rig.current.dealEligible = visibleKeysFor(
          tops,
          rows,
          pitch,
          geo.cardH,
          fieldSize.h,
          pos,
        );
      }
      return;
    }
    if (!initDoneRef.current) {
      // Bottom-anchored first land: the list's bottom is NOW.
      initDoneRef.current = true;
      rig.current.anchorIndex = rows.length - 1;
      rig.current.target = max;
      rig.current.current = max;
      rig.current.genAt = performance.now();
      rig.current.dealEligible = visibleKeysFor(
        tops,
        rows,
        pitch,
        geo.cardH,
        fieldSize.h,
        max,
      );
    }
  }, [rows, geo, level, fieldSize.h, tops]);

  // ── Fill pass: content shorter than the field can never reach the top ──
  useEffect(() => {
    if (!hasMore || rows.length === 0) return;
    const timer = setTimeout(() => {
      if (rows.length * framePitchFor(level, geo) <= fieldSize.h + 1) onNeedOlder();
    }, 900);
    return () => clearTimeout(timer);
  }, [rows, hasMore, onNeedOlder, geo, level, fieldSize.h]);

  // ── ?at= flash decay ──
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 3600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ── Level stepping ──
  const stepLevel = useCallback(
    (next: StackLevel, anchorId?: string) => {
      if (next === level) return;
      startTransition(level, next, anchorId ?? null);
      applyLevel(next);
    },
    [level, startTransition, applyLevel],
  );

  /** Top id of the row nearest the viewport center — the gesture anchor. */
  const centerAnchorFor = useCallback(
    (fromLevel: StackLevel) => {
      const curPitch = framePitchFor(fromLevel, geo);
      const centerRow = Math.max(
        0,
        Math.round(
          (rig.current.current + fieldSize.h / 2 - geo.cardH / 2) / curPitch,
        ),
      );
      return groupForLevel(entries, fromLevel)[centerRow]?.top.id ?? null;
    },
    [entries, geo, fieldSize.h],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const next = Math.min(2, Math.max(0, level + dir)) as StackLevel;
      if (next === level) return;
      startTransition(level, next, centerAnchorFor(level));
      applyLevel(next);
    },
    [level, centerAnchorFor, startTransition, applyLevel],
  );

  // ── External level changes (the lens switcher) ──
  // Render-time, not an effect: the transition snapshot (deal origins +
  // leaving cards) must exist BEFORE the new level's rows render, or the
  // first frame already shows the final layout with no fly-in. An internal
  // change echoes back through the prop with innerLevel already updated, so
  // the `levelProp !== innerLevel` guard runs the transition exactly once.
  const prevLevelPropRef = useRef(levelProp);
  if (levelProp != null && prevLevelPropRef.current !== levelProp) {
    prevLevelPropRef.current = levelProp;
    if (levelProp !== innerLevel) {
      startTransition(innerLevel, levelProp, centerAnchorFor(innerLevel));
      setInnerLevel(levelProp);
    }
  }

  const onActivate = useCallback(
    (row: StackRow) => {
      if (row.level === 0) onOpenSlice(row.top.id, row.top.start);
      else stepLevel((row.level - 1) as StackLevel, row.top.id);
    },
    [onOpenSlice, stepLevel],
  );

  const onLeavingDone = useCallback((id: string) => {
    setLeaving((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // ── Gestures: wheel (plain = scroll, ctrl/cmd = zoom), touch drag, pinch ──
  const zoomAccumRef = useRef(0);
  const zoomIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAccumRef.current += e.deltaY;
        if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
        zoomIdleRef.current = setTimeout(() => {
          zoomAccumRef.current = 0;
        }, ZOOM_ACCUM_IDLE_MS);
        if (Math.abs(zoomAccumRef.current) >= ZOOM_STEP_PX) {
          const dir = zoomAccumRef.current > 0 ? 1 : -1;
          zoomAccumRef.current = 0;
          zoomBy(dir);
        }
      } else {
        rig.current.target += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (zoomIdleRef.current) clearTimeout(zoomIdleRef.current);
    };
  }, [zoomBy]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastDist: number | null = null;
    let pinchAccum = 0;
    const dist = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        lastDist = dist();
        pinchAccum = 0;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        // One-finger vertical drag scrolls time.
        rig.current.target -= e.clientY - prev.y;
        return;
      }
      if (pointers.size !== 2) return;
      const d = dist();
      if (d == null || lastDist == null) return;
      pinchAccum += d - lastDist;
      lastDist = d;
      if (Math.abs(pinchAccum) >= PINCH_STEP_PX) {
        const dir = pinchAccum > 0 ? -1 : 1; // spread = zoom in
        pinchAccum = 0;
        zoomBy(dir);
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastDist = null;
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [zoomBy]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("fallback.empty")}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      data-card-field
      className="relative h-full w-full"
      style={{ touchAction: "none" }}
    >
      <Canvas
        dpr={[1, 1.75]}
        // Dead-on camera: cards on the z=0 plane always face the viewer
        // square-on (no keystone tilt). A pile's depth comes from its own
        // sheet offsets/tilts/shadows, not from the camera angle.
        //
        // The distance is DERIVED from the field height (`camera.ts`) and
        // re-set every frame by the drift; this initial value only covers the
        // frame before the loop starts. `fov` is fixed — the distance moving is
        // what makes the field 1 world unit per CSS px.
        camera={{
          position: [0, 0, camZFor(fieldSize.h || 800)],
          fov: FIELD_FOV,
        }}
        gl={{ antialias: true, alpha: true }}
      >
        <FieldScene
          rows={rows}
          geo={geo}
          level={level}
          rig={rig}
          hasMore={hasMore}
          onNeedOlder={onNeedOlder}
          progressRef={progressRef}
          reducedMotion={reducedMotion}
          flashId={flashId}
          onActivate={onActivate}
          arias={arias}
          texts={texts}
          leaving={leaving}
          onLeavingDone={onLeavingDone}
          anchorsRef={anchorsRef}
          crossingRef={crossingRef}
        />
      </Canvas>
    </div>
  );
}
