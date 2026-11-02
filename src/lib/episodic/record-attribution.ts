/** Source attribution for model-facing records. No I/O or semantic classification. */
import type { ModelMessage } from "@/lib/deepseek/types";
import { projectNativeReplySemantics } from "@/lib/markdown/native-reply-semantics";
import { applyRange, parseTurns } from "./turn-parser";

export const RECORD_ATTRIBUTION_RULE =
  "Source role identifies who authored a turn, not who endorses every sentence. " +
  "A user turn may quote someone else, reject a suggestion, ask a hypothetical question, or confirm it; preserve that context. " +
  "Assistant proposals, inferences, tool output, archive titles/summaries and derived profiles are not user-confirmed facts. " +
  "Only explicit user evidence supports user confirmation; silence, repetition by an assistant, and a successful source read do not. " +
  "Keep contrary evidence and distinguish what was said from your interpretation when writing summaries or semantic documents.";

export function conversationRole(role: string): "user" | "assistant" | null {
  if (role === "user") return "user";
  if (role === "agent" || role === "assistant") return "assistant";
  return null;
}

/** Legacy/unrecognized roles cannot become user wire messages by default. */
export function recordTurnsToMessages(turns: Array<{ role: string; content: string }>): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let gap = false;
  for (const turn of turns) {
    const role = conversationRole(turn.role);
    if (role) {
      messages.push({ role, content: turn.content });
      gap = false;
    } else if (!gap) {
      messages.push({
      role: "assistant",
      content: "[Archive provenance notice — host-generated, not an archived utterance or evidence] A non-conversation or unattributed source interval was omitted here. Do not infer user speech, agreement or continuity across this gap.",
      });
      gap = true;
    }
  }
  return messages;
}

type SourceTurn = { role: string; sourceRole?: string; content: string; turnId?: string; timestamp?: string; index?: number; boundary?: string; attachments?: import("@/lib/chat/image-attachments").ImageAttachmentSnapshot[] };

export function attributedTurn(turn: SourceTurn, maxChars?: number) {
  const content = projectNativeReplySemantics(turn.content, turn.role);
  const clipped = maxChars !== undefined && content.length > maxChars;
  return {
    role: conversationRole(turn.role) ?? turn.role,
    sourceRole: turn.sourceRole ?? turn.role,
    ...(turn.boundary ? { boundary: turn.boundary } : {}),
    ...(turn.index !== undefined ? { turnIndex: turn.index } : {}),
    ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}),
    ...(turn.timestamp !== undefined ? { timestamp: turn.timestamp } : {}),
    ...(turn.attachments?.length ? { attachments: { kind: "attachment_metadata_not_speech", items: turn.attachments } } : {}),
    content: clipped ? content.slice(0, maxChars) : content,
    contentTruncated: clipped,
  };
}

/** JSON escaping keeps authored newlines/role labels inside their source turn. */
export function renderAttributedTurns(turns: SourceTurn[], maxChars?: number): string {
  return JSON.stringify(turns.map((turn) => attributedTurn(turn, maxChars)));
}

export function renderAttributedRecord(ref: string, raw: string, range?: Parameters<typeof applyRange>[1]): string {
  const { frontmatter, turns } = parseTurns(raw);
  const selected = range ? applyRange(turns, range) : turns;
  return JSON.stringify({
    source: { ref, kind: "conversation_record" },
    metadata: { kind: "archive_metadata_not_speech", content: frontmatter },
    coverage: { totalTurns: turns.length, selectedTurns: selected.length, ...(range ? { range } : {}) },
    turns: selected.map((turn) => attributedTurn(turn)),
  });
}
