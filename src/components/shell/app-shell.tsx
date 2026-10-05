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
 * Catalog loading is lazy: the timeline catalog window is fetched on the
 * first switch to a card rung. Addressing a slice (terminal entrance, card
 * click) loads the full catalog so the slice is always resolvable.
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
import { AnimatePresence, motion } from "motion/react";
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
  transitionPhase,
  WORLD_TRANSITION,
  WORLD_TRANSITION_MS,
  WORLD_TRANSITION_REDUCED_MS,
  type WorldTransitionPhase,
} from "@/lib/timeline3d/world-transition";
import {
  getTimelineCatalog,
  getTimelineCatalogPage,
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
import { useBridgeBrainActive } from "@/hooks/use-bridge-brain";
import { useTier } from "@/hooks/use-tier";
import { AxisBand, JumpControls } from "@/components/timeline-3d/axis-band";
import { BoardBar } from "@/components/shell/board-bar";
import { DeskField, type DeskTexts } from "@/components/desk/desk-field";
import { DocLibrary } from "@/components/shelf/doc-library";
import type { WorldKind } from "@/components/timeline-3d/world-contract";

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

export function AppShell() {
  // THE URL IS DEV-ONLY. `?view=game` is read ONCE, as the cold-boot world,
  // so the debug gallery's link (`?view=game&debug=rooms`, game-shell.tsx)
  // still opens straight into the hotel. Nothing else reads the query string
  // here and nothing ever writes it: a refresh returns to the field at the
  // conversation rung, exactly like a fresh visit.
  const searchParams = useSearchParams();
  // The demo persona rides the dev-only URL, exactly like `?view=game` —
  // read once at mount, forwarded to the library column's server actions.
  const persona = searchParams.get("persona") ?? undefined;
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
    deskDoc,
    getCursor,
    feed,
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
  const [entries, setEntries] = useState<TimelineSliceEntry[]>([]);
  const [timelineReady, setTimelineReady] = useState(false);
  /** A turn is streaming. Reported by the overlay's `ChatPage` through the
   *  driver (it is the only half that knows — `useChat`'s `isLoading`). The
   *  value had one reader, the card field's `RunningCard`, which retired
   *  with the card field (v0.23); the SETTER stays — the WorldDriver
   *  contract still carries it. */
  const [, setRunning] = useState(false);

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
        const p = Math.min(1, elapsedMs / duration);
        // (v0.23) The data hold retired with the card field: the reader is
        // the field world's destination now and mounts nothing that waits
        // on the catalog, so the dissolve never holds at the threshold.
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

  const range = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (entries.length === 0) return { oldest: today, now: today };
    return { oldest: entries[0].date, now: today };
  }, [entries]);

  // ── Lazy catalog load on the first CARD rung (the reader's rungs count).
  //    A slice address (the shared cursor, or a transition's terminal slice)
  //    loads the full catalog; otherwise the latest month window. The
  //    catalog feeds the band's RANGE and the settle refresh below — the
  //    card rows it once also fed retired with the card field. ──────────────
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
        } else {
          const page = await getTimelineCatalogPage(null);
          if (cancelled) return;
          setEntries(page.entries);
        }
        setTimelineReady(true);
      } catch {
        // A failed boot load leaves the band's range at today; the next
        // card-rung visit retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rung, focusId, timelineReady]);

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
  const refreshCatalog = useCallback(async () => {
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

  // ── THE PANE'S TWO MODES (v0.23) ─────────────────────────────────────────
  // The rung is the navigation now; there is no view mode beside it. The
  // CONVERSATION rung is the chat's own surface and is UNTOUCHED here. Every
  // CARD rung is the DOCUMENT READER: the library filter column on the left
  // (shelf/doc-library.tsx) and the desk's tabletop + paper in the main
  // area — a quiet placeholder while nothing is open.
  //
  // THE CARD FIELD no longer renders in the pane. Its code stays in the
  // tree untouched (`timeline-3d/**`, backed up at branch
  // `backup/card-field-v0.22` + tag `v0.22-card-field`) — the pane simply
  // stops mounting it. The mutual-exclusion choreography the desk shared
  // with it (exit latches, never-mounted-together) retired with it: the
  // desk is now the slot's only owner and mounts the moment `deskDoc` is
  // set.
  const onConversationRung = rung === "conversation";

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
  // THE FEED LEASE (v0.23). The pane publishes nothing any more — the card
  // field retired — so the chat half owns the band feed everywhere except
  // mid-transition, exactly the conversation-rung rule the card field used
  // to hold at card rungs.
  useLayoutEffect(() => {
    setFeedPublishing(!transitionActive);
  }, [transitionActive, setFeedPublishing]);
  useEffect(() => () => setFeedPublishing(true), [setFeedPublishing]);
  // `?at=` suppression keeps the deep link from jumping the (dimmed) chat
  // while the reader is up — the same card-rung rule as before, now keyed
  // off the rung itself.
  useLayoutEffect(() => {
    setSuppressAtJump(!onConversationRung);
  }, [onConversationRung, setSuppressAtJump]);
  useEffect(() => () => setSuppressAtJump(false), [setSuppressAtJump]);

  // ── THE READER LAYOUT (v0.23) ────────────────────────────────────────────
  // The library column's width is MEASURED, not assumed: it is the single
  // source the desk's camera offset reads, so the paper centres in the main
  // area to the column's right (world px = screen px at the z=0 plane; a
  // camera x of -D shifts content right by D). Below `md` the column hides
  // and the measurement reads 0 — the paper then centres in the full pane.
  const libColRef = useRef<HTMLElement | null>(null);
  const [libColW, setLibColW] = useState(0);
  useLayoutEffect(() => {
    const el = libColRef.current;
    if (!el) {
      setLibColW(0);
      return;
    }
    const update = () => setLibColW(el.offsetWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onConversationRung]);

  // ── THE ONE CANVAS (§14 merge) ───────────────────────────────────────────
  // Both worlds render in the shell-owned WorldCanvas, the game joining the
  // field as the other world. The band's rect comes from the same tier spec
  // the AxisBand sizes itself by, so the braid's scissor window lands
  // exactly under the band's DOM. THE BAND PROP STAYS while the field world
  // is mounted, even in the reader (where the band's DOM is gone): the
  // canvas gates the field world's renderer on `band !== null`
  // (world-canvas.tsx), so nulling it would blank the desk scene too — the
  // empty retired braid just winds unseen under the library column.
  const { spec } = useTier();
  const bandX = spec.railMargin;
  const bandW = spec.railW;
  const camXOffset = -(bandX + bandW) / 2;
  // The desk's camera offset. On the CONVERSATION rung the band still takes
  // its strip, so the paper keeps the band-based shift it has always had.
  // In the READER the band is gone and the library column takes its place:
  // the paper centres in the main area, shifted right by half the column.
  const deskCamXOffset = onConversationRung ? camXOffset : -libColW / 2;

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
      {/* LEFT: the time axis — CONVERSATION RUNG ONLY (v0.23). In the reader
          the card rungs are the document library's, and the band renders
          nowhere; its braid still winds in the canvas under the column (the
          band prop must stay non-null, see above), unseen. The band's DOM
          waits for the same phase as the rest of the field chrome: it
          arrives with the dissolve when the field is the destination and
          stays while the field is the source. Field world only — the game
          owns the whole viewport. */}
      {fieldChrome && onConversationRung && <AxisBand range={range} feed={feed} />}

      {/* RIGHT: the conversation field's pane slot + the reader chrome. THE
          CONVERSATION LAYER ITSELF IS NOT HERE any more — §3.1 mounted it at
          the layout (chat/conversation-overlay.tsx), a sibling of this route
          that survives navigation and world rebuilds. Only the field's pane
          slot remains, because the R3F band still reaches into this pane. */}
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
            // `inset-0`, not `inset-y-0 left-0`: an absolute box with only a
            // left edge shrink-wraps to ZERO width, and the field portaled
            // into it measured 0 px — the canvas never sized, no block ever
            // entered the visible set, and the conversation rendered nothing.
            className={`absolute inset-0 z-0 transition-opacity duration-300 ${
              onConversationRung
                ? "opacity-100"
                : "pointer-events-none opacity-0"
            }`}
          />
        )}

        {fieldChrome && (
          <>
        {/* THE LIBRARY COLUMN (v0.23) — the reader's three-level filter,
            the pane's left strip. DOM chrome over the canvas; the desk's
            camera shifts right by half its measured width so the paper
            centres in the main area. Below `md` it hides and the reader is
            the paper alone. */}
        {!onConversationRung && (
          <aside
            ref={libColRef}
            data-doc-library
            className="absolute inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-border bg-background md:flex"
          >
            <DocLibrary persona={persona} />
          </aside>
        )}

        {/* THE EMPTY READER — nothing open: a quiet hint centred in the main
            area (to the column's right), no new visual language. */}
        {!onConversationRung && deskDoc === null && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center justify-center"
            style={{ left: libColW }}
          >
            <p className="max-w-60 px-6 text-center text-sm leading-relaxed text-muted-foreground/70">
              {tLibrary("empty")}
            </p>
          </div>
        )}

        {/* THE DOCUMENT DESK (v0.22, the reader's main area since v0.23) —
            the field slot's only owner now: it mounts the moment `deskDoc`
            is set, swaps the paper in place when the ref changes (the
            pull-out re-plays inside the scene), and unmounts on Escape.
            The pane swap is the same 300 ms opacity idiom as the old
            conversation↔cards switch; the paper's own entrance beat plays
            inside the scene. */}
        <AnimatePresence>
          {deskDoc !== null && (
            <motion.div
              key="desk"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 z-10"
            >
              <DeskField
                docRef={deskDoc}
                camXOffset={deskCamXOffset}
                reducedMotion={reducedMotion}
                texts={deskTexts}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* THE BOARD BAR — the zoom lens, floating at the top of the screen.
            Mounted with the SHELL rather than with the card field, because
            the control that gets you back to the conversation must not
            disappear at exactly the moment you are on the conversation. See
            `board-bar.tsx`. */}
        <BoardBar
          rung={rung}
          onRungChange={setRung}
          reducedMotion={reducedMotion}
        />
        {/* The two ends, floating on the same right-hand edge as the lens. They
            used to sit ON the rail, which by then held a thumb, a readout, a
            crossing dot and these two — a 32px column where the controls were
            competing with the thing they controlled. The rail says where time
            IS; the right edge is where you act on it. */}
        {/* THE JUMP CONTROLS — CONVERSATION RUNG ONLY (v0.23). They only
            ever served the card field; in the reader the left edge is the
            library column's, so the controls' stack is gone. On the
            conversation rung the bottom control keeps its old
            seek-to-bottom: the chat field's live edge IS now. */}
        {onConversationRung && <JumpControls feed={feed} />}
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
