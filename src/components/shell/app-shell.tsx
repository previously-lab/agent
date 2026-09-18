"use client";

/**
 * AppShell (v0.11) — the single-route shell that hosts both chat and timeline
 * views on `/`. The rung (`?z=`, absent = conversation) is the only
 * navigation. The left time axis (AxisBand) is always mounted; the right pane
 * holds the card field at a card rung, with the CONVERSATION LAYER
 * (`chat/conversation-panel.tsx`) floating over everything as a persistent
 * three-tier panel (pill / dock / fullscreen, §14.1). The chat stream stays
 * MOUNTED at every tier — pill slides the panel offscreen instead of
 * unmounting — so Virtuoso scroll state and the live useChat stream survive
 * every collapse, and FULLSCREEN freezes the card field's frame loop
 * (`paused` → frameloop="never") without unmounting it.
 *
 * Catalog loading is lazy: the timeline data layer (catalog window + strand
 * list) is fetched on the first switch to the timeline view. A deep link
 * `/?view=timeline&at=<sliceId>` loads the full catalog so the linked slice is
 * always resolvable, mirroring the old `/timeline` page behavior.
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
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import { Hotel, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
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
  getStrandList,
  getTimelineCatalog,
  getTimelineCatalogPage,
  type StrandListItem,
} from "@/lib/episodic/actions";
import {
  DEFAULT_RUNG,
  parseAtParam,
  parseRungParam,
} from "@/lib/chat/deep-link";
import { ISLAND } from "@/components/layout/island";
import { useChromeInset } from "@/hooks/use-chrome-inset";
import { useBridgeBrainActive } from "@/hooks/use-bridge-brain";
import { useTier } from "@/hooks/use-tier";
import { ChatPage } from "@/components/chat/chat-page";
import {
  ConversationPanel,
  type ConversationPanelMode,
} from "@/components/chat/conversation-panel";
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

export function AppShell({ initialConfig }: AppShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawSearch = searchParams.toString();
  // THE RUNG IS THE ONLY NAVIGATION. There used to be a view mode beside it
  // (`?view=timeline` = cards, absent = chat) and the two were the same axis at
  // different resolutions — see `deep-link.ts`. `?z=` names the rung; a deep
  // link with `?at=` still lands on the slice rung, because a reader arriving
  // at a named slice wants the field one step coarser than the conversation.
  const rungParam = parseRungParam(rawSearch);
  const at = parseAtParam(rawSearch);
  // THE WORLD SWITCH (§14): `?view=game` mounts the hotel instead of the
  // field world; absent (or the old `?view=timeline` alias) is the field.
  // The override is the in-session toggle — the URL param is the arrival.
  // `?slice=` is the SHARED ADDRESS: the field focuses the slice's card
  // (lands on the slice rung, flashed), the game stands at its door
  // (game-canvas.tsx). It is deliberately separate from `?at=`, whose
  // remaining meaning is a CONVERSATION jump (see the rung note below).
  const sliceParam = searchParams.get("slice");
  const viewParam = searchParams.get("view");
  const [viewOverride, setViewOverride] = useState<WorldKind | null>(null);
  const view: WorldKind =
    viewOverride ?? (viewParam === "game" ? "game" : "field");
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
   *  value CardField transitions through. Seeded from `?z=` when the URL names
   *  one, and otherwise from `DEFAULT_RUNG` — the CONVERSATION, so a bare `/`
   *  opens on the live conversation exactly as it always has. (The card field's
   *  own default is `day`; that is the right default for someone who asked for
   *  the timeline and the wrong one for someone who just opened the app.)
   *
   *  `?at=` DELIBERATELY DOES NOT PICK A RUNG. It used to force `slice`, and
   *  that was a porting slip: the rule was written when `?view=` still chose
   *  which pane was up, so "the slice rung" then meant "open the timeline
   *  field at this slice". With the view gone, `?at=` means what its only
   *  remaining callers mean by it — a slice JUMP, which the conversation
   *  performs (`openSlice`, the search palette). Forcing `slice` opened the
   *  card field on top of the jump and the conversation never happened; the
   *  e2e caught it. `?z=slice&at=…` still asks for the card rung at a slice.
   *
   *  `?slice=` DOES seed the slice rung — but only in the field world: the
   *  shared address means "look at this slice", and the field's way of looking
   *  is the slice rung with the card flashed. In the game world it addresses
   *  the hotel instead (the reader stands at its door), so the rung keeps the
   *  conversation default. */
  const [rung, setRung] = useState<FieldRung>(
    rungParam ?? (sliceParam && view !== "game" ? "slice" : DEFAULT_RUNG),
  );

  // The rung lives in the URL so a refresh or a share keeps the zoom — the view
  // param used to be the only thing that survived, which meant the one piece of
  // state the reader actually manipulates was the one that did not. Written with
  // `replaceState`, not a router push: the rung changes on every wheel-zoom, and
  // a history entry per notch would make Back useless.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (rung === DEFAULT_RUNG) params.delete("z");
    else params.set("z", rung);
    // The world rides the URL too: a refresh or a share of `/?view=game`
    // reopens the hotel. The field is the default, so it writes nothing.
    if (view === "game") params.set("view", "game");
    else params.delete("view");
    const q = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${q ? `?${q}` : ""}`,
    );
  }, [rung, view]);

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

  // ── THE CONVERSATION LAYER'S TIER (§14.1) ───────────────────────────────
  // One conversation, three sizes — the tier lives HERE, not inside the
  // panel, because the shell must react to it: a card rung defaults to the
  // pill (the reader came to look at the cards), the conversation rung
  // defaults to the dock, and FULLSCREEN freezes the card field's frame
  // loop (paused → frameloop="never", below). The effect fires only on the
  // world boundary — zooming BETWEEN card rungs keeps the tier the reader
  // picked (a docked conversation survives slice → day).
  const [panelMode, setPanelMode] =
    useState<ConversationPanelMode>("dock");
  const worldKind = rung === "conversation" ? "conversation" : "cards";
  useEffect(() => {
    // The game world is a LOOKING view like the card rungs — the conversation
    // arrives as the pill there too.
    setPanelMode(
      view === "game" || worldKind !== "conversation" ? "pill" : "dock",
    );
  }, [worldKind, view]);
  const worldFrozen = panelMode === "fullscreen";

  // A conversation jump (`?at=` — `openSlice`, the search palette) is a FIELD
  // world act: arriving on one clears an in-session game override so the
  // linked slice is never buried under the hotel.
  useEffect(() => {
    if (at) setViewOverride(null);
  }, [at]);

  // Escape in the game world: panel first (anything open folds to the pill),
  // then the view itself (back to the field). The panel's own Escape lives on
  // its container with stopPropagation, so the two never fire together.
  useEffect(() => {
    if (view !== "game") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (panelMode !== "pill") setPanelMode("pill");
      else setViewOverride("field");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, panelMode]);

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

  // ── Lazy catalog load on the first CARD rung (or a deep link that starts on
  //    one). A slice address (`?at=`, or the shared `?slice=` in the field
  //    world) loads the full catalog so the linked slice is always resolvable;
  //    otherwise loads the latest month window. ──────────────────────────────
  const focusId = at ?? sliceParam;
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

  const openSlice = useCallback(
    (sliceId: string, start?: string) => {
      // `atStart` carries the slice's ISO start — the chat page's jump
      // handler needs it for the travel clock and would otherwise spend a
      // full catalog fetch to learn it.
      const startParam = start
        ? `&atStart=${encodeURIComponent(start)}`
        : "";
      router.push(`/?at=${encodeURIComponent(sliceId)}${startParam}`);
    },
    [router],
  );

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

  return (
    // The world-slot provider must sit ABOVE both the canvas and the worlds'
    // DOM-side owners (they are siblings here) — see world-canvas.tsx.
    <WorldSceneProvider>
    <div className="relative flex h-dvh overflow-hidden">
      {/* The field world's page atmosphere, UNDER the canvas (the canvas is
          transparent; the aurora used to sit behind the pane's own canvas,
          now it sits behind the shared one). Inset past the band so the
          strip keeps the plain page background it has always had. Mounted
          only at a card rung, exactly as before. */}
      {view === "field" && showCardField && (
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
          header itself is not this file's to change. */}
      {view === "game" && <style>{`[data-app-header]{display:none}`}</style>}
      <WorldCanvas
        world={view}
        paused={worldFrozen}
        band={
          view === "field"
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
      {/* LEFT: the time axis, present in BOTH views. It is not a timeline-view
          affordance — it is where the app's strands live, and it stays put
          across the switch. Its braid renders in the shared canvas (scissored
          to this strip's rect); what mounts here is the band's DOM half, so
          the scrub lens and fades sit above the canvas by DOM order. The
          right pane supplies the anchors either way: the card field's rows
          in the timeline, the chat stream's slice seams in chat, so the
          braid winds at whatever the user is actually looking at. Field
          world only — the game owns the whole viewport. */}
      {view === "field" && <AxisBand range={range} feed={feed} />}

      {/* RIGHT: chat stream (always mounted) + timeline overlay when active. */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* THE CONVERSATION LAYER — one persistent panel over the world
            (§14.1), not a view of its own any more. The panel OVERLAYS the
            pane (position: fixed): the card field behind it keeps its size,
            so opening or docking never triggers a canvas resize. ChatPage
            keeps publishing to the band only while the conversation rung
            owns it, and still receives `suppressAtJump` at a card rung —
            but its OWN rung is pinned to "conversation": tier visibility is
            the panel's job now, and the composer is the full form at every
            tier. insetTop={0} because the panel's own slim bar replaced the
            floating chrome's keep-out inside it. */}
        <ConversationPanel
          mode={panelMode}
          onModeChange={setPanelMode}
          insetTop={chromeInset}
        >
          <ChatPage
            initialConfig={initialConfig}
            suppressAtJump={showCardField}
            rung="conversation"
            onTurnSettled={refreshCatalog}
            feed={feed}
            publishing={!panePublishes}
            onRunningChange={setRunning}
            insetTop={0}
            insetBottom={composerClearance}
            onComposerClearanceChange={setComposerClearance}
          />
        </ConversationPanel>

        {view === "field" && (
          <>
        <AnimatePresence>
          {showCardField && (
            <motion.div
              key="timeline"
              // Opacity-only (§14 merge): the cards render in the shell's
              // shared canvas now, so this DOM layer can no longer slide the
              // scene with it — a fade keeps the two in step.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 z-10 flex flex-col"
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
                      publishing={panePublishes}
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
                    />
                  </motion.div>
                )}
              </AnimatePresence>
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
            way back is the game's own exit button or Escape. */}
        <button
          type="button"
          onClick={() => setViewOverride("game")}
          aria-label={tGame("title")}
          title={tGame("title")}
          className={`${ISLAND} pointer-events-auto absolute bottom-4 left-4 z-10 flex size-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground`}
        >
          <Hotel className="size-4" />
        </button>
          </>
        )}

        {view === "game" && (
          <div className="relative flex-1 min-h-0">
            <GameShell
              onExit={() => setViewOverride("field")}
              focusSlice={sliceParam}
            />
          </div>
        )}
      </div>
    </div>
    </WorldSceneProvider>
  );
}
