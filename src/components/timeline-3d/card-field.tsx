"use client";

/**
 * CardField (Rev 12) — the timeline's right field: the cards ARE the scene.
 * The scene renders in the app's ONE shared canvas (`world-canvas.tsx`,
 * §14 merge — this field no longer mounts its own `<Canvas>`); what lives
 * HERE is everything that is not GL: the current zoom level's rows as big
 * film-frame cards on the z=0 plane; each stack (L1/L2) is a real 3D deck — the top
 * card is the full original slice card (never a summary), and 1–6 backing
 * sheets of the SAME size/radius/color cascade behind it (`backingSheets`
 * tiers in stacks.ts) so a pile reads as thick without rendering its count.
 *
 * - Virtualized: only rows near the viewport mount (a handful of cards; the
 *   catalog may hold thousands). Scroll state lives in refs — React only
 *   re-renders when the visible range or the level changes.
 * - Scroll: wheel / one-finger drag move through time (bottom = NOW); the
 *   shared `feed` reports 0..1 to the ambient threadline. A prepend shifts the
 *   scroll offset so the world never jumps.
 *
 *   OLDER PAGES LOAD ONLY WHEN ASKED FOR. This field used to fetch the next
 *   window by itself, on two triggers: crossing into a 320px zone below the
 *   top, and a 900ms fill pass when the loaded content was shorter than the
 *   viewport. The first made the window's head unreachable — every approach
 *   pulled another page in, so the thing the reader was walking toward moved
 *   away from them, and the "load earlier" control it exists to offer could
 *   never be pressed. The second filled the screen before anyone had decided
 *   they wanted more, which is a repository read in production. Both are gone:
 *   the head is now the ONLY pager, it is reachable, and every page that
 *   arrives is one the reader asked for. A slice read is a repository call.
 * - The window's HEAD (`OriginRow`): the region above the oldest loaded row,
 *   stating what time it is at that edge and offering the older page. It is
 *   the conversation field's `FieldOrigin` in the same visual language, and it
 *   scrolls one region past the oldest row (`originMinOffset`) — so the two
 *   fields have one scroll range shape, not two.
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
import { useFrame, useThree } from "@react-three/fiber";
import { useLocale, useTranslations } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  DEFAULT_LEVEL,
  frameGeometryFor,
  framePitchFor,
  frameVariantFor,
  groupForLevel,
  indexForAnchor,
  type FrameGeometry,
  type StackLevel,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import {
  camZFor,
  clipPlanesFor,
  worldScaleFor,
} from "@/lib/timeline3d/camera";
import {
  anchorScrollFor,
  unitAtPx,
  visibleRangeFor,
} from "@/lib/timeline3d/field-offsets";
import { offsetFor } from "@/lib/timeline3d/field-feed";
import {
  layoutFor,
  layoutForRows,
  presentationForRung,
  RUNG_ORDER,
  rungForStackLevel,
  rungIndex,
  stackLevelForRung,
  unitMetricsFor,
  type FieldRung,
  type UnitMetrics,
} from "@/lib/timeline3d/units";
import { boundaryBetween } from "@/lib/timeline3d/boundary";
import {
  armedGate,
  gateBands,
  maxOffsetFor,
  minOffsetFor,
  ORIGIN_REGION,
  type GateBand,
  type GateSignal,
} from "@/lib/chat/field-blocks";
import {
  clearFeed,
  progressFor,
  type FieldFeed,
} from "@/lib/timeline3d/field-feed";
import { FrameCardTexts, frameCardLabel } from "./frame-card";
import { RowGroup } from "./row-group";
import { useWorldScene } from "./world-slot";
import type { SliceNarration } from "./slice-narrate-button";
import { BoundaryRow } from "./boundary-row";
import { OriginRow } from "./origin-row";
import { ConversationUnit } from "./conversation-unit";
import { LeavingCard } from "./leaving-card";
import type { DealOrigin, FieldRig, LeavingItem } from "./field-rig";

export interface CardFieldProps {
  /** Catalog window, already strand-filtered (oldest → newest). */
  entries: TimelineSliceEntry[];
  /** The filter removed EVERYTHING the window had. Distinct from "this memory
   *  has no slices": the window is loaded, it simply carries none of the picks
   *  — which may well live in a page nobody has asked for yet. The two need
   *  different words and, in the second case, a way out. */
  filteredOut: boolean;
  hasMore: boolean;
  /** Prefetch the next older window. Answers with the read's own promise when
   *  it has one, which is what lets the head's button show that a page is in
   *  flight — a caller that pages synchronously simply never sees the spinner. */
  onNeedOlder: () => void | Promise<void>;
  /** L0 card click → dock the reading panel. `start` (the row top's ISO
   *  start) rides along so the chat jump never needs a catalog fetch. */
  onOpenSlice: (sliceId: string, start?: string) => void;
  /** 「讲讲这片」 — ask the mouth to narrate a slice. Absent (bridge brain,
   *  or the probe still out) → the card renders no narrate corner action. */
  onNarrate?: SliceNarration["onSelect"];
  /** ?at= deep link: land at L0 on this slice, flashed. */
  initialAtId?: string;
  /** Identity of the current filter — a change re-plays the deal. */
  genKey?: string;
  reducedMotion: boolean;
  /** What the left band reads — see `field-feed.ts`. The chat field publishes
   *  through the SAME object in the chat view. */
  feed: FieldFeed;
  /** Whether this field owns the band right now. False means it writes
   *  NOTHING: both fields are mounted at once while the timeline is open, and
   *  two writers on one feed is what the feed exists to prevent. */
  publishing: boolean;
  /** Controlled rung (lifted to the shell for the lens switcher). When
   *  provided, every rung change — gesture, unit click, or external — still
   *  runs through the same transition path and is echoed via onRungChange. */
  rung?: FieldRung;
  onRungChange?: (rung: FieldRung) => void;
  /** The pane's two floating insets, px, owned by the shell: the chrome at the
   *  top edge and the composer at the foot. They come off the field's RANGE
   *  (`minOffsetFor`/`maxOffsetFor`), never off its box — the field fills the
   *  pane and its cards pass UNDER the controls, coming to rest clear of them.
   *  See `timeline-scene.tsx` for why the box is the wrong lever. */
  insetTop?: number;
  insetBottom?: number;
  /** Horizontal camera shift, world units (= CSS px at the z=0 plane). The
   *  shared canvas spans the band AND the pane (§14 merge), so the camera
   *  parks this far left of centre to keep the card column centred in the
   *  PANE — the shell computes it from the band's rect. Parallel shift, no
   *  turn: the dead-on framing rule below is untouched. */
  camXOffset?: number;
  /** The rung-switch slide, restored (§: 556ae16's regression): world px the
   *  camera additionally offsets by for the 300 ms of a conversation↔cards
   *  switch, driven by the shell with the same framer animation that slides
   *  the DOM layer — so the GL content and the Html card faces travel as
   *  one plane, exactly like the pre-merge per-pane canvas did under its
   *  CSS transform. */
  slideRef?: React.MutableRefObject<number>;
  /** True while the timeline layer is EXITING to the conversation rung (the
   *  shell's AnimatePresence playing the 0.3 s exit): the field freezes on
   *  `frozenRung` — the rung the reader was actually looking at — instead
   *  of re-rendering the conversation rung's units for one frame and
   *  unmounting. The world content that slides out is the content that was
   *  on screen. */
  exiting?: boolean;
  /** The rung the field freezes on while `exiting`. */
  frozenRung?: FieldRung;
}

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Ctrl+wheel deltaY px per level step; pinch threshold; idle reset. */
const ZOOM_STEP_PX = 120;
const PINCH_STEP_PX = 90;
const ZOOM_ACCUM_IDLE_MS = 350;

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

/** Scroll offset that puts `anchorIdx`'s centre at the middle of the field,
 *  clamped to content. The anchor's own height comes off the table — a
 *  conversation unit's is measured, and passing a card's would aim the landing
 *  half a conversation away from the slice the reader asked for. The floor is
 *  the field's own `minOffset` (the head is a place to land like any other). */
function centeredScrollForAnchor(
  layout: ReturnType<typeof layoutFor>,
  anchorIdx: number,
  fieldH: number,
  minOffset: number,
  insetBottom: number,
): number {
  const { tops, faceHeights } = layout;
  // The same upper bound every other clamp in this file uses, insets included
  // — a landing aimed at a ceiling the frame loop does not share is a landing
  // that drifts the moment the reader touches anything. See `maxOffsetFor`.
  const max = maxOffsetFor(
    tops[tops.length - 1] ?? 0,
    fieldH,
    minOffset,
    insetBottom,
  );
  return anchorScrollFor(
    tops,
    anchorIdx,
    faceHeights[anchorIdx] ?? 0,
    fieldH / 2,
    minOffset,
    max,
  );
}

/** Row keys visible (including virtual-scroll margin) at a given scroll. */
function visibleKeysFor(
  tops: readonly number[],
  rows: StackRow[],
  metrics: UnitMetrics,
  fieldH: number,
  scrollPx: number,
): Set<string> {
  const set = new Set<string>();
  for (const i of visibleRangeFor(
    tops,
    rows.length,
    scrollPx,
    fieldH,
    metrics.margin,
    metrics.fallbackExtent,
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
  rung: FieldRung;
  /** The offset table, computed ONCE by the field and handed down. It is the
   *  same table the transitions read, and a second copy
   *  computed here from the same inputs would be one more thing that has to
   *  stay in agreement — with measured heights in the inputs, no longer a
   *  guarantee that holds for free. */
  layout: ReturnType<typeof layoutFor>;
  metrics: UnitMetrics;
  /** A conversation unit's measured height, reported up by the unit itself. */
  onUnitHeight: (key: string, px: number) => void;
  rig: React.MutableRefObject<FieldRig>;
  hasMore: boolean;
  /** Ask for the older page. The head's control is the ONLY caller — nothing
   *  in this file pages on its own. See `CardField`'s own `requestOlder`. */
  requestOlder: () => void;
  /** True while that page is in flight, for the head's control. */
  loadingOlder: boolean;
  reducedMotion: boolean;
  flashId: string | null;
  onActivate: (row: StackRow) => void;
  arias: Map<string, string>;
  texts: FrameCardTexts;
  leaving: LeavingItem[];
  onLeavingDone: (id: string) => void;
  /** The shared band feed — see `field-feed.ts`. */
  feed: FieldFeed;
  /** Whether this field owns the band. See `CardFieldProps.publishing`. */
  publishing: boolean;
  /** The 「讲讲这片」 corner action for card faces; undefined → no button
   *  (bridge brain). Threaded as data because next-intl context does not
   *  cross the Canvas root into the drei Html portals. */
  narration?: SliceNarration;
  /** The pane's floating insets — see `CardFieldProps`. The frame loop is the
   *  clamp every other one has to agree with, so it reads them here. */
  insetTop: number;
  insetBottom: number;
  /** Horizontal camera shift — see `CardFieldProps.camXOffset`. */
  camXOffset: number;
  /** The rung-switch slide's transient camera offset — see
   *  `CardFieldProps.slideRef`. Composed into the camera's x every frame. */
  slideRef?: React.MutableRefObject<number>;
}

function FieldScene({
  rows,
  geo,
  rung,
  layout,
  metrics,
  onUnitHeight,
  rig,
  hasMore,
  requestOlder,
  loadingOlder,
  reducedMotion,
  flashId,
  onActivate,
  arias,
  texts,
  leaving,
  onLeavingDone,
  feed,
  publishing,
  narration,
  insetTop,
  insetBottom,
  camXOffset,
  slideRef,
}: FieldSceneProps) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  const pitch = metrics.fallbackExtent;
  const turns = presentationForRung(rung) === "turns";
  /** The card-to-card advance minus the face — the room the PILE cascades
   *  into. Deliberately NOT the row's full extent: the boundary region below
   *  each row is a new kind of space, and letting the sheets spread into it
   *  would make the pile read bigger than it does today as a side effect of
   *  adding the boundary. */
  const pileGap = pitch - geo.cardH;

  // WHERE EVERY UNIT SITS, boundary included (v0.13). The card rungs used
  // `index * pitch`; they now share the running offset table with the
  // conversation rung, which is what lets one field carry both — a card row
  // declares its height (`geo.cardH`, a formula), a conversation unit measures
  // its text, and `layoutFor` is the only place that difference is known.
  // `layout` itself is the field's, computed once and passed down (see props).
  const tops = layout.tops;

  // THE HEAD OF THE WINDOW. A LEADING region above unit 0, exactly as the
  // conversation field has always drawn it: the offset table stays anchored on
  // the oldest unit's own top edge, and the head is the strip of
  // `FIELD_ORIGIN_PX` that ends there — which is why `minOffset` (how far above
  // that edge the reader may travel) is one function rather than a ternary
  // re-derived at each clamp.
  const hasOrigin = rows.length > 0;
  // The chrome's room comes off the RANGE, not off the field's box — see
  // `minOffsetFor`. The field still fills the pane.
  const minOffset = minOffsetFor(hasOrigin, insetTop);
  /** The oldest time the window holds — the row's oldest ENTRY, because a stack
   *  row's face is its newest slice and the head stands above all of them. */
  const oldestIso = rows[0]?.entries[0]?.start ?? rows[0]?.top.start ?? "";
  // The head's own arm signal: it is the one boundary in this field that
  // belongs to no row, so it cannot be looked up in the per-row map.
  const originSignal = useRef<GateSignal>({ armed: false, dir: "past" });

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

  /** The last seek this field acted on — see `SeekRequest.gen`. */
  const seekGenRef = useRef(-1);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const rigNow = rig.current;
    const max = maxOffsetFor(layout.total, size.height, minOffset, insetBottom);
    rigNow.target = THREE.MathUtils.clamp(rigNow.target, minOffset, max);

    // A SEEK from the band. Consumed by `gen`, so a request is acted on once
    // however many frames it stays published. While the pointer is down the
    // field goes exactly where it was told — a scrubber that eases toward the
    // finger is a scrubber that lags it — and the release needs no special
    // case, because the last drag frame already left `target` and `current` in
    // the same place.
    const seek = feed?.seek;
    if (seek && seek.gen !== seekGenRef.current) {
      seekGenRef.current = seek.gen;
      const to = offsetFor(seek.progress, minOffset, max);
      rigNow.target = to;
      if (seek.dragging) rigNow.current = to;
    }

    if (reducedMotion) {
      rigNow.current = rigNow.target;
    } else {
      rigNow.current +=
        (rigNow.target - rigNow.current) * Math.min(1, 1 - Math.exp(-dt * 9));
      if (Math.abs(rigNow.target - rigNow.current) < 0.05) {
        rigNow.current = rigNow.target;
      }
    }

    // THE ONE PLACE THIS FIELD TOUCHES THE FEED, and the ownership test is on
    // the whole block rather than on each write — see `field-feed.ts`.
    const ownsFeed = publishing;
    if (ownsFeed) {
      feed.progress = progressFor(rigNow.current, minOffset, max);
    }

    // Row-start anchors for the threadline's strand field: every visible row
    // at the CURRENT level is one anchor (L0 slice / L1 day / L2 week), as a
    // screen-Y fraction of the shared field height, carrying the row's own
    // strands so the band winds them at exactly this height (v0.11 §2.3).
    if (ownsFeed) {
      const h = size.height;
      const scroll = rigNow.current;
      const faces = layout.faceHeights;
      const list: FieldAnchor[] = [];
      for (let i = 0; i < rows.length; i++) {
        // The unit's OWN height, off the table — a card's formula at a card
        // rung, a measurement at the turns rung. The offset table has already
        // decided this once; re-deriving it here as `geo.cardH` would put the
        // band's knot in the middle of the top card's worth of a conversation
        // rather than the middle of the conversation.
        const faceH = faces[i] ?? geo.cardH;
        const centerPy = (tops[i] ?? 0) + faceH / 2 - scroll;
        if (centerPy < -faceH || centerPy > h + faceH) continue;
        // `span` is the unit's own height: the band sizes each knot to the
        // content it marks, so the twist spans the slice and unwinds in the gap
        // after it. Unclamped, as the conversation field has always published
        // it — a tall block's knot simply spans further than the viewport.
        list.push({
          y: centerPy / h,
          strands: rows[i].strands,
          span: faceH / h,
          // Identity, so the band can NAME where a scrub is heading rather
          // than reporting a fraction. Straight off the row — see `FieldAnchor`.
          date: rows[i].top.date,
          focus: rows[i].top.focus,
        });
        if (list.length >= 24) break;
      }
      feed.anchors = list;
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
    //
    // The head is a boundary too, and it takes precedence at the top: being at
    // the very top IS the announcement, which is what `armedGate`'s origin
    // branch says. Its own box is the leading region above unit 0, off the same
    // table the rows are placed from.
    const bands = gateBands(
      bandsRef.current,
      rows.length,
      (i) => i < rows.length - 1,
      tops,
      pitch,
      hasOrigin,
    );
    const armed = armedGate(bands, rigNow.current, size.height, minOffset);
    let armedBand: GateBand | null = null;
    for (const band of bands) {
      const isArmed = band.index === armed;
      if (isArmed) armedBand = band;
      const signal =
        band.index === ORIGIN_REGION
          ? originSignal.current
          : signalFor(rows[band.index].key);
      if (signal.armed !== isArmed) signal.armed = isArmed;
      if (isArmed && signal.dir !== dirRef.current) signal.dir = dirRef.current;
    }
    if (ownsFeed) {
      feed.crossing.y = armedBand
        ? (armedBand.top + armedBand.height / 2 - rigNow.current) / size.height
        : null;
    }

    // Scroll-driven camera drift, VERTICAL ONLY.
    //
    // There used to be a horizontal term too: `cx = (p - 0.5) * 2 * 0.42 *
    // worldScale`, paired with `lookAt(0, cy, 0)`. That pair keeps the card
    // column centred — which is why it looked right on paper — but the only way
    // to be centred on x=0 from x=cx is to TURN, and a perspective camera that
    // has turned by atan(0.42/9) = 2.67° renders a face-on rectangle as a
    // trapezoid: the card's left and right edges sit at different depths, so
    // the card is drawn very slightly crooked. Measured, that is ~2% of scale
    // across a 900px card — about 20px of keystone, and unmistakably "the card
    // is leaning" rather than "the field has depth".
    //
    // The vertical term is free by comparison: the camera sits at y=cy and
    // looks at y=cy, so there is no pitch and no distortion — it simply moves
    // what is on screen, which is the whole point of a drift. So the drift
    // stays and the turn goes. Depth in this field comes from the sheets' own
    // poses (`sheetPose`), which is where it was always drawn from anyway.
    const camZ = camZFor(size.height);
    const worldScale = worldScaleFor(size.height);
    // THE RUNG SLIDE, restored (see `CardFieldProps.slideRef`): the shell's
    // conversation↔cards transition parks a parallel x offset here for its
    // 300 ms — world px = screen px at the z=0 plane, so the GL content
    // shifts by exactly what the DOM layer's x shift moves the Html faces
    // by. Dead-on framing preserved: still a parallel shift, never a turn.
    const slideX = slideRef?.current ?? 0;
    const camX = camXOffset + slideX;
    if (!reducedMotion) {
      const p = feed.progress; // 0..1 (0 = oldest/top, 1 = newest/bottom)
      const cy = (p - 0.5) * 2 * 0.14 * worldScale; // ±0.14 old world units
      camera.position.set(camX, cy, camZ);
      camera.lookAt(camX, cy, 0);
    } else {
      camera.position.set(camX, 0, camZ);
      camera.lookAt(camX, 0, 0);
    }

    // Which way the reader is travelling, for the boundary that speaks. Read
    // off the eased position rather than the input, so a flick that has not
    // settled yet does not flip the side mid-crossing.
    if (rigNow.current !== lastScrollRef.current) {
      dirRef.current = rigNow.current < lastScrollRef.current ? "past" : "future";
      lastScrollRef.current = rigNow.current;
    }

    // Visible-range virtualization (React state changes only when it does) —
    // the shared rule, so a card row and a conversation unit mount by the same
    // arithmetic. The margin is what keeps a unit's measurement from being
    // thrown away the moment it leaves the viewport, and at the turns rung it
    // is sized to the tallest unit measured (see `unitMetricsFor`).
    const nextVisible = visibleRangeFor(
      tops,
      rows.length,
      rigNow.current,
      size.height,
      metrics.margin,
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
      {hasOrigin && (
        <OriginRow
          // The head's BOTTOM edge is unit 0's top. The table starts at 0, so
          // this is `tops[0]` today — read off the table rather than written as
          // 0, because "where does the column start" is the table's answer and
          // a literal here would be a second one.
          bottomPx={tops[0] ?? 0}
          width={geo.cardW}
          oldestIso={oldestIso}
          hasMore={hasMore}
          loading={loadingOlder}
          onLoadOlder={requestOlder}
          signal={originSignal.current}
          rig={rig}
        />
      )}
      {visible.map((row, vi) => {
        const index = first + vi;
        const topPx = tops[index] ?? 0;
        // Every row but the last closes a boundary, and the closing row owns
        // it — the region `layoutFor` reserved after this row's face.
        const boundary =
          index < rows.length - 1
            ? boundaryBetween(row.top, rows[index + 1]?.top)
            : null;
        if (turns) {
          // The same unit, the other component: one slice drawn as its turns
          // rather than as a card (`units.ts`). The gate is NOT a sibling here —
          // it is drawn inside the unit, at its tail, because the room for it
          // lives at the end of a MEASURED box and hanging it outside would
          // need the measurement to be known before the unit renders, which is
          // the one thing this rung cannot promise.
          return (
            <ConversationUnit
              key={row.key}
              entry={row.top}
              index={index}
              // The unit's CENTRE, off the table — see `ConversationUnit` for
              // why a measured box is placed by its middle and not its top.
              centerPx={
                ((tops[index] ?? 0) + (tops[index + 1] ?? topPx + geo.cardH)) / 2
              }
              boundary={boundary}
              signal={boundary ? signalFor(row.key) : undefined}
              rig={rig}
              reducedMotion={reducedMotion}
              onHeight={(px) => onUnitHeight(row.key, px)}
            />
          );
        }
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
              narration={narration}
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
          tops={tops}
          level={metrics.level}
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
  filteredOut,
  onNeedOlder,
  onOpenSlice,
  onNarrate,
  initialAtId,
  genKey = "",
  reducedMotion,
  feed,
  publishing,
  rung: rungProp,
  onRungChange,
  insetTop = 0,
  insetBottom = 0,
  camXOffset = 0,
  slideRef,
  exiting = false,
  frozenRung,
}: CardFieldProps) {
  const t = useTranslations("timeline3d");
  const tc = useTranslations("companion");
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
  // The narrate corner action, as data — the label is translated HERE (the
  // Canvas root cuts next-intl context off from the drei Html portals, the
  // same reason `texts` is a prop). Undefined → no button on any card face.
  const narration = useMemo<SliceNarration | undefined>(
    () =>
      onNarrate
        ? { label: tc("narrateAria"), onSelect: onNarrate }
        : undefined,
    [onNarrate, tc],
  );
  // THE RUNG IS THE ZOOM; `level` is derived from it, never stored. `StackLevel`
  // is still what the GROUPING is keyed by (`groupForLevel`, `framePitchFor`,
  // `backingSheets`), so keeping a separate level state would be a second answer
  // to a question `units.ts` already answers — and the two finest rungs share
  // their answer, which is exactly the pair a second state would drift apart.
  const [innerRung, setInnerRung] = useState<FieldRung>(
    initialAtId ? "slice" : rungForStackLevel(DEFAULT_LEVEL),
  );
  // THE EXIT FREEZE: while the shell's timeline layer slides out to the
  // conversation rung, this field keeps rendering the rung the reader was
  // actually looking at — the world content that slides out is the content
  // that was on screen, not one frame of the conversation rung's units.
  const rung = exiting && frozenRung ? frozenRung : (rungProp ?? innerRung);
  const level = stackLevelForRung(rung);
  const applyRung = useCallback(
    (next: FieldRung) => {
      setInnerRung(next);
      onRungChange?.(next);
    },
    [onRungChange],
  );
  useEffect(() => {
    // The band's zoom linkage, when this field owns the band. Written as the
    // LEVEL because the band scales by the GROUPING and the two finest rungs
    // group identically — the band cannot tell them apart, and saying otherwise
    // here would mean re-deriving its zoom range against a camera it is about
    // to stop having its own of (C10's work, not this step's).
    if (publishing) feed.level = level;
  }, [level, feed, publishing]);
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

  // ── Paging older: ONE caller, and it is the head ─────────────────────────
  // `requestOlder` is the latch + the in-flight flag, and the head's own
  // control is the only thing that calls it — this field no longer pages
  // itself. See the module header for the two automatic triggers that were
  // removed and why.
  // Two things ask: the top-edge trigger in the frame loop, and the head's own
  // control. Both go through here for the in-flight flag, so the head can show
  // that a page is on its way regardless of which of the two asked — and so the
  // guard is stated once rather than as a habit of one caller. The ref is the
  // latch (a page takes hundreds of ms and the edge can be crossed many times
  // in that window); the state is only what the pill paints.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderInFlightRef = useRef(false);
  const requestOlder = useCallback(() => {
    if (olderInFlightRef.current) return;
    const pending = onNeedOlder();
    // A caller that pages synchronously has nothing to wait on, and the pill
    // simply does not spin — there is no honest moment to spin it.
    if (!(pending instanceof Promise)) return;
    olderInFlightRef.current = true;
    setLoadingOlder(true);
    void pending.finally(() => {
      olderInFlightRef.current = false;
      setLoadingOlder(false);
    });
  }, [onNeedOlder]);

  // ── Measured face heights: the turns rung's only input the cards lack ────
  // Keyed by ROW KEY and not by index. A page arriving at the head renumbers
  // every row, and an index-keyed map would hand each arriving slice the height
  // of whichever one used to sit at its index — the same re-indexing trap the
  // conversation field's `heightsRef` documents, avoided here by keying on the
  // thing that does not move.
  const measuredRef = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  // Coalesced to at most one bump per frame. A page landing reports a height
  // per unit as each slice's read resolves, and a state update per report is a
  // full re-render of the field per slice.
  const bumpPendingRef = useRef(false);
  const onUnitHeight = useCallback((key: string, px: number) => {
    if (measuredRef.current.get(key) === px) return;
    measuredRef.current.set(key, px);
    if (bumpPendingRef.current) return;
    bumpPendingRef.current = true;
    requestAnimationFrame(() => {
      bumpPendingRef.current = false;
      setMeasureVersion((v) => v + 1);
    });
  }, []);

  const rows = useMemo(() => groupForLevel(entries, level), [entries, level]);
  // The PANE decides the card's COMPOSITION; `frameGeometryFor` decides its
  // size from the same measured box. Keeping the two apart is what stops a
  // phone from getting a desktop card scaled down — the composition is where
  // "too small to read" is actually fixed, not the dimensions.
  //
  // IT USED TO BE THE TIER'S, and that was a statement about the window for a
  // card that lives in the pane. The two agree almost everywhere (the pane is
  // the window minus a rail) and part company on a tall window, which is the
  // family that was wrong: see `frameVariantFor`.
  const variant = frameVariantFor(fieldSize.w || 1280, fieldSize.h || 800);
  const geo = useMemo(
    () => frameGeometryFor(variant, fieldSize.w || 1280, fieldSize.h || 800),
    [variant, fieldSize],
  );
  // THE ONE OFFSET TABLE. Every consumer — the scene's placement, the scroll
  // transitions, the deep-link landing — reads this one, because
  // with measured heights in the inputs two tables computed from "the same"
  // inputs are two tables that can disagree.
  const metrics = useMemo(
    () => unitMetricsFor(rung, geo, measuredRef.current),
    // `measureVersion` is the trigger. `measuredRef.current` is deliberately
    // not a dependency — a ref's identity never changes, so listing it would
    // say "this never moves" about the one thing that does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rung, geo, measureVersion],
  );
  const layout = useMemo(
    () => layoutForRows(rows, rung, geo, measuredRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, rung, geo, measureVersion],
  );
  const tops = layout.tops;
  // The window's head, and the floor of the scroll range it implies. Both the
  // scene and every clamp in this component read the same pair — see
  // `originMinOffset`.
  const hasOrigin = rows.length > 0;
  const minOffset = minOffsetFor(hasOrigin, insetTop);

  // Render-time prepend compensation: shift the scroll rig synchronously so the
  // next frame's RowGroup positions use the corrected offset, avoiding a
  // one-frame jump before the useEffect could run.
  if (rows.length > 0) {
    const firstKey = rows[0]?.key ?? null;
    const prevFirst = prevFirstKeyRef.current;
    if (prevFirst && prevFirst !== firstKey && !pendingAnchorRef.current) {
      const added = rows.findIndex((r) => r.key === prevFirst);
      if (added > 0) {
        // THE SHIFT IS `tops[added]` — how far the old head has moved down the
        // column — not `added * pitch`. The two are the same number at a card
        // rung and stop being one at the turns rung, where a unit is as tall as
        // its text: multiplying a count by a pitch would move the camera by a
        // card per arriving SLICE and drop the reader's place by the
        // difference.
        const shift = tops[added] ?? added * metrics.fallbackExtent;
        rig.current.target += shift;
        rig.current.current += shift;
        rig.current.genAt = 0;
        rig.current.dealEligible = null;
      }
    }
    prevFirstKeyRef.current = firstKey;
  }

  // ── The camera follows the table when the table moves UNDER it ───────────
  // A card rung never needs this: `faceHeightOf` is `geo.cardH`, a formula, so
  // the table is a constant and nothing can move. The turns rung does, because
  // `faceHeightOf` is a DOM MEASUREMENT that arrives after the unit mounts — so
  // the column re-lays itself out several times in the seconds after a reader
  // arrives, and without this the reader's content slides by however much the
  // units above them changed.
  //
  // Why the magnitude is not small: the running carry is seeded from the first
  // positive height anywhere in the table, so with only a band of units near
  // the viewport measured, everything ABOVE that band is laid out at the seed's
  // height and the anchor's top is `anchorIndex x carry`. When the seed moves —
  // which it does as the mounted set changes — that top moves by
  // `anchorIndex x delta`. It scales with how far into history the reader is,
  // which is why it measured 3px on one run and 689px on another.
  //
  // WHAT IT DOES: pin the unit at the viewport top. Re-read that unit's start
  // off the old table, take its start off the new one, and move the camera by
  // the difference — the same statement `relayout` makes in the conversation
  // field, which fires on EVERY re-layout for exactly this reason and says so
  // in as many words. The prepend block above is this mechanism's other half.
  //
  // WHAT IT DELIBERATELY IGNORES. A change in the UNIT KEYS is never this: a
  // rung change, a strand filter and a page all renumber or replace the rows,
  // and all three position the camera themselves — the first two through
  // `startTransition`, the third through the prepend shift. Only a change to
  // the heights of the SAME units in the SAME order is a measurement landing.
  // `pendingAnchorRef` is the second guard: a landing owns the position
  // outright until it has been applied, and this effect is declared above the
  // anchor effect precisely so it cannot see that flag already cleared.
  const reconcileRef = useRef<{ keys: string; tops: number[] } | null>(null);
  useEffect(() => {
    const keys = rows.map((r) => r.key).join("|");
    const prev = reconcileRef.current;
    reconcileRef.current = { keys, tops: tops.slice() };
    if (!prev || prev.keys !== keys) return;
    if (prev.tops.length !== tops.length) return;
    if (pendingAnchorRef.current) return;
    const count = prev.tops.length - 1;
    const idx = unitAtPx(prev.tops, count, rig.current.current);
    if (idx < 0) return;
    const delta = (tops[idx] ?? 0) - (prev.tops[idx] ?? 0);
    if (delta === 0) return;
    rig.current.current += delta;
    rig.current.target += delta;
  }, [rows, tops]);

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
  // The threadline only converges while a field owns the band; relax the feed on
  // unmount (and on losing ownership) so the weave unwinds instead of freezing
  // around units that are no longer on screen.
  useEffect(() => {
    if (!publishing) return;
    // Relax on ACQUIRE as well as on release — see the note in
    // `conversation-field.tsx`. A field that mounts but never reaches its frame
    // loop (an empty catalog renders no canvas) would otherwise leave the band
    // holding the other pane's winding.
    clearFeed(feed);
    return () => clearFeed(feed);
  }, [feed, publishing]);

  // ── Generation bookkeeping: bump the deal clock on rung/filter change ──
  const genTrackRef = useRef<{ rung: FieldRung; genKey: string } | null>(null);
  if (
    genTrackRef.current === null ||
    genTrackRef.current.rung !== rung ||
    genTrackRef.current.genKey !== genKey
  ) {
    genTrackRef.current = { rung, genKey };
    rig.current.genAt = performance.now();
    rig.current.dealEligible = visibleKeysFor(
      tops,
      rows,
      metrics,
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

  // ── Start a real rung transition (snapshot + leaving cards) ──
  const startTransition = useCallback(
    (fromRung: FieldRung, toRung: FieldRung, anchorId: string | null) => {
      pendingAnchorRef.current = anchorId;
      if (reducedMotion) {
        rig.current.dealOrigins = null;
        rig.current.dealEligible = null;
        setLeaving([]);
        return;
      }
      const fromLevel = stackLevelForRung(fromRung);
      const toLevel = stackLevelForRung(toRung);
      const measured = measuredRef.current;
      const fromRows = groupForLevel(entries, fromLevel);
      const toRows = groupForLevel(entries, toLevel);
      const fromMetrics = unitMetricsFor(fromRung, geo, measured);
      const toMetrics = unitMetricsFor(toRung, geo, measured);
      const fromTops = layoutForRows(fromRows, fromRung, geo, measured).tops;
      const toLayout = layoutForRows(toRows, toRung, geo, measured);
      const toTops = toLayout.tops;
      const cardH = geo.cardH;
      const scroll = rig.current.current;
      const fieldH = fieldSize.h || 800;

      const worldScale = worldScaleFor(fieldH);
      const dealOrigins = new Map<string, DealOrigin>();

      const anchorIdx = anchorId ? indexForAnchor(toRows, anchorId) : -1;
      if (anchorIdx >= 0) rig.current.anchorIndex = anchorIdx;
      const newCurrent =
        anchorIdx >= 0
          ? centeredScrollForAnchor(
              toLayout,
              anchorIdx,
              fieldH,
              minOffsetFor(toRows.length > 0, insetTop),
              insetBottom,
            )
          : scroll;
      // Pre-apply the post-transition scroll so the first rendered frame
      // already uses the same current that RowGroup will animate toward.
      rig.current.current = newCurrent;
      rig.current.target = newCurrent;

      for (let newIdx = 0; newIdx < toRows.length; newIdx++) {
        const row = toRows[newIdx];
        const old = findOldSlot(row.top.id, fromRows);
        if (old == null) continue;
        // Both ends use the CARD height, not the unit's own: the deal is a
        // card-sized gesture playing between two card-sized slots. At a card
        // rung that is the unit; at a conversation rung it is where the top
        // card of the unit sits — which is where the reader's eye already is.
        const newCenterPy = (toTops[newIdx] ?? 0) + cardH / 2 - newCurrent;
        const oldCenterPy = (fromTops[old.index] ?? 0) + cardH / 2 - scroll;
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
        toMetrics,
        fieldH,
        newCurrent,
      );

      // Only a zoom OUT swallows cards. The two finest rungs share their
      // grouping, so stepping between them leaves every unit where it is and
      // this is empty by construction rather than by a special case.
      setLeaving(
        fromLevel < toLevel
          ? buildLeaving(
              fromRows,
              fromTops,
              scroll,
              fromMetrics.fallbackExtent,
              cardH,
              toRows,
              fieldH,
            )
          : [],
      );
    },
    [entries, geo, fieldSize.h, reducedMotion, insetTop, insetBottom],
  );

  // ── Anchor / scroll position after rows change (rung, filter, paging) ──
  useEffect(() => {
    if (rows.length === 0) return;
    const max = maxOffsetFor(layout.total, fieldSize.h, minOffset, insetBottom);

    // Prepend compensation now runs synchronously during render (above).

    const anchorId = pendingAnchorRef.current;
    if (anchorId != null) {
      pendingAnchorRef.current = null;
      const idx = indexForAnchor(rows, anchorId);
      if (idx >= 0) {
        rig.current.anchorIndex = idx;
        const pos = centeredScrollForAnchor(
          layout,
          idx,
          fieldSize.h,
          minOffset,
          insetBottom,
        );
        rig.current.target = pos;
        rig.current.current = pos;
        rig.current.genAt = performance.now();
        rig.current.dealEligible = visibleKeysFor(
          tops,
          rows,
          metrics,
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
        metrics,
        fieldSize.h,
        max,
      );
    }
    // `layout.total` rather than `count * pitch`: the column's extent is what
    // the frame loop clamps against, and at the turns rung no count times any
    // pitch gives it.
  }, [rows, geo, layout, metrics, fieldSize.h, tops, minOffset, insetBottom]);

  // ── ?at= flash decay ──
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 3600);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ── Rung stepping ──
  const stepRung = useCallback(
    (next: FieldRung, anchorId?: string) => {
      if (next === rung) return;
      startTransition(rung, next, anchorId ?? null);
      applyRung(next);
    },
    [rung, startTransition, applyRung],
  );

  /** Top id of the unit nearest the viewport center — the gesture anchor.
   *  Off the offset table, not `scroll / pitch`: a conversation unit is as tall
   *  as its text, so dividing by a pitch names the wrong unit near the top of a
   *  long one. */
  const centerAnchorFor = useCallback(
    (fromRung: FieldRung) => {
      const fromRows = groupForLevel(entries, stackLevelForRung(fromRung));
      const table = layoutForRows(fromRows, fromRung, geo, measuredRef.current);
      const idx = unitAtPx(
        table.tops,
        fromRows.length,
        rig.current.current + fieldSize.h / 2,
      );
      return fromRows[idx]?.top.id ?? null;
    },
    [entries, geo, fieldSize.h],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const next = RUNG_ORDER[rungIndex(rung) + dir];
      if (next === undefined || next === rung) return;
      startTransition(rung, next, centerAnchorFor(rung));
      applyRung(next);
    },
    [rung, centerAnchorFor, startTransition, applyRung],
  );

  // ── External rung changes (the lens switcher) ──
  // Render-time, not an effect: the transition snapshot (deal origins +
  // leaving cards) must exist BEFORE the new rung's rows render, or the first
  // frame already shows the final layout with no fly-in. An internal change
  // echoes back through the prop with innerRung already updated, so the
  // `rungProp !== innerRung` guard runs the transition exactly once.
  // During the EXIT freeze the prop flips to "conversation" while this field
  // keeps its card rung: the transition is skipped outright (the snapshot
  // would re-deal rows nobody will see), and the tracker still advances so
  // the post-exit enter doesn't replay it.
  const prevRungPropRef = useRef(rungProp);
  if (rungProp != null && prevRungPropRef.current !== rungProp) {
    prevRungPropRef.current = rungProp;
    if (!exiting && rungProp !== innerRung) {
      startTransition(innerRung, rungProp, centerAnchorFor(innerRung));
      setInnerRung(rungProp);
    }
  }

  // A CARD click means "show me this thing at the next grain down" — one step
  // finer, which at `slice` is the conversation itself. At the conversation
  // there is no finer rung and the click keeps its old meaning: hand the slice
  // to the chat, which is the one place a slice can still be read in its full
  // scrollback form.
  const onActivate = useCallback(
    (row: StackRow) => {
      const finer = RUNG_ORDER[rungIndex(rung) - 1];
      if (finer === undefined) onOpenSlice(row.top.id, row.top.start);
      else stepRung(finer, row.top.id);
    },
    [onOpenSlice, stepRung, rung],
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

  // ── Keyboard: the field had NO keyboard scroll at all before this ────────
  // Wheel, one-finger drag and pinch were the only ways to move, so a reader
  // without a pointer could not travel the timeline at all — they could only
  // Tab between the cards that happened to be mounted, which is the one
  // grouping of this content that cannot be reached by any other means. The
  // steps mirror what a scroll container does: a line for the arrows, a
  // viewport for Page, and the ends for Home/End.
  //
  // Bound as a React prop rather than through `addEventListener` in an effect.
  // The imperative version had a real bug: this component renders a DIFFERENT
  // tree (with no wrapper, so `wrapRef.current` is null) until the catalog
  // arrives, so the effect attached nothing on its first run — and its deps
  // (`layout.total`, the measured height) did not change afterwards, so it
  // never got a second chance. The handler was never bound and the keys went
  // nowhere, silently. A prop has no attach order to get wrong.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Never steal a key from a control inside the field — the cards are
      // buttons and the strand filter has a real input.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== e.currentTarget &&
        target.closest("input, textarea, button, a, [contenteditable]")
      ) {
        return;
      }
      const viewH = e.currentTarget.clientHeight || fieldSize.h;
      const max = maxOffsetFor(layout.total, viewH, minOffset, insetBottom);
      const page = Math.max(120, viewH * 0.9);
      let next: number;
      switch (e.key) {
        case "ArrowDown":
          next = rig.current.target + 120;
          break;
        case "ArrowUp":
          next = rig.current.target - 120;
          break;
        case "PageDown":
          next = rig.current.target + page;
          break;
        case "PageUp":
          next = rig.current.target - page;
          break;
        case "Home":
          // The very top is the head of the window, not unit 0's top edge:
          // Home is where the "load earlier" control lives.
          next = minOffset;
          break;
        case "End":
          next = max;
          break;
        default:
          return;
      }
      e.preventDefault();
      rig.current.target = THREE.MathUtils.clamp(next, minOffset, max);
    },
    [layout.total, fieldSize.h, minOffset, insetBottom],
  );

  // THE CANVAS IS THE SHELL'S (§14 merge). This component keeps everything
  // that is NOT GL — the gesture surface, the rung/deal state, the offset
  // table — and hands the scene subtree to the shared canvas through the
  // world slot (`useWorldScene`). Registered on every render (the element
  // is a description; the canvas re-renders only when this field does) and
  // cleared on unmount. Empty states register NOTHING — there is no scene.
  useWorldScene(
    entries.length === 0 ? null : (
      <FieldScene
        rows={rows}
        geo={geo}
        rung={rung}
        layout={layout}
        metrics={metrics}
        onUnitHeight={onUnitHeight}
        rig={rig}
        hasMore={hasMore}
        requestOlder={requestOlder}
        loadingOlder={loadingOlder}
        reducedMotion={reducedMotion}
        flashId={flashId}
        onActivate={onActivate}
        arias={arias}
        texts={texts}
        leaving={leaving}
        onLeavingDone={onLeavingDone}
        feed={feed}
        publishing={publishing}
        narration={narration}
        insetTop={insetTop}
        insetBottom={insetBottom}
        camXOffset={camXOffset}
        slideRef={slideRef}
      />
    ),
  );

  if (entries.length === 0) {
    // AN EMPTY FIELD IS TWO DIFFERENT SITUATIONS, and this used to answer both
    // with "No memory slices yet — start a conversation first."
    //
    // When a strand filter is on, the board bar offers every strand in
    // `strands.json` (the whole history) while the filter can only see the
    // loaded window (the newest month). Pick a strand that only occurs further
    // back and the field emptied out, claimed the memory was empty, and offered
    // NO WAY OUT — not the head, not a pager, because the empty branch returns
    // before any of that is built. The reader was stuck until they cleared the
    // filter, and the app had told them something untrue on the way.
    //
    // So the filtered case says what is actually true and keeps the pager.
    if (filteredOut) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
          <p className="text-sm text-foreground">{t("filteredOut.title")}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("filteredOut.body")}
          </p>
          {hasMore && (
            <button
              type="button"
              data-filtered-out-pager
              onClick={() => void onNeedOlder()}
              className="rounded-full px-3 py-1.5 text-xs text-muted-foreground ring-1 ring-border transition-colors hover:text-foreground hover:ring-foreground/30"
            >
              {t("filteredOut.loadOlder")}
            </button>
          )}
        </div>
      );
    }
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
      // Focusable so the arrow/Page/Home/End handler above has somewhere to
      // listen. `tabIndex={0}` on a scrollable region is the standard advice
      // and it is what this is: the cards inside are reachable by Tab either
      // way, but the SPACE between them is only reachable from here.
      //
      // The div is the field's whole DOM presence now: the scene it
      // controls renders in the shell's shared canvas (§14 merge), and the
      // card faces arrive back over it as drei Html portals.
      tabIndex={0}
      role="group"
      aria-label={t("fieldLabel")}
      onKeyDown={onKeyDown}
      className="relative h-full w-full outline-none"
      style={{ touchAction: "none" }}
    />
  );
}
