"use client";

import { useEffect, useState } from "react";
import { getSliceContent } from "@/lib/episodic/actions";
import type { Turn } from "@/lib/episodic/types";

/**
 * SliceContent (Rev 3) — the 3D card field's read of one slice's opening
 * rounds, held as plain component state.
 *
 * Each card face used to receive its turn content from a `Map<string, ContentSlot>`
 * held in `CardField` state. That meant every visible slice resolve triggered a
 * top-down re-render of the whole R3F scene and produced the field-wide flicker
 * seen while scrolling. Rev 1 moved content into a module cache here, with each
 * card subscribing independently via `useSliceTurns(id)`; Rev 2 moved that cache
 * to `src/lib/chat/slice-cache.ts` so the chat's paging path could share one
 * entry per slice with the card face.
 *
 * Rev 3 deletes the client cache outright (v0.10 C7). The project decision is
 * that the CLIENT HOLDS NO CACHE: `getSliceContent` is a server action, the
 * SERVER caches, and an extra call is cheap next to a cache that two surfaces
 * keep disagreeing about. So this module keeps the per-card READ — the reason
 * for it has not changed, and a card resolving its own content without
 * re-rendering the whole R3F scene is still the whole point — but the read now
 * resolves into one `useState` slot filled by one effect.
 *
 * The request is still `meta`: the server-truncated opening rounds the card
 * face is designed around (`FRAME_TURN_COUNT` in `src/lib/episodic/actions.ts`),
 * because a fixed-size frame handed a whole conversation would centre on the
 * middle of the slice. The conversation rung asks for the opposite
 * completeness — every turn, `{ full: true }` — and it asks for it directly
 * (`slice-conversation.tsx`); the two faces are no longer one cache entry, so
 * each states at its own call site what it draws.
 */
export interface SlicePreview {
  state: "loading" | "ready" | "failed";
  turns?: Turn[];
  previously?: string | null;
  summary?: string;
  open_loops?: string[];
  decisions?: string[];
}

export type SliceContent = SlicePreview;

/**
 * Stable placeholder for "nothing here yet". Every loading card shares this one
 * object, so setting it never churns a subscriber that compares identity, and
 * the card face never has to null-check its content. Treat it as frozen.
 */
export const SLICE_LOADING: SliceContent = { state: "loading" };

const SLICE_FAILED: SliceContent = { state: "failed" };

/**
 * Hook that returns this slice's content, loading while the server action is
 * in flight and `failed` when it cannot be read.
 *
 * The cancellation flag is not defensive: the field reconciles units by
 * position, so a slice scrolled out of the window unmounts while its read is
 * still on the wire (`useSliceTurns` is called per mounted card), and a late
 * resolution must not write into a slot that no longer describes it. An
 * unmount is the common case here, not the exceptional one.
 *
 * A failure is TERMINAL for this mount — the hook does not retry. `id` is the
 * only dependency, so a retry would only ever come from the field remounting
 * the card, which is exactly the per-card retry loop the deleted cache refused
 * to run; leaving a failed card failed is the honest face.
 */
export function useSliceTurns(id: string): SliceContent {
  const [slot, setSlot] = useState<SliceContent>(SLICE_LOADING);

  useEffect(() => {
    let cancelled = false;
    setSlot(SLICE_LOADING);

    getSliceContent(id)
      .then((payload) => {
        if (cancelled) return;
        setSlot(
          payload
            ? {
                state: "ready",
                turns: payload.turns,
                previously: payload.previously,
                summary: payload.summary,
                open_loops: payload.open_loops,
                decisions: payload.decisions,
              }
            : SLICE_FAILED,
        );
      })
      .catch(() => {
        // A server action can reject (transport, deserialization) rather than
        // resolve to the `null` a missing slice gives. Both are the same face.
        if (!cancelled) setSlot(SLICE_FAILED);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return slot;
}
