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
 *                    transport at SEND time, never render time. Only an
 *                    active, visible room supplies a frozen snapshot; the
 *                    corridor, reader and other routes carry no room view.
 *   feed             the one FieldFeed object (field-feed.ts). The band's
 *                    braid and the chat stream share it; it is created here
 *                    so the stream's writer survives a route unmount.
 *   publishing       the feed's one-writer lease, computed and pushed by the
 *                    route.
 *   composerClearance the composer's measured foot inset — measured inside
 *                    the overlay's ChatPage, consumed by the chat stream; the
 *                    provider is the one place above both.
 *
 * THE ROUTE'S HALF — `WorldDriver`. The lazy game host registers here only
 * after the first `/game` visit. Its hidden state reports a suspended pose,
 * so app/reader sends never describe a world that is not visible.
 *
 * Desk state is URL-backed. Explicit opens carry a fresh focus epoch; Back
 * and Forward restore the prior document without reapplying its old source
 * anchor. The main `/app` conversation defaults to fullscreen; reader, game,
 * and utility surfaces use the mini composer until an explicit expansion.
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
import type { CaseCategory } from "@/lib/docs";
import { createFieldFeed, type FieldFeed } from "@/lib/timeline3d/field-feed";
import { CURSOR_HOOKS } from "@/lib/timeline3d/cursor";
import type { ConversationPanelMode } from "@/components/chat/conversation-panel";
import { ShellNavContext, type ShellNav } from "@/components/shell/shell-nav";
import { panelModeForDeskOpen } from "@/components/desk/desk-model";
import {
  currentRoomView,
  type WorldPose,
  type WorldViewDriver,
} from "@/components/shell/world-view";
import type { ScreenContext, ScreenOrigin } from "@/lib/chat/screen-context";
import {
  createScreenContextTracker,
  type ScreenContextTracker,
} from "@/lib/chat/screen-context-tracker";
import { useNativeSourceScope } from "@/components/chat/native-source-scope";
import { usePathname, useRouter } from "@/i18n/navigation";
import {
  buildConversationHref,
  buildDocumentHref,
  buildGameHref,
  buildLibraryHref,
  deskHistoryOwnsTarget,
  deskTargetEqual,
  markDeskHistoryState,
  markOriginPanelMode,
  originPanelModeFromHistory,
  reduceDeskNavigation,
  shouldFocusSyncedDocument,
  workspaceDocumentTarget,
  type DeskNavigationState,
  type DeskOpenOptions,
  type WorkspaceDocumentTarget,
} from "@/lib/workspace/navigation";
export type { WorldPose } from "@/components/shell/world-view";
export type { DeskOpenOptions } from "@/lib/workspace/navigation";

/** The desk's memory (v0.25b, product-pass §4): the last document the
 *  reader opened, so a returning reader's desk opens on his paper instead
 *  of the bare archive. Written on every open; a dead ref is dropped by the
 *  app shell's restore preflight. The `previously:<name>:vN` naming follows
 *  the lens-switcher's hint key. */
export const LAST_DOCUMENT_KEY = "previously:last-document:v1";

/**
 * What the route (the world) implements and the provider calls. The cursor
 * half of the nav action lives in the provider; these are the WORLD-MOTION
 * halves, plus the turn callback the overlay's ChatPage reports and the pose
 * read the send-time getter needs.
 */
export interface WorldDriver extends WorldViewDriver {
  /** Address a slice to the HOTEL: the reader stands at the slice's door. */
  standAtSlice: (sliceId: string) => void;
  /** A turn settled — the route refreshes its catalog and the hotel's doors. */
  onTurnSettled: () => void;
}

export interface ShellValue {
  panelMode: ConversationPanelMode;
  setPanelMode: (mode: ConversationPanelMode) => void;
  worldFrozen: boolean;
  sharedSlice: string | null;
  deskDoc: string | null;
  deskOpenOptions: DeskOpenOptions | null;
  deskNavigation: DeskNavigationState;
  archiveCategory: CaseCategory | null;
  setArchiveCategory: (category: CaseCategory | null) => void;
  openDesk: (ref: string, origin?: ScreenOrigin, options?: DeskOpenOptions) => void;
  closeDesk: () => void;
  cleanupDesk: () => void;
  syncDeskRoute: (target: WorkspaceDocumentTarget | null) => void;
  resetDeskForLane: () => void;
  openLibrary: (history?: boolean) => void;
  openConversation: () => void;
  openGame: () => void;
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
  getScreenContext: () => ScreenContext | undefined;
  screen: ScreenContextTracker;
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
  const router = useRouter();
  const pathname = usePathname();
  const [panelMode, setPanelModeState] = useState<ConversationPanelMode>("pill");
  const panelModeRef = useRef(panelMode);
  const setPanelMode = useCallback((mode: ConversationPanelMode) => {
    panelModeRef.current = mode;
    setPanelModeState(mode);
  }, []);
  const worldFrozen = panelMode === "fullscreen";
  const sourceScope = useNativeSourceScope();

  const screenRef = useRef<ScreenContextTracker | null>(null);
  screenRef.current ??= createScreenContextTracker();
  const screen = screenRef.current;
  const getScreenContext = useCallback(
    (): ScreenContext | undefined => screen.getScreenContext(),
    [screen],
  );

  const [deskTarget, setDeskTarget] = useState<WorkspaceDocumentTarget | null>(null);
  const [deskNavigation, setDeskNavigation] = useState<DeskNavigationState>({ epoch: 0, focus: false });
  const deskDoc = deskTarget?.ref ?? null;
  const deskOpenOptions = deskTarget?.options ?? null;
  const deskTargetRef = useRef<WorkspaceDocumentTarget | null>(null);
  const pendingDeskTargetRef = useRef<WorkspaceDocumentTarget | null>(null);
  const restoreNavigationRef = useRef(false);
  const previousSourceScope = useRef(sourceScope);

  const applyDeskTarget = useCallback((
    target: WorkspaceDocumentTarget,
    origin: ScreenOrigin,
    focus: boolean,
  ) => {
    deskTargetRef.current = target;
    setDeskTarget(target);
    setDeskNavigation((current) => reduceDeskNavigation(current, focus));
    screen.documentOpened({
      ref: target.ref,
      origin,
      ...(target.options.edition ? { edition: target.options.edition } : {}),
    });
    setPanelMode(panelModeForDeskOpen(panelModeRef.current));
    try {
      window.localStorage.setItem(LAST_DOCUMENT_KEY, target.ref);
    } catch {
      // Storage is a convenience, never a gate.
    }
  }, [screen, setPanelMode]);

  const clearDesk = useCallback((origin: "manual" | "observed") => {
    const previous = deskTargetRef.current;
    setDeskNavigation((current) => ({ ...current, focus: false }));
    if (!previous) return;
    deskTargetRef.current = null;
    pendingDeskTargetRef.current = null;
    setDeskTarget(null);
    screen.documentClosed(previous.ref, { origin });
  }, [screen]);
  const cleanupDesk = useCallback(() => clearDesk("observed"), [clearDesk]);

  const rememberPanelOnEntry = useCallback(() => {
    window.history.replaceState(
      markOriginPanelMode(window.history.state, panelModeRef.current),
      "",
      window.location.href,
    );
  }, []);

  useEffect(() => {
    const onPopState = () => { restoreNavigationRef.current = true; };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const syncDeskRoute = useCallback((target: WorkspaceDocumentTarget | null) => {
    const restoring = restoreNavigationRef.current;
    restoreNavigationRef.current = false;
    const pending = target && pendingDeskTargetRef.current && deskTargetEqual(pendingDeskTargetRef.current, target)
      ? pendingDeskTargetRef.current
      : null;
    if (pending) {
      const href = buildDocumentHref(pending, window.location.search);
      window.history.replaceState(
        markDeskHistoryState(window.history.state, href),
        "",
        window.location.href,
      );
    }
    pendingDeskTargetRef.current = null;
    if (deskTargetEqual(deskTargetRef.current, target)) return;
    if (deskTargetRef.current) clearDesk("observed");
    if (target) applyDeskTarget(target, "restored", shouldFocusSyncedDocument(pending !== null, restoring));
    const originMode = originPanelModeFromHistory(window.history.state);
    if (originMode) setPanelMode(originMode);
  }, [applyDeskTarget, clearDesk, setPanelMode]);

  const openDesk = useCallback((
    ref: string,
    origin: ScreenOrigin = "observed",
    options?: DeskOpenOptions,
  ) => {
    const target = workspaceDocumentTarget(ref, options);
    if (!target) return;
    if (pathname === "/app" && deskTargetEqual(deskTargetRef.current, target)) {
      applyDeskTarget(target, origin, true);
      return;
    }
    const href = buildDocumentHref(target, window.location.search);
    rememberPanelOnEntry();
    if (pathname === "/app") {
      window.history.pushState(
        markDeskHistoryState(markOriginPanelMode({}, panelModeRef.current), href),
        "",
        `${window.location.pathname}${href.slice("/app".length)}`,
      );
    } else {
      pendingDeskTargetRef.current = target;
      router.push(href, { scroll: false });
    }
    applyDeskTarget(target, origin, true);
  }, [applyDeskTarget, pathname, rememberPanelOnEntry, router]);

  const closeDesk = useCallback(() => {
    const target = deskTargetRef.current;
    if (!target) return;
    const href = buildDocumentHref(target, window.location.search);
    const owned = pathname === "/app" && deskHistoryOwnsTarget(window.history.state, href);
    clearDesk("manual");
    if (owned) {
      window.history.back();
      return;
    }
    setPanelMode("pill");
    router.replace(buildLibraryHref(window.location.search), { scroll: false });
  }, [clearDesk, pathname, router, setPanelMode]);

  const resetDeskForLane = useCallback(() => {
    clearDesk("observed");
    pendingDeskTargetRef.current = null;
    screen.reset();
    if (pathname === "/app" && new URLSearchParams(window.location.search).has("doc")) {
      router.replace(buildLibraryHref(window.location.search), { scroll: false });
    }
  }, [clearDesk, pathname, router, screen]);

  const openLibrary = useCallback((history = false) => {
    const href = buildLibraryHref(window.location.search, history);
    const current = new URLSearchParams(window.location.search);
    const unchanged = pathname === "/app" &&
      current.get("view") === "field" &&
      !current.has("doc") &&
      (current.get("history") === "1") === history;
    if (!unchanged) rememberPanelOnEntry();
    cleanupDesk();
    setPanelMode("pill");
    if (!unchanged) router.push(href, { scroll: false });
  }, [cleanupDesk, pathname, rememberPanelOnEntry, router, setPanelMode]);

  const openConversation = useCallback(() => {
    const href = buildConversationHref(window.location.search);
    const current = new URLSearchParams(window.location.search);
    const unchanged = pathname === "/app" &&
      !current.has("doc") &&
      current.get("view") !== "field" &&
      current.get("view") !== "game" &&
      current.get("history") !== "1";
    if (!unchanged) rememberPanelOnEntry();
    cleanupDesk();
    setPanelMode("fullscreen");
    if (!unchanged) router.push(href, { scroll: false });
  }, [cleanupDesk, pathname, rememberPanelOnEntry, router, setPanelMode]);

  const openGame = useCallback(() => {
    if (pathname !== "/game") rememberPanelOnEntry();
    cleanupDesk();
    setPanelMode("pill");
    if (pathname !== "/game") {
      router.push(buildGameHref(window.location.search), { scroll: false });
    }
  }, [cleanupDesk, pathname, rememberPanelOnEntry, router, setPanelMode]);

  useEffect(() => {
    if (previousSourceScope.current === sourceScope) return;
    previousSourceScope.current = sourceScope;
    resetDeskForLane();
  }, [sourceScope, resetDeskForLane]);

  // THE ARCHIVE FIELD'S FILTER (v0.25a §四). The library control's category
  // selection doubles as the field's column filter — lifted here because the
  // two surfaces are siblings in the route, and a panel close must not throw
  // the filter away.
  const [archiveCategory, setArchiveCategory] = useState<CaseCategory | null>(
    null,
  );

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

  const [, setWorldPoseState] = useState<WorldPose | null>(null);
  const setWorldPose = useCallback((pose: WorldPose | null) => {
    setWorldPoseState(pose);
    if (!pose || (pose.settled !== "game" && deskTargetRef.current === null)) {
      screen.roomLeft();
    }
  }, [screen]);
  const [publishing, setFeedPublishing] = useState(true);
  const [composerClearance, setComposerClearance] = useState(0);

  const driverRef = useRef<WorldDriver | null>(null);
  const registerWorldDriver = useCallback((driver: WorldDriver | null) => {
    driverRef.current = driver;
    if (!driver) screen.routeLeft();
  }, [screen]);

  const getChatView = useCallback((): CurrentView | undefined => {
    return currentRoomView(driverRef.current, deskTargetRef.current !== null);
  }, []);

  const nav = useMemo<ShellNav>(
    () => ({
      standAtSlice: (sliceId) => {
        reportCursor(sliceId);
        openGame();
        driverRef.current?.standAtSlice(sliceId);
      },
    }),
    [openGame, reportCursor],
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
      deskOpenOptions,
      deskNavigation,
      archiveCategory,
      setArchiveCategory,
      openDesk,
      closeDesk,
      cleanupDesk,
      syncDeskRoute,
      resetDeskForLane,
      openLibrary,
      openConversation,
      openGame,
      reportCursor,
      getCursor,
      getChatView,
      getScreenContext,
      screen,
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
      setPanelMode,
      worldFrozen,
      sharedSlice,
      deskDoc,
      deskOpenOptions,
      deskNavigation,
      archiveCategory,
      openDesk,
      closeDesk,
      cleanupDesk,
      syncDeskRoute,
      resetDeskForLane,
      openLibrary,
      openConversation,
      openGame,
      reportCursor,
      getCursor,
      getChatView,
      getScreenContext,
      screen,
      feed,
      publishing,
      composerClearance,
      registerWorldDriver,
      setWorldPose,
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
