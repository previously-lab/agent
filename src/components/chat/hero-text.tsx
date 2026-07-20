"use client";

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
          className={`text-3xl sm:text-4xl md:text-5xl font-bold text-foreground ${
            clickable
              ? "cursor-pointer hover:text-primary/80 transition-colors group inline-flex items-center gap-2"
              : ""
          }`}
          duration={0.5}
          delay={1.1}
          staggerDelay={0.4}
        />
        {clickable && (
          <span
            onClick={onNameClick}
            className="ml-2 inline-flex cursor-pointer rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors align-middle"
          >
            Switch &#x25BE;
          </span>
        )}
      </div>
    </div>
  );
}
