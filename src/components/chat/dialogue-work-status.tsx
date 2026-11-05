"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { DialogueInput, DialoguePage, DialogueWork } from "@/lib/chat/dialogue-contract";
import { dialogueInputExcerpt } from "./dialogue-stream-rows";
import { DialogueArtifact } from "./native-artifact";
import { NativeReadingCopyProvider } from "./native-reading-context";
import { flushNativeReading } from "./native-reading-flush";
import "./dialogue-manuscript.css";

export function DialogueWorkStatus({ works, inputs, expression, onCancel }: {
  works: readonly DialogueWork[];
  inputs: ReadonlyMap<string, DialogueInput>;
  expression: DialoguePage["expression"];
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
  const toggle = async () => {
    const next = !requested.current;
    requested.current = next;
    if (!next) await flushNativeReading(root.current);
    if (requested.current === next) setExpanded(next);
  };
  if (active.length === 0 && completed.length === 0 && !terminal && expression === "idle") return null;
  const label = expression === "running" ? t("expressing") : expression === "paused" ? t("expressionStopped")
    : active.length ? t("thinking", { count: active.length }) : terminal ? t(terminal.status === "failed" ? "workFailed" : "workCancelled") : t("workProducts");
  return <div className="dialogue-work-status" ref={root}>
    <button className="dialogue-work-disclosure" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => void toggle()}>{label}</button>
    {expanded && <div id={panelId}>
      {active.length > 0 && <ul>{active.map(work => <li key={work.workId} data-dialogue-work={work.workId}>
      <span>{dialogueInputExcerpt(inputs.get(work.inputId)) ?? t("thinking", { count: 1 })}</span>
      <button type="button" disabled={Boolean(cancelling)} onClick={async () => {
        setCancelling(work.workId); setFailed(false);
        try { await onCancel(work.workId); } catch { setFailed(true); }
        finally { setCancelling(undefined); }
      }}>{t("cancelWork")}</button>
      </li>)}</ul>}
      {failed && <p role="status">{t("stopFailed")}</p>}
      <NativeReadingCopyProvider active priority={1}>
        {completed.map(work => <section key={work.workId} data-dialogue-work={work.workId} className="dialogue-work-product">
          {dialogueInputExcerpt(inputs.get(work.inputId)) && <p>{dialogueInputExcerpt(inputs.get(work.inputId))}</p>}
          {work.summary && <p>{work.summary}</p>}
          {work.artifacts?.map(artifact => <DialogueArtifact key={artifact.artifactId} artifact={artifact} mode="interactive" />)}
        </section>)}
      </NativeReadingCopyProvider>
    </div>}
  </div>;
}
