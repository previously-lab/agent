import { Link } from "@/i18n/navigation";
import type { HomeRecap } from "@/lib/home/recap";

/**
 * The home card (v0.13 §3) — the game's start screen, not a chat window.
 *
 * Four zones, top to bottom: the identity line (who this is, one line of
 * state), the 前情提要 (where the last conversation left off — real time,
 * real gap, the last exchange's own words), the two doors (继续 reads,
 * 进入世界 walks), and the settings fine print in the footer. No input box,
 * no message stream, no conversation ability — and no R3F anywhere in this
 * import graph.
 *
 * Purely presentational: every fact arrives formatted from the server page,
 * so this file stays locale- and clock-free.
 */
export interface HomeCardProps {
  identity: string;
  /** One line of state — "{count} time slices" / the first-meeting line. */
  stateLine: string;
  recap: {
    label: string;
    /** Localized wall-clock of the last exchange, in the slice's timezone. */
    when: string;
    /** Localized gap since then ("3 days ago" / "3 天前"). */
    gap: string;
    youLabel: string;
    agentLabel: string;
    lastUser: HomeRecap["lastUser"];
    lastAgent: HomeRecap["lastAgent"];
  } | null;
  continueLabel: string;
  enterWorldLabel: string;
  settingsLabel: string;
}

export function HomeCard({
  identity,
  stateLine,
  recap,
  continueLabel,
  enterWorldLabel,
  settingsLabel,
}: HomeCardProps) {
  return (
    <main className="relative flex h-dvh flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        {/* 1 · Identity — who the reader is talking with, one line of state. */}
        <header>
          <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-muted-foreground">
            {identity}
          </p>
          <p className="mt-2 text-xs text-muted-foreground/80">{stateLine}</p>
        </header>

        {/* 2 · 前情提要 — where the last conversation left off. Hairlines, not
            a card box: the recap is a readout, not a landing-page tile. */}
        {recap && (
          <section className="mt-10 border-t border-border pt-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground/70">
              {recap.label}
            </p>
            <p className="mt-3 font-mono text-[11px] text-muted-foreground">
              {recap.when}
              <span className="text-muted-foreground/50"> · </span>
              {recap.gap}
            </p>
            <dl className="mt-3 space-y-2 text-sm leading-6">
              {recap.lastUser && (
                <div className="flex gap-3">
                  <dt className="shrink-0 font-mono text-[11px] leading-6 text-muted-foreground/70">
                    {recap.youLabel}
                  </dt>
                  <dd className="min-w-0 truncate text-foreground/90">
                    {recap.lastUser}
                  </dd>
                </div>
              )}
              {recap.lastAgent && (
                <div className="flex gap-3">
                  <dt className="shrink-0 font-mono text-[11px] leading-6 text-brand/80">
                    {recap.agentLabel}
                  </dt>
                  <dd className="min-w-0 truncate text-foreground/90">
                    {recap.lastAgent}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* 3 · The two doors — 继续 (read, the hero) / 进入世界 (walk). */}
        <nav
          className={`flex flex-col gap-5 border-t border-border pt-8 ${
            recap ? "mt-10" : "mt-12"
          }`}
        >
          <Link
            href="/app"
            className="text-lg font-medium transition-colors hover:text-brand"
          >
            {continueLabel}
          </Link>
          <Link
            href="/app?view=game"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {enterWorldLabel}
          </Link>
        </nav>
      </div>

      {/* 4 · 设置不进卡的主体 — 内容是内容，设施是设施 (§3). */}
      <Link
        href="/settings"
        className="absolute bottom-6 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        {settingsLabel}
      </Link>
    </main>
  );
}
