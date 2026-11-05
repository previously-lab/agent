"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DialogueAccepted, DialoguePage, DialogueWork } from "@/lib/chat/dialogue-contract";
import { emptyDialogueProjection, projectAcceptedInput, projectDialoguePage, type DialogueProjection } from "./dialogue-projection";

type DialogueMode = "probing" | "legacy" | "dialogue";

function codeOf(value: unknown) {
  return value && typeof value === "object" && "code" in value ? value.code : undefined;
}

export class DialogueDisabled extends Error {}

/** One scoped reader independent of work attempts. A rejected read leaves the
 * prefix and editor usable, and never changes an active session to legacy. */
export function useDialogueManuscript(persona: string) {
  const [mode, setMode] = useState<DialogueMode>("probing");
  const enabled = useRef(false);
  const opened = useRef(false);
  const [expression, setExpression] = useState<DialoguePage["expression"]>("idle");
  const expressionIntent = useRef(0);
  const [projection, setProjection] = useState(emptyDialogueProjection);
  const state = useRef(projection);
  const [newPublications, setNewPublications] = useState(0);
  const refresh = useRef<() => void>(() => {});
  const lifetime = useRef<AbortController | null>(null);
  const update = useCallback((next: DialogueProjection) => {
    if (next === state.current) return;
    state.current = next;
    setProjection(next);
  }, []);

  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let readAgain = false;
    let caughtUp = false;
    let disabled = false;
    let failures = 0;
    const read = async () => {
      if (scope.signal.aborted || disabled) return;
      if (reading) { readAgain = true; return; }
      clearTimeout(timer);
      reading = true;
      let immediate = false;
      try {
        const after = state.current.cursor;
        const intent = expressionIntent.current;
        const params = new URLSearchParams({ persona, after: String(after) });
        const response = await fetch(`/api/chat/dialogue?${params}`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([scope.signal, AbortSignal.timeout(5_000)]),
        });
        const payload = await response.json() as DialoguePage;
        if (scope.signal.aborted) return;
        if (!response.ok) {
          if (!enabled.current && codeOf(payload) === "dialogue_disabled") {
            disabled = true;
            setMode("legacy");
            return;
          }
          throw new Error("Dialogue unavailable");
        }
        const previous = state.current;
        const next = projectDialoguePage(previous, payload);
        if (payload.hasMore && payload.cursor <= after) throw new Error("Dialogue cursor did not advance");
        enabled.current = true;
        opened.current = true;
        setMode("dialogue");
        if (intent === expressionIntent.current) setExpression(payload.expression);
        if (caughtUp && next.utterances.size > previous.utterances.size) setNewPublications(count => count + next.utterances.size - previous.utterances.size);
        update(next);
        caughtUp ||= !payload.hasMore;
        failures = 0;
        immediate = payload.hasMore;
      } catch {
        // The POST can still succeed while recovery is temporarily unavailable.
        if (!scope.signal.aborted) { opened.current = true; setMode("dialogue"); }
        failures++;
      } finally {
        reading = false;
        if (!scope.signal.aborted && !disabled) {
          const active = [...state.current.works.values()].some(work => work.status === "queued" || work.status === "running");
          const delay = failures ? Math.min(10_000, 1_000 * 2 ** Math.min(failures, 4))
            : document.hidden ? 8_000 : active ? 600 : 2_500;
          timer = setTimeout(read, immediate || readAgain ? 0 : delay);
        }
        readAgain = false;
      }
    };
    refresh.current = () => { void read(); };
    document.addEventListener("visibilitychange", refresh.current);
    window.addEventListener("online", refresh.current);
    void read();
    return () => {
      scope.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh.current);
      window.removeEventListener("online", refresh.current);
    };
  }, [persona, update]);

  const submit = useCallback(async (body: Record<string, unknown>): Promise<DialogueAccepted> => {
    const signal = lifetime.current?.signal;
    const response = await fetch("/api/chat", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, persona, dialogueVersion: 1 }), signal,
    });
    const payload = await response.json() as DialogueAccepted;
    if (!response.ok) {
      if (!enabled.current && codeOf(payload) === "dialogue_disabled") { setMode("legacy"); throw new DialogueDisabled(); }
      throw new Error("Dialogue submission failed");
    }
    if (payload.version !== 1 || !payload.input?.inputId || !payload.workId) throw new Error("Invalid dialogue acceptance");
    if (signal?.aborted) return payload;
    enabled.current = true;
    opened.current = true;
    setMode("dialogue");
    const next = projectAcceptedInput(state.current, payload.input);
    if (!next.works.has(payload.workId)) {
      const work: DialogueWork = { workId: payload.workId, inputId: payload.input.inputId, userSeq: payload.input.userSeq, status: "queued", runId: payload.runId };
      update({ ...next, works: new Map(next.works).set(work.workId, work) });
    } else update(next);
    refresh.current();
    return payload;
  }, [persona, update]);

  const stop = useCallback(async (workId?: string) => {
    const intent = ++expressionIntent.current;
    const response = await fetch("/api/chat/dialogue/stop", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona, ...(workId ? { workId } : {}) }), signal: lifetime.current?.signal,
    });
    if (!response.ok) throw new Error("Dialogue stop failed");
    if (!workId && intent === expressionIntent.current) setExpression("paused");
    refresh.current();
  }, [persona]);

  return { mode, opened: opened.current, expression, projection, submit, stop, newPublications };
}
