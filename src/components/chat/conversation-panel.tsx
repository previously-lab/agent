"use client";

/**
 * ConversationPanel — the conversation layer's two tiers (v0.13 §4).
 *
 * ONE conversation surface (the DOM chat — `ChatPage`), two sizes, one box:
 *
 *   pill        the floating PILL: a translucent glass bar (rounded-full,
 *               `bg-background/70` + backdrop blur + a hairline ring),
 *               horizontally centred a small gap above the viewport's
 *               bottom edge, at most 600px wide (`--pill-max-width` in
 *               globals.css), exactly
 *               `PILL_HEIGHT_PX` tall. ONE row with exactly four controls —
 *               a round attach button on the left, a single-line input in
 *               the middle (no box of its own; the pill is the container),
 *               and round send/stop + fullscreen buttons on the right —
 *               plus, floating directly ABOVE the pill (never part of the
 *               pill's height or width), the subtitle: an FPS-radio strip —
 *               a fixed-width speaker column (uppercase, letterspaced, the
 *               persona in brand blue / the user in warm grey) with the body
 *               pinned to the column's x, wrapped to at most two lines, the
 *               whole block capped to `--subtitle-block-max` and centred
 *               over the pill — the live rendering of the newest turn, folded
 *               by the pure reducer in `lib/chat/subtitle-line.ts` and passed
 *               in as a prop. The
 *               fullscreen chrome (slim bar + conversation body) folds to
 *               zero height and goes inert, but stays MOUNTED — the live
 *               `useChat` stream, the draft and the scroll position all
 *               survive the collapse, and the composer itself keeps
 *               rendering (absolutely positioned against this box, which
 *               the pill does not clip), so a draft typed in the pill is
 *               still there at fullscreen. The pill tier's box is
 *               pointer-transparent: only the pill and its buttons eat
 *               events, the world behind keeps every other pixel.
 *   fullscreen  the same box grown to the viewport (a CSS height transition
 *               FROM the pill's height, not a remount), full capability.
 *               OVERLAY, never a route change — `position: fixed`, so the
 *               world canvas behind it is never resized or unmounted; the
 *               provider derives `worldFrozen` from this tier and the app
 *               route's canvas freezes its R3F `frameloop` ("never") while
 *               it is up, which pauses rendering WITHOUT unmounting:
 *               the scene, its programs and the last frame all stay.
 *
 * The component is CONTROLLED (`mode`/`onModeChange`): the tier state lives
 * in the layout-level `ShellProvider` (shell-provider.tsx, v0.13 §3.1) and
 * the panel is rendered by `conversation-overlay.tsx`, because the tier's
 * readers sit in BOTH trees — the overlay draws it, the app route reacts to
 * it (freeze the world, pick the per-world default tier). The tier is also
 * published to the chat components through `PanelTierContext` — the
 * composer (via `ComposerHost`) and `ChatInput` read it to know which form
 * to draw, so the pill and the full composer are one component instance,
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
 * when it opens and lands on the pill when it collapses.
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
import { SUBTITLE_LINE_MAX } from "@/lib/chat/subtitle-line";

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
      // The pill's expand verb: from the pill tier the only place to open IS
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

/** The pill's height, px — the single height knob. One control row
 *  (`PILL_HEIGHT_PX` tall, round ~36px buttons and a one-line input
 *  centred in it); THE constant to turn if the pill reads too tall or too
 *  short on screen. */
export const PILL_HEIGHT_PX = 48;
/** The gap between the viewport's bottom edge and the pill, px. Turn this
 *  to sit the pill higher or lower. (The pill's MAX width lives in CSS as
 *  `--pill-max-width` in globals.css, consumed by composer-host's
 *  `.pill-box` — no Tailwind token sits at 600px.) */
export const PILL_BOTTOM_GAP_PX = 16;

/** The subtitle's static geometry now lives in CSS/Tailwind: the block cap
 *  is `--subtitle-block-max` in globals.css (660px sits between max-w-xl and
 *  max-w-2xl), the speaker column is the `w-28` token (112px), the
 *  column-to-body gap is `gap-3` (12px), and the user's warm-grey ink is the
 *  `.subtitle-user-ink` class. One line's height stays a constant because the
 *  seat computation below uses it: */
export const SUBTITLE_LINE_HEIGHT_PX = 20;

/** What the panel tells the chat components that render inside it: which
 *  tier is up and how to change it. Null outside a panel — consumers then
 *  draw the fullscreen-era form (there is no pill to draw). */
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
  /** The pill's one non-control, floating above it: the live radio-line
   *  rendering of the newest turn (fixed-width speaker column + body pinned
   *  to the column's x, at most two lines, block capped and centred), or a
   *  status label in the same column rhythm while there is no text yet —
   *  folded by the pure reducer in `lib/chat/subtitle-line.ts`. Null when
   *  there is nothing to say — the line then renders empty so its seat (and
   *  the pill's position) stays put. Only ever shown at the pill tier. */
  subtitleLine?: SubtitleLine | null;
  /** An optional surface mounted ABOVE the conversation children inside the
   *  panel body — the overlay's portal target for the R3F conversation field
   *  at FULLSCREEN, where the panel is viewport-wide and the field fits.
   *  Absent at the pill tier (the field then portals into the app route's
   *  pane slot). */
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
  // lands it on the pill — the control surface that re-opens. The two are
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

  // The subtitle seat: one 20px line normally, two when the fold's text is
  // long enough to wrap (estimated at half the reducer cap — the body track
  // holds ~75 mono-11px characters per line at the desktop block width). The
  // estimate only ever reserves a line; `line-clamp-2` owns the real wrap.
  const subtitleTwoLines =
    !!subtitleLine?.text &&
    subtitleLine.text.length > Math.ceil(SUBTITLE_LINE_MAX / 2);
  const subtitleSeatHeight =
    SUBTITLE_LINE_HEIGHT_PX * (subtitleTwoLines ? 2 : 1);

  return (
    <PanelTierContext.Provider value={tier}>
      {/* THE ONE BOX — a floating pill at the pill tier, the viewport at
          fullscreen; the change is a height transition, not a remount.
          `fixed` (overlay) is the "覆盖，不挤压" rule made structural:
          nothing in the layout can feel this box, so the canvas behind it
          never resizes. At the pill tier the box itself is chromeless and
          pointer-transparent — only the pill (positioned by the composer
          host) and its buttons eat events; the world keeps every other
          pixel of the bottom edge. The height at the pill tier is the pill
          plus the subtitle seat above it: PILL_HEIGHT_PX + one or two 20px
          subtitle lines + a 4px gap between them + PILL_BOTTOM_GAP_PX. */}
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onContainerKeyDown}
        // Height: 100dvh at fullscreen; at the pill tier PILL_HEIGHT_PX +
        // the subtitle seat (JS-estimated 1–2 lines) + the 4px gap +
        // PILL_BOTTOM_GAP_PX — only the seat varies with state.
        style={{
          height: open
            ? "100dvh"
            : PILL_HEIGHT_PX + subtitleSeatHeight + 4 + PILL_BOTTOM_GAP_PX,
        }}
        className={`fixed inset-x-0 bottom-0 flex flex-col outline-none transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open
            ? "z-40 bg-background"
            : "pointer-events-none z-40 overflow-hidden"
        }`}
      >
        {/* Z-ORDER: the panel sits BELOW every dialog (z-50 and up) and above
            the world (auto). A modal must never be trapped behind a
            fullscreen conversation — the command palette proved it the hard
            way, its items un-clickable while the panel was z-60. */}
        {/* THE SUBTITLE — the pill's one non-control, floating directly above
            it (never part of the pill's height or width): an FPS-radio
            strip, capped to `--subtitle-block-max` and centred over the
            pill — never full-bleed. The speaker column is a fixed-width,
            uppercase, letterspaced label (the persona in `text-brand`, the
            user in the warm grey `.subtitle-user-ink`); the body starts at the
            column's far edge and wraps to at most two lines, the CSS clamp
            supplying the ellipsis. While the turn has produced no words the
            status prefix (thinking / reading) takes the label's place in the
            same column rhythm, capped at the block width. An empty line
            still renders (the row keeps the subtitle's seat). */}
        <div
          data-conversation-subtitle
          aria-live="polite"
          // The reserved seat's height, px — one 20px line, two when the
          // fold is long enough to wrap (JS estimate; line-clamp-2 owns
          // the real wrap).
          style={{ height: subtitleSeatHeight }}
          className={`shrink-0 overflow-hidden font-mono text-[11px] leading-5 ${
            open ? "hidden" : "pointer-events-none flex justify-center px-4"
          }`}
        >
          {subtitleLine && subtitleLine.text ? (
            <span
              className="flex min-w-0 w-full gap-3"
              style={{ maxWidth: "var(--subtitle-block-max)" }}
            >
              <span
                aria-hidden
                className={`w-28 shrink-0 truncate uppercase tracking-[0.08em] ${
                  subtitleLine.speaker === "persona"
                    ? "text-brand"
                    : "subtitle-user-ink"
                }`}
              >
                {subtitleLine.speaker === "persona"
                  ? t("subtitlePersona")
                  : t("subtitleUser")}
                :
              </span>
              <span className="min-w-0 flex-1 break-words text-muted-foreground line-clamp-2">
                {subtitleLine.runs.length > 0
                  ? subtitleLine.runs.map((run, index) =>
                      run.emphasis === "strong" ? (
                        <strong key={index} className="font-bold text-foreground">
                          {run.text}
                        </strong>
                      ) : run.emphasis === "em" ? (
                        <em key={index} className="italic">
                          {run.text}
                        </em>
                      ) : run.emphasis === "code" ? (
                        <code
                          key={index}
                          className="rounded-sm bg-foreground/10 px-1 text-foreground"
                        >
                          {run.text}
                        </code>
                      ) : (
                        run.text
                      ),
                    )
                  : subtitleLine.text}
              </span>
            </span>
          ) : subtitleLine?.status ? (
            <span
              className="subtitle-user-ink min-w-0 w-full truncate uppercase tracking-[0.08em]"
              style={{ maxWidth: "var(--subtitle-block-max)" }}
            >
              {subtitleLine.status.kind === "reading"
                ? t("subtitleReading", { count: subtitleLine.status.count })
                : t("subtitleThinking")}
            </span>
          ) : null}
        </div>

        {/* The panel's own slim bar: title + the two tier verbs. Fullscreen
            only — at the pill tier it stays mounted but hidden (it holds no
            state; the pill is the collapsed face). In-flow, so the
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
            stay mounted) and the clip hides the content. The body itself
            must NOT be inert: the composer renders inside this subtree
            (absolutely positioned against the BOX — outside this clip
            visually), and inertness is a DOM-subtree property a descendant
            cannot opt out of, so the body-level inert made the painted,
            clipped-out pill dead to every click. The CONTENT stays inert
            through the stream column's OWN `inert` (chat-page) — that is
            the fold's real guard; the composer is its live sibling. At
            fullscreen the body was never inert anyway, so this changes
            nothing there. */}
        <div
          id="conversation-panel"
          role="region"
          aria-label={t("title")}
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
            pill tier it lands on this box's bottom edge, centred, as the
            pill's one control row; at fullscreen it floats over the body
            as it always has. One component instance throughout — see
            `composer-host.tsx` and the `PanelTierContext` header. */}
      </div>
    </PanelTierContext.Provider>
  );
}
