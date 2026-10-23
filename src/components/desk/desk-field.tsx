"use client";

/**
 * A fixed A4 document over the paused world. Print geometry never responds
 * to viewport size: only the viewing scale and pan change. The initial
 * view fits the whole sheet; zooming reads the same lines at a closer
 * distance. Page shuffling and cyclic navigation preserve the existing
 * paper interaction, with a constant body frame on every page.
 *
 * The shell owns pause/resume and the place the paper came from. This
 * reader only calls openDesk/closeDesk; it never moves the world itself.
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
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { useShell } from "@/components/shell/shell-provider";
import {
  clampViewCentre,
  dragPanBy,
  panBoundsFor,
  type DeskCameraState,
} from "@/lib/timeline3d/desk-camera";
import { formatDeskZoom } from "./desk-zoom";
import {
  fitPaperZoom,
  PAPER_HEIGHT,
  PAPER_WIDTH,
  PAPER_ZOOM_MAX,
  paperPageCount,
  paperZoomAtMin,
  stepPaperZoom,
} from "./paper-view";
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
  /** Put down the paper; the shell restores its original world or index. */
  close?: string;
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
  /** Accessible reading position; the printed folio remains on the sheet. */
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

function createPaperCamera(zoom = 1): DeskCameraState {
  return { zoom, zoomTarget: zoom, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } };
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

export function DeskField({
  docRef,
  reducedMotion,
  texts,
  leaving = false,
}: {
  /** The open document's reference (`deskDoc` — never null here: app-shell
   *  mounts the desk only when a ref is set). */
  docRef: string;
  /** Legacy shell prop. The paper now centres in its own reading viewport. */
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
    const actual = paperPageCount(el.scrollWidth, w);
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

  // The print sheet is fixed. Zoom is its real CSS scale, independent of
  // paper layout and the shell's camera. Fit mode alone follows resizing.
  const cameraRef = useRef<DeskCameraState>(createPaperCamera());
  const fitModeRef = useRef(true);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef({ w: 0, h: 0 });
  const [panTick, setPanTick] = useState(0);
  const [zoomView, setZoomView] = useState({ text: formatDeskZoom(1), atMin: false, atMax: false });
  const syncZoomView = useCallback(() => {
    const zoom = cameraRef.current.zoomTarget;
    const fit = fitPaperZoom(viewRef.current.w, viewRef.current.h);
    setZoomView({ text: formatDeskZoom(zoom), atMin: paperZoomAtMin(zoom, fit), atMax: zoom >= PAPER_ZOOM_MAX - 0.001 });
  }, []);
  const clampCameraPan = useCallback((cam: DeskCameraState): DeskCameraState => {
    const view = viewRef.current;
    const bounds = panBoundsFor(PAPER_WIDTH, PAPER_HEIGHT, view.w, view.h, cam.zoomTarget);
    return { ...cam, panTarget: clampViewCentre(cam.panTarget, bounds) };
  }, []);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      viewRef.current = { w: el.clientWidth, h: el.clientHeight };
      cameraRef.current = fitModeRef.current
        ? createPaperCamera(fitPaperZoom(el.clientWidth, el.clientHeight))
        : clampCameraPan(cameraRef.current);
      syncZoomView();
      setPanTick((tick) => tick + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clampCameraPan, syncZoomView]);
  const zoomStep = useCallback((dir: 1 | -1) => {
    fitModeRef.current = false;
    const cam = cameraRef.current;
    const zoom = stepPaperZoom(cam.zoomTarget, dir, fitPaperZoom(viewRef.current.w, viewRef.current.h));
    cameraRef.current = clampCameraPan({ ...cam, zoom, zoomTarget: zoom });
    syncZoomView();
  }, [clampCameraPan, syncZoomView]);
  const zoomReset = useCallback(() => {
    fitModeRef.current = true;
    cameraRef.current = createPaperCamera(fitPaperZoom(viewRef.current.w, viewRef.current.h));
    syncZoomView();
  }, [syncZoomView]);
  const panBy = useCallback((dx: number, dy: number) => {
    cameraRef.current = clampCameraPan(dragPanBy(cameraRef.current, dx, dy));
    setPanTick((tick) => tick + 1);
  }, [clampCameraPan]);

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
    fitModeRef.current = true;
    cameraRef.current = createPaperCamera(fitPaperZoom(viewRef.current.w, viewRef.current.h));
    setEntered(false);
  }
  useEffect(() => syncZoomView(), [docRef, syncZoomView]);

  // THE COUNT IS READ, NOT PLANNED (v0.29). The top sheet's flow container
  // stays one page wide; with `column-fill: auto` the browser fragments the
  // whole flow into page-height columns on demand, letting the excess
  // overflow the box horizontally — so scrollWidth / pageW is the exact
  // filled-column count. Print CSS allows long blocks to fragment instead
  // of treating clipped vertical overflow as another empty page. The
  // attach callback covers late mounts; this effect covers content and
  // font changes. INERT WHILE A TURN IS IN FLIGHT: every input is frozen
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

  // At reading distance the wheel moves across the fixed paper. When the
  // whole sheet fits, its established wheel gesture turns the stack.
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
          zoomStepRef.current(-1);
        } else if (zoomAcc <= -WHEEL_ZOOM_THRESHOLD_PX) {
          zoomAcc = 0;
          zoomStepRef.current(1);
        }
        return;
      }
      zoomAcc = 0;
      const view = viewRef.current;
      const bounds = panBoundsFor(PAPER_WIDTH, PAPER_HEIGHT, view.w, view.h, cameraRef.current.zoomTarget);
      if (bounds.x > 0 || bounds.y > 0) {
        e.preventDefault();
        panBy(-e.deltaX, -e.deltaY);
        return;
      }
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
  }, [ready, total, panBy]);

  /** `+`/`=` and `-` step zoom, `0` fits the whole page. Up/down pan;
   *  shift-left/right reach the sides without changing pages. Callers guard
   *  modifiers (ctrl/cmd+= is the browser's own zoom) and editable targets
   *  (a `+` typed into the floating chat is text). */
  const applyZoomKey = useCallback(
    (key: string, shiftKey = false): boolean => {
      if (key === "+" || key === "=") {
        zoomStep(1);
      } else if (key === "-") {
        zoomStep(-1);
      } else if (key === "0") {
        zoomReset();
      } else if (key === "ArrowDown" || key === "ArrowUp") {
        panBy(0, key === "ArrowDown" ? -60 : 60);
      } else if (shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
        panBy(key === "ArrowRight" ? -60 : 60, 0);
      } else {
        return false;
      }
      return true;
    },
    [zoomStep, zoomReset, panBy],
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
      if (editableTarget(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeDesk();
      } else if (!(e.ctrlKey || e.metaKey || e.altKey) && applyZoomKey(e.key, e.shiftKey)) {
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        turnPage("next");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        turnPage("prev");
      }
    },
    [closeDesk, turnPage, applyZoomKey],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || editableTarget(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeDesk();
      } else if (!(e.ctrlKey || e.metaKey || e.altKey) && applyZoomKey(e.key, e.shiftKey)) {
        e.preventDefault();
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        turnPageRef.current(e.key === "ArrowRight" ? "next" : "prev");
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
    canPan: boolean;
    canSwipe: boolean;
  } | null>(null);
  const onStackPointerDown = useCallback((e: ReactPointerEvent) => {
    if ((e.target as Element).closest("button, a, input, textarea, [contenteditable=true]")) return;
    // Mouse text selection remains native. Alt/middle drag pans; touch and
    // pen drag pan when zoomed, or turn the sheet when it fits.
    if (e.pointerType === "mouse" && (e.button === 1 || e.altKey)) e.preventDefault();
    dragRef.current = {
      x: e.clientX, y: e.clientY, id: e.pointerId, panned: false,
      canPan: e.pointerType !== "mouse" || e.button === 1 || e.altKey,
      canSwipe: e.pointerType !== "mouse",
    };
  }, []);
  const onStackPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== e.pointerId || !drag.canPan) return;
      const cam = cameraRef.current;
      const view = viewRef.current;
      if (view.w <= 0) return;
      const bounds = panBoundsFor(
        PAPER_WIDTH,
        PAPER_HEIGHT,
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
      if (start.canSwipe &&
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
  const givewayStyle = { "--desk-giveway-x": "0px" } as CSSProperties;
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
            .desk-pan the drag (no transition, so it tracks the pointer),
            and .desk-zoom the viewing scale. Neither changes print layout. */}
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
                        aria-hidden={!isTop || undefined}
                        inert={!isTop}
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
                                        ref={isTop ? attachPagesRef : undefined}
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
      {createPortal(
        <div className="desk-toolbar" data-desk-toolbar>
          <div className="desk-toolbar-group" data-page-controls>
            <button type="button" data-page-prev aria-label={texts.prevPage} title={texts.prevPage}
              disabled={!ready || total <= 1 || turn !== null} onClick={() => turnPage("prev")} className="desk-tool-button">
              <ChevronLeft className="size-4" />
            </button>
            <span className="desk-page-position" aria-label={texts.pagePosition?.(page, total)}>{page} / {total}</span>
            <button type="button" data-page-next aria-label={texts.nextPage} title={texts.nextPage}
              disabled={!ready || total <= 1 || turn !== null} onClick={() => turnPage("next")} className="desk-tool-button">
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="desk-toolbar-group" data-zoom-controls>
            <button type="button" data-zoom-out aria-label={texts.zoomOut} title={texts.zoomOut}
              disabled={!ready || zoomView.atMin} onClick={() => zoomStep(-1)} className="desk-tool-button">
              <Minus className="size-4" />
            </button>
            <button type="button" data-zoom-readout aria-label={texts.zoomReset} title={texts.zoomReset}
              onClick={zoomReset} className="desk-tool-button desk-tool-readout">{zoomView.text}</button>
            <button type="button" data-zoom-in aria-label={texts.zoomIn} title={texts.zoomIn}
              disabled={!ready || zoomView.atMax} onClick={() => zoomStep(1)} className="desk-tool-button">
              <Plus className="size-4" />
            </button>
          </div>
          <button type="button" data-desk-close onClick={closeDesk} className="desk-tool-button desk-tool-close"
            aria-label={texts.close ?? texts.regionLabel} title={texts.close ?? texts.regionLabel}><X className="size-4" /></button>
        </div>, document.body,
      )}
    </>
  );
}
