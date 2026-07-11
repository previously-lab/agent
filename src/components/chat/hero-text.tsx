"use client";

import { TextGenerateEffect } from "@/components/ui/text-generate-effect";

export function HeroText({ name }: { name: string }) {
  return (
    <div className="h-screen flex flex-col items-center justify-center text-center font-[family-name:var(--font-raleway)]">
      {/* 0.3s stillness → "Previously" → 0.25s beat → "on" */}
      <TextGenerateEffect
        words="Previously on"
        className="text-6xl sm:text-7xl md:text-8xl lg:text-9xl font-light text-foreground leading-none tracking-tighter"
        duration={0.5}
        delay={0.3}
        staggerDelay={0.25}
      />
      {/* Title settles → name announced word by word, deliberate pace */}
      <div className="mt-3">
        <TextGenerateEffect
          words={name}
          className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
          duration={0.5}
          delay={1.1}
          staggerDelay={0.4}
        />
      </div>

    </div>
  );
}
