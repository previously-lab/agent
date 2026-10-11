"use client";

/**
 * The paged document desk (v0.24; DOM tier v0.30) — the open document as
 * PLAIN DOM above the one world canvas. The paper, its pages and its stack
 * are ordinary elements in the pane's z-10 layer; the frozen world (the
 * suspended hotel, blurred) stays mounted behind them on the z-0 canvas.
 *
 * THE MIGRATION (v0.30, doc/design/v0.28-document-tier-architecture.md step
 * 2). The reader used to live INSIDE the R3F scene: the desk registered a
 * `DeskScene` into the field world's slot and drei's `<Html transform>`
 * projected the paper's DOM into the pane, while a per-frame `useFrame`
 * rewrote the camera (zoom/pan) and the sheet's matrix — so every frame of
 * a zoom ease made the browser flatten and re-rasterize up to five
 * full-page text layers. Now the desk registers NO scene: the table plane,
 * the lights, the clip-plane bookkeeping and the Html portal are gone (the
 * field's ground is the shell's `data-field-backdrop`; the paper separates
 * from it by its contact shadow, exactly the archive piles' read). What
 * drew the paper was always DOM — that part is unchanged, down to the
 * markup and the print-scale CSS.
 *
 * ZOOM AND PAN ARE DOM TRANSFORMS NOW (rule 18's intent unchanged: the
 * sheet is a fixed 210×297mm object, the reading distance changes). Three
 * nested wrappers, each owning one transform so their transitions never
 * fight:
 *
 *   .desk-giveway  the give-way x (the open library panel's measured width)
 *                  — a 300ms CSS transition, the damped pan of old;
 *   .desk-pan      the user's drag pan — NO transition: it tracks the
 *                  pointer 1:1;
 *   .desk-zoom     `scale(zoom)` — a 300ms CSS transition, the damping of
 *                  old, now compositor-owned.
 *
 * THE ZOOM IS BANDED (v0.30, the owner's ruling): `DESK_ZOOM_BANDS` in
 * lib/timeline3d/desk-camera — a few discrete stops (0.7× 1.0× 1.2× 1.45×
 * 1.7× 2.0×), opening at 1.45×, `0`/the readout resetting to the whole
 * page (1.0×). The buttons, the `+`/`−` keys and ctrl/cmd-wheel all step
 * between stops — a continuous wheel is what made the raster cost
 * unpredictable. The pure state machine keeps the targets and the clamped
 * pan; the visual value is the stop itself, animated by CSS.
 *
 * THE TURN IS UNTOUCHED (the product's beat): the same shuffle, the same
 * five shells, the same pure-CSS keyframes — only the traveling sheet ever
 * changes transform, a settle repaints nothing.
 *
 * THE PANE HANDSHAKE (unchanged): while `deskDoc` is set, the shell unmounts
 * the archive field and mounts this component in the same pane branch, on a
 * hand-timed handover (see app-shell.tsx). No world-slot registration any
 * more — the field world's GL slot is simply empty while the desk is open.
 *
 * PAGINATION (v0.24, cyclic in v0.29). One sheet = one PAGE of the
 * document. The markdown flows through CSS multi-column layout inside a
 * fixed-height 版心 (one column per page; `column-fill: auto` packs each
 * column to the page height) and five paper SLOTS carry the current, next,
 * and previous pages (the other two are blank paper, their edges peeking —
 * the card field's stacked-papers look). A turn SHUFFLES (the user's ruling
 * — no rotation): the top sheet lifts off, travels, and is put at the very
 * back; the deck closes rank beneath it; going back is the same gesture in
 * reverse. Pure CSS transform animation, only the traveler ever moves. THE
 * STACK IS A CYCLE (v0.29, the owner's ruling): forward past the last page
 * returns to the first, back past the first to the last — like turning a
 * held stack of paper over. Nothing prints a total: the count is READ off
 * the live layout (the flow container stays one page wide, the browser
 * fragments the content into as many overflow columns as it needs, and
 * scrollWidth / pageW IS the true count — no measurer, no lower bound, no
 * growth loop, and never a sheet beyond what the flow fills); the only
 * page indicator is the folio printed on the sheet itself, true by
 * construction.
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
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "next-intl";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useShell } from "@/components/shell/shell-provider";
import {
  clampViewCentre,
  createDeskCamera,
  dragPanBy,
  panBoundsFor,
  resetDeskCamera,
  stepDeskZoomBand,
  type DeskCameraState,
} from "@/lib/timeline3d/desk-camera";
import { ISLAND_BAR, ISLAND_CONTROL } from "@/components/layout/island";
import {
  deskZoomAtMax,
  deskZoomAtMin,
  formatDeskZoom,
} from "@/components/desk/desk-zoom";
import {
  getCaseDoc,
  type CaseDocContent,
} from "@/lib/episodic/actions";
import {
  getDossierDoc,
  getRecordDoc,
  verifyRefs,
  type RecordDocContent,
  type VerifiedRef,
} from "@/lib/archive/actions";
import { deskRefKind } from "@/lib/archive/refs";
import { extractMarkdownRefs } from "@/lib/archive/ref-tokens";
import {
  DocRefProvider,
  MarkdownRenderer,
  type DocRefContextValue,
} from "@/components/chat/markdown";
import {
  clampPage,
  wrapPage,
  TURN_MS,
  pageForShellSlot,
  deskPaperModel,
  mastheadLines,
  DOSSIER_NAMES,
  SHELL_COUNT,
  shellOffsetForSlot,
} from "./desk-model";
import "./desk.css";

/** The desk's UI strings, injected from the shell (the desk.chrome strings
 *  live in messages/, the v0.28 pattern — kept as a prop so this module's
 *  interface is unchanged for the shell). Only CHROME strings live here (the
 *  region, the page control, the not-found paper, the transcript's speaker
 *  labels); the paper's own furniture — the letterhead's category, RECORD,
 *  the shelf line, the folio — is fixed English and never goes through
 *  next-intl (the owner's v0.28 ruling: the document's surroundings are not
 *  translated; its title and body print exactly as stored). */
export interface DeskTexts {
  /** aria-label of the desk region — carries the Escape affordance. */
  regionLabel: string;
  /** The body line while the document is in flight. */
  loading: string;
  /** The dead-link paper's heading. */
  notFoundHeading: string;
  /** The dead-link paper's body line. */
  notFoundBody(ref: string): string;
  /** aria-label of the page-control's previous-page button. */
  prevPage: string;
  /** aria-label of the page-control's next-page button. */
  nextPage: string;
  /** RETIRED (v0.29): the island no longer prints a position — the stack is
   *  a cycle and a total is never announced (the folio on the sheet is the
   *  only page indicator). Optional so the shell's wiring keeps compiling
   *  until the shell lane deletes it (app-shell.tsx `pagePosition`, and the
   *  `desk.pagePosition` key in messages/en.json + messages/zh.json). */
  pagePosition?(current: number, total: number): string;
  /** aria-label of the zoom island's zoom-out button. */
  zoomOut: string;
  /** aria-label of the zoom island's zoom-in button. */
  zoomIn: string;
  /** aria-label of the zoom readout — activating it fits the whole page
   *  (the visible twin of the `0` key), like the page bar's readout. */
  zoomReset: string;
  /** The transcript paper's speaker labels (v0.25b §三) — handed to the
   *  record read, which composes the turns' markdown with them. */
  recordUserLabel: string;
  recordAgentLabel: string;
}

/** Wheel paging: accumulated deltaY per turn, and the quiet window that
 *  resets the accumulator (trackpad momentum decays — without the reset a
 *  slow drift would page forever). */
const WHEEL_THRESHOLD_PX = 120;
const WHEEL_QUIET_MS = 150;

/** Banded ctrl/cmd-wheel zoom: accumulated deltaY per STOP (v0.30). A mouse
 *  notch (±100) is one or two stops; a trackpad pinch's small deltas pool
 *  until they cross the threshold — the wheel, like the buttons, can only
 *  rest on a band. */
const WHEEL_ZOOM_THRESHOLD_PX = 50;

/** Touch/pen swipe: horizontal distance that turns a page, and the
 *  dominance the horizontal component needs over the vertical one. */
const SWIPE_THRESHOLD_PX = 56;

/** The give-way breakpoint (v0.25 R1-A): at ≥lg the paper pans aside; below
 *  it the panel closes on selection instead (library-control's half of the
 *  ruling) — a phone never gets both the panel and a shifted sheet. */
const LIBRARY_GIVEWAY_MQ = "(min-width: 1024px)";

/** How wide the open library panel stands, in px — 0 when it is closed or
 *  the viewport is below lg. The panel renders `[data-library-panel]` and
 *  its toggle carries `aria-expanded`, so the desk MEASURES the truth
 *  instead of importing a copy of the panel's state (the chrome-inset
 *  idiom). The open signal reads off the TOGGLE, not the panel's presence:
 *  the panel lingers through its exit beat, and the paper's return pan
 *  starts on the close click, not 200 ms after it.
 *
 *  Two observers because the two inputs change differently: the toggle's
 *  aria-expanded and the panel's mount/unmount are mutations on the
 *  control's subtree; the panel's WIDTH follows the viewport (its formula
 *  is viewport-derived), which is a resize. rAF-debounced, equality-guarded. */
function measureLibraryPanelWidth(): number {
  if (!window.matchMedia(LIBRARY_GIVEWAY_MQ).matches) return 0;
  const control = document.querySelector("[data-library-control]");
  const toggle = control?.querySelector("[data-library-toggle]");
  if (toggle?.getAttribute("aria-expanded") !== "true") return 0;
  const panel = control?.querySelector("[data-library-panel]");
  if (!panel) return 0;
  return panel.getBoundingClientRect().width;
}

function useLibraryPanelShift(): number {
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const apply = () => {
      const w = measureLibraryPanelWidth();
      setShift((prev) => (prev === w ? prev : w));
    };
    apply();
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const mo = new MutationObserver(remeasure);
    // The desk mounts inside the shell that already rendered the control —
    // the root is there by the time this effect runs.
    const root = document.querySelector("[data-library-control]");
    if (root) {
      mo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-expanded"],
      });
    }
    window.addEventListener("resize", remeasure);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, []);
  return shift;
}

export function DeskField({
  docRef,
  camXOffset,
  reducedMotion,
  texts,
  leaving = false,
}: {
  /** The open document's reference (`deskDoc` — never null here: app-shell
   *  mounts the desk only when a ref is set). */
  docRef: string;
  /** The field camera's half-band x shift — 0 in the reader (the library
   *  control floats; there is no column to clear). The give-way pan (v0.25
   *  R1-A) is ADDED ON TOP inside the field: it derives from the panel's
   *  measured width, not from this prop. */
  camXOffset: number;
  reducedMotion: boolean;
  texts: DeskTexts;
  /** The shell's handover says the desk is on its way out (the pane's
   *  handover is hand-timed in app-shell). The stage's exit beat reads it:
   *  the CSS transition returns the paper to its hidden pose while the
   *  shell's own fade runs above it. */
  leaving?: boolean;
}) {
  const { closeDesk, openDesk } = useShell();
  const locale = useLocale();
  const leave = leaving;

  // The give-way (v0.25 R1-A): the open library panel's measured width,
  // SUBTRACTED from the camera's x — the view's centre sits left of the
  // paper and the paper reads shifted RIGHT (the card field's band bias is
  // the same sign convention). The .desk-giveway wrapper carries it as a
  // 300ms CSS transition, so open/close is a glide, not a jump.
  const panelShift = useLibraryPanelShift();
  const panelShiftRef = useRef(panelShift);
  panelShiftRef.current = panelShift;
  const effectiveCamX = camXOffset - panelShift;

  // The document arrives lazily, one server-action round trip per open —
  // the shelf's own rhythm. `undefined` = in flight; null = dead link (the
  // not-found paper); a throw surfaces as the same not-found paper. The
  // ref's vocabulary picks the read (refs.ts): a case/piece/legacy ref rides
  // getCaseDoc; records/<sliceId> reads the slice's transcript (composed
  // with THIS locale's speaker labels — a locale switch refetches); a
  // dossier/<name> ref reads the self-document verbatim.
  const [doc, setDoc] = useState<CaseDocContent | null | undefined>(undefined);
  const recordUserLabel = texts.recordUserLabel;
  const recordAgentLabel = texts.recordAgentLabel;
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    const kind = deskRefKind(docRef);
    const read: Promise<CaseDocContent | RecordDocContent | null> =
      kind === "record"
        ? getRecordDoc(docRef, {
            user: recordUserLabel,
            agent: recordAgentLabel,
          })
        : kind === "dossier"
          ? getDossierDoc(docRef)
          : getCaseDoc(docRef);
    read
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch(() => {
        if (live) setDoc(null);
      });
    return () => {
      live = false;
    };
  }, [docRef, recordUserLabel, recordAgentLabel]);
  const loading = doc === undefined;
  const model = useMemo(
    () => deskPaperModel(docRef, doc ?? null),
    [docRef, doc],
  );
  // The paper's display title: a record prints NONE (§三 — the transcript's
  // identity is the letterhead's clock + shelf lines; the body is the turns
  // alone); a dossier prints its fixed English name; a case its own.
  const displayTitle =
    model.kind === "record"
      ? ""
      : model.kind === "dossier" && model.dossier
        ? DOSSIER_NAMES[model.dossier]
        : model.title;

  // ── REFERENCE LINKS (v0.25a §五) ───────────────────────────────────────
  // The candidates ride the SAME grammar the remark plugin renders
  // (ref-tokens.ts), so every span the paper can underline is a span this
  // batch pre-verified. The map is NOT reset on a document swap: stale
  // entries go unqueried, and the live links of the previous paper never
  // flash back to plain text mid-pull-out.
  const refCandidates = useMemo(
    () => (model.markdown ? extractMarkdownRefs(model.markdown) : []),
    [model.markdown],
  );
  const [refStatus, setRefStatus] = useState<ReadonlyMap<string, VerifiedRef>>(
    () => new Map(),
  );
  useEffect(() => {
    if (refCandidates.length === 0) return;
    let live = true;
    verifyRefs(refCandidates)
      .then((verified) => {
        if (live) setRefStatus(new Map(verified.map((v) => [v.ref, v])));
      })
      .catch(() => {
        // A failed verify pass leaves every candidate inert (plain text).
      });
    return () => {
      live = false;
    };
  }, [refCandidates]);

  const docRefCtx = useMemo<DocRefContextValue>(
    () => ({
      status: new Map(Array.from(refStatus, ([ref, v]) => [ref, v.alive])),
      onOpen: openDesk,
    }),
    [refStatus, openDesk],
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
  // THE TRUE COUNT (v0.29) — read off the live layout, never computed from a
  // guess: the flow container stays ONE page wide, the browser fragments the
  // content into as many page-height columns as it needs (overflowing
  // horizontally), and scrollWidth / pageW is the exact filled-column count.
  // 1 until the first measure lands (the single-sheet form until then).
  const [total, setTotal] = useState(1);

  const totalRef = useRef(total);
  totalRef.current = total;
  const turnRef = useRef(turn);
  turnRef.current = turn;

  const pagesRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The count read, self-contained on the node: the pages container stays
  // one page wide, so its clientWidth IS the page width and scrollWidth /
  // clientWidth the exact filled-column count.
  const readTotal = useCallback((el: HTMLDivElement) => {
    const w = el.clientWidth;
    if (w <= 0) return; // not in a laid-out state — keep the previous truth
    const actual = Math.max(1, Math.round(el.scrollWidth / w));
    setTotal((prev) => (prev === actual ? prev : actual));
  }, []);

  // Callback refs, not plain refs: a missed attach must not leave the
  // measurement state at zero until some unrelated re-render. The callback
  // measures at attach time; the effects below re-measure on the content
  // and width changes. All setters are equality-guarded, so a re-attach
  // with the same numbers re-renders nothing. INERT WHILE A TURN IS IN
  // FLIGHT: the top slot's occupant changes at turn start, moving this ref
  // between shells — re-counting mid-gesture collapses the deck for a
  // frame (the reader-visible flicker).
  const attachPagesRef = useCallback(
    (el: HTMLDivElement | null) => {
      pagesRef.current = el;
      if (el && turnRef.current === null) readTotal(el);
    },
    [readTotal],
  );
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

  // Settle is idempotent by a synchronous flag, not by state: the landing
  // reports through animationend AND a timeout backstop — if the main
  // thread is busy when the backstop fires, the state guard alone would
  // still be stale and the page would bump twice (observed: 1 → 2 → 3).
  const settledRef = useRef(true);

  // THE READER'S CAMERA STATE (v0.25a §一, rule 18; DOM tier v0.30): the
  // sheet's size is FIXED; zoom (banded — see the module header) and pan
  // are reading-distance state. The machine is pure
  // (lib/timeline3d/desk-camera); gestures write its TARGETS, clamped on
  // every write so the sheet can never leave the viewport. The RENDERED
  // value is the target itself: the .desk-zoom wrapper's CSS transition is
  // the damping, so no per-frame JS advance exists any more.
  const cameraRef = useRef<DeskCameraState>(createDeskCamera());

  // THE ZOOM ISLAND'S MIRROR (v0.28 zoom chrome, banded v0.30). The state
  // machine is a ref; React sees it only through this state. Banded, there
  // is no per-frame ease to mirror — gestures (buttons, keys, wheel)
  // re-render it once per STOP with the display string and the two
  // range-end flags; between stops the string is stable.
  const [zoomView, setZoomView] = useState(() => {
    const cam = cameraRef.current;
    return {
      text: formatDeskZoom(cam.zoomTarget),
      atMin: deskZoomAtMin(cam.zoomTarget),
      atMax: deskZoomAtMax(cam.zoomTarget),
    };
  });
  const syncZoomView = useCallback(() => {
    const cam = cameraRef.current;
    setZoomView((prev) => {
      const text = formatDeskZoom(cam.zoomTarget);
      const atMin = deskZoomAtMin(cam.zoomTarget);
      const atMax = deskZoomAtMax(cam.zoomTarget);
      if (prev.text === text && prev.atMin === atMin && prev.atMax === atMax) {
        return prev;
      }
      return { text, atMin, atMax };
    });
  }, []);

  // ── THE PAN/ZOOM GEOMETRY (DOM tier v0.30) ────────────────────────────
  // The stage's box IS the viewport the pan bounds clamp against (the pane
  // spans the screen; the old code read the canvas's size).
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      viewRef.current = { w: el.clientWidth, h: el.clientHeight };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The sheet's size in LAYOUT px — measured off the top paper (the fixed
  // 210×297mm object; ancestor transforms never touch offsetWidth). The
  // pan bounds derive from it.
  const paperSizeRef = useRef({ w: 0, h: 0 });
  const paperRORef = useRef<ResizeObserver | null>(null);
  const attachPaperRef = useCallback((el: HTMLDivElement | null) => {
    paperRORef.current?.disconnect();
    paperRORef.current = null;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) paperSizeRef.current = { w, h };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    paperRORef.current = ro;
  }, []);

  // Re-clamp the pan TARGET against the current bounds (the give-way x
  // counts toward the centre, so a panel-open desk can't be panned off the
  // paper either). Runs on every gesture that moves the zoom or the pan;
  // with whole-page fits the bounds are zero and the clamp is a no-op.
  const clampCameraPan = useCallback((cam: DeskCameraState): DeskCameraState => {
    const paper = paperSizeRef.current;
    const view = viewRef.current;
    if (paper.w <= 0 || view.w <= 0) return cam;
    const camX = camXOffset - panelShiftRef.current;
    const bounds = panBoundsFor(
      paper.w,
      paper.h,
      view.w,
      view.h,
      cam.zoomTarget,
    );
    const centre = clampViewCentre(
      { x: camX + cam.panTarget.x, y: cam.panTarget.y },
      bounds,
    );
    return { ...cam, panTarget: { x: centre.x - camX, y: centre.y } };
  }, [camXOffset]);

  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      cameraRef.current = clampCameraPan(
        stepDeskZoomBand(cameraRef.current, dir),
      );
      syncZoomView();
    },
    [clampCameraPan, syncZoomView],
  );
  const zoomReset = useCallback(() => {
    cameraRef.current = clampCameraPan(resetDeskCamera(cameraRef.current));
    syncZoomView();
  }, [clampCameraPan, syncZoomView]);

  // Drag writes pan 1:1 with no CSS transition, so the styles must update
  // without waiting for a zoom/page state change — a tick re-renders the
  // wrappers (the flow stays memoized; the shells diff cheap).
  const [panTick, setPanTick] = useState(0);

  // The entrance/exit beat (the pull-out, v0.22 §3): in, the paper rises
  // from below the viewport over the pane's own 300 ms; out, the same beat
  // reversed, in step with the shell's handover fade. Pure CSS on
  // .desk-stage (data-entered) — reduced motion keeps the opacity leg.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (leave) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [leave, docRef]);

  // A new document restarts at page 1 with no turn in flight — the render-
  // phase reset (no frame flashes the old document's last page). The camera
  // reopens too: every document opens at the readable default, centred, and
  // the entrance beat replays for the new stack.
  const lastDocRef = useRef(docRef);
  if (lastDocRef.current !== docRef) {
    lastDocRef.current = docRef;
    setPage(1);
    setTurn(null);
    setTotal(1);
    settledRef.current = true;
    cameraRef.current = createDeskCamera();
    setEntered(false);
  }

  // THE COUNT IS READ, NOT PLANNED (v0.29). The top sheet's flow container
  // stays one page wide; with `column-fill: auto` the browser fragments the
  // whole flow into page-height columns on demand, letting the excess
  // overflow the box horizontally — so scrollWidth / pageW is the exact
  // filled-column count, in both directions (it shrinks as readily as it
  // grows: the container's own width no longer floors the reading). A
  // vertical spill NEVER grows the count: a block taller than one page
  // overflows its column permanently, and reading that as "needs another
  // column" counted air (a taller column is a pagination imperfection
  // prints tolerate, not a missing page). The attach callback above covers
  // the late mount; THIS effect covers the later changes — content swap,
  // pane resize. INERT WHILE A TURN IS IN FLIGHT: every input is frozen
  // then, and re-counting mid-gesture collapses the deck for a frame — the
  // reader-visible flicker.
  useLayoutEffect(() => {
    const el = pagesRef.current;
    if (!el || !ready || turn !== null) return;
    readTotal(el);
  }, [ready, model.markdown, pageBox, turn, readTotal]);

  // The webfonts can land after the first measure and re-break the flow —
  // re-read the count then.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    document.fonts?.ready.then(() => {
      const el = pagesRef.current;
      if (live && el && turnRef.current === null) readTotal(el);
    });
    return () => {
      live = false;
    };
  }, [ready, pageBox.w, model.markdown, readTotal]);

  // The pane resizes (window, dvh shifts): the pagebox is re-measured and
  // the count re-read — rAF-debounced so a drag's event storm collapses
  // into one re-pagination. Re-subscribes when the single-sheet ↔ stack
  // swap replaces the pagebox element (an observer on a detached node would
  // silently stop watching) AND when the top slot's occupant changes
  // (every turn) — the observer must follow the live pagebox, never a shell
  // that a later edge blanks.
  const stacked = ready && total > 1;
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
      wrapPage(p + (active.dir === "next" ? 1 : -1), totalRef.current),
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
      if (turn !== null || !ready || total <= 1) return;
      // THE CYCLE (v0.29): no edge rejection — forward past the last page
      // wraps to the first, back past the first to the last.
      const target = wrapPage(page + (dir === "next" ? 1 : -1), total);
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
  const zoomStepRef = useRef(zoomStep);
  zoomStepRef.current = zoomStep;

  // The wheel's TWO jobs (v0.28 camera; banded v0.30). Plain wheel keeps
  // turning pages — the established gesture: the accumulator turns a page
  // at the threshold and the quiet window eats trackpad momentum.
  // Ctrl/cmd+wheel — which is ALSO what a trackpad pinch sends — steps the
  // zoom BANDS instead (accumulated to a stop threshold, so the wheel lands
  // only on stops, never between). Only the zoom leg preventDefaults
  // (keeping the browser's own pinch-zoom out of the fight), so the
  // listener is non-passive but the page-turn leg stays a pure observer,
  // exactly as before.
  useEffect(() => {
    if (!ready) return;
    let acc = 0;
    let zoomAcc = 0;
    let lastEvent = 0;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.("[data-desk-stack]")) {
        acc = 0;
        zoomAcc = 0;
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAcc += e.deltaY;
        if (zoomAcc >= WHEEL_ZOOM_THRESHOLD_PX) {
          zoomAcc = 0;
          zoomStepRef.current(1);
        } else if (zoomAcc <= -WHEEL_ZOOM_THRESHOLD_PX) {
          zoomAcc = 0;
          zoomStepRef.current(-1);
        }
        return;
      }
      zoomAcc = 0;
      if (total <= 1) return;
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
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [ready, total]);

  /** The camera keys: `+`/`=` and `-` step the zoom one BAND, `0` resets
   *  to the whole page. Returns false for every other key. Callers guard
   *  modifiers (ctrl/cmd+= is the browser's own zoom) and editable targets
   *  (a `+` typed into the floating chat is text). */
  const applyZoomKey = useCallback(
    (key: string): boolean => {
      if (key === "+" || key === "=") {
        zoomStep(1);
      } else if (key === "-") {
        zoomStep(-1);
      } else if (key === "0") {
        zoomReset();
      } else {
        return false;
      }
      return true;
    },
    [zoomStep, zoomReset],
  );

  // Escape puts the document back; the arrows turn its pages. The desk is
  // plain DOM now (no Canvas boundary), so the wrapper's own keydown sees
  // every key pressed over the paper. The window backstop stays for the
  // chrome that is NOT in this subtree: the page/zoom islands render through
  // body portals, and after a button click they hold the focus — arrows and
  // Escape must keep working there (it defers to any inner handler that
  // already claimed the key, and to editable targets).
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
      } else if (!(e.ctrlKey || e.metaKey || e.altKey) && applyZoomKey(e.key)) {
        e.preventDefault();
      }
    },
    [closeDesk, turnPage, applyZoomKey],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") closeDesk();
      else if (e.key === "ArrowRight") turnPageRef.current("next");
      else if (e.key === "ArrowLeft") turnPageRef.current("prev");
      else if (!(e.ctrlKey || e.metaKey || e.altKey)) {
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('input, textarea, select, [contenteditable="true"]'))
          return;
        if (applyZoomKey(e.key)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDesk, applyZoomKey]);

  // The letterhead (v0.28): `Previously` over the model's three derived
  // lines — clock, bare category, shelf — each omitted when its data does
  // not exist. Fixed English, one ink; the paper's furniture is not
  // translated.
  const head = mastheadLines(model);

  // One shell when the document is not a stack at all: in flight, dead
  // link, or a single page (backingSheets(1) = 0 — a one-page document
  // wears no pile).
  const slots = stacked
    ? Array.from({ length: SHELL_COUNT }, (_, i) => i)
    : [0];

  // The landing handshake: the traveler's animation reports here (the
  // close-rank beats end at the same instant); the page bump and the turn
  // state's retirement settle the new arrangement.
  const onStackAnimationEnd = useCallback(
    (e: ReactAnimationEvent) => {
      if (e.animationName === "desk-travel") settleTurn();
    },
    [settleTurn],
  );

  // Drag on the paper: PAN when the zoomed sheet outgrows the viewport
  // (grab-the-paper feel; the camera state machine owns the math), the
  // horizontal SWIPE stays a page turn while the whole page fits (pan
  // bounds are zero there, so the two gestures never fight). A drag that
  // panned is never a page turn. Nothing is preventDefaulted — text
  // selection and dblclick behave exactly as before.
  const dragRef = useRef<{
    x: number;
    y: number;
    id: number;
    panned: boolean;
  } | null>(null);
  const onStackPointerDown = useCallback((e: ReactPointerEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId, panned: false };
  }, []);
  const onStackPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== e.pointerId) return;
      const cam = cameraRef.current;
      const paper = paperSizeRef.current;
      const view = viewRef.current;
      if (paper.w <= 0 || view.w <= 0) return;
      const bounds = panBoundsFor(
        paper.w,
        paper.h,
        view.w,
        view.h,
        cam.zoomTarget,
      );
      if (bounds.x <= 0 && bounds.y <= 0) return; // whole page: swipe only
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      // A few px of slack so a click or a double-click never becomes a pan.
      if (!drag.panned && Math.hypot(dx, dy) < 3) return;
      if (!drag.panned) {
        drag.panned = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      cameraRef.current = clampCameraPan(dragPanBy(cam, dx, dy));
      setPanTick((t) => t + 1);
    },
    [clampCameraPan],
  );
  const onStackPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const start = dragRef.current;
      dragRef.current = null;
      if (!start || start.id !== e.pointerId) return;
      if (start.panned) {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        return; // a pan is never a page turn
      }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (
        Math.abs(dx) > SWIPE_THRESHOLD_PX &&
        Math.abs(dx) > 2 * Math.abs(dy)
      ) {
        turnPage(dx < 0 ? "next" : "prev");
      }
    },
    [turnPage],
  );
  const onStackPointerCancel = useCallback(() => {
    dragRef.current = null;
  }, []);

  // The flow — one full copy of the document per content shell, translated
  // to the shell's page by --desk-page-i. MEMOIZED on the document alone:
  // a turn changes paging state every few hundred milliseconds, and without
  // this each turn would re-parse and re-layout all three markdown copies
  // before the animation could even start. The desk is plain DOM now, so
  // the markdown keeps its real context — no portal re-wrap.
  const flow = useMemo(
    () =>
      ready && model.markdown !== null ? (
    <>
      {/* A record's title is "" (§三: the header carries the identity) —
          no display line opens the transcript. */}
      {displayTitle !== "" && <h1 className="desk-title">{displayTitle}</h1>}
      <MarkdownRenderer content={model.markdown} />
        </>
      ) : null,
    [ready, model.markdown, displayTitle],
  );

  // THE TRANSFORM STACK (v0.30): three layers, one transform each, so a
  // layer's CSS transition can only ever animate its own job. Values in
  // screen px = world units × zoom, with the sign flips of screen-y-down
  // vs world-y-up folded in (the same math the old camera write did:
  // position (camX + pan.x, pan.y, camZ) looking at the sheet's plane).
  const camNow = cameraRef.current;
  const zoomNow = camNow.zoomTarget;
  const givewayStyle = {
    "--desk-giveway-x": `${-effectiveCamX * zoomNow}px`,
  } as CSSProperties;
  const panStyle = {
    "--desk-pan-x": `${-camNow.panTarget.x * zoomNow}px`,
    "--desk-pan-y": `${camNow.panTarget.y * zoomNow}px`,
  } as CSSProperties;
  const zoomStyle = {
    "--desk-zoom": zoomNow,
  } as CSSProperties;
  // panTick is read here so a drag's transform lands on the wrappers.
  void panTick;

  return (
    <>
      <div
        ref={wrapRef}
        data-desk-field
        // Focusable so the Escape/arrows binding has somewhere to listen —
        // the card field's wrapper pattern. The desk's whole DOM presence is
        // this region; pointer-events-none is LOAD-BEARING: the pane (z-10)
        // stacks above the world canvas (z-0), and only the paper re-enables
        // hits on its own layers.
        tabIndex={0}
        role="region"
        aria-label={texts.regionLabel}
        onKeyDown={onKeyDown}
        className="pointer-events-none relative h-full w-full outline-none"
      >
        {/* THE DOCUMENT TIER (v0.30) — the open document as plain DOM above
            the frozen world. .desk-stage owns the entrance/exit beat,
            .desk-giveway the panel give-way glide, .desk-pan the drag (no
            transition — it tracks the pointer), .desk-zoom the banded scale
            (the CSS transition IS the damping). */}
        <div
          ref={stageRef}
          data-desk-stage
          data-entered={entered && !leave ? true : undefined}
          className="desk-stage"
        >
          <div data-desk-giveway className="desk-giveway" style={givewayStyle}>
            <div data-desk-pan className="desk-pan" style={panStyle}>
              <div data-desk-zoom className="desk-zoom" style={zoomStyle}>
                <div
                  data-desk-stack
                  data-locale={locale}
                  className="desk-stack"
                  onAnimationEnd={onStackAnimationEnd}
                  onPointerDown={onStackPointerDown}
                  onPointerMove={onStackPointerMove}
                  onPointerUp={onStackPointerUp}
                  onPointerCancel={onStackPointerCancel}
                >
                  {slots.map((slot) => {
                    const shellId = stacked ? order[slot] : 0;
                    const offset = shellOffsetForSlot(slot);
                    // The pages derive from the turn's TARGET page while a
                    // turn is in flight: the traveling sheet keeps showing
                    // the page it physically carries, the revealed sheet
                    // keeps the page it already showed, and every change
                    // lands on covered slots — so the settle repaints
                    // nothing. The step wraps (the stack is a cycle).
                    const effectivePage = wrapPage(
                      page + (turn ? (turn.dir === "next" ? 1 : -1) : 0),
                      total,
                    );
                    const shellPage = stacked
                      ? pageForShellSlot(effectivePage, total, slot, SHELL_COUNT)
                      : 1;
                    const isTop = slot === 0;
                    const isTraveler = turn !== null && shellId === turn.traveler;
                    // Where this shell sits at the END of the gesture: its
                    // new slot's resting pose. The traveler animates from
                    // its old seat (--from-*) to here; the staying sheets
                    // hold --from-* until the landing beat, then close rank
                    // to here.
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
                          ref={isTop ? attachPaperRef : undefined}
                        >
                          {shellPage === null ? (
                            // Blank paper: the stack's peek, nothing printed.
                            <div className="desk-face" aria-hidden="true" />
                          ) : (
                            <div className="desk-face">
                              {/* The head is page-aware (v0.27 原稿 §4.3,
                                  v0.28 letterhead): the FIRST page opens
                                  with the letterhead — the wordmark over the
                                  file's three identity lines (clock · bare
                                  category · shelf, each omitted when its
                                  data does not exist); every page after it
                                  carries only the running line. The head
                                  lives on the physical shell, so shellPage
                                  drives the swap — the paging mechanism is
                                  untouched. */}
                              {shellPage === 1 ? (
                                <header className="desk-masthead">
                                  <p className="desk-wordmark">Previously</p>
                                  <div className="desk-masthead-info">
                                    {head.clock !== null && (
                                      <span className="desk-masthead-time">
                                        {head.clock}
                                      </span>
                                    )}
                                    {head.category !== null && (
                                      <span className="desk-masthead-cat">
                                        {head.category}
                                      </span>
                                    )}
                                    {head.shelf !== null && (
                                      <span className="desk-masthead-line">
                                        {head.shelf}
                                      </span>
                                    )}
                                  </div>
                                </header>
                              ) : (
                                <header className="desk-runhead">
                                  <span className="desk-runhead-ref">
                                    {/* The dossier's line is its fixed
                                        English name (no case ref); a
                                        record's is the slice id (set as
                                        caseRef by the model); a case's its
                                        ref. */}
                                    {model.kind === "dossier" && model.dossier
                                      ? DOSSIER_NAMES[model.dossier]
                                      : (model.caseRef ?? model.title)}
                                  </span>
                                  <span className="desk-runhead-time">
                                    {model.date}
                                  </span>
                                </header>
                              )}

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
                                        <div className="desk-flow">
                                          <DocRefProvider value={docRefCtx}>
                                            {flow}
                                          </DocRefProvider>
                                        </div>
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

                              <footer className="desk-foot">
                                {/* The folio alone (v0.28): the hotel left
                                    the paper — no place line — and the
                                    category moved up into the letterhead,
                                    so the footer carries only the page
                                    number, centred, fixed form. */}
                                <span className="tabular-nums">
                                  · {shellPage} ·
                                </span>
                              </footer>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* THE PAGE CONTROL (v0.29: two turn buttons, NO readout) — the stack
          is a cycle: turn back / turn forward, past either end the other
          end's sheet arrives. Nothing prints a position or a total — the
          folio on the sheet itself is the only page indicator, true by
          construction. The buttons disable only while a turn is in flight
          (the cycle has no edges to guard). Floating with the app's other
          chrome: the bottom-left corner itself is the world gate's seat
          (z-20 at the pane root), so the control stacks one bar-height
          above it (bottom-14) — both stay clickable. It also lives OUTSIDE
          the desk's pane branch, which the pane caps at z-10: under the
          gate even a z-50 control would lose every hit test, so it renders
          through a body-level portal (page state stays here, where it is
          owned). */}
      {ready && total > 1 &&
        createPortal(
          <div
            data-page-controls
            className="pointer-events-none fixed bottom-27 left-2 z-30 md:bottom-14 md:left-4"
          >
            <div className={`${ISLAND_BAR} pointer-events-auto gap-0.5 px-1`}>
              <button
                type="button"
                data-page-prev
                aria-label={texts.prevPage}
                disabled={turn !== null}
                onClick={() => turnPage("prev")}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <ChevronLeft className="size-4 shrink-0" />
              </button>
              <button
                type="button"
                data-page-next
                aria-label={texts.nextPage}
                disabled={turn !== null}
                onClick={() => turnPage("next")}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <ChevronRight className="size-4 shrink-0" />
              </button>
            </div>
          </div>,
          document.body,
        )}
      {/* THE ZOOM ISLAND (v0.28 zoom chrome; banded v0.30) — the reader's
          camera gestures are banded now (see the module header): `−`/`+`
          step one stop, the readout prints the current stop and activating
          it fits the whole page (the `0` key's visible twin). Same
          floating-island idiom as the page bar, stacked one bar-height +
          the grid's 4px gap ABOVE it in the bottom-left column (mobile
          bottom-37 = 108+36+4, desktop bottom-24 = 56+36+4 — the
          grid-derived seat, not a magic number). No aria-live: the stop
          text only changes on a gesture, and a polite region would be
          noise; the static aria-label carries the affordance. Body portal
          for the same reason as the page bar: the pane caps its branch at
          z-10, under the world gate.
          Z-ORDER (fixed 2026-10-15): the desk's own islands sit at z-30 —
          above the gate's z-20 and the paper's z-10, and BELOW the expanded
          conversation panel's z-40, which used to be covered by them; the
          app's chrome stays at z-50, above everything. Raise neither island
          past 30 without re-reading the panel's own contract. */}
      {ready &&
        createPortal(
          <div
            data-zoom-controls
            className="pointer-events-none fixed bottom-37 left-2 z-30 md:bottom-24 md:left-4"
          >
            <div className={`${ISLAND_BAR} pointer-events-auto gap-0.5 px-1`}>
              <button
                type="button"
                data-zoom-out
                aria-label={texts.zoomOut}
                disabled={zoomView.atMin}
                onClick={() => zoomStep(-1)}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <Minus className="size-4 shrink-0" />
              </button>
              <button
                type="button"
                data-zoom-readout
                aria-label={texts.zoomReset}
                onClick={zoomReset}
                className={`${ISLAND_CONTROL} min-w-10 px-1 font-mono text-xs tabular-nums`}
              >
                {zoomView.text}
              </button>
              <button
                type="button"
                data-zoom-in
                aria-label={texts.zoomIn}
                disabled={zoomView.atMax}
                onClick={() => zoomStep(1)}
                className={`${ISLAND_CONTROL} size-7 disabled:pointer-events-none disabled:opacity-40`}
              >
                <Plus className="size-4 shrink-0" />
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
