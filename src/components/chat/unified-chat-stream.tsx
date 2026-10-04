"use client";

/**
 * The conversation surface — a thin adapter over the two renderers.
 *
 * IT USED TO BE THE RENDERER. This file held a react-virtuoso list, the
 * bottom-follow workaround for that library's estimate-short total height, the
 * per-frame seam measurement that fed the band's anchors, and the scroll
 * bookkeeping that tied them together. All of it existed because a browser
 * scroll container owned the position: the list had to be told where it was,
 * told what it had grown, and corrected when its own height estimate was wrong.
 *
 * THE SURFACE SPLIT (2026-10-04). The three surfaces are three different
 * things, with TWO SEPARATE ITEM LISTS and two loaders — and this adapter is
 * where the split becomes structural:
 *
 *   - the R3F field (`conversation-field.tsx`) renders the repository's time
 *     slices — the ACTIVE one included — and LOADS THEM ITSELF
 *     (`useSliceStream` inside the field: catalog → content, older paging and
 *     jump paging included). Its only seat is the app shell's PANE slot — the
 *     conversation rung's 2.5D view of happened time, while the panel floats
 *     beside it at the pill tier. The field's column is window-derived
 *     (680 px), so it reaches the pane through a portal into the
 *     provider-composed slot (`conversation-surface.tsx`).
 *   - the DOM list (`dom-chat-list.tsx`) renders the PANEL's conversation:
 *     the `useChat` in-memory messages plus the arrival-restored resume
 *     block — the current conversation, zero repository paging. It is the
 *     panel's fullscreen body and every other narrow surface. No R3F ever
 *     mounts inside the panel.
 *   - the pill's subtitle is the third surface and is not here at all — it is
 *     folded in `chat-page.tsx` (`lib/chat/subtitle-line.ts`) and rendered by
 *     the panel.
 *
 * `ChatStreamItem` and its halves live in `lib/chat/stream-items.ts`, where the
 * pure item model already was; anything that needs them imports them there
 * rather than reaching through a component.
 */

import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import {
  ConversationField,
  type ConversationFieldHandle,
} from "./conversation-field";
import { DomChatList, type ChatStreamHandle } from "./dom-chat-list";
import { useConversationSurface } from "./conversation-surface";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";

export interface UnifiedChatStreamProps {
  /** The PANEL's items: the in-memory current conversation (the resume block
   *  + the live `useChat` messages). The field never sees this list — it
   *  loads the repository's slices itself. */
  items: ChatStreamItem[];
  /** Whose repository the field reads (the field self-loads its slices). */
  persona: string;
  /** The block at the top of the viewport — the travel clock's "from". Both
   *  surfaces report it; the clock reads whichever is mounted. */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** A failed turn, shown as a banner under the PANEL's content (the chat's
   *  error belongs to the in-memory conversation, not to the repository's
   *  history). */
  error: Error | undefined;
  /** Briefing-mode arrival card props (§1.2 Rev 2). Seated ONLY in the
   *  field's tail block — the panel no longer carries the card. Typed from
   *  the component itself so a new briefing prop cannot be added without
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
  /** Filled with the mounted surface's imperative handle, for the page's
   *  jumps. Both handles are structurally identical (scrollToKey /
   *  scrollToOffset / scrollToBottom / offset); only the field's carries
   *  `seekKey`, and jump callers guard for its absence. */
  fieldApiRef?: MutableRefObject<ConversationFieldHandle | null>;
  /** The floating chrome's height at the pane's top edge, px — carried
   *  straight through to the field's range. See `use-chrome-inset`. */
  insetTop?: number;
  /** The floating composer's height at the pane's foot, px — the DOM list
   *  also clears it, so the tail floats above the composer rather than under
   *  it. */
  insetBottom?: number;
}

export function UnifiedChatStream({
  items,
  persona,
  onTopItemChange,
  error,
  briefing,
  feed,
  publishing,
  fieldApiRef,
  insetTop,
  insetBottom,
}: UnifiedChatStreamProps) {
  const surface = useConversationSurface();

  if (surface && surface.kind === "field" && surface.el) {
    // The pane: the R3F field, self-loaded from the repository (the active
    // slice included). No item list crosses this boundary.
    return createPortal(
      <ConversationField
        persona={persona}
        onTopItemChange={onTopItemChange}
        briefing={briefing}
        feed={feed}
        publishing={publishing}
        apiRef={fieldApiRef}
        insetTop={insetTop}
        insetBottom={insetBottom}
      />,
      surface.el,
    );
  }

  // Everywhere else — the panel's fullscreen body, the game view, a route
  // with no pane, or the first paint before the shell has registered the
  // slot element. The DOM list carries the in-memory conversation, whole
  // (resume block and live), with no repository paging.
  return (
    <DomChatList
      items={items}
      onTopItemChange={onTopItemChange}
      error={error}
      feed={feed}
      publishing={publishing}
      // The two handle shapes are structurally identical (see the prop) —
      // the panel's list simply never implements `seekKey`.
      apiRef={
        fieldApiRef as MutableRefObject<ChatStreamHandle | null> | undefined
      }
      insetTop={insetTop}
      insetBottom={insetBottom}
    />
  );
}
