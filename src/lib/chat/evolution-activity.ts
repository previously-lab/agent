/**
 * Evolution activity bus (v0.11) — the chat stream's data-evolution frames
 * as COMPANION events, in the slice-jump.ts discipline: module-level pub/sub,
 * no provider, no dependency.
 *
 * Producer: ChatPage scans the live messages' data-evolution parts and
 * publishes each newly-arrived frame (the scan state in
 * `createEvolutionScanState` / `nextEvolutionEvent` makes the diff pure and
 * unit-testable). Consumer: the app shell, which folds events into the
 * companion pod's presence (button breathing + panel replay) and fires the
 * achievement toast on a genuine completion.
 *
 * The chat-side EvolutionCard keeps rendering its own frames — this bus is an
 * ADDITIONAL surface, not a replacement (M3 retires the card). Bridge brain
 * runs no inline evolution, so nothing publishes there; with no subscribers
 * the bus is a no-op.
 */
import type { EvolutionStepData } from "@/lib/chat/build-stream";

/**
 * One normalized evolution activity event. `turnId` is the owning assistant
 * message's id — the frames themselves carry no run/turn id, and the message
 * id IS the turn identity (stable across reconnect replays, which is what
 * makes it the toast-dedupe key).
 */
/**
 * The structured fields of a done frame the pod panel's debug block renders —
 * everything the scan can pass through without interpretation.
 */
export type EvolutionDetail = Pick<
  EvolutionStepData,
  | "changes"
  | "mutations"
  | "direction"
  | "playbooks"
  | "triggers"
  | "partial"
  | "note"
>;

export type EvolutionActivity =
  | {
      kind: "running";
      turnId: string;
      step?: string;
      /** The Previously Agent's realtime thinking line, when the frame carries one. */
      live?: string;
    }
  | {
      kind: "done";
      turnId: string;
      /** The agent's one-sentence user-language account of what changed. */
      summary?: string;
      /** False = a legitimate no-change run (not an achievement moment). */
      hasChanges?: boolean;
      /** Set when the run FAILED — never a legit no-change. */
      error?: string;
      /**
       * True when this client session watched the run START (a running frame
       * arrived before this one). A done frame that is the FIRST frame
       * observed for its turn — a reconnect replay of a finished run, the
       * restored stash — is fact, not news: it lights no toast.
       */
      fresh: boolean;
      /** Structured frame detail, when the frame carries any. */
      detail?: EvolutionDetail;
    };

// ── Pub/sub ─────────────────────────────────────────────────────────────────

type EvolutionListener = (event: EvolutionActivity) => void;

const listeners = new Set<EvolutionListener>();

/** Subscribe to evolution activity; returns the unsubscribe function. */
export function subscribeEvolutionActivity(
  listener: EvolutionListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish one event to every subscriber (synchronous; no-op when none). */
export function publishEvolutionActivity(event: EvolutionActivity): void {
  for (const listener of [...listeners]) listener(event);
}

/** Test hook: drop all subscribers. */
export function resetEvolutionActivityForTests(): void {
  listeners.clear();
}

// ── Producer scan (pure diff against the last published frame) ──────────────

/**
 * Per-client-session scan state — one instance lives in the publisher's ref.
 * `running`: turn ids whose run this session saw start. `published`: the last
 * frame published per turn id, identity-compared so a re-render that replays
 * the SAME chunk object publishes nothing (new chunks are new objects).
 */
export type EvolutionScanState = {
  running: Set<string>;
  published: Map<string, EvolutionStepData>;
};

export function createEvolutionScanState(): EvolutionScanState {
  return { running: new Set(), published: new Map() };
}

/**
 * Diff one turn's latest data-evolution frame against the scan state and
 * return the event to publish, or null when the frame was already published.
 * A running frame marks the turn tracked; a done frame is `fresh` only while
 * the turn was tracked (and untracks it). Frames without the `status` field
 * are legacy — `running` is inferred from the `running` boolean.
 */
export function nextEvolutionEvent(
  state: EvolutionScanState,
  turnId: string,
  frame: EvolutionStepData,
): EvolutionActivity | null {
  if (state.published.get(turnId) === frame) return null;
  state.published.set(turnId, frame);
  const running =
    frame.status !== undefined ? frame.status === "running" : (frame.running ?? false);
  if (running) {
    state.running.add(turnId);
    return { kind: "running", turnId, step: frame.step, live: frame.live };
  }
  return {
    kind: "done",
    turnId,
    summary: frame.summary,
    hasChanges: frame.hasChanges,
    error: frame.error,
    fresh: state.running.delete(turnId),
    detail: evolutionDetailFromFrame(frame),
  };
}

/**
 * Extract a done frame's structured detail, or undefined when the frame
 * carries none — the debug surface only shows what exists.
 */
export function evolutionDetailFromFrame(
  frame: EvolutionStepData,
): EvolutionDetail | undefined {
  const detail: EvolutionDetail = {
    changes: frame.changes,
    mutations: frame.mutations,
    direction: frame.direction,
    playbooks: frame.playbooks,
    triggers: frame.triggers,
    partial: frame.partial,
    note: frame.note,
  };
  return Object.values(detail).some((v) => v !== undefined)
    ? detail
    : undefined;
}

// ── Consumer reducer: events → pod presence ─────────────────────────────────

/** What the pod reads — the button's breathing state and the panel's replay. */
export type EvolutionPresence = {
  /** A run is in flight — the pod's button breathes. */
  working: boolean;
  /** The newest completed run, for the panel's seat when no narration exists. */
  latest: {
    turnId: string;
    summary?: string;
    failed: boolean;
    /** False = a legitimate no-change run. */
    hasChanges?: boolean;
    /** The failure reason, when the run failed. */
    error?: string;
    /** Structured frame detail — the panel debug block's payload. */
    detail?: EvolutionDetail;
  } | null;
};

export const EVOLUTION_PRESENCE_IDLE: EvolutionPresence = {
  working: false,
  latest: null,
};

export function applyEvolutionActivity(
  presence: EvolutionPresence,
  event: EvolutionActivity,
): EvolutionPresence {
  switch (event.kind) {
    case "running":
      // A new run starts: the button lights. The last completion stays in the
      // panel's seat until this one settles — presence, not notification.
      return { ...presence, working: true };
    case "done":
      return {
        working: false,
        latest: {
          turnId: event.turnId,
          summary: event.summary,
          failed: Boolean(event.error),
          hasChanges: event.hasChanges,
          error: event.error,
          detail: event.detail,
        },
      };
  }
}

// ── Achievement toast: mapper + dedupe ──────────────────────────────────────

/** Localized copy — the caller (shell) owns the strings via next-intl. */
export type EvolutionToastCopy = {
  title: string;
  /** Used when the run left no one-line summary. */
  fallback: string;
};

export type EvolutionToast = { title: string; description: string };

/**
 * Maps a completion event to achievement-toast content, or null when the
 * moment is not an achievement: a failed run, a run that changed nothing, or
 * a run this client never saw start (history, not news). A run that changed
 * things but left no summary still counts — the caller's fallback carries it.
 */
export function evolutionToastContent(
  event: Extract<EvolutionActivity, { kind: "done" }>,
  copy: EvolutionToastCopy,
): EvolutionToast | null {
  if (!event.fresh || event.error || event.hasChanges === false) return null;
  const summary = event.summary?.trim();
  return {
    title: copy.title,
    description: summary ? summary : copy.fallback,
  };
}

/**
 * Toast dedupe — one achievement per turn. A durable run's replay (reconnect
 * or rescan) redelivers the same done frame; the turn was toasted the first
 * time and is skipped ever after. One instance per subscribing component.
 */
export class EvolutionToastDedupe {
  private toasted = new Set<string>();

  /** True the first time this turnId asks; false on every replay. */
  markToasted(turnId: string): boolean {
    if (this.toasted.has(turnId)) return false;
    this.toasted.add(turnId);
    return true;
  }
}
