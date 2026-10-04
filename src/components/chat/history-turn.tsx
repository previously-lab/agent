"use client";

import { Message, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { MarkdownRenderer } from "./markdown";
import { CognitionPopover } from "./cognition-popover";
import { TimeDisplay, sameDay } from "./time-display";
import { strandTint } from "@/lib/timeline3d/ink";

// ── Ink film (paper-and-ink material model) ─────────────────────────────
// The user bubble is PRINTED INK: a flat translucent film over the paper,
// NOT the shared STRAND_TINT_ALPHA (0.12) whisper the timeline cards use —
// that constant stays untouched outside this lane. INK_FILM_ALPHA covers
// ~70% of the tooth so a quarter to a third of the grain survives through
// the fill; INK_EDGE_ALPHA is the dot-gain boundary, the SAME hue at
// slightly higher opacity — never a light/dark relief pair.
//
// The film used to hue-shift with the owning slice's first strand. The
// strand layer is retired (§A.2.4) — the slice carries no strands — so the
// bubble prints in the ONE neutral strandless grey, always.

/** Interior film alpha — ~30% of the paper texture shows through. */
const INK_FILM_ALPHA = 0.7;
/** Dot-gain edge alpha — same hue, denser at the boundary. */
const INK_EDGE_ALPHA = 0.9;

/**
 * A single historical turn — pure body bubbles (design §1.2: history renders
 * as plain text, no tool state). Rendered by the unified message stream.
 *
 * The user bubble prints in the neutral strandless ink — the strand tint it
 * once took went with the strand layer (§A.2.4).
 */
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
  /** @deprecated Retired with the strand layer (§A.2.4) — accepted (the
   *  non-writable callers still pass it) and ignored. */
  strands?: string[];
}) {
  const isUser = role === "user";
  const userTint = isUser ? strandTint(undefined, INK_FILM_ALPHA) : undefined;
  const userTintEdge = isUser
    ? strandTint(undefined, INK_EDGE_ALPHA)
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
              // Neutral ink from JS — the film arrives as --user-tint and the
              // dot-gain edge as --user-tint-edge; .user-tint in globals.css
              // owns the fill, the ring utility owns the denser boundary. No
              // relief shadow either side. Agent turns stay variant="ghost":
              // prose ink printed straight on the sheet.
              className={
                userTint
                  ? "user-tint ring-1 ring-(--user-tint-edge)"
                  : undefined
              }
              style={
                userTint
                  ? ({
                      "--user-tint": userTint,
                      "--user-tint-edge": userTintEdge,
                    } as React.CSSProperties)
                  : undefined
              }
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
