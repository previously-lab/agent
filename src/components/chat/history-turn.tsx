"use client";

import { MarkdownRenderer } from "./markdown";
import { nativeSourceVersion } from "@/lib/markdown/native-sections";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { ConversationTurn } from "./conversation-turn";
import { MessageActions } from "./message-actions";
import { SubmittedDocumentReferences } from "@/components/documents/submitted-document-references";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { ConversationImageBody } from "./conversation-images";
import type { DialogueRecordTurn } from "@/lib/episodic/dialogue-record";
import type { Turn } from "@/lib/episodic/types";
import { DialogueContent } from "./dialogue-utterance";

/** Saved turns share the live manuscript's voice and reading measure. Their
 * timestamps remain visible on touch; the original cognition is still openable. */
export function HistoryTurn({
  role,
  content,
  sliceId,
  turnId,
  timestamp,
  documentContext,
  attachments = [],
  sourceRole,
  dialogue,
  artifactBodies,
  continuations = [],
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
  documentContext?: DocumentContextSnapshot;
  attachments?: readonly ImageAttachmentSnapshot[];
  sourceRole?: string;
  dialogue?: DialogueRecordTurn;
  artifactBodies?: Readonly<Record<string, string>>;
  continuations?: readonly Turn[];
  /** @deprecated Retired with the strand layer; accepted for old callers. */
  strands?: string[];
}) {
  const isUser = role === "user";
  const isAgent = role === "agent" || role === "assistant";
  const publications = dialogue?.kind === "public_utterance" ? [
    { dialogue, artifactBodies },
    ...continuations.flatMap(turn => turn.dialogue?.kind === "public_utterance"
      ? [{ dialogue: turn.dialogue, artifactBodies: turn.artifactBodies }] : []),
  ] : undefined;
  const blocks = publications?.flatMap(publication => publication.dialogue.blocks);
  const copyContent = [content, ...continuations.map(turn => turn.content)].filter(Boolean).join("\n\n");

  return (
    <ConversationTurn
      role={role}
      metadata={
        <>
          <TimeDisplay
            timestamp={timestamp}
            mode={sameDay(timestamp) ? "time" : "full"}
          />
          {sourceRole && !isUser && !isAgent && <span>{sourceRole}</span>}
          {isAgent && turnId && (
            <CognitionPopover sliceId={sliceId} turnId={turnId} />
          )}
          {continuations.map(continuation => <span key={continuation.turnId ?? continuation.timestamp}>
            <TimeDisplay timestamp={continuation.timestamp} mode={sameDay(continuation.timestamp) ? "time" : "full"} />
            {continuation.turnId && <CognitionPopover sliceId={sliceId} turnId={continuation.turnId} />}
          </span>)}
        </>
      }
    >
      {!isAgent ? (
        <>
          <SubmittedDocumentReferences references={documentContext ?? []} />
          <ConversationImageBody content={content} images={attachments} />
        </>
      ) : publications ? (
        <div className="dialogue-continuous-reply" data-dialogue-reply={publications[0]?.dialogue.inputIds.join(":")}>
          {publications.map(publication => <div className="dialogue-publication" key={publication.dialogue.publicationId}
            data-public-utterance={publication.dialogue.publicationId} data-public-seq={publication.dialogue.publicSeq}>
            <DialogueContent blocks={publication.dialogue.blocks} mode="interactive"
              artifactBodies={publication.artifactBodies ? new Map(Object.entries(publication.artifactBodies)) : undefined} />
          </div>)}
        </div>
      ) : (
        <div className="conversation-prose">
          <MarkdownRenderer
            content={content}
            nativeMode="interactive"
            nativeTurnId={turnId ?? `${timestamp}:${nativeSourceVersion(content)}`}
          />
        </div>
      )}
      {isAgent && (copyContent || blocks?.length) ? <MessageActions content={copyContent}
        response={blocks ? JSON.stringify(blocks, null, 2) : undefined} /> : null}
    </ConversationTurn>
  );
}
