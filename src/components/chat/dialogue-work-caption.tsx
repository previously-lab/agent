"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, CirclePause } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isMemoryReadTool } from "@/lib/chat/build-stream";
import type { DialogueWorkView } from "./dialogue-projection";
import {
  useDialogueWorkStream,
  type DialogueWorkStreamView,
  type DialogueWorkToolView,
} from "./dialogue-work-stream";
import { MarkdownRenderer } from "./markdown";

export type DialogueWorkCaptionStatus =
  | "thinking"
  | "recalling"
  | "searching"
  | "reading"
  | "working"
  | "replying"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconnecting"
  | "disconnected"
  | "unavailable";

function toolActivity(tool: DialogueWorkToolView | undefined): DialogueWorkCaptionStatus {
  if (!tool || tool.status !== "running") return "thinking";
  if (isMemoryReadTool(tool.name)) return "recalling";
  if (tool.name === "webResearch" || tool.name === "webSearch" || tool.name === "webFetch") return "searching";
  if (tool.name === "thinkDeep") return "thinking";
  if (tool.name === "viewImage" || tool.name === "describeRoom") return "reading";
  return "working";
}

/** Work status owns terminal completion. A thoughts-stream `completed` frame
 * only means the parent reasoning stream ended; a public child reply may
 * still be running, so it must not prematurely settle this caption. */
export function dialogueWorkCaptionStatus(
  work: Pick<DialogueWorkView, "status" | "connection">,
  stream: DialogueWorkStreamView,
  replying = false,
): DialogueWorkCaptionStatus {
  if (work.connection === "disconnected") return "disconnected";
  if (work.connection === "reconnecting") return "reconnecting";
  if (work.status === "failed" || stream.status === "failed") return "failed";
  if (work.status === "cancelled" || stream.status === "cancelled") return "cancelled";
  if (stream.unavailable) return "unavailable";
  if (replying) return "replying";
  if (work.status === "completed") return "completed";
  const activity = stream.activity;
  if (activity?.type === "reasoning") return "thinking";
  if (activity?.type === "tool" && stream.status !== "completed") {
    return toolActivity(stream.tools.find(tool => tool.id === activity.toolCallId));
  }
  // Private work text is output, not evidence that the public reply started.
  return "thinking";
}

interface DialogueWorkCaptionProps {
  work: DialogueWorkView;
  persona: string;
  onCancel?: (workId: string) => Promise<void>;
  onRetry?: (inputId: string) => Promise<void> | void;
  onResume?: () => void;
  replying?: boolean;
  hasPublishedReply?: boolean;
}

export function DialogueWorkCaption({ work, persona, onCancel, onRetry, onResume, replying = false, hasPublishedReply = false }: DialogueWorkCaptionProps) {
  const t = useTranslations("chat.dialogue");
  const phase = useTranslations("chat.phase");
  const search = useTranslations("chat.search");
  const evolution = useTranslations("chat.evolution");
  const [expanded, setExpanded] = useState(false);
  const [replay, setReplay] = useState<string>();
  const [previewRetry, setPreviewRetry] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const actionPending = useRef<string | undefined>(undefined);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const openedOnce = useRef(false);
  const identity = `${work.workId}\0${work.runId ?? ""}\0${work.thoughtsUrl ?? ""}\0${persona}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const active = work.status === "queued" || work.status === "running";
  const stream = useDialogueWorkStream(work, persona, Boolean(work.runId && work.thoughtsUrl &&
    (active || replay === identity)), previewRetry);
  const status = dialogueWorkCaptionStatus(work, stream, replying);
  // A terminal thoughts stream may have no result for its final tool call.
  // End its running indicator without inventing a successful tool result.
  const unfinishedToolStatus = work.status === "cancelled" || stream.status === "cancelled" ? "stopped"
    : work.status === "completed" || work.status === "failed" || stream.status === "completed" || stream.status === "failed"
      ? "ended" : "running";
  const disconnected = work.connection === "disconnected" || work.connection === "reconnecting";
  const streaming = active && status !== "unavailable" && !disconnected;
  const activity = stream.activity;
  const activityTool = activity?.type === "tool"
    ? stream.tools.find(tool => tool.id === activity.toolCallId)
    : undefined;
  const activityKey = activityTool?.status === "running" && activityTool.subject &&
    (status === "thinking" || status === "recalling" || status === "searching" ||
      status === "reading" || status === "working")
    ? `activity_${activityTool.name}`
    : undefined;
  const label = activityTool?.status === "running" && activityTool.subject && activityKey && t.has(activityKey)
    ? t(activityKey, { subject: activityTool.subject })
    : status === "thinking" ? phase("thinking")
      : status === "recalling" ? phase("stageRecalling")
        : status === "searching" ? search("searching")
          : status === "reading" ? t("reading")
            : status === "working" ? phase("stageWorking")
              : status === "replying" ? t("expressing")
                : status === "completed" ? t("tool_completed")
                  : status === "failed" ? t("workFailed")
                    : status === "cancelled" ? t("workCancelled")
                      : status === "reconnecting" ? t("reconnecting")
                        : status === "disconnected" ? t("connectionDisconnected")
                          : t("streamUnavailable");
  const disclosureLabel = expanded ? t("hideThoughts") : t("showThoughts");

  const toolLabel = (tool: DialogueWorkToolView) => {
    const key = `tool_${tool.name}_subject`;
    return tool.subject && t.has(key) ? t(key, { subject: tool.subject })
      : t.has(`tool_${tool.name}`) ? t(`tool_${tool.name}`) : t("tool_unknown");
  };
  const toolStatus = (tool: DialogueWorkToolView) => {
    if (tool.status !== "completed" || !tool.outcome) {
      return t(`tool_${tool.status === "running" ? unfinishedToolStatus : tool.status}`);
    }
    const baseKey = `toolOutcome_${tool.name}`;
    if (tool.outcome === "empty" && t.has(`${baseKey}_empty`)) return t(`${baseKey}_empty`);
    if (tool.outcome === "found" && tool.resultCount !== undefined && t.has(baseKey)) {
      return t(baseKey, { count: tool.resultCount });
    }
    return t(tool.outcome === "found" ? "toolOutcome_found" : "toolOutcome_empty");
  };

  useEffect(() => {
    setCancelling(false);
    setCancelFailed(false);
    setRetrying(false);
    setRetryFailed(false);
    actionPending.current = undefined;
    followOutput.current = true;
    openedOnce.current = false;
  }, [identity]);

  useEffect(() => {
    if (!expanded) return;
    const viewport = scrollRoot.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const updateFollow = () => {
      followOutput.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
    };
    viewport.addEventListener("scroll", updateFollow, { passive: true });
    if (!openedOnce.current) {
      openedOnce.current = true;
      followOutput.current = true;
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      updateFollow();
    }
    return () => viewport.removeEventListener("scroll", updateFollow);
  }, [expanded, identity]);

  useEffect(() => {
    if (!expanded || !followOutput.current) return;
    const viewport = scrollRoot.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [expanded, stream.reasoning, stream.text, stream.tools]);

  const runAction = async (kind: "cancel" | "retry") => {
    if (actionPending.current) return;
    const actionIdentity = identity;
    actionPending.current = actionIdentity;
    if (kind === "cancel") {
      setCancelling(true);
      setCancelFailed(false);
    } else {
      setRetrying(true);
      setRetryFailed(false);
    }
    try {
      if (kind === "cancel") await onCancel?.(work.workId);
      else await onRetry?.(work.inputId);
    } catch {
      if (identityRef.current !== actionIdentity) return;
      if (kind === "cancel") setCancelFailed(true);
      else setRetryFailed(true);
    } finally {
      if (actionPending.current === actionIdentity) actionPending.current = undefined;
      if (identityRef.current === actionIdentity) {
        if (kind === "cancel") setCancelling(false);
        else setRetrying(false);
      }
    }
  };

  // Older saved replies may have no trace endpoint. Their public content
  // stands on its own instead of a disclosure that can only show "waiting".
  if (hasPublishedReply && status === "completed" && !work.thoughtsUrl && !stream.log.length) return null;

  return <Collapsible open={expanded} onOpenChange={open => {
    setExpanded(open);
    if (open && !active && !stream.log.length) setReplay(identity);
  }} data-dialogue-work={work.workId} data-status={status} className="dialogue-activity">
    <div className="dialogue-activity-heading">
      <CollapsibleTrigger data-dialogue-work-caption="" title={label} aria-label={`${disclosureLabel}: ${label}`}
        className="dialogue-activity-trigger">
        <span className="dialogue-activity-indicator" aria-hidden="true">
          {streaming ? <span className="dialogue-live-dots"><i /><i /><i /></span>
            : status === "completed" ? <Check />
            : status === "cancelled" ? <CirclePause /> : <CircleAlert />}
        </span>
        <span className="min-w-0 flex-1 truncate" role="status" aria-live="polite" aria-atomic="true">{label}</span>
        <ChevronDown className="dialogue-activity-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      {active && onCancel && <Button type="button" variant="ghost" size="xs" disabled={cancelling} onClick={() => void runAction("cancel")}>
        {cancelling ? t("stopExpression") : t("cancelWork")}
      </Button>}
      {status === "disconnected" && onResume && <Button type="button" variant="outline" size="xs" onClick={onResume}>{t("reconnect")}</Button>}
      {status === "unavailable" && <Button type="button" variant="outline" size="xs" onClick={() => setPreviewRetry(value => value + 1)}>{t("reconnect")}</Button>}
      {work.status === "failed" && onRetry && !disconnected && <Button type="button" variant="outline" size="xs" disabled={retrying} onClick={() => void runAction("retry")}>
        {retrying ? t("retrying") : t("retry")}
      </Button>}
    </div>
    {(cancelFailed || retryFailed) && <p role="status" className="px-3 pb-2 text-xs text-destructive">
      {cancelFailed ? t("stopFailed") : t("regenerateFailed")}
    </p>}
    <CollapsibleContent keepMounted className="border-border/60 data-[open]:border-t data-[closed]:hidden">
      <ScrollArea ref={scrollRoot} className="dialogue-activity-viewport h-32 max-h-32 w-full" aria-label={t("liveOutput")}>
        <div className="dialogue-activity-log" role="log" aria-live="off" data-dialogue-thought-content="">
          {!stream.log.length && !stream.unavailable && <p className="text-muted-foreground">{active || (replay === identity && !stream.status) ? t("waitingForOutput") : t("noRecordedActivity")}</p>}
          <ul>{stream.log.map((entry, index) => {
            if (entry.type === "tool") {
              const tool = stream.tools[entry.index];
              return <li key={tool.id} className="dialogue-activity-tool" data-state={tool.status}>
                <span className="min-w-0 flex-1 truncate" title={toolLabel(tool)}>{toolLabel(tool)}</span>
                <span className="shrink-0 whitespace-nowrap">{toolStatus(tool)}</span>
              </li>;
            }
            const heading = entry.type === "reasoning" ? evolution("thoughts") : t("thoughtOutput");
            const content = stream[entry.type].slice(entry.start, entry.end);
            return <li key={`${entry.type}:${entry.start}`} className="dialogue-activity-text">
              <section aria-label={heading}>
                <h3>{heading}</h3>
                {expanded ? <MarkdownRenderer content={content}
                  isStreaming={streaming && index === stream.log.length - 1 && activity?.type === entry.type} /> : content}
              </section>
            </li>;
          })}</ul>
          {stream.unavailable && <p role="status" className="text-xs text-muted-foreground">{t("streamUnavailable")}</p>}
        </div>
      </ScrollArea>
    </CollapsibleContent>
  </Collapsible>;
}
