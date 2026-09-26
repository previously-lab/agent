import { Link } from "@/i18n/navigation";

/**
 * The home (v0.13 §3) — pure typography on the field. No card, no box, no
 * rule, no stamps, no file numbers: sentence case, and weight + margins
 * carry the hierarchy. Zones, top to bottom:
 *
 *   TITLE    "Previously on" (the product's sentence, weight-split) and the
 *            reader's name — the biggest thing on the page.
 *   DATELINE the remark under it — ONE line, hugging the name the way a
 *            subtitle hugs a title: either the relative phrase the page
 *            already phrased, or the plain clock once the gap outgrows the
 *            interval ladder's day bucket.
 *   MENU     继续 → `/app`, then 设置 beneath it in faint ink — a stacked
 *            pair with one left edge, the way a game's menu lists equal items.
 *
 * Purely presentational: every fact arrives formatted from the server page,
 * so this file stays locale- and clock-free. No R3F anywhere in the import
 * graph.
 */

export interface HomeScreenProps {
  /** Line 1, weight-split parts — the product's own sentence. */
  eyebrowLead: string;
  eyebrowPreposition: string;
  /** Line 2 — the reader's name, from the same read the header chip uses. */
  name: string;
  /** THE DATELINE, already phrased by the page — one line, one fact. Null
   *  when there is no conversation to recap. */
  dateline: string | null;
  continueLabel: string;
  settingsLabel: string;
}

export function HomeScreen({
  eyebrowLead,
  eyebrowPreposition,
  name,
  dateline,
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
          <p className="text-base text-muted-foreground">
            <span className="font-medium text-foreground/75">
              {eyebrowLead}
            </span>{" "}
            {eyebrowPreposition}
          </p>
          <h1 className="home-name-type mt-1 font-light text-foreground">
            {name}
          </h1>
        </header>

        {/* THE DATELINE — the page's one factual line, and the page has
            already chosen its shape. It hugs the name (a subtitle, not a
            document's dateline far down the page), so the three lines read as
            ONE block: kicker, name, remark. */}
        {dateline && (
          <section>
            <p className="mt-2 font-mono text-xs text-muted-foreground/70">
              {dateline}
            </p>
          </section>
        )}

        {/* THE MENU — two items, stacked on one left edge: a game's own menu
            rather than a toolbar's row, and the same size for both, because
            they are two choices and not a hero with a hanger-on. The ink
            separates them (继续 full, 设置 faint); neither carries an arrow —
            the items ARE the affordance, and a glyph would decorate what
            already reads as a link. 进入世界 is gone: the world is reached
            through the conversation, not as a second front door. */}
        <nav className="mt-16 flex flex-col items-start gap-3">
          <Link
            href="/app"
            className="text-lg text-foreground transition-colors hover:text-brand"
          >
            {continueLabel}
          </Link>
          <Link
            href="/settings"
            className="text-lg text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            {settingsLabel}
          </Link>
        </nav>
      </div>
    </main>
  );
}
