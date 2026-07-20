"use client";

import { ArrowLeftRight } from "lucide-react";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { Button } from "@/components/ui/button";

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
        {clickable ? (
          <Button
            variant="ghost"
            onClick={onNameClick}
            className="group relative text-3xl sm:text-4xl md:text-5xl font-bold text-foreground hover:bg-transparent hover:text-primary/80 transition-colors h-auto py-1 px-3 rounded-lg"
          >
            <span>{name}</span>
            <ArrowLeftRight className="ml-2 h-5 w-5 opacity-0 group-hover:opacity-40 transition-opacity -translate-y-px" />
          </Button>
        ) : (
          <TextGenerateEffect
            words={name}
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-foreground"
            duration={0.5}
            delay={1.1}
            staggerDelay={0.4}
          />
        )}
      </div>
    </div>
  );
}
