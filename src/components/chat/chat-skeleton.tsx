"use client";

/**
 * Arrival skeletons — the loading face of the chat view.
 *
 * THE ONE RULE: A SKELETON MUST OCCUPY THE SPACE IT IS STANDING IN FOR. A
 * loading face that is merely "the same kind of thing" still makes the page
 * jump when the real content lands, and the jump is the part a reader notices.
 * So every number here is taken from the same source the real tree takes it
 * from — the reading column comes from `columnFor` (`@/lib/layout/tiers`) and
 * the paddings are copied from the field's own face inset — rather than being
 * re-derived by hand. That was the previous version's actual bug: it hard-coded
 * `pr-4 sm:pr-6 lg:pr-8` and `md:max-w-2xl`, which agreed with the real tree
 * until the column became responsive, and then quietly disagreed with it at
 * every viewport below the laptop tier.
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

import { useTier } from "@/hooks/use-tier";
import { useChromeInset } from "@/hooks/use-chrome-inset";

const PULSE = "animate-pulse motion-reduce:animate-none bg-foreground/8";

/**
 * The field's own face inset — the padding a real block's content sits inside
 * (`unified-chat-stream.tsx` and `slice-conversation.tsx` both carry this exact
 * string). It is duplicated rather than imported because those two modules are
 * the RENDERERS and this is a placeholder; the contract is the string, and the
 * comment in each place says so.
 */
const FACE_INSET = "px-3 sm:pr-6 md:pl-0 lg:pr-8";

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
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      className={`rounded-full ${PULSE} ${className}`}
    />
  );
}

/** A boundary-seam skeleton — hairline + centered date pill, like SliceSeam. */
function SeamSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div aria-hidden className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span
        style={{ animationDelay: `${delay}ms` }}
        className="h-5 w-28 rounded-full bg-muted animate-pulse motion-reduce:animate-none"
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
        style={{ animationDelay: `${delay}ms` }}
        className="h-6 w-52 rounded-full bg-brand-500/10 animate-pulse motion-reduce:animate-none"
      />
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
  delay = 0,
}: {
  userLines?: 1 | 2 | 3;
  userWidth?: string;
  agentLines?: 1 | 2 | 3;
  agentWidth?: string;
  delay?: number;
}) {
  return (
    <div aria-hidden className="space-y-1.5 py-1.5">
      <div
        style={{ animationDelay: `${delay}ms` }}
        className={`ml-auto rounded-2xl rounded-br-md bg-secondary animate-pulse motion-reduce:animate-none ${BUBBLE_HEIGHT[userLines]} ${userWidth}`}
      />
      <div
        style={{ animationDelay: `${delay + 90}ms` }}
        className={`rounded-2xl rounded-bl-md ${PULSE} ${BUBBLE_HEIGHT[agentLines]} ${agentWidth}`}
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
            <Bar className="ml-auto h-2.5 w-20" delay={120} />
          </div>

          <div className="mt-4 h-px w-full bg-foreground/[0.07]" />

          {/* Serif title bar (the user's name). */}
          <div
            aria-hidden
            style={{ animationDelay: "60ms" }}
            className="mt-4 h-8 w-44 rounded-md bg-foreground/8 animate-pulse motion-reduce:animate-none"
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
            <span
              style={{ animationDelay: "380ms" }}
              className="h-7 w-32 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none"
            />
            <span
              style={{ animationDelay: "440ms" }}
              className="h-7 w-24 rounded-full border border-foreground/10 bg-foreground/5 animate-pulse motion-reduce:animate-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export type ChatSkeletonTail = "briefing" | "resume" | "rounds";

/**
 * The stream-area skeleton: a bottom-anchored column of seam + bubble rounds,
 * with the tail matching the arrival mode — the briefing card (briefing mode),
 * the resume banner + rounds (resume mode), or plain rounds while the verdict
 * itself is still pending.
 *
 * The column width is `columnFor` — the SAME function the real field uses — so
 * the rows land exactly where the turns will. Anchored to the BOTTOM, because
 * the field is: it lands on the live edge, and a skeleton that fills from the
 * top would jump the moment the first real block measured.
 */
export function ChatStreamSkeleton({
  tail = "rounds",
  className = "",
}: {
  tail?: ChatSkeletonTail;
  className?: string;
}) {
  const { column } = useTier();
  return (
    <div
      aria-hidden
      className={`flex h-full flex-col justify-end overflow-hidden ${className}`}
    >
      <div className="mx-auto w-full" style={{ maxWidth: column }}>
        <div className={FACE_INSET}>
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
      <div
        style={{ paddingTop: chromeInset }}
        className="relative flex-1 overflow-hidden"
      >
        <ChatStreamSkeleton tail={tail} />
      </div>
      <div className="shrink-0 z-10 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]">
        <div className="mx-auto w-full max-w-5xl xl:max-w-7xl px-3 sm:px-6 lg:px-8">
          <ChatInputSkeleton />
        </div>
      </div>
    </>
  );
}
