/**
 * Cross-component "jump to this slice in the unified message stream" bus
 * (v0.10 M2) — the same module-level pub/sub discipline as turn-busy.ts: no
 * provider, no dependency.
 *
 * Producers: the search command palette (mounted in the header) and the recall
 * references bar (inside a chat message). Consumer: ChatPage registers its
 * slice-select path (page-until-loaded + Virtuoso scrollToIndex + the
 * time-travel clock as the loading state).
 *
 * A jump requested while the chat page is NOT mounted (the palette used from
 * another route) is stashed as `pending`; the producer then navigates home and
 * ChatPage replays the stash when its handler registers.
 */

export type SliceJumpHandler = (sliceId: string, start?: string) => void;

let handler: SliceJumpHandler | null = null;
let pending: { sliceId: string; start?: string } | null = null;

/** ChatPage registers its jump path here; returns the unregister function. */
export function registerSliceJumpHandler(h: SliceJumpHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/**
 * Request a jump. Returns true when a handler ran it synchronously; when no
 * handler is registered the slice id is stashed (exactly one pending jump —
 * the latest wins) and false is returned so the caller can navigate to the
 * chat page, where the stash replays on registration. `start` is the
 * target slice's ISO `start` when the producer already knows it (the card
 * field threads it through) — it saves the jump handler a catalog fetch to
 * learn the travel clock's target.
 */
export function requestSliceJump(sliceId: string, start?: string): boolean {
  if (handler) {
    handler(sliceId, start);
    return true;
  }
  pending = { sliceId, start };
  return false;
}

/** Take (and clear) the stashed pending jump — null when there is none. */
export function takePendingSliceJump(): { sliceId: string; start?: string } | null {
  const p = pending;
  pending = null;
  return p;
}

/** Test hook: drop all module state. */
export function resetSliceJumpForTests(): void {
  handler = null;
  pending = null;
}
