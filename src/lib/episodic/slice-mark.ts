/**
 * Deterministic slice marking — the reliability backstop for close-marking.
 *
 * When the worker analyzer produces no `closed_marking` (call failure returns
 * EMPTY, or the model omits it), housekeeping fills focus/summary from the
 * slice's actual user and assistant text. The `[degraded]` prefix makes the
 * missing semantic pass explicit; turn counts and retired tags are not a
 * substitute for a directory description.
 *
 * Pure — no I/O, no LLM.
 */
import type { TimeSlice } from "./types";

export interface SliceMark {
  focus: string;
  summary: string;
}

const OPENING_MAX = 60;
const SUMMARY_TOPIC_MAX = 48;
const SUMMARY_REPLY_MAX = 56;

function openingOf(content: string, max: number): string {
  const opening = content.trim().split(/\n/)[0].replace(/\s+/g, " ").trim();
  return opening.length > max ? `${opening.slice(0, max)}…` : opening;
}

/** Content-derived, explicitly degraded navigation when no semantic mark exists. */
export function deterministicSliceMark(slice: TimeSlice): SliceMark {
  const firstUser = slice.turns.find((turn) => turn.role === "user" && turn.content.trim());
  const lastAgent = [...slice.turns].reverse().find((turn) => turn.role === "agent" && turn.content.trim());
  const topic = openingOf(firstUser?.content ?? lastAgent?.content ?? "", OPENING_MAX);
  if (!topic) {
    return {
      focus: "[degraded] 无法生成会话焦点",
      summary: "[degraded] 没有可用于生成目录的会话内容。",
    };
  }
  const focus = `${firstUser ? "用户提到" : "助手记录"}：${topic}`;
  const reply = lastAgent ? openingOf(lastAgent.content, SUMMARY_REPLY_MAX) : "";
  const shortTopic = openingOf(firstUser?.content ?? lastAgent?.content ?? "", SUMMARY_TOPIC_MAX);
  const summary = reply && reply !== topic
    ? `关于“${shortTopic}”，助手回应：“${reply}”`
    : `关于“${shortTopic}”的会话。`;
  return { focus, summary: `[degraded] ${summary}` };
}
