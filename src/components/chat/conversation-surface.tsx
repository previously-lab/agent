"use client";

/**
 * ConversationSurface — where the R3F conversation field is allowed to draw.
 *
 * The restored `ConversationField` (pre-`419ad3d`) is authored against the
 * WINDOW-derived tier column (`useTier()`, 680 px at a laptop window) and
 * simply does not fit the conversation panel's 420–520 px dock. So the field
 * renders through a portal into whichever surface can host it:
 *
 *   - "field" + el  an HTMLElement the field portals into — the app shell's
 *                   pane slot (field view, the floating pill beside it) or a
 *                   slot inside the panel body (fullscreen, where the panel
 *                   is as wide as the viewport).
 *   - "narrow"      no wide surface exists (the game view below the
 *                   fullscreen tier, or a route with no pane at all) —
 *                   the DOM list carries the conversation there, exactly as
 *                   it did before the restore.
 *
 * The provider lives in `shell/shell-provider.tsx` (v0.13 §3.1: the
 * conversation layer moved to the layout, and the surface state moved up
 * with it). The two slot ELEMENTS are rendered by their owners — the pane
 * slot by `app-shell.tsx`, the panel-body slot by `conversation-overlay.tsx`
 * — and registered with the provider through `useState`-backed refs. The
 * consumer is `unified-chat-stream.tsx`, which decides — per surface —
 * between the portaled field and the DOM list. The shape mirrors
 * `world-slot.tsx` (a host element handed to a renderer that lives outside
 * its DOM branch).
 */
import { createContext, useContext, type ReactNode } from "react";

export type ConversationSurface =
  | { kind: "field"; el: HTMLElement | null }
  | { kind: "narrow" };

const ConversationSurfaceContext = createContext<ConversationSurface | null>(
  null,
);

export function ConversationSurfaceProvider({
  value,
  children,
}: {
  value: ConversationSurface;
  children: ReactNode;
}) {
  return (
    <ConversationSurfaceContext.Provider value={value}>
      {children}
    </ConversationSurfaceContext.Provider>
  );
}

/** The current surface, or null before the provider's first commit (SSR and
 *  the first client paint) — consumers treat null as the narrow fallback. */
export function useConversationSurface(): ConversationSurface | null {
  return useContext(ConversationSurfaceContext);
}
