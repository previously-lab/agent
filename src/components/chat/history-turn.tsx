"use client";

import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { strandTint, STRAND_TINT_ALPHA } from "@/lib/timeline3d/layout";

/**
 * A single historical turn — pure body bubbles (design §1.2: history renders
 * as plain text, no tool state). Rendered by the unified message stream.
 *
 * The user bubble tints with the owning slice's FIRST strand (the same
 * accent the timeline cards use, via layout.ts's shared helpers); a
 * strandless slice tints with the neutral strandless grey.
 */
export function HistoryTurn({
  role,
  content,
  sliceId,
  turnId,
  timestamp,
  strands,
}: {
  role: string;
  content: string;
  sliceId: string;
  turnId?: string;
  timestamp: string;
  /** The owning slice's strands (always set for history items). */
  strands?: string[];
}) {
  const isUser = role === "user";
  const userTint = isUser
    ? strandTint(strands?.[0], STRAND_TINT_ALPHA)
    : undefined;

  return (
    <div className="py-1.5">
      <Message align={isUser ? "end" : "start"} className="gap-1">
        <MessageContent className="min-w-0">
          <Bubble variant={isUser ? "secondary" : "ghost"}>
            {/* Header row: [timestamp ·] 思考. The timestamp auto-hides —
                the time rail / mobile indicator are the always-on time
                channels — and fades in on bubble hover or keyboard focus.
                Only opacity changes (the row keeps its height, no scroll
                jump); the 思考 trigger stays visible. Touch has no hover:
                it simply stays hidden. */}
            <div className={`flex items-center gap-1.5 mb-1 font-mono text-[0.6rem] text-muted-foreground/50 ${isUser ? "justify-end" : ""}`}>
              <span
                tabIndex={0}
                className="inline-flex items-center gap-1.5 opacity-0 transition-opacity duration-150 motion-reduce:transition-none group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100"
              >
                <TimeDisplay
                  timestamp={timestamp}
                  mode={sameDay(timestamp) ? "time" : "full"}
                />
                {!isUser && turnId && <span aria-hidden>·</span>}
              </span>
              {!isUser && turnId && (
                <CognitionPopover sliceId={sliceId} turnId={turnId} />
              )}
            </div>
            <BubbleContent
              style={userTint ? { backgroundColor: userTint } : undefined}
            >
              {isUser ? (
                <span className="whitespace-pre-wrap text-sm font-serif font-light">{content}</span>
              ) : (
                <div className="font-serif font-light">
                  <MarkdownRenderer content={content} />
                </div>
              )}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </div>
  );
}
