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

      {/* Credits line */}
      <div className="mt-12">
        <div className="flex items-center gap-2 text-xs text-muted-foreground/40 tracking-wide">
          <span>Previously</span>
          <span className="text-muted-foreground/20">·</span>
          <a
            href="https://github.com/LikeDreamwalker/Aftrbrez"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-muted-foreground/60 transition-colors"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            <span>GitHub</span>
          </a>
        </div>
      </div>
    </div>
  );
}
