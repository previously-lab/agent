"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { UIMessage } from "ai";

/**
 * Durable loop streams recognized by this watcher. Avoids duplicate
 * subscriptions across renders — each loop runId connects exactly once.
 */
const seen = new Set<string>();

interface LoopProgressChunk {
  loopId: string;
  goal: string;
  status: string;
  iteration: number;
  latestStep: { action: string; result: string } | null;
  done: boolean;
}

/**
 * Watch for completed `startLoop` tool calls in the chat message list and
 * subscribe to each loop's durable stream. When the stream carries a `done`
 * chunk, dismiss the loading toast and present the result the same way the
 * agent would — as a summary of what the loop accomplished.
 *
 * Renders nothing — side-effects only (toasts).
 */
export function LoopWatcher({ messages }: { messages: UIMessage[] }) {
  // Stable ref so the effect doesn't re-fire when messages shift
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    let cancelled = false;

    async function connectAndWatch(runId: string, loopId: string, goal: string) {
      if (seen.has(runId)) return;
      seen.add(runId);

      const toastId = `loop-${loopId}`;
      toast.loading(`Loop: ${goal.slice(0, 60)}…`, { id: toastId, duration: Infinity });

      try {
        const res = await fetch(`/api/loops/${encodeURIComponent(runId)}/stream?startIndex=0`);
        if (!res.ok || !res.body) {
          toast.error(`Loop stream unavailable (${res.status})`, { id: toastId });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (cancelled) { reader.cancel(); break; }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const chunk = JSON.parse(line.slice(6)) as
                | { type: string; data?: LoopProgressChunk }
                | undefined;
              if (chunk?.type === "data-loop" && chunk.data) {
                const d = chunk.data;
                if (d.done) {
                  const statusLabel =
                    d.status === "completed" ? "Finished"
                    : d.status === "stuck" ? "Stalled"
                    : d.status === "timeout" ? "Timed out"
                    : d.status === "failed" ? "Failed"
                    : d.status;
                  const lastAction = d.latestStep?.action ?? "no steps recorded";
                  toast.success(`${statusLabel}: ${d.goal.slice(0, 50)}`, {
                    id: toastId,
                    description: lastAction,
                    duration: 8000,
                  });
                  return; // stream is done
                }
                // Otherwise still running — update the loading toast subtitle
                if (d.latestStep) {
                  toast.loading(`Loop: ${d.goal.slice(0, 60)}…`, {
                    id: toastId,
                    description: `Step ${d.iteration}: ${d.latestStep.action}`,
                    duration: Infinity,
                  });
                }
              }
            } catch {
              // Skip unparseable lines at stream edges
            }
          }
        }

        // Stream ended without a `done` chunk (interrupted / cancelled).
        toast.error(`Loop interrupted: ${goal.slice(0, 50)}`, {
          id: toastId,
          description: "The run ended without a completion signal.",
          duration: 8000,
        });
      } catch (err) {
        toast.error(`Loop connection lost: ${goal.slice(0, 50)}`, {
          id: toastId,
          description: err instanceof Error ? err.message : undefined,
          duration: 8000,
        });
      }
    }

    // Scan the latest message for freshly-completed startLoop tool calls.
    // Only the last message matters — prior messages were already scanned.
    const latest = messagesRef.current[messagesRef.current.length - 1];
    if (!latest || latest.role !== "assistant") return;

    for (const part of (latest as { parts?: Array<{ type?: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown }> }).parts ?? []) {
      if (
        part.type === "tool-startLoop" &&
        part.state === "result" &&
        typeof (part.output as Record<string, unknown> | null)?.runId === "string"
      ) {
        const output = part.output as { runId: string; loopId: string; goal?: string };
        // goal is embedded in the tool input
        const input = (part.input as { goal?: string } | undefined) ?? {};
        const goal = input.goal ?? "background task";
        connectAndWatch(output.runId, output.loopId, goal);
      }
    }

    // Cleanup: cancel all inflight fetch readers when the component unmounts.
    return () => { cancelled = true; };
  }, []);

  return null;
}
