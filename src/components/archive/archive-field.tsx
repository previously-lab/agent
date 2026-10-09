"use client";

/**
 * ArchiveField — the 原稿 rung's default surface (v0.25a §四): the archive
 * field IS a grid of piles, re-wiring the preserved card-field machinery
 * (`timeline-3d/**`, untouched — everything here is an IMPORT) to documents.
 *
 *   rows = time buckets (day for the trailing week, ISO week beyond),
 *   columns = the case categories (empty ones simply have no column) plus
 *   the synthetic trailing RECORDS column (v0.25b §三 — exists only while
 *   slices exist, and a category filter hides it: a category question is
 *   about cases),
 *   a cell = ONE PILE — one case (its index + its pieces), its thickness the
 *   tiered page volume, its cover printed at the pile's own mm scale (§九).
 *   Every bucket also carries its ONE RECORD PILE (the bucket's slices
 *   folded together, thickness tiered off the TURN volume, opening the
 *   newest slice's transcript on the desk); a bucket with only records is
 *   still a row.
 *
 * THE MACHINERY REUSED. The scroll rig (`FieldRig`), the offset table
 * (`buildOffsets`), the virtual scroll (`visibleRangeFor`), the rubber band
 * (`elasticAdd`), the scroll-range ends (`minOffsetFor`/`maxOffsetFor`), the
 * camera (`camZFor`/`clipPlanesFor`/`worldScaleFor`, the dead-on parallel
 * rule included), and the world-slot handshake (`useWorldScene("field", …)`,
 * the desk's own) — all imported, none edited. What is new is only what is
 * the archive's: the data pipeline (lib/archive/actions.ts), the model
 * (archive-model.ts), and the pile/row DOM (archive-pile.tsx, archive.css).
 *
 * THE SCENE IS THE CANVAS'S. Like the desk, this component owns everything
 * that is NOT GL — the data, the gestures, the virtual range — and hands the
 * scene subtree to the shared canvas through the slot. The app shell keeps
 * the desk and this field mutually exclusive (AnimatePresence mode="wait"),
 * so the slot never has two owners.
 *
 * THE SCROLL SURVIVES THE DESK. The rig object lives in the app shell (a
 * ref), not here: opening a pile and putting it back (Escape) remounts this
 * field with the same rig, so the reader returns to the exact scroll
 * position they left — the same object the hotel round trip keeps.
 *
 * GESTURES ARE WINDOW-BOUND (the desk's wheel pager is the precedent): the
 * pile DOM renders through drei Html portals, which are NOT descendants of
 * this component's wrapper, so a wrapper-bound listener would never see a
 * wheel over a pile. Every handler gates on the floating chrome's data hooks
 * instead — the conversation pill, the library, the board bar and friends
 * keep their own gestures. No zoom, no pinch: the field has one scale.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useTheme } from "@teispace/next-themes";
import { useLocale, useTranslations } from "next-intl";
import { useShell } from "@/components/shell/shell-provider";
import { useWorldScene } from "@/components/timeline-3d/world-slot";
import type { FieldRig } from "@/components/timeline-3d/field-rig";
import {
  buildOffsets,
  visibleRangeFor,
} from "@/lib/timeline3d/field-offsets";
import { elasticAdd, RUBBER_BAND_PX } from "@/lib/timeline3d/field-snap";
import { minOffsetFor, maxOffsetFor } from "@/lib/chat/field-blocks";
import { progressFor } from "@/lib/timeline3d/field-feed";
import {
  camZFor,
  clipPlanesFor,
  worldScaleFor,
} from "@/lib/timeline3d/camera";
import { dateTimeFormat } from "@/lib/time/formatter-cache";
import {
  getArchiveField,
  type ArchiveFieldData,
  type ArchivePile,
} from "@/lib/archive/actions";
import {
  archiveColumns,
  archiveGeometry,
  archiveInsetTop,
  buildArchiveUnits,
  buildBuckets,
  localTodayIso,
  type ArchiveBucket,
  type ArchiveUnit,
} from "./archive-model";
import {
  ArchivePileView,
  RecordPileView,
  type ArchivePileTexts,
  type RecordPileTexts,
} from "./archive-pile";
import "./archive.css";

/** The floating chrome's own gestures stay its own — a wheel or a drag that
 *  starts inside one of these never moves the field. */
const CHROME_SELECTOR =
  "[data-app-header], [data-board-bar], [data-library-control], [data-composer], [data-world-gate], [data-page-controls], [data-companion-pod-root]";

/** Input quiet time before a held rubber band eases home — the card field's
 *  own constant (field-snap.ts documents the mechanism). */
const RELEASE_IDLE_MS = 120;

/** The entrance stagger per unit, and its cap — a fresh field settles in a
 *  third of a second no matter how many rows it holds. */
const ENTER_STAGGER_MS = 45;
const ENTER_STAGGER_CAP_MS = 360;

// ─── The data: one aggregated read, cached for the session ─────────────────
// The field is the rung's DEFAULT surface — remounted by every hotel round
// trip — so refetching per mount would re-deal it every time. The session
// cache answers a remount instantly; a settled turn invalidates it (the app
// shell's refreshCatalog → invalidateArchiveField + a dataGen bump), because
// a turn may have written a new case.

let fieldCache: { key: string; data: ArchiveFieldData } | null = null;

/** A settled turn may have written cases — the next read must re-aggregate. */
export function invalidateArchiveField(): void {
  fieldCache = null;
}

// ─── The component ──────────────────────────────────────────────────────────

export function ArchiveField({
  persona,
  rig,
  dataGen,
  reducedMotion,
  leaving,
}: {
  persona?: string;
  /** The scroll rig, owned by the app shell — see the module header. */
  rig: MutableRefObject<FieldRig>;
  /** Bumped when a turn settles; a change re-aggregates the field. */
  dataGen: number;
  reducedMotion: boolean;
  /** The shell's handover says the field is on its way out — the units play
   *  their CSS exit beat while the branch fades (presence never reaches
   *  this deep: AnimatePresence mode="wait" wedges under usePresence, so
   *  the handover is hand-timed in the shell). */
  leaving: boolean;
}) {
  const t = useTranslations("archiveField");
  const tLibrary = useTranslations("library");
  const locale = useLocale();
  const { openDesk, archiveCategory, composerClearance, panelMode } =
    useShell();
  // The exit beat arrives as a PROP (see the signature); the scene reads it
  // as `exiting`, the name the card field's units already knew.
  const exiting = leaving;

  // The pile's printed strings — prepared HERE (next-intl context does not
  // cross the drei Html portal root; the FrameCardTexts pattern).
  const pileTexts = useMemo<ArchivePileTexts>(() => {
    const stamp = dateTimeFormat(locale, { month: "short", day: "numeric" });
    return {
      pileAria: (pile, categoryLabel) =>
        t("pileAria", {
          name: pile.name,
          category: categoryLabel,
          count: pile.pages,
        }),
      categoryLabel: (category) => tLibrary(`category.${category}`),
      columnLabel: (column) =>
        column === "records" ? t("recordsLabel") : tLibrary(`category.${column}`),
      dateLabel: (date) => stamp.format(new Date(`${date}T00:00:00`)),
      openedLabel: (opened) => (opened ? t("openedAt", { date: opened }) : ""),
    };
  }, [t, tLibrary, locale]);

  // The record pile's printed strings — same portal constraint. The stamp
  // line is the §九 pile-scale ruling made literal: label · date · turns.
  const recordTexts = useMemo<RecordPileTexts>(() => {
    const stamp = dateTimeFormat(locale, { month: "short", day: "numeric" });
    return {
      recordAria: (pile, bucket) =>
        t("recordPileAria", {
          date: bucket,
          slices: pile.slices,
          turns: pile.turns,
        }),
      stampLabel: (pile) =>
        `${t("recordsLabel")} · ${stamp.format(new Date(`${pile.date}T00:00:00`))} · ${t("recordTurns", { count: pile.turns })}`,
    };
  }, [t, locale]);

  const bucketLabel = useCallback(
    (bucket: ArchiveBucket): string => {
      if (bucket.kind === "undated") return t("undated");
      const date = dateTimeFormat(locale, {
        month: "short",
        day: "numeric",
      }).format(new Date(`${bucket.date}T00:00:00`));
      return bucket.kind === "week" ? t("weekOf", { date }) : date;
    },
    [t, locale],
  );

  // ── The aggregated read: warm from the session cache when it answers for
  //    this persona, otherwise one round trip. A failure stays quiet (the
  //    field renders nothing and the next mount retries) — the shelf's own
  //    rhythm. ──
  const personaKey = persona ?? "";
  const [state, setState] = useState<{
    key: string;
    gen: number;
    data: ArchiveFieldData;
  } | null>(() =>
    fieldCache?.key === personaKey
      ? { key: personaKey, gen: dataGen, data: fieldCache.data }
      : null,
  );
  // A warm mount skips the entrance beat — a return from the desk or the
  // hotel is not a fresh deal.
  const instantRef = useRef(state !== null);
  useEffect(() => {
    if (state?.key === personaKey && state.gen === dataGen) return;
    let live = true;
    getArchiveField(persona)
      .then((data) => {
        fieldCache = { key: personaKey, data };
        if (live) setState({ key: personaKey, gen: dataGen, data });
      })
      .catch(() => {
        // Quiet: see above.
      });
    return () => {
      live = false;
    };
  }, [persona, personaKey, dataGen, state]);

  // ── The model: filter → buckets → columns → units → the offset table ──
  const piles = useMemo(
    () =>
      state?.data.piles.filter(
        (p) => archiveCategory === null || p.category === archiveCategory,
      ) ?? [],
    [state, archiveCategory],
  );
  // The records sit OUTSIDE the category grammar — a category filter is a
  // question about cases, and the record piles leave with the other columns.
  const records = useMemo(
    () => (archiveCategory === null ? (state?.data.records ?? []) : []),
    [state, archiveCategory],
  );
  const today = useMemo(() => localTodayIso(), []);
  const columns = useMemo(() => archiveColumns(piles, records), [piles, records]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** The piles' DOM escape hatch. drei's Html portals mount INSIDE the world
   *  canvas's container by default — a z-0 sibling BELOW this pane, whose
   *  box swallows every hit before it reaches a pile (the e2e click failure
   *  that proved it). Mounting the units' DOM into THIS div — a child of the
   *  pane, same box as the canvas — puts the piles back in hit range. The
   *  chain stays pointer-events-none except the units' own inner layer
   *  (Html's `pointerEvents` prop), so the empty field lets every gesture
   *  fall through to the canvas exactly as before. */
  const portalRef = useRef<HTMLDivElement | null>(null);
  const [fieldSize, setFieldSize] = useState({ w: 0, h: 0 });
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

  const singleColumn = fieldSize.w < 768 || columns.length <= 1;
  const geo = archiveGeometry(fieldSize.w || 1280, Math.max(columns.length, 1));
  const units = useMemo(
    () =>
      buildArchiveUnits(
        buildBuckets(piles, today, records),
        columns,
        geo,
        singleColumn,
      ),
    [piles, today, records, columns, geo, singleColumn],
  );
  const layout = useMemo(
    () =>
      buildOffsets(
        units.length,
        (i) => units[i].height,
        singleColumn ? geo.pileUnitH || 480 : geo.rowH || 340,
      ),
    [units, singleColumn, geo],
  );
  const insetTop = archiveInsetTop(fieldSize.w || 1280);
  const insetBottom = composerClearance + 24;
  const minOffset = minOffsetFor(false, insetTop);
  const maxOffset = maxOffsetFor(
    layout.total,
    fieldSize.h || 800,
    minOffset,
    insetBottom,
  );

  // First land: the top of the field is NOW, parked clear of the top chrome.
  // The rig persists across mounts (the shell's ref), so this runs exactly
  // once per session — genAt 0 is the never-initialized marker.
  useEffect(() => {
    if (units.length === 0 || rig.current.genAt !== 0) return;
    rig.current.target = minOffset;
    rig.current.current = minOffset;
    rig.current.genAt = performance.now();
  }, [units.length, minOffset, rig]);

  // A filter or a data refresh can shrink the field out from under the
  // scroll — pull the rig back inside the new range (a jump, not a drift:
  // the field re-deals on the same beat).
  useEffect(() => {
    rig.current.target = THREE.MathUtils.clamp(
      rig.current.target,
      minOffset,
      maxOffset,
    );
    rig.current.current = THREE.MathUtils.clamp(
      rig.current.current,
      minOffset,
      maxOffset,
    );
  }, [minOffset, maxOffset, rig]);

  // The filter change re-deals: remounting the units' DOM replays the
  // entrance stagger. (Only the key's prefix changes; the units are stable.)
  const [dealGen, setDealGen] = useState(0);
  const lastFilterRef = useRef(archiveCategory);
  useEffect(() => {
    if (lastFilterRef.current === archiveCategory) return;
    lastFilterRef.current = archiveCategory;
    setDealGen((g) => g + 1);
  }, [archiveCategory]);

  // ── Gestures: wheel scrolls, one finger drags, the keyboard walks. All
  //    window-bound (see the module header), all chrome-gated, all writing
  //    the rig's TARGET — the frame loop owns the easing and the clamps. ──
  const boundsRef = useRef({ min: 0, max: 0 });
  boundsRef.current.min = minOffset;
  boundsRef.current.max = maxOffset;
  /** Stamp of the last touch drag's end — openPile ignores the click a drag
   *  tails into (the cover is a button; see the pointer gesture's `up`). */
  const lastDragEndRef = useRef(0);
  const gesturesLive = units.length > 0 && panelMode === "pill";

  useEffect(() => {
    if (!gesturesLive) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(CHROME_SELECTOR)) return;
      const b = boundsRef.current;
      rig.current.target = elasticAdd(rig.current.target, e.deltaY, b.min, b.max);
      rig.current.releaseAt = performance.now() + RELEASE_IDLE_MS;
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [gesturesLive, rig]);

  useEffect(() => {
    if (!gesturesLive) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragMoved = false;
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(CHROME_SELECTOR)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      rig.current.releaseAt = 0;
      dragMoved = false;
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 1) return;
      const b = boundsRef.current;
      rig.current.target = elasticAdd(
        rig.current.target,
        -(e.clientY - prev.y),
        b.min,
        b.max,
      );
      rig.current.releaseAt = performance.now() + RELEASE_IDLE_MS;
      dragMoved = true;
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && dragMoved) {
        rig.current.releaseAt = performance.now() + RELEASE_IDLE_MS;
        dragMoved = false;
        // The pile's cover is a button: a touch drag that ENDS on the pile
        // still produces a click. Stamp the drag's end so openPile can tell
        // a tap from a scroll's tail.
        lastDragEndRef.current = performance.now();
      }
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gesturesLive, rig]);

  useEffect(() => {
    if (!gesturesLive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) {
        return;
      }
      if (target?.closest?.(CHROME_SELECTOR)) return;
      const viewH = fieldSize.h || 800;
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
          next = boundsRef.current.min;
          break;
        case "End":
          next = boundsRef.current.max;
          break;
        default:
          return;
      }
      e.preventDefault();
      rig.current.target = THREE.MathUtils.clamp(
        next,
        boundsRef.current.min,
        boundsRef.current.max,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gesturesLive, fieldSize.h, rig]);

  const openPile = useCallback(
    (ref: string) => {
      // A scroll gesture's tail click is not an open.
      if (performance.now() - lastDragEndRef.current < 250) return;
      openDesk(ref);
    },
    [openDesk],
  );

  // ── The scene registration — the desk's handshake, unchanged. The empty
  //    field registers NOTHING (there is no scene), exactly like the card
  //    field's empty state. ──
  const dark = (useTheme().resolvedTheme ?? "dark") !== "light";
  useWorldScene(
    "field",
    units.length === 0 ? null : (
      <ArchiveScene
        units={units}
        tops={layout.tops}
        total={layout.total}
        geo={geo}
        columns={columns}
        singleColumn={singleColumn}
        fieldW={fieldSize.w || 1280}
        rig={rig}
        portalRef={portalRef}
        reducedMotion={reducedMotion}
        exiting={exiting}
        instant={instantRef.current}
        dealGen={dealGen}
        dark={dark}
        insetTop={insetTop}
        insetBottom={insetBottom}
        pileTexts={pileTexts}
        recordTexts={recordTexts}
        bucketLabel={bucketLabel}
        onOpenPile={openPile}
      />
    ),
  );

  return (
    <div
      ref={wrapRef}
      data-archive-field
      // The wrapper is the field's whole DOM presence of its own: the piles
      // render through the canvas's Html portals (see the module header).
      // pointer-events-none is LOAD-BEARING: the pane (z-10) stacks above
      // the world canvas (z-0), so a hit-testable wrapper would swallow
      // every click aimed at a pile. Every gesture here is window-bound —
      // the wrapper itself never needs a hit.
      className="pointer-events-none relative h-full w-full touch-none outline-none"
      role="region"
      aria-label={t("fieldLabel")}
    >
      {/* The units' DOM lands HERE (drei Html `portal`), a pane-side overlay
          with the canvas's own box — see portalRef above. */}
      <div
        ref={portalRef}
        data-archive-portal
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      {/* The empty archive — the quiet line the empty desk used to carry,
          wording and all (the dispatch's ruling: reuse, never invent).
          Empty means BOTH nothing written and nothing said. */}
      {state !== null && piles.length === 0 && records.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-60 px-6 text-center text-sm leading-relaxed text-muted-foreground/70">
            {tLibrary("empty")}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── The scene: the camera, the tabletop, and the visible units ─────────────

function ArchiveScene({
  units,
  tops,
  total,
  geo,
  columns,
  singleColumn,
  fieldW,
  rig,
  portalRef,
  reducedMotion,
  exiting,
  instant,
  dealGen,
  dark,
  insetTop,
  insetBottom,
  pileTexts,
  recordTexts,
  bucketLabel,
  onOpenPile,
}: {
  units: ArchiveUnit[];
  tops: readonly number[];
  total: number;
  geo: ReturnType<typeof archiveGeometry>;
  columns: ReturnType<typeof archiveColumns>;
  singleColumn: boolean;
  fieldW: number;
  rig: MutableRefObject<FieldRig>;
  /** The pane-side mount for the units' DOM — see the field's portalRef. */
  portalRef: MutableRefObject<HTMLDivElement | null>;
  reducedMotion: boolean;
  exiting: boolean;
  instant: boolean;
  dealGen: number;
  dark: boolean;
  insetTop: number;
  insetBottom: number;
  pileTexts: ArchivePileTexts;
  recordTexts: RecordPileTexts;
  bucketLabel: (bucket: ArchiveBucket) => string;
  onOpenPile: (ref: string) => void;
}) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);
  const groupRef = useRef<THREE.Group>(null);

  // The clip planes follow the viewport because the camera DISTANCE does —
  // the same correction the desk and the card field apply, before paint.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const { near, far } = clipPlanesFor(size.height);
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, size.height]);

  // The tabletop the piles rest on — the desk's own plane recipe, so the
  // field and the reader share one surface and the world dissolve between
  // them has something continuous to fade through.
  const table = useMemo(() => {
    const camZ = camZFor(size.height);
    const d = camZ * 0.22;
    const grow = ((camZ + d) / camZ) * 1.12;
    return { d, w: size.width * grow, h: size.height * grow };
  }, [size.width, size.height]);

  // The visible range is STATE (drives which units mount), mirrored in a ref
  // so the frame loop compares without a stale closure — the card field's
  // own arrangement.
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const rangeRef = useRef<[number, number]>([0, -1]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const rigNow = rig.current;
    const minOffset = minOffsetFor(false, insetTop);
    const max = maxOffsetFor(total, size.height, minOffset, insetBottom);

    // The band's release: the hand has gone quiet, so a held overscroll
    // eases home; inside the range this is a no-op (field-snap.ts).
    if (rigNow.releaseAt > 0 && performance.now() >= rigNow.releaseAt) {
      rigNow.releaseAt = 0;
      rigNow.target = THREE.MathUtils.clamp(rigNow.target, minOffset, max);
    }
    rigNow.target = THREE.MathUtils.clamp(
      rigNow.target,
      minOffset - RUBBER_BAND_PX,
      max + RUBBER_BAND_PX,
    );

    if (reducedMotion) {
      rigNow.current = rigNow.target;
    } else {
      rigNow.current +=
        (rigNow.target - rigNow.current) * Math.min(1, 1 - Math.exp(-dt * 9));
      if (Math.abs(rigNow.target - rigNow.current) < 0.05) {
        rigNow.current = rigNow.target;
      }
    }

    // The camera: dead-on and parallel, never a turn (the card field's
    // measured ruling) — the scroll drift is VERTICAL ONLY, keyed to the
    // reader's progress through the field.
    const camZ = camZFor(size.height);
    if (!reducedMotion) {
      const p = progressFor(rigNow.current, minOffset, max);
      const cy = (p - 0.5) * 2 * 0.14 * worldScaleFor(size.height);
      camera.position.set(0, cy, camZ);
      camera.lookAt(0, cy, 0);
    } else {
      camera.position.set(0, 0, camZ);
      camera.lookAt(0, 0, 0);
    }

    // The content plane: content px 0 (the first unit's top) sits at the
    // viewport's top edge when the scroll is 0 — one moving group, the
    // units parked at their fixed offsets inside it.
    const group = groupRef.current;
    if (group) group.position.y = size.height / 2 + rigNow.current;

    // The ONE virtualization rule, shared with the card field.
    const margin = 320;
    const fallback = singleColumn ? geo.pileUnitH || 480 : geo.rowH || 340;
    const next = visibleRangeFor(
      tops,
      units.length,
      rigNow.current,
      size.height,
      margin,
      fallback,
    );
    const first = next[0] ?? 0;
    const last = next[next.length - 1] ?? -1;
    if (first !== rangeRef.current[0] || last !== rangeRef.current[1]) {
      rangeRef.current = [first, last];
      setRange([first, last]);
    }
  });

  const [first, last] = range;
  const enter = !instant && !reducedMotion;

  return (
    <>
      {/* The house light — the desk's own rig, upper-left. */}
      <ambientLight intensity={dark ? 0.55 : 0.75} />
      <directionalLight
        position={[-size.width * 0.3, size.height * 0.45, camZFor(size.height) * 0.6]}
        intensity={dark ? 1.1 : 0.9}
      />
      <mesh position={[0, 0, -table.d]}>
        <planeGeometry args={[table.w, table.h]} />
        <meshStandardMaterial
          color={dark ? 0x23242b : 0xd8dae3}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
      <group ref={groupRef}>
        {units.slice(first, last + 1).map((unit, vi) => {
          const index = first + vi;
          const centerY = -((tops[index] ?? 0) + unit.height / 2);
          return (
            <group key={unit.key} position={[0, centerY, 0]}>
              {/*
                * The archive's z range sits BELOW the floating chrome (the
                * world gate is z-20, the library z-40): the field fills the
                * pane and its piles pass UNDER the controls — the card
                * field's own stacking rule. The `portal` mounts the unit DOM
                * into the pane-side div (the field's portalRef) instead of
                * the canvas's z-0 container — same box, but a descendant of
                * the pane, so the piles are clickable at all.
                */}
              <Html
                transform
                center
                distanceFactor={400}
                zIndexRange={[19, 10]}
                // drei's type wants a non-null current; the div mounts with
                // the field's own DOM, before the scene's first frame.
                portal={portalRef as unknown as RefObject<HTMLElement>}
                pointerEvents="auto"
              >
                <ArchiveUnitView
                  unit={unit}
                  geo={geo}
                  columns={columns}
                  fieldW={fieldW}
                  enter={enter}
                  delayMs={Math.min(vi * ENTER_STAGGER_MS, ENTER_STAGGER_CAP_MS)}
                  exiting={exiting}
                  dealGen={dealGen}
                  pileTexts={pileTexts}
                  recordTexts={recordTexts}
                  bucketLabel={bucketLabel}
                  onOpenPile={onOpenPile}
                />
              </Html>
            </group>
          );
        })}
      </group>
    </>
  );
}

// ─── One unit's DOM (inside its Html portal) ────────────────────────────────

function ArchiveUnitView({
  unit,
  geo,
  columns,
  fieldW,
  enter,
  delayMs,
  exiting,
  dealGen,
  pileTexts,
  recordTexts,
  bucketLabel,
  onOpenPile,
}: {
  unit: ArchiveUnit;
  geo: ReturnType<typeof archiveGeometry>;
  columns: ReturnType<typeof archiveColumns>;
  fieldW: number;
  enter: boolean;
  delayMs: number;
  exiting: boolean;
  dealGen: number;
  pileTexts: ArchivePileTexts;
  recordTexts: RecordPileTexts;
  bucketLabel: (bucket: ArchiveBucket) => string;
  onOpenPile: (ref: string) => void;
}) {
  const stateClass = `${enter ? " archive-unit--enter" : ""}${
    exiting ? " archive-unit--exiting" : ""
  }`;
  const unitStyle = {
    "--archive-field-w": `${fieldW}px`,
    "--archive-unit-h": `${unit.height}px`,
    "--archive-delay": `${delayMs}ms`,
    width: fieldW,
    height: unit.height,
  } as React.CSSProperties;

  if (unit.kind === "header") {
    return (
      <div
        className={`archive-unit archive-header${stateClass}`}
        style={
          {
            ...unitStyle,
            "--archive-grid-cols": `${geo.labelW}px repeat(${unit.columns.length}, 1fr)`,
          } as React.CSSProperties
        }
        aria-hidden="true"
      >
        <span />
        {unit.columns.map((c) => (
          <span key={c}>{pileTexts.columnLabel(c)}</span>
        ))}
      </div>
    );
  }

  if (unit.kind === "bucket") {
    return (
      <div
        className={`archive-unit archive-bucket${stateClass}`}
        style={unitStyle}
      >
        <span>{bucketLabel(unit.bucket)}</span>
      </div>
    );
  }

  if (unit.kind === "pile") {
    return (
      <div
        className={`archive-unit archive-pileunit${stateClass}`}
        style={unitStyle}
      >
        {unit.pile.kind === "record" ? (
          <RecordPileView
            pile={unit.pile}
            bucketLabel={bucketLabel(unit.bucket)}
            width={geo.pileW}
            height={geo.pileH}
            texts={recordTexts}
            onOpen={onOpenPile}
          />
        ) : (
          <ArchivePileView
            pile={unit.pile}
            width={geo.pileW}
            height={geo.pileH}
            texts={pileTexts}
            onOpen={onOpenPile}
          />
        )}
      </div>
    );
  }

  // A desktop bucket row: the label, then the cells on their column tracks.
  return (
    <div
      className={`archive-unit archive-row${stateClass}`}
      style={
        {
          ...unitStyle,
          "--archive-grid-cols": `${geo.labelW}px repeat(${columns.length}, 1fr)`,
        } as React.CSSProperties
      }
    >
      <p className="archive-row-label">{bucketLabel(unit.bucket)}</p>
      {unit.cells.map((cell) => (
        <div
          key={`${dealGen}:${cell.column}`}
          className="archive-cell"
          style={{ "--archive-col": cell.column + 2 } as React.CSSProperties}
        >
          {cell.piles.map((pile) =>
            pile.kind === "record" ? (
              <RecordPileView
                key={pile.ref}
                pile={pile}
                bucketLabel={bucketLabel(unit.bucket)}
                width={geo.pileW}
                height={geo.pileH}
                texts={recordTexts}
                onOpen={onOpenPile}
              />
            ) : (
              <ArchivePileView
                key={pile.ref}
                pile={pile}
                width={geo.pileW}
                height={geo.pileH}
                texts={pileTexts}
                onOpen={onOpenPile}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}
