"use client";

/**
 * Arrival skeletons — the loading face of the chat view.
 *
 * Two seats, one visual identity:
 * - `ChatPageSkeleton` fills the whole right pane BEFORE the mount-time
 *   arrival verdict lands (chat-page renders nothing until then).
 * - `ChatStreamSkeleton` covers the pane as an overlay AFTER the verdict,
 *   while the mount fetches (episodic state, the first history page) are
 *   still in flight, and crossfades out (the travel-clock pattern, one
 *   level up).
 *
 * Every bar is isomorphic to the real content it stands in for — boundary
 * seam (hairline + date pill), user/agent bubble pairs sized like real
 * turns (1 line ≈ 2.25rem, 2 ≈ 3.5rem, 3 ≈ 4.75rem incl. the bubble's
 * px-3 py-2), and the briefing's slice-card face — and everything pulses
 * with `motion-reduce:animate-none`, the project convention.
 */

const PULSE = "animate-pulse motion-reduce:animate-none bg-foreground/8";

function Bar({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`rounded-full ${PULSE} ${className}`} />;
}

/** A boundary-seam skeleton — hairline + centered date pill, like SliceSeam. */
function SeamSkeleton() {
  return (
    <div aria-hidden className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="h-5 w-28 rounded-full bg-muted animate-pulse motion-reduce:animate-none" />
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** The resume-banner skeleton — a centered brand pill, like ResumeBanner. */
function ResumeBannerSkeleton() {
  return (
    <div aria-hidden className="my-4 flex justify-center">
      <span className="h-6 w-52 rounded-full bg-brand-500/10 animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

const BUBBLE_HEIGHT = {
  1: "h-[2.25rem]",
  2: "h-[3.5rem]",
  3: "h-[4.75rem]",
} as const;

/** One user/agent round — right-aligned user bar + left agent bar, the same
 *  widths and line counts real turns produce (frame-card's TurnBubbles
 *  skeleton is the precedent for the em heights). */
function RoundSkeleton({
  userLines = 1,
  userWidth = "w-[42%]",
  agentLines = 2,
  agentWidth = "w-[62%]",
}: {
  userLines?: 1 | 2 | 3;
  userWidth?: string;
  agentLines?: 1 | 2 | 3;
  agentWidth?: string;
}) {
  return (
    <div aria-hidden className="space-y-1.5 py-1.5">
      <div
        className={`ml-auto rounded-xl rounded-br-md bg-secondary animate-pulse motion-reduce:animate-none ${BUBBLE_HEIGHT[userLines]} ${userWidth} max-w-[88%] sm:max-w-[75%] md:max-w-[65%]`}
      />
      <div
        className={`rounded-xl rounded-bl-md ${PULSE} ${BUBBLE_HEIGHT[agentLines]} ${agentWidth} max-w-[88%] sm:max-w-[75%] md:max-w-[65%]`}
      />
    </div>
  );
}

/**
 * The briefing card's skeleton face — identical chrome to EmptyBriefing's
 * slice card (ring + soft shadow + top light falloff), with the eyebrow
 * row, serif title, ledger rows and suggestion chips as bars.
 */
export function BriefingCardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col items-center px-4 py-10">
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
        />
        <div className="relative px-5 py-5 sm:px-6">
          {/* Eyebrow row — marker square + label bar + timecode bar. */}
          <div className="flex items-center gap-2">
            <span className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary/70" />
            <Bar className="h-2.5 w-24" />
            <Bar className="ml-auto h-2.5 w-20" />
          </div>

          <div className="mt-4 h-px w-full bg-foreground/[0.07]" />

          {/* Serif title bar (the user's name). */}
          <div
            aria-hidden
            className="mt-4 h-8 w-44 rounded-md bg-foreground/8 animate-pulse motion-reduce:animate-none"
          />

          <div className="mt-5 h-px w-full bg-foreground/[0.07]" />

          {/* Ledger rows — label chip + value lines. */}
          <div className="flex items-start gap-3 py-3">
            <Bar className="mt-0.5 h-2.5 w-14 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Bar className="h-3 w-full" />
              <Bar className="h-3 w-2/3" />
            </div>
          </div>
          <div className="h-px w-full bg-foreground/[0.07]" />
          <div className="flex items-start gap-3 py-3">
            <Bar className="mt-0.5 h-2.5 w-12 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Bar className="h-3 w-5/6" />
              <Bar className="h-3 w-1/2" />
            </div>
          </div>

          {/* Suggestion chips. */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="h-7 w-32 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none" />
            <span className="h-7 w-24 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </div>
    </div>
  );
}

export type ChatSkeletonTail = "briefing" | "resume" | "rounds";

/**
 * The stream-area skeleton: a bottom-anchored column of seam + bubble
 * rounds, with the tail matching the arrival mode — the briefing card
 * (briefing mode), the resume banner + rounds (resume mode), or plain
 * rounds while the verdict itself is still pending.
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
      className={`relative mx-auto h-full w-full max-w-5xl xl:max-w-7xl ${className}`}
    >
      <div className="flex h-full flex-col justify-end overflow-hidden">
        <div className="pr-4 sm:pr-6 lg:pr-8">
          <SeamSkeleton />
          <RoundSkeleton userWidth="w-[38%]" agentWidth="w-[58%]" />
          <RoundSkeleton
            userLines={2}
            userWidth="w-[52%]"
            agentLines={3}
            agentWidth="w-[68%]"
          />
          {tail === "briefing" ? (
            <BriefingCardSkeleton />
          ) : tail === "resume" ? (
            <>
              <ResumeBannerSkeleton />
              <RoundSkeleton
                userLines={2}
                userWidth="w-[46%]"
                agentLines={2}
                agentWidth="w-[72%]"
              />
            </>
          ) : (
            <>
              <SeamSkeleton />
              <RoundSkeleton userWidth="w-[33%]" agentWidth="w-[64%]" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The input bar's skeleton — the ChatInput chrome (card ring, light
 *  falloff, textarea line, toolbar pills, send button) as inert bars. */
export function ChatInputSkeleton() {
  return (
    <div
      aria-hidden
      className="relative overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
      {/* Textarea line */}
      <div className="px-4 pb-2 pt-3">
        <Bar className="h-[24px] w-2/5" />
      </div>
      {/* Toolbar — left controls + send button */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="size-7 rounded-full animate-pulse motion-reduce:animate-none bg-foreground/8" />
          <Bar className="h-5 w-16" />
          <Bar className="h-5 w-24" />
        </div>
        <span className="size-8 shrink-0 rounded-full bg-primary/70 animate-pulse motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/**
 * The full pre-verdict pane — stream skeleton + input skeleton, laid out
 * exactly like ChatPage's fragment, so the swap to the real tree doesn't
 * move a pixel.
 */
export function ChatPageSkeleton({ tail = "rounds" }: { tail?: ChatSkeletonTail }) {
  return (
    <>
      <div className="relative flex-1 overflow-hidden">
        <ChatStreamSkeleton tail={tail} />
      </div>
      <div className="shrink-0 z-10 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
        <div className="mx-auto w-full px-4 sm:px-6 lg:px-8 md:max-w-2xl">
          <ChatInputSkeleton />
        </div>
      </div>
    </>
  );
}
