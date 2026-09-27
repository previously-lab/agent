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
 * The composition is the card's own, top to bottom: the pinned-corner
 * rounds (turn count, strand chip), the centred date and clock rounds
 * sitting slightly above true centre, then the focus-line round at the
 * foot. It is a smaller DOCUMENT than the dossier was (it is a
 * placeholder), but the same one as the business card it stands in for,
 * at the same scale.
 *
 * Motion is staggered down the column so it reads as one gesture rather than a
 * field of lights blinking in unison. `motion-reduce:animate-none` throughout.
 */
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { useTier } from "@/hooks/use-tier";
import { frameGeometryFor, frameVariantFor } from "@/lib/timeline3d/stacks";
import "./timeline-3d.css";

function Bar({ className = "", delay = 0 }: { className?: string; delay?: number }) {
  return (
    <span
      aria-hidden
      // Dynamic stagger (per-instance prop) — written as a CSS variable and
      // consumed by `.tl-fb-delay` in timeline-3d.css.
      style={delay ? ({ "--fb-delay": `${delay}ms` } as React.CSSProperties) : undefined}
      className={`tl-fb-delay rounded-full bg-foreground/8 animate-pulse motion-reduce:animate-none ${className}`}
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
      // Dynamic: the placeholder is the real card's size (frameGeometryFor),
      // so the swap when the catalog lands moves nothing.
      style={{ width, height }}
      className="relative flex shrink-0 flex-col overflow-hidden rounded-xl bg-paper bg-paper-grain-card p-5 shadow-paper-contact"
    >
      {/* The pinned corners — the turn count (left) and the strand chip (right). */}
      <div className="relative flex items-start justify-between">
        <div
          className="tl-fb-delay relative h-2.5 w-12 rounded-md bg-foreground/8 animate-pulse motion-reduce:animate-none"
          style={{ "--fb-delay": `${delay}ms` } as React.CSSProperties}
        />
        <div className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 shrink-0 rounded-[2px] bg-primary/50" />
          <Bar className="h-2.5 w-14" delay={delay + 60} />
        </div>
      </div>

      {/* The centre — the date and the clock, sitting slightly above true
          centre. */}
      <div className="relative flex flex-1 flex-col items-center justify-center pb-3">
        <div
          className="tl-fb-delay relative h-6 w-2/5 rounded-md bg-foreground/8 animate-pulse motion-reduce:animate-none"
          style={{ "--fb-delay": `${delay + 90}ms` } as React.CSSProperties}
        />
        <Bar className="mt-2 h-2 w-16" delay={delay + 120} />
      </div>

      {/* The foot — the focus line, spanning nearly the full width. */}
      <Bar className="h-2 w-4/5" delay={delay + 150} />
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
