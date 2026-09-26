import { Link } from "@/i18n/navigation";
import type { SubtitleRun } from "@/lib/chat/subtitle-line";
import type { HomeRecap } from "@/lib/home/recap";

/**
 * The home (v0.13 §3) — pure typography on the field. No card, no box, no
 * stamps, no file numbers: sentence case, and weight + two hairline rules
 * carry the hierarchy. Zones, top to bottom:
 *
 *   TITLE    "Previously on" (the product's sentence, weight-split) and the
 *            reader's name — the biggest thing on the page.
 *   RECAP    where the last conversation left off: a fixed-width mono
 *            speaker column + the spoken lines in serif (two display lines,
 *            emphasis painted from the subtitle parser's runs — no marker
 *            ever leaks), then the slice's own clock and the real gap.
 *   ACTIONS  one row: 接着说 → `/app` (the old 继续, the reader's wording),
 *            进入世界 → `/app?view=game`, 设置 at the right end.
 *
 * Purely presentational: every fact arrives formatted from the server page,
 * so this file stays locale- and clock-free. No R3F anywhere in the import
 * graph.
 */

// ─── The ink palette ───────────────────────────────────────────────────────
// The semantic CLASS NAMES the zones draw on. The page's tuned sizes used
// to live here as a tuning table feeding inline styles; the rule against
// static values in style={{ … }} re-homed them — scale values became
// Tailwind tokens in the markup, the off-scale type sizes became the
// --home-* variables in globals.css.

/** Inks — the semantic palette the zones draw on. */
export const HOME_INK_FULL = "text-foreground";
export const HOME_INK_MUTED = "text-muted-foreground";
export const HOME_INK_FAINT = "text-muted-foreground/70";
export const HOME_INK_BRAND = "text-brand";
export const HOME_RULE_CLASS = "border-t border-border";

export interface HomeScreenProps {
  /** Line 1, weight-split parts — the product's own sentence. */
  eyebrowLead: string;
  eyebrowPreposition: string;
  /** Line 2 — the reader's name, from the same read the header chip uses. */
  name: string;
  recap: {
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
  settingsLabel: string;
}

/** One side of the last exchange — mono speaker, serif words, emphasis kept. */
function QuoteRow({
  speaker,
  speakerClass,
  runs,
}: {
  speaker: string;
  speakerClass: string;
  runs: SubtitleRun[];
}) {
  return (
    <div className="flex gap-3">
      <dt
        className={`w-24 shrink-0 font-mono ${speakerClass}`}
        style={{ fontSize: "var(--home-speaker-size)" }}
      >
        {speaker}
      </dt>
      <dd
        className={`min-w-0 flex-1 font-serif text-foreground/90 line-clamp-2`}
        style={{
          fontSize: "var(--home-quote-size)",
          lineHeight: "var(--home-quote-leading)",
        }}
      >
        {runs.map((run, index) =>
          run.emphasis === "strong" ? (
            <strong key={index} className={`font-semibold ${HOME_INK_FULL}`}>
              {run.text}
            </strong>
          ) : run.emphasis === "code" ? (
            <code
              key={index}
              className="rounded-sm bg-foreground/10 px-1 font-mono text-[0.85em]"
            >
              {run.text}
            </code>
          ) : (
            run.text
          ),
        )}
      </dd>
    </div>
  );
}

export function HomeScreen({
  eyebrowLead,
  eyebrowPreposition,
  name,
  recap,
  continueLabel,
  settingsLabel,
}: HomeScreenProps) {
  return (
    <main className="flex h-dvh flex-col items-center justify-center overflow-y-auto px-6">
      <div className="w-full max-w-sm">
        {/* TITLE — the product's sentence, then the reader's name. Sentence
            case, no tracking, and NO font-family class: the app's default is
            Raleway, so the title says nothing and inherits it. The weight does
            the hierarchy — the lead a touch heavier than its preposition, the
            name large and LIGHT (300, the variable face's own light; the big
            quiet line is the page's largest ink without shouting). */}
        <header>
          <p className={`text-base ${HOME_INK_MUTED}`}>
            <span className="font-medium text-foreground/75">
              {eyebrowLead}
            </span>{" "}
            {eyebrowPreposition}
          </p>
          <h1
            className={`mt-1 font-light ${HOME_INK_FULL}`}
            style={{
              fontSize: "var(--home-name-size)",
              lineHeight: "var(--home-name-leading)",
            }}
          >
            {name}
          </h1>
        </header>

        {/* HAIRLINE 1 — the title's only frame. No box anywhere: the rule,
            not a border, is what separates the name from the memory. */}
        <hr aria-hidden className={`mt-10 mb-6 ${HOME_RULE_CLASS}`} />

        {/* 前情提要 — where the last conversation left off. The clock line
            sits UNDER the words, the way a dateline closes a passage. */}
        {recap && (
          <section>
            <dl className="space-y-2.5">
              {recap.lastUser && (
                <QuoteRow
                  speaker={recap.youLabel}
                  speakerClass={HOME_INK_FAINT}
                  runs={recap.lastUser}
                />
              )}
              {recap.lastAgent && (
                <QuoteRow
                  speaker={recap.agentLabel}
                  speakerClass={HOME_INK_BRAND}
                  runs={recap.lastAgent}
                />
              )}
            </dl>
            <p className={`mt-4 font-mono text-xs ${HOME_INK_FAINT}`}>
              {recap.when}
              <span className="opacity-50"> · </span>
              {recap.gap}
            </p>
          </section>
        )}

        {/* HAIRLINE 2 — under the dateline, above the doors. */}
        <hr aria-hidden className={`mt-8 mb-6 ${HOME_RULE_CLASS}`} />

        {/* THE DOORS — one row, TWO of them, set in the same size and weight:
            the reader's call, a menu of equal items rather than a hero with a
            hanger-on. The ink still separates them (继续 full, 设置 faint) and
            继续 keeps its arrow; 进入世界 is gone — the world is reached
            through the conversation, not as a second front door. */}
        <nav className="flex items-baseline gap-8">
          <Link
            href="/app"
            className={`text-lg ${HOME_INK_FULL} transition-colors hover:text-brand`}
          >
            {continueLabel}
            <span aria-hidden className={HOME_INK_BRAND}>
              {" "}
              →
            </span>
          </Link>
          <Link
            href="/settings"
            className={`ml-auto text-lg ${HOME_INK_FAINT} transition-colors hover:${HOME_INK_FULL}`}
          >
            {settingsLabel}
          </Link>
        </nav>
      </div>
    </main>
  );
}
