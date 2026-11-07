"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DialoguePage } from "@/lib/chat/dialogue-contract";
import {
  DialogueParentController,
  parseDialogueAcceptedV2,
  parseSubmittedUserMessage,
  type DialogueAcceptedV2,
} from "./dialogue-parent-stream";
import { emptyDialogueProjection, mergeDialogueProjections, projectDialoguePage, type DialogueProjection } from "./dialogue-projection";

type DialogueMode = "legacy" | "dialogue";


export type DialogueSubmission =
  | { phase: "idle" | "submitting" | "failed" }
  | { phase: "accepted"; workId: string };

function codeOf(value: unknown) {
  return value && typeof value === "object" && "code" in value ? value.code : undefined;
}

export class DialogueDisabled extends Error {}

/** v2 sends and recovery use parent/child streams only. The old Git-backed
 * projection is an optional, one-pass history read and never gates startup. */
export function useDialogueManuscript(persona: string) {
  const [mode, setMode] = useState<DialogueMode>("dialogue");
  const [expression] = useState<DialoguePage["expression"]>("idle");
  const opened = useRef(true);
  const [history, setHistory] = useState<DialogueProjection>(emptyDialogueProjection);
  const [live, setLive] = useState<DialogueProjection>(emptyDialogueProjection);
  const liveState = useRef(live);
  const [newPublications, setNewPublications] = useState(0);
  const [submission, setSubmission] = useState<DialogueSubmission>({ phase: "idle" });
  const controller = useRef<DialogueParentController | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const updateLive = useCallback((next: DialogueProjection) => {
    liveState.current = next;
    setLive(next);
    setSubmission(current => current.phase === "accepted" && next.works.get(current.workId)?.status !== "queued"
      ? { phase: "idle" } : current);
  }, []);

  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    const parent = new DialogueParentController({
      persona,
      signal: scope.signal,
      onProjection: updateLive,
      onPublication: () => setNewPublications(count => count + 1),
    });
    controller.current = parent;
    parent.start();
    const resume = () => parent.resume();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    const readHistory = async () => {
      let projection = emptyDialogueProjection();
      let hasMore = true;
      while (hasMore && !scope.signal.aborted) {
        try {
          const params = new URLSearchParams({ persona, after: String(projection.cursor) });
          const response = await fetch(`/api/chat/dialogue?${params}`, {
            credentials: "same-origin", cache: "no-store",
            signal: AbortSignal.any([scope.signal, AbortSignal.timeout(5_000)]),
          });
          const payload = await response.json() as DialoguePage;
          if (scope.signal.aborted) return;
          if (!response.ok) {
            if (codeOf(payload) === "dialogue_disabled" && liveState.current.entries.length === 0) {
              opened.current = false;
              setMode("legacy");
            }
            return;
          }
          const next = projectDialoguePage(projection, payload);
          if (payload.hasMore && payload.cursor <= projection.cursor) return;
          projection = next;
          setHistory(next);
          hasMore = payload.hasMore;
        } catch {
          return;
        }
      }
    };
    void readHistory();
    return () => {
      scope.abort();
      controller.current = null;
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [persona, updateLive]);

  const submit = useCallback(async (body: Record<string, unknown>): Promise<DialogueAcceptedV2> => {
    const signal = lifetime.current?.signal;
    const userMessage = parseSubmittedUserMessage(body);
    setSubmission({ phase: "submitting" });
    try {
      const response = await fetch("/api/chat", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, persona, dialogueVersion: 2 }), signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        if (codeOf(payload) === "dialogue_disabled") {
          opened.current = false;
          setMode("legacy");
          throw new DialogueDisabled();
        }
        throw new Error("Dialogue submission failed");
      }
      const acceptance = parseDialogueAcceptedV2(payload);
      if (signal?.aborted) return acceptance;
      if (!controller.current) throw new Error("Dialogue is unavailable");
      opened.current = true;
      setMode("dialogue");
      controller.current.accept(acceptance, userMessage);
      setSubmission({ phase: "accepted", workId: acceptance.workId });
      return acceptance;
    } catch (error) {
      if (!signal?.aborted) setSubmission({ phase: error instanceof DialogueDisabled ? "idle" : "failed" });
      throw error;
    }
  }, [persona]);

  const stop = useCallback(async (workId?: string) => {
    if (!controller.current) return;
    await controller.current.stop(workId);
  }, []);

  const resume = useCallback(() => controller.current?.resume(), []);

  const projection = useMemo(() => mergeDialogueProjections(history, live), [history, live]);
  return { mode, opened: opened.current, expression, projection, submission, submit, stop, resume, newPublications };
}
