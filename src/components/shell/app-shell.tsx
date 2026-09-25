"use client";

/**
 * AppShell (v0.11; rehomed to `/app` in v0.13 §3.1) — the app route's shell:
 * the left time axis (AxisBand), the one shared world canvas (the card field
 * and the hotel), the world transition machine, and the zoom rung. Product
 * navigation is IN-MEMORY state; the URL carries none of it.
 *
 * WHAT MOVED OUT (§3.1). The CONVERSATION LAYER used to render HERE — the
 * two-tier panel with ChatPage inside, plus the portal slots the
 * conversation field reached its seat through. It is now a real floating
 * layer mounted by the LAYOUT (`chat/conversation-overlay.tsx`): a sibling
 * of this route, above the canvas by z-index, surviving navigation and world
 * rebuilds. The state the layer and this shell SHARE moved up with it into
 * `shell/shell-provider.tsx` — the panel tier, the shared slice cursor, the
 * per-turn view getter (`getChatView`), the world-freeze signal
 * (`worldFrozen`, which still arrives here as the canvas's `paused`), the
 * one band feed, and the composer clearance. What stays HERE is the world's
 * half: the canvas, the rung, the transition clock, the card catalog, and
 * the pane's portal slot for the conversation field. The shell registers a
 * `WorldDriver` with the provider on mount (the nav actions' world-motion
 * halves, the pose read, the turn callbacks) and pushes its pose / feed
 * lease / `?at=` suppression up as they change — the layout talks to the
 * world through that channel; it does not own it.
 *
 * Catalog loading is lazy: the timeline data layer (catalog window + strand
 * list) is fetched on the first switch to a card rung. Addressing a slice
 * (terminal entrance, card click) loads the full catalog so the slice is
 * always resolvable.
 *
 * THE URL IS DEV-ONLY. The only query params anyone reads are the debug
 * gallery's (`?view=game&debug=rooms&page=&skin=`, game-shell.tsx) and the
 * playground route's — never product navigation. `?view=game` is read ONCE
 * as the cold-boot world (so the gallery link still opens the hotel); it is
 * never written back and never reconciled. `?at=`/`?atStart=` remain a
 * cold-boot conversation deep link consumed once by ChatPage (chat-page.tsx,
 * now in the layout's overlay) — a shared link still lands on its slice, but
 * nothing inside the session ever produces one.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useReducedMotion } from "motion/react";
import { AnimatePresence, animate, motion } from "motion/react";
import { useTranslations, useLocale } from "next-intl";
import { Hotel, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { FieldRung } from "@/lib/timeline3d/units";
import {
  applyEvolutionActivity,
  EVOLUTION_PRESENCE_IDLE,
  EvolutionToastDedupe,
  evolutionToastContent,
  subscribeEvolutionActivity,
} from "@/lib/chat/evolution-activity";
import {
  DISSOLVE_START,
  transitionPhase,
  WORLD_TRANSITION,
  WORLD_TRANSITION_MS,
  WORLD_TRANSITION_REDUCED_MS,
  type WorldTransitionPhase,
} from "@/lib/timeline3d/world-transition";
import {
  getStrandList,
  getTimelineCatalog,
  getTimelineCatalogPage,
  type StrandListItem,
} from "@/lib/episodic/actions";
import { invalidateHotelData } from "@/lib/game/hotel-data";
import { DEFAULT_RUNG } from "@/lib/chat/deep-link";
import { requestSliceJump } from "@/lib/chat/slice-jump";
import { useShellNav } from "@/components/shell/shell-nav";
import {
  useShell,
  type WorldDriver,
} from "@/components/shell/shell-provider";
import { ISLAND } from "@/components/layout/island";
import { useChromeInset } from "@/hooks/use-chrome-inset";
import { useBridgeBrainActive } from "@/hooks/use-bridge-brain";
import { useTier } from "@/hooks/use-tier";
import { AxisBand, JumpControls } from "@/components/timeline-3d/axis-band";
import { BoardBar } from "@/components/shell/board-bar";
import { TimelineScene } from "@/components/timeline-3d/timeline-scene";
import { TimelineFallback } from "@/components/timeline-3d/timeline-fallback";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import {
  AtmosphereBackdrop,
  TIMELINE_KEYFRAMES,
} from "@/components/timeline-3d/atmosphere";

// THE CANVAS AND THE GAME LOAD AS THEIR OWN CHUNKS (§13.2): the shared
// canvas pulls in three/fiber, the game its postprocessing chain — a visitor
// who never leaves the conversation pays neither. Both are client-only
// (WebGL), so ssr: false exactly like the canvases they replace.
const WorldCanvas = dynamic(
  () =>
    import("@/components/timeline-3d/world-canvas").then((m) => m.WorldCanvas),
  { ssr: false, loading: () => null },
);
// The provider half is plain context — safe to import statically (and it must
// be the same module instance as the canvas's).
import { WorldSceneProvider } from "@/components/timeline-3d/world-slot";
const GameShell = dynamic(
  () => import("@/components/game/game-shell").then((m) => m.GameShell),
  { ssr: false, loading: () => null },
);
import {
  CompanionPod,
  type NarrationTarget,
} from "@/components/companion/companion-pod";

/** The rung-switch slide's travel, px (world units at the z=0 plane — the
 *  field camera's 1:1 screen mapping, camera.ts). Pre-merge value, restored
 *  (556ae16 took the slide out with the per-pane canvases; §14's single
 *  canvas moves the CAMERA instead of the DOM layer — same gesture). */
const RUNG_SLIDE_X = 24;

/** The data-hold's bound (ms): how long a move into the field may wait at
 *  the dissolve threshold for the catalog before proceeding into the
 *  destination's fallback skeleton. An unbounded hold would pin
 *  WORLD_TRANSITION.active — the input gate — forever when the catalog
 *  fetch fails (see the clock's exception-path note). */
const TRANSITION_DATA_WAIT_MS = 8000;

export function AppShell() {
  // THE URL IS DEV-ONLY. `?view=game` is read ONCE, as the cold-boot world,
  // so the debug gallery's link (`?view=game&debug=rooms`, game-shell.tsx)
  // still opens straight into the hotel. Nothing else reads the query string
  // here and nothing ever writes it: a refresh returns to the field at the
  // conversation rung, exactly like a fresh visit.
  const searchParams = useSearchParams();
  const [settledView, setSettledView] = useState<WorldKind>(() =>
    searchParams.get("view") === "game" ? "game" : "field",
  );

  // ── THE SHARED CHANNEL (shell-provider.tsx, layout level) ───────────────
  // Everything the conversation overlay and this shell both read or write:
  // the panel tier (the overlay renders it; this shell derives the per-world
  // default and consumes the freeze), the shared slice cursor, the one band
  // feed, the composer's measured clearance, and the registration channels
  // for the world driver / pose / feed lease below.
  const {
    panelMode,
    setPanelMode,
    worldFrozen,
    sharedSlice,
    reportCursor,
    getCursor,
    feed,
    composerClearance,
    setPaneSlotEl,
    registerWorldDriver,
    setWorldPose,
    setFeedPublishing,
    setSuppressAtJump,
  } = useShell();
  // The provider-owned nav actions (cursor + the driver registered below) —
  // handed to the card field as its slice-click prop.
  const nav = useShellNav();

  // THE WORLD SWITCH (§14) — a TRANSITION, never a snap, and PURE STATE: no
  // URL leg, no reconciliation. `settledView` is the world the reader is in;
  // `transition` is a live move between the worlds (owned by the shell,
  // driven per frame by world-transition.ts). The shared slice address lives
  // in the provider now; it is consumed two ways: the field focuses the
  // slice's card (its `initialAtId` — flashed), the game stands the reader
  // at the slice's door (game-canvas.tsx's `focusSlice`). The provider's
  // navigation actions (shell-nav.ts) compose the cursor write with this
  // transition machine, through the driver registered below.
  const [transition, setTransition] = useState<{
    from: WorldKind;
    to: WorldKind;
    sliceId: string | null;
    phase: WorldTransitionPhase;
  } | null>(null);
  const view: WorldKind = settledView;
  const mountedWorlds: readonly WorldKind[] = transition
    ? [transition.from, transition.to]
    : [settledView];
  const transitionActive = transition !== null;
  const reducedMotion = useReducedMotion() ?? false;

  // ── Shared timeline state (owned by the shell so the left AxisBand and the
  //    right pane read the same values). ────────────────────────────────────
  //
  // THE FEED IS ONE OBJECT WITH ONE WRITER (`lib/timeline3d/field-feed.ts`),
  // created by the PROVIDER (above both this shell and the overlay's chat
  // stream). Both fields are mounted whenever the timeline view is open — the
  // chat one dimmed behind the other — and they used to publish into four
  // shared refs with no ownership rule between them, so the band's position
  // came down to which of the two rendered last. `panePublishes` below is the
  // whole rule; the lease reaches the overlay as `publishing`.
  /** The zoom rung, owned here so the floating lens switcher reads the same
   *  value CardField transitions through. Memory-only: a bare `/app` always
   *  opens on `DEFAULT_RUNG` — the CONVERSATION, exactly as it always has.
   *  (The card field's own default is `day`; that is the right default for
   *  someone who asked for the timeline and the wrong one for someone who
   *  just opened the app.) */
  const [rung, setRung] = useState<FieldRung>(DEFAULT_RUNG);

  // `Cmd/Ctrl+.` — the shortcut the deleted mode switcher owned. Kept because
  // it is the fastest round trip between the cards and the conversation, and it
  // now does something better than a fixed jump: it returns you to the card
  // rung you were last on, so it is a toggle rather than a reset.
  const lastCardRungRef = useRef<FieldRung>("slice");
  useEffect(() => {
    if (rung !== "conversation") lastCardRungRef.current = rung;
  }, [rung]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      e.preventDefault();
      setRung((r) =>
        r === "conversation" ? lastCardRungRef.current : "conversation",
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** The strand picks, in the order they were added. An EMPTY list is 核心时间线
   *  — the unfiltered timeline — which is why this is a list and not a nullable
   *  name: "nothing selected" is a real state, not the absence of one. */
  const [strands, setStrands] = useState<string[]>([]);
  const [strandList, setStrandList] = useState<StrandListItem[]>([]);
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [oldestMonth, setOldestMonth] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [timelineReady, setTimelineReady] = useState(false);
  const loadingRef = useRef(false);
  /** A turn is streaming. Reported by the overlay's `ChatPage` through the
   *  driver (it is the only half that knows — `useChat`'s `isLoading`); the
   *  card field draws its abstract placeholder from it. See `RunningCard`. */
  const [running, setRunning] = useState(false);

  // ── THE WORLD TRANSITION MACHINE (world-transition.ts) ────────────────────
  // The shell owns the move: WHICH worlds are mounted (one settled, two
  // mid-move) and the rAF clock that writes the shared singleton's progress.
  // Everything inside the canvas (the scripted hotel shot, the compositor's
  // dissolve, the contract pin) reads the singleton per frame; React state
  // only mirrors the phase boundaries. The machine is PURE STATE — nothing
  // here reads or writes the URL.
  //
  // THE INPUT-GATE INVARIANT. WORLD_TRANSITION.active freezes the hotel's
  // keyboard (game-canvas.tsx's movement gate), so it must be false exactly
  // when no move is running. It is therefore cleared in ONE place only —
  // settleMove() — and settleMove() runs on EVERY path that ends a move:
  //   · the completion tick (finish),
  //   · the clock effect's cleanup — an interrupt that starts a new move,
  //     a mid-flight reversal, or the shell unmounting,
  //   · an exception in the tick (the catch ends the move).
  // The guard is WORLD_TRANSITION.id: a reversal bumps id in startMove
  // BEFORE the outgoing clock's cleanup runs, so an outgoing settle can
  // never clear a newer move's gate. beginTransition() never clears the
  // flag and never leaves it set without a live clock behind it — every
  // early return happens before the singleton is touched. A stuck gate is
  // structurally impossible: either a clock is running (the flag is
  // wanted), or the clock has stopped and its cleanup settled the move.
  const transitionRef = useRef<{
    from: WorldKind;
    to: WorldKind;
    sliceId: string | null;
    phase: WorldTransitionPhase;
  } | null>(null);
  /** THE "WHERE WAS I" MEMORY (v0.13 §6): the cursor's value when the reader
   *  last LEFT the world for the cards — written in startMove on every
   *  game → field move. The card gate's 回到原来的房间 is the one return
   *  that restores it instead of moving the cursor. */
  const prevRoomCursorRef = useRef<string | null>(null);
  const settledRef = useRef<WorldKind>(view);
  const readyRef = useRef(false);
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    settledRef.current = settledView;
  }, [settledView]);
  useEffect(() => {
    readyRef.current = timelineReady;
  }, [timelineReady]);
  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  /** THE SINGLE EXIT — see the invariant above. Id-guarded: only the move
   *  that owns WORLD_TRANSITION.id may clear the gate, so an outgoing
   *  clock's cleanup (reversal, interrupt, unmount) can never clear the
   *  flag a newer move just set. Idempotent — safe to run twice. */
  const settleMove = useCallback((id: number) => {
    const wt = WORLD_TRANSITION;
    if (wt.id !== id) return;
    wt.active = false;
    wt.progress = 0;
    transitionRef.current = null;
  }, []);

  const startMove = useCallback(
    (from: WorldKind, to: WorldKind, sliceId: string | null) => {
      const wt = WORLD_TRANSITION;
      wt.active = true;
      wt.id += 1;
      wt.from = from;
      wt.to = to;
      wt.progress = 0;
      wt.reducedMotion = reducedMotionRef.current;
      if (from === "game") {
        // THE "WHERE WAS I" MEMORY (v0.13 §6): leaving the world remembers
        // the cursor as it stands — walking has been keeping it current, so
        // this is the room the reader was last in. The card gate's
        // 回到原来的房间 restores exactly this value. Read through
        // `getCursor` (the provider's synchronously-written ref): an exit
        // fired in the same beat as the room's cursor report can outrun the
        // render pipeline, and a render-mirrored value would read stale.
        prevRoomCursorRef.current = getCursor();
      }
      if (to === "field") {
        // Seed the destination's card rung while the hotel still owns the
        // screen — the dissolve then reveals cards, never an empty canvas
        // (the field world mounts nothing at the conversation rung; its
        // scene is the card field's). A terminal entrance lands on the
        // slice rung at the terminal's slice; a plain exit (the game's
        // exit button, Escape) lands where the reader last looked at
        // cards — the same last-card-rung the ⌘/. toggle returns to.
        setRung(sliceId !== null ? "slice" : lastCardRungRef.current);
      }
      const t = {
        from,
        to,
        sliceId,
        phase: "camera" as WorldTransitionPhase,
      };
      transitionRef.current = t;
      setTransition(t);
    },
    [getCursor],
  );

  const beginTransition = useCallback(
    (to: WorldKind, sliceId: string | null) => {
      const live = transitionRef.current;
      if (live) {
        // A move is already running. The same destination is a no-op (the
        // live move lands there — repeated Enter, Exit pressed twice).
        // The OTHER world is a REVERSAL mid-flight: the live move's
        // destination becomes the departure world and the dissolve simply
        // crosses back (Escape/Exit pressed while the hotel mounts). The
        // outgoing clock's cleanup will call settleMove with the stale id
        // and no-op — the gate stays live for the new move.
        if (live.to === to) return;
        startMove(live.to, to, sliceId);
        return;
      }
      const from = settledRef.current;
      if (from === to) return;
      startMove(from, to, sliceId);
    },
    [startMove],
  );

  // Read-anywhere mirror of the rung for the navigation callbacks below.
  const rungRef = useRef<FieldRung>(rung);
  useEffect(() => {
    rungRef.current = rung;
  }, [rung]);

  // ── THE WORLD'S HALF OF THE NAVIGATION ACTIONS (shell-nav.ts) ───────────
  // The memory form of the old `?slice=` / `?at=` contract, split in two by
  // §3.1: the CURSOR half (writing the shared slice address) lives in the
  // provider, because the conversation layer — the other reader of that
  // address — lives at the layout now. What stays HERE is the WORLD MOTION:
  // which world to move to, which rung to seed, and the conversation jump's
  // bus ride. All three are pure state — no URL, no router. The provider's
  // nav actions call these through the registered driver.
  const driveFocusSlice = useCallback(
    (sliceId: string) => {
      if (transitionRef.current) return; // a move owns the rung seeding
      if (settledRef.current !== "field") {
        beginTransition("field", sliceId);
      } else {
        setRung("slice");
      }
    },
    [beginTransition],
  );
  const driveStandAtSlice = useCallback(() => {
    if (transitionRef.current) return;
    if (settledRef.current !== "game") beginTransition("game", null);
  }, [beginTransition]);
  const driveOpenSlice = useCallback(
    (sliceId: string, start?: string) => {
      // The card field's click: the provider has already addressed the slice
      // (the field focuses and flashes its card at the current rung), and
      // when the CONVERSATION is the active surface the jump itself runs
      // through the M2 bus, exactly the split the old `?at=` consumption had
      // (chat-page.tsx suppresses its deep-link jump at a card rung).
      // `start` rides the bus so the travel clock skips its resolve fetch.
      if (rungRef.current === "conversation") requestSliceJump(sliceId, start);
      if (transitionRef.current) return;
      if (settledRef.current !== "field") beginTransition("field", null);
    },
    [beginTransition],
  );
  /** The live pose for the provider's two readers: the surface composition
   *  (via the pushed pose below) and the send-time view getter (via this
   *  ref read — the transport asks outside React's render). A mid-move read
   *  reports the SETTLED world: that is where the reader stands. */
  const getPose = useCallback(
    () => ({ settled: settledRef.current, rung: rungRef.current }),
    [],
  );

  // The room → catalog entrance: the terminal interaction fires this after
  // its depart flare (world-transition.ts's hook), and the move starts
  // here — replacing the interaction's old instant anchorNavPlan jump.
  useEffect(() => {
    WORLD_TRANSITION.hooks.enter = (sliceId) =>
      beginTransition("field", sliceId);
    return () => {
      WORLD_TRANSITION.hooks.enter = null;
    };
  }, [beginTransition]);

  // ── THE CONVERSATION LAYER'S TIER (v0.13 §4 — two tiers) ────────────────
  // The tier itself lives in the PROVIDER (the layout-level overlay renders
  // it). This shell only derives the per-world default, exactly as before:
  // the game world and the card rungs default to the pill, the conversation
  // rung to fullscreen — and FULLSCREEN freezes the card field's frame loop
  // (the provider's `worldFrozen` → the canvas's `paused` →
  // frameloop="never", below). The provider's INITIAL tier already matches
  // the cold-boot verdict (it reads `?view=game` once, and DEFAULT_RUNG is a
  // constant), so the mount fire is SKIPPED — otherwise re-entering `/app`
  // from another route would reset a tier the reader picked. The effect then
  // fires only on the world boundary: zooming BETWEEN card rungs keeps the
  // tier the reader picked.
  //
  // …with one arrival exception: a CLIENT navigation straight into the hotel
  // (the home's 进入世界 door, `/app?view=game`) brings whatever tier the
  // provider persisted, and the hotel must open on the pill. The provider's
  // initializer never sees that case (it runs once, at the layout's mount),
  // so this layout effect folds the tier BEFORE the first paint — a passive
  // effect would flash the fullscreen body (and its portal target) over the
  // hotel for one frame. On a cold boot the provider already holds "pill"
  // and this is a same-value no-op.
  useLayoutEffect(() => {
    if (settledRef.current === "game") setPanelMode("pill");
    // Mount only — `settledRef` still holds the ARRIVAL world here; later
    // world changes are the boundary effect's job.
  }, [setPanelMode]);
  const worldKind = rung === "conversation" ? "conversation" : "cards";
  const tierBoundaryRef = useRef(false);
  useEffect(() => {
    if (!tierBoundaryRef.current) {
      tierBoundaryRef.current = true;
      return;
    }
    // The game world is a LOOKING view like the card rungs — the conversation
    // arrives as the pill there too.
    setPanelMode(
      view === "game" || worldKind !== "conversation" ? "pill" : "fullscreen",
    );
  }, [worldKind, view, setPanelMode]);

  // THE TRANSITION CLOCK — one rAF per move writes the shared singleton's
  // progress; React state only mirrors the phase boundaries (2–3 re-renders
  // a move, not 60/s), and the per-frame readers (the scripted hotel shot,
  // the compositor's dissolve and contract pin) stay inside the canvas. The
  // primitives are destructured so the clock does NOT restart on a phase
  // boundary re-render — restarting would reset the elapsed baseline.
  const transitionFrom = transition?.from;
  const transitionTo = transition?.to;
  const transitionSlice = transition?.sliceId;
  useEffect(() => {
    if (transitionFrom === undefined || transitionTo === undefined) return;
    const duration = WORLD_TRANSITION.reducedMotion
      ? WORLD_TRANSITION_REDUCED_MS
      : WORLD_TRANSITION_MS;
    const started = performance.now();
    // The move this clock owns: settleMove(id) clears the input gate only
    // when the singleton's id still matches, so a reversal/interrupt that
    // bumped the id before this effect's cleanup runs leaves the new
    // move's gate untouched (see the machine's invariant above).
    const moveId = WORLD_TRANSITION.id;
    let raf = 0;
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      settleMove(moveId);
      setSettledView(transitionTo);
      setTransition(null);
    };
    const tick = () => {
      if (cancelled) return;
      try {
        // §14.1: a fullscreen conversation freezes the world — the move
        // holds until the panel folds back.
        if (worldFrozen) {
          raf = requestAnimationFrame(tick);
          return;
        }
        const elapsedMs = performance.now() - started;
        let p = Math.min(1, elapsedMs / duration);
        // The dissolve waits for the destination's data: hold at the
        // threshold — the hotel parked at the terminal's eye pose — until
        // the catalog has loaded enough for the field world to mount the
        // focused card. The hold is BOUNDED: a catalog fetch that failed
        // leaves the destination showing its designed fallback skeleton
        // (TimelineFallback), and an unbounded hold would pin the input
        // gate forever — the exception path must still end the move.
        if (
          transitionTo === "field" &&
          p >= DISSOLVE_START &&
          !readyRef.current &&
          elapsedMs < TRANSITION_DATA_WAIT_MS
        ) {
          p = DISSOLVE_START;
        }
        WORLD_TRANSITION.progress = p;
        const phase = transitionPhase(p);
        setTransition((prev) =>
          prev && prev.phase !== phase ? { ...prev, phase } : prev,
        );
        if (p >= 1) {
          finish();
          return;
        }
        raf = requestAnimationFrame(tick);
      } catch {
        // An exception in the clock must not orphan the move: end it
        // through the same single exit (the settled world lands on the
        // requested destination — state, not the interrupted frame, is the
        // source of truth).
        finish();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      // THE GATE ALWAYS CLEARS: completion (finish above), an interrupt or
      // reversal (a new move owns the singleton now — the id guard makes
      // this a no-op), or the shell unmounting. There is no path that stops
      // the clock without running settleMove.
      cancelled = true;
      cancelAnimationFrame(raf);
      settleMove(moveId);
    };
  }, [transitionFrom, transitionTo, transitionSlice, worldFrozen, settleMove]);

  // ── THE CONVERSATION FIELD'S PANE SLOT ───────────────────────────────────
  // The conversation layer moved to the layout (§3.1), but the field's PANE
  // SEAT stays here: the R3F band still reaches into the pane through a
  // portal, and the pane is this route's. The slot ELEMENT is owned by the
  // provider (it composes the surface from both trees' slots): this shell
  // renders the div, `setPaneSlotEl` registers it, and the `useState`-backed
  // ref re-renders the provider on registration — the same handshake
  // world-canvas.tsx uses. The element is null until the ref registers (and
  // null again the moment the field chrome unmounts, e.g. leaving `/app`),
  // and the provider never publishes a "field" surface with a null target —
  // an R3F portal handed a null/detached element dies exactly at the canvas's
  // connect.

  // Escape in the game world: panel first (anything open folds to the pill),
  // then the view itself (back to the field, through the transition). The
  // panel's own Escape lives on its container with stopPropagation, so the
  // two never fire together.
  useEffect(() => {
    if (view !== "game") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (panelMode !== "pill") setPanelMode("pill");
      else beginTransition("field", null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, panelMode, setPanelMode, beginTransition]);

  // ── 回到现在 (v0.13 §6) — an explicit JUMP, never a scroll ─────────────
  // "Now" is the live stream, not the newest card: the newest slice is NOT
  // in the card stack's reachable set (the stack is the bounded past), so
  // the corner control leaves the stack for the conversation rung and
  // clears the cursor — the default state is no slice selected (§2/§5), and
  // the next request carries no view block. At the conversation rung the
  // same corner button keeps its old seek-to-bottom, because the chat
  // field's live edge IS now.
  const returnToNow = useCallback(() => {
    reportCursor(null);
    setRung("conversation");
  }, [reportCursor]);

  // ── THE WORLD GATE (v0.13 §6) — returning to the world is a CHOICE ─────
  // The field's way into the hotel used to be a bare button that started
  // the transition. With a cursor (or a remembered one) it now offers the
  // three rulings first: 前往这个房间 (travel to the room the cursor now
  // names — the full transition beat, never a hard cut), 回到原来的房间
  // (the cursor does NOT move — the card session leaves no trace on it),
  // or 取消 (stay with the cards). With neither a cursor nor a memory the
  // gate has nothing to offer and the button keeps its old direct move.
  const [worldGateOpen, setWorldGateOpen] = useState(false);
  useEffect(() => {
    if (!worldGateOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWorldGateOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [worldGateOpen]);
  const locale = useLocale();
  // The gate's labels are inline per-locale rather than message keys:
  // messages/ belongs to another lane tonight, and the game shell's own
  // gallery chrome already carries its labels this way.
  const gateText = locale.startsWith("zh")
    ? {
        goThis: "前往这个房间",
        goBack: "回到原来的房间",
        cancel: "取消 · 继续看卡片",
      }
    : {
        goThis: "Go to this room",
        goBack: "Back to the previous room",
        cancel: "Cancel · keep reading",
      };
  const prevRoomCursor = prevRoomCursorRef.current;

  // ── THE MOUTH STREAM ──────────────────────────────────────────────────────
  // One narration at a time: each request bumps `gen`, and the pod aborts
  // the previous reader when a new target lands. The target is owned HERE
  // (not by the card field, and not by the pod — the pod streams and renders
  // it) so narration survives rung switches and view changes — the reader
  // keeps browsing while Previously speaks.
  const [narrateTarget, setNarrateTarget] = useState<NarrationTarget | null>(
    null,
  );
  const narrateGenRef = useRef(0);
  const startNarration = useCallback(
    (sliceId: string, timeLabel?: string) => {
      narrateGenRef.current += 1;
      setNarrateTarget({
        sliceId,
        timeLabel,
        gen: narrateGenRef.current,
      });
    },
    [],
  );
  // The narrate entry hides on the bridge brain — /api/companion answers 501
  // there. Tri-state: hidden until the probe resolves (never flash an entry
  // a bridge client cannot serve); cloud and BYOK clients get it.
  const bridgeBrain = useBridgeBrainActive();

  // ── THE EVOLUTION STREAM — the pod's second event source ────────────────
  // ChatPage publishes data-evolution frames onto the module-level bus; here
  // the shell folds them into the pod's presence (the button breathes while a
  // run is in flight, the panel replays the newest completion when there is
  // no narration) and fires the achievement toast on a genuine completion.
  // The toast is deduped per turn: a durable run's reconnect replay
  // redelivers the terminal frame, and it must not fire twice. Bridge brain
  // runs no inline evolution — the bus stays silent and the pod is hidden,
  // so there is nothing to clean up and no console noise.
  const tCompanion = useTranslations("companion");
  const tGame = useTranslations("game");
  const [evolution, setEvolution] = useState(EVOLUTION_PRESENCE_IDLE);
  const evolutionToastDedupe = useRef(new EvolutionToastDedupe());
  useEffect(() => {
    return subscribeEvolutionActivity((event) => {
      setEvolution((prev) => applyEvolutionActivity(prev, event));
      if (event.kind !== "done") return;
      const content = evolutionToastContent(event, {
        title: tCompanion("evolvedToast"),
        fallback: tCompanion("evolvedFallback"),
      });
      if (content && evolutionToastDedupe.current.markToasted(event.turnId)) {
        toast(content.title, {
          description: content.description,
          icon: <Sparkles className="size-4" />,
        });
      }
    });
  }, [tCompanion]);

  // ── THE PANE'S TWO FLOATING INSETS ───────────────────────────────────────
  // What the chrome covers at the top edge and what the composer covers at the
  // foot, in px. The top one is measured from the chrome itself
  // (`use-chrome-inset.ts`); the foot one is measured by the overlay's
  // composer (`composer-host.tsx`) and arrives through the PROVIDER, because
  // both fields float under the same two controls and the provider is the
  // one place above both of them.
  //
  // They are RANGE insets, not container padding: the fields fill the pane and
  // the content travels under the controls on its way past them, coming to rest
  // clear of them. A padding on the pane would crop the content instead — see
  // `minOffsetFor`.
  const chromeInset = useChromeInset();

  // NOTE — there is deliberately no `selectedCount` here any more. It was the
  // band caption's number, and it was only ever exact for a SINGLE pick: with
  // several, the counts overlap (a slice can carry two chosen strands) and
  // summing them overcounts. The board bar names the picks instead, which
  // cannot be wrong. A number that can be wrong is worse than no number.

  const toggleStrand = useCallback((name: string) => {
    setStrands((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name],
    );
  }, []);
  const clearStrands = useCallback(() => setStrands([]), []);

  const ambientStrands = useMemo(
    () => strandList.slice(0, 12).map((s) => s.name),
    [strandList],
  );

  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (entries.length === 0) return { oldest: today, now: today };
    return { oldest: entries[0].date, now: today };
  }, [entries]);

  // ── Strand list loads on mount in BOTH views (the axis focus chip lives in
  //    the always-mounted band); the catalog stays lazy for the timeline. ────
  useEffect(() => {
    if (strandList.length > 0) return;
    let cancelled = false;
    getStrandList()
      .then((strands) => {
        if (!cancelled) setStrandList(strands);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [strandList.length]);

  // ── Lazy catalog load on the first CARD rung. A slice address (the shared
  //    cursor, or a transition's terminal slice) loads the full catalog so the
  //    addressed slice is always resolvable; otherwise loads the latest month
  //    window. ───────────────────────────────────────────────────────────────
  // A live transition's slice leads: it is the field's landing focus the
  // moment the move completes.
  const focusId = transition?.sliceId ?? sharedSlice;
  useEffect(() => {
    if (rung === "conversation" || timelineReady) return;
    let cancelled = false;
    (async () => {
      try {
        if (focusId) {
          const catalog = await getTimelineCatalog();
          if (cancelled) return;
          setEntries(catalog);
          setOldestMonth(catalog[0]?.date.slice(0, 7) ?? null);
          setHasMore(false);
        } else {
          const page = await getTimelineCatalogPage(null);
          if (cancelled) return;
          setEntries(page.entries);
          setOldestMonth(page.oldestMonth);
          setHasMore(page.hasMore);
        }
        setTimelineReady(true);
      } catch {
        // A failed boot load leaves the fallback in place; the user can retry
        // by zooming out to a card rung again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rung, focusId, timelineReady]);

  /**
   * Re-read the newest catalog page after a turn settles, and APPEND.
   *
   * Appending is the whole trick, and it is not an optimisation. `rows` is
   * `groupForLevel(entries, level)`, so replacing `entries` reorders the
   * reader's list under them; and `buildOffsets` recomputes every `tops[i]`,
   * so a head that moves invalidates the one offset table everything
   * positional reads. A new slice is always the NEWEST — `groupForLevel` sorts
   * by `start` — so it can only ever land at the tail, where nothing above it
   * moves. Returning `prev` BY IDENTITY when there is nothing new is the other
   * half: React bails out, `rows` never recomputes, and a settle with no new
   * slice costs one no-op render.
   */
  const refreshCatalog = useCallback(async () => {
    try {
      const page = await getTimelineCatalogPage(null);
      // A settled turn may have written a new slice (or rewoven strands) —
      // kill the hotel's cached lane so the next game entry re-derives
      // instead of serving pre-turn doors. Bumping on every successful
      // refresh is deliberate: strand-only changes have no client-visible
      // growth signal, and an unnecessary re-fetch beats stale doors.
      invalidateHotelData();
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const newest = prev.at(-1)?.start ?? "";
        const fresh = page.entries
          .filter((e) => !have.has(e.id) && e.start > newest)
          .sort((a, b) => a.start.localeCompare(b.start));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    } catch {
      // A failed refresh is silent: the slice is on disk and the next settle,
      // or the next mount, finds it. Retrying here would fight the turn.
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingRef.current || !oldestMonth) return;
    loadingRef.current = true;
    try {
      const page = await getTimelineCatalogPage(oldestMonth);
      if (page.entries.length === 0) {
        setHasMore(false);
        return;
      }
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const older = page.entries.filter((e) => !have.has(e.id));
        return older.length > 0 ? [...older, ...prev] : prev;
      });
      setOldestMonth(page.oldestMonth);
      setHasMore(page.hasMore);
    } catch {
      // A failed prefetch is silent: the list just finds no older rows and the
      // next edge approach retries.
    } finally {
      loadingRef.current = false;
    }
  }, [hasMore, oldestMonth]);

  // ── ONE LADDER, TWO RENDERERS ─────────────────────────────────────────────
  // The rung is the navigation now; there is no view mode beside it. The
  // CONVERSATION rung is drawn by the chat's own field and the three card rungs
  // by the card field, because the two have genuinely different jobs rather
  // than two settings of one thing:
  //
  //   - the conversation rung must show the turn that is being written RIGHT
  //     NOW, which lives only in `useChat`'s messages — the card field's rows
  //     come from the persisted catalog (`groupForLevel(entries)`) and have no
  //     path to it. Giving it one means threading a streaming array through
  //     props or a store, which is the re-render storm `card-field.tsx:30-36`
  //     documents.
  //   - the card rungs must show the pile, the deal and the rung transitions,
  //     which the conversation field has no concept of.
  //
  // So: one LADDER the reader navigates, two RENDERERS behind it. The camera
  // unification the previous note here described (derive `CAM_Z` from the
  // viewport so both fields share one coordinate system) is still true and
  // still worth doing — but it is a rendering change, not a navigation one, and
  // it is not what stood between the reader and a single ladder.
  const showCardField = rung !== "conversation";
  /** True while the conversation rung is up — the pane slot's visibility
   *  switch (the field's R3F band is read in the pane there, dimmed away at
   *  a card rung). The PANEL half of the conversation is the layout overlay's
   *  business; this is only the slot's. */
  const onConversationRung = rung === "conversation";
  /** THE OWNERSHIP RULE, in one line. Exactly one pane publishes to the band at
   *  a time: the card field while a card rung is up, the chat otherwise. The
   *  other field is still mounted and still animating — it simply writes
   *  nothing, which is why this is a lease rather than a merge. The chat half
   *  lives in the overlay now, so the lease is PUSHED to the provider (below)
   *  instead of handed down as a prop. */
  const panePublishes = showCardField;

  // ── THE ROUTE → PROVIDER CHANNEL ─────────────────────────────────────────
  // Registration and pushes, all laid out in one place:
  //
  //   · the WorldDriver — the nav actions' world-motion halves, the send-time
  //     pose read, and the two turn callbacks the overlay's ChatPage reports
  //     (a settled turn refreshes the catalog; a running one draws the card
  //     field's placeholder). A ref on the provider's side: registration must
  //     not re-render the layout's subtree.
  //   · the reactive pose / feed lease / `?at=` suppression — provider STATE,
  //     because their readers (the surface composition, the overlay's
  //     ChatPage props) must re-render. Layout effects, so the push lands
  //     before paint: a passive effect would let one painted frame run with
  //     the mount defaults (both fields publishing at once is exactly what
  //     the feed's one-writer rule exists to prevent).
  //   · unmount cleans every channel back to its no-world default, so a
  //     route without a world (settings) finds no stale driver, a neutral
  //     lease, and no suppression.
  const driver = useMemo<WorldDriver>(
    () => ({
      focusSlice: driveFocusSlice,
      standAtSlice: driveStandAtSlice,
      openSlice: driveOpenSlice,
      getPose,
      onTurnSettled: refreshCatalog,
      setRunning,
    }),
    [driveFocusSlice, driveStandAtSlice, driveOpenSlice, getPose, refreshCatalog],
  );
  useEffect(() => {
    registerWorldDriver(driver);
    return () => registerWorldDriver(null);
  }, [driver, registerWorldDriver]);
  useLayoutEffect(() => {
    setWorldPose({ settled: settledView, rung });
  }, [settledView, rung, setWorldPose]);
  useEffect(() => () => setWorldPose(null), [setWorldPose]);
  useLayoutEffect(() => {
    setFeedPublishing(!panePublishes && !transitionActive);
  }, [panePublishes, transitionActive, setFeedPublishing]);
  useEffect(() => () => setFeedPublishing(true), [setFeedPublishing]);
  useLayoutEffect(() => {
    setSuppressAtJump(showCardField);
  }, [showCardField, setSuppressAtJump]);
  useEffect(() => () => setSuppressAtJump(false), [setSuppressAtJump]);

  // ── THE RUNG SLIDE (the 556ae16 regression, restored in-canvas) ──────────
  // Pre-merge, the timeline pane was a DOM layer carrying its OWN canvas, so
  // its enter/exit SLIDED the whole scene (x: 24, 0.3 s, ease-out-expo). The
  // merge moved the cards into the shell's shared canvas, which must not
  // move — and the transition degenerated to an opacity fade. The slide is
  // restored by moving the two halves together: ONE framer animation writes
  // BOTH the field camera's x offset and the DOM layer's transform every
  // tick, so the GL content and the Html card faces travel as one plane
  // (world px = screen px at the z=0 plane) — exactly like the pre-merge
  // per-pane canvas under its CSS transform. The x never rides in the
  // motion element's props: an `initial x` would hydrate differently for a
  // reduced-motion client (the server cannot know the preference), and the
  // imperative transform keeps server and client markup identical. A
  // reduced-motion reader gets opacity only, the offset pinned at 0.
  const paneSlideRef = useRef(0); // camera offset (world px)
  const paneLayerRef = useRef<HTMLDivElement | null>(null); // the DOM layer
  const setSlide = (v: number) => {
    paneSlideRef.current = v;
    const el = paneLayerRef.current;
    if (el) el.style.transform = v === 0 ? "" : `translateX(${v}px)`;
  };
  // True while the timeline layer is EXITING (the conversation rung took
  // over and AnimatePresence is playing the 0.3 s exit): the field freezes
  // on its last card rung — the world content the reader was looking at is
  // what slides out, not one frame of the conversation rung's units.
  const [timelineExiting, setTimelineExiting] = useState(false);
  // Layout effect: the snap + animation must be in place BEFORE the entering
  // world's first paint (a passive effect would let one frame flash at 0).
  useLayoutEffect(() => {
    if (showCardField) {
      setTimelineExiting(false);
      if (reducedMotion) {
        setSlide(0);
        return;
      }
      // Enter: the world appears at +24 — where the pre-merge layer's
      // initial x sat — and travels to 0 over the same 300 ms.
      setSlide(RUNG_SLIDE_X);
      const controls = animate(RUNG_SLIDE_X, 0, {
        duration: 0.3,
        ease: [0.22, 1, 0.36, 1],
        onUpdate: setSlide,
      });
      return () => controls.stop();
    }
    setTimelineExiting(true);
    if (reducedMotion) {
      setSlide(0);
      const t = setTimeout(() => setTimelineExiting(false), 0);
      return () => clearTimeout(t);
    }
    const controls = animate(paneSlideRef.current, RUNG_SLIDE_X, {
      duration: 0.3,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setSlide,
      onComplete: () => setTimelineExiting(false),
    });
    // Backstop: onComplete can race a fast re-enter, and the exiting freeze
    // must never outlive the layer it describes.
    const t = setTimeout(() => setTimelineExiting(false), 350);
    return () => {
      controls.stop();
      clearTimeout(t);
    };
  }, [showCardField, reducedMotion]);

  // ── THE ONE CANVAS (§14 merge) ───────────────────────────────────────────
  // Both worlds render in the shell-owned WorldCanvas — the card field's two
  // canvases (the pane's card field and the band's braid) are subtrees of it
  // now, and the game joins it as the other world. The band's rect comes
  // from the same tier spec the AxisBand sizes itself by, so the braid's
  // scissor window lands exactly under the band's DOM; `camXOffset` parks
  // the card field's camera half a band-width left of the canvas centre so
  // the cards stay centred in the PANE (a parallel shift, not a turn).
  const { spec } = useTier();
  const bandX = spec.railMargin;
  const bandW = spec.railW;
  const camXOffset = -(bandX + bandW) / 2;

  // The field world's DOM layer (band, pane, floating chrome) rides the
  // move's phase: as the DESTINATION it arrives with the dissolve — it
  // never sits over the hotel during the camera beat; as the SOURCE it
  // stays up until completion, so the reader watches the field fade
  // through the compositor, not the DOM.
  const fieldChrome = transition
    ? transition.to === "field"
      ? transition.phase !== "camera"
      : true
    : settledView === "field";

  return (
    // The world-slot provider must sit ABOVE both the canvas and the worlds'
    // DOM-side owners (they are siblings here) — see world-canvas.tsx. (The
    // shell-nav and conversation-surface providers are NOT here any more:
    // §3.1 moved them to the layout's ShellProvider, above the overlay too.)
    <WorldSceneProvider>
    <div className="relative flex h-dvh overflow-hidden">
      {/* The field world's page atmosphere, UNDER the canvas (the canvas is
          transparent; the aurora used to sit behind the pane's own canvas,
          now it sits behind the shared one). Inset past the band so the
          strip keeps the plain page background it has always had. Mounted
          only at a card rung and while the field world is up, exactly as
          before. */}
      {mountedWorlds.includes("field") && showCardField && (
        <>
          <style>{TIMELINE_KEYFRAMES}</style>
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 z-0"
            style={{ left: bandX + bandW }}
          >
            <AtmosphereBackdrop />
          </div>
        </>
      )}
      {/* The floating chrome (app-header) is a FIELD-world fixture; the game
          keeps only its own overlay. Hidden with a style tag because the
          header itself is not this file's to change. Hidden from the start
          of a move INTO the hotel, shown from the start of a move OUT. */}
      {mountedWorlds.includes("game") && (
        <style>{`[data-app-header]{display:none}`}</style>
      )}
      <WorldCanvas
        worlds={mountedWorlds}
        paused={worldFrozen}
        band={
          mountedWorlds.includes("field")
            ? {
                x: bandX,
                width: bandW,
                strands: ambientStrands,
                selected: strands,
                feed,
                range,
                reducedMotion,
              }
            : null
        }
      />
      {/* LEFT: the time axis. It is not a timeline-view affordance — it is
          where the app's strands live — but its braid renders in the
          field world's scene, so the band's DOM waits for the same phase
          as the rest of the field chrome: it arrives with the dissolve
          when the field is the destination and stays while the field is
          the source. The right pane supplies the anchors either way: the
          card field's rows in the timeline, the chat stream's slice seams
          in chat, so the braid winds at whatever the user is actually
          looking at. Field world only — the game owns the whole viewport. */}
      {fieldChrome && <AxisBand range={range} feed={feed} />}

      {/* RIGHT: the conversation field's pane slot + the timeline overlay
          when active. THE CONVERSATION LAYER ITSELF IS NOT HERE any more —
          §3.1 mounted it at the layout (chat/conversation-overlay.tsx), a
          sibling of this route that survives navigation and world rebuilds.
          Only the field's pane slot remains, because the R3F band still
          reaches into this pane. */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* THE CONVERSATION FIELD'S PANE SLOT — the restored R3F conversation
            renders HERE, in the 2.5D view, exactly where the conversation
            rung lived before the DOM refactor: portal target for the field
            (see `chat/conversation-surface.tsx`; the element is registered
            with the PROVIDER, which composes the surface). Dimmed, not
            unmounted, at a card rung — the subtree holds the field's camera
            position — and at conversation rung the reader reads history in
            the pane while the ongoing turn lives in the panel. Rides the
            field chrome's phase like the band. */}
        {fieldChrome && (
          <div
            ref={setPaneSlotEl}
            data-conversation-slot
            inert={!onConversationRung || undefined}
            className={`absolute inset-y-0 left-0 z-0 transition-opacity duration-300 ${
              onConversationRung
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          />
        )}

        {fieldChrome && (
          <>
        <AnimatePresence>
          {showCardField && (
            <motion.div
              key="timeline"
              // Opacity only — the slide's x lives on the inner layer, set
              // imperatively by THE RUNG SLIDE above (one animation drives
              // the DOM transform and the camera offset together, and an
              // `initial x` here would hydrate differently for a reduced-
              // motion client).
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 z-10 flex flex-col"
            >
              {/* THE SLIDING LAYER: plain div, so framer never touches the
                  transform — THE RUNG SLIDE's onUpdate owns it, writing the
                  same value to the camera offset and this transform every
                  tick (the two halves move as one plane). */}
              <div
                ref={paneLayerRef}
                className="absolute inset-0 will-change-transform"
              >
              {/* Catalog-loading crossfade: the arrival swaps a structured
                  skeleton for the live scene without a hard cut. */}
              <AnimatePresence mode="wait" initial={false}>
                {!timelineReady ? (
                  <motion.div
                    key="fallback"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reducedMotion ? 0 : 0.25 }}
                    className="absolute inset-0"
                  >
                    <TimelineFallback />
                  </motion.div>
                ) : (
                  <motion.div
                    key="scene"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: reducedMotion ? 0 : 0.25 }}
                    className="absolute inset-0"
                  >
                    <TimelineScene
                      entries={entries}
                      hasMore={hasMore}
                      onNeedOlder={loadOlder}
                      onOpenSlice={nav.openSlice}
                      // ONE CURSOR (§6): the card a scroll centres IS the
                      // slice the reader stands at — the quiet write, no
                      // world motion (see card-field.tsx).
                      onCursorSlice={reportCursor}
                      onNarrate={bridgeBrain === false ? startNarration : undefined}
                      initialAtId={focusId ?? undefined}
                      strands={strands}
                      feed={feed}
                      // Same freeze as the chat field — the one-writer rule
                      // holds through the move (the overlay's half gets the
                      // lease through the provider; see the driver pushes).
                      publishing={panePublishes && !transitionActive}
                      rung={rung}
                      onRungChange={setRung}
                      reducedMotion={reducedMotion}
                      running={running}
                      insetTop={chromeInset}
                      insetBottom={composerClearance}
                      // §14.1 rule 2's freeze now lives on the shared canvas
                      // itself (WorldCanvas frameloop="never" while the panel
                      // is fullscreen) — pause, never unmount.
                      camXOffset={camXOffset}
                      // The rung slide, restored: the camera offset the
                      // world content travels during the 0.3 s switch, and
                      // the exit freeze (the field keeps its last card rung
                      // while this layer slides out).
                      slideRef={paneSlideRef}
                      exiting={timelineExiting}
                      frozenRung={lastCardRungRef.current}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* THE BOARD BAR — the zoom lens and the strand selector, together at
            the top of the screen. Mounted with the SHELL rather than with the
            card field, because the control that gets you back to the
            conversation must not disappear at exactly the moment you are on
            the conversation. See `board-bar.tsx`. */}
        <BoardBar
          rung={rung}
          onRungChange={setRung}
          reducedMotion={reducedMotion}
          strands={strands}
          strandList={strandList}
          onToggleStrand={toggleStrand}
          onClearStrands={clearStrands}
        />
        {/* The two ends, floating on the same right-hand edge as the lens. They
            used to sit ON the rail, which by then held a thumb, a readout, a
            crossing dot and these two — a 32px column where the controls were
            competing with the thing they controlled. The rail says where time
            IS; the right edge is where you act on it. */}
        <JumpControls
          feed={feed}
          // 回到现在 (§6): at a card rung the bottom control is the explicit
          // jump to NOW — the conversation rung, cursor cleared — because the
          // newest slice is not in the stack's reachable set. At the
          // conversation rung it keeps its seek-to-bottom: the chat field's
          // live edge IS now.
          onNow={rung !== "conversation" ? returnToNow : undefined}
        />
        {/* THE COMPANION POD — the companion stream's floating presence. It
            holds the narration the 「讲讲这片」 entry starts (pod button +
            panel in one component, streaming and all) AND the evolution
            stream's presence — the same button breathes while a run is in
            flight and the panel replays the newest completion when there is
            no narration (props from the shell's bus subscription above). It
            lives here with the shell, NOT the card field, so a narration
            survives rung switches and view changes. Its fixed seat on the
            right edge clears JumpControls' stack by measurement — see
            companion-pod.tsx. Hidden with the narrate entry when the brain is
            bridge: /api/companion answers 501 there. */}
        {bridgeBrain === false && (
          <CompanionPod
            target={narrateTarget}
            onDismiss={() => setNarrateTarget(null)}
            onRetry={startNarration}
            reducedMotion={reducedMotion}
            working={evolution.working}
            evolution={evolution}
          />
        )}

        {/* THE WORLD GATE (§6) — the field world's way into the hotel, now a
            CHOICE when there is a cursor to travel to or a room to return to:
            前往这个房间 (the transition's travel beat, landing at the slice
            the cards centred on) / 回到原来的房间 (the remembered cursor —
            the card session does not move it) / 取消 (stay). With neither,
            the button keeps its old direct move. The way back out of the
            hotel is unchanged: the game's own exit button or Escape. */}
        <div className="absolute bottom-4 left-4 z-20">
          {worldGateOpen && (
            <>
              {/* The click-away: a bare layer, not a focusable control. */}
              <div
                aria-hidden
                className="fixed inset-0 z-10"
                onClick={() => setWorldGateOpen(false)}
              />
              <div
                data-world-gate
                role="menu"
                aria-label={tGame("title")}
                className="absolute bottom-11 left-0 z-20 flex w-56 flex-col gap-0.5 rounded-xl bg-background/95 p-1.5 shadow-lg ring-1 ring-border backdrop-blur-md"
              >
                {sharedSlice !== null && (
                  <button
                    type="button"
                    role="menuitem"
                    className="rounded-lg px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/5"
                    onClick={() => {
                      setWorldGateOpen(false);
                      nav.standAtSlice(sharedSlice);
                    }}
                  >
                    {gateText.goThis}
                  </button>
                )}
                {prevRoomCursor !== null && prevRoomCursor !== sharedSlice && (
                  <button
                    type="button"
                    role="menuitem"
                    className="rounded-lg px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-foreground/5"
                    onClick={() => {
                      setWorldGateOpen(false);
                      nav.standAtSlice(prevRoomCursor);
                    }}
                  >
                    {gateText.goBack}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  onClick={() => setWorldGateOpen(false)}
                >
                  {gateText.cancel}
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              if (sharedSlice === null && prevRoomCursor === null) {
                beginTransition("game", null);
                return;
              }
              setWorldGateOpen((open) => !open);
            }}
            aria-label={tGame("title")}
            aria-haspopup={
              sharedSlice !== null || prevRoomCursor !== null
                ? "menu"
                : undefined
            }
            aria-expanded={worldGateOpen || undefined}
            title={tGame("title")}
            className={`${ISLAND} pointer-events-auto flex size-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
          >
            <Hotel className="size-4" />
          </button>
        </div>
          </>
        )}

        {mountedWorlds.includes("game") && (
          <div className="relative flex-1 min-h-0">
            <GameShell
              onExit={() => beginTransition("field", null)}
              focusSlice={sharedSlice}
            />
          </div>
        )}
      </div>
    </div>
    </WorldSceneProvider>
  );
}
