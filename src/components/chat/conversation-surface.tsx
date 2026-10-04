"use client";

/**
 * ConversationSurface — where the R3F conversation field is allowed to draw.
 *
 * The restored `ConversationField` (pre-`419ad3d`) is authored against the
 * WINDOW-derived tier column (`useTier()`, 680 px at a laptop window) and its
 * ONLY seat is the app shell's PANE slot — the conversation rung's 2.5D view
 * of happened time, portaled into the pane while the panel floats beside it
 * at the pill tier:
 *
 *   - "field" + el  an HTMLElement the field portals into — the app shell's
 *                   pane slot, and nothing else.
 *   - "narrow"      everywhere else: the panel's FULLSCREEN body (the
 *                   expanded conversation is a plain DOM surface — history
 *                   and the in-flight turn alike), the game view, or a route
 *                   with no pane at all. The DOM list carries the
 *                   conversation there, exactly as it did before the restore.
 *
 * The provider lives in `shell/shell-provider.tsx` (v0.13 §3.1: the
 * conversation layer moved to the layout, and the surface state moved up
 * with it). The slot ELEMENT is rendered by its owner — `app-shell.tsx` —
 * and registered with the provider through a `useState`-backed ref. The
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
