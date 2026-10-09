import type { ReactNode } from "react";

/** The lab's recipe chrome — a name, one line of intent, and the variant
 *  label. English only: the lab never ships. */
export function RecipeHead({
  name,
  intent,
  variant,
}: {
  name: string;
  intent: string;
  variant: string;
}) {
  return (
    <header className="lab-recipe-head">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-mono text-sm tracking-[0.22em] uppercase">{name}</h2>
        <span className="lab-variant-chip">{variant}</span>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">{intent}</p>
    </header>
  );
}

export function LabPageIntro() {
  return (
    <header className="lab-topbar">
      <p className="font-mono text-xs tracking-[0.22em] uppercase">
        Visual lab — dev-only discussion medium, not product UI
      </p>
      <p className="text-xs text-muted-foreground">
        Recipes for the v0.25a structure decisions, skinned with the app&apos;s
        real paper tokens. Each section is one full-page composition; shoot
        each with --selector &quot;[data-recipe=…]&quot;.
      </p>
    </header>
  );
}

export function Stage({ children }: { children: ReactNode }) {
  return <div className="lab-stage">{children}</div>;
}
