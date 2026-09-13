"use client";

import { useEffect, useState } from "react";
import {
  peekEntry,
  subscribeSlice,
  SLICE_LOADING,
  type SlicePreview,
} from "@/lib/chat/slice-cache";

/**
 * SliceContent (Rev 2) — the 3D card field's subscription to the ONE slice
 * cache.
 *
 * Each card face used to receive its turn content from a `Map<string, ContentSlot>`
 * held in `CardField` state. That meant every visible slice resolve triggered a
 * top-down re-render of the whole R3F scene and produced the field-wide flicker
 * seen while scrolling. Rev 1 moved content into a module cache here, with each
 * card subscribing independently via `useSliceTurns(id)`.
 *
 * Rev 2 keeps the subscription per card — the reason for it has not changed —
 * but the CACHE moved to `src/lib/chat/slice-cache.ts`, because the chat's
 * paging path was keeping its own parallel copy of the very same slices: a
 * card's preview and the conversation's turns were two reads of one immutable
 * file. What this module still owns is the React binding, and it asks for
 * `meta` — the server-truncated opening rounds the card face is designed
 * around. A slice the chat has already paged in upgrades that entry to `full`
 * in place, and the upgrade reaches this subscription too.
 */
export type SliceContent = SlicePreview;

/**
 * Hook that returns the cached/loading turn content for a single slice.
 * Triggers one cache read when the slice is first requested and keeps the
 * result available for future mounts.
 */
export function useSliceTurns(id: string): SliceContent {
  const [slot, setSlot] = useState<SliceContent>(
    () => peekEntry(id)?.preview ?? SLICE_LOADING,
  );

  useEffect(
    () => subscribeSlice(id, "meta", (entry) => setSlot(entry.preview)),
    [id],
  );

  return slot;
}
