"use client";

/**
 * ShellProvider (v0.13 §3.1) — the LAYOUT-level home of everything the
 * conversation layer and the route content share.
 *
 * WHY THIS EXISTS. The conversation layer used to live INSIDE AppShell, and
 * any rebuild of the shell subtree remounted the panel. §3.1's ruling: the
 * conversation layer is a real floating layer — mounted once at the layout, a
 * sibling of the route content, above the canvas by z-index, surviving
 * navigation and world rebuilds. For that, the state the overlay and the
 * routes SHARE had to move up with it; this provider is that state.
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
 *                    moves (v0.13 §6 一个游标). Written by the nav action,
 *                    and quietly by the surfaces themselves: the world's
 *                    roaming (game-canvas reports the room the reader stands
 *                    in) moves the SAME cursor through `reportCursor` — the
 *                    write that steers no world. Read by the route (the hotel
 *                    door, the world gate) and at call time by `getCursor`.
 *   nav (ShellNav)   standAtSlice. It moves the cursor HERE and delegates
 *                    the world motion to the route's registered driver — the
 *                    transition machine belongs to the world, and the world
 *                    belongs to the route.
 *   getChatView      the per-turn 视野 getter (v0.13 §5), read by the chat
 *                    transport at SEND time, never render time. No cursor, or
 *                    no registered world (off `/app`), is the lobby:
 *                    undefined, and the request carries no view block.
 *   feed             the one FieldFeed object (field-feed.ts). The band's
 *                    braid and the chat stream share it; it is created here
 *                    so the stream's writer survives a route unmount.
 *   publishing       the feed's one-writer lease, computed and pushed by the
 *                    route.
 *   composerClearance the composer's measured foot inset — measured inside
 *                    the overlay's ChatPage, consumed by the chat stream; the
 *                    provider is the one place above both.
 *
 * THE ROUTE'S HALF — `WorldDriver`. The world (canvas, transition machine)
 * stays in `/app`; the layout TALKS to it through a registered driver instead
 * of owning it. AppShell registers on mount and unregisters on unmount: off
 * `/app` the nav action still moves the cursor but drives no world (there is
 * none to drive), and `getChatView` falls back to the lobby.
 *
 * SSR / HYDRATION NOTE. The first tier is the PILL everywhere: the
 * conversation is a floating capability over whichever world the route opens
 * on, never a surface of its own — so no route may be covered by a fullscreen
 * conversation on its first commit. `panelMode` reaches no SSR'd markup (the
 * overlay is client-only, and the route reads the tier only in effects and in
 * the client-only canvas's `paused` prop).
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
import type { CurrentView } from "@/lib/chat/current-view";
import { createFieldFeed, type FieldFeed } from "@/lib/timeline3d/field-feed";
import { CURSOR_HOOKS } from "@/lib/timeline3d/cursor";
import type { ConversationPanelMode } from "@/components/chat/conversation-panel";
import type { WorldKind } from "@/components/timeline-3d/world-contract";
import { ShellNavContext, type ShellNav } from "@/components/shell/shell-nav";
import { panelModeForDeskOpen } from "@/components/desk/desk-model";

/**
 * The world's pose, as the route last reported it. The per-turn view getter
 * reads it through the driver's `getPose` instead of this state, because it
 * runs at send time, outside React.
 */
export interface WorldPose {
  settled: WorldKind;
}

/**
 * What the route (the world) implements and the provider calls. The cursor
 * half of the nav action lives in the provider; these are the WORLD-MOTION
 * halves, plus the turn callback the overlay's ChatPage reports and the pose
 * read the send-time getter needs.
 */
export interface WorldDriver {
  /** Address a slice to the HOTEL: the reader stands at the slice's door. */
  standAtSlice: (sliceId: string) => void;
  /** The live pose, read at CALL time — never a render-time snapshot. */
  getPose: () => WorldPose;
  /** A turn settled — the route refreshes its catalog and the hotel's doors. */
  onTurnSettled: () => void;
}

interface ShellValue {
  panelMode: ConversationPanelMode;
  setPanelMode: (mode: ConversationPanelMode) => void;
  /** Fullscreen freezes the world — the route hands this to the canvas as
   *  `paused` (frameloop="never"). Pause, never unmount. */
  worldFrozen: boolean;
  /** The shared slice address — the one cursor every surface reads. */
  sharedSlice: string | null;
  /** The document on the desk (v0.22): a case ref, or null when the desk is
   *  away. One field, no persistence — a refresh puts nothing on the desk. */
  deskDoc: string | null;
  /** Pull a document onto the desk (the shelf's terminal open action). A
   *  fullscreen panel folds to the pill first — fullscreen freezes the
   *  world's frame loop and covers the canvas the desk renders in. */
  openDesk: (ref: string) => void;
  /** Put the document back; the desk's seat empties. */
  closeDesk: () => void;
  /** The cursor's QUIET write (v0.13 §6 一个游标): the surfaces' own motion
   *  — the room the reader walks into — moves the SAME cursor the nav action
   *  owns, but steers NO world (the nav action is the only writer that also
   *  drives world motion). */
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
  /** The composer's measured foot inset — see the module header. */
  composerClearance: number;
  setComposerClearance: (px: number) => void;
  /** The route's registration channel — see `WorldDriver`. */
  registerWorldDriver: (driver: WorldDriver | null) => void;
  setWorldPose: (pose: WorldPose | null) => void;
  setFeedPublishing: (publishing: boolean) => void;
  /** The forwarder the overlay's ChatPage reports through; it reaches the
   *  registered driver, and no-ops off `/app` (no world to refresh). */
  reportTurnSettled: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);

/** The layout-level shell channel — throws outside ShellProvider (a bug:
 *  the overlay and the app shell both render under it). */
export function useShell(): ShellValue {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell outside ShellProvider");
  return shell;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  // The first tier is the PILL on every route — see the module header's SSR
  // note. The conversation is a floating capability, never an opening surface.
  const [panelMode, setPanelMode] = useState<ConversationPanelMode>("pill");
  const worldFrozen = panelMode === "fullscreen";

  // THE DOCUMENT DESK (v0.22 P1). Just the ref — no placement, no order, no
  // persistence. The page's library column (shelf/doc-library.tsx) writes
  // it, the app shell reads it; this provider is their common ancestor.
  // Opening folds a fullscreen panel to the pill first
  // (panelModeForDeskOpen), the same rule as leaving `/app` (fullscreen
  // would freeze the world the desk renders in).
  const [deskDoc, setDeskDoc] = useState<string | null>(null);
  const openDesk = useCallback((ref: string) => {
    setPanelMode(panelModeForDeskOpen);
    setDeskDoc(ref);
  }, []);
  const closeDesk = useCallback(() => setDeskDoc(null), []);

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
  // Created here, above the stream's owner, so the chat stream's writer
  // survives the app route unmounting.
  const feedRef = useRef<FieldFeed | null>(null);
  feedRef.current ??= createFieldFeed();
  const feed = feedRef.current;

  // The route's reactive pose — see the module header. Null off `/app` (a
  // route with no world registers no driver and reports no pose).
  const [worldPose, setWorldPose] = useState<WorldPose | null>(null);
  const [publishing, setFeedPublishing] = useState(true);
  const [composerClearance, setComposerClearance] = useState(0);

  // The route's driver. A REF, not state: callers (the nav action, the
  // send-time getter, the turn forwarder) all read it at call time, and a
  // registration must not re-render the layout's whole subtree.
  const driverRef = useRef<WorldDriver | null>(null);
  const registerWorldDriver = useCallback((driver: WorldDriver | null) => {
    driverRef.current = driver;
  }, []);

  // ── THE CONVERSATION'S VIEW OF THE WORLD (v0.13 §5 视野注入) ─────────
  // What the reader is currently looking at, derived at SEND time from the
  // shared cursor and the world's live pose (never render time — the
  // transport asks when the message leaves). Standing at the slice's door in
  // the hotel = room; ANYTHING ELSE — no shared address, the reader's desk,
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
    return undefined;
  }, []);

  // ── THE NAVIGATION ACTION (shell-nav.ts) ────────────────────────────────
  // The memory form of the old `?slice=` contract. It moves the cursor HERE
  // (the provider owns it) and then delegates the world motion to the
  // registered driver — with no driver (off `/app`) the cursor still moves
  // and nothing else happens, which is the honest state of a route that has
  // no world.
  const nav = useMemo<ShellNav>(
    () => ({
      standAtSlice: (sliceId) => {
        reportCursor(sliceId);
        driverRef.current?.standAtSlice(sliceId);
      },
    }),
    [reportCursor],
  );

  const reportTurnSettled = useCallback(() => {
    driverRef.current?.onTurnSettled();
  }, []);

  const value = useMemo<ShellValue>(
    () => ({
      panelMode,
      setPanelMode,
      worldFrozen,
      sharedSlice,
      deskDoc,
      openDesk,
      closeDesk,
      reportCursor,
      getCursor,
      getChatView,
      feed,
      publishing,
      composerClearance,
      setComposerClearance,
      registerWorldDriver,
      setWorldPose,
      setFeedPublishing,
      reportTurnSettled,
    }),
    [
      panelMode,
      worldFrozen,
      sharedSlice,
      deskDoc,
      openDesk,
      closeDesk,
      reportCursor,
      getCursor,
      getChatView,
      feed,
      publishing,
      composerClearance,
      registerWorldDriver,
      reportTurnSettled,
    ],
  );

  return (
    <ShellContext.Provider value={value}>
      <ShellNavContext.Provider value={nav}>
        {children}
      </ShellNavContext.Provider>
    </ShellContext.Provider>
  );
}
