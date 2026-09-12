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
 * The field owns the position instead, so none of that is needed and none of it
 * is kept. What remains here is the seam between the page and the surface: the
 * items the page owns, the paging it drives, and the two signals it reads back
 * — the top item (for the clock and the mode switcher) and the live edge.
 *
 * `ChatStreamItem` and its halves live in `lib/chat/stream-items.ts`, where the
 * pure item model already was; anything that needs them imports them there
 * rather than reaching through a component.
 */

import type { MutableRefObject } from "react";
import { ConversationField, type ConversationFieldHandle } from "./conversation-field";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import type { FieldAnchor } from "@/lib/timeline3d/winding";

export interface UnifiedChatStreamProps {
  items: ChatStreamItem[];
  /** Fired when the reader reaches the top of what is loaded. */
  onStartReached: () => void;
  /** The block at the top of the viewport — the travel clock's "from", and the
   *  slice the mode switcher carries to the timeline. */
  onTopItemChange?: (timeIso: string, sliceId: string | null) => void;
  /** True while older slices are being paged in. */
  loadingOlder: boolean;
  /** A failed turn, shown as a banner under the content. */
  error: Error | undefined;
  /** Briefing-mode arrival card props (§1.2 Rev 2). When set, the parent seats
   *  a `briefing` item at the stream tail and it renders through these. */
  briefing?: {
    persona?: string;
    active: import("@/lib/episodic/actions").SliceSummary | null;
    recent: import("@/lib/episodic/actions").SliceSummary[];
    onSend: (message: string) => void;
  } | null;
  /** Shared strand-field anchors owned by the app shell — the field fills them
   *  while the chat view is foreground. */
  anchorsRef?: MutableRefObject<FieldAnchor[]>;
  /** True only when the chat view is the FOREGROUND view. The field keeps
   *  rendering while the timeline is open, but the timeline's card field owns
   *  the anchors then — publishing here would fight it. */
  anchorsActive?: boolean;
  /** Shared 0..1 progress for the band's ruler and rotation drift. */
  progressRef?: MutableRefObject<number>;
  /** Filled with the field's imperative handle, for the page's jumps. */
  fieldApiRef?: MutableRefObject<ConversationFieldHandle | null>;
}

export function UnifiedChatStream({
  items,
  onStartReached,
  onTopItemChange,
  loadingOlder,
  error,
  briefing,
  anchorsRef,
  anchorsActive,
  progressRef,
  fieldApiRef,
}: UnifiedChatStreamProps) {
  return (
    <div className="relative mx-auto h-full w-full max-w-5xl xl:max-w-7xl">
      <ConversationField
        items={items}
        onNeedOlder={onStartReached}
        onTopItemChange={onTopItemChange}
        loadingOlder={loadingOlder}
        error={error}
        briefing={briefing}
        anchorsRef={anchorsActive ? anchorsRef : undefined}
        progressRef={progressRef}
        apiRef={fieldApiRef}
      />
    </div>
  );
}
