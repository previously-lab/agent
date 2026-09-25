"use client";

/**
 * AppShell (v0.11) — the single-route shell that hosts both chat and timeline
 * views on `/`. ALL product navigation is IN-MEMORY state owned here (the
 * world, the rung, the shared slice address, the conversation jump) — the
 * URL carries none of it. The left time axis (AxisBand) is always mounted;
 * the right pane holds the card field at a card rung, with the CONVERSATION
 * LAYER (`chat/conversation-panel.tsx`) floating over everything as a
 * persistent two-tier panel (pill strip / fullscreen, v0.13 §4). The chat
 * stream stays MOUNTED at every tier — the pill folds the panel body to
 * zero height instead of unmounting it — so the field camera and the live
 * useChat stream survive every collapse, and FULLSCREEN freezes the card
 * field's frame loop (`paused` → frameloop="never") without unmounting it.
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
 * cold-boot conversation deep link consumed once by ChatPage (chat-page.tsx)
 * — a shared link still lands on its slice, but nothing inside the session
 * ever produces one.
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
import { useTranslations } from "next-intl";
import { Hotel, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { UserConfig } from "@/lib/config/types";
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
  createFieldFeed,
  type FieldFeed,
} from "@/lib/timeline3d/field-feed";
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
import type { SubtitleLine } from "@/lib/chat/subtitle-line";
import {
  ShellNavContext,
  type ShellNav,
} from "@/components/shell/shell-nav";
import { ISLAND } from "@/components/layout/island";
import { useChromeInset } from "@/hooks/use-chrome-inset";
import { useBridgeBrainActive } from "@/hooks/use-bridge-brain";
import { useTier } from "@/hooks/use-tier";
import { ChatPage } from "@/components/chat/chat-page";
import {
  ConversationPanel,
  type ConversationPanelMode,
} from "@/components/chat/conversation-panel";
import {
  ConversationSurfaceProvider,
  type ConversationSurface,
} from "@/components/chat/conversation-surface";
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

interface AppShellProps {
  /** Server-preloaded user config passed through to ChatPage. */
  initialConfig?: UserConfig;
}

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

export function AppShell({ initialConfig }: AppShellProps) {
  // THE URL IS DEV-ONLY. `?view=game` is read ONCE, as the cold-boot world,
  // so the debug gallery's link (`?view=game&debug=rooms`, game-shell.tsx)
  // still opens straight into the hotel. Nothing else reads the query string
  // here and nothing ever writes it: a refresh returns to the field at the
  // conversation rung, exactly like a fresh visit.
  const searchParams = useSearchParams();
  const [settledView, setSettledView] = useState<WorldKind>(() =>
    searchParams.get("view") === "game" ? "game" : "field",
  );
  // THE WORLD SWITCH (§14) — a TRANSITION, never a snap, and PURE STATE: no
  // URL leg, no reconciliation. `settledView` is the world the reader is in;
  // `transition` is a live move between the worlds (owned by the shell,
  // driven per frame by world-transition.ts). `sharedSlice` is the shared
  // slice address — the memory form of the old `?slice=`/`?at=` contract,
  // consumed two ways: the field focuses the slice's card (its `initialAtId`
  // — flashed), the game stands the reader at the slice's door
  // (game-canvas.tsx's `focusSlice`). The shell's navigation actions
  // (shell-nav.ts) compose these with the transition machine.
  const [sharedSlice, setSharedSlice] = useState<string | null>(null);
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
  // THE FEED IS ONE OBJECT WITH ONE WRITER (`lib/timeline3d/field-feed.ts`).
  // Both fields are mounted whenever the timeline view is open — the chat one
  // dimmed behind the other — and they used to publish into four shared refs
  // with no ownership rule between them, so the band's position came down to
  // which of the two rendered last. `panePublishes` below is the whole rule.
  const feedRef = useRef<FieldFeed | null>(null);
  feedRef.current ??= createFieldFeed();
  const feed = feedRef.current;
  /** The zoom rung, owned here so the floating lens switcher reads the same
   *  value CardField transitions through. Memory-only: a bare `/` always
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
  /** A turn is streaming. Reported up by `ChatPage`, which is the only half
   *  that knows (`useChat`'s `isLoading`); the card field draws its abstract
   *  placeholder from it. See `RunningCard`. */
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
    [],
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

  // ── THE SHELL'S NAVIGATION ACTIONS (shell-nav.ts) ────────────────────────
  // The memory form of the old `?slice=` / `?at=` contract. `focusSlice`
  // addresses a slice to the card field, `standAtSlice` to the hotel (the
  // reader stands at the slice's door), `openSlice` is the conversation
  // jump. All three are pure state — no URL, no router.
  const focusSlice = useCallback(
    (sliceId: string) => {
      setSharedSlice(sliceId);
      if (transitionRef.current) return; // a move owns the rung seeding
      if (settledRef.current !== "field") {
        beginTransition("field", sliceId);
      } else {
        setRung("slice");
      }
    },
    [beginTransition],
  );
  const standAtSlice = useCallback(
    (sliceId: string) => {
      setSharedSlice(sliceId);
      if (transitionRef.current) return;
      if (settledRef.current !== "game") beginTransition("game", null);
    },
    [beginTransition],
  );
  const openSlice = useCallback(
    (sliceId: string, start?: string) => {
      // The card field's click: address the slice — the field focuses and
      // flashes its card at the current rung (the shared address), and
      // when the CONVERSATION is the active surface the jump itself runs
      // through the M2 bus, exactly the split the old `?at=` consumption
      // had (chat-page.tsx suppresses its deep-link jump at a card rung).
      // `start` rides the bus so the travel clock skips its resolve fetch.
      setSharedSlice(sliceId);
      if (rungRef.current === "conversation") requestSliceJump(sliceId, start);
      if (transitionRef.current) return;
      if (settledRef.current !== "field") beginTransition("field", null);
    },
    [beginTransition],
  );
  const shellNav = useMemo<ShellNav>(
    () => ({ focusSlice, standAtSlice, openSlice }),
    [focusSlice, standAtSlice, openSlice],
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
  // One conversation, two sizes — the tier lives HERE, not inside the
  // panel, because the shell must react to it: the game world and the card
  // rungs default to the pill (the bottom strip: quick input, the subtitle
  // line, nothing else), the conversation rung defaults to fullscreen (the
  // full-capability surface the removed dock used to be), and FULLSCREEN
  // freezes the card field's frame loop (paused → frameloop="never", below).
  // The effect fires only on the world boundary — zooming BETWEEN card
  // rungs keeps the tier the reader picked.
  const [panelMode, setPanelMode] =
    useState<ConversationPanelMode>("fullscreen");
  const worldKind = rung === "conversation" ? "conversation" : "cards";
  useEffect(() => {
    // The game world is a LOOKING view like the card rungs — the conversation
    // arrives as the pill there too.
    setPanelMode(
      view === "game" || worldKind !== "conversation" ? "pill" : "fullscreen",
    );
  }, [worldKind, view]);
  const worldFrozen = panelMode === "fullscreen";
  // The pill strip's subtitle line (v0.13 §4): folded from the live message
  // stream by ChatPage (the only holder of the messages), lifted here, and
  // handed back down into the panel as a prop — the panel renders it, the
  // page produces it, and this state is the wire between them.
  const [subtitleLine, setSubtitleLine] = useState<SubtitleLine | null>(null);

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

  // ── THE CONVERSATION SURFACE (the restored R3F field's host) ─────────────
  // The conversation field renders through a portal into whichever surface can
  // host its window-derived 680 px column: the pane's slot while the panel
  // floats beside it (the pill strip leaves the whole pane free), a slot
  // inside the panel body at fullscreen, and — with no wide host (the game
  // view below the fullscreen tier) — the DOM list takes the conversation
  // instead (see `chat/conversation-surface.tsx`). The slot elements are
  // owned HERE because the shell owns both their parents; `useState` refs
  // re-render on registration, the same handshake `world-canvas.tsx` uses.
  const [paneSlotEl, setPaneSlotEl] = useState<HTMLElement | null>(null);
  const [panelSlotEl, setPanelSlotEl] = useState<HTMLElement | null>(null);
  const onConversationRung = rung === "conversation";
  const conversationSurface: ConversationSurface =
    view === "game"
      ? panelSlotEl
        ? { kind: "field", el: panelSlotEl }
        : { kind: "narrow" }
      : panelMode === "fullscreen"
        ? panelSlotEl
          ? { kind: "field", el: panelSlotEl }
          : { kind: "narrow" }
        : { kind: "field", el: paneSlotEl };

  // A conversation jump (`openSlice`, the search palette rides the M2 bus
  // directly) is pure state now: `openSlice` homes the world to the field
  // when the jump comes from the hotel, and the conversation performs the
  // jump itself (chat-page.tsx) — nothing needs clearing afterwards.

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
  }, [view, panelMode, beginTransition]);

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
  // foot, in px. BOTH are measured from the things themselves (see
  // `use-chrome-inset.ts` and `composer-host.tsx`) and both are OWNED HERE,
  // because both fields float under the same two controls and the shell is the
  // only place above both of them.
  //
  // They are RANGE insets, not container padding: the fields fill the pane and
  // the content travels under the controls on its way past them, coming to rest
  // clear of them. A padding on the pane would crop the content instead — see
  // `minOffsetFor`.
  const chromeInset = useChromeInset();
  const [composerClearance, setComposerClearance] = useState(0);

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
  //    `sharedSlice`, or a transition's terminal slice) loads the full catalog
  //    so the addressed slice is always resolvable; otherwise loads the latest
  //    month window. ─────────────────────────────────────────────────────────
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
  /** THE OWNERSHIP RULE, in one line. Exactly one pane publishes to the band at
   *  a time: the card field while a card rung is up, the chat otherwise. The
   *  other field is still mounted and still animating — it simply writes
   *  nothing, which is why this is a lease rather than a merge. */
  const panePublishes = showCardField;

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
    // DOM-side owners (they are siblings here) — see world-canvas.tsx.
    <WorldSceneProvider>
    <ShellNavContext.Provider value={shellNav}>
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

      {/* RIGHT: chat stream (always mounted) + timeline overlay when active. */}
      <ConversationSurfaceProvider value={conversationSurface}>
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* THE CONVERSATION FIELD'S PANE SLOT — the restored R3F conversation
            renders HERE, in the 2.5D view, exactly where the conversation
            rung lived before the DOM refactor: portal target for the field
            (see `chat/conversation-surface.tsx`). Dimmed, not unmounted, at a
            card rung — the subtree holds the field's camera position — and
            at conversation rung the reader reads history in the pane while
            the ongoing turn lives in the panel. Rides the field chrome's
            phase like the band. */}
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
        {/* THE CONVERSATION LAYER — one persistent panel over the world
            (v0.13 §4), not a view of its own any more: a bottom strip at the
            pill tier, a viewport-wide overlay at fullscreen. `position:
            fixed` either way: the world behind it keeps its size, so no tier
            change ever triggers a canvas resize. ChatPage keeps publishing
            to the band only while the conversation rung owns it, and still
            receives `suppressAtJump` at a card rung — but its OWN rung is
            pinned to "conversation": tier visibility is the panel's job.
            At FULLSCREEN the panel is viewport-wide, so it hosts the R3F
            field itself (bodyPrefix is the portal target); at the pill tier
            the field portals into the pane and the strip keeps the quick
            input + the subtitle line at the viewport's foot. */}
        <ConversationPanel
          mode={panelMode}
          onModeChange={setPanelMode}
          subtitleLine={subtitleLine}
          bodyPrefix={
            panelMode === "fullscreen" ? (
              <div ref={setPanelSlotEl} className="min-h-0 flex-1" />
            ) : undefined
          }
        >
          <ChatPage
            initialConfig={initialConfig}
            suppressAtJump={showCardField}
            rung="conversation"
            onTurnSettled={refreshCatalog}
            feed={feed}
            // Frozen while a world transition runs: the feed is one-writer
            // (field-feed.ts), and a move mounts/unmounts the fields
            // around the band — nobody publishes mid-move.
            publishing={!panePublishes && !transitionActive}
            onRunningChange={setRunning}
            onSubtitleLineChange={setSubtitleLine}
            insetTop={0}
            insetBottom={composerClearance}
            onComposerClearanceChange={setComposerClearance}
          />
        </ConversationPanel>

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
                      onOpenSlice={openSlice}
                      onNarrate={bridgeBrain === false ? startNarration : undefined}
                      initialAtId={focusId ?? undefined}
                      strands={strands}
                      feed={feed}
                      // Same freeze as the chat field — the one-writer rule
                      // holds through the move (see ChatPage above).
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
        <JumpControls feed={feed} />
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

        {/* THE WORLD SWITCH (§14) — the field world's way into the hotel. A
            quiet island button at the pane's foot, clear of the composer; the
            way back is the game's own exit button or Escape. Both now START
            THE TRANSITION instead of snapping the view. */}
        <button
          type="button"
          onClick={() => beginTransition("game", null)}
          aria-label={tGame("title")}
          title={tGame("title")}
          className={`${ISLAND} pointer-events-auto absolute bottom-4 left-4 z-10 flex size-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
        >
          <Hotel className="size-4" />
        </button>
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
      </ConversationSurfaceProvider>
    </div>
    </ShellNavContext.Provider>
    </WorldSceneProvider>
  );
}
