"use client";

import { ConversationTurn } from "./conversation-turn";
import { DialogueWorkCaption } from "./dialogue-work-caption";
import { DialogueContent } from "./dialogue-utterance";
import { MarkdownRenderer } from "./markdown";
import { MessageActions } from "./message-actions";
import type { DialogueWorkSeat } from "./dialogue-stream-rows";

/** A work keeps the same message seat from its first caption through its
 * first public reply. Its preview never migrates into another prompt. */
export function DialogueWorkTurn({ seat: { work, reply }, persona, onCancel, onRetry, onResume }: {
  seat: DialogueWorkSeat;
  persona: string;
  onCancel: (workId: string) => Promise<void>;
  onRetry: (inputId: string) => Promise<void> | void;
  onResume: () => void;
}) {
  const publication = reply?.kind === "utterance" ? reply : undefined;
  const message = reply?.kind === "message" ? reply : undefined;
  const text = publication ? publication.utterance.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n")
    : message?.message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n") ?? "";
  return <div className="conversation-stream-row dialogue-publication" data-dialogue-work-turn={work.workId} data-public-utterance={publication?.utterance.utteranceId}
    data-public-seq={publication?.utterance.publicSeq}>
    <ConversationTurn role="assistant">
      <DialogueWorkCaption work={work} persona={persona} replying={message?.isStreaming ?? false}
        onCancel={onCancel} onRetry={onRetry} onResume={onResume} />
      {publication ? <DialogueContent blocks={publication.utterance.blocks} mode="interactive" artifactBodies={publication.artifactBodies} />
        : text ? <div className="conversation-prose"><MarkdownRenderer content={text} isStreaming={message?.isStreaming} /></div> : null}
      {text && !message?.isStreaming && <MessageActions content={text} onRegenerate={() => void onRetry(work.inputId)} />}
    </ConversationTurn>
  </div>;
}
