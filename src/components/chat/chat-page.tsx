"use client";

import { useDurableChat } from "@/hooks/use-durable-chat";
import { messagesWithNativeReplay, rememberNativeReplay } from "@/lib/chat/native-replay";
import { nativeMessageTurnIdentity, visibleAssistantText } from "@/lib/chat/assistant-text";
import { useMemo, useState, useRef, useCallback, useEffect, type MutableRefObject } from "react";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import type { UIMessage } from "@/lib/chat/protocol";
import { ChatInput } from "./chat-input";
import { messageImageAttachments, stagedImageReferences } from "@/lib/chat/image-attachment-message";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { ComposerHost } from "./composer-host";
import { ConversationPrimaryPlaceholder } from "./conversation-controls";
import { NativePersonaProvider, useNativeSourceScope } from "./native-source-scope";
import { DocumentContextPersonaSync, useDocumentContext } from "./document-context-provider";
import {
  createDocumentContextEnvelope,
  createDocumentContextMetadata,
  documentContextFromMetadata,
  type DocumentContextSnapshot,
} from "@/lib/chat/document-context";
import { usePanelTier } from "./conversation-panel";
import { useShell, type DeskOpenOptions } from "@/components/shell/shell-provider";
import { ChatPageSkeleton, ChatStreamSkeleton } from "./chat-skeleton";
import { DomChatList, type ChatStreamHandle } from "./dom-chat-list";
import type { FieldFeed } from "@/lib/timeline3d/field-feed";
import type { ChatStreamItem } from "@/lib/chat/stream-items";
import { RelativeTimeReadout } from "./relative-time";
import { EmptyBriefing } from "./empty-briefing";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  getArrivalState,
  getEpisodicState,
  getSlicePageWithContent,
  getSliceStart,
  type ArrivalState,
  type SliceSummary,
  type SliceWithContent,
} from "@/lib/episodic/actions";
import { useBriefingIdentity } from "@/hooks/use-briefing-identity";
import {
  decideArrival,
  readArrivalWithRecovery,
  shouldDiscardRecoveredSession,
  type ArrivalGateResult,
  recoveryMessages,
  mergeRecoveredMessages,
  mergeSavedTurns,
  type ArrivalDecision,
} from "@/lib/chat/reconnect";
import {
  buildHistoryItems,
  interleaveNestedBubbles,
  type ResumeBlock,
} from "@/lib/chat/stream-items";
import {
  NESTED_BUBBLE_CHUNK,
  normalizeNestedBubble,
  type NestedBubbleFrame,
} from "@/lib/chat/nested-bubble";
import { PARALLEL_SUMMARY_CHUNK } from "@/lib/chat/parallel-runs";
import {
  ParallelLaneView,
  upsertMergeLane,
  useParallelLaneReaders,
  type ParallelLane,
} from "./parallel-lane";
import { getChatRecovery, type ChatRecovery } from "@/lib/chat/actions";
import { usePersistenceObserver } from "@/hooks/use-persistence-observer";
import { ACTIVE_RUN_ID_KEY, acceptPersistenceRecovery, readPendingPersistence, rememberSummaryRun, rememberTurnRun } from "@/lib/chat/persistence";
import { PERSISTENCE_HANDOFF_CHUNK } from "@/lib/chat/turn-types";
import type { UserConfig } from "@/lib/config/types";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { setTurnBusy } from "./turn-busy";
import {
  createEvolutionScanState,
  nextEvolutionEvent,
  publishEvolutionActivity,
} from "@/lib/chat/evolution-activity";
import type { EvolutionStepData } from "@/lib/chat/build-stream";
import { registerSliceJumpHandler, takePendingSliceJump } from "@/lib/chat/slice-jump";
import { parseAtParam, parseAtStartParam, stripAtParam } from "@/lib/chat/deep-link";
import {
  foldSubtitleLineLatest,
  type AnyPart,
  type SubtitleLine,
  type SubtitleSource,
} from "@/lib/chat/subtitle-line";
import type { CurrentView } from "@/lib/chat/current-view";
import {
  captureScreenContext,
  screenContextRequestField,
  type ScreenContext,
} from "@/lib/chat/screen-context";
import { formatErrorDetail } from "@/lib/chat/workflow-errors";
import { buildDialogueRegenerationRequest } from "@/lib/chat/dialogue-regenerate";
import { DialogueDisabled, useDialogueManuscript } from "./use-dialogue-manuscript";
import { dialogueStreamRows } from "./dialogue-stream-rows";
import { orderDialogueItems, unrepresentedHistory } from "./dialogue-history";
import { DialogueWorkTurn } from "./dialogue-work-turn";

const DIALOGUE_ARRIVAL: ArrivalState = { mode: "briefing" };

interface ChatPageProps {
  /** Server-preloaded user config (RSC) — seeds the selected model so the
   *  chat starts on the real value instead of flashing defaults. */
  initialConfig?: UserConfig;
  /** A summary receipt proves saved turns; refresh the catalog and archives. */
  onTurnSettled?: () => void;
  /** The shared band feed, owned by the layout-level shell provider — see
   *  `field-feed.ts`. */
  feed?: FieldFeed;
  /** The feed's one-writer lease, computed by the route (nobody publishes
   *  mid-move). */
  publishing?: boolean;
  /** The floating chrome's height at the pane's top edge, px — measured once
   *  by the shell (`use-chrome-inset`). */
  insetTop?: number;
  /** The floating composer's height at the pane's foot, px — BUBBLED UP rather
   *  than held here, because the layout-level shell provider is the one place
   *  above both the measurer and the stream that clears it (v0.13 §3.1). */
  insetBottom?: number;
  /** Report that measurement upward. The composer is the only thing that knows
   *  how tall it is (a growing textarea, an attachment row), so it is measured
   *  where it is drawn and the number is owned by the provider. */
  onComposerClearanceChange?: (px: number) => void;
  /** Publish the in-flight turn's subtitle line (v0.13 §4) — the current
   *  discrete activity caption (what the agent is doing, never the reply's
   *  words), folded here from the live messages by the pure reducer in
   *  `lib/chat/subtitle-line.ts` and gated on a turn actually being in
   *  flight. The panel's pill renders it; the overlay lifts the value from
   *  this page back down into the panel as a prop. */
  onSubtitleLineChange?: (line: SubtitleLine | null) => void;
  /** The shell provider's current-view getter (v0.13 §5 视野注入). Read at SEND
   *  time in the transport body as the structured `view` field — which slice
   *  the reader is looking at, and on which surface. Absent (the provider
   *  returns none in the lobby default) → no field → the server injects no
   *  block. */
  getView?: () => CurrentView | undefined;
  /** A separate, bounded observation frozen only while preparing a send. */
  getScreenContext?: () => ScreenContext | undefined;
}

/** Only history failure blocks entry. Workflow recovery is optional and bounded. */
interface MountVerdict extends ArrivalDecision {
  arrival: ArrivalState;
  recovery: ChatRecovery | null;
  storedRunId: string | null;
  resumeRunId: string | null;
  discardStored: boolean;
}

export function ChatPage(props: ChatPageProps) {
  const sourceScope = useNativeSourceScope();
  const searchParams = useSearchParams();
  const persona = searchParams.get("persona") || "user";
  // A late result must not mount another memory owner's conversation. Ordinary
  // route/tier changes retain the same session and its single editor.
  const scope = JSON.stringify([sourceScope, persona]);
  return <ChatPageSession key={scope} {...props} persona={persona} />;
}

function ChatPageSession({ persona, ...props }: ChatPageProps & { persona: string }) {
  const dialogue = useDialogueManuscript(persona);
  const legacyGate = dialogue.mode === "legacy" && !dialogue.opened;
  const arrivalTier = usePanelTier();
  const t = useTranslations("chat");
  const [verdict, setVerdict] = useState<MountVerdict | null>(null);
  const [arrivalFailure, setArrivalFailure] = useState<"failed" | "timeout" | null>(null);
  const [arrivalAttempt, setArrivalAttempt] = useState(0);
  const onTurnSettledRef = useRef(props.onTurnSettled);
  onTurnSettledRef.current = props.onTurnSettled;
  useEffect(() => {
    if (dialogue.mode !== "legacy") return;
    let cancelled = false;
    resolveArrival(persona).then((result) => {
      if (cancelled) return;
      if (result.kind !== "ok") {
        setArrivalFailure(result.kind);
        return;
      }
      const next = result.verdict;
      // Apply only timely results from this source/persona. Missing workflow
      // IDs are discarded, not acknowledged as saved; transient errors do not
      // remove pending entries. No late read may mutate these pointers.
      const sameStoredRun = readStoredRunId() === next.storedRunId;
      if (next.recovery) acceptPersistenceRecovery(next.recovery);
      // The background observer is deliberately not mounted yet. Initial
      // receipts must still refresh the shell's archive/catalog once accepted.
      if (next.recovery?.receipts.length) onTurnSettledRef.current?.();
      if (persona === "user" && sameStoredRun) {
        if (next.discardStored) {
          clearStoredRunId();
          clearStoredChatId();
          clearStoredMessages();
        } else if (next.storedRunId && next.recovery?.missingRunIds?.includes(next.storedRunId)) {
          clearStoredRunId();
        }
        if (next.resumeRunId) writeStoredRunId(next.resumeRunId);
      }
      setVerdict(next);
    });
    return () => { cancelled = true; };
  }, [arrivalAttempt, persona, dialogue.mode]);
  if (arrivalFailure && legacyGate) {
    return (
      <><ComposerHost composer={
        <div data-chat-arrival-error data-arrival-failure={arrivalFailure} className="conversation-composer composer-bar flex min-w-0 items-center gap-3 px-3">
          <p role="alert" className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t(arrivalFailure === "timeout" ? "arrivalTimeout" : "arrivalError")}
          </p>
          <button type="button" className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm"
            onClick={() => { setArrivalFailure(null); setArrivalAttempt((n) => n + 1); }}>
            {t("arrivalRetry")}
          </button>
        </div>
      } /><ConversationPrimaryPlaceholder inline={arrivalTier?.mode === "pill"} /></>
    );
  }
  if (legacyGate && !verdict) return <ChatPageSkeleton />;
  return (
    <NativePersonaProvider value={persona}>
      <DocumentContextPersonaSync persona={persona} />
      {persona === "user" && dialogue.mode === "legacy" && verdict && <PersistenceObserver onCommitted={props.onTurnSettled} />}
      <Inner {...props} persona={persona} dialogue={dialogue} shouldResume={verdict?.shouldResume ?? false}
        initialMessages={verdict?.initialMessages ?? []}
        arrival={dialogue.mode === "dialogue" ? dialogue.historyWindow?.arrival ?? DIALOGUE_ARRIVAL : verdict?.arrival ?? DIALOGUE_ARRIVAL} />
    </NativePersonaProvider>
  );
}

function PersistenceObserver({ onCommitted }: { onCommitted?: () => void }) {
  // Mount only after history has loaded: Next can serialize Server Actions,
  // so a background workflow read must not get ahead of authoritative history.
  usePersistenceObserver(onCommitted, (error) => toast.error(error));
  return null;
}

async function resolveArrival(persona: string): Promise<ArrivalGateResult<MountVerdict>> {
  // Legacy reconnect keys belong to the user's live chat, not demo personas.
  const storedRunId = persona === "user" ? readStoredRunId() : null;
  const pending = persona === "user" ? readPendingPersistence() : { runIds: [], summaryRunIds: [] };
  const runIds = [...new Set([...pending.runIds, ...(storedRunId ? [storedRunId] : [])])];
  const result = await readArrivalWithRecovery(
    getArrivalState(persona),
    () => runIds.length || pending.summaryRunIds.length
      ? getChatRecovery(runIds, pending.summaryRunIds)
      : Promise.resolve({ records: [], activeRunIds: [], savedRunIds: [], receipts: [], unavailableRunIds: [], failures: [] }),
  );
  if (result.kind !== "ok") return result;
  const { arrival, recovery: recoveryRead } = result.verdict;
  const recovery = recoveryRead.kind === "ok" ? recoveryRead.verdict : null;
  let resumeRunId = storedRunId && recovery?.activeRunIds.includes(storedRunId) ? storedRunId : null;
  if (!resumeRunId && recovery?.activeRunIds.length === 1) resumeRunId = recovery.activeRunIds[0];
  const verdict = { arrival, recovery, storedRunId, resumeRunId,
    discardStored: shouldDiscardRecoveredSession(recovery, runIds, pending.summaryRunIds) };
  if (!recovery) return { kind: "ok", verdict: { ...verdict, ...decideArrival(false, []) } };
  const persisted = new Set(arrival.mode === "resume" ? arrival.turns.map((turn) => turn.turnId).filter((id): id is string => Boolean(id)) : []);
  const persistedUsers = new Set(arrival.mode === "resume" ? arrival.turns.filter((turn) => turn.role === "user").map((turn) => turn.clientMessageId).filter((id): id is string => Boolean(id)) : []);
  if (resumeRunId) {
    const decision = decideArrival(true, storedRunId === resumeRunId ? readStoredMessages() : []);
    const saved = mergeSavedTurns(decision.initialMessages, arrival.mode === "resume" ? arrival.turns : []);
    return { kind: "ok", verdict: { ...verdict, ...decision,
      initialMessages: mergeRecoveredMessages(saved, recovery.records.map(({ record }) => record), persisted, persistedUsers) } };
  }
  return { kind: "ok", verdict: { ...verdict, shouldResume: false,
    initialMessages: recoveryMessages(recovery.records.map(({ record }) => record), persisted, persistedUsers) } };
}

// ─── Reconnect persistence ────────────────────────────────────────────────
// The durable workflow run's id is persisted so a reloaded or backgrounded tab
// (phone lock / app switch) can re-attach to the SAME run's stream and replay
// whatever it missed — but only while the run is actually in flight (the
// mount-time arrival decision asks the server, see resolveArrival). Cleared on
// a clean turn end and whenever the run turns out terminal. Guarded so a
// private-mode / SSR environment (no localStorage) degrades to no-op.
const RUN_ID_KEY = ACTIVE_RUN_ID_KEY;
const CHAT_ID_KEY = "previously:chatId";

// ─── Sending window (v0.8) ────────────────────────────────────────────────
// The client keeps the full conversation for rendering, but only the LAST N
// messages travel to the server each turn. Everything earlier is already
// stored in the current slice; if the agent needs deeper context it gets it
// via recall / readSlice — it must NOT be handed
// the whole client history (that is the context-bloat + storage-accumulation
// source). The UI never trims; only the wire payload does.
const SEND_MESSAGE_WINDOW = 10; // ~5 turns of working memory
/** Cap the persisted conversation so a long session can't overflow localStorage. */
const PERSIST_MESSAGE_CAP = 200;

function readStoredRunId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(RUN_ID_KEY);
  } catch {
    return null;
  }
}

function writeStoredRunId(runId: string): void {
  rememberTurnRun(runId);
  try {
    localStorage.setItem(RUN_ID_KEY, runId);
  } catch {
    /* private mode — reconnection is best-effort */
  }
}

function clearStoredRunId(): void {
  try {
    localStorage.removeItem(RUN_ID_KEY);
  } catch {
    /* private mode — reconnection is best-effort */
  }
}

function clearStoredChatId(): void {
  try {
    localStorage.removeItem(CHAT_ID_KEY);
  } catch {
    /* best-effort */
  }
}

// ─── Conversation persistence (official single-turn resume pattern) ───────
// The chat-session-modeling / resumable-streams docs: the client owns the
// conversation and restores it via `initialMessages` when a run is resumed, so
// the stream resume only reconciles the LAST message instead of replaying the
// whole run into an empty store (which pushes a full copy per chunk →
// duplicated, growing message list). We persist the rendered UIMessage[] to
// localStorage. Since v0.10 this stash serves ONLY the in-flight reconnect —
// completed conversation is restored from its slice (see resolveArrival).
const STORED_MESSAGES_KEY = "previously:messages";

function readStoredMessages(): UIMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORED_MESSAGES_KEY);
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  } catch {
    return [];
  }
}

function writeStoredMessages(messages: UIMessage[]): void {
  try {
    localStorage.setItem(STORED_MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    /* private mode — persistence is best-effort */
  }
}

function clearStoredMessages(): void {
  try {
    localStorage.removeItem(STORED_MESSAGES_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Mint a client-side turn id for the say-into-episode path (v0.30 §4.1): 4
 * random bytes as 6-char base64url — the same shape start-turn mints
 * server-side (`crypto.randomBytes(4).toString("base64url")`), validated by
 * the messages route. The id is the dedupe key: a retried submit never
 * writes the turn twice.
 */
function mintTurnId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Read a File as a data URL — the transport for image file parts. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The live run as subtitle sources. The subtitle captions WHAT THE AGENT IS
 * DOING (the discrete activity blocks, `lib/chat/subtitle-line.ts`), so only
 * the LIVE turn's messages are sources — history turns (slice-restored,
 * synthetic text parts) are happened time and never light up the caption.
 * Oldest → newest, matching the stream's order.
 */
function subtitleSourcesOf(items: readonly ChatStreamItem[]): SubtitleSource[] {
  const sources: SubtitleSource[] = [];
  for (const item of items) {
    if (item.kind === "live") {
      sources.push({
        role: item.message.role,
        parts: (item.message.parts ?? []) as AnyPart[],
        live: true,
      });
    }
  }
  return sources;
}

// ─── Inner ───────────────────────────────────────────────────────────────

function Inner({
  initialConfig,
  onTurnSettled,
  feed,
  publishing,
  insetTop,
  insetBottom,
  onComposerClearanceChange,
  onSubtitleLineChange,
  getView,
  getScreenContext,
  persona,
  shouldResume,
  initialMessages,
  arrival,
  dialogue,
}: {
  initialConfig?: UserConfig;
  /** A turn settled — see ChatPageProps. */
  onTurnSettled?: () => void;
  /** The shared band feed — see ChatPageProps. */
  feed?: FieldFeed;
  /** The feed's one-writer lease — see ChatPageProps. */
  publishing?: boolean;
  /** The pane's two floating insets — see `ChatPageProps`. */
  insetTop?: number;
  insetBottom?: number;
  /** Report the composer's own measurement upward — see `ChatPageProps`. */
  onComposerClearanceChange?: (px: number) => void;
  /** Publish the subtitle line upward — see `ChatPageProps`. */
  onSubtitleLineChange?: (line: SubtitleLine | null) => void;
  /** The shell's current-view getter — see `ChatPageProps`. */
  getView?: () => CurrentView | undefined;
  getScreenContext?: () => ScreenContext | undefined;
  /** Persona from the URL — server actions can't read searchParams. */
  persona: string;
  /** The mount-time arrival verdict (resolveArrival) — see ChatPage. */
  shouldResume: boolean;
  initialMessages: UIMessage[];
  /** The §2 arrival gate — resume restores the alive slice's turns. */
  arrival: ArrivalState;
  dialogue: ReturnType<typeof useDialogueManuscript>;
}) {
  const locale = useLocale();
  const tDialogue = useTranslations("chat.dialogue");
  const { getSnapshot, clearReferences } = useDocumentContext();
  const parallelDocumentContextsRef = useRef<Map<string, DocumentContextSnapshot>>(new Map());

  const [lastUserMessageAt, setLastUserMessageAt] = useState<string | null>(null);

  // ── Timeline state ──────────────────────────────────────────────────────
  const [timelineSlices, setTimelineSlices] = useState<SliceSummary[]>([]);
  // The most recent slice — its focus / open_loops seed the empty briefing.
  const [activeSlice, setActiveSlice] = useState<SliceSummary | null>(null);
  // The slice the stream is currently landed on ("now" = the live bottom) —
  // the jump guard and the submit snap-back read it.
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>("now");
  // The briefing identity — the display name for the "PREVIOUSLY ON {name}"
  // eyebrow over the time-travel readout, plus the persona list in demo mode.
  // Resolved through the SHARED hook and passed down, so nothing below it looks
  // the name up again — and so the header's brand shares this one request
  // rather than making a second. The read walks the memory for the newest
  // previously.md, which in GitHub mode is a network walk over a month of day
  // directories; see `use-briefing-identity.ts`.
  const identity = useBriefingIdentity();
  // The time-travel transition currently playing (if any) — an overlay that
  // covers the stream and doubles as the loading state while older pages are
  // paged in beneath it.
  const [transition, setTransition] = useState<{
    from: string;
    to: string;
    sliceId: string;
  } | null>(null);
  // Resolves when the clock animation lands (see handleSelectSlice).
  const clockLandedRef = useRef<(() => void) | null>(null);

  // ── Unified message stream (v0.10 §1/§2) ──────────────────────────────
  // The resume block: when the newest slice is still alive (and we're not
  // re-attaching to an in-flight run whose stash already carries those turns),
  // its turns re-enter the PANEL from the slice itself — the restored current
  // conversation, in memory.
  const resumeBlock = useMemo<ResumeBlock | null>(() =>
    arrival.mode === "resume" && !shouldResume
      ? {
          sliceId: arrival.sliceId,
          start: arrival.start,
          focus: arrival.focus,
          strands: arrival.strands,
          turns: arrival.turns,
        }
      : null, [arrival, shouldResume],
  );

  // The DOM list owns the position, so the jump paths drive it through this
  // handle (filled by the list below — see `dom-chat-list.tsx`).
  const streamApiRef = useRef<ChatStreamHandle | null>(null);
  // The time of the item currently at the top of the viewport (reported by the
  // mounted surface) — the travel clock rolls FROM where the viewer actually is.
  const topTimeRef = useRef<string | null>(null);

  // Load the newest slice on mount — feeds the empty briefing and the
  // empty-memory verdict (`hasMore` included: an empty recent page with more
  // pages behind it is NOT an empty memory). (The 3D
  // timeline loads its catalog lazily inside AppShell.)
  // The arrival payload already contains readable history. A later catalog
  // request queued behind a slow workflow must not cover that history again.
  const [episodicReady, setEpisodicReady] = useState(arrival.mode === "resume");
  const [episodicHasMore, setEpisodicHasMore] = useState(true);
  useEffect(() => {
    let cancelled = false;
    getEpisodicState(persona)
      .then((data) => {
        if (cancelled) return;
        setTimelineSlices(data.recent);
        setActiveSlice(data.active);
        setEpisodicHasMore(data.hasMore);
      })
      .catch(() => {
        // silently ignore
      })
      .finally(() => {
        if (!cancelled) setEpisodicReady(true);
      });
    return () => { cancelled = true; };
  }, [persona]);

  // ── The episode side store (v0.30 §4.2) ─────────────────────────────────
  // Nested-bubble frames live OUTSIDE useDurableChat's messages: a Map keyed by the
  // inner instance's own turnId, written only by onData below (the frames are
  // transient — never UIMessage parts). They survive the turn's end within
  // the session (bubbles stay seated after their user messages); a reload
  // starts empty and rebuilds from the replayed stream — history never reads
  // them back (R7).
  const [nestedBubbles, setNestedBubbles] = useState<
    Map<string, NestedBubbleFrame>
  >(new Map());

  // ── Parallel lanes (v0.33 §6) ────────────────────────────────────────────
  // A send while a turn streams starts ANOTHER standard run on a bypass lane
  // Each concurrent turn has an independent durable stream reader.
  // Lanes live OUTSIDE `messages` while the burst is in flight; when every
  // lane has settled and the main stream is idle, the fold below appends the
  // bypass user/answer pairs and the batch summary as ordinary messages, so
  // the next send's client history lines up with the slice again.
  const [parallelLanes, setParallelLanes] = useState<ParallelLane[]>([]);
  const patchParallelLane = useCallback(
    (
      laneId: string,
      patch: Partial<Pick<ParallelLane, "text" | "settled" | "runId" | "message">>,
    ) => {
      setParallelLanes((prev) =>
        prev.map((l) => (l.laneId === laneId ? { ...l, ...patch } : l)),
      );
    },
    [],
  );
  // The merge line rides the LAST finisher's stream as a transient chunk
  // CARRYING THE TEXT (v0.38 §3.2, v0.40 §2.1) — no summary run exists
  // anymore. It seats the batch's closing bubble directly: 可空 = no chunk =
  // no lane = no bubble. Replay-deduped inside the pure upsert.
  const seatMergeLine = useCallback((sliceId: string, text: string) => {
    setParallelLanes((prev) => upsertMergeLane(prev, sliceId, text));
  }, []);
  useParallelLaneReaders(parallelLanes, patchParallelLane, seatMergeLine);

  // The one-shot arrival verdict owns resume. The transport replays the same
  // durable run from index zero; data checkpoints rebuild with the visible text.
  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    error,
  } = useDurableChat({
    messages: initialMessages,
    resume: shouldResume,
    // v0.30 §4.2 — the episode's side channel: transient `data-nested-bubble`
    // frames never land in UIMessage parts (the server marks them transient),
    // they arrive HERE only. The side store is keyed by the instance's turnId;
    // a reconnect replay re-delivers every frame in order, so the map rebuilds
    // deterministically (later frames for one instance overwrite earlier ones).
    onData: (chunk) => {
      if (chunk.type === PERSISTENCE_HANDOFF_CHUNK) {
        const data = (chunk as { data?: { summaryRunId?: unknown } }).data;
        if (typeof data?.summaryRunId === "string") rememberSummaryRun(data.summaryRunId);
        return;
      }
      // v0.40 §2.1 — the merge line's TEXT, emitted by the last finisher's
      // tail when THAT finisher is this useDurableChat lane (a bypass lane's reader
      // forwards the same chunk instead). 可空: no chunk → no closing bubble.
      if (chunk.type === PARALLEL_SUMMARY_CHUNK) {
        const data = (chunk as { data?: { sliceId?: unknown; text?: unknown } }).data;
        if (typeof data?.text === "string" && data.text.trim()) {
          seatMergeLine(
            typeof data.sliceId === "string" ? data.sliceId : "",
            data.text,
          );
        }
        return;
      }
      if (chunk.type !== NESTED_BUBBLE_CHUNK) return;
      const frame = normalizeNestedBubble(
        (chunk as { data?: unknown }).data,
      );
      if (!frame) return;
      setNestedBubbles((prev) => {
        const next = new Map(prev);
        next.set(frame.turnId, frame);
        return next;
      });
    },
    // Clear a stale runId when a reconnect 404s ("Run not available") — the run
    // is gone, so a future reload shouldn't keep retrying it.
    onError: (err) => {
      console.error("[chat][stream]", formatErrorDetail(err));
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|Run not available/.test(msg)) {
        clearStoredRunId();
      }
    },
    // Flush the completed conversation the moment a turn ends, so a refresh
    // right after finishing never restores a stale copy. The debounced effect
    // below only writes after a quiet period — during continuous streaming it
    // may not have written at all, and onChatEnd clears the runId immediately,
    // so the gap between "finished" and "persisted" would otherwise lose the
    // just-finished reply.
    onFinish: ({ messages: finished }) => {
      writeStoredMessages(finished.slice(-PERSIST_MESSAGE_CAP));
      rememberNativeReplay(finished);
    },
    getRunId: readStoredRunId,
    prepareBody: (workingMessages, regenerate, screen) => {
      const view = getView?.();
      const lastUser = [...workingMessages].reverse().find((message) => message.role === "user");
      const documentContext = documentContextFromMetadata(lastUser?.metadata);
      const stagedAttachments = stagedImageReferences(messageImageAttachments(lastUser?.metadata));
      return {
        messages: messagesWithNativeReplay(workingMessages, resumeBlock?.turns ?? []).slice(-SEND_MESSAGE_WINDOW),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale,
        persona,
        loadedSliceIds: timelineSlices.map((slice) => slice.slice_id),
        ...(view ? { view } : {}),
        ...screenContextRequestField(() => screen),
        ...(documentContext.length ? { documentContext: createDocumentContextEnvelope(documentContext) } : {}),
        ...(stagedAttachments.length ? { stagedAttachments } : {}),
        ...(burstIdRef.current ? { burstId: burstIdRef.current } : {}),
        ...(regenerate ? { regenerate: true } : {}),
      };
    },
    onRunStarted: (response, chatId) => {
      const runId = response.headers.get("x-workflow-run-id");
      if (runId) {
        writeStoredRunId(runId);
        try { localStorage.setItem(CHAT_ID_KEY, chatId); } catch { /* best-effort */ }
      }
    },
    onEnd: clearStoredRunId,
  });

  // ── Persist the conversation (debounced) so a refresh restores it via
  // `initialMessages`.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    const id = setTimeout(() => {
      writeStoredMessages(messages.slice(-PERSIST_MESSAGE_CAP));
    }, 100);
    return () => clearTimeout(id);
  }, [messages]);

  const isStreaming = status === "streaming";
  const isLoading = status === "submitted" || isStreaming;
  const dialogueEnabled = dialogue.mode === "dialogue";
  const dialogueWorks = useMemo(() => [...dialogue.projection.works.values()], [dialogue.projection.works]);
  const thinking = dialogueWorks.some(work => work.status === "queued" || work.status === "running");
  const dialogueActive = dialogue.expression !== "paused" && (thinking || dialogue.expression === "running");
  const composerBusy = dialogueEnabled ? dialogueActive : isLoading;
  const dialogueRows = useMemo(() => dialogueStreamRows(dialogue.projection.entries, dialogue.projection.inputs, dialogueWorks),
    [dialogue.projection.entries, dialogue.projection.inputs, dialogueWorks]);
  const receiptCount = dialogue.projection.receiptCount;
  const observedReceipt = useRef(0);
  useEffect(() => {
    if (receiptCount <= observedReceipt.current) return;
    observedReceipt.current = receiptCount;
    onTurnSettled?.();
  }, [receiptCount, onTurnSettled]);

  // ── The post-burst fold (v0.33 §6) ───────────────────────────────────────
  // Once every lane has settled AND the main stream is idle, the burst's
  // lanes become ordinary messages — the bypass user/answer pairs and the
  // batch summary, in send order — and the lane blocks retire. From here the
  // slice and the client tell the same story again (no history-mismatch
  // rebuild on the next send), and a reload restores everything from the
  // slice. The "main" seat carries no content (its message never left the
  // list); it just retires. Idempotent via the known-id guard.
  useEffect(() => {
    if (parallelLanes.length === 0 || status !== "ready") return;
    if (!parallelLanes.every((l) => l.laneId === "main" || l.settled)) return;
    const additions: UIMessage[] = [];
    for (const lane of parallelLanes) {
      if (lane.laneId === "main") continue;
      if (!lane.summary) {
        additions.push({
          id: lane.laneId,
          role: "user",
          metadata: lane.userMessage?.metadata ?? createDocumentContextMetadata(parallelDocumentContextsRef.current.get(lane.laneId) ?? []),
          parts: lane.userMessage?.parts ?? [{ type: "text" as const, text: lane.userText }],
        });
      }
      if (lane.text) {
        additions.push({
          id: lane.summary
            ? `sum-${lane.runId ?? lane.laneId}`
            : `ans-${lane.runId ?? lane.laneId}`,
          role: "assistant",
          parts: lane.message?.parts ?? [{ type: "text" as const, text: lane.text }],
        });
      }
    }
    if (additions.length > 0) {
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const fresh = additions.filter((m) => !known.has(m.id));
        if (fresh.length === 0) return prev;
        const next = [...prev, ...fresh];
        writeStoredMessages(next.slice(-PERSIST_MESSAGE_CAP));
        return next;
      });
    }
    for (const lane of parallelLanes) parallelDocumentContextsRef.current.delete(lane.laneId);
    setParallelLanes([]);
  }, [parallelLanes, status, setMessages]);

  // Stream completion settles transient bubbles. Catalog invalidation follows
  // the summary's commit receipt through usePersistenceObserver above.
  const wasLoadingRef = useRef(false);
  /**
   * v0.42 §3 [7283] — the burst id: ONE id per parallel batch. Minted the
   * moment a send lands while another answer is still in flight; every
   * message sent during that window carries it, so the server enumerates
   * the batch's members exactly (attributes equality) instead of the legacy
   * time-window heuristic. Cleared once the air is quiet again.
   */
  const burstIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      // v0.31 — settle stranded bubbles on the episode stream's falling edge
      // (stop / error / transport death): the orchestrator is dead then, no
      // terminal frame will ever arrive, and a queued/running chip would spin
      // forever (the bubble's `active` flip also aborts its child-stream
      // reader). A clean end has every bubble terminal already — a no-op. A
      // same-session reconnect that bounced the status self-heals: the replay
      // re-delivers the running frames and the map flips back.
      setNestedBubbles((prev) => {
        let dirty = false;
        const next = new Map(prev);
        for (const [id, frame] of next) {
          if (frame.status === "queued" || frame.status === "running") {
            next.set(id, { ...frame, status: "failed" });
            dirty = true;
          }
        }
        return dirty ? next : prev;
      });
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  // Publish the in-flight state so the header can disable the settings entry
  // mid-turn (engine/model changes must not land while a call is running).
  useEffect(() => {
    setTurnBusy(composerBusy);
    return () => setTurnBusy(false);
  }, [composerBusy]);

  // ── Background-completion toast ──────────────────────────────────────────
  // A turn that finishes while the tab is backgrounded is exactly the
  // "I come after you're done" moment — nudge the user back. The turn lifecycle
  // itself renders inline in the bubble (chat-message's buildStream), so this
  // only fires the notification.
  const t = useTranslations("chat");
  const backgroundToastShownRef = useRef(false);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      backgroundToastShownRef.current = false;
    }
  }, [status]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const parts = (last.parts ?? []) as Array<{
      type?: string;
      data?: { status?: string };
    }>;
    for (const part of parts) {
      if (part.type !== "data-turn-status") continue;
      if (part.data?.status !== "done") continue;
      if (
        !backgroundToastShownRef.current &&
        typeof document !== "undefined" &&
        document.hidden
      ) {
        backgroundToastShownRef.current = true;
        toast.success(t("turnStatus.backgroundDone"));
      }
    }
  }, [messages, t]);

  // ── Evolution activity → the companion pod ─────────────────────────────
  // The pod lives in the SHELL and is now the ONLY evolution surface (M3
  // retired the chat-side EvolutionCard — the stream classifier skips
  // data-evolution parts), so the frames cross the module-level
  // evolution-activity bus instead of props. Each turn's LAST
  // data-evolution part is its current frame; the scan state identity-compares
  // against the last published frame so only NEWLY ARRIVED chunks publish.
  // Bridge brain never runs inline evolution, so nothing publishes there.
  const evolutionScanRef = useRef(createEvolutionScanState());
  useEffect(() => {
    const scan = evolutionScanRef.current;
    for (const message of messages) {
      const parts = (message.parts ?? []) as Array<{
        type?: string;
        data?: unknown;
      }>;
      let frame: EvolutionStepData | undefined;
      for (const part of parts) {
        if (part.type === "data-evolution") frame = part.data as EvolutionStepData;
      }
      if (!frame) continue;
      const event = nextEvolutionEvent(scan, message.id, frame);
      if (event) publishEvolutionActivity(event);
    }
  }, [messages]);

  // ── The stream's item model: [history slice blocks …, resume block, live] ─
  const handleRegenerate = useCallback(
    (messageId: string) => {
      if (status !== "ready") return;
      const screen = captureScreenContext(getScreenContext);
      void regenerate({ messageId }, screen);
    },
    [regenerate, status, getScreenContext],
  );

  const liveItems = useMemo<ChatStreamItem[]>(() => {
    const lastMessage = messages[messages.length - 1];
    // v0.33: while the main lane's answer streams collapsed (a burst is in
    // flight), its streaming shell leaves the list — the lane block renders
    // it instead.
    const mainSeated = parallelLanes.some((l) => l.laneId === "main");
    // Regenerate re-answers the last user message — only meaningful on the
    // LATEST assistant reply (and never mid-stream; ChatMessage also gates).
    const lastAssistantId = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.id;
    const nowIso = new Date().toISOString();
    const live = messages
      .map((message, index) => ({
        kind: "live" as const,
        // Index-suffixed key: if a reconnect ever delivers a duplicated message
        // id (the same turn written twice by concurrent streams), the key stays
        // unique — React's duplicate-key reconciliation can otherwise loop into
        // "Maximum update depth exceeded" (#185).
        key: `${message.id}-${index}`,
        message,
        // The live turns continue the active slice — its strands tint the user
        // bubbles (same source as the history turns' tint).
        strands: activeSlice?.strands,
        timeIso: nowIso,
        isStreaming: message.id === lastMessage?.id && isStreaming,
        startedAt:
          message.id === lastMessage?.id
            ? (lastUserMessageAt ?? undefined)
            : undefined,
        onRegenerate:
          message.id === lastAssistantId
            ? () => handleRegenerate(message.id)
            : undefined,
      }))
      .filter((item) => {
        // v0.33 — the collapsed main lane's streaming shell renders as its
        // lane mini-block, not here (it returns the moment the turn ends).
        if (mainSeated && item.isStreaming && item.message.role === "assistant") {
          return false;
        }
        if (item.message.role !== "assistant") return true;
        const parts = (item.message.parts ?? []) as Array<{
          type: string;
          text?: string;
          data?: unknown;
        }>;
        const hasText = parts.some(
          (p) => p.type === "text" && typeof p.text === "string" && p.text.trim(),
        );
        if (hasText) return true;
        // A terminal error/interruption must stay visible — it IS the content.
        const statusData = parts.find((p) => p.type === "data-turn-status")?.data as
          | { status?: string }
          | undefined;
        if (statusData?.status === "error" || statusData?.status === "interrupted") {
          return true;
        }
        // v0.31 — an empty assistant shell earns a seat ONLY while it is the
        // live streaming message of a turn with no bubbles yet (the classic
        // path's stage-pill affordance). The orchestrator's outer message
        // carries no text of its own (the answers are the bubbles; only the
        // optional closing summary streams there), so once a bubble frame
        // exists the shell would render as a blank beat — and a finished or
        // reloaded husk (housekeeping's `start` chunk materializes one either
        // way) has no content at all.
        return item.isStreaming && nestedBubbles.size === 0;
      });
    // v0.30 §4.3 — the merge view: the episode's side-store bubbles seat
    // after the user message each one answers (orphans after a regenerate
    // drop out rather than render unmoored).
    const merged = interleaveNestedBubbles(live, nestedBubbles);
    // v0.33 §6 — the parallel lanes seat AFTER the live thread (the burst is
    // the newest activity). The newest lane reads expanded, the rest fold to
    // mini-blocks. The main lane's seat retires the moment its stream
    // settles — the message itself renders again from then on.
    if (parallelLanes.length === 0) return merged;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const mainText = lastAssistant ? visibleAssistantText(lastAssistant) : "";
    const laneItems: ChatStreamItem[] = [];
    parallelLanes.forEach((lane, i) => {
      if (lane.laneId === "main" && !isStreaming) return;
      const laneMessage = lane.laneId === "main" ? lastAssistant : lane.message;
      const laneTurn = laneMessage ? nativeMessageTurnIdentity(laneMessage) : null;
      laneItems.push({
        kind: "parallel-lane",
        key: `pl-${lane.laneId}`,
        timeIso: nowIso,
        lane: {
          laneId: lane.laneId,
          runId: lane.runId,
          turnId: laneTurn?.turnId ?? (lane.runId ?? lane.laneId),
          slotId: lane.laneId === "main"
            ? laneMessage?.id
            : lane.runId
              ? `ans-${lane.runId}`
              : undefined,
          provisionalTurnId: laneTurn?.provisionalTurnId,
          userText: lane.userText,
          userMessage: lane.userMessage,
          summary: lane.summary,
          collapsed: i < parallelLanes.length - 1,
          text: lane.laneId === "main" ? mainText : lane.text,
          settled: lane.laneId === "main" ? !isStreaming : lane.settled,
        },
      });
    });
    return [...merged, ...laneItems];
  }, [messages, isStreaming, lastUserMessageAt, handleRegenerate, activeSlice, nestedBubbles, parallelLanes]);

  // ── Arrival forms (v0.10 §1.2 Rev 2, re-seated with the two-rungs rewrite):
  // the PANEL is the in-memory current conversation — plus, on a briefing
  // arrival, the cold-open page of history with the EmptyBriefing card seated
  // as a stream item between the two (the field that used to host the card
  // retired with the rung ladder). Resume mode restores the alive slice's
  // turns under a banner HERE. The standalone full-screen briefing survives
  // ONLY for an empty memory (not one slice), known once the episodic state
  // settles.
  const emptyMemory = dialogueEnabled ? dialogue.historyReady && !dialogue.historyFailed &&
    arrival.mode === "briefing" && !dialogue.historyWindow?.previous.length && dialogueRows.items.length === 0 :
    arrival.mode === "briefing" &&
    episodicReady &&
    timelineSlices.length === 0 &&
    !episodicHasMore &&
    messages.length === 0 && dialogueRows.items.length === 0;
  const showBriefingCard = !dialogueEnabled && arrival.mode === "briefing" && !emptyMemory;

  // ── Arrival skeleton cover ─────────────────────────────────────────────
  // Until the mount fetches settle (the episodic state), an isomorphic
  // skeleton covers the pane and crossfades out — the
  // restored turns / the empty state replace it without a hard cut. A hard
  // backstop lifts the cover even if a fetch hangs forever.
  const reducedMotion = useReducedMotion() ?? false;
  const [skeletonBackstop, setSkeletonBackstop] = useState(false);
  const arrivalReady = episodicReady;
  useEffect(() => {
    if (arrivalReady) return;
    const id = setTimeout(() => setSkeletonBackstop(true), 12_000);
    return () => clearTimeout(id);
  }, [arrivalReady]);
  const showArrivalSkeleton = !dialogueEnabled && !arrivalReady && !skeletonBackstop;

  // One preceding record. V2 receives it atomically with its arrival snapshot;
  // the legacy client uses the same exclusive one-slice read.
  const [legacyHistory, setLegacyHistory] = useState<SliceWithContent[] | null>(
    null,
  );
  const briefingSlices = dialogueEnabled ? dialogue.historyWindow?.previous ?? null : legacyHistory;
  useEffect(() => {
    if (dialogueEnabled) return;
    let cancelled = false;
    getSlicePageWithContent(arrival.mode === "resume" ? arrival.sliceId : null, 1, persona)
      .then((page) => {
        if (!cancelled) setLegacyHistory(page.slices);
      })
      .catch(() => {
        if (!cancelled) setLegacyHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [arrival, dialogueEnabled, persona]);

  // THE PANEL'S ITEMS (2026-10-04; the briefing card re-seated HERE with the
  // two-rungs rewrite — the field that hosted it is gone): the cold-open page
  // of repository history on a briefing arrival, the briefing card as a
  // stream item between history and the live edge, the arrival-restored
  // resume block, and the live `useDurableChat` messages.
  const [briefingTimeIso] = useState(() => new Date().toISOString());
  const items = useMemo<ChatStreamItem[]>(() => {
    const history = unrepresentedHistory(buildHistoryItems(briefingSlices ?? [], resumeBlock), messages, dialogue.projection.entries);
    const card: ChatStreamItem[] = showBriefingCard
      ? [{ kind: "briefing", key: "briefing", timeIso: briefingTimeIso }]
      : [];
    const combined = [
      ...history,
      ...card,
      ...liveItems,
      ...dialogueRows.items,
    ];
    return dialogueEnabled ? orderDialogueItems(combined) : combined;
  }, [briefingSlices, resumeBlock, liveItems, messages, showBriefingCard, briefingTimeIso, dialogueRows.items, dialogue.projection.entries, dialogueEnabled]);

  /**
   * Run `fn` against the list's handle as soon as it exists.
   *
   * The list mounts BELOW this component and fills its handle from an effect,
   * so a jump that fires during the mount sequence — and `?at=` is consumed
   * exactly then — would find nothing. Retrying is bounded, so a genuinely
   * absent list gives up rather than spinning. `scrollToKey` needs no retry
   * of its own: it remembers an unloaded target and lands when it arrives.
   */
  const withStream = useCallback(
    (fn: (api: ChatStreamHandle) => void, frames = 120) => {
      const attempt = (left: number) => {
        const api = streamApiRef.current;
        if (api) {
          fn(api);
          return;
        }
        if (left <= 0) return;
        requestAnimationFrame(() => attempt(left - 1));
      };
      attempt(frames);
    },
    [],
  );

  const scrollToBottom = useCallback(() => {
    withStream((api) => api.scrollToBottom());
  }, [withStream]);

  const handleSubmit = async (message: string, images: File[], attachments: readonly ImageAttachmentSnapshot[] = [], messageId?: string) => {
    const documentContext = getSnapshot();
    const metadata = { ...createDocumentContextMetadata(documentContext), ...(attachments.length ? { attachments } : {}) };
    const stagedAttachments = stagedImageReferences(attachments);
    const screen = captureScreenContext(getScreenContext);
    // Sending snaps back to the present: the jump target is cleared and the
    // stream follows the new turn to the bottom.
    setSelectedSliceId("now");
    setTransition(null);
    setLastUserMessageAt(new Date().toISOString());

    if (dialogueEnabled) {
      const view = getView?.();
      const parts: UIMessage["parts"] = await Promise.all(images.map(async file => ({
        type: "file" as const, mediaType: file.type, filename: file.name, url: await fileToDataUrl(file),
      })));
      if (message) parts.push({ type: "text", text: message });
      try {
        await dialogue.submit({
          messages: [{ id: messageId ?? mintTurnId(), role: "user", parts, metadata }], locale,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(view ? { view } : {}), ...screenContextRequestField(() => screen),
          ...(documentContext.length ? { documentContext: createDocumentContextEnvelope(documentContext) } : {}),
          ...(stagedAttachments.length ? { stagedAttachments } : {}),
        });
        clearReferences(documentContext);
        requestAnimationFrame(scrollToBottom);
        return;
      } catch (failure) {
        if (!(failure instanceof DialogueDisabled)) throw failure;
        // Only the explicit, unaccepted compatibility response allows the
        // old transport. An outage cannot create a second worker.
      }
    }

    // ── The burst identity (v0.42 §3 [7283]): EVERY send carries one — the
    // first message mints it, a send landing while an answer is still in
    // flight (the main stream OR an unsettled bypass lane) reuses it, and a
    // send after the air went quiet mints a new one. The first message must
    // carry the id too: the last finisher enumerates its batch members by
    // exact id, so a first send without one is invisible to that enumeration
    // and its record would never land (a solo batch is simply a batch of one
    // — the server's lastness predicate returns true for it).
    const inFlight =
      isLoading || parallelLanes.some((lane) => !lane.settled);
    if (!inFlight || !burstIdRef.current) {
      burstIdRef.current = crypto.randomUUID();
    }
    const burstId = burstIdRef.current;

    // ── Parallel sends (v0.33 §6): a send while a turn streams starts
    // ANOTHER standard run with its own reader. The lane echoes the user text immediately, the new
    // run's runId arrives in the response header, and the lane reader streams
    // the answer off the durable stream. The say-into-episode route this
    // replaces never answered (episodeEnabled is off) — the red line is "no
    // send lands unanswered", and a fresh run always answers.
    if (isLoading) {
      const fileParts = await Promise.all(
        images.map(async (file) => ({
          type: "file" as const,
          mediaType: file.type,
          filename: file.name,
          url: await fileToDataUrl(file),
        })),
      );
      const parts: UIMessage["parts"] = [
        ...fileParts,
        ...(message ? [{ type: "text" as const, text: message }] : []),
      ];
      const clientId = messageId ?? mintTurnId();
      const userMsg: UIMessage = {
        id: clientId,
        role: "user",
        parts,
        metadata,
      };
      parallelDocumentContextsRef.current.set(clientId, documentContext);
      // Seat the collapsed main lane first (the in-flight answer folds into a
      // mini-block — nothing is lost: it re-seats as a normal message when
      // its turn ends), then the new bypass lane.
      setParallelLanes((prev) => [
        ...(prev.some((l) => l.laneId === "main")
          ? []
          : ([{ laneId: "main", userText: "", text: "", settled: false }] as ParallelLane[])),
        ...prev,
        { laneId: clientId, userText: message, userMessage: userMsg, text: "", settled: false },
      ]);
      const view = getView?.();
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Same window + fields the transport sends (see
            // prepareSendMessagesRequest) plus the new message.
            messages: [...messagesWithNativeReplay(messages, resumeBlock?.turns ?? []).slice(-SEND_MESSAGE_WINDOW), userMsg],
            timezone:
              typeof Intl !== "undefined"
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : "UTC",
            locale,
            persona,
            loadedSliceIds: timelineSlices.map((s) => s.slice_id),
            ...(view ? { view } : {}),
            ...screenContextRequestField(() => screen),
            ...(documentContext.length ? { documentContext: createDocumentContextEnvelope(documentContext) } : {}),
            ...(stagedAttachments.length ? { stagedAttachments } : {}),
            ...(burstId ? { burstId } : {}),
          }),
        });
        const runId = res.headers.get("x-workflow-run-id");
        if (!res.ok || !runId) {
          throw new Error(`parallel send HTTP ${res.status}`);
        }
        clearReferences(documentContext);
        rememberTurnRun(runId);
        // The lane reads via the reconnect route — this response's body is
        // only the first attachment onto the same durable stream.
        await res.body?.cancel().catch(() => {});
        patchParallelLane(clientId, { runId });
      } catch (err) {
        parallelDocumentContextsRef.current.delete(clientId);
        console.error("[chat] parallel send failed:", err);
        setParallelLanes((prev) => prev.filter((l) => l.laneId !== clientId));
        toast.error(t("parallel.sendFailed"));
        throw err;
      }
      requestAnimationFrame(scrollToBottom);
      return;
    }

    // Images travel as project-owned file parts (data URLs) — convertToModelMessages
    // on the server maps them to the provider's image inputs. The files are
    // already downscaled/re-encoded by use-image-attachments.
    const fileParts = await Promise.all(
      images.map(async (file) => ({
        type: "file" as const,
        mediaType: file.type,
        filename: file.name,
        url: await fileToDataUrl(file),
      })),
    );
    const parts: UIMessage["parts"] = [
      ...fileParts,
      ...(message ? [{ type: "text" as const, text: message }] : []),
    ];
    await new Promise<void>((resolve, reject) => {
      void sendMessage({ id: messageId, role: "user", parts, metadata }, screen, { accepted: resolve, rejected: reject });
    });
    clearReferences(documentContext);
    requestAnimationFrame(scrollToBottom);
    // v0.7b: self-evolution runs INLINE inside housekeeping (the turn's stream
    // carries data-evolution chunks) — no separate evolution request here.
    // v0.9: buildStream folds those chunks into the housekeeping card, so the
    // CHAT UI needs no evolution-specific state; the companion pod reads the
    // same frames off the evolution-activity bus (see the effect below).
  };

  const regeneration = useRef<{ inputId: string; requestId: string; pending: boolean } | undefined>(undefined);
  const regenerateDialogue = async (inputId: string) => {
    const input = dialogue.projection.inputs.get(inputId);
    if (!input) {
      toast.error(tDialogue("regenerateFailed"));
      return;
    }
    if (regeneration.current?.inputId !== inputId) regeneration.current = { inputId, requestId: crypto.randomUUID(), pending: false };
    const request = regeneration.current;
    if (request.pending) return;
    request.pending = true;
    try {
      await dialogue.submit(buildDialogueRegenerationRequest(input, request.requestId, {
        locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      if (regeneration.current === request) regeneration.current = undefined;
      requestAnimationFrame(scrollToBottom);
    } catch {
      toast.error(tDialogue("regenerateFailed"));
    } finally {
      request.pending = false;
    }
  };

  // ── Stop means STOP: abort the local stream, cancel the durable run
  // server-side (no further steps, no recorded agent reply — the slice keeps
  // the already-persisted user turn, "a question without an answer"), drop
  // the stored run id so a reload never resurrects a turn the user cut off
  // (onChatEnd only fires on a finish chunk, which an abort never receives),
  // and report the interruption as a fitness signal. All best-effort.
  const handleStop = useCallback(() => {
    const runId = readStoredRunId();
    void stop();
    clearStoredRunId();
    if (runId) {
      fetch(`/api/chat/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {
        /* best-effort — the local abort already stopped the UI */
      });
    }
    fetch("/api/episodic/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "interaction_interrupt" }),
      keepalive: true,
    }).catch(() => {
      /* instrumentation — never surface */
    });
  }, [stop]);

  // The unified stream replaced the separate historical view (v0.10 §1): a
  // slice jump (search palette, references bar, `?at=`) pages the target slice
  // into the stream (the time-travel clock covers the loading) and
  // scroll-lands on its seam. "now" lands at the bottom.

  // The travel clock's TARGET time: producers that know the slice's start
  // pass it as `toTime` (the timeline card click threads it through
  // `?atStart=`), everyone else resolves it — the recent-summaries catalog,
  // the resume block, else one catalog fetch. (The loaded stream window used
  // to answer too; the panel no longer holds one — the field owns the
  // repository's slices.)
  // Unknown target → the clock just holds (to = from).
  const resolveSliceStart = useCallback(
    async (sliceId: string): Promise<string | null> => {
      const known = timelineSlices.find((s) => s.slice_id === sliceId)?.start;
      if (known) return known;
      if (resumeBlock?.sliceId === sliceId) return resumeBlock.start;
      try {
        // One slice's start, not the whole catalog: this used to fetch every
        // entry (tags, open loops, summaries) over the wire to read one field.
        return await getSliceStart(sliceId);
      } catch {
        return null;
      }
    },
    [timelineSlices, resumeBlock],
  );

  // The panel's tier, hoisted above the jump path: a jump to a past slice
  // RISES the pill to fullscreen, because the target lives in this list and
  // the reader should land looking at it. Rising is an /app-only move — the
  // overlay-mount gate force-folds fullscreen on utility routes.
  const panelTier = usePanelTier();
  const openDesk = useShell().openDesk;
  const pathname = usePathname();
  const onApp = pathname === "/app";

  // An EMPTY memory's arrival face is the standalone full-screen briefing —
  // the first-install ruling (首装仍落对话): the panel RISES once, on /app,
  // when the verdict lands. Ref-guarded: a reader who folds it afterwards is
  // left alone.
  const emptyRisenRef = useRef(false);
  useEffect(() => {
    if (!emptyMemory || !onApp || emptyRisenRef.current) return;
    emptyRisenRef.current = true;
    panelTier?.setMode("fullscreen");
  }, [emptyMemory, onApp, panelTier]);

  const handleSelectSlice = useCallback(
    async (sliceId: string, toTime?: string, targetOptions?: DeskOpenOptions) => {
      if (sliceId === selectedSliceId && !transition) return;

      const nowIso = new Date().toISOString();
      const from = topTimeRef.current ?? nowIso;
      const to = toTime ??
        (sliceId === "now" ? nowIso : ((await resolveSliceStart(sliceId)) ?? from));
      const clockLanded = new Promise<void>((resolve) => {
        clockLandedRef.current = resolve;
      });
      setTransition({ from, to, sliceId });

      if (sliceId !== "now" && panelTier?.mode === "pill") {
        panelTier.requestMode("fullscreen", "jump");
      }

      await clockLanded;
      setTransition(null);
      setSelectedSliceId(sliceId);

      requestAnimationFrame(() => {
        if (sliceId === "now") {
          scrollToBottom();
          return;
        }
        withStream((api) => {
          const found = api.scrollToKey("seam-" + sliceId);
          if (found) return;
          const pagePending = arrival.mode === "briefing" && briefingSlices === null;
          if (!pagePending) openDesk(`records/${sliceId}`, "manual", targetOptions);
        });
      });
    },
    [
      selectedSliceId,
      transition,
      panelTier,
      openDesk,
      scrollToBottom,
      withStream,
      resolveSliceStart,
      arrival.mode,
      briefingSlices,
    ],
  );

  // M2 jump bus: the search palette and the recall references bar request a
  // stream jump through the module-level slice-jump bus (or via `?at=`,
  // below) — the handler is the same select path (rise the panel + the
  // travel clock as the loading state + scroll-to-seam). A jump stashed
  // while the chat page wasn't mounted replays once, on registration.
  useEffect(() => {
    const unregister = registerSliceJumpHandler((sliceId, start) => {
      void handleSelectSlice(sliceId, start);
    });
    const stashed = takePendingSliceJump();
    if (stashed) void handleSelectSlice(stashed.sliceId, stashed.start);
    return unregister;
  }, [handleSelectSlice]);

  // `?at=<sliceId>&atStart=<iso>` — a shared link's conversation deep link.
  // The chat page stays MOUNTED at the layout (v0.13 §3.1: the overlay
  // survives navigation and world switches), so this must react to
  // searchParam changes, not just the initial mount. Consumed once: the
  // params are stripped (replaceState, no navigation) so a refresh or a
  // re-render never re-fires the jump. `atStart` is the target slice's ISO
  // start — passing it as the clock's `to` skips the catalog fetch
  // resolveSliceStart would otherwise need.
  const searchParams = useSearchParams();
  useEffect(() => {
    const at = parseAtParam(searchParams.toString());
    if (!at) return;
    const atStart = parseAtStartParam(searchParams.toString());
    window.history.replaceState(
      null,
      "",
      window.location.pathname + stripAtParam(searchParams.toString()) + window.location.hash,
    );
    void handleSelectSlice(at, atStart ?? undefined);
  }, [searchParams, handleSelectSlice]);

  // The slice at the top of the viewport. The TIME half is all that is left
  // of it: the travel clock reads `topTimeRef` for the "from" end of its
  // interval.
  const handleTopItemChange = useCallback((iso: string, _sliceId: string | null) => {
    topTimeRef.current = iso;
  }, []);

  // The "PREVIOUSLY ON" eyebrow over the travel readout — same brand mark as
  // the empty briefing's title card.
  const tBrief = useTranslations("emptyBriefing");

  // ── The pill's subtitle line (v0.13 §4, re-contracted 2026-10-04) ───────
  // The subtitle captions WHAT THE AGENT IS DOING — discrete activity blocks
  // (thinking / searching / recalling / …), each replacing the last — never
  // the reply's text. Sources are the LIVE turn only (history is happened
  // time), and the line is published only while a turn is actually in
  // flight: the gate is what makes stop / error / idle drop the caption
  // immediately (the reducer's own `done` detection covers the clean finish,
  // where the last activity would otherwise linger one commit).
  useEffect(() => {
    onSubtitleLineChange?.(
      dialogueEnabled ? (dialogueActive ? { activity: dialogue.expression === "running" ? "replying" : "thinking", count: 0 } : null)
        : isLoading ? foldSubtitleLineLatest(subtitleSourcesOf(items)) : null,
    );
  }, [items, isLoading, dialogueEnabled, dialogueActive, dialogue.expression, onSubtitleLineChange]);

  // The panel tier this page is hosted at (null only outside a panel): at
  // the pill tier the conversation body is folded away and the stream goes
  // inert with it — the list applies that guard to its content, leaving the
  // single composer interactive at both tiers.
  const panelPill = panelTier?.mode === "pill";

  // Route policy owns send expansion; game and reader mini composers stay mini.
  const submitAndRise = (...args: Parameters<typeof handleSubmit>) => {
    if (panelTier?.mode === "pill") panelTier.requestMode("fullscreen", "send");
    return handleSubmit(...args);
  };

  return (
    <>
      {/* ── Content — the conversation's own column, inside the panel body
           (the panel itself hangs at the layout — v0.13 §3.1; the app shell
           owns the world canvas, this component owns only the conversation).
           The stream is always mounted (§1.2 Rev 2) — briefing mode rides it
           as a card item; only an EMPTY memory falls back to the full-screen
           empty briefing.

           THE COLUMN RESERVES NOTHING, and that is the point. It used to carry
           `pt-24 pb-36` as the chrome's and the composer's keep-out, which read
           as a reserve and behaved as a CROP: this box is `overflow-hidden`, so
           a padding here shrinks the viewport and cuts the content off at that
           edge — pixels the reader can never scroll to, because they are
           outside the field rather than merely behind a control. The room now
           comes off the CONTENT's own extent instead (the scroller's padding
           below), so the list fills the pane and content passes under the
           floating chrome on its way past it. ── */}
      <div
        className={`${panelPill ? "" : "relative"} flex-1 overflow-hidden`}
      >
        <DomChatList
          items={items}
          onTopItemChange={handleTopItemChange}
          error={error}
          // The FOLDED tier is not a surface: a zero-height body publishing
          // progress and anchors for a conversation nobody can see is a lie
          // the band cannot tell from a still one.
          feed={feed}
          publishing={publishing && !panelPill}
          apiRef={streamApiRef}
          insetTop={insetTop}
          insetBottom={insetBottom}
          contentInert={panelPill}
          floatingComposer={panelPill}
          dialogueUtterances={dialogueEnabled ? dialogueRows.utterances : undefined}
          renderDialogueWork={item => {
            const seat = dialogueRows.workSeats.get(item.key);
            return seat ? <DialogueWorkTurn seat={seat} persona={persona} onCancel={dialogue.stop}
              onRetry={regenerateDialogue} onResume={dialogue.resume} /> : null;
          }}
          dialogueRegenerate={dialogueEnabled && !composerBusy ? regenerateDialogue : undefined}
          newPublications={dialogue.newPublications}
          emptyState={dialogueEnabled && !dialogue.historyReady && !items.length ? (
            <p role="status" className="py-6 text-sm text-muted-foreground">{tDialogue("loadingHistory")}</p>
          ) : dialogueEnabled && dialogue.historyFailed && !items.length ? (
            <p role="status" className="py-6 text-sm text-muted-foreground">{tDialogue("historyUnavailable")}</p>
          ) : emptyMemory ? (
            <EmptyBriefing
              persona={persona}
              identity={identity}
              active={activeSlice}
              recent={timelineSlices}
              onSend={(msg) => void handleSubmit(msg, [])}
            />
          ) : undefined}
          composer={
            <ComposerHost
              onClearanceChange={onComposerClearanceChange}
              composer={<>
                {dialogueEnabled && dialogue.submission.phase === "failed" && <p role="alert" className="text-sm text-destructive">{tDialogue("submitFailedHelp")}</p>}
                <ChatInput onSubmit={submitAndRise} isLoading={composerBusy}
                  stopLabel={dialogueEnabled ? tDialogue("stopExpression") : undefined}
                  onStop={dialogueEnabled ? () => { void dialogue.stop().catch(() => toast.error(tDialogue("stopFailed"))); } : handleStop} />
              </>}
            />
          }
          briefing={
            showBriefingCard
              ? {
                  persona,
                  identity,
                  active: activeSlice,
                  recent: timelineSlices,
                  onSend: (msg) => void handleSubmit(msg, []),
                }
              : null
          }
        />

        {/* ── Time-travel cover — an overlay ABOVE the stream (the list
             never unmounts, so the scroll position and the jump target
             survive the trip). Doubles as the page-loading state. ── */}
        <AnimatePresence>
          {transition && (
            <motion.div
              key="travel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-background"
            >
              {/* The slice-card face — the same ring/hairline/serif language
                  as the timeline's FrameCard and the briefing card, so the
                  travel "moment" reads as one product. */}
              <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
                />
                <div className="relative flex flex-col items-center px-6 py-8">
                  <div className="flex w-full items-center gap-2 self-stretch text-[0.65rem] leading-none tracking-[0.08em] text-muted-foreground">
                    <span
                      aria-hidden
                      className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary"
                    />
                    <span className="font-mono uppercase tracking-[0.35em]">
                      {tBrief("eyebrowWithName", { name: identity?.name || tBrief("fallbackName") })}
                    </span>
                  </div>
                  <div
                    aria-hidden
                    className="mt-4 h-px w-full self-stretch bg-foreground/[0.07]"
                  />
                  <RelativeTimeReadout
                    timestamp={transition.to}
                    from={transition.from}
                    onRollComplete={() => clockLandedRef.current?.()}
                    className="mt-8"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Arrival skeleton cover — same seat as the travel clock: an
             isomorphic skeleton (seams, bubble pairs, the briefing card
             face) over the pane while the mount fetches are in flight,
             crossfading out as the real stream takes over. ── */}
        <AnimatePresence>
          {showArrivalSkeleton && (
            <motion.div
              key="arrival-skeleton"
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.3 }}
              className="absolute inset-0 z-10 overflow-hidden bg-background"
            >
              <ChatStreamSkeleton
                tail={arrival.mode === "briefing" ? "briefing" : "rounds"}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

    </>
  );
}
