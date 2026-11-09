"use client";

import type { ContentBlockV1 } from "@/lib/chat/dialogue-contract";
import type { UIMessagePart } from "@/lib/chat/protocol";
import { ConversationTurn } from "./conversation-turn";
import { DialogueWorkCaption } from "./dialogue-work-caption";
import { DialogueContent } from "./dialogue-utterance";
import { MarkdownRenderer } from "./markdown";
import { MessageActions } from "./message-actions";
import type { DialogueWorkSeat } from "./dialogue-stream-rows";

/** A work keeps the same message seat from its first caption through its
 * contiguous public replies. Its preview never migrates into another prompt. */
export function DialogueWorkTurn({ seat: { work, replying, replies = [] }, persona, onCancel, onRetry, onResume }: {
  seat: DialogueWorkSeat;
  persona: string;
  onCancel: (workId: string) => Promise<void>;
  onRetry: (inputId: string) => Promise<void> | void;
  onResume: () => void;
}) {
  const streaming = replies.some(reply => reply.kind === "message" && reply.isStreaming);
  const text = replies.map(reply => reply.kind === "utterance"
    ? reply.utterance.blocks.flatMap(block => block.kind === "markdown" ? [block.text] : []).join("\n\n")
    : reply.message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n")).filter(Boolean).join("\n\n");
  const blocks = replies.flatMap<ContentBlockV1 | UIMessagePart>(reply => reply.kind === "utterance" ? reply.utterance.blocks : reply.message.parts);
  return <div className="conversation-stream-row dialogue-publication" data-dialogue-work-turn={work.workId} data-dialogue-reply={work.inputId}>
    <ConversationTurn role="assistant">
      <DialogueWorkCaption work={work} persona={persona} replying={replying}
        onCancel={onCancel} onRetry={onRetry} onResume={onResume} />
      <div className="dialogue-continuous-reply">
        {replies.map(reply => reply.kind === "utterance" ? <div className="dialogue-publication" key={reply.id}
          data-public-utterance={reply.utterance.utteranceId} data-public-seq={reply.utterance.publicSeq}>
          <DialogueContent blocks={reply.utterance.blocks} mode="interactive" artifactBodies={reply.artifactBodies} />
        </div> : <div className="conversation-prose" key={reply.id} data-dialogue-message={reply.id}>
          <MarkdownRenderer content={reply.message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n")} isStreaming={reply.isStreaming} />
        </div>)}
      </div>
      {blocks.length > 0 && !streaming ? <MessageActions content={text} response={JSON.stringify(blocks, null, 2)} onRegenerate={() => void onRetry(work.inputId)} /> : null}
    </ConversationTurn>
  </div>;
}
