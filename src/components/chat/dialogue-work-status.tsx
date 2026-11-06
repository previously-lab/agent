"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { DialogueInput, DialoguePage, DialogueWork } from "@/lib/chat/dialogue-contract";
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

export function DialogueWorkStatus({ works, inputs, expression, submission = { phase: "idle" }, persona, onCancel }: {
  works: readonly DialogueWork[];
  inputs: ReadonlyMap<string, DialogueInput>;
  expression: DialoguePage["expression"];
  submission?: DialogueSubmission;
  persona: string;
  onCancel: (workId: string) => Promise<void>;
}) {
  const t = useTranslations("chat.dialogue");
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const requested = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const [failed, setFailed] = useState(false);
  const active = works.filter(work => work.status === "queued" || work.status === "running");
  const completed = works.filter(work => work.status === "completed" && (work.summary || work.artifacts?.length)).slice(-3);
  const last = works.at(-1);
  const terminal = last?.status === "failed" || last?.status === "cancelled" ? last : undefined;
  const acceptedWork = submission.phase === "accepted" ? works.find(work => work.workId === submission.workId) : undefined;
  const toggle = async () => {
    const next = !requested.current;
    requested.current = next;
    if (!next) await flushNativeReading(root.current);
    if (requested.current === next) setExpanded(next);
  };
  if (active.length === 0 && completed.length === 0 && !terminal && expression === "idle" && submission.phase === "idle") return null;
  const label = submission.phase === "submitting" ? t("submitting")
    : submission.phase === "failed" ? t("submitFailed")
      : acceptedWork?.status === "queued" ? t("received")
        : expression === "running" ? t("expressing") : expression === "paused" ? t("expressionStopped")
          : active.length ? t("thinking") : terminal ? t(terminal.status === "failed" ? "workFailed" : "workCancelled") : t("workProducts");
  return <div className="dialogue-work-status" ref={root} data-dialogue-submission={submission.phase}>
    <span className="sr-only" role="status" aria-live="polite">{label}</span>
    <button className="dialogue-work-disclosure" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => void toggle()}>{label}</button>
    {expanded && <div id={panelId} className="dialogue-work-details">
      {active.length > 0 && <ul className="dialogue-work-active">{active.map(work => <li key={work.workId} data-dialogue-work={work.workId}>
        <div className="dialogue-work-heading">
          <span className="dialogue-work-excerpt">{dialogueInputExcerpt(inputs.get(work.inputId)) ?? t("thinking")}</span>
          <button type="button" disabled={Boolean(cancelling)} onClick={async () => {
            setCancelling(work.workId); setFailed(false);
            try { await onCancel(work.workId); } catch { setFailed(true); }
            finally { setCancelling(undefined); }
          }}>{t("cancelWork")}</button>
        </div>
        <DialogueWorkLive work={work} persona={persona} />
      </li>)}</ul>}
      {failed && <p role="status">{t("stopFailed")}</p>}
      <NativeReadingCopyProvider active priority={1}>
        {completed.map(work => <section key={work.workId} data-dialogue-work={work.workId} className="dialogue-work-product">
          {dialogueInputExcerpt(inputs.get(work.inputId)) && <p>{dialogueInputExcerpt(inputs.get(work.inputId))}</p>}
          {work.summary && <p>{work.summary}</p>}
          {work.artifacts?.map(artifact => <DialogueArtifact key={artifact.artifactId} artifact={artifact} mode="interactive" workId={work.workId} />)}
        </section>)}
      </NativeReadingCopyProvider>
    </div>}
  </div>;
}
