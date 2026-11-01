"use client";

import type { RecordTurnContent } from "@/lib/archive/actions";
import { MarkdownRenderer } from "@/components/chat/markdown";
import { ConversationTurn } from "@/components/chat/conversation-turn";
import { SubmittedDocumentReferences } from "./submitted-document-references";

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
      <ConversationTurn role={turn.role} speaker={speaker}>
        <div data-no-selection>
          <SubmittedDocumentReferences references={turn.documentContext ?? []} />
        </div>
        <div className="conversation-prose">
          <MarkdownRenderer
            content={turn.content}
            nativeMode="paper"
            nativeTurnId={`${docRef}:${turn.turnId ?? turn.index}:${turn.role}`}
          />
        </div>
      </ConversationTurn>
    </section>
  );
}
