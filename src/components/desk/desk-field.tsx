"use client";

/**
 * The paged document desk (v0.24) — one tabletop plane, one light, and a
 * STACK of A4 sheets in the EXISTING field world. The desk is the card
 * field's mutually exclusive pane mate: while `deskDoc` is set, CardField
 * is unmounted and this component registers `DeskScene` into the SAME field
 * world slot (`useWorldScene("field", …)`). The render chain is untouched —
 * the field renderer draws whatever subtree the slot holds.
 *
 * THE SLOT HANDSHAKE. Slot registration is last-write-wins with an
 * unconditional null cleanup (world-slot.tsx), so two owners may never be
 * mounted at once. That sequencing is NOT done here: app-shell mounts this
 * component only after the card field's exit completed (and holds the card
 * field's return until this one's exit completes), so by the time DeskScene
 * registers, the slot is already free.
 *
 * THE DESK OWNS THE CAMERA. Per-frame camera writes are the slot owner's
 * job (FieldScene does the same for the cards); the shell centres the paper
 * in the full pane (v0.24: the library is a floating control, so the
 * reader's `camXOffset` is 0 — there is no column to clear).
 *
 * PAGINATION (v0.24). One sheet = one PAGE of the document. The markdown
 * flows through CSS multi-column layout inside a fixed-height 版心 (one
 * column per page; `column-fill: auto` packs each column to the page
 * height) and five paper SLOTS carry the current, next, and previous pages
 * (the other two are blank paper, their edges peeking — the card field's
 * stacked-papers look). A turn SHUFFLES (the user's ruling — no rotation):
 * the top sheet lifts off, travels, and is put at the very back; the deck
 * closes rank beneath it; going back is the same gesture in reverse. Pure
 * CSS transform animation, only the traveler ever moves. Measurement is
 * browser-native (no JS line measuring): the natural height of a hidden
 * single-column copy gives the page-count lower bound; the exact count
 * reads off the column overflow.
 *
 * I18N ACROSS THE PORTAL. drei's `<Html>` mounts the paper in the Canvas's
 * own React root. The desk's few UI strings arrive as PROPS (the
 * FrameCardTexts pattern); the markdown body keeps its real components
 * (CodeBlock and friends call hooks), so it is re-wrapped in
 * `NextIntlClientProvider` — the conversation field's BillboardBlock
 * pattern.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { usePresence } from "motion/react";
import { useTheme } from "@teispace/next-themes";
import {
  NextIntlClientProvider,
  useLocale,
  useMessages,
} from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useShell } from "@/components/shell/shell-provider";
import { useWorldScene } from "@/components/timeline-3d/world-slot";
import { camZFor, clipPlanesFor } from "@/lib/timeline3d/camera";
import { ISLAND_BAR, ISLAND_CONTROL } from "@/components/layout/island";
import {
  getCaseDoc,
  type CaseDocContent,
} from "@/lib/episodic/actions";
import { MarkdownRenderer } from "@/components/chat/markdown";
import {
  clampPage,
  TURN_MS,
  pageCountLowerBound,
  pageForShellSlot,
  deskPaperModel,
  SHELL_COUNT,
  shellOffsetForSlot,
  type DeskPaperModel,
} from "./desk-model";
import "./desk.css";

/** The desk's UI strings, injected from OUTSIDE the Canvas (next-intl
 *  context does not cross the Html portal — see the module header). */
export interface DeskTexts {
  /** aria-label of the desk region — carries the Escape affordance. */
  regionLabel: string;
  /** The body line while the document is in flight. */
  loading: string;
  /** The dead-link paper's heading. */
  notFoundHeading: string;
  /** The dead-link paper's body line. */
  notFoundBody(ref: string): string;
  /** The footer's category name (the shelf's translated category keys). */
  categoryName(category: string): string;
  /** The footer's centred folio, the `· 1 ·` form. */
  page(n: number): string;
  /** aria-label of the page-control's previous-page button. */
  prevPage: string;
  /** aria-label of the page-control's next-page button. */
  nextPage: string;
  /** The page control's readout, `{current} / {total}`. */
  pagePosition(current: number, total: number): string;
}

/** The entrance/exit beat, seconds — the pane swap's own 300 ms. */
const DESK_BEAT_S = 0.3;

/** The measurement loop's growth budget: one column per pass from the lower
 *  bound, so the first pass without spill IS the minimum page count. A doc
 *  needs more passes only when that many break-avoid blocks force early
 *  column ends; beyond the cap we accept the (wider) plan — never a clip. */
const MAX_MEASURE_PASSES = 8;

/** Wheel paging: accumulated deltaY per turn, and the quiet window that
 *  resets the accumulator (trackpad momentum decays — without the reset a
 *  slow drift would page forever). */
const WHEEL_THRESHOLD_PX = 120;
const WHEEL_QUIET_MS = 150;

/** Touch/pen swipe: horizontal distance that turns a page, and the
 *  dominance the horizontal component needs over the vertical one. */
const SWIPE_THRESHOLD_PX = 56;

export function DeskField({
  docRef,
  camXOffset,
  reducedMotion,
  texts,
}: {
  /** The open document's reference (`deskDoc` — never null here: app-shell
   *  mounts the desk only when a ref is set). */
  docRef: string;
  /** The field camera's half-band x shift — 0 in the reader (the library
   *  control floats; there is no column to clear). The desk still writes
   *  its own camera, offset included. */
  camXOffset: number;
  reducedMotion: boolean;
  texts: DeskTexts;
}) {
  const { closeDesk } = useShell();
  const locale = useLocale();
  const messages = useMessages();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  // Presence rides the pane's AnimatePresence: false while this branch plays
  // its exit — the scene gets it as a PROP because presence context, like
  // every context, stops at the Canvas root.
  const [isPresent] = usePresence();

  // The document arrives lazily, one server-action round trip per open —
  // the shelf's own rhythm. `undefined` = in flight; null = dead link (the
  // not-found paper); a throw surfaces as the same not-found paper.
  const [doc, setDoc] = useState<CaseDocContent | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    getCaseDoc(docRef)
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => {
        if (live) setDoc(null);
      });
    return () => {
      live = false;
    };
  }, [docRef]);
  const loading = doc === undefined;
  const model = useMemo(
    () => deskPaperModel(docRef, doc ?? null),
    [docRef, doc],
  );

  // ── PAGING (v0.24) ────────────────────────────────────────────────────
  // The current page is ephemeral reading state: it lives HERE (not in the
  // shell provider — deskDoc stays the desk's only shell-level state) and
  // resets on a new document (render-phase reset below), on close/re-open
  // (the unmount discards it), and clamps when a re-pagination shrinks the
  // page count out from under the reader.
  const ready = !loading && model.markdown !== null;

  const [page, setPage] = useState(1);
  // The turn (a shuffle, not a flip): which direction is in flight and
  // which shell is traveling. The slot ORDER rotates at turn START (every
  // sheet's resting pose is recomputed then; the ones that stay put hold
  // still for the leave and close rank in the landing beat — see desk.css).
  // The page number bumps at SETTLE: the traveling sheet already shows the
  // page its new slot derives, and every other visible surface is unchanged
  // — a settle can paint no flash.
  const [turn, setTurn] = useState<{
    dir: "next" | "prev";
    traveler: number;
  } | null>(null);
  const [order, setOrder] = useState<number[]>(() =>
    Array.from({ length: SHELL_COUNT }, (_, i) => i),
  );
  const [pageBox, setPageBox] = useState({ w: 0, h: 0 });
  const [naturalH, setNaturalH] = useState(0);
  const [plan, setPlan] = useState({ columns: 1, passes: 0 });

  const pagesRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

  // Callback refs, not plain refs: the scene's portal DOM (inside the
  // dynamically-loaded canvas chunk) can establish itself in a later commit
  // than any of the field's effects — a missed attach must not leave the
  // measurement state at zero until some unrelated re-render. The callback
  // measures at attach time; the effects below re-measure on the content
  // and width changes. All setters are equality-guarded, so a re-attach
  // with the same numbers re-renders nothing.
  const attachMeasureRef = useCallback((el: HTMLDivElement | null) => {
    measureRef.current = el;
    if (el) {
      const h = el.scrollHeight;
      setNaturalH((prev) => (prev === h ? prev : h));
    }
  }, []);
  const attachBoxRef = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    if (el) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // A zero box means the node is not in a laid-out state (detached or
      // its shell has gone blank at a deck edge) — the previous measure is
      // still the truth. Accepting the zero collapsed the deck to one
      // sheet and let the clamp hijack the page mid-turn (the flicker).
      if (w > 0 && h > 0) {
        setPageBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    }
  }, []);

  const lowerBound = pageCountLowerBound(naturalH, pageBox.h);
  const total = plan.columns;
  const totalRef = useRef(total);
  totalRef.current = total;
  const turnRef = useRef(turn);
  turnRef.current = turn;
  // Settle is idempotent by a synchronous flag, not by state: the landing
  // reports through animationend AND a timeout backstop — if the main
  // thread is busy when the backstop fires, the state guard alone would
  // still be stale and the page would bump twice (observed: 1 → 2 → 3).
  const settledRef = useRef(true);

  // A new document restarts at page 1 with no turn in flight — the render-
  // phase reset (no frame flashes the old document's last page).
  const lastDocRef = useRef(docRef);
  if (lastDocRef.current !== docRef) {
    lastDocRef.current = docRef;
    setPage(1);
    setTurn(null);
    settledRef.current = true;
  }

  // The flow's natural height from the hidden single-column measurer. The
  // attach callback captures the first measure; this effect re-measures on
  // content and width changes (the callback does not re-fire when only the
  // element's content changes).
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el || !ready) return;
    const h = el.scrollHeight;
    setNaturalH((prev) => (prev === h ? prev : h));
  }, [ready, model.markdown, pageBox.w]);

  // Re-measure when the page box changes (resize) or the webfonts land —
  // either can move the natural height after the first measure.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    document.fonts?.ready.then(() => {
      const el = measureRef.current;
      if (live && el) {
        const h = el.scrollHeight;
        setNaturalH((prev) => (prev === h ? prev : h));
      }
    });
    return () => {
      live = false;
    };
  }, [ready, pageBox.w, model.markdown]);

  // A new lower bound re-plans the container width; the growth loop below
  // then verifies it against the real layout. INERT WHILE A TURN IS IN
  // FLIGHT (see the loop) — a mid-gesture re-plan is the flicker.
  useEffect(() => {
    if (turn !== null) return;
    setPlan({ columns: lowerBound, passes: 0 });
  }, [lowerBound, turn]);

  // The measurement loop — the page count IS the column count, and the
  // runtime tells it for free: with `column-fill: auto` the browser
  // fragments the whole flow into page-height columns on demand, letting
  // excess columns overflow the box horizontally (verified in the running
  // app: a 1-page-wide box reported scrollWidth = 4 × pageW for a 4-page
  // document). So the count is scrollWidth / pageW, full stop. A vertical
  // spill NEVER grows the count: a block taller than one page (a long
  // break-avoided item at print scale) overflows its column permanently,
  // and reading that as "needs another column" grew the plan +8 deep in
  // the trace (a taller column is a pagination imperfection prints
  // tolerate, not a missing page). INERT WHILE A TURN IS IN FLIGHT: every
  // input is frozen then, and re-planning mid-gesture collapses the deck
  // for a frame — the reader-visible flicker.
  useLayoutEffect(() => {
    const el = pagesRef.current;
    if (!el || !ready || pageBox.w <= 0 || turn !== null) return;
    const actual = Math.max(1, Math.round(el.scrollWidth / pageBox.w));
    if (actual > plan.columns && plan.passes < MAX_MEASURE_PASSES) {
      setPlan({ columns: actual, passes: plan.passes + 1 });
    }
  }, [ready, model.markdown, pageBox, plan, turn]);

  // The pane resizes (window, dvh shifts): the pagebox is re-measured and
  // the lower-bound effect re-plans — rAF-debounced so a drag's event storm
  // collapses into one re-pagination. Re-subscribes when the single-sheet ↔
  // stack swap replaces the pagebox element (an observer on a detached node
  // would silently stop watching) AND when the top slot's occupant changes
  // (every turn) — the observer must follow the live pagebox, never a shell
  // that a later edge blanks.
  const stacked = ready && plan.columns > 1;
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        // The observed node can outlive its seat in the deck (its shell
        // goes blank at an edge, or the single-sheet form replaces the
        // stack) — a detached node measures 0×0 and must not rewrite the
        // page box (see attachBoxRef; same flicker, same guard).
        if (w > 0 && h > 0) {
          setPageBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        }
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [stacked, order, boxRef]);

  // Re-pagination can only shrink the count under a resize — clamp, never
  // throw the reader off the document. INERT WHILE A TURN IS IN FLIGHT: the
  // turn owns the page number between start and settle, and a transient
  // count must never hijack it (observed: a one-frame total=1 clamped the
  // reader back to page 1 mid-turn — the deck collapsed to a single page-1
  // sheet and re-expanded, repeatedly, until the count recovered).
  useEffect(() => {
    if (turn !== null) return;
    setPage((p) => clampPage(p, total));
  }, [total, turn]);

  const settleTurn = useCallback(() => {
    const active = turnRef.current;
    if (!active || settledRef.current) return;
    settledRef.current = true;
    setPage((p) =>
      clampPage(p + (active.dir === "next" ? 1 : -1), totalRef.current),
    );
    setTurn(null);
  }, []);

  // The traveler's landing normally reports through animationend; the
  // timeout is the backstop for the event that never arrives (unmounted
  // mid-beat included) — the turn must never stay half-committed.
  useEffect(() => {
    if (!turn) return;
    const t = setTimeout(settleTurn, TURN_MS + 120);
    return () => clearTimeout(t);
  }, [turn, settleTurn]);

  const turnPage = useCallback(
    (dir: "next" | "prev") => {
      if (turn !== null || !ready) return;
      const target = page + (dir === "next" ? 1 : -1);
      if (target < 1 || target > total) return;
      if (reducedMotion) {
        // No motion: the sheets do not travel, the content swaps in place
        // under a quiet fade (the CSS replays it via the remount).
        setPage(target);
        return;
      }
      // The shuffle: the top sheet (or the bottom, going back) is taken out
      // and put at the very back. The slot order rotates NOW — the resting
      // poses update immediately, the staying sheets hold still for the
      // leave (their close-rank beat is delayed into the landing), and the
      // traveler animates from its old seat to its new one.
      setOrder((prev) =>
        dir === "next"
          ? [...prev.slice(1), prev[0]]
          : [prev[prev.length - 1], ...prev.slice(0, -1)],
      );
      settledRef.current = false;
      setTurn({ dir, traveler: dir === "next" ? order[0] : order[SHELL_COUNT - 1] });
    },
    [turn, ready, page, total, reducedMotion, order],
  );
  const turnPageRef = useRef(turnPage);
  turnPageRef.current = turnPage;

  // The wheel pages the paper — the 版心 no longer scrolls, so the gesture
  // is free. Passive (no hijack): the accumulator turns a page at the
  // threshold and the quiet window eats trackpad momentum.
  useEffect(() => {
    if (!ready || total <= 1) return;
    let acc = 0;
    let lastEvent = 0;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.("[data-desk-stack]")) {
        acc = 0;
        return;
      }
      const now = performance.now();
      if (now - lastEvent > WHEEL_QUIET_MS) acc = 0;
      lastEvent = now;
      if (turnRef.current) return;
      acc += e.deltaY;
      if (acc >= WHEEL_THRESHOLD_PX) {
        acc = 0;
        turnPageRef.current("next");
      } else if (acc <= -WHEEL_THRESHOLD_PX) {
        acc = 0;
        turnPageRef.current("prev");
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [ready, total]);

  // The scene registration — unchanged handshake, new paging bundle.
  useWorldScene(
    "field",
    <DeskScene
      model={model}
      docRef={docRef}
      loading={loading}
      texts={texts}
      locale={locale}
      messages={messages}
      dark={dark}
      camXOffset={camXOffset}
      reducedMotion={reducedMotion}
      exiting={!isPresent}
      paging={{
        ready,
        markdown: model.markdown,
        title: model.title,
        page,
        total,
        turn,
        order,
        planColumns: plan.columns,
        pageBox,
        pagesRef,
        attachBoxRef,
        attachMeasureRef,
        onTravelEnd: settleTurn,
        onTurn: turnPage,
      }}
    />,
  );

  // Escape puts the document back; the arrows turn its pages. Two bindings
  // because the paper lives in the canvas's Html portal — OUTSIDE this
  // wrapper's DOM subtree — so a keydown with focus inside the paper never
  // reaches the wrapper. The window backstop defers to any inner handler
  // that already claimed the key (defaultPrevented).
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDesk();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        turnPage("next");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        turnPage("prev");
      }
    },
    [closeDesk, turnPage],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") closeDesk();
      else if (e.key === "ArrowRight") turnPageRef.current("next");
      else if (e.key === "ArrowLeft") turnPageRef.current("prev");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDesk]);

  return (
    <>
      <div
        ref={wrapRef}
        data-desk-field
        // Focusable so the Escape/arrows binding has somewhere to listen —
        // the card field's wrapper pattern. The desk's whole DOM presence is
        // this region; the paper arrives back over it as the Html portal.
        tabIndex={0}
        role="region"
        aria-label={texts.regionLabel}
        onKeyDown={onKeyDown}
        className="relative h-full w-full outline-none"
      />
      {/* THE PAGE CONTROL — floating with the app's other chrome. The
          bottom-left corner itself is the world gate's seat (z-20 at the pane
          root), so the control stacks one bar-height above it (bottom-14) —
          both stay clickable. It also lives OUTSIDE the desk's pane branch,
          which the pane caps at z-10: under the gate even a z-50 control
          would lose every hit test, so it renders through a body-level
          portal (page state stays here, where it is owned). */}
      {ready && total > 1 &&
        createPortal(
          <div
            data-page-controls
            className="pointer-events-none fixed bottom-14 left-4 z-50 sm:left-6"
          >
            <div className={`${ISLAND_BAR} pointer-events-auto gap-0.5 px-1`}>
              <button
                type="button"
                data-page-prev
                aria-label={texts.prevPage}
                disabled={turn !== null || page <= 1}
                onClick={() => turnPage("prev")}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <ChevronLeft className="size-4 shrink-0" />
              </button>
              <span
                data-page-readout
                aria-live="polite"
                className="min-w-10 px-1 text-center font-mono text-xs tabular-nums text-muted-foreground"
              >
                {texts.pagePosition(page, total)}
              </span>
              <button
                type="button"
                data-page-next
                aria-label={texts.nextPage}
                disabled={turn !== null || page >= total}
                onClick={() => turnPage("next")}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <ChevronRight className="size-4 shrink-0" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Everything the scene needs to render the paged stack. Grouped so the
 *  DeskScene props stay readable; every field is a primitive or a ref. */
interface PagingProps {
  ready: boolean;
  markdown: string | null;
  title: string;
  page: number;
  total: number;
  /** The shuffle in flight, if any: direction + the traveling shell's id. */
  turn: { dir: "next" | "prev"; traveler: number } | null;
  /** The deck: which shell occupies each slot, slot 0 = the visible top.
   *  Rotates at turn start; shells are keyed by id, not slot. */
  order: number[];
  planColumns: number;
  pageBox: { w: number; h: number };
  pagesRef: RefObject<HTMLDivElement | null>;
  attachBoxRef: (el: HTMLDivElement | null) => void;
  attachMeasureRef: (el: HTMLDivElement | null) => void;
  onTravelEnd: () => void;
  /** The page turn, owned by the field above — the swipe hands it a
   *  direction and the same gate as the buttons applies (turn state,
   *  bounds, reduced motion). */
  onTurn: (dir: "next" | "prev") => void;
}

function DeskScene({
  model,
  docRef,
  loading,
  texts,
  locale,
  messages,
  dark,
  camXOffset,
  reducedMotion,
  exiting,
  paging,
}: {
  model: DeskPaperModel;
  docRef: string;
  loading: boolean;
  texts: DeskTexts;
  locale: string;
  messages: ReturnType<typeof useMessages>;
  dark: boolean;
  camXOffset: number;
  reducedMotion: boolean;
  exiting: boolean;
  paging: PagingProps;
}) {
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera);

  // The clip planes follow the viewport because the camera DISTANCE does
  // (camera.ts) — the same correction FieldScene applies, before paint.
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const { near, far } = clipPlanesFor(size.height);
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }, [camera, size.height]);

  // The tabletop: one big plane behind the paper, sized to cover the view
  // at its depth (a plane d behind the focal plane renders camZ/(camZ+d)
  // of its size). Parallel to the sheet, never turned.
  const table = useMemo(() => {
    const camZ = camZFor(size.height);
    const d = camZ * 0.22;
    const grow = ((camZ + d) / camZ) * 1.12;
    return { d, w: size.width * grow, h: size.height * grow };
  }, [size.width, size.height]);

  const animRef = useRef({ t: 0 });
  const groupRef = useRef<THREE.Group>(null);
  const tableMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const stackRef = useRef<HTMLDivElement>(null);

  // THE SWAP RE-PLAYS THE PULL-OUT (v0.23): the reader stays mounted while
  // `docRef` changes (picking another document in the library), and the
  // entrance beat runs again for the new stack. The write happens during
  // render so no frame flashes the old stack with the new ref's loading
  // state (the ref write is idempotent).
  const lastDocRefRef = useRef(docRef);
  if (lastDocRefRef.current !== docRef) {
    lastDocRefRef.current = docRef;
    animRef.current.t = 0;
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const anim = animRef.current;
    // The pull-out (v0.22 §3): in, the paper rises from below the viewport
    // over the pane's own 300 ms; out, the same beat reversed. Reduced
    // motion keeps only the opacity leg.
    anim.t = THREE.MathUtils.clamp(
      anim.t + (exiting ? -dt : dt) / DESK_BEAT_S,
      0,
      1,
    );
    const eased = 1 - Math.pow(1 - anim.t, 3);

    // THE CAMERA IS THE DESK'S (see the module header): a parallel shift
    // centring the stack in the PANE (0 in the reader — no column). No
    // scroll drift, never a turn.
    const camZ = camZFor(size.height);
    camera.position.set(camXOffset, 0, camZ);
    camera.lookAt(camXOffset, 0, 0);

    const group = groupRef.current;
    if (group) {
      group.position.y = reducedMotion
        ? 0
        : (1 - eased) * -size.height * 0.6;
    }
    if (tableMatRef.current) tableMatRef.current.opacity = anim.t;
    const stack = stackRef.current;
    if (stack) stack.style.opacity = `${anim.t}`;
  });

  const {
    ready,
    markdown,
    title,
    page,
    total,
    turn,
    order,
    planColumns,
    pageBox,
    pagesRef,
    attachBoxRef,
    attachMeasureRef,
    onTravelEnd,
    onTurn,
  } = paging;

  // One shell when the document is not a stack at all: in flight, dead
  // link, or a single page (backingSheets(1) = 0 — a one-page document
  // wears no pile).
  const stacked = ready && total > 1;
  // The visible slots, top (0) to bottom (SHELL_COUNT-1), each holding its
  // occupant shell id. Shells render in slot order and paint by --sz, both
  // derived from the slot — a shell never moves except inside the two turn
  // animations.
  const slots = stacked
    ? Array.from({ length: SHELL_COUNT }, (_, i) => i)
    : [0];

  // The landing handshake: the traveler's animation reports here (the
  // close-rank beats end at the same instant); the page bump and the turn
  // state's retirement settle the new arrangement.
  const onStackAnimationEnd = useCallback(
    (e: ReactAnimationEvent) => {
      if (e.animationName === "desk-travel") onTravelEnd();
    },
    [onTravelEnd],
  );

  // The horizontal swipe: a page turn is a flick across the paper. Nothing
  // is preventDefaulted — there is no scroll to fight.
  const swipeRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const onStackPointerDown = useCallback((e: ReactPointerEvent) => {
    swipeRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }, []);
  const onStackPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      if (!start || start.id !== e.pointerId) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (
        Math.abs(dx) > SWIPE_THRESHOLD_PX &&
        Math.abs(dx) > 2 * Math.abs(dy)
      ) {
        onTurn(dx < 0 ? "next" : "prev");
      }
    },
    [onTurn],
  );
  const onStackPointerCancel = useCallback(() => {
    swipeRef.current = null;
  }, []);

  // The flow — one full copy of the document per content shell, translated
  // to the shell's page by --desk-page-i. MEMOIZED on the document alone:
  // a turn changes paging state every few hundred milliseconds, and without
  // this each turn would re-parse and re-layout all four markdown copies
  // (three shells + the measurer) before the animation could even start.
  const flow = useMemo(
    () =>
      ready && markdown !== null ? (
    <>
      <h1 className="desk-title">{title}</h1>
      {/* The body keeps its real components (CodeBlock's hooks included) —
          re-wrapped in intl context, the conversation field's
          BillboardBlock pattern. */}
      <NextIntlClientProvider messages={messages} locale={locale}>
        <MarkdownRenderer content={markdown} />
      </NextIntlClientProvider>
        </>
      ) : null,
    [ready, markdown, title, locale, messages],
  );

  return (
    <>
      {/* The one light: upper-left, where the house light lives (the CSS
          light field's 30%/22% default). Ambient keeps the plate readable
          in both themes. */}
      <ambientLight intensity={dark ? 0.55 : 0.75} />
      <directionalLight
        position={[-size.width * 0.3, size.height * 0.45, camZFor(size.height) * 0.6]}
        intensity={dark ? 1.1 : 0.9}
      />
      <mesh position={[0, 0, -table.d]}>
        <planeGeometry args={[table.w, table.h]} />
        <meshStandardMaterial
          ref={tableMatRef}
          // A tone step off the field's backdrop — the sheet separates by
          // its contact shadow, not by a bright slab. GL colours are hex
          // literals (the CSS tokens don't reach here), pinned to the
          // paper's cool hue family; both themes are an acceptance point.
          color={dark ? 0x23242b : 0xd8dae3}
          roughness={0.95}
          metalness={0}
          transparent
          opacity={0}
        />
      </mesh>
      <group ref={groupRef}>
        <Html
          transform
          center
          // 400 is drei's 1:1 reference at this camera (see row-group.tsx):
          // the paper's DOM px are world units, so print sizes stay honest.
          distanceFactor={400}
          zIndexRange={[30, 21]}
          pointerEvents="auto"
        >
          <div
            ref={stackRef}
            data-desk-stack
            data-locale={locale}
            className="desk-stack"
            onAnimationEnd={onStackAnimationEnd}
            onPointerDown={onStackPointerDown}
            onPointerUp={onStackPointerUp}
            onPointerCancel={onStackPointerCancel}
          >
            {slots.map((slot) => {
              const shellId = stacked ? order[slot] : 0;
              const offset = shellOffsetForSlot(slot);
              // The pages derive from the turn's TARGET page while a turn
              // is in flight: the traveling sheet keeps showing the page it
              // physically carries, the revealed sheet keeps the page it
              // already showed, and every change lands on covered slots —
              // so the settle repaints nothing.
              const effectivePage = clampPage(
                page + (turn ? (turn.dir === "next" ? 1 : -1) : 0),
                total,
              );
              const shellPage = stacked
                ? pageForShellSlot(effectivePage, total, slot, SHELL_COUNT)
                : 1;
              const isTop = slot === 0;
              const isTraveler = turn !== null && shellId === turn.traveler;
              // Where this shell sits at the END of the gesture: its new
              // slot's resting pose. The traveler animates from its old
              // seat (--from-*) to here; the staying sheets hold --from-*
              // until the landing beat, then close rank to here.
              const shellStyle = {
                "--sx": `${offset.x}px`,
                "--sy": `${offset.y}px`,
                "--sr": `${offset.r}deg`,
                "--sz": SHELL_COUNT - slot,
                ...(turn
                  ? isTraveler
                    ? {
                        "--from-x": `${shellOffsetForSlot(turn.dir === "next" ? 0 : SHELL_COUNT - 1).x}px`,
                        "--from-y": `${shellOffsetForSlot(turn.dir === "next" ? 0 : SHELL_COUNT - 1).y}px`,
                        "--from-r": `${shellOffsetForSlot(turn.dir === "next" ? 0 : SHELL_COUNT - 1).r}deg`,
                      }
                    : {
                        "--from-x": `${shellOffsetForSlot(turn.dir === "next" ? slot + 1 : slot - 1).x}px`,
                        "--from-y": `${shellOffsetForSlot(turn.dir === "next" ? slot + 1 : slot - 1).y}px`,
                        "--from-r": `${shellOffsetForSlot(turn.dir === "next" ? slot + 1 : slot - 1).r}deg`,
                      }
                  : null),
              } as CSSProperties;
              const boxStyle = {
                "--desk-page-h":
                  pageBox.h > 0 ? `${pageBox.h}px` : undefined,
              } as CSSProperties;
              const pagesStyle = {
                "--desk-pages-w":
                  pageBox.w > 0 ? `${planColumns * pageBox.w}px` : undefined,
                "--desk-page-w":
                  pageBox.w > 0 ? `${pageBox.w}px` : undefined,
                "--desk-page-i": (shellPage ?? 1) - 1,
              } as CSSProperties;
              return (
                <div
                  key={shellId}
                  data-desk-shell={slot}
                  className={`desk-shell${isTop ? " desk-shell--top" : ""}${
                    turn
                      ? isTraveler
                        ? ` desk-shell--travel-${turn.dir}`
                        : " desk-shell--close"
                      : ""
                  }`}
                  style={shellStyle}
                >
                  <div
                    className="desk-paper bg-paper bg-paper-grain-card shadow-paper-contact text-card-foreground"
                    data-locale={locale}
                  >
                    {shellPage === null ? (
                      // Blank paper: the stack's peek, nothing printed.
                      <div className="desk-face" aria-hidden="true" />
                    ) : (
                      <div className="desk-face">
                        <header className="desk-head flex items-baseline justify-between gap-8">
                          <span className="truncate">
                            {model.caseRef ?? model.title}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {model.date}
                          </span>
                        </header>

                        <div className="desk-bodywrap">
                          <div className="desk-body">
                            <div
                              className="desk-pagebox"
                              ref={isTop ? attachBoxRef : undefined}
                              style={boxStyle}
                            >
                              {ready ? (
                                <div
                                  className={`desk-pages${
                                    reducedMotion && isTop
                                      ? " desk-pages--fade"
                                      : ""
                                  }`}
                                  key={reducedMotion && isTop ? page : shellId}
                                  ref={isTop ? pagesRef : undefined}
                                  style={pagesStyle}
                                >
                                  <div className="desk-flow">{flow}</div>
                                </div>
                              ) : (
                                <div className="desk-pages">
                                  {loading ? (
                                    <p className="desk-note">
                                      {texts.loading}
                                    </p>
                                  ) : (
                                    <>
                                      <h1 className="desk-title">
                                        {texts.notFoundHeading}
                                      </h1>
                                      <p className="desk-note">
                                        {texts.notFoundBody(docRef)}
                                      </p>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <footer className="desk-foot flex items-baseline">
                          <span className="flex-1" />
                          <span className="tabular-nums">
                            {texts.page(shellPage)}
                          </span>
                          <span className="flex-1 truncate text-right">
                            {model.category
                              ? texts.categoryName(model.category)
                              : ""}
                          </span>
                        </footer>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* The single-column measurer: the same flow at natural height,
                invisible. Its scrollHeight feeds the page-count lower
                bound; the growth loop verifies it against the real
                columns. */}
            {ready && flow && (
              <div
                className="desk-measure"
                ref={attachMeasureRef}
                aria-hidden="true"
              >
                <div className="desk-flow">{flow}</div>
              </div>
            )}
          </div>
        </Html>
      </group>
    </>
  );
}
