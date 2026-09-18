"use client";

/**
 * The conversation surface — a thin adapter over `ConversationField`.
 *
 * IT USED TO BE THE RENDERER. This file held a react-virtuoso list, the
 * bottom-follow workaround for that library's estimate-short total height, the
 * per-frame seam measurement that fed the band's anchors, and the scroll
 * bookkeeping that tied them together. All of it existed because a browser
 * scroll container owned the position: the list had to be told where it was,
 * told what it had grown, and corrected when its own height estimate was wrong.
 *
 * The field owns the position instead, so none of that is needed and none of
 * it is kept. What remains here is the seam between the page and the surface:
 * the items the page owns, the paging it drives, and the two signals it reads
 * back — the top item (for the clock and the mode switcher) and the live edge.
 *
 * THE SURFACE SPLIT (the 2026-09 restore). The field is rendered where a WIDE
 * surface exists — it is authored against the window-derived tier column
 * (680 px) and cannot fit the conversation panel's 420–520 px dock:
 *
 *   - a portal into the shell's pane slot (field view; the panel floats
 *     beside it) or into the panel body (fullscreen, where the panel is
 *     viewport-wide);
 *   - a DOM fallback (`dom-chat-list.tsx`) on narrow surfaces (the game's
 *     docked/pilled panel), exactly as before the restore.
 *
 * THE ONE DIFFERENCE from the pre-refactor field: the turn that is IN FLIGHT
 * never enters the 3D field. History — happened time — is the field's whole
 * content; the ongoing turn renders as plain DOM in the conversation panel,
 * above the composer (`LiveTurnStrip`). That is the user's ruling: the 2.5D
 * conversation comes back unchanged, and only the live turn lives in the
 * panel. See `LiveTurnStrip` below and `conversation-surface.tsx`.
 *
 * `ChatStreamItem` and its halves live in `lib/chat/stream-items.ts`, where the
 * pure item model already was; anything that needs them imports them there
 * rather than reaching through a component.
 */

import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ConversationField,
  type ConversationFieldHandle,
} from "./conversation-field";
import { DomChatList } from "./dom-chat-list";
import { ChatMessage } from "./chat-message";
import { useConversationSurface } from "./conversation-surface";
import { splitItems } from "@/lib/chat/field-blocks";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";

export interface UnifiedChatStreamProps {
  items: ChatStreamItem[];
  /** Fired when the reader asks for the older page at the window's head. */
  onStartReached: () => void;
  /** The block at the top of the viewport — the travel clock's "from", and the
   *  slice the mode switcher carries to the timeline. */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** True while older slices are being paged in. */
  loadingOlder: boolean;
  /** Whether the catalog still holds older slices — decides whether the
   *  window's head offers the older page or reads as the beginning. */
  hasMore?: boolean;
  /** A failed turn, shown as a banner under the content. */
  error: Error | undefined;
  /** Briefing-mode arrival card props (§1.2 Rev 2). When set, the parent seats
   *  a `briefing` item at the stream tail and it renders through these. Typed
   *  from the component itself so a new briefing prop cannot be added without
   *  this adapter carrying it. */
  briefing?: React.ComponentProps<
    typeof import("./empty-briefing").EmptyBriefing
  > | null;
  /** The shared band feed, owned by the app shell — see `field-feed.ts`. */
  feed?: FieldFeed;
  /** True only while the chat view OWNS the band. The field keeps rendering
   *  while the timeline is open, but the card field owns the feed then, and two
   *  writers on one feed is exactly what the feed exists to prevent. */
  publishing?: boolean;
  /** Filled with the field's imperative handle, for the page's jumps. */
  fieldApiRef?: MutableRefObject<ConversationFieldHandle | null>;
  /** The floating chrome's height at the pane's top edge, px — carried
   *  straight through to the field's range. See `use-chrome-inset`. */
  insetTop?: number;
  /** The floating composer's height at the pane's foot, px — the live strip
   *  also clears it, so it floats above the composer rather than under it. */
  insetBottom?: number;
}

export function UnifiedChatStream({
  items,
  onStartReached,
  onTopItemChange,
  loadingOlder,
  hasMore,
  error,
  briefing,
  feed,
  publishing,
  fieldApiRef,
  insetTop,
  insetBottom,
}: UnifiedChatStreamProps) {
  const surface = useConversationSurface();

  // ── The one difference, stated where it happens ─────────────────────
  // `items` still ends with the live run (ChatPage builds it verbatim, and
  // the narrow DOM fallback renders it whole). The 3D field receives HISTORY
  // ONLY: the turn in flight is the panel's job, not the field's. `splitItems`
  // is the same pure split the field itself runs, so the field sees exactly
  // the item list it would have derived internally.
  const { history, live } = useMemo(() => splitItems(items), [items]);

  if (surface && surface.kind === "field" && surface.el) {
    return (
      <>
        {createPortal(
          <ConversationField
            items={history}
            onNeedOlder={onStartReached}
            onTopItemChange={onTopItemChange}
            loadingOlder={loadingOlder}
            hasMore={hasMore}
            error={error}
            briefing={briefing}
            feed={feed}
            publishing={publishing}
            apiRef={fieldApiRef}
            insetTop={insetTop}
            insetBottom={insetBottom}
          />,
          surface.el,
        )}
        <LiveTurnStrip items={live} insetBottom={insetBottom} />
      </>
    );
  }

  // Narrow surface (the game's docked/pilled panel) — or the first paint
  // before the shell has registered a slot element. The DOM list carries the
  // conversation there, whole (history and live), as it did before the
  // restore.
  return (
    <DomChatList
      items={items}
      onStartReached={onStartReached}
      onTopItemChange={onTopItemChange}
      loadingOlder={loadingOlder}
      hasMore={hasMore}
      error={error}
      briefing={briefing}
      feed={feed}
      publishing={publishing}
      insetTop={insetTop}
      insetBottom={insetBottom}
    />
  );
}

/**
 * THE IN-PROGRESS TURN — plain DOM in the conversation panel, above the
 * composer. THE REASON this strip exists at all is the restore's one
 * difference: the field renders happened time (history), and the turn that is
 * being written right now is rendered HERE, by the panel, in the same DOM the
 * composer lives in. Each item renders through `ChatMessage` — the same
 * component the field's live billboard used verbatim — so a live turn looks
 * the same as it always did; only its surface changed.
 *
 * The strip pins itself to the tail while the turn grows (a reader watching
 * the reply expects it to stay in view), and it scrolls internally once it
 * passes half the panel, so a long reply can never push the composer away.
 */
function LiveTurnStrip({
  items,
  insetBottom = 0,
}: {
  items: ChatStreamItem[];
  insetBottom?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const live = items.filter((item) => item.kind === "live") as Extract<
    ChatStreamItem,
    { kind: "live" }
  >[];
  if (live.length === 0) return null;

  return (
    <div
      data-conversation-live
      role="log"
      aria-live="polite"
      className="absolute inset-x-0 z-10 border-t border-foreground/5 bg-background"
      style={{ bottom: insetBottom, maxHeight: "50%" }}
    >
      <div ref={scrollRef} className="max-h-full overflow-y-auto px-4 py-3">
        {live.map((item): ReactNode => {
          return (
            <ChatMessage
              key={item.key}
              message={item.message}
              isStreaming={item.isStreaming}
              startedAt={item.startedAt}
              onRegenerate={item.onRegenerate}
              strands={item.strands}
            />
          );
        })}
      </div>
    </div>
  );
}
