"use client";

import { MarkdownRenderer } from "./markdown";
import { nativeSourceVersion } from "@/lib/markdown/native-sections";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { ConversationTurn } from "./conversation-turn";
import { SubmittedDocumentReferences } from "@/components/documents/submitted-document-references";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";
import type { ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { ConversationImageBody } from "./conversation-images";

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
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
  documentContext?: DocumentContextSnapshot;
  attachments?: readonly ImageAttachmentSnapshot[];
  sourceRole?: string;
  /** @deprecated Retired with the strand layer; accepted for old callers. */
  strands?: string[];
}) {
  const isUser = role === "user";
  const isAgent = role === "agent" || role === "assistant";

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
        </>
      }
    >
      {!isAgent ? (
        <>
          <SubmittedDocumentReferences references={documentContext ?? []} />
          <ConversationImageBody content={content} images={attachments} />
        </>
      ) : (
        <div className="conversation-prose">
          <MarkdownRenderer
            content={content}
            nativeMode="interactive"
            nativeTurnId={turnId ?? `${timestamp}:${nativeSourceVersion(content)}`}
          />
        </div>
      )}
    </ConversationTurn>
  );
}
