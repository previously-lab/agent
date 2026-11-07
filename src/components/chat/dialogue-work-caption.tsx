"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
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
  if (tool.name === "webSearch" || tool.name === "webFetch") return "searching";
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
  if (work.status === "completed") return "completed";
  if (replying) return "replying";
  const activity = stream.activity;
  if (activity?.type === "reasoning") return "thinking";
  if (activity?.type === "tool") {
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
}

export function DialogueWorkCaption({ work, persona, onCancel, onRetry, onResume, replying = false }: DialogueWorkCaptionProps) {
  const t = useTranslations("chat.dialogue");
  const phase = useTranslations("chat.phase");
  const search = useTranslations("chat.search");
  const evolution = useTranslations("chat.evolution");
  const [expanded, setExpanded] = useState(false);
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
  const stream = useDialogueWorkStream(work, persona, true, previewRetry);
  const status = dialogueWorkCaptionStatus(work, stream, replying);
  // A terminal thoughts stream may have no result for its final tool call.
  // End its running indicator without inventing a successful tool result.
  const unfinishedToolStatus = work.status === "cancelled" || stream.status === "cancelled" ? "stopped"
    : work.status === "completed" || work.status === "failed" || stream.status === "completed" || stream.status === "failed"
      ? "ended" : "running";
  const active = work.status === "queued" || work.status === "running";
  const disconnected = work.connection === "disconnected" || work.connection === "reconnecting";
  const streaming = active && status !== "unavailable" && !disconnected;
  const label = status === "thinking" ? phase("thinking")
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

  return <Collapsible open={expanded} onOpenChange={setExpanded} data-dialogue-work={work.workId}
    className="my-1 data-[open]:rounded-lg data-[open]:border data-[open]:border-border/60 data-[open]:bg-muted/20">
    <div className="flex min-h-7 min-w-0 items-center gap-1 px-1 data-[open]:px-2">
      <CollapsibleTrigger data-dialogue-work-caption="" title={disclosureLabel} aria-label={disclosureLabel}
        className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        {streaming && <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate" role="status" aria-live="polite" aria-atomic="true">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[open]:rotate-180" aria-hidden="true" />
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
      <ScrollArea ref={scrollRoot} className="h-48 max-h-48 w-full" aria-label={t("liveOutput")}>
        <div className="space-y-4 p-3" role="log" aria-live="off" data-dialogue-thought-content="">
          {!stream.reasoning && !stream.text && stream.tools.length === 0 && <p className="text-muted-foreground">{t("waitingForOutput")}</p>}
          {stream.reasoning && <section aria-label={evolution("thoughts")}>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{evolution("thoughts")}</h3>
            <MarkdownRenderer content={stream.reasoning} isStreaming={streaming && stream.activity?.type === "reasoning"} />
          </section>}
          {stream.text && <section aria-label={t("thoughtOutput")}>
            <MarkdownRenderer content={stream.text} isStreaming={streaming && stream.activity?.type === "text"} />
          </section>}
          {stream.tools.length > 0 && <ul className="space-y-1 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            {stream.tools.map(tool => <li key={tool.id} className="flex items-center justify-between gap-3">
              <span>{t.has(`tool_${tool.name}`) ? t(`tool_${tool.name}`) : t("tool_unknown")}</span>
              <span>{t(`tool_${tool.status === "running" ? unfinishedToolStatus : tool.status}`)}</span>
            </li>)}
          </ul>}
          {stream.unavailable && <p role="status" className="text-xs text-muted-foreground">{t("streamUnavailable")}</p>}
        </div>
      </ScrollArea>
    </CollapsibleContent>
  </Collapsible>;
}
