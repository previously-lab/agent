"use client";

/**
 * Scene-first shell. Reading pauses the mounted world; continuing restores
 * its position. Conversation state belongs to the layout and survives both.
 * `?view=field` is an explicit reading entrance; subsequent moves stay local.
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
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
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
  WORLD_TRANSITION_PAUSE_MS,
  WORLD_TRANSITION_REDUCED_MS,
  type WorldTransitionMode,
  type WorldTransitionPhase,
} from "@/lib/timeline3d/world-transition";
import { GAME_SIM_FREEZE } from "@/components/game/sim-freeze";
import { getTimelineCatalogPage } from "@/lib/episodic/actions";
import { getCaseDoc, getSliceStart } from "@/lib/episodic/actions";
import { getDossierDoc } from "@/lib/archive/actions";
import { deskRefKind, parseRecordRef } from "@/lib/archive/refs";
import { invalidateHotelData } from "@/lib/game/hotel-data";
import type { RoomSnapshot } from "@/lib/game/room-snapshot";
import { useShellNav } from "@/components/shell/shell-nav";
import {
  LAST_DOCUMENT_KEY,
  useShell,
  type WorldDriver,
} from "@/components/shell/shell-provider";
import { useTier } from "@/hooks/use-tier";
import { BoardBar } from "@/components/shell/board-bar";
import { DeskField, type DeskTexts } from "@/components/desk/desk-field";
import { NativePersonaProvider } from "@/components/chat/native-source-scope";
import {
  ArchiveField,
  invalidateArchiveField,
} from "@/components/archive/archive-field";
import { RecordSwitch } from "@/components/archive/record-switch";
import type { FieldRig } from "@/components/timeline-3d/field-rig";
import { LibraryControl } from "@/components/shelf/library-control";
import { WorldBlur } from "@/components/shell/world-blur";
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

/** The desk-memory restore runs ONCE per JS session (module scope — the
 *  provider's deskDoc survives route remounts, so a remounted shell must
 *  not re-open what the reader put back). See the restore effect below. */
let restoreAttempted = false;

export function AppShell({ sourceScope }: { sourceScope: string }) {
  const searchParams = useSearchParams();
  // The demo persona rides the dev-only URL, exactly like `?view=game` —
  // forwarded explicitly to the library and the hotel's data/profile reads.
  const persona = searchParams.get("persona") ?? undefined;
  const roomSnapshotLane = JSON.stringify([sourceScope, persona ?? "user"]);
  const roomSnapshotRef = useRef<{
    lane: string;
    snapshot: RoomSnapshot | null;
  } | null>(null);
  const onRoomSnapshotChange = useCallback((snapshot: RoomSnapshot | null) => {
    roomSnapshotRef.current = { lane: roomSnapshotLane, snapshot };
  }, [roomSnapshotLane]);
  const getRoomSnapshot = useCallback(() => {
    const current = roomSnapshotRef.current;
    return current?.lane === roomSnapshotLane ? current.snapshot : null;
  }, [roomSnapshotLane]);
  // THE IN-PLACE COMPARISON SWITCH (v0.28 step 1): `?dissolve=1` forces the
  // old scripted dissolve for game ⇄ field moves — a debug flag read ONCE
  // at mount (the URL is dev-only), never product UI. Without it, leaving
  // the hotel for the documents is the Control-style pause: the world
  // freezes under a blur layer and stays mounted behind the document tier.
  const [dissolveDebug] = useState(() => searchParams.get("dissolve") === "1");
  // Exploration is the default. Explicit reader entry remains available for
  // a direct reading session and does not eagerly mount the game behind it.
  const [readerEntry] = useState(() => searchParams.get("view") === "field");
  const [settledView, setSettledView] = useState<WorldKind>(() =>
    readerEntry ? "field" : "game",
  );
  // Restoration belongs only to the untouched cold reader entrance. Once
  // navigation or a document selection supersedes it, returning to the
  // field must not revive a slow response from that original entrance.
  const bootRestoreAllowedRef = useRef(readerEntry);
  const shellMountedRef = useRef(false);
  useEffect(() => {
    shellMountedRef.current = true;
    return () => { shellMountedRef.current = false; };
  }, []);

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
    openDesk,
    closeDesk,
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
  // in the provider now; it is consumed two ways: the board bar's Scene
  // word offers it as 前往这个房间, the game stands the reader at the slice's
  // door
  // (game-canvas.tsx's `focusSlice`). The provider's navigation action
  // (shell-nav.ts) composes the cursor write with this transition machine,
  // through the driver registered below.
  const [transition, setTransition] = useState<{
    from: WorldKind;
    to: WorldKind;
    sliceId: string | null;
    phase: WorldTransitionPhase;
    mode: WorldTransitionMode;
  } | null>(null);
  // THE DOCUMENT PAUSE'S STEADY STATE (v0.28 step 1): a pause-mode move
  // into the field ends HERE instead of unmounting the game — the hotel
  // stays mounted behind the document tier, simulation frozen
  // (GAME_SIM_FREEZE), the blur layer up, the canvas showing the frozen
  // frame. Leaving for the hotel from this state is a RESUME: no scripted
  // shot, because the camera never moved.
  const [gameSuspended, setGameSuspended] = useState(false);
  const documentFromSceneRef = useRef(false);
  const view: WorldKind = settledView;
  const mountedWorlds: readonly WorldKind[] = transition
    ? [transition.from, transition.to]
    : gameSuspended
      ? ["game", "field"]
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
    mode: WorldTransitionMode;
  } | null>(null);
  /** The suspension state's synchronous mirror for the mode pick (the same
   *  outrun-the-render-pipeline reason as getCursor below). Initialised
   *  from the actual initial world state. */
  const gameSuspendedRef = useRef(gameSuspended);
  /** THE "WHERE WAS I" MEMORY (v0.13 §6): the cursor's value when the reader
   *  last LEFT the world for the reader — written in startMove on every
   *  game → field move. The Scene word's 回到原来的房间 is the one return
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
    (
      from: WorldKind,
      to: WorldKind,
      sliceId: string | null,
      mode: WorldTransitionMode,
    ) => {
      bootRestoreAllowedRef.current = false;
      const wt = WORLD_TRANSITION;
      wt.active = true;
      wt.id += 1;
      wt.from = from;
      wt.to = to;
      wt.mode = mode;
      wt.progress = 0;
      wt.reducedMotion = reducedMotionRef.current;
      if (mode === "pause") {
        // The world stops as the beat begins. INTO the documents it stays
        // frozen at settle (the steady state); back INTO the hotel the
        // clock's finish() unfreezes it once the blur has lifted.
        GAME_SIM_FREEZE.frozen = true;
        if (to === "game") {
          // The resume beat starts now: the blur lifts over a still-frozen
          // world while the field's chrome plays its exit above it.
          gameSuspendedRef.current = false;
          setGameSuspended(false);
        }
      }
      if (from === "game") {
        // THE "WHERE WAS I" MEMORY (v0.13 §6): leaving the world remembers
        // the cursor as it stands — walking has been keeping it current, so
        // this is the room the reader was last in. The Scene word's
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
        mode,
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
        // destination becomes the departure world and the move simply
        // crosses back (Escape/Exit pressed while the hotel mounts) — and
        // it keeps the live move's MECHANISM: it is the same two worlds
        // crossing back, so a pause move reverses as a pause. The
        // outgoing clock's cleanup will call settleMove with the stale id
        // and no-op — the gate stays live for the new move.
        if (live.to === to) return;
        startMove(live.to, to, sliceId, live.mode);
        return;
      }
      const from = settledRef.current;
      if (from === to) return;
      // THE MODE PICK (v0.28 step 1): leaving the hotel for the documents
      // is always the pause (the world stays mounted behind them); coming
      // back is a RESUME only when the hotel is actually still mounted
      // (gameSuspended) — a cold field → hotel entry keeps the scripted
      // dissolve. `?dissolve=1` forces the dissolve everywhere.
      const mode: WorldTransitionMode =
        !dissolveDebug &&
        ((from === "game" && to === "field") ||
          (from === "field" && to === "game" && gameSuspendedRef.current))
          ? "pause"
          : "dissolve";
      startMove(from, to, sliceId, mode);
    },
    [startMove, dissolveDebug],
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
      if (world === "game") {
        documentFromSceneRef.current = false;
        closeDesk();
      }
      beginTransition(world, null);
    },
    [beginTransition, closeDesk, setPanelMode],
  );

  // Every document entrance (world paper, reference, or chat receipt) uses
  // the same pause. Closing a world pickup resumes its existing scene;
  // closing a document picked from the index returns to that index.
  const previousDocumentRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousDocumentRef.current;
    previousDocumentRef.current = deskDoc;
    if (deskDoc !== null && previous !== deskDoc) {
      bootRestoreAllowedRef.current = false;
      if (settledRef.current === "game" && transitionRef.current?.to !== "game") {
        documentFromSceneRef.current = true;
        beginTransition("field", null);
      }
    } else if (previous !== null && deskDoc === null && documentFromSceneRef.current) {
      documentFromSceneRef.current = false;
      setPanelMode("pill");
      beginTransition("game", null);
    }
  }, [deskDoc, beginTransition, setPanelMode]);

  /** The Scene word's room choice, delegated to the provider's nav action:
   *  the cursor write (theirs) composed with the world move (the driver
   *  registered below) — the same path the old world gate's rulings took. */
  const enterRoom = useCallback(
    (sliceId: string) => {
      if (transitionRef.current) return;
      nav.standAtSlice(sliceId);
    },
    [nav],
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
    documentFromSceneRef.current = false;
    closeDesk();
    setPanelMode("pill");
    if (settledRef.current !== "game") beginTransition("game", null);
  }, [beginTransition, closeDesk, setPanelMode]);
  /** Read synchronously at send time. A transition or document pause hides
   *  the room context even while the world remains mounted underneath. */
  const getPose = useCallback(() => ({
    settled: settledRef.current,
    transitioning: transitionRef.current !== null,
    suspended: gameSuspendedRef.current,
  }), []);

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
  const transitionMode = transition?.mode;
  useEffect(() => {
    if (transitionFrom === undefined || transitionTo === undefined) return;
    const duration = WORLD_TRANSITION.reducedMotion
      ? WORLD_TRANSITION_REDUCED_MS
      : WORLD_TRANSITION.mode === "pause"
        ? WORLD_TRANSITION_PAUSE_MS
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
      if (transitionMode === "pause") {
        if (transitionTo === "field") {
          // THE PAUSE'S STEADY STATE: the game does NOT unmount — it stays
          // mounted behind the document tier, frozen, under the blur layer.
          gameSuspendedRef.current = true;
          setGameSuspended(true);
        } else {
          // The resume's end: the blur has lifted — the world runs again.
          gameSuspendedRef.current = false;
          setGameSuspended(false);
          GAME_SIM_FREEZE.frozen = false;
        }
      }
      settledRef.current = transitionTo;
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
  }, [transitionFrom, transitionTo, transitionSlice, transitionMode, worldFrozen, settleMove]);

  // The freeze flag is module state: a route change that unmounts this shell
  // mid-pause must not leave the hotel frozen for its next mount.
  useEffect(() => {
    return () => {
      GAME_SIM_FREEZE.frozen = false;
    };
  }, []);

  // Escape in the game world: panel first (anything open folds to the pill),
  // then the view itself (back to the reader, through the transition). The
  // panel's own Escape lives on its container with stopPropagation, so the
  // two never fire together.
  useEffect(() => {
    if (view !== "game") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== "Escape") return;
      if (panelMode !== "pill") setPanelMode("pill");
      else beginTransition("field", null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, panelMode, setPanelMode, beginTransition]);

  // ── THE SCENE WORD'S ROOM CHOICES (v0.13 §6, carried by the board bar) ──
  // The reader's way into the hotel used to be a second door — the floating
  // world gate — beside the bar's Scene word, doing the same job twice. The
  // word carries the choice now: with a cursor (or a remembered one) it
  // offers 前往这个房间 (travel to the room the cursor now names — the full
  // transition beat, never a hard cut) / 回到原来的房间 (the cursor does NOT
  // move — the reading session leaves no trace on it) / 取消 (stay with the
  // documents). With neither a cursor nor a memory the word has nothing to
  // offer and keeps its old direct move. The board bar owns the menu UI;
  // these are its data. The way back out of the hotel is unchanged: the
  // game's own exit button or Escape.
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
  // The desk's injected strings (v0.22): the Html portal is a separate React
  // root, so the paper's CHROME strings go in as props (FrameCardTexts
  // pattern). The paper's own furniture — letterhead category, shelf line,
  // folio — is fixed English and never passes through here (v0.28).
  const tDesk = useTranslations("desk");
  const deskTexts = useMemo<DeskTexts>(
    () => ({
      regionLabel: tDesk("regionLabel"),
      loading: tDesk("loading"),
      notFoundHeading: tDesk("notFoundHeading"),
      notFoundBody: (ref) => tDesk("notFoundBody", { ref }),
      prevPage: tDesk("prevPage"),
      nextPage: tDesk("nextPage"),
      pagePosition: (current, total) => tDesk("pagePosition", { current, total }),
      zoomOut: tDesk("zoomOut"),
      zoomIn: tDesk("zoomIn"),
      zoomReset: tDesk("zoomReset"),
      close: tDesk("close"),
      // The record paper's speaker labels (v0.25b §三) ride INTO the record
      // read — the transcript's markdown composes server-side with them.
      recordUserLabel: tDesk("recordUser"),
      recordAgentLabel: tDesk("recordAgent"),
    }),
    [tDesk],
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
  //    month page. THE OPENING RUNG IS ONE DOCUMENT (perf pass 2026-10-12):
  //    this fetch is NOT part of that document's load, so it waits for the
  //    boot decision (which document opens, if any) AND for the desk to be
  //    closed — the field and its braid range are what need it, and the
  //    reader reaching them is the trigger. A settled turn appends
  //    (refreshCatalog below). ───────────────────────────────────────────
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [timelineReady, setTimelineReady] = useState(false);
  const [bootResolved, setBootResolved] = useState(false);
  useEffect(() => {
    if (timelineReady) return;
    if (!bootResolved) return;
    if (deskDoc !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await getTimelineCatalogPage(null);
        if (cancelled) return;
        setEntries(page.entries);
        setTimelineReady(true);
      } catch {
        // A failed boot load leaves the band's range at today; the next
        // transition retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timelineReady, bootResolved, deskDoc]);

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

  // THE DESK'S MEMORY (v0.25b, product-pass §4 / R2): a returning reader's
  // desk opens on the last document he read — ONCE per session (the module
  // flag below: closing the desk re-runs this effect through the deskDoc
  // dependency, and must not reopen what the reader just put back). The
  // ref is PREFLIGHTED by kind before anything opens: a live document
  // opens; a dead one (moved, renamed, sealed) drops its stale key and the
  // archive stands — the field's honest placeholder is the fallback, and a
  // dead ref never blocks behind a not-found paper. Restored only on the
  // field world — a `?view=game` cold boot has the hotel as its explicit
  // destination. StrictMode-safe: the once-guard is module state (the
  // simulated remount's second pass returns early), and the preflight's
  // mounted ref is restored by the simulated remount. The intent ref is
  // invalidated by actual navigation/selection and never reset: a slow
  // response cannot override even a field → game → field round trip.
  const deskDocRef = useRef<string | null>(deskDoc);
  useEffect(() => {
    deskDocRef.current = deskDoc;
  }, [deskDoc]);
  useEffect(() => {
    if (restoreAttempted) {
      setBootResolved(true);
      return;
    }
    restoreAttempted = true;
    if (deskDoc !== null) {
      setBootResolved(true);
      return;
    }
    if (!readerEntry) {
      setBootResolved(true);
      return;
    }
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(LAST_DOCUMENT_KEY);
    } catch {
      setBootResolved(true);
      return; // storage denied — the archive stands.
    }
    // THE RECAP DEFAULT (perf pass 2026-10-12): a cold entry opens exactly
    // ONE document — the reader's remembered one when there is one, the
    // 前情提要 (people/user) otherwise. The field and every list behind it
    // load on demand, never on entry.
    const RECAP_DOC_REF = "people/user";
    const candidates: string[] = [];
    if (remembered) candidates.push(remembered);
    if (remembered !== RECAP_DOC_REF) candidates.push(RECAP_DOC_REF);
    void (async () => {
      try {
        for (const ref of candidates) {
          if (!bootRestoreAllowedRef.current || !shellMountedRef.current) return;
          const kind = deskRefKind(ref);
          const record = kind === "record" ? parseRecordRef(ref) : null;
          const ok =
            kind === "record"
              ? record
                ? (await getSliceStart(record.sliceId)) !== null
                : false
              : kind === "dossier"
                ? (await getDossierDoc(ref)) !== null
                : (await getCaseDoc(ref)) !== null;
          if (!bootRestoreAllowedRef.current || !shellMountedRef.current) return;
          if (ok) {
            bootRestoreAllowedRef.current = false;
            if (deskDocRef.current === null) openDesk(ref);
            return;
          }
          if (ref === remembered) {
            try {
              window.localStorage.removeItem(LAST_DOCUMENT_KEY);
            } catch {
              // same denial tolerance as the write.
            }
          }
        }
      } finally {
        if (shellMountedRef.current) setBootResolved(true);
      }
    })().catch(() => {
      // A failed preflight opens nothing — a flaky read must not erase the
      // memory; the next boot retries.
    });
    // searchParams is read once per cold boot by contract (the URL is
    // dev-only); deskDoc/openDesk are the live gates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskDoc, openDesk]);
  const refreshCatalog = useCallback(async () => {
    // Invalidate at START, including failed refreshes. An older hotel/profile
    // request may not adopt this newer generation while the catalog is pending.
    // A mounted room keeps its own frozen snapshot throughout the refresh.
    invalidateHotelData();
    // A settled turn may have written new CASES too — the archive field's
    // aggregated read is session-cached, so drop it and let the mounted
    // field re-aggregate (its dataGen prop bumps below on success AND on
    // failure: a missed catalog refresh never gates the field's freshness).
    invalidateArchiveField();
    setArchiveGen((g) => g + 1);
    try {
      const page = await getTimelineCatalogPage(null);
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
      getRoomSnapshot,
      onTurnSettled: refreshCatalog,
    }),
    [driveStandAtSlice, getPose, getRoomSnapshot, refreshCatalog],
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
  // with the dissolve — it never sits over the hotel during the camera beat
  // (a PAUSE move has no camera beat: the chrome arrives with the blur, at
  // the move's start); as the SOURCE it stays up until completion, so the
  // reader watches the field fade through the compositor, not the DOM.
  const fieldChrome = transition
    ? transition.to === "field"
      ? transition.mode === "pause" || transition.phase !== "camera"
      : true
    : settledView === "field";

  // THE PAUSE VEIL (v0.28 step 1): the blur layer is up for the whole
  // suspended steady state and fades in with every pause-mode move into the
  // documents; a resume (pause mode, destination the hotel) starts with it
  // mounted and lets the fade run OUT over the beat.
  const blurMounted =
    gameSuspended || (transition !== null && transition.mode === "pause");
  const blurLive =
    gameSuspended ||
    (transition !== null &&
      transition.mode === "pause" &&
      transition.to === "field");

  return (
    // The world-slot provider must sit ABOVE both the canvas and the worlds'
    // DOM-side owners (they are siblings here) — see world-canvas.tsx. (The
    // shell-nav provider is NOT here any more: §3.1 moved it to the layout's
    // ShellProvider, above the overlay too.)
    <WorldSceneProvider>
    {/* THE VIEWPORT IS FIXED (v0.30): `fixed inset-0` keeps the one canvas
        and the document tier viewport-locked no matter what any layer's
        content does — the page can never scroll, so a wheel over the
        document, the field or the game moves nothing — and
        `overscroll-behavior: none` kills the rubber-band/bounce that
        `overflow-hidden` alone does not. (Measured: scrollY stays 0 under
        trusted wheel input over all three surfaces.) */}
    <div data-app-world={view} data-scene-suspended={gameSuspended || undefined} className="fixed inset-0 flex overflow-hidden overscroll-none">
      {/* The floating chrome (app-header) is a FIELD-world fixture; the game
          keeps only its own overlay. Hidden with a style tag because the
          header itself is not this file's to change. Hidden from the start
          of a move INTO the hotel, shown from the start of a move OUT —
          which is also why a suspended hotel (mounted behind the documents)
          never hides it. */}
      {(transition ? transition.to === "game" : settledView === "game") && (
        <style>{`[data-app-header]{display:none}`}</style>
      )}
      {/* THE FIELD BACKDROP (v0.28, board A) — the warm desk surface the
          paper lies on. The one shared canvas clears TRANSPARENT
          (world-canvas onCreated), so this div is the field world's
          ground: the archive piles and the desk's surround show through
          the canvas onto it. It mounts only while the field world is
          mounted, so the hotel's own surround keeps the page background
          and no world switch can show a seam. The chrome, the chat
          surface and settings never read --field: they stay on
          --background. */}
      {mountedWorlds.includes("field") && (
        <div
          aria-hidden
          data-field-backdrop
          className="absolute inset-0 bg-field"
        />
      )}
      <WorldCanvas
        worlds={mountedWorlds}
        paused={worldFrozen}
        suspended={gameSuspended && transition === null}
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

      {/* THE PAUSE VEIL — between the canvas (z-0) and the pane's document
          DOM (z-10): the frozen world reads THROUGH it, defocused, while
          the paper and the chrome sit crisp above it. */}
      {blurMounted && <WorldBlur active={blurLive} />}

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

        {/* THE RECORD SWITCH (v0.28) — while a transcript is on the desk,
            the bucket's OTHER records (the pile opens only the newest). A
            floating island one toggle below the library's — document picking
            lives on the left edge, page turning keeps the bottom-left bar.
            Renders nothing for a one-record bucket or a non-record desk. */}
        <RecordSwitch persona={persona} reducedMotion={reducedMotion} />

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
          transition?.to !== "game" &&
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
            // pointer-events-none is LOAD-BEARING, same as the archive
            // branch above: this pane (z-10) stacks above the world canvas
            // (z-0), so a hit-testable branch would swallow every click
            // meant for the paper (which portals pane-side — desk-field's
            // portalRef — and re-enables events on its own inner layer).
            className="pointer-events-none absolute inset-0 z-10"
          >
            {/* The leaving desk outlives its ref: deskDoc is already null
                during the return beat, so the desk keeps the last one. */}
            {(deskDoc ?? lastDeskDocRef.current) !== null && (
              <NativePersonaProvider value={persona ?? "user"}>
                <DeskField
                  docRef={(deskDoc ?? lastDeskDocRef.current)!}
                  camXOffset={0}
                  reducedMotion={reducedMotion}
                  texts={deskTexts}
                  leaving={handoverLeaving}
                />
              </NativePersonaProvider>
            )}
          </motion.div>
        )}

        {/* The reading layer offers one primary action: continue the scene. */}
        <BoardBar
          world={transition ? transition.to : settledView}
          onSelect={selectRung}
          canTravel={!transitionActive}
          sceneChoice={{
            current: deskDoc ? parseRecordRef(deskDoc)?.sliceId ?? null : null,
            remembered: prevRoomCursor,
          }}
          onEnterRoom={enterRoom}
        />
        {/* THE COMPANION POD — the companion stream's floating presence. It
            holds the narration the 「讲讲这片」 entry starts (pod button +
            panel in one component, streaming and all) AND the evolution
            stream's presence — the same button breathes while a run is in
            flight and the panel replays the newest completion when there is
            no narration (props from the shell's bus subscription above). It
            lives here with the shell, so a narration survives rung switches
            and view changes. */}
          <CompanionPod
            target={narrateTarget}
            onDismiss={() => setNarrateTarget(null)}
            onRetry={startNarration}
            reducedMotion={reducedMotion}
            working={evolution.working}
            evolution={evolution}
          />

          </>
        )}

        {mountedWorlds.includes("game") && (
          <div className="relative flex-1 min-h-0">
            <GameShell
              key={roomSnapshotLane}
              persona={persona ?? "user"}
              sourceScope={sourceScope}
              dataGeneration={archiveGen}
              onRoomSnapshotChange={onRoomSnapshotChange}
              onExit={() => {
                documentFromSceneRef.current = false;
                beginTransition("field", null);
              }}
              focusSlice={sharedSlice}
              // The hotel's own chrome stands down for the whole pause —
              // the steady state and both pause-mode flights.
              suspended={
                gameSuspended || transition?.mode === "pause"
              }
              // A room paper reads in the ORIGINAL manuscript (v0.25a §五):
              // the desk opens on the field world while the game world
              // stays mounted behind it — the way back is the desk's Esc.
              onOpenDoc={(ref) => {
                documentFromSceneRef.current = true;
                openDesk(ref);
                beginTransition("field", null);
              }}
            />
          </div>
        )}
      </div>
    </div>
    </WorldSceneProvider>
  );
}
