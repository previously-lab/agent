"use client";

/**
 * ConversationSurface — where the R3F conversation field is allowed to draw.
 *
 * The restored `ConversationField` (pre-`419ad3d`) is authored against the
 * WINDOW-derived tier column (`useTier()`, 680 px at a laptop window) and
 * simply does not fit the conversation panel's 420–520 px dock. So the field
 * renders through a portal into whichever surface can host it:
 *
 *   - "field" + el  an HTMLElement the field portals into — the shell's pane
 *                   slot (field view, docked/pilled panel beside it) or a slot
 *                   inside the panel body (fullscreen, where the panel is as
 *                   wide as the viewport).
 *   - "narrow"      no wide surface exists (the game's docked/pilled panel) —
 *                   the DOM list carries the conversation there, exactly as it
 *                   did before the restore.
 *
 * The provider lives in `app-shell.tsx`, which owns the two slot elements and
 * the panel mode; the consumer is `unified-chat-stream.tsx`, which decides —
 * per surface — between the portaled field and the DOM list. The shape
 * mirrors `world-slot.tsx` (the shell hands a host element to a renderer that
 * lives outside its DOM branch).
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

/** The current surface, or null before the shell's first commit (SSR and the
 *  first client paint) — consumers treat null as the narrow fallback. */
export function useConversationSurface(): ConversationSurface | null {
  return useContext(ConversationSurfaceContext);
}
