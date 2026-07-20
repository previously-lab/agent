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

      {clickable ? (
        <div
          onClick={onNameClick}
          className="relative mt-3 inline-flex cursor-pointer group"
        >
          <TextGenerateEffect
            words={name}
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground group-hover:text-primary/80 transition-colors duration-300"
            duration={0.5}
            delay={1.1}
            staggerDelay={0.4}
          />
          <ArrowLeftRight className="absolute -top-1 -right-5 h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-all duration-300" />
        </div>
      ) : (
        <div className="mt-3">
          <TextGenerateEffect
            words={name}
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
            duration={0.5}
            delay={1.1}
            staggerDelay={0.4}
          />
        </div>
      )}
    </div>
  );
}
