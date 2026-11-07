"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DialoguePage } from "@/lib/chat/dialogue-contract";
import {
  DialogueParentController,
  parseDialogueAcceptedV2,
  parseSubmittedUserMessage,
  type DialogueAcceptedV2,
} from "./dialogue-parent-stream";
import { emptyDialogueProjection, type DialogueProjection } from "./dialogue-projection";
import { getConversationWindow, type ConversationWindow } from "@/lib/episodic/conversation-window";

type DialogueMode = "legacy" | "dialogue";


export type DialogueSubmission =
  | { phase: "idle" | "submitting" | "failed" }
  | { phase: "accepted"; workId: string };

function codeOf(value: unknown) {
  return value && typeof value === "object" && "code" in value ? value.code : undefined;
}

export class DialogueDisabled extends Error {}

/** Saved records supply one preceding slice and the current conversation.
 * Parent/child streams supply only the live work in that bounded window. */
export function useDialogueManuscript(persona: string) {
  const [mode, setMode] = useState<DialogueMode>("dialogue");
  const [expression] = useState<DialoguePage["expression"]>("idle");
  const opened = useRef(true);
  const [historyWindow, setHistoryWindow] = useState<ConversationWindow | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [live, setLive] = useState<DialogueProjection>(emptyDialogueProjection);
  const [newPublications, setNewPublications] = useState(0);
  const [submission, setSubmission] = useState<DialogueSubmission>({ phase: "idle" });
  const controller = useRef<DialogueParentController | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const updateLive = useCallback((next: DialogueProjection) => {
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
    const resume = () => parent.resume();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    const loadWindow = async () => {
      // Keep demo/legacy mode detection separate from saved history. This is
      // one lightweight request, never an event-log page or a polling loop.
      try {
        const response = await fetch(`/api/chat/dialogue?capabilities=1&persona=${encodeURIComponent(persona)}`, {
          credentials: "same-origin", signal: AbortSignal.any([scope.signal, AbortSignal.timeout(5_000)]),
        });
        if (response.status === 409 && codeOf(await response.json()) === "dialogue_disabled") {
          if (!scope.signal.aborted) { opened.current = false; setMode("legacy"); }
          return null;
        }
      } catch { /* A failed probe must not hide the saved conversation. */ }
      return scope.signal.aborted ? null : getConversationWindow(persona);
    };
    void loadWindow().then(window => {
      if (scope.signal.aborted || !window) return;
      setHistoryWindow(window);
      // With no saved slice yet, restore the current local run even if its
      // acceptance predates this reload. A real slice boundary is exclusive.
      const since = window.previous[0]?.start ?? (window.arrival.mode === "resume" ? window.arrival.start : undefined);
      const savedTurns = [...window.previous.flatMap(slice => slice.turns), ...(window.arrival.mode === "resume" ? window.arrival.turns : [])];
      const savedPublications = new Set(savedTurns.flatMap(turn => turn.dialogue?.kind === "public_utterance" ? [turn.dialogue.publicationId] : []));
      parent.start(since, savedPublications);
    }).catch(() => {
      if (scope.signal.aborted) return;
      setHistoryFailed(true);
      parent.start();
    }).finally(() => { if (!scope.signal.aborted) setHistoryReady(true); });
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

  return { mode, opened: opened.current, expression, projection: live, submission, submit, stop, resume, newPublications,
    historyWindow, historyReady, historyFailed };
}
