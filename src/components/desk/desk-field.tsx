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
 * height) and a ring of five paper SHELLS carries the current, next, and
 * previous pages (the other two are blank paper, their edges peeking —
 * the card field's stacked-papers look). A turn flips the top sheet over
 * its centre line to the deck bottom (or the bottom sheet forward, going
 * back): pure CSS transform animation, blank paper back, the deck re-
 * cascades as the ring shifts. Measurement is browser-native (no JS line
 * measuring): the natural height of a hidden single-column copy gives the
 * page-count lower bound; a hidden-measure loop grows the column container
 * one column at a time while any content still spills.
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
  FLIP_MS,
  pageCountLowerBound,
  pageForShellDepth,
  deskPaperModel,
  recessIntensityFor,
  SHELL_COUNT,
  shellOffsetForDepth,
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
  const [flip, setFlip] = useState<"next" | "prev" | null>(null);
  // The deck ring: depth(i) = (i + shift) mod SHELL_COUNT. A "next" turn
  // shifts +1 (the top shell wraps to the bottom); "prev" shifts −1.
  const [shift, setShift] = useState(0);
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
      setPageBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    }
  }, []);

  const lowerBound = pageCountLowerBound(naturalH, pageBox.h);
  const total = plan.columns;
  const totalRef = useRef(total);
  totalRef.current = total;
  const flipRef = useRef(flip);
  flipRef.current = flip;

  // A new document restarts at page 1 with no flip in flight — the render-
  // phase reset (no frame flashes the old document's last page).
  const lastDocRef = useRef(docRef);
  if (lastDocRef.current !== docRef) {
    lastDocRef.current = docRef;
    setPage(1);
    setFlip(null);
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
  // then verifies it against the real layout.
  useEffect(() => {
    setPlan({ columns: lowerBound, passes: 0 });
  }, [lowerBound]);

  // The measurement loop — the page count IS the column count, and the
  // runtime tells it for free: with `column-fill: auto` the browser
  // fragments the whole flow into page-height columns on demand, letting
  // excess columns overflow the box horizontally (verified in the running
  // app: a 1-page-wide box reported scrollWidth = 4 × pageW for a 4-page
  // document). So the count is scrollWidth / pageW, and the plan only ever
  // widens to fit it. The vertical spill check rides along as the
  // conservative signal for engines that clip instead of overflowing.
  useLayoutEffect(() => {
    const el = pagesRef.current;
    if (!el || !ready || pageBox.w <= 0) return;
    const byWidth = Math.max(1, Math.round(el.scrollWidth / pageBox.w));
    const byHeight =
      el.scrollHeight > el.clientHeight + 1 ? plan.columns + 1 : 1;
    const actual = Math.max(byWidth, byHeight);
    if (actual > plan.columns && plan.passes < MAX_MEASURE_PASSES) {
      setPlan({ columns: actual, passes: plan.passes + 1 });
    }
  }, [ready, model.markdown, pageBox, plan]);

  // The pane resizes (window, dvh shifts): the pagebox is re-measured and
  // the lower-bound effect re-plans — rAF-debounced so a drag's event storm
  // collapses into one re-pagination. Re-subscribes when the single-sheet ↔
  // stack swap replaces the pagebox element (an observer on a detached node
  // would silently stop watching).
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
        setPageBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [stacked, boxRef]);

  // Re-pagination can only shrink the count under a resize — clamp, never
  // throw the reader off the document.
  useEffect(() => {
    setPage((p) => clampPage(p, total));
  }, [total]);

  const settleFlip = useCallback(() => {
    const dir = flipRef.current;
    if (!dir) return;
    setPage((p) => clampPage(p + (dir === "next" ? 1 : -1), totalRef.current));
    setShift((s) => (dir === "next" ? s + 1 : s - 1));
    setFlip(null);
  }, []);

  // The flip's landing normally reports through animationend; the timeout
  // is the backstop for the event that never arrives (unmounted mid-beats
  // included) — the ring must never stay half-shifted.
  useEffect(() => {
    if (!flip) return;
    const t = setTimeout(settleFlip, FLIP_MS + 120);
    return () => clearTimeout(t);
  }, [flip, settleFlip]);

  const turnPage = useCallback(
    (dir: "next" | "prev") => {
      if (flip !== null || !ready) return;
      const target = page + (dir === "next" ? 1 : -1);
      if (target < 1 || target > total) return;
      if (reducedMotion) {
        // No motion: the sheets do not move, the content swaps in place
        // under a quiet fade (the CSS replays it via the remount).
        setPage(target);
        return;
      }
      setFlip(dir);
    },
    [flip, ready, page, total, reducedMotion],
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
      if (flipRef.current) return;
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
        flip,
        shift,
        planColumns: plan.columns,
        pageBox,
        pagesRef,
        attachBoxRef,
        attachMeasureRef,
        onFlipEnd: settleFlip,
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
                disabled={flip !== null || page <= 1}
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
                disabled={flip !== null || page >= total}
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
  flip: "next" | "prev" | null;
  shift: number;
  planColumns: number;
  pageBox: { w: number; h: number };
  pagesRef: RefObject<HTMLDivElement | null>;
  attachBoxRef: (el: HTMLDivElement | null) => void;
  attachMeasureRef: (el: HTMLDivElement | null) => void;
  onFlipEnd: () => void;
  /** The page turn, owned by the field above — the swipe hands it a
   *  direction and the same gate as the buttons applies (flipping state,
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

  // §12.2 — pointermove rewrites the paper-scoped --recess-i (0.7–1.3),
  // reaching only the header date and the folio. The global light field is
  // never touched.
  const onPaperPointerMove = useCallback((e: ReactPointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    el.style.setProperty("--recess-i", recessIntensityFor(relY).toFixed(3));
  }, []);

  const {
    ready,
    markdown,
    title,
    page,
    total,
    flip,
    shift,
    planColumns,
    pageBox,
    pagesRef,
    attachBoxRef,
    attachMeasureRef,
    onFlipEnd,
    onTurn,
  } = paging;

  // The deck ring: slot i sits at depth (i + shift) mod SHELL_COUNT —
  // depth 0 = deck bottom, SHELL_COUNT-1 = the visible top. Shells paint in
  // ascending depth (DOM order is the paint order in the flat stack
  // context); only the flying sheet needs an explicit lift.
  const depthOf = useCallback(
    (slot: number) =>
      (((slot + shift) % SHELL_COUNT) + SHELL_COUNT) % SHELL_COUNT,
    [shift],
  );
  const slots = useMemo(
    () =>
      Array.from({ length: SHELL_COUNT }, (_, i) => i).sort(
        (a, b) => depthOf(a) - depthOf(b),
      ),
    [depthOf],
  );

  // One shell when the document is not a stack at all: in flight, dead
  // link, or a single page (backingSheets(1) = 0 — a one-page document
  // wears no pile).
  const stacked = ready && total > 1;
  const renderedSlots = stacked ? slots : [SHELL_COUNT - 1];
  const topDepth = SHELL_COUNT - 1;

  // The landing handshake: the flip animation reports here (it bubbles off
  // whichever shell was flying); the ring shift and the page bump settle
  // the new arrangement.
  const onStackAnimationEnd = useCallback(
    (e: ReactAnimationEvent) => {
      if (e.animationName === "desk-flip-turn") onFlipEnd();
    },
    [onFlipEnd],
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
  // to the shell's page by --desk-page-i.
  const flow = ready && markdown !== null ? (
    <>
      <h1 className="desk-title">{title}</h1>
      {/* The body keeps its real components (CodeBlock's hooks included) —
          re-wrapped in intl context, the conversation field's
          BillboardBlock pattern. */}
      <NextIntlClientProvider messages={messages} locale={locale}>
        <MarkdownRenderer content={markdown} />
      </NextIntlClientProvider>
    </>
  ) : null;

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
            {renderedSlots.map((slot) => {
              const depth = stacked ? depthOf(slot) : topDepth;
              const offset = shellOffsetForDepth(depth);
              const shellPage = stacked
                ? pageForShellDepth(page, total, depth, SHELL_COUNT)
                : 1;
              const isTop = depth === topDepth;
              const isFlying =
                flip !== null &&
                depth === (flip === "next" ? topDepth : 0);
              const shellStyle = {
                "--sx": `${offset.x}px`,
                "--sy": `${offset.y}px`,
                "--sr": `${offset.r}deg`,
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
                  key={slot}
                  data-desk-shell={depth}
                  className={`desk-shell${isTop ? " desk-shell--top" : ""}${
                    isFlying ? " desk-shell--flying" : ""
                  }`}
                  style={shellStyle}
                >
                  <div className="desk-flip">
                    <div
                      className="desk-paper bg-paper bg-paper-grain-card shadow-paper-contact text-card-foreground"
                      data-locale={locale}
                      onPointerMove={onPaperPointerMove}
                    >
                      {shellPage === null ? (
                        // Blank paper: the stack's peek, nothing printed.
                        <div
                          className="desk-face desk-face-front"
                          aria-hidden="true"
                        />
                      ) : (
                        <div className="desk-face desk-face-front">
                          <header className="desk-head flex items-baseline justify-between gap-8">
                            <span className="truncate">
                              {model.caseRef ?? model.title}
                            </span>
                            <span className="desk-recess shrink-0 tabular-nums">
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
                                    key={reducedMotion && isTop ? page : slot}
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
                            <span className="desk-recess tabular-nums">
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
                      {/* The back of a printed sheet: blank paper (the stock
                          shows through), never mirrored text. */}
                      <div
                        className="desk-face desk-face-back"
                        aria-hidden="true"
                      />
                    </div>
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
