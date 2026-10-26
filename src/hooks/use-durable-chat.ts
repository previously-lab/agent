"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage, UIMessageChunk } from "@/lib/chat/protocol";
import type { ScreenContext } from "@/lib/chat/screen-context";
import { regenerationMessages } from "@/lib/chat/client-stream";
import { readDurableChat } from "@/lib/chat/client-transport";

export interface DurableChatOptions {
  messages: UIMessage[];
  resume?: boolean;
  getRunId: () => string | null;
  prepareBody: (messages: UIMessage[], regenerate: boolean, screen?: ScreenContext) => Record<string, unknown>;
  onRunStarted?: (response: Response, chatId: string) => void;
  onData?: (chunk: UIMessageChunk) => void;
  onFinish?: (event: { messages: UIMessage[] }) => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

/** Own one durable conversation lane. Parallel sends keep their independent
 * readers; the page's existing fold/recovery logic owns their seating. */
export function useDurableChat(options: DurableChatOptions) {
  const [messages, updateMessages] = useState(options.messages);
  const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready");
  const [error, setError] = useState<Error>();
  const latest = useRef(options);
  latest.current = options;
  const messagesRef = useRef(messages);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const chatId = useRef<string | null>(null);
  const cancelActive = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
  }, []);

  const setMessages = useCallback((value: UIMessage[] | ((previous: UIMessage[]) => UIMessage[])) => {
    const next = typeof value === "function" ? value(messagesRef.current) : value;
    messagesRef.current = next;
    updateMessages(next);
  }, []);

  const execute = useCallback(async (base: UIMessage[], mode: "send" | "regenerate" | "resume", screen?: ScreenContext) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const ticket = ++generation.current;
    const current = () => generation.current === ticket && !controller.signal.aborted;
    setError(undefined);
    setStatus("submitted");
    setMessages(base);
    let runId = mode === "resume" ? latest.current.getRunId() : null;
    let assistantId = runId ? `assistant-run-${runId}` : crypto.randomUUID();
    try {
      let response: Response | undefined;
      if (mode !== "resume") {
        chatId.current ??= crypto.randomUUID();
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(latest.current.prepareBody(base, mode === "regenerate", screen)),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error((await response.text()) || `Chat HTTP ${response.status}`);
        if (!current()) return;
        runId = response.headers.get("x-workflow-run-id");
        if (runId) assistantId = `assistant-run-${runId}`;
        latest.current.onRunStarted?.(response, chatId.current);
      }
      if (!response && !runId) { if (current()) setStatus("ready"); return; }
      setStatus("streaming");
      await readDurableChat({
        runId,
        assistantId,
        signal: controller.signal,
        response,
        onMessage: (answer) => { if (current()) setMessages([...base, answer]); },
        onData: (chunk) => { if (current()) latest.current.onData?.(chunk); },
      });
      if (current()) {
        setStatus("ready");
        latest.current.onFinish?.({ messages: messagesRef.current });
        latest.current.onEnd?.();
      }
    } catch (cause) {
      if (current()) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        setStatus("error");
        latest.current.onError?.(failure);
      }
    } finally {
      if (generation.current === ticket) active.current = null;
    }
  }, [setMessages]);

  useEffect(() => {
    if (latest.current.resume) void execute(latest.current.messages, "resume");
    return cancelActive;
  }, [execute, cancelActive]);

  const sendMessage = useCallback((message: { role?: "user"; parts: UIMessage["parts"]; id?: string }, screen?: ScreenContext) => {
    const next: UIMessage = { ...message, id: message.id ?? crypto.randomUUID(), role: "user" };
    return execute([...messagesRef.current, next], "send", screen);
  }, [execute]);

  const regenerate = useCallback((request: { messageId?: string } = {}, screen?: ScreenContext) => {
    return execute(regenerationMessages(messagesRef.current, request.messageId), "regenerate", screen);
  }, [execute]);

  const stop = useCallback(() => {
    cancelActive();
    setStatus("ready");
  }, [cancelActive]);

  return { messages, setMessages, status, error, sendMessage, regenerate, stop };
}
