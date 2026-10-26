"use client";

import { MarkdownRenderer } from "./markdown";
import { nativeSourceVersion } from "@/lib/markdown/native-sections";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { ConversationTurn } from "./conversation-turn";
import { SubmittedDocumentReferences } from "@/components/documents/submitted-document-references";
import type { DocumentContextSnapshot } from "@/lib/chat/document-context";

/** Saved turns share the live manuscript's voice and reading measure. Their
 * timestamps remain visible on touch; the original cognition is still openable. */
export function HistoryTurn({
  role,
  content,
  sliceId,
  turnId,
  timestamp,
  documentContext,
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
  documentContext?: DocumentContextSnapshot;
  /** @deprecated Retired with the strand layer; accepted for old callers. */
  strands?: string[];
}) {
  const isUser = role === "user";

  return (
    <ConversationTurn
      role={role}
      metadata={
        <>
          <TimeDisplay
            timestamp={timestamp}
            mode={sameDay(timestamp) ? "time" : "full"}
          />
          {!isUser && turnId && (
            <CognitionPopover sliceId={sliceId} turnId={turnId} />
          )}
        </>
      }
    >
      {isUser ? (
        <>
          <SubmittedDocumentReferences references={documentContext ?? []} />
          <div className="conversation-prose conversation-prose--literal">{content}</div>
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
