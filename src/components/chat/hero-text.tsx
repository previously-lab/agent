"use client";

import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { Github } from "lucide-react";

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

      {/* Credits line — fades in after the title */}
      <div className="mt-12 opacity-0 animate-[fadeIn_0.6s_ease-out_2s_forwards]">
        <div className="flex items-center gap-2 text-xs text-muted-foreground/50 tracking-wide">
          <span>Previously</span>
          <span className="text-muted-foreground/25">·</span>
          <a
            href="https://likedreamwalker.space"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-muted-foreground/70 transition-colors"
          >
            LikeDreamwalker
          </a>
          <span className="text-muted-foreground/25">·</span>
          <a
            href="https://github.com/LikeDreamwalker/Aftrbrez"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-muted-foreground/70 transition-colors"
          >
            <Github className="h-3 w-3" />
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </div>
  );
}
