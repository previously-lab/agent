/**
 * Companion panel open requests (v0.21 visibility lane) — the composer's HQ
 * button and the pod's floating button are TWO ENTRIES TO THE SAME PANEL.
 * In the slice-jump.ts discipline: module-level pub/sub, no provider, no
 * dependency.
 *
 * Producer: the composer's evolution-stream button (chat-input.tsx) — one
 * click = open the panel. Consumer: the CompanionPod, which owns the panel's
 * open state and answers a request with `setOpen(true)`. Closing stays the
 * panel's own gesture (its ✕); a request only ever OPENS.
 *
 * With no subscriber (the pod is hidden on the bridge brain) a request is a
 * no-op — the button is quiet, never broken.
 */

type CompanionPanelListener = () => void;

const listeners = new Set<CompanionPanelListener>();

/** Subscribe to panel-open requests; returns the unsubscribe function. */
export function subscribeCompanionPanelRequests(
  listener: CompanionPanelListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the pod to open its panel (synchronous; no-op when it is absent). */
export function requestCompanionPanelOpen(): void {
  for (const listener of [...listeners]) listener();
}

/** Test hook: drop all subscribers. */
export function resetCompanionPanelRequestsForTests(): void {
  listeners.clear();
}
