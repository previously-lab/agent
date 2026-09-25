"use client";

/**
 * ShellProvider (v0.13 §3.1) — the LAYOUT-level home of everything the
 * conversation layer and the route content share.
 *
 * WHY THIS EXISTS. The conversation layer used to live INSIDE AppShell, and
 * the conversation field reached its home by portaling into DOM slots whose
 * refs AppShell owned. That made the overlay a prisoner of the route: any
 * rebuild of the shell subtree remounted the panel, and a slot ref that had
 * not registered yet handed the R3F portal a null target — the
 * `CanvasImpl.connect: addEventListener of null` crash class. §3.1's ruling:
 * the conversation layer is a real floating layer — mounted once at the
 * layout, a sibling of the route content, above the canvas by z-index,
 * surviving navigation and world rebuilds. For that, the state the overlay
 * and the routes SHARE had to move up with it; this provider is that state.
 *
 * WHAT LIVES HERE, AND WHY IT CANNOT STAY IN A ROUTE:
 *
 *   panelMode        the panel tier (pill / fullscreen). The overlay renders
 *                    it; the route reacts to it (the freeze below). Neither
 *                    may own it alone.
 *   worldFrozen      the "freeze the world" signal, DERIVED here
 *                    (fullscreen freezes) and consumed by the route's canvas
 *                    (`paused` → frameloop="never" — pause, never unmount).
 *   sharedSlice      the ONE cursor every surface reads AND every surface
 *                    moves (v0.13 §6 一个游标). Written by the nav actions,
 *                    and quietly by the surfaces themselves: the world's
 *                    roaming (game-canvas reports the room the reader
 *                    stands in) and the card stack's scrolling (card-field
 *                    reports the centred card) move the SAME cursor through
 *                    `reportCursor` — the write that steers no world. Read
 *                    by the route (field focus / hotel door), by
 *                    `getChatView`, and at call time by `getCursor`.
 *   nav (ShellNav)   focusSlice / standAtSlice / openSlice. Each moves the
 *                    cursor HERE and delegates the world motion to the
 *                    route's registered driver — the transition machine and
 *                    the rung belong to the world, and the world belongs to
 *                    the route.
 *   getChatView      the per-turn 视野 getter (v0.13 §5), read by the chat
 *                    transport at SEND time, never render time. No cursor, or
 *                    no registered world (off `/app`), is the lobby:
 *                    undefined, and the request carries no view block.
 *   feed             the one FieldFeed object (field-feed.ts). The band, the
 *                    card field and the chat stream share it; it is created
 *                    here so the stream's writer survives a route unmount.
 *   The CONVERSATION SURFACE slots — `paneSlotEl` rendered by the route (the
 *   pane's portal target), `panelSlotEl` by the overlay (the fullscreen
 *   body) — plus the composition of `ConversationSurface` from the slots,
 *   the tier and the route's reported pose. `useState`-backed element refs,
 *   the same handshake world-canvas.tsx uses: the re-render on registration
 *   is the point. A slot is null until its element registers, and a "field"
 *   surface is only ever published WITH a live element — a portal handed a
 *   null or detached element dies exactly at the canvas's connect.
 *   publishing /     the feed's one-writer lease and the `?at=` suppression
 *   suppressAtJump   flag — both computed by the route (it owns the rung and
 *                    the transition machine), pushed here, read by the chat
 *                    stream in the overlay.
 *   composerClearance the composer's measured foot inset — measured inside
 *                    the overlay's ChatPage, consumed by the route's card
 *                    field; the provider is the one place above both.
 *
 * THE ROUTE'S HALF — `WorldDriver`. The world (canvas, transition machine,
 * rung) stays in `/app`; the layout TALKS to it through a registered driver
 * instead of owning it. AppShell registers on mount and unregisters on
 * unmount: off `/app` the nav actions still move the cursor but drive no
 * world (there is none to drive), and `getChatView` falls back to the lobby.
 *
 * SSR / HYDRATION NOTE. The initial tier is read ONCE from
 * `window.location`: a `?view=game` cold boot must START at the pill — a
 * wrong first tier renders the fullscreen body (and its R3F portal target)
 * for one commit and folds it the next, and that mount-fold churn at connect
 * time is exactly the crash class this hoist exists to kill. Server and
 * client can therefore disagree on the initial value — safely: `panelMode`
 * reaches no SSR'd markup (the overlay is client-only, and the route reads
 * the tier only in effects and in the client-only canvas's `paused` prop).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FieldRung } from "@/lib/timeline3d/units";
import type { CurrentView } from "@/lib/chat/current-view";
import { DEFAULT_RUNG } from "@/lib/chat/deep-link";
import { createFieldFeed, type FieldFeed } from "@/lib/timeline3d/field-feed";
import { CURSOR_HOOKS } from "@/lib/timeline3d/cursor";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import type { ConversationPanelMode } from "@/components/chat/conversation-panel";
import {
  ConversationSurfaceProvider,
  type ConversationSurface,
} from "@/components/chat/conversation-surface";
import { ShellNavContext, type ShellNav } from "@/components/shell/shell-nav";

/**
 * The world's pose, as the route last reported it. The SURFACE composition
 * below needs it reactively (a settle into the hotel swaps the field's
 * portal target); the per-turn view getter reads the same pair through the
 * driver's `getPose` instead, because it runs at send time, outside React.
 */
export interface WorldPose {
  settled: WorldKind;
  rung: FieldRung;
}

/**
 * What the route (the world) implements and the provider calls. The cursor
 * half of every nav action lives in the provider; these are the WORLD-MOTION
 * halves, plus the two turn callbacks the overlay's ChatPage reports and the
 * pose read the send-time getter needs.
 */
export interface WorldDriver {
  /** Address a slice to the CARD FIELD (the old focusSlice minus the cursor). */
  focusSlice: (sliceId: string) => void;
  /** Address a slice to the HOTEL (the old standAtSlice minus the cursor). */
  standAtSlice: (sliceId: string) => void;
  /** The CONVERSATION jump (the old openSlice minus the cursor). */
  openSlice: (sliceId: string, start?: string) => void;
  /** The live pose, read at CALL time — never a render-time snapshot. */
  getPose: () => WorldPose;
  /** A turn settled — the route refreshes its card catalog. */
  onTurnSettled: () => void;
  /** A turn started/stopped streaming — the route draws the running card. */
  setRunning: (running: boolean) => void;
}

interface ShellValue {
  panelMode: ConversationPanelMode;
  setPanelMode: (mode: ConversationPanelMode) => void;
  /** Fullscreen freezes the world — the route hands this to the canvas as
   *  `paused` (frameloop="never"). Pause, never unmount. */
  worldFrozen: boolean;
  /** The shared slice address — the one cursor every surface reads. */
  sharedSlice: string | null;
  /** The cursor's QUIET write (v0.13 §6 一个游标): the surfaces' own motion
   *  — the room the reader walks into, the card a scroll centres — moves
   *  the SAME cursor the nav actions own, but steers NO world (the nav
   *  actions are the only writers that also drive world motion). */
  reportCursor: (sliceId: string | null) => void;
  /** The cursor at CALL time (the synchronously-written ref, not the render
   *  snapshot) — for event-callback readers that can outrun the render
   *  pipeline, like the route's "where was I" memory. */
  getCursor: () => string | null;
  /** The per-turn view getter (v0.13 §5) — see the module header. */
  getChatView: () => CurrentView | undefined;
  /** The one band feed — see `field-feed.ts`. */
  feed: FieldFeed;
  /** The feed's one-writer lease, computed and pushed by the route. */
  publishing: boolean;
  /** True while the route's card rungs own the `?at=` anchor. */
  suppressAtJump: boolean;
  /** The composer's measured foot inset — see the module header. */
  composerClearance: number;
  setComposerClearance: (px: number) => void;
  /** Slot registration — `useState`-backed element refs (module header). */
  setPaneSlotEl: (el: HTMLElement | null) => void;
  setPanelSlotEl: (el: HTMLElement | null) => void;
  /** The route's registration channel — see `WorldDriver`. */
  registerWorldDriver: (driver: WorldDriver | null) => void;
  setWorldPose: (pose: WorldPose | null) => void;
  setFeedPublishing: (publishing: boolean) => void;
  setSuppressAtJump: (suppress: boolean) => void;
  /** Forwarders the overlay's ChatPage reports through; they reach the
   *  registered driver, and no-op off `/app` (no world to refresh). */
  reportTurnSettled: () => void;
  reportRunning: (running: boolean) => void;
}

const ShellContext = createContext<ShellValue | null>(null);

/** The layout-level shell channel — throws outside ShellProvider (a bug:
 *  the overlay and the app shell both render under it). */
export function useShell(): ShellValue {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell outside ShellProvider");
  return shell;
}

/** The FIRST tier is the cold-boot verdict, not a placeholder (see the
 *  module header's SSR note): the pill for a `?view=game` boot, for a
 *  non-default rung, and for any route that is not the app surface itself —
 *  a route with no world behind it (settings) must never be covered by a
 *  fullscreen conversation on its first commit (folding it afterwards would
 *  mount and unmount the panel's portal target in one commit — exactly the
 *  R3F connect-time churn this hoist exists to kill). Fullscreen only for
 *  the app's own cold boot, whose first screen IS the conversation. The
 *  window pathname carries the locale prefix; stripping the first segment
 *  recovers the route. */
function initialPanelTier(): ConversationPanelMode {
  if (typeof window !== "undefined") {
    if (new URLSearchParams(window.location.search).get("view") === "game") {
      return "pill";
    }
    const path = window.location.pathname.replace(/^\/[^/]+/, "") || "/";
    if (path !== "/" && path !== "/app") return "pill";
  }
  return DEFAULT_RUNG !== "conversation" ? "pill" : "fullscreen";
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [panelMode, setPanelMode] = useState<ConversationPanelMode>(
    initialPanelTier,
  );
  const worldFrozen = panelMode === "fullscreen";

  // The navigation cursor, plus a read-anywhere mirror for the send-time
  // getter (the transport reads it at SEND time, outside React's render).
  const [sharedSlice, setSharedSlice] = useState<string | null>(null);
  const sharedSliceRef = useRef<string | null>(null);
  useEffect(() => {
    sharedSliceRef.current = sharedSlice;
  }, [sharedSlice]);

  // THE CURSOR'S QUIET WRITE (v0.13 §6 一个游标) — see ShellValue.reportCursor.
  // The surfaces report through the module hook (lib/timeline3d/cursor.ts —
  // the WORLD_TRANSITION.hooks idiom) rather than context, because one
  // reporter is game-canvas.tsx: its import chain is already loaded by the
  // pure-function vitest suites, and pulling this provider (and the chat
  // tree with it) into that chain to deliver one string would be the most
  // expensive possible channel. The same-value guard keeps a scroll that
  // parks on one card for hundreds of frames from re-rendering anything.
  const reportCursor = useCallback((sliceId: string | null) => {
    if (sharedSliceRef.current === sliceId) return;
    sharedSliceRef.current = sliceId;
    setSharedSlice(sliceId);
  }, []);
  // The cursor at CALL time. The state above is a render snapshot; this ref
  // moves in the same synchronous write, so an event-callback reader (the
  // route's transition machine saving its "where was I" memory) never sees
  // a value the render pipeline has not caught up with yet.
  const getCursor = useCallback(() => sharedSliceRef.current, []);
  useEffect(() => {
    CURSOR_HOOKS.report = reportCursor;
    return () => {
      CURSOR_HOOKS.report = null;
    };
  }, [reportCursor]);

  // THE FEED IS ONE OBJECT WITH ONE WRITER (lib/timeline3d/field-feed.ts).
  // Created here, above both of its fields' owners, so the chat stream's
  // half survives the app route unmounting.
  const feedRef = useRef<FieldFeed | null>(null);
  feedRef.current ??= createFieldFeed();
  const feed = feedRef.current;

  // The two conversation-surface slots and the route's reactive pose — see
  // the module header. Null until a real element registers, and null again
  // the moment its branch unmounts (leaving `/app` drops the pane slot).
  const [paneSlotEl, setPaneSlotEl] = useState<HTMLElement | null>(null);
  const [panelSlotEl, setPanelSlotEl] = useState<HTMLElement | null>(null);
  const [worldPose, setWorldPose] = useState<WorldPose | null>(null);
  const [publishing, setFeedPublishing] = useState(true);
  const [suppressAtJump, setSuppressAtJump] = useState(false);
  const [composerClearance, setComposerClearance] = useState(0);

  // The route's driver. A REF, not state: callers (the nav actions, the
  // send-time getter, the turn forwarders) all read it at call time, and a
  // registration must not re-render the layout's whole subtree.
  const driverRef = useRef<WorldDriver | null>(null);
  const registerWorldDriver = useCallback((driver: WorldDriver | null) => {
    driverRef.current = driver;
  }, []);

  // ── THE CONVERSATION'S VIEW OF THE WORLD (v0.13 §5 视野注入) ─────────
  // What the reader is currently looking at, derived at SEND time from the
  // shared cursor and the world's live pose (never render time — the
  // transport asks when the message leaves). Standing at the slice's door in
  // the hotel = room; the slice rung's focused card in the field = card;
  // ANYTHING ELSE — no shared address, a pile rung, the conversation rung,
  // or no registered world (a route without one) — is the lobby: the getter
  // returns undefined and the request carries NO view, so the server injects
  // no per-turn block. A mid-move read uses the settled world: that is where
  // the reader stands while the transition runs.
  const getChatView = useCallback((): CurrentView | undefined => {
    const sliceId = sharedSliceRef.current;
    if (!sliceId) return undefined;
    const pose = driverRef.current?.getPose();
    if (!pose) return undefined;
    if (pose.settled === "game") return { sliceId, surface: "room" };
    if (pose.rung === "slice") return { sliceId, surface: "card" };
    return undefined;
  }, []);

  // ── THE NAVIGATION ACTIONS (shell-nav.ts) ───────────────────────────────
  // The memory form of the old `?slice=` / `?at=` contract. Each action moves
  // the cursor HERE (the provider owns it) and then delegates the world
  // motion to the registered driver — with no driver (off `/app`) the cursor
  // still moves and nothing else happens, which is the honest state of a
  // route that has no world.
  const nav = useMemo<ShellNav>(
    () => ({
      focusSlice: (sliceId) => {
        reportCursor(sliceId);
        driverRef.current?.focusSlice(sliceId);
      },
      standAtSlice: (sliceId) => {
        reportCursor(sliceId);
        driverRef.current?.standAtSlice(sliceId);
      },
      openSlice: (sliceId, start) => {
        reportCursor(sliceId);
        driverRef.current?.openSlice(sliceId, start);
      },
    }),
    [reportCursor],
  );

  const reportTurnSettled = useCallback(() => {
    driverRef.current?.onTurnSettled();
  }, []);
  const reportRunning = useCallback((running: boolean) => {
    driverRef.current?.setRunning(running);
  }, []);

  // ── THE CONVERSATION SURFACE (the R3F field's host) ─────────────────────
  // Where the conversation field is allowed to draw: the route's pane slot
  // while the panel floats beside it (the pill leaves the whole pane free),
  // the overlay's panel-body slot at fullscreen (where the panel is
  // viewport-wide), and — with no wide host (the game view below the
  // fullscreen tier, or a route with no pane at all) — "narrow", where the
  // DOM list takes the conversation (see `chat/conversation-surface.tsx`).
  // Before the route reports its pose the default is the field's rules; both
  // slots are null then, so the surface degrades to "narrow", never to a
  // "field" with a null target.
  const conversationSurface: ConversationSurface = useMemo(() => {
    const view = worldPose?.settled ?? "field";
    return view === "game"
      ? panelSlotEl
        ? { kind: "field", el: panelSlotEl }
        : { kind: "narrow" }
      : panelMode === "fullscreen"
        ? panelSlotEl
          ? { kind: "field", el: panelSlotEl }
          : { kind: "narrow" }
        : paneSlotEl
          ? { kind: "field", el: paneSlotEl }
          : { kind: "narrow" };
  }, [worldPose, panelMode, panelSlotEl, paneSlotEl]);

  const value = useMemo<ShellValue>(
    () => ({
      panelMode,
      setPanelMode,
      worldFrozen,
      sharedSlice,
      reportCursor,
      getCursor,
      getChatView,
      feed,
      publishing,
      suppressAtJump,
      composerClearance,
      setComposerClearance,
      setPaneSlotEl,
      setPanelSlotEl,
      registerWorldDriver,
      setWorldPose,
      setFeedPublishing,
      setSuppressAtJump,
      reportTurnSettled,
      reportRunning,
    }),
    [
      panelMode,
      worldFrozen,
      sharedSlice,
      reportCursor,
      getCursor,
      getChatView,
      feed,
      publishing,
      suppressAtJump,
      composerClearance,
      registerWorldDriver,
      reportTurnSettled,
      reportRunning,
    ],
  );

  return (
    <ShellContext.Provider value={value}>
      <ShellNavContext.Provider value={nav}>
        <ConversationSurfaceProvider value={conversationSurface}>
          {children}
        </ConversationSurfaceProvider>
      </ShellNavContext.Provider>
    </ShellContext.Provider>
  );
}
