/**
 * The game room's narration session — ONE request per slice per session.
 *
 * The hotel room panel (src/components/game/room-narration-panel.tsx) asks
 * for a narration every time a room mounts; this store is what keeps that
 * cheap. It owns the in-flight streamNarration calls, remembers each slice's
 * entry (pending / done / failed), and answers a repeat request for the same
 * slice with the entry it already has instead of a new POST — re-entering a
 * room replays what is already there, and a room left mid-sentence keeps
 * streaming in the background so coming back re-attaches to live progress.
 *
 * The one sanctioned second request is the manual retry: `force` restarts a
 * FAILED entry (never a pending or done one), so the endpoint's budget gate
 * is spent on user intent, not on wandering the corridor.
 *
 * Deliberately DOM-free (like narrate.ts) so the whole de-dup / retry /
 * abort contract is unit-testable under vitest's node environment; the fetch
 * implementation is injectable for the same reason.
 */

import {
  NarrateError,
  streamNarration,
  type NarrateErrorCode,
} from "./narrate";

export interface NarrationEntry {
  status: "pending" | "done" | "failed";
  /** The prose so far — grows while pending, final when done. On a cut
   *  stream this is the part that WAS told (the failure marker is stripped
   *  by the narrate helper), so it is always renderable as-is. */
  text: string;
  /** Set only when status is "failed" — the UI maps it to localized copy. */
  error?: NarrateErrorCode;
}

export type NarrationListener = (entry: NarrationEntry) => void;

export interface NarrationRequestOptions {
  locale?: string;
  timezone?: string;
  /** Restart a FAILED narration (the manual retry). Never restarts a pending
   *  or done one — those are served from the session's memory. */
  force?: boolean;
}

export interface NarrationSession {
  /** The recorded entry for a slice, or undefined when nothing was asked. */
  get(sliceId: string): NarrationEntry | undefined;
  /** Follow one slice's entry; the listener fires on every change. */
  subscribe(sliceId: string, listener: NarrationListener): () => void;
  /**
   * Ensure a narration for `sliceId` is in flight. Returns true when a NEW
   * request was started; false when the session already has the slice
   * (pending or done — served as-is) or the retry rules forbid it.
   */
  request(sliceId: string, options?: NarrationRequestOptions): boolean;
  /** Abort every in-flight stream (session teardown). Aborted narrations
   *  leave NO record, so a later session may ask for the slice again. */
  dispose(): void;
}

export function createNarrationSession(deps?: {
  /** Test seam — forwarded to streamNarration. */
  fetchImpl?: typeof fetch;
}): NarrationSession {
  const entries = new Map<string, NarrationEntry>();
  const listeners = new Map<string, Set<NarrationListener>>();
  const controllers = new Map<string, AbortController>();

  function update(sliceId: string, entry: NarrationEntry): void {
    entries.set(sliceId, entry);
    const subs = listeners.get(sliceId);
    if (!subs) return;
    for (const listener of subs) listener(entry);
  }

  return {
    get: (sliceId) => entries.get(sliceId),

    subscribe(sliceId, listener) {
      let subs = listeners.get(sliceId);
      if (!subs) {
        subs = new Set();
        listeners.set(sliceId, subs);
      }
      subs.add(listener);
      return () => {
        subs.delete(listener);
        if (subs.size === 0) listeners.delete(sliceId);
      };
    },

    request(sliceId, options = {}) {
      const existing = entries.get(sliceId);
      if (existing && !(options.force === true && existing.status === "failed")) {
        return false;
      }
      const controller = new AbortController();
      controllers.set(sliceId, controller);
      update(sliceId, { status: "pending", text: "" });
      let text = "";
      streamNarration(
        {
          sliceId,
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.timezone ? { timezone: options.timezone } : {}),
          signal: controller.signal,
          ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        },
        (accumulated) => {
          text = accumulated;
          update(sliceId, { status: "pending", text });
        },
      )
        .then((finalText) => {
          update(sliceId, { status: "done", text: finalText });
        })
        .catch((e: unknown) => {
          if (e instanceof NarrateError && e.code === "aborted") {
            // Teardown or a superseded run — leave no record, so a later
            // visit may ask again (nothing was ever shown from this run).
            if (controllers.get(sliceId) === controller) {
              controllers.delete(sliceId);
              entries.delete(sliceId);
            }
            return;
          }
          update(sliceId, {
            status: "failed",
            text,
            error: e instanceof NarrateError ? e.code : "request_failed",
          });
        })
        .finally(() => {
          if (controllers.get(sliceId) === controller) {
            controllers.delete(sliceId);
          }
        });
      return true;
    },

    dispose() {
      // Abort only — do NOT clear the map: each request's own finally/aborted
      // cleanup removes its controller (identity-checked) when the rejection
      // settles, and clearing here would make that check fail and strand the
      // pending entry.
      for (const controller of controllers.values()) controller.abort();
    },
  };
}
