"use client";

/**
 * AppShell — the app route's shell: the one shared world canvas (the reader's
 * field and the hotel), the world transition machine, and the TWO RUNGS.
 * Product navigation is IN-MEMORY state; the URL carries none of it.
 *
 * THE WORLD HAS TWO RUNGS (v0.26). 原稿 / Manuscript is the field world — the
 * document reader (the floating library, the desk and its paper); 现场 /
 * Scene is the game world — the hotel. The board bar's two tags switch
 * between them through the transition machine below — a move, never a snap.
 * The four-rung zoom ladder (conversation · slice · day · week) retired: the
 * three card rungs rendered the same reader, and the conversation stopped
 * being a rung at all — it is a floating layer mounted by the LAYOUT
 * (`chat/conversation-overlay.tsx`), a sibling of this route, above the
 * canvas by z-index, surviving navigation and world moves. The retired
 * ladder's chrome (the pane slot, the rung slide, the zoom hint, the jump
 * controls, the AxisBand DOM) is gone; the card field's own components stay
 * in the tree untouched (`timeline-3d/**`) for the archive field to re-wire
 * later — the shell simply stops importing them.
 *
 * WHAT THE LAYOUT OWNS (§3.1). The state the conversation layer and this
 * shell SHARE lives in `shell/shell-provider.tsx` — the panel tier, the
 * shared slice cursor, the per-turn view getter (`getChatView`), the
 * world-freeze signal (`worldFrozen`, which still arrives here as the
 * canvas's `paused`), the one band feed, and the composer clearance. What
 * stays HERE is the world's half: the canvas, the transition clock, and the
 * catalog window the band's braid reads its range from. The shell registers
 * a `WorldDriver` with the provider on mount (the nav action's world-motion
 * half, the pose read, the turn callback) and pushes its pose / feed lease
 * up as they change — the layout talks to the world through that channel; it
 * does not own it.
 *
 * THE URL IS DEV-ONLY. The only query params anyone reads are the debug
 * gallery's (`?view=game&debug=rooms&page=&skin=`, game-shell.tsx) and the
 * playground route's — never product navigation. `?view=game` is read ONCE
 * as the cold-boot world (so the gallery link still opens the hotel); it is
 * never written back and never reconciled. `?at=`/`?atStart=` remain a
 * cold-boot conversation deep link consumed once by ChatPage (chat-page.tsx,
 * in the layout's overlay) — a shared link still lands on its slice, but
 * nothing inside the session ever produces one.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useReducedMotion } from "motion/react";
import { motion } from "motion/react";
import { useTranslations, useLocale } from "next-intl";
import { Hotel, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import {
  applyEvolutionActivity,
  EVOLUTION_PRESENCE_IDLE,
  EvolutionToastDedupe,
  evolutionToastContent,
  subscribeEvolutionActivity,
} from "@/lib/chat/evolution-activity";
import {
  transitionPhase,
  WORLD_TRANSITION,
  WORLD_TRANSITION_MS,
  WORLD_TRANSITION_REDUCED_MS,
  type WorldTransitionPhase,
} from "@/lib/timeline3d/world-transition";
import { getTimelineCatalogPage } from "@/lib/episodic/actions";
import { invalidateHotelData } from "@/lib/game/hotel-data";
import { useShellNav } from "@/components/shell/shell-nav";
import {
  useShell,
  type WorldDriver,
} from "@/components/shell/shell-provider";
import { ISLAND } from "@/components/layout/island";
import { useBridgeBrainActive } from "@/hooks/use-bridge-brain";
import { useTier } from "@/hooks/use-tier";
import { BoardBar } from "@/components/shell/board-bar";
import { DeskField, type DeskTexts } from "@/components/desk/desk-field";
import {
  ArchiveField,
  invalidateArchiveField,
} from "@/components/archive/archive-field";
import type { FieldRig } from "@/components/timeline-3d/field-rig";
import { LibraryControl } from "@/components/shelf/library-control";
import type { WorldKind } from "@/components/timeline-3d/world-contract";

// THE CANVAS AND THE GAME LOAD AS THEIR OWN CHUNKS (§13.2): the shared
// canvas pulls in three/fiber, the game its postprocessing chain — a visitor
// who never leaves the reader pays neither. Both are client-only
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

export function AppShell() {
  // THE URL IS DEV-ONLY. `?view=game` is read ONCE, as the cold-boot world,
  // so the debug gallery's link (`?view=game&debug=rooms`, game-shell.tsx)
  // still opens straight into the hotel. Nothing else reads the query string
  // here and nothing ever writes it: a refresh returns to the reader,
  // exactly like a fresh visit.
  const searchParams = useSearchParams();
  // The demo persona rides the dev-only URL, exactly like `?view=game` —
  // read once at mount, forwarded to the library column's server actions.
  const persona = searchParams.get("persona") ?? undefined;
  const [settledView, setSettledView] = useState<WorldKind>(() =>
    searchParams.get("view") === "game" ? "game" : "field",
  );

  // ── THE SHARED CHANNEL (shell-provider.tsx, layout level) ───────────────
  // Everything the conversation overlay and this shell both read or write:
  // the panel tier (the overlay renders it; this shell consumes the freeze),
  // the shared slice cursor, the one band feed, and the registration channels
  // for the world driver / pose / feed lease below.
  const {
    panelMode,
    setPanelMode,
    worldFrozen,
    sharedSlice,
    deskDoc,
    getCursor,
    feed,
    registerWorldDriver,
    setWorldPose,
    setFeedPublishing,
  } = useShell();
  // The provider-owned nav action (cursor + the driver registered below).
  const nav = useShellNav();

  // THE WORLD SWITCH (§14) — a TRANSITION, never a snap, and PURE STATE: no
  // URL leg, no reconciliation. `settledView` is the world the reader is in;
  // `transition` is a live move between the worlds (owned by the shell,
  // driven per frame by world-transition.ts). The shared slice address lives
  // in the provider now; it is consumed two ways: the world gate offers it
  // as 前往这个房间, the game stands the reader at the slice's door
  // (game-canvas.tsx's `focusSlice`). The provider's navigation action
  // (shell-nav.ts) composes the cursor write with this transition machine,
  // through the driver registered below.
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
   *  last LEFT the world for the reader — written in startMove on every
   *  game → field move. The world gate's 回到原来的房间 is the one return
   *  that restores it instead of moving the cursor. */
  const prevRoomCursorRef = useRef<string | null>(null);
  const settledRef = useRef<WorldKind>(view);
  const reducedMotionRef = useRef(reducedMotion);
  useEffect(() => {
    settledRef.current = settledView;
  }, [settledView]);
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
        // this is the room the reader was last in. The world gate's
        // 回到原来的房间 restores exactly this value. Read through
        // `getCursor` (the provider's synchronously-written ref): an exit
        // fired in the same beat as the room's cursor report can outrun the
        // render pipeline, and a render-mirrored value would read stale.
        prevRoomCursorRef.current = getCursor();
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

  /** Ask the world to switch rungs — the board bar's two tags and the ⌘/.
   *  toggle share this path. A fullscreen conversation FREEZES the world's
   *  clock (the tick holds while `worldFrozen`), so the panel folds to the
   *  pill first — otherwise the move would hang at frame zero until the
   *  reader folded it themselves. */
  const selectRung = useCallback(
    (world: WorldKind) => {
      const live = transitionRef.current;
      const wouldMove = live ? live.to !== world : settledRef.current !== world;
      if (!wouldMove) return;
      setPanelMode("pill");
      beginTransition(world, null);
    },
    [beginTransition, setPanelMode],
  );

  // `Cmd/Ctrl+.` — the fastest round trip between the two rungs: the reader
  // ⇄ the scene. It used to toggle the conversation against the card rungs;
  // with the conversation floating it toggles the WORLD.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      e.preventDefault();
      const live = transitionRef.current;
      const current = live ? live.to : settledRef.current;
      selectRung(current === "game" ? "field" : "game");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectRung]);

  // ── THE WORLD'S HALF OF THE NAVIGATION ACTION (shell-nav.ts) ────────────
  // The memory form of the old `?slice=` contract, split in two by §3.1: the
  // CURSOR half (writing the shared slice address) lives in the provider,
  // because the conversation layer — the other reader of that address —
  // lives at the layout now. What stays HERE is the WORLD MOTION: the move
  // into the hotel. Pure state — no URL, no router. The provider's nav
  // action calls this through the registered driver.
  const driveStandAtSlice = useCallback(() => {
    if (transitionRef.current) return;
    if (settledRef.current !== "game") beginTransition("game", null);
  }, [beginTransition]);
  /** The live pose for the provider's send-time view getter (via this ref
   *  read — the transport asks outside React's render). A mid-move read
   *  reports the SETTLED world: that is where the reader stands. */
  const getPose = useCallback(() => ({ settled: settledRef.current }), []);

  // The room → reader entrance: the terminal interaction fires this after
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
  // it). This shell only derives the per-world default: the hotel opens on
  // the pill — and FULLSCREEN freezes the field world's frame loop (the
  // provider's `worldFrozen` → the canvas's `paused` → frameloop="never",
  // below). The provider's initial tier is the pill everywhere, so there is
  // no mount-time correction; the effect fires only on the world boundary:
  // settling INTO the hotel folds whatever tier the reader carried.
  const tierBoundaryRef = useRef(false);
  useEffect(() => {
    if (!tierBoundaryRef.current) {
      tierBoundaryRef.current = true;
      return;
    }
    if (view === "game") setPanelMode("pill");
  }, [view, setPanelMode]);

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
        const p = Math.min(1, elapsedMs / duration);
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

  // Escape in the game world: panel first (anything open folds to the pill),
  // then the view itself (back to the reader, through the transition). The
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

  // ── THE WORLD GATE (v0.13 §6) — returning to the world is a CHOICE ─────
  // The reader's way into the hotel used to be a bare button that started
  // the transition. With a cursor (or a remembered one) it now offers the
  // three rulings first: 前往这个房间 (travel to the room the cursor now
  // names — the full transition beat, never a hard cut), 回到原来的房间
  // (the cursor does NOT move — the reading session leaves no trace on it),
  // or 取消 (stay with the documents). With neither a cursor nor a memory
  // the gate has nothing to offer and the button keeps its old direct move.
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
        cancel: "取消 · 继续阅读",
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
  // (not by the pod — the pod streams and renders it) so narration survives
  // rung switches and view changes — the reader keeps browsing while
  // Previously speaks.
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
  // The desk's injected strings (v0.22): the Html portal is a separate React
  // root, so the paper's chrome strings go in as props (FrameCardTexts
  // pattern). The footer's category name and the reader's chrome read the
  // library namespace — the category table's one home since v0.23.
  const tDesk = useTranslations("desk");
  const tLibrary = useTranslations("library");
  const deskTexts = useMemo<DeskTexts>(
    () => ({
      regionLabel: tDesk("regionLabel"),
      loading: tDesk("loading"),
      notFoundHeading: tDesk("notFoundHeading"),
      notFoundBody: (ref) => tDesk("notFoundBody", { ref }),
      categoryName: (category) => tLibrary(`category.${category}`),
      page: (n) => tDesk("page", { n }),
      prevPage: tDesk("prevPage"),
      nextPage: tDesk("nextPage"),
      pagePosition: (current, total) => tDesk("pagePosition", { current, total }),
    }),
    [tDesk, tLibrary],
  );
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

  // ── The catalog window the band's braid reads its RANGE from — the latest
  //    month page, fetched once on mount (the reader is the app's opening
  //    rung, so there is no lazier trigger left to wait for). A settled turn
  //    appends (refreshCatalog below). The card rows this catalog once also
  //    fed retired with the card field. ─────────────────────────────────────
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [timelineReady, setTimelineReady] = useState(false);
  useEffect(() => {
    if (timelineReady) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await getTimelineCatalogPage(null);
        if (cancelled) return;
        setEntries(page.entries);
        setTimelineReady(true);
      } catch {
        // A failed boot load leaves the band's range at today; the next
        // mount retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timelineReady]);

  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (entries.length === 0) return { oldest: today, now: today };
    return { oldest: entries[0].date, now: today };
  }, [entries]);

  /**
   * Re-read the newest catalog page after a turn settles, and APPEND.
   *
   * Appending is the whole trick, and it is not an optimisation: replacing
   * `entries` reorders a list built from it, while a new slice is always
   * the NEWEST — it can only ever land at the tail, where nothing above it
   * moves. Returning `prev` BY IDENTITY when there is nothing new is the
   * other half: React bails out and a settle with no new slice costs one
   * no-op render.
   */
  // THE ARCHIVE FIELD'S TWO SHELL-HELD CHANNELS. The rig (the field's scroll
  // physics state) lives HERE so a desk round trip — open a pile, Escape
  // back — and a hotel round trip both return the reader to the exact scroll
  // position: the field component remounts, the rig object does not. The
  // dataGen counter is the turn-settled re-aggregation trigger (a settled
  // turn may have written a case); the data itself caches in the field's
  // module (archive-field.tsx), invalidated alongside.
  const archiveRigRef = useRef<FieldRig>({
    target: 0,
    current: 0,
    releaseAt: 0,
    anchorIndex: 0,
    genAt: 0,
    hoverKey: null,
    dealOrigins: null,
    dealEligible: null,
  });
  const [archiveGen, setArchiveGen] = useState(0);

  // THE FIELD ⇄ DESK HANDOVER, HAND-TIMED (the JSX below carries the why).
  // `shownSide` trails `handoverSide` by the leaving side's beat — archive
  // exits in 220ms, the desk in 300ms (their old AnimatePresence numbers);
  // a reversal mid-beat (open, then Escape inside the beat) simply cancels
  // the timer and the leaving side fades back in, never having unmounted.
  const handoverSide = deskDoc !== null ? "desk" : "archive";
  const [shownSide, setShownSide] = useState<"archive" | "desk">("archive");
  const handoverLeaving = shownSide !== handoverSide;
  useEffect(() => {
    if (shownSide === handoverSide) return;
    const t = setTimeout(
      () => setShownSide(handoverSide),
      reducedMotion ? 0 : handoverSide === "desk" ? 220 : 300,
    );
    return () => clearTimeout(t);
  }, [shownSide, handoverSide, reducedMotion]);
  // The desk's last live ref, so its exit beat still has a document to show.
  const lastDeskDocRef = useRef<string | null>(null);
  if (deskDoc !== null) lastDeskDocRef.current = deskDoc;
  const refreshCatalog = useCallback(async () => {
    // A settled turn may have written new CASES too — the archive field's
    // aggregated read is session-cached, so drop it and let the mounted
    // field re-aggregate (its dataGen prop bumps below on success AND on
    // failure: a missed catalog refresh never gates the field's freshness).
    invalidateArchiveField();
    setArchiveGen((g) => g + 1);
    try {
      const page = await getTimelineCatalogPage(null);
      // A settled turn may have written a new slice — kill the hotel's
      // cached lane so the next game entry re-derives instead of serving
      // pre-turn doors. Bumping on every successful refresh is deliberate:
      // an unnecessary re-fetch beats stale doors.
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

  // ── THE READER'S RUNG (v0.23–v0.26) ──────────────────────────────────────
  // The field world IS the document reader: the floating library control
  // (shelf/library-control.tsx) on the left edge, and the pane itself owned
  // by the ARCHIVE FIELD (archive/archive-field.tsx — the piles' grid, the
  // 原稿 default) until a pile or the shelf opens a document onto the desk
  // (desk/desk-field.tsx). The conversation is not a rung any more; it
  // floats above both worlds as the layout's overlay.

  // ── THE ROUTE → PROVIDER CHANNEL ─────────────────────────────────────────
  // Registration and pushes, all laid out in one place:
  //
  //   · the WorldDriver — the nav action's world-motion half, the send-time
  //     pose read, and the turn callback the overlay's ChatPage reports (a
  //     settled turn refreshes the catalog and the hotel's doors). A ref on
  //     the provider's side: registration must not re-render the layout's
  //     subtree.
  //   · the reactive pose / feed lease — provider STATE, because their
  //     readers (the send-time getter's fallback, the overlay's ChatPage
  //     props) must re-render. Layout effects, so the push lands before
  //     paint.
  //   · unmount cleans every channel back to its no-world default, so a
  //     route without a world (settings) finds no stale driver and a neutral
  //     lease.
  const driver = useMemo<WorldDriver>(
    () => ({
      standAtSlice: driveStandAtSlice,
      getPose,
      onTurnSettled: refreshCatalog,
    }),
    [driveStandAtSlice, getPose, refreshCatalog],
  );
  useEffect(() => {
    registerWorldDriver(driver);
    return () => registerWorldDriver(null);
  }, [driver, registerWorldDriver]);
  useEffect(() => {
    setWorldPose({ settled: settledView });
    return () => setWorldPose(null);
  }, [settledView, setWorldPose]);
  // THE FEED LEASE. The chat stream owns the band feed everywhere except
  // mid-transition — a move mounts/unmounts the worlds around the band, and
  // nobody publishes mid-move.
  useEffect(() => {
    setFeedPublishing(!transitionActive);
    return () => setFeedPublishing(true);
  }, [transitionActive, setFeedPublishing]);

  // ── THE READER LAYOUT (v0.24) ────────────────────────────────────────────
  // No left column any more: the library is a floating control (see
  // LibraryControl), the canvas keeps the full pane, and the desk's camera
  // offset is 0 — the paper centres in the whole pane.

  // ── THE ONE CANVAS (§14 merge) ───────────────────────────────────────────
  // Both worlds render in the shell-owned WorldCanvas, the game joining the
  // field as the other world. The band's rect comes from the same tier spec
  // the AxisBand sized itself by, so the braid's scissor window lands exactly
  // where the band's DOM used to sit. THE BAND PROP STAYS while the field
  // world is mounted: the canvas gates the field world's renderer on
  // `band !== null` (world-canvas.tsx), so nulling it would blank the desk
  // scene too — the braid keeps winding along the left edge, quiet decoration
  // at the reader's rung.
  const { spec } = useTier();
  const bandX = spec.railMargin;
  const bandW = spec.railW;
  // The desk renders only in the reader (it mounts when `deskDoc` is set,
  // which only the library can do), and the reader is full-width — the
  // floating library control reserves no pane — so the desk's camera offset
  // is 0: the paper centres in the whole pane. The prop stays as the desk's
  // centre-me-elsewhere seam.

  // The field world's DOM layer (the board bar, the library, the desk, the
  // floating chrome) rides the move's phase: as the DESTINATION it arrives
  // with the dissolve — it never sits over the hotel during the camera beat;
  // as the SOURCE it stays up until completion, so the reader watches the
  // field fade through the compositor, not the DOM.
  const fieldChrome = transition
    ? transition.to === "field"
      ? transition.phase !== "camera"
      : true
    : settledView === "field";

  return (
    // The world-slot provider must sit ABOVE both the canvas and the worlds'
    // DOM-side owners (they are siblings here) — see world-canvas.tsx. (The
    // shell-nav provider is NOT here any more: §3.1 moved it to the layout's
    // ShellProvider, above the overlay too.)
    <WorldSceneProvider>
    <div className="relative flex h-dvh overflow-hidden">
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
                feed,
                range,
                reducedMotion,
              }
            : null
        }
      />

      {/* The field world's DOM: the reader's chrome + the hotel's slot. The
          CONVERSATION LAYER IS NOT HERE — §3.1 mounted it at the layout
          (chat/conversation-overlay.tsx), a sibling of this route that
          survives navigation and world rebuilds. */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {fieldChrome && (
          <>
        {/* THE FLOATING LIBRARY (v0.24) — the reader's three-level filter as
            one of the app's floating islands, mid-left. The canvas keeps the
            full pane; the paper centres. Below `md` this is the shelf's only
            door — the control never hides. */}
        <LibraryControl persona={persona} reducedMotion={reducedMotion} />

        {/* THE ARCHIVE FIELD ⇄ THE DOCUMENT DESK (v0.25a §四) — the pane's
            owner, mutually exclusive through a HAND-TIMED handover: while
            nothing is open the archive field stands (the piles' grid IS the
            原稿 default — the empty-desk placeholder is gone); opening a pile
            dims the field out, then the desk's pull-out beat plays. NOT
            AnimatePresence mode="wait": under motion v12 the presence
            subscription both fields carry wedges the removal — the exit
            plays, the old branch never unmounts, the desk never mounts
            (measured 2026-10-10). The hand-timed version also keeps the
            world-slot handshake honest: the LEAVING side keeps its scene
            registered through its beat and unregisters on unmount; only
            then does the entering side mount and register — the slot's
            cleanup is a blind null, so the survivor must come second. The
            field's rig is shell-held (above): Escape returns to the same
            scroll. */}
        {shownSide === "archive" ? (
          <motion.div
            key="archive"
            // The wrapper has no paint of its own (the piles render through
            // the field's own portal layer) — the fade only TIMES the
            // handover; the visible beats are the units' own (archive.css).
            // pointer-events-none is LOAD-BEARING: this pane (z-10) stacks
            // above the world canvas (z-0), so a hit-testable branch would
            // swallow every click aimed at a pile. The field's gestures are
            // all window-bound; nothing in this branch needs a hit.
            initial={{ opacity: 0 }}
            animate={{ opacity: handoverLeaving ? 0 : 1 }}
            transition={{
              duration: reducedMotion ? 0 : 0.22,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="pointer-events-none absolute inset-0 z-10"
          >
            <ArchiveField
              persona={persona}
              rig={archiveRigRef}
              dataGen={archiveGen}
              reducedMotion={reducedMotion}
              leaving={handoverLeaving}
            />
          </motion.div>
        ) : (
          <motion.div
            key="desk"
            initial={{ opacity: 0 }}
            animate={{ opacity: handoverLeaving ? 0 : 1 }}
            transition={{
              duration: reducedMotion ? 0 : 0.3,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="absolute inset-0 z-10"
          >
            {/* The leaving desk outlives its ref: deskDoc is already null
                during the return beat, so the desk keeps the last one. */}
            {(deskDoc ?? lastDeskDocRef.current) !== null && (
              <DeskField
                docRef={(deskDoc ?? lastDeskDocRef.current)!}
                camXOffset={0}
                reducedMotion={reducedMotion}
                texts={deskTexts}
                leaving={handoverLeaving}
              />
            )}
          </motion.div>
        )}

        {/* THE BOARD BAR — the two rungs, floating at the top of the screen.
            Field-world chrome: in the hotel the game's own Exit is the way
            back. Mid-move the DESTINATION's tag lights, so the bar states
            where you are going, not where the fade started. See
            `board-bar.tsx`. */}
        <BoardBar
          world={transition ? transition.to : settledView}
          onSelect={selectRung}
        />
        {/* THE COMPANION POD — the companion stream's floating presence. It
            holds the narration the 「讲讲这片」 entry starts (pod button +
            panel in one component, streaming and all) AND the evolution
            stream's presence — the same button breathes while a run is in
            flight and the panel replays the newest completion when there is
            no narration (props from the shell's bus subscription above). It
            lives here with the shell, so a narration survives rung switches
            and view changes. Hidden with the narrate entry when the brain is
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

        {/* THE WORLD GATE (§6) — the reader's way into the hotel, now a
            CHOICE when there is a cursor to travel to or a room to return to:
            前往这个房间 (the transition's travel beat, landing at the slice
            the cursor names) / 回到原来的房间 (the remembered cursor — the
            reading session does not move it) / 取消 (stay). With neither,
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
                    className="rounded-lg px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
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
