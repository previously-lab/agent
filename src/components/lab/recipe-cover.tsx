"use client";

import { useCallback } from "react";
import type { PointerEvent } from "react";
import { RecipeHead } from "./recipe-chrome";

/**
 * recipe 4 · cover — the home cover's primary action in three candidates.
 * The composition (card, plate, rule, menu) reuses the real home classes so
 * the replica tracks the shipped cover; only the primary item's treatment
 * changes. The current gold foil throws a white mirror flash — the brief's
 * judgement — so the candidates are: (a) no foil at all, (b) a static
 * restrained gleam, (c) the same gleam shifted a few px by the pointer.
 *
 * FOIL IS DOM-ONLY: Chromium drops background-clip:text under the card
 * field's 3D transforms (globals.css contract) — fine here, the home is a
 * pure-DOM route, but a foil treatment could never live inside <Html>.
 */

function CoverCard({
  label,
  children,
}: {
  label: string;
  children: (continueLabel: string) => React.ReactNode;
}) {
  return (
    <div className="lab-covercard-block">
      <p className="lab-covercard-label">{label}</p>
      <div className="lab-covercard-board bg-paper bg-paper-grain">
        <div className="home-card bg-paper bg-paper-grain-card shadow-paper-lift w-full max-w-sm">
          <header className="home-plate bg-paper-plate shadow-paper-sink">
            <p className="text-base text-muted-foreground">
              <span className="font-medium text-foreground/75">
                Previously on
              </span>
            </p>
            <h1 className="home-name-type mt-1 font-light text-foreground">
              You
            </h1>
            <p className="mt-2 font-mono text-xs text-muted-foreground/70">
              Last spoke 5 hours ago
            </p>
          </header>
          <div className="my-7 h-px bg-paper-line" aria-hidden="true" />
          <nav className="flex flex-col items-start gap-3">
            {children("Continue")}
            <span className="home-item shadow-paper-raise text-lg text-muted-foreground/80">
              Settings
            </span>
          </nav>
        </div>
      </div>
    </div>
  );
}

export function RecipeCover() {
  const onMicroMove = useCallback((e: PointerEvent<HTMLSpanElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const t = (e.clientX - r.left) / Math.max(1, r.width);
    const clamped = Math.min(1, Math.max(0, t));
    el.style.setProperty("--foil-x", `${(10 + clamped * 80).toFixed(1)}%`);
  }, []);

  return (
    <section data-recipe="cover" className="lab-recipe">
      <RecipeHead
        name="04 · cover — the first screen's primary action"
        intent="Continue wears three treatments: (a) pure deboss — no metal at all; (b) a static leaf gleam, restrained — no mirror flash; (c) the same gleam, shifted a few px with the pointer. Brand line and dateline stay in all three. Foil is DOM-only — background-clip:text dies under the field's 3D transforms."
        variant="dom · 3 candidates"
      />
      <div className="lab-stage">
        <div className="lab-cover-grid">
          <CoverCard label="a — no foil · debossed plate">
            {(continueLabel) => (
              <span className="home-item lab-item-deboss text-lg">
                {continueLabel}
              </span>
            )}
          </CoverCard>
          <CoverCard label="b — static foil · fixed gleam band">
            {(continueLabel) => (
              <span className="home-item shadow-paper-raise lab-foil text-lg">
                {continueLabel}
              </span>
            )}
          </CoverCard>
          <CoverCard label="c — micro foil · gleam follows the pointer">
            {(continueLabel) => (
              <span
                className="home-item shadow-paper-raise lab-foil lab-foil--micro text-lg"
                onPointerMove={onMicroMove}
              >
                {continueLabel}
              </span>
            )}
          </CoverCard>
        </div>
      </div>
    </section>
  );
}
