"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DialoguePage } from "@/lib/chat/dialogue-contract";
import type { UIMessage } from "@/lib/chat/protocol";
import { getConversationWindow, type ConversationWindow } from "@/lib/episodic/conversation-window";
import {
  DialogueParentController,
  parseDialogueAcceptedV2,
  parseSubmittedUserMessage,
  type DialogueAcceptedV2,
} from "./dialogue-parent-stream";
import { mergeDialogueHistory } from "./dialogue-stream-rows";

type DialogueMode = "legacy" | "dialogue";
type HistoryGetter = () => UIMessage[];
type HistorySetter = (update: (previous: UIMessage[]) => UIMessage[]) => void;

export type DialogueSubmission =
  | { phase: "idle" | "submitting" | "failed" }
  | { phase: "accepted"; workId: string };

function codeOf(value: unknown) {
  return value && typeof value === "object" && "code" in value ? value.code : undefined;
}

export class DialogueDisabled extends Error {}

/** Capability and saved records live here; live conversation state does not.
 * Inner binds useDurableChat's get/set so every writer shares one history. */
export function useDialogueManuscript(persona: string) {
  const [mode, setMode] = useState<DialogueMode>("dialogue");
  const [expression, setExpression] = useState<DialoguePage["expression"]>("idle");
  const opened = useRef(true);
  const [historyWindow, setHistoryWindow] = useState<ConversationWindow | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [newPublications, setNewPublications] = useState(0);
  const [submission, setSubmission] = useState<DialogueSubmission>({ phase: "idle" });
  const [historyBound, setHistoryBound] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const controller = useRef<DialogueParentController | null>(null);
  const getMessages = useRef<HistoryGetter>(() => []);
  const setMessages = useRef<HistorySetter>(() => {});

  const bindHistory = useCallback((get: HistoryGetter, set: HistorySetter) => {
    getMessages.current = get;
    setMessages.current = set;
    setHistoryBound(true);
  }, []);

  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    const parent = new DialogueParentController({
      persona,
      signal: scope.signal,
      getMessages: () => getMessages.current(),
      setMessages: update => setMessages.current(update),
      onPublication: () => setNewPublications(count => count + 1),
    });
    controller.current = parent;
    const resume = () => parent.resume();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    const loadWindow = async () => {
      try {
        const response = await fetch(`/api/chat/dialogue?capabilities=1&persona=${encodeURIComponent(persona)}`, {
          credentials: "same-origin", signal: AbortSignal.any([scope.signal, AbortSignal.timeout(5_000)]),
        });
        if (response.status === 409 && codeOf(await response.json()) === "dialogue_disabled") {
          if (!scope.signal.aborted) {
            opened.current = false;
            setMode("legacy");
          }
          return null;
        }
      } catch { /* A failed probe must not hide the saved conversation. */ }
      return scope.signal.aborted ? null : getConversationWindow(persona);
    };
    void loadWindow().then(window => {
      if (!scope.signal.aborted && window) setHistoryWindow(window);
    }).catch(() => {
      if (!scope.signal.aborted) setHistoryFailed(true);
    }).finally(() => {
      if (!scope.signal.aborted) setHistoryReady(true);
    });

    return () => {
      scope.abort();
      lifetime.current = null;
      controller.current = null;
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [persona]);

  useEffect(() => {
    if (!historyReady || !historyBound || !controller.current) return;
    const parent = controller.current;
    if (!historyWindow) {
      if (historyFailed) parent.start();
      return;
    }
    const currentTurns = historyWindow.arrival.mode === "resume" ? historyWindow.arrival.turns : [];
    const savedTurns = [...historyWindow.previous.flatMap(slice => slice.turns), ...currentTurns];
    const savedPublications = new Set(savedTurns.flatMap(turn =>
      turn.dialogue?.kind === "public_utterance" ? [turn.dialogue.publicationId] : []));
    const since = historyWindow.previous[0]?.start ??
      (historyWindow.arrival.mode === "resume" ? historyWindow.arrival.start : undefined);
    parent.start(since, savedPublications);
    setMessages.current(previous => mergeDialogueHistory(previous, currentTurns));
  }, [historyReady, historyBound, historyWindow, historyFailed]);

  const submit = useCallback(async (body: Record<string, unknown>, assistantId: string): Promise<DialogueAcceptedV2> => {
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
      setExpression("idle");
      controller.current.accept(acceptance, assistantId, userMessage);
      setSubmission({ phase: "idle" });
      return acceptance;
    } catch (error) {
      if (!signal?.aborted) setSubmission({ phase: error instanceof DialogueDisabled ? "idle" : "failed" });
      throw error;
    }
  }, [persona]);

  const stop = useCallback(async (workId?: string) => {
    await controller.current?.stop(workId);
    if (!workId) setExpression("paused");
  }, []);

  const resume = useCallback(() => controller.current?.resume(), []);

  return { mode, opened: opened.current, expression, submission, submit, stop, resume, newPublications,
    historyWindow, historyReady, historyFailed, bindHistory };
}
