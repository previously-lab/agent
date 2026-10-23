"use client";

/**
 * Parallel lanes (v0.33 §6) — the client half of 连发并行.
 *
 * While a turn streams, sending again starts ANOTHER standard turn run. One
 * lane has its own independent reader, so second-and-later sends live
 * here as BYPASS lanes: a direct POST /api/chat, then the lane reads the new
 * run's durable stream (`/api/chat/<runId>/stream?startIndex=0`) itself —
 * the NestedBubble child-stream precedent. The batch's closing beat
 * (v0.38 §3.2) is no longer a separate run: the LAST finisher's tail
 * generates the merge line itself and announces it as a transient
 * `data-parallel-summary` chunk CARRYING THE TEXT ({sliceId, text} —
 * forwarded by both the useDurableChat onData and every lane reader, since the last
 * finisher may itself be a bypass lane). The client seats it as the summary
 * lane directly — 收合句独立泡, 可空 = 没有这个泡 (v0.40 §2.1).
 *
 * The lane readers are owned by ONE effect in the page (useParallelLaneReaders),
 * not by the views: the virtualized list unmounts scrolled-out rows, and a
 * dead reader would never report its settle — the post-burst fold would
 * stall. Readers survive collapse and windowing; views are stateless renders
 * of the seat (stream-items.ts ParallelLaneSeat).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Split, WrapText } from "lucide-react";
import { Message, MessageContent } from "@/components/ui/message";
import { MarkdownRenderer } from "./markdown";
import { PARALLEL_SUMMARY_CHUNK } from "@/lib/chat/parallel-runs";
import { PERSISTENCE_HANDOFF_CHUNK } from "@/lib/chat/turn-types";
import { rememberSummaryRun } from "@/lib/chat/persistence";
import { readDurableChat } from "@/lib/chat/client-transport";
import type { UIMessage } from "@/lib/chat/protocol";
import { rememberNativeReplay } from "@/lib/chat/native-replay";
import type { ParallelLaneSeat } from "@/lib/chat/stream-items";

/** One lane as the page's side store holds it. The seat the list renders
 *  (ParallelLaneSeat) is derived from this plus the collapse verdict. */
export interface ParallelLane {
  /** "main" for the collapsed useDurableChat lane; the client-minted message id for
   *  bypass lanes; the runId for the summary lane. */
  laneId: string;
  /** The durable run to read — patched in when the POST's header lands. */
  runId?: string;
  /** The echoed user message ("" for the summary lane). */
  userText: string;
  /** The batch-closing lane. */
  summary?: boolean;
  /** Live/settled answer text — the reader patches this per network batch. */
  text: string;
  /** Original completed message, including replay data. */
  message?: UIMessage;
  /** The stream ended (or degraded) — the fold gate reads this. */
  settled: boolean;
}

interface LaneStreamHandlers {
  signal: AbortSignal;
  onText: (text: string) => void;
  onMessage?: (message: UIMessage) => void;
  /** The last finisher's merge line (v0.40 §2.1) — the chunk carries the
   *  TEXT itself; absent when the batch needed no closing (可空). */
  onMergeLine: (sliceId: string, text: string) => void;
}

/** Read a bypass with the same replay, completion and abort guarantees as the
 * main lane. Every reconnect rebuilds from index zero without doubling text. */
export async function readLaneStream(
  runId: string,
  { signal, onText, onMessage, onMergeLine }: LaneStreamHandlers,
): Promise<string> {
  const message = await readDurableChat({
    runId,
    assistantId: `ans-${runId}`,
    signal,
    onMessage: (answer) => {
      onText(answer.parts.filter((part) => part.type === "text").map((part) => part.text.trim()).filter(Boolean).join("\n\n"));
      onMessage?.(answer);
    },
    onData: (chunk) => {
      const data = chunk.data as { summaryRunId?: unknown; sliceId?: unknown; text?: unknown } | undefined;
      if (chunk.type === PERSISTENCE_HANDOFF_CHUNK && typeof data?.summaryRunId === "string") rememberSummaryRun(data.summaryRunId);
      if (chunk.type === PARALLEL_SUMMARY_CHUNK && typeof data?.text === "string" && data.text.trim()) onMergeLine(typeof data.sliceId === "string" ? data.sliceId : "", data.text);
    },
  });
  return message.parts.filter((part) => part.type === "text").map((part) => part.text.trim()).filter(Boolean).join("\n\n");
}

/**
 * Seat the last finisher's merge line as the batch's summary lane
 * (v0.40 §2.1 — 收合句独立泡). PURE and idempotent: a reconnect replay
 * re-delivers the chunk and must never double-seat. 可空 is expressed by
 * NEVER calling this — no chunk, no lane, no bubble, no placeholder.
 */
export function upsertMergeLane(
  lanes: readonly ParallelLane[],
  sliceId: string,
  text: string,
): ParallelLane[] {
  const laneId = `merge-${sliceId || "batch"}`;
  if (lanes.some((l) => l.laneId === laneId)) return [...lanes];
  return [
    ...lanes,
    {
      laneId,
      userText: "",
      summary: true,
      text,
      settled: true, // the text ARRIVES whole — nothing streams
    },
  ];
}

/**
 * Own every lane's reader in ONE effect — started once per runId, aborted
 * when the lane disappears (the post-settle fold) or the page unmounts.
 * `patchLane`/`onMergeLine` ride refs so a delta's state write (which
 * rebuilds `lanes` and re-runs the effect) never restarts a live reader.
 */
export function useParallelLaneReaders(
  lanes: readonly ParallelLane[],
  patchLane: (
    laneId: string,
    patch: Partial<Pick<ParallelLane, "text" | "settled" | "runId" | "message">>,
  ) => void,
  onMergeLine: (sliceId: string, text: string) => void,
): void {
  const activeRef = useRef<Map<string, AbortController>>(new Map());
  const patchRef = useRef(patchLane);
  patchRef.current = patchLane;
  const mergeRef = useRef(onMergeLine);
  mergeRef.current = onMergeLine;

  useEffect(() => {
    const active = activeRef.current;
    for (const lane of lanes) {
      if (!lane.runId || lane.settled || active.has(lane.laneId)) continue;
      const ac = new AbortController();
      active.set(lane.laneId, ac);
      let completedMessage: UIMessage | undefined;
      readLaneStream(lane.runId, {
        signal: ac.signal,
        onText: (text) => patchRef.current(lane.laneId, { text }),
        onMessage: (message) => { completedMessage = message; },
        onMergeLine: (sliceId, text) => mergeRef.current(sliceId, text),
      })
        .then((text) => {
          activeRef.current.delete(lane.laneId);
          if (ac.signal.aborted) return;
          if (completedMessage) rememberNativeReplay([{ id: lane.laneId, role: "user", parts: [{ type: "text", text: lane.userText }] }, completedMessage]);
          patchRef.current(lane.laneId, { text, message: completedMessage, settled: true });
        })
        .catch(() => {
          // Aborted (fold/unmount) or the stream dropped — settle with
          // whatever text accumulated; the slice holds the real record.
          activeRef.current.delete(lane.laneId);
          if (!ac.signal.aborted) patchRef.current(lane.laneId, { settled: true });
        });
    }
    for (const [laneId, ac] of active) {
      if (!lanes.some((l) => l.laneId === laneId && !l.settled)) {
        ac.abort();
        active.delete(laneId);
      }
    }
  }, [lanes]);

  useEffect(() => {
    const active = activeRef.current;
    return () => {
      for (const ac of active.values()) ac.abort();
      active.clear();
    };
  }, []);
}

/**
 * One lane's block. Expanded (the newest lane): the echoed user line above
 * the streaming answer in the assistant's clothes. Collapsed (older lanes):
 * a one-row mini-block — the message is never lost, it folds. The collapse
 * verdict comes from the page (newest expands); a manual toggle overrides it
 * until the verdict changes again (a newer lane arrives).
 */
export function ParallelLaneView({ lane }: { lane: ParallelLaneSeat }) {
  const t = useTranslations("chat.parallel");
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [lane.collapsed]);
  const collapsed = override ?? lane.collapsed;
  const label = lane.summary ? t("summaryLabel") : t("laneLabel");
  const excerptSource = lane.userText || lane.text;
  const excerpt =
    excerptSource.length <= 40 ? excerptSource : `${excerptSource.slice(0, 40)}…`;

  return (
    <div
      className="py-1"
      data-parallel-lane={lane.laneId}
      data-lane-status={lane.settled ? "settled" : "streaming"}
      {...(lane.summary ? { "data-lane-summary": "true" } : {})}
    >
      <Message align="start" className="gap-1">
        <MessageContent className="min-w-0">
          <button
            type="button"
            onClick={() => setOverride(collapsed ? false : true)}
            aria-label={collapsed ? t("expand") : t("collapse")}
            className="mb-1 flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {collapsed ? (
              <ChevronRight className="size-3 shrink-0" />
            ) : (
              <ChevronDown className="size-3 shrink-0" />
            )}
            {lane.summary ? (
              <WrapText className="size-3 shrink-0" />
            ) : (
              <Split className="size-3 shrink-0" />
            )}
            <span className="shrink-0">{label}</span>
            {!lane.settled && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-brand-500/70" />
                {t("running")}
              </span>
            )}
            {collapsed && excerpt && (
              <span className="min-w-0 truncate">{excerpt}</span>
            )}
          </button>
          {!collapsed && (
            <div className="border-l-2 border-paper-line pl-3">
              {lane.userText && (
                <div className="mb-1 text-xs text-muted-foreground">
                  {lane.userText}
                </div>
              )}
              {lane.text ? (
                <div className="font-serif font-light">
                  <MarkdownRenderer content={lane.text} />
                </div>
              ) : (
                !lane.settled && (
                  <div className="text-xs text-muted-foreground">
                    {t("running")}
                  </div>
                )
              )}
            </div>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}
