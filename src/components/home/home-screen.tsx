import { Link } from "@/i18n/navigation";

/**
 * The home (v0.13 §3) — pure typography on the field. No card, no box, no
 * rule, no stamps, no file numbers: sentence case, and weight + margins
 * carry the hierarchy. Zones, top to bottom:
 *
 *   TITLE    "Previously on" (the product's sentence, weight-split) and the
 *            reader's name — the biggest thing on the page.
 *   RECAP    where the last conversation left off: the slice's own clock
 *            and the real gap — a dateline, not a document.
 *   ACTIONS  one row: 继续 → `/app`, 设置 at the right end.
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
  } | null;
  continueLabel: string;
  settingsLabel: string;
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
          <h1 className={`home-name-type mt-1 font-light ${HOME_INK_FULL}`}>
            {name}
          </h1>
        </header>

        {/* THE DATELINE — the page's one factual line: when the last
            conversation happened, and how long ago it was. Two hairlines used
            to frame it; the reader dropped them (a cover carries no rules), so
            the rhythm they enforced is now the margins: 64px above the datum,
            56px below it — the same distances the rules used to hold. */}
        {recap && (
          <section>
            <p className={`mt-16 font-mono text-xs ${HOME_INK_FAINT}`}>
              {recap.when}
              <span className="opacity-50"> · </span>
              {recap.gap}
            </p>
          </section>
        )}

        {/* THE DOORS — one row, TWO of them, set in the same size and weight:
            the reader's call, a menu of equal items rather than a hero with a
            hanger-on. The ink still separates them (继续 full, 设置 faint) and
            继续 keeps its arrow; 进入世界 is gone — the world is reached
            through the conversation, not as a second front door. */}
        <nav className="mt-14 flex items-baseline gap-8">
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
