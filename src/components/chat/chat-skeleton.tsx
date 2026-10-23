"use client";

/**
 * Arrival skeletons — the loading face of the chat view.
 *
 * THE ONE RULE: A SKELETON MUST OCCUPY THE SPACE IT IS STANDING IN FOR. A
 * loading face that is merely "the same kind of thing" still makes the page
 * jump when the real content lands, and the jump is the part a reader notices.
 * The shared conversation-stream-shell and conversation-stream-row classes
 * supply the same reading width and gutters as the measured live list.
 *
 * TWO SEATS, ONE IDENTITY:
 * - `ChatPageSkeleton` fills the right pane BEFORE the mount-time arrival
 *   verdict lands (chat-page renders nothing until then).
 * - `ChatStreamSkeleton` covers the pane as an overlay AFTER the verdict, while
 *   the mount fetches are still in flight.
 *
 * MOTION. Every bar pulses, but on a staggered delay by row, so the column
 * reads as one gesture travelling down rather than a field of lights blinking
 * in unison — the unison version is what makes a skeleton read as a placeholder
 * instead of as loading. Everything carries `motion-reduce:animate-none`.
 */

import { useChromeInset } from "@/hooks/use-chrome-inset";
import "./writing.css";

/** A pulsing bar. `delay` staggers it against its neighbours — see MOTION. */
function Bar({
  className = "",
  delay = 0,
}: {
  className?: string;
  delay?: number;
}) {
  return (
    <div
      aria-hidden
      // Stagger delay from the row's position in the tuned table — CSS
      // owns the delay via .pulse-delay.
      style={
        delay
          ? ({ "--pulse-delay": `${delay}ms` } as React.CSSProperties)
          : undefined
      }
      className={`pulse-delay rounded-full animate-pulse motion-reduce:animate-none bg-foreground/8 ${className}`}
    />
  );
}

/** A boundary-seam skeleton — hairline + centered date pill, like SliceSeam. */
function SeamSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div aria-hidden className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span
        // Stagger delay from the seam's position — CSS owns it via
        // .pulse-delay.
        style={
          delay
            ? ({ "--pulse-delay": `${delay}ms` } as React.CSSProperties)
            : undefined
        }
        className="pulse-delay h-5 w-28 rounded-full bg-muted animate-pulse motion-reduce:animate-none"
      />
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The resume-banner skeleton — a centered brand pill, like ResumeBanner. */
function ResumeBannerSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div aria-hidden className="my-4 flex justify-center">
      <span
        // Stagger delay from the banner's position — CSS owns it via
        // .pulse-delay.
        style={
          delay
            ? ({ "--pulse-delay": `${delay}ms` } as React.CSSProperties)
            : undefined
        }
        className="pulse-delay h-6 w-52 rounded-full bg-brand-500/10 animate-pulse motion-reduce:animate-none"
      />
    </div>
  );
}

const PROSE_HEIGHT = {
  1: "h-[2.25rem]",
  2: "h-[3.5rem]",
  3: "h-[4.75rem]",
} as const;

/** Both voices share a prose column, with room for the desktop byline. */
function RoundSkeleton({
  userLines = 1,
  userWidth = "w-[42%]",
  agentLines = 2,
  agentWidth = "w-[62%]",
  delay = 0,
}: {
  userLines?: 1 | 2 | 3;
  userWidth?: string;
  agentLines?: 1 | 2 | 3;
  agentWidth?: string;
  delay?: number;
}) {
  return (
    <div aria-hidden className="space-y-6 py-5 md:pl-30">
      <div
        // Stagger delays from the round's position — CSS owns them via
        // .pulse-delay.
        style={
          delay
            ? ({ "--pulse-delay": `${delay}ms` } as React.CSSProperties)
            : undefined
        }
        className={`pulse-delay rounded-sm bg-foreground/6 animate-pulse motion-reduce:animate-none ${PROSE_HEIGHT[userLines]} ${userWidth}`}
      />
      <div
        style={
          { "--pulse-delay": `${delay + 90}ms` } as React.CSSProperties
        }
        className={`pulse-delay rounded-sm animate-pulse motion-reduce:animate-none bg-foreground/8 ${PROSE_HEIGHT[agentLines]} ${agentWidth}`}
      />
    </div>
  );
}

/**
 * EmptyBriefing's introduction, with its eyebrow, title, ledger and actions.
 */
export function BriefingCardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col items-center px-4 py-10">
      <div className="relative w-full max-w-xl overflow-hidden">
        <div className="relative px-5 py-5 sm:px-6">
          {/* Eyebrow row — marker square + label bar + timecode bar. */}
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary/70" />
            <Bar className="h-2.5 w-24" />
            <Bar className="ml-auto h-2.5 w-20" delay={120} />
          </div>

          <div className="mt-4 h-px w-full bg-foreground/[0.07]" />

          {/* Serif title bar (the user's name). */}
          <div
            aria-hidden
            className="pulse-delay-60 mt-4 h-8 w-44 rounded-md bg-foreground/8 animate-pulse motion-reduce:animate-none"
          />

          <div className="mt-5 h-px w-full bg-foreground/[0.07]" />

          {/* Ledger rows — label chip + value lines. */}
          <div className="flex items-start gap-3 py-3">
            <Bar className="mt-0.5 h-2.5 w-14 shrink-0" delay={180} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Bar className="h-3 w-full" delay={200} />
              <Bar className="h-3 w-2/3" delay={240} />
            </div>
          </div>
          <div className="h-px w-full bg-foreground/[0.07]" />
          <div className="flex items-start gap-3 py-3">
            <Bar className="mt-0.5 h-2.5 w-12 shrink-0" delay={280} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Bar className="h-3 w-5/6" delay={300} />
              <Bar className="h-3 w-1/2" delay={340} />
            </div>
          </div>

          {/* Suggestion chips. */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="pulse-delay-380 h-7 w-32 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none" />
            <span className="pulse-delay-440 h-7 w-24 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

export type ChatSkeletonTail = "briefing" | "resume" | "rounds";

/**
 * The stream-area skeleton: a bottom-anchored column of seam + prose rounds,
 * with the tail matching the arrival mode — the briefing card (briefing mode),
 * the resume banner + rounds (resume mode), or plain rounds while the verdict
 * itself is still pending.
 *
 * Shared writing.css classes place the rows where the real turns land.
 * The bottom anchor matches the live edge of the measured conversation list.
 */
export function ChatStreamSkeleton({
  tail = "rounds",
  className = "",
}: {
  tail?: ChatSkeletonTail;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`flex h-full flex-col justify-end overflow-hidden ${className}`}
    >
      {/* Same responsive manuscript column as DomChatList. */}
      <div className="conversation-stream-shell mx-auto">
        <div className="conversation-stream-row">
          <SeamSkeleton />
          <RoundSkeleton userWidth="w-[38%]" agentWidth="w-[58%]" delay={0} />
          <RoundSkeleton
            userLines={2}
            userWidth="w-[52%]"
            agentLines={3}
            agentWidth="w-[68%]"
            delay={120}
          />
          {tail === "briefing" ? (
            <BriefingCardSkeleton />
          ) : tail === "resume" ? (
            <>
              <ResumeBannerSkeleton delay={240} />
              <RoundSkeleton
                userLines={2}
                userWidth="w-[46%]"
                agentLines={2}
                agentWidth="w-[72%]"
                delay={300}
              />
            </>
          ) : (
            <>
              <SeamSkeleton delay={240} />
              <RoundSkeleton
                userWidth="w-[33%]"
                agentWidth="w-[64%]"
                delay={300}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The translucent composer, textarea and controls as inert bars. */
export function ChatInputSkeleton() {
  return (
    <div
      aria-hidden
      className="conversation-composer composer-bar relative overflow-hidden"
    >
      {/* Textarea line */}
      <div className="px-4 pb-2 pt-3">
        <Bar className="h-[24px] w-2/5" />
      </div>
      {/* Toolbar — left controls + send button */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="size-7 rounded-full animate-pulse motion-reduce:animate-none bg-foreground/8" />
          <Bar className="h-5 w-16" delay={80} />
          <Bar className="h-5 w-24" delay={140} />
        </div>
        <span className="size-8 shrink-0 rounded-full bg-primary/70 animate-pulse motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * The full pre-verdict pane — stream skeleton + input skeleton, laid out
 * EXACTLY like `ChatPage`'s fragment, so the swap to the real tree doesn't
 * move a pixel. The two wrappers below are copied from `chat-page.tsx` and
 * must stay identical to them; they are the reason this is a layout rather
 * than a picture of one.
 *
 * The TOP ENTRY IS ITS OWN, though, because at this point in the mount there is
 * no composer to measure and no field to carry an inset: the chrome's height is
 * measured here directly and reserved the way a scroller reserves it, which is
 * also how the real tree's empty-briefing branch does it. The BOTTOM needs
 * nothing — the input skeleton is in FLOW here (in the real tree the composer
 * floats), so the stream area already ends where it begins.
 */
export function ChatPageSkeleton({
  tail = "rounds",
}: {
  tail?: ChatSkeletonTail;
}) {
  const chromeInset = useChromeInset();
  return (
    <>
      {/* The measured top chrome's height, px — reserves the strip the
          floating chrome covers (see use-chrome-inset). */}
      <div
        style={{ paddingTop: chromeInset }}
        className="relative flex-1 overflow-hidden"
      >
        <ChatStreamSkeleton tail={tail} />
      </div>
      <div className="shrink-0 z-10 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
        <div className="mx-auto w-full max-w-[44rem] px-3">
          <ChatInputSkeleton />
        </div>
      </div>
    </>
  );
}
