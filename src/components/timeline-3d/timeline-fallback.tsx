"use client";

/**
 * Loading shell for the card field — shown while the catalog window streams in
 * (Rev 8 §R8: without WebGL the ambient strip simply drops out and the stack
 * list takes the full width, so there is no degraded data view anymore; the
 * list itself renders its own empty state).
 *
 * THE CARDS ARE THE REAL CARDS' SIZE. They used to be a column of `w-full`
 * boxes inside a hard-coded `max-w-xl`, which is a picture of a card rather
 * than a card: at the laptop tier the real card is ~900px wide and the
 * placeholder was 576, so the whole field resized the moment the catalog
 * landed. The size now comes from `frameGeometryFor` — the same function
 * `card-field.tsx` sizes the real cards with — so the swap moves nothing.
 *
 * The composition is the card's own, top to bottom: eyebrow row, hairline,
 * title, then the user/agent bubble rounds. It is a smaller DOCUMENT than the
 * dossier (it is a placeholder), but the same one, at the same scale.
 *
 * Motion is staggered down the column so it reads as one gesture rather than a
 * field of lights blinking in unison. `motion-reduce:animate-none` throughout.
 */
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { useTier } from "@/hooks/use-tier";
import { frameGeometryFor, frameVariantFor } from "@/lib/timeline3d/stacks";

const PULSE = "animate-pulse motion-reduce:animate-none";

function Bar({ className = "", delay = 0 }: { className?: string; delay?: number }) {
  return (
    <span
      aria-hidden
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      className={`rounded-full bg-foreground/8 ${PULSE} ${className}`}
    />
  );
}

function FallbackCard({
  width,
  height,
  delay = 0,
}: {
  width: number;
  height: number;
  delay?: number;
}) {
  return (
    <div
      aria-hidden
      style={{ width, height }}
      className="relative shrink-0 overflow-hidden rounded-xl bg-card p-5 ring-1 ring-foreground/10 shadow-[0_34px_80px_-20px_rgba(15,23,42,0.28)] dark:shadow-[0_34px_80px_-20px_rgba(0,0,0,0.8)]"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-foreground/[0.05] to-35% to-transparent"
      />
      {/* Eyebrow row — marker square + label + timecode bars. */}
      <div className="relative flex items-center gap-2">
        <span className="inline-block size-1.5 shrink-0 rounded-[1px] bg-primary/70" />
        <Bar className="h-2.5 w-24" delay={delay} />
        <Bar className="ml-auto h-2.5 w-16" delay={delay + 60} />
      </div>

      <div className="relative mt-4 h-px w-full bg-foreground/[0.07]" />

      {/* Title bar. */}
      <div
        className={`relative mt-4 h-6 w-1/2 rounded-md bg-foreground/8 ${PULSE}`}
        style={{ animationDelay: `${delay + 100}ms` }}
      />

      <div className="relative mt-4 h-px w-full bg-foreground/[0.07]" />

      {/* Turn rounds — the TurnBubbles skeleton language (user tinted right,
          agent gray left), rem-sized for the fallback seat. */}
      <div className="relative mt-4 space-y-2.5">
        <div
          className={`ml-auto h-9 w-[68%] rounded-2xl rounded-br-md bg-muted ${PULSE}`}
          style={{ animationDelay: `${delay + 160}ms` }}
        />
        <div
          className={`h-12 w-[80%] rounded-2xl rounded-bl-md bg-foreground/8 ${PULSE}`}
          style={{ animationDelay: `${delay + 220}ms` }}
        />
        <div
          className={`ml-auto h-9 w-[52%] rounded-2xl rounded-br-md bg-muted ${PULSE}`}
          style={{ animationDelay: `${delay + 280}ms` }}
        />
      </div>
    </div>
  );
}

export function TimelineFallback() {
  const t = useTranslations("timeline3d.fallback");
  const { paneW } = useTier();

  // The real geometry, from the real function — including the VARIANT, which is
  // the pane's to decide (see `frameVariantFor`). The height argument is the
  // desktop default the card field itself falls back to before it has measured
  // its box (`card-field.tsx` uses 800 for the same reason) — the fallback has
  // no measured box either, and a card that is one frame-height wrong is still
  // far closer than `max-w-xl` was.
  const geo = frameGeometryFor(
    frameVariantFor(paneW || 1280, 800),
    paneW || 1280,
    800,
  );

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 overflow-hidden bg-background px-6 py-8">
      <div aria-hidden className="flex flex-col items-center gap-8">
        <FallbackCard width={geo.cardW} height={geo.cardH} delay={0} />
        <FallbackCard width={geo.cardW} height={geo.cardH} delay={140} />
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
