"use client";

import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { ConversationTurn } from "./conversation-turn";

/** Saved turns share the live manuscript's voice and reading measure. Their
 * timestamps remain visible on touch; the original cognition is still openable. */
export function HistoryTurn({
  role,
  content,
  sliceId,
  turnId,
  timestamp,
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
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
        <div className="conversation-prose conversation-prose--literal">{content}</div>
      ) : (
        <div className="conversation-prose">
          <MarkdownRenderer content={content} />
        </div>
      )}
    </ConversationTurn>
  );
}
