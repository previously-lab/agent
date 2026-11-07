"use client";

import { memo, useMemo, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { UIMessage } from "@/lib/chat/protocol";
import { nativeMessageTurnIdentity, visibleAssistantText } from "@/lib/chat/assistant-text";
import { parseNativeSections } from "@/lib/markdown/native-sections";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { MarkdownRenderer } from "./markdown";
import { ThinkingSteps } from "./thinking";
import { PhaseIndicator } from "./phase-indicator";
import { HousekeepingCard } from "./housekeeping-card";
import { RecallReferencesBar } from "./recall-references-bar";
import { MessageActions } from "./message-actions";
import { ToolRenderer } from "./tool-renderer";
import { ConversationTurn } from "./conversation-turn";
import { ConversationImageBody } from "./conversation-images";
import { messageImageAttachments } from "@/lib/chat/image-attachment-message";
import { SubmittedDocumentReferencesFromMetadata } from "@/components/documents/submitted-document-references";
import { TimeDisplay, sameDay } from "./time-display";
import {
  Activity,
  AlertTriangle,
  Paperclip,
  XCircle,
} from "lucide-react";
import type { ToolRenderState } from "@/lib/chat/tool-state";
import {
  buildStream,
  deriveAgentStage,
  type AnyPart,
  type StreamItem,
  type AgentStage,
} from "@/lib/chat/build-stream";

interface ChatMessageProps {
  message: UIMessage;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  startedAt?: string;
  /**
   * @deprecated Retired with the strand layer (§A.2.4) — accepted (the
   * older callers still pass it) and ignored. Both voices now share the
   * manuscript's neutral prose surface.
   */
  strands?: string[];
}

// ── i18n key lookup for the live agent-stage pill ───────────────────────

const STAGE_KEYS: Record<AgentStage, string> = {
  recalling: "stageRecalling",
  reasoning: "stageReasoning",
  working: "stageWorking",
  composing: "stageComposing",
};

/** How long without a new stream part before the "still working" nudge shows. */
const SILENT_MS = 10000;

// ── Unified stream: walk parts in natural order ────────────────────────

/**
 * Maps a running-phase i18n key to its done-state key. `slicing` is kept for
 * backward compatibility with messages streamed before the housekeeping phases
 * were granularized; the current phases (slice/tags/context) merge into
 * the HousekeepingCard instead. The retired "strands" phase maps to no done
 * key — old streams fall back to their running label.
 */
const PHASE_DONE_KEYS: Record<string, string> = {
  slicing: "sliced",
  slice: "sliced",
  tags: "tagged",
  context: "contextLoaded",
};

// ── Stable PhaseIndicator props ──────────────────────────────────────────
// Module-level constants so the stream items don't allocate a fresh state
// object / JSX element on every render. Stable references let any future
// memoization of these items actually bail, and reduce churn during the
// reconnect replay burst (one render per replayed chunk).

const PHASE_RUNNING_STATE: ToolRenderState = {
  running: true,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const PHASE_DONE_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const TERMINAL_ERROR_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const TERMINAL_INTERRUPTED_STATE: ToolRenderState = {
  running: false,
  inputStreaming: false,
  interrupted: true,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

const PHASE_ICON = <Activity className="h-3.5 w-3.5" />;
const TERMINAL_ERROR_ICON = <XCircle className="h-3.5 w-3.5 text-red-500" />;
const TERMINAL_INTERRUPTED_ICON = (
  <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
);

/** Stable key for a stream item — used by AnimatePresence for enter/exit animation. */
function itemKey(item: StreamItem, index: number): string {
  switch (item.kind) {
    case "reasoning":
      return `reasoning-${index}`;
    case "text":
      return `text-${index}`;
    case "tool":
      return `tool-${item.toolCallId}`;
    case "housekeeping":
      return `housekeeping-${index}`;
    case "phase":
      return `phase-${item.phase}-${index}`;
    case "recall-references":
      return `recall-references-${index}`;
  }
}

function isWorkProcessItem(item: StreamItem): boolean {
  return item.kind === "reasoning" || item.kind === "tool" || item.kind === "housekeeping" ||
    (item.kind === "phase" && item.mode !== "terminal");
}

export const ChatMessage = memo(function ChatMessage({
  message,
  onRegenerate,
  isStreaming,
  startedAt,
}: ChatMessageProps) {
  const t = useTranslations("chat.phase");
  const tChat = useTranslations("chat");
  const reducedMotion = useReducedMotion() ?? false;
  const isAssistant = message.role === "assistant";
  const parts = useMemo(
    () => (message.parts ?? []) as AnyPart[],
    [message.parts],
  );
  const nativeTurn = nativeMessageTurnIdentity(message);

  const streamItems = useMemo(
    () => (isAssistant ? buildStream(parts, isStreaming ?? false) : []),
    [parts, isAssistant, isStreaming],
  );
  const lastTextDone = useMemo(() => {
    for (let index = parts.length - 1; index >= 0; index--) {
      if (parts[index].type === "text") return parts[index].state === "done";
    }
    return false;
  }, [parts]);
  const nativeOffsets = useMemo(() => {
    let count = 0;
    return streamItems.map((item) => {
      const offset = count;
      if (item.kind === "text") {
        count += parseNativeSections(item.content).filter((section) => section.kind === "native").length;
      }
      return offset;
    });
  }, [streamItems]);
  const workProcessItems = streamItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isWorkProcessItem(item));
  const publicItems = streamItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !isWorkProcessItem(item));

  // ── Live agent-stage pill ─────────────────────────────────────────────
  // Derives what the agent is doing right now (recalling / reasoning /
  // working / composing) from the part stream; shown only while streaming.
  const stage = useMemo(
    () => (isAssistant ? deriveAgentStage(parts) : null),
    [parts, isAssistant],
  );

  // ── Silence heartbeat ─────────────────────────────────────────────────
  // If the stream stalls (no new part for SILENT_MS), surface a "still
  // working" nudge so a long step never reads as dead. Client-only; the
  // server never needs to know.
  const lastPartsRef = useRef(Date.now());
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    lastPartsRef.current = Date.now();
    // Functional form so a `false` state is a no-op: during a reconnect replay
    // this effect fires once per replayed chunk, and redundant setState calls
    // would pile onto an already-heavy render burst.
    setSilent((s) => (s ? false : s));
  }, [message.parts]);

  useEffect(() => {
    if (!isAssistant || !isStreaming) return;
    const id = window.setInterval(() => {
      setSilent(Date.now() - lastPartsRef.current > SILENT_MS);
    }, 2000);
    return () => window.clearInterval(id);
  }, [isAssistant, isStreaming]);

  // Full text for footer / actions
  const textContent = isAssistant ? visibleAssistantText(message) : "";

  const hasContent = streamItems.length > 0;
  const timestamp = startedAt ? (
    <TimeDisplay timestamp={startedAt} mode={sameDay(startedAt) ? "time" : "full"} />
  ) : undefined;

  // ── User message ──────────────────────────────────────────────────
  if (!isAssistant) {
    const userText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    // File parts (attachments): images render inline from their data URL;
    // anything else collapses to a small file chip.
    const fileParts = parts.filter((p) => p.type === "file" && p.url);
    const images = messageImageAttachments(message.metadata);
    return (
      <ConversationTurn role={message.role} metadata={timestamp}>
        {fileParts.length > 0 && (
          <div className="conversation-attachments">
            {fileParts.map((p, i) =>
              p.mediaType?.startsWith("image/") ? (
                <img
                  key={i}
                  src={p.url}
                  alt={p.filename ?? tChat("attachment")}
                  className="conversation-image"
                  data-rich-block="image"
                />
              ) : (
                <span
                  key={i}
                  className="conversation-file"
                  data-rich-block="attachment"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {p.filename ?? tChat("attachment")}
                </span>
              ),
            )}
          </div>
        )}
        <SubmittedDocumentReferencesFromMetadata metadata={message.metadata} />
        <ConversationImageBody content={userText} images={images} />
      </ConversationTurn>
    );
  }

  const renderStreamItem = (item: StreamItem, i: number) => {
    const key = itemKey(item, i);
    if (item.kind === "reasoning") {
      return <ThinkingSteps key={key} text={item.text}
        isStreaming={isStreaming && i === streamItems.length - 1} />;
    }
    if (item.kind === "tool") {
      return <ToolRenderer key={key} toolName={item.toolName} state={item.state}
        input={item.input} output={item.output} streamingText={item.streamingText}
        streamingStage={item.streamingStage} isStreaming={isStreaming ?? false} />;
    }
    if (item.kind === "housekeeping") return <HousekeepingCard key={key} steps={item.steps} />;
    if (item.kind === "phase") {
      if (item.mode === "terminal") {
        const isInterrupted = item.phase.includes("interrupted");
        const detail = (item.summaries ?? []).join("\n");
        return <PhaseIndicator key={key} mode="static"
          icon={isInterrupted ? TERMINAL_INTERRUPTED_ICON : TERMINAL_ERROR_ICON}
          label={isInterrupted ? t("turnInterrupted") : t("turnError")}
          state={isInterrupted ? TERMINAL_INTERRUPTED_STATE : TERMINAL_ERROR_STATE}
          summary={detail ? detail.split("\n")[0] : undefined}
          expandedContent={detail ? <p className="whitespace-pre-wrap">{detail}</p> : undefined} />;
      }
      const doneKey = PHASE_DONE_KEYS[item.phase];
      const label = item.running ? t(item.phase) : doneKey ? t(doneKey) : t(item.phase);
      const hasSummaries = item.summaries && item.summaries.length > 0;
      return <PhaseIndicator key={key} mode="static" icon={PHASE_ICON} label={label}
        state={item.running ? PHASE_RUNNING_STATE : PHASE_DONE_STATE}
        expandedContent={hasSummaries ? <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          {item.summaries!.map((summary, index) => <div key={index}>{summary}</div>)}
        </div> : undefined} />;
    }
    if (item.kind === "recall-references") {
      return <RecallReferencesBar key={key} references={item.references} />;
    }
    return <motion.div key={key} initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.15 }}
      className="conversation-prose">
      <MarkdownRenderer content={item.content}
        isStreaming={isStreaming && i === streamItems.length - 1 && !lastTextDone}
        nativeMode="interactive" nativeTurnId={nativeTurn.turnId} nativeSlotId={message.id}
        nativeProvisionalTurnId={nativeTurn.provisionalTurnId} nativeOrdinalOffset={nativeOffsets[i]}
        onNativeRetry={onRegenerate} />
    </motion.div>;
  };

  // Internal work is available on demand without interrupting the public reply.
  return (
    <ConversationTurn role={message.role} metadata={timestamp}>
      {/* Live agent-stage pill — a small brand marker of what the agent is doing */}
      {isStreaming && stage && (
        <div className="conversation-stage">
          <span className="size-1.5 animate-pulse rounded-full bg-brand-500" />
          {silent ? t("stillWorking") : t(STAGE_KEYS[stage])}
        </div>
      )}

      {hasContent && (
        <div className="conversation-stream-parts">
          <AnimatePresence>
            {workProcessItems.length > 0 && <details className="conversation-work-process">
              <summary>{t("workProcess")}</summary>
              <div className="conversation-work-process-items">
                {workProcessItems.map(({ item, index }) => renderStreamItem(item, index))}
              </div>
            </details>}
            {publicItems.map(({ item, index }) => renderStreamItem(item, index))}
          </AnimatePresence>
        </div>
      )}

      {/* Generic loading tips stay retired; MarkdownRenderer owns the quiet
          stream caret and each native block's preparing/fallback state. */}

      {/* Silence heartbeat — only when the stream has gone quiet mid-turn */}
      {isStreaming && silent && !stage && (
        <div className="conversation-heartbeat">
          <span className="size-1.5 animate-pulse rounded-full bg-brand-500/70" />
          {t("stillWorking")}
        </div>
      )}

      {publicItems.some(({ item }) => item.kind === "phase" && item.mode === "terminal") &&
        !textContent && !isStreaming && onRegenerate && <button type="button"
          className="conversation-terminal-retry" onClick={onRegenerate}>{tChat("dialogue.retry")}</button>}

      {/* Footer — actions only */}
      {isAssistant && textContent && !isStreaming && onRegenerate && (
        <MessageActions content={textContent} onRegenerate={onRegenerate} />
      )}
    </ConversationTurn>
  );
});
