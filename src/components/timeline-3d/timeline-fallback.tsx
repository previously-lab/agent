"use client";

/**
 * Loading shell for the timeline route — shown while the client checks WebGL
 * support and the catalog window streams in (Rev 8 §R8: without WebGL the
 * ambient strip simply drops out and the stack list takes the full width,
 * so there is no degraded data view anymore; the list itself renders its
 * own empty state).
 *
 * Instead of a lone spinner, the loading face previews the real layout: a
 * column of frame-card-shaped outlines — eyebrow row, hairline, title bar,
 * then the same user/agent bubble skeleton the cards' TurnBubbles use —
 * all pulsing (motion-reduce:animate-none), with the spinner caption as the
 * status line.
 */
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

const PULSE = "animate-pulse motion-reduce:animate-none";

function FallbackCard() {
  return (
    <div
      aria-hidden
      className="relative w-full overflow-hidden rounded-xl bg-card p-5 ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
      {/* Eyebrow row — marker square + label + timecode bars. */}
      <div className="relative flex items-center gap-2">
        <span className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary/70" />
        <span className={`h-2.5 w-24 rounded-full bg-foreground/8 ${PULSE}`} />
        <span className={`ml-auto h-2.5 w-16 rounded-full bg-foreground/8 ${PULSE}`} />
      </div>

      <div className="relative mt-4 h-px w-full bg-foreground/[0.07]" />

      {/* Title bar. */}
      <div
        className={`relative mt-4 h-6 w-1/2 rounded-md bg-foreground/8 ${PULSE}`}
      />

      <div className="relative mt-4 h-px w-full bg-foreground/[0.07]" />

      {/* Turn rounds — the TurnBubbles skeleton language (user tinted
          right, agent gray left), rem-sized for the fallback seat. */}
      <div className="relative mt-4 space-y-2.5">
        <div
          className={`ml-auto h-9 w-[68%] rounded-xl rounded-br-md bg-muted ${PULSE}`}
        />
        <div className={`h-12 w-[80%] rounded-xl rounded-bl-md bg-foreground/8 ${PULSE}`} />
        <div
          className={`ml-auto h-9 w-[52%] rounded-xl rounded-br-md bg-muted ${PULSE}`}
        />
      </div>
    </div>
  );
}

export function TimelineFallback() {
  const t = useTranslations("timeline3d.fallback");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 overflow-hidden bg-background px-6 py-8">
      <div aria-hidden className="w-full max-w-xl space-y-8">
        <FallbackCard />
        <FallbackCard />
      </div>
      <div
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        {t("loading")}
      </div>
    </div>
  );
}
