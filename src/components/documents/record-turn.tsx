"use client";

import type { RecordTurnContent } from "@/lib/archive/actions";
import { MarkdownRenderer } from "@/components/chat/markdown";
import { ConversationTurn } from "@/components/chat/conversation-turn";
import { ConversationImageBody } from "@/components/chat/conversation-images";
import { SubmittedDocumentReferences } from "./submitted-document-references";
import { DialogueContent } from "@/components/chat/dialogue-utterance";

export function RecordTurnView({
  docRef,
  turn,
  speaker,
  focused,
}: {
  docRef: string;
  turn: RecordTurnContent;
  speaker: string;
  focused: boolean;
}): React.JSX.Element {
  return (
    <section
      className="document-record-turn"
      data-record-turn-index={turn.index}
      data-turn-id={turn.turnId}
      data-turn-role={turn.role}
      data-reading-focus={focused || undefined}
    >
      <ConversationTurn role={turn.role} speaker={speaker} metadata={turn.sourceRole && turn.role !== "user" && turn.role !== "assistant" ? turn.sourceRole : undefined}>
        <div data-no-selection>
          <SubmittedDocumentReferences references={turn.documentContext ?? []} />
        </div>
        {turn.role === "assistant" && turn.dialogue?.kind === "public_utterance" ? (
          <div data-public-utterance={turn.dialogue.publicationId} data-public-seq={turn.dialogue.publicSeq}>
            <DialogueContent blocks={turn.dialogue.blocks} mode="reader"
              artifactBodies={turn.artifactBodies ? new Map(Object.entries(turn.artifactBodies)) : undefined} />
          </div>
        ) : turn.role !== "assistant" ? <ConversationImageBody content={turn.content} images={turn.attachments ?? []} /> : <div className="conversation-prose">
          <MarkdownRenderer
            content={turn.content}
            nativeMode={turn.role === "assistant" ? "reader" : undefined}
            nativeTurnId={turn.turnId ?? `${docRef}:${turn.index}:${turn.role}`}
          />
        </div>}
      </ConversationTurn>
    </section>
  );
}
