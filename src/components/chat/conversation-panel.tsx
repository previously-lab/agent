"use client";

/**
 * ConversationPanel — the conversation layer's three tiers (v0.11 §14.1).
 *
 * ONE conversation surface (the DOM chat — `ChatPage`), three sizes:
 *
 *   pill        a quiet floating button, bottom-right. The conversation
 *               subtree stays MOUNTED but slides offscreen (inert, no
 *               pointer events) so the live `useChat` stream, the draft and
 *               the scroll position all survive the collapse.
 *   dock        an overlay panel on the right edge, 420–520px (full width
 *               under `sm`). OVERLAY, never a squeeze: it is `position:
 *               fixed`, so the world canvas behind it keeps its size — no
 *               resize event, no camera recompute, no framing jump.
 *   fullscreen  the same panel grown to the viewport width (a CSS width
 *               transition FROM the dock width, not a remount). While it is
 *               up the owning surface freezes its R3F world — the parent
 *               reads `mode === "fullscreen"` and switches the Canvas
 *               `frameloop` to "never", which pauses rendering WITHOUT
 *               unmounting: the scene, its programs and the last frame all
 *               stay, so returning is instant.
 *
 * The component is CONTROLLED (`mode`/`onModeChange`): the two surfaces
 * (`app-shell`, `game-shell`) own the state, because they are the ones that
 * must react to it (freeze the world, pick the per-surface default tier).
 *
 * Keyboard. `Cmd/Ctrl+J` toggles pill ↔ dock (window-level, registered here
 * so both surfaces share it). The two obvious neighbours were taken:
 * `Cmd/Ctrl+K` is the search palette and `Cmd/Ctrl+.` is the shell's rung
 * toggle (app-shell.tsx). `Escape` collapses to the pill and is listened for
 * on the PANEL CONTAINER, not the window: popovers inside the chat (the
 * model selector & co.) render in portals OUTSIDE this subtree, so their
 * Escape never reaches this handler — one Escape closes the popover, the
 * next collapses the panel. Focus is moved into the panel when it opens and
 * back to the pill when it collapses.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Maximize2, MessageCircle, Minimize2, X } from "lucide-react";

export type ConversationPanelMode = "pill" | "dock" | "fullscreen";

/** Every tier change — clicks and keys alike — funnels through this table,
 *  so the keyboard surface and the buttons can never disagree. Exported and
 *  pure for the unit test (`__tests__/conversation-panel.test.ts`). */
export function reducePanelMode(
  mode: ConversationPanelMode,
  event: "open" | "toggle" | "toggleFullscreen" | "collapse",
): ConversationPanelMode {
  switch (event) {
    case "open":
      return mode === "pill" ? "dock" : mode;
    case "toggle":
      return mode === "pill" ? "dock" : "pill";
    case "toggleFullscreen":
      return mode === "fullscreen" ? "dock" : "fullscreen";
    case "collapse":
      return "pill";
  }
}

/** The panel toggle chord. `Cmd/Ctrl+K` (search) and `Cmd/Ctrl+.` (the
 *  shell's rung toggle) were both taken — `J` is the "panel" key the
 *  editor convention established. */
export function isPanelHotkey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j"
  );
}

/** Dock width bounds (§14.1: "约 420–520px"). Measured in JS — a CSS
 *  `clamp()` string cannot be interpolated into a width transition from a
 *  number, and the dock → fullscreen grow IS a width transition. */
const DOCK_MIN_PX = 420;
const DOCK_MAX_PX = 520;
const DOCK_RATIO = 0.38;
/** Below the `sm` breakpoint the dock IS the screen — a 420px panel on a
 *  390px phone leaves a sliver of world that helps no one. */
const DOCK_FULLWIDTH_BELOW_PX = 640;
/** First-hydration placeholder before the viewport is measured. */
const DOCK_FALLBACK_PX = 480;

/** The dock width for a viewport width — pure, so the shell can lay its pane
 *  surfaces out around the docked panel with the SAME number the panel
 *  transitions on (the field-view slot leaves the dock's width clear). */
export function dockWidthFor(viewportW: number): number {
  if (viewportW === 0) return DOCK_FALLBACK_PX;
  if (viewportW < DOCK_FULLWIDTH_BELOW_PX) return viewportW;
  return Math.min(
    DOCK_MAX_PX,
    Math.max(DOCK_MIN_PX, Math.round(viewportW * DOCK_RATIO)),
  );
}

/** The live viewport width — the panel measures it, and the shell reuses the
 *  measurement for the dock-aware pane layout. */
export function useViewportWidth(): number {
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const update = () => setViewportW(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewportW;
}

export interface ConversationPanelProps {
  mode: ConversationPanelMode;
  onModeChange: (mode: ConversationPanelMode) => void;
  /** The room the floating chrome takes at the top of the viewport, px —
   *  the dock starts BELOW it (the header's islands stay visible and
   *  clickable above the panel); fullscreen ignores it and covers all. */
  insetTop?: number;
  /** An optional surface mounted ABOVE the conversation children inside the
   *  panel body — the shell's portal target for the R3F conversation field
   *  at FULLSCREEN, where the panel is viewport-wide and the field fits.
   *  Absent at every other tier (the field then portals into the pane). */
  bodyPrefix?: ReactNode;
  /** The conversation surface. Always mounted — see the module header. */
  children: ReactNode;
}

export function ConversationPanel({
  mode,
  onModeChange,
  insetTop = 0,
  bodyPrefix,
  children,
}: ConversationPanelProps) {
  const t = useTranslations("conversationPanel");
  const panelRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  // The dock width in px, so dock → fullscreen is a real CSS width
  // transition (the panel GROWS out of its docked size) rather than a jump
  // between two uninterpolatable length expressions.
  const viewportW = useViewportWidth();
  const dockWidth = dockWidthFor(viewportW);
  const panelWidth =
    mode === "fullscreen" ? viewportW || DOCK_FALLBACK_PX : dockWidth;

  // `Cmd/Ctrl+J` — one registration per surface (the panel is mounted once
  // per page). Deps re-register on mode change rather than holding a ref:
  // the cost is one add/removeListener, and the closure is always honest.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPanelHotkey(event)) return;
      event.preventDefault();
      onModeChange(reducePanelMode(mode, "toggle"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onModeChange]);

  // Focus follows the tier: opening moves it INTO the panel (so Escape and
  // Tab belong to the conversation from the first keystroke), collapsing
  // returns it to the pill — the control that re-opens. Tier-to-tier moves
  // (dock ↔ fullscreen) leave focus wherever it is.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === mode) return;
    if (mode === "pill") {
      if (prev !== "pill") pillRef.current?.focus();
    } else if (prev === "pill") {
      panelRef.current?.focus();
    }
  }, [mode]);

  const open = mode !== "pill";
  const onContainerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Keep the game's (or any window-level) Escape from ALSO firing on this
    // keystroke — collapsing the panel is the whole answer.
    event.stopPropagation();
    onModeChange("pill");
  };

  return (
    <>
      {/* THE PILL — the collapsed tier. Quiet by design (§14.1): one small
          frosted button at the bottom-right, clear of the game's sightline
          and of the companion pod's column (which sits ~220px up). Only it
          eats events while collapsed. */}
      <button
        ref={pillRef}
        type="button"
        aria-label={t("open")}
        aria-expanded={open}
        aria-controls="conversation-panel"
        onClick={() => onModeChange(reducePanelMode(mode, "open"))}
        className={`fixed right-4 bottom-4 z-40 flex size-11 items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-[0_12px_32px_-12px_rgba(15,23,42,0.4)] ring-1 ring-foreground/10 backdrop-blur-md transition-[opacity,transform] duration-200 hover:text-foreground hover:ring-foreground/25 motion-reduce:transition-none sm:right-5 sm:bottom-5 ${
          open ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100"
        }`}
        // Collapsed-but-mounted like the panel: the button itself is the
        // focus-return target, so it must stay in the tree.
        tabIndex={open ? -1 : 0}
      >
        <MessageCircle className="size-5" aria-hidden />
      </button>

      {/* THE PANEL — dock and fullscreen share one box; only its width and
          elevation change. `fixed` (overlay) is the "覆盖，不挤压" rule made
          structural: nothing in the layout can feel this box, so the canvas
          behind it never resizes. Pill slides it offscreen instead of
          unmounting. */}
      <div
        ref={panelRef}
        id="conversation-panel"
        role="region"
        aria-label={t("title")}
        tabIndex={-1}
        inert={!open}
        onKeyDown={onContainerKeyDown}
        style={{
          width: panelWidth,
          top: mode === "fullscreen" ? 0 : insetTop,
        }}
        className={`fixed right-0 bottom-0 flex flex-col border-l border-foreground/10 bg-background shadow-[0_0_60px_-15px_rgba(15,23,42,0.35)] outline-none transition-[width,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:shadow-[0_0_60px_-15px_rgba(0,0,0,0.8)] ${
          mode === "fullscreen" ? "z-[60] border-l-0" : "z-50"
        } ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
      >
        {/* The panel's own slim bar: title + the two tier verbs. In-flow
            (not floating), so the conversation below reserves nothing. */}
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-foreground/5 px-2">
          <span className="flex-1 truncate px-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {t("title")}
          </span>
          <button
            type="button"
            aria-label={
              mode === "fullscreen" ? t("exitFullscreen") : t("expand")
            }
            onClick={() =>
              onModeChange(reducePanelMode(mode, "toggleFullscreen"))
            }
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            {mode === "fullscreen" ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label={t("collapse")}
            onClick={() => onModeChange(reducePanelMode(mode, "collapse"))}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {/* min-h-0 so the chat's own surface — not this column — grows and
            scrolls. At fullscreen an optional bodyPrefix (the R3F field's
            portal target) takes the grow and the conversation children keep
            their natural height (live strip + composer). */}
        <div className="flex min-h-0 flex-1 flex-col">
          {bodyPrefix}
          <div
            className={
              bodyPrefix
                ? "flex min-h-0 flex-col"
                : "flex min-h-0 flex-1 flex-col"
            }
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
