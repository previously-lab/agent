"use client";

import { ArrowLeftRight } from "lucide-react";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";

export function HeroText({
  name,
  onNameClick,
  clickable = false,
}: {
  name: string;
  onNameClick?: () => void;
  clickable?: boolean;
}) {
  return (
    <div className="h-screen flex flex-col items-center justify-center text-center font-[family-name:var(--font-raleway)]">
      <TextGenerateEffect
        words="Previously on"
        className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl font-light text-foreground leading-none tracking-tighter"
        duration={0.5}
        delay={0.3}
        staggerDelay={0.25}
      />
      <div className="mt-3">
        <TextGenerateEffect
          words={name}
          className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
          duration={0.5}
          delay={1.1}
          staggerDelay={0.4}
        />
      </div>

      {clickable && onNameClick && (
        <button
          onClick={onNameClick}
          className="mt-5 group inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 transition-all duration-300"
        >
          <ArrowLeftRight className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100 transition-opacity" />
          <span>Browse personas</span>
        </button>
      )}
    </div>
  );
}
