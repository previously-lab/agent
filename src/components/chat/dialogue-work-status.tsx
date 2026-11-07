"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { DialogueInput, DialoguePage, DialogueWork } from "@/lib/chat/dialogue-contract";
import type { DialogueWorkView } from "./dialogue-projection";
import { dialogueInputExcerpt } from "./dialogue-stream-rows";
import { DialogueArtifact } from "./native-artifact";
import { NativeReadingCopyProvider } from "./native-reading-context";
import { flushNativeReading } from "./native-reading-flush";
import { useDialogueWorkStream } from "./dialogue-work-stream";
import type { DialogueSubmission } from "./use-dialogue-manuscript";
import "./dialogue-manuscript.css";

function DialogueWorkLive({ work, persona }: { work: DialogueWork; persona: string }) {
  const t = useTranslations("chat.dialogue");
  const stream = useDialogueWorkStream(work, persona, true);
  const output = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [stream.text, stream.tools]);
  return <div className="dialogue-work-live" data-work-stream-status={stream.status}>
    <div className="dialogue-work-output" ref={output} tabIndex={0} role="log" aria-live="off" aria-label={t("liveOutput")}>
      {!stream.text && stream.tools.length === 0 && <p className="dialogue-work-empty">{t("waitingForOutput")}</p>}
      {stream.text && <pre>{stream.text}</pre>}
      {stream.tools.length > 0 && <ul className="dialogue-work-tools">
        {stream.tools.map(tool => <li key={tool.id}>
          <span className="dialogue-work-tool-name">{tool.name}</span>
          <span>{t(`tool_${tool.status}`)}</span>
        </li>)}
      </ul>}
    </div>
    {stream.unavailable && <p role="status" className="dialogue-work-stream-error">{t("streamUnavailable")}</p>}
  </div>;
}

export function DialogueWorkStatus({ works, inputs, expression, submission = { phase: "idle" }, persona, onCancel, onRetry, onResume }: {
  works: readonly DialogueWorkView[];
  inputs: ReadonlyMap<string, DialogueInput>;
  expression: DialoguePage["expression"];
  submission?: DialogueSubmission;
  persona: string;
  onCancel: (workId: string) => Promise<void>;
  onRetry?: (inputId: string) => Promise<void> | void;
  onResume?: () => void;
}) {
  const t = useTranslations("chat.dialogue");
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const requested = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const [stopFailed, setStopFailed] = useState(false);
  const [retrying, setRetrying] = useState<string>();
  const [retryFailed, setRetryFailed] = useState(false);
  const [retiredProducts, setRetiredProducts] = useState<string>();
  const retryPending = useRef(false);
  const active = works.filter(work => work.status === "queued" || work.status === "running");
  const completed = works.filter(work => work.status === "completed" && (work.summary || work.artifacts?.length)).slice(-3);
  const productKey = completed.map(work => work.workId).join("|");
  const ephemeralProducts = completed.length > 0 && completed.every(work => !work.artifacts?.length);
  const showCompleted = completed.length > 0 && (!ephemeralProducts || retiredProducts !== productKey);
  const last = works.at(-1);
  const terminal = last?.status === "failed" || last?.status === "cancelled" ? last : undefined;
  const acceptedWork = submission.phase === "accepted" ? works.find(work => work.workId === submission.workId) : undefined;
  const acceptedQueued = acceptedWork?.status === "queued";
  const hasSubmissionStatus = submission.phase === "submitting" || submission.phase === "failed" || acceptedQueued;
  const connectionWork = [...active].reverse().find(work => work.connection === "disconnected" || work.connection === "reconnecting") ?? acceptedWork ?? last;
  const connection = connectionWork?.connection;
  const failedWork = terminal?.status === "failed" ? terminal : undefined;
  const retryActive = failedWork ? active.some(work => work.inputId === failedWork.inputId) : false;
  useEffect(() => {
    if (!ephemeralProducts || expanded) return;
    const timeout = window.setTimeout(() => setRetiredProducts(productKey), 8000);
    return () => window.clearTimeout(timeout);
  }, [ephemeralProducts, expanded, productKey]);
  const toggle = async () => {
    const next = !requested.current;
    requested.current = next;
    if (!next) await flushNativeReading(root.current);
    if (requested.current === next) setExpanded(next);
  };
  if (active.length === 0 && !showCompleted && !terminal && connection !== "reconnecting" && connection !== "disconnected" && expression === "idle" && !hasSubmissionStatus) return null;
  const labelKey = submission.phase === "submitting" ? "submitting"
    : submission.phase === "failed" ? "submitFailed"
      : connection === "disconnected" ? "connectionDisconnected"
        : connection === "reconnecting" ? "reconnecting"
          : acceptedQueued ? "received"
            : terminal ? terminal.status === "failed" ? "workFailed" : "workCancelled"
              : expression === "running" ? "expressing" : expression === "paused" ? "expressionStopped"
                : active.length ? "thinking" : showCompleted ? "workProducts" : "workDetails";
  const label = t(labelKey);
  const tone = submission.phase === "failed" || failedWork || connection === "disconnected" ? "error"
    : connection === "reconnecting" ? "warning" : "normal";
  return <div className="dialogue-work-status" ref={root} data-dialogue-submission={submission.phase} data-tone={tone}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{label}</span>
    <button className="dialogue-work-disclosure" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => void toggle()}>
      <span>{label}</span>{labelKey !== "workProducts" && labelKey !== "workDetails" &&
        <span className="dialogue-work-details-toggle">{t("workDetails")}</span>}
    </button>
    {submission.phase === "failed" && <p className="dialogue-work-help">{t("submitFailedHelp")}</p>}
    {connection === "disconnected" && onResume && <div className="dialogue-work-recovery">
      <button type="button" onClick={onResume}>{t("reconnect")}</button>
    </div>}
    {failedWork && onRetry && connection !== "disconnected" && connection !== "reconnecting" && <div className="dialogue-work-recovery">
      <p className="dialogue-work-help">{t(retryActive ? "retryActiveHelp" : "workFailedHelp")}</p>
      <button type="button" disabled={Boolean(retrying) || retryActive} onClick={async () => {
        if (retryPending.current || retryActive) return;
        retryPending.current = true;
        setRetrying(failedWork.inputId); setRetryFailed(false);
        try { await onRetry(failedWork.inputId); } catch { setRetryFailed(true); }
        finally { retryPending.current = false; setRetrying(undefined); }
      }}>{retrying ? t("retrying") : t("retry")}</button>
      {retryFailed && <p role="status" className="dialogue-work-help">{t("regenerateFailed")}</p>}
    </div>}
    {expanded && <div id={panelId} className="dialogue-work-details">
      <div className="dialogue-work-details-heading">
        <h2>{t("workDetails")}</h2>
        <p>{t("workDetailsHelp")}</p>
      </div>
      {active.length > 0 && <ul className="dialogue-work-active">{active.map(work => <li key={work.workId}>
        <div className="dialogue-work-heading">
          <span className="dialogue-work-excerpt">{dialogueInputExcerpt(inputs.get(work.inputId)) ?? t("thinking")}</span>
          <button type="button" disabled={Boolean(cancelling)} onClick={async () => {
            setCancelling(work.workId); setStopFailed(false);
            try { await onCancel(work.workId); } catch { setStopFailed(true); }
            finally { setCancelling(undefined); }
          }}>{t("cancelWork")}</button>
        </div>
        <DialogueWorkLive work={work} persona={persona} />
      </li>)}</ul>}
      {stopFailed && <p role="status">{t("stopFailed")}</p>}
      <NativeReadingCopyProvider active priority={1}>
        {showCompleted && completed.map(work => <section key={work.workId} className="dialogue-work-product">
          {dialogueInputExcerpt(inputs.get(work.inputId)) && <p>{dialogueInputExcerpt(inputs.get(work.inputId))}</p>}
          {work.summary && <p>{work.summary}</p>}
          {work.artifacts?.map(artifact => <DialogueArtifact key={artifact.artifactId} artifact={artifact} mode="interactive" workId={work.workId} />)}
        </section>)}
      </NativeReadingCopyProvider>
    </div>}
  </div>;
}
