"use client";

/**
 * ConversationPanel — the conversation layer's two tiers (v0.13 §4).
 *
 * ONE conversation surface (the DOM chat — `ChatPage`), two sizes, one box:
 *
 *   pill        the bottom STRIP: a hairline-ruled bar pinned to the
 *               viewport's bottom edge, spanning the full width. It carries
 *               exactly four controls — a single-line input, send/stop as
 *               one button, expand into fullscreen, attach — plus the one
 *               non-control, the subtitle line: the live one-line rendering
 *               of the newest turn, folded by the pure reducer in
 *               `lib/chat/subtitle-line.ts` and passed in as a prop. The
 *               fullscreen chrome (slim bar + conversation body) folds to
 *               zero height and goes inert, but stays MOUNTED — the live
 *               `useChat` stream, the draft and the scroll position all
 *               survive the collapse, and the composer itself keeps
 *               rendering (absolutely positioned against this box, which
 *               the strip does not clip), so a draft typed in the strip is
 *               still there at fullscreen.
 *   fullscreen  the same box grown to the viewport (a CSS height transition
 *               FROM the strip height, not a remount), full capability.
 *               OVERLAY, never a route change — `position: fixed`, so the
 *               world canvas behind it is never resized or unmounted; the
 *               owning surface freezes its R3F `frameloop` ("never") while
 *               this tier is up, which pauses rendering WITHOUT unmounting:
 *               the scene, its programs and the last frame all stay.
 *
 * The component is CONTROLLED (`mode`/`onModeChange`): the owning surface
 * (`app-shell`) owns the state, because it is the one that must react to it
 * (freeze the world, pick the per-surface default tier). The tier is also
 * published to the chat components through `PanelTierContext` — the
 * composer (via `ComposerHost`) and `ChatInput` read it to know which form
 * to draw, so the strip and the full composer are one component instance,
 * never an unmount boundary.
 *
 * Keyboard. `Cmd/Ctrl+J` toggles pill ↔ fullscreen (window-level,
 * registered here so both surfaces share it). The two obvious neighbours
 * were taken: `Cmd/Ctrl+K` is the search palette and `Cmd/Ctrl+.` is the
 * shell's rung toggle (app-shell.tsx). `Escape` collapses to the pill and
 * is listened for on the PANEL CONTAINER, not the window: popovers inside
 * the chat (the model selector & co.) render in portals OUTSIDE this
 * subtree, so their Escape never reaches this handler — one Escape closes
 * the popover, the next collapses the panel. Focus moves into the panel
 * when it opens and lands on the strip when it collapses.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { SubtitleLine } from "@/lib/chat/subtitle-line";

export type ConversationPanelMode = "pill" | "fullscreen";

/** Every tier change — clicks and keys alike — funnels through this table,
 *  so the keyboard surface and the buttons can never disagree. Exported and
 *  pure for the unit test (`__tests__/conversation-panel.test.ts`). */
export function reducePanelMode(
  mode: ConversationPanelMode,
  event: "open" | "toggle" | "toggleFullscreen" | "collapse",
): ConversationPanelMode {
  switch (event) {
    case "open":
      // The strip's expand verb: from the pill the only place to open IS
      // fullscreen; already there, nothing more to open.
      return mode === "pill" ? "fullscreen" : mode;
    case "toggle":
      // Cmd/Ctrl+J — the two tiers are each other's only destination.
      return mode === "pill" ? "fullscreen" : "pill";
    case "toggleFullscreen":
      return mode === "fullscreen" ? "pill" : "fullscreen";
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

/** The pill strip's total height, px — the subtitle row (`h-5`) plus the
 *  one control row, under a 1px hairline. THE knob to turn if the strip
 *  reads too tall or too short on screen: the subtitle keeps its 20px and
 *  the composer row takes whatever is left. */
export const STRIP_HEIGHT_PX = 72;

/** What the panel tells the chat components that render inside it: which
 *  tier is up and how to change it. Null outside a panel — consumers then
 *  draw the fullscreen-era form (there is no strip to be). */
export interface PanelTier {
  mode: ConversationPanelMode;
  setMode: (mode: ConversationPanelMode) => void;
}

const PanelTierContext = createContext<PanelTier | null>(null);

/** The tier the surrounding `ConversationPanel` is in — null when there is
 *  no panel around the consumer. */
export function usePanelTier(): PanelTier | null {
  return useContext(PanelTierContext);
}

export interface ConversationPanelProps {
  mode: ConversationPanelMode;
  onModeChange: (mode: ConversationPanelMode) => void;
  /** The strip's one non-control: the live one-line rendering of the newest
   *  turn (`speaker: text`, or a dim status prefix while there is no text
   *  yet), folded by the pure reducer in `lib/chat/subtitle-line.ts`. Null
   *  when there is nothing to say — the row then renders empty so the strip
   *  keeps its height. Only ever shown at the pill tier. */
  subtitleLine?: SubtitleLine | null;
  /** An optional surface mounted ABOVE the conversation children inside the
   *  panel body — the shell's portal target for the R3F conversation field
   *  at FULLSCREEN, where the panel is viewport-wide and the field fits.
   *  Absent at the pill tier (the field then portals into the pane). */
  bodyPrefix?: ReactNode;
  /** The conversation surface. Always mounted — see the module header. */
  children: ReactNode;
}

export function ConversationPanel({
  mode,
  onModeChange,
  subtitleLine = null,
  bodyPrefix,
  children,
}: ConversationPanelProps) {
  const t = useTranslations("conversationPanel");
  const panelRef = useRef<HTMLDivElement>(null);
  const open = mode === "fullscreen";

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
  // lands it on the strip — the control surface that re-opens. The two are
  // one box now, so the same ref serves both; `outline-none` keeps the
  // programmatic focus invisible.
  const prevModeRef = useRef(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === mode) return;
    panelRef.current?.focus();
  }, [mode]);

  const onContainerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Keep the game's (or any window-level) Escape from ALSO firing on this
    // keystroke — collapsing the panel is the whole answer.
    event.stopPropagation();
    onModeChange(reducePanelMode(mode, "collapse"));
  };

  const tier = useMemo<PanelTier>(
    () => ({ mode, setMode: onModeChange }),
    [mode, onModeChange],
  );

  return (
    <PanelTierContext.Provider value={tier}>
      {/* THE ONE BOX — strip at the pill tier, viewport at fullscreen; the
          change is a height transition, not a remount. `fixed` (overlay) is
          the "覆盖，不挤压" rule made structural: nothing in the layout can
          feel this box, so the canvas behind it never resizes. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onContainerKeyDown}
        style={{ height: open ? "100dvh" : STRIP_HEIGHT_PX }}
        className={`fixed inset-x-0 bottom-0 flex flex-col bg-background outline-none transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? "z-[60]" : "z-40 overflow-hidden border-t border-foreground/10"
        }`}
      >
        {/* THE SUBTITLE — the strip's one non-control: `label: text` for the
            newest turn, or a dim status prefix while the turn has produced
            no words yet. An empty line still renders (the row keeps the
            strip's height); the truncated marker is the expand hint. */}
        <div
          data-conversation-subtitle
          aria-live="polite"
          className={`h-5 shrink-0 overflow-hidden px-3 font-mono text-[11px] leading-5 ${
            open ? "hidden" : "block"
          }`}
        >
          {subtitleLine && subtitleLine.text ? (
            <span className="flex h-full items-center gap-1.5">
              <span
                aria-hidden
                className={`shrink-0 uppercase tracking-[0.08em] ${
                  subtitleLine.speaker === "persona"
                    ? "text-brand"
                    : "text-muted-foreground"
                }`}
              >
                {subtitleLine.speaker === "persona"
                  ? t("subtitlePersona")
                  : t("subtitleUser")}
                :
              </span>
              <span className="truncate text-muted-foreground">
                {subtitleLine.text}
              </span>
              {subtitleLine.truncated ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/60">
                  …
                </span>
              ) : null}
            </span>
          ) : subtitleLine?.status ? (
            <span className="flex h-full items-center">
              <span className="truncate text-muted-foreground/80">
                {subtitleLine.status.kind === "reading"
                  ? t("subtitleReading", { count: subtitleLine.status.count })
                  : t("subtitleThinking")}
              </span>
            </span>
          ) : null}
        </div>

        {/* The panel's own slim bar: title + the two tier verbs. Fullscreen
            only — at the pill tier it stays mounted but hidden (it holds no
            state; the strip is the collapsed face). In-flow, so the
            conversation below reserves nothing. */}
        <div
          className={`h-10 shrink-0 items-center gap-1 border-b border-foreground/5 px-2 ${
            open ? "flex" : "hidden"
          }`}
        >
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

        {/* THE CONVERSATION BODY — the fullscreen surface. At the pill tier
            it folds to zero height (not `display:none` — the subtree must
            stay mounted, and the composer below is absolutely positioned
            against the BOX, outside this clip) and goes inert. `inert` is
            what keeps the hidden conversation out of the tab order — a
            zero-height box alone would not. */}
        <div
          id="conversation-panel"
          role="region"
          aria-label={t("title")}
          inert={!open}
          className={`min-h-0 flex-col overflow-hidden ${
            open ? "flex flex-1" : "flex h-0"
          }`}
        >
          {/* min-h-0 so the chat's own surface — not this column — grows and
              scrolls. At fullscreen an optional bodyPrefix (the R3F field's
              portal target) takes the grow and the conversation children
              keep their natural height (live strip + composer). */}
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

        {/* The composer is NOT in this JSX — `ChatPage` renders it
            (`ComposerHost`), absolutely positioned against this box. At the
            pill tier it lands on this box's bottom edge, i.e. inside the
            strip, below the subtitle; at fullscreen it floats over the body
            as it always has. One component instance throughout — see
            `composer-host.tsx` and the `PanelTierContext` header. */}
      </div>
    </PanelTierContext.Provider>
  );
}
