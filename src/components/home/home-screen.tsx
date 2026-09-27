import { Link } from "@/i18n/navigation";
import "./home-paper.css";

/**
 * The home (v0.13 §3) — paper, not bare typography: the page IS a big
 * sheet and a card lies on it — ONE paper, one colour; the card reads as
 * a separate layer only through the contract's lift shadow
 * (shadow-paper-lift) and the content regions carry printed relief.
 * Everything is lit from one upper-left light: the card's shadow falls
 * down-right, a sunken region shadows its top lip, a raised one catches
 * light on its top edge.
 *
 * Zones, top to bottom inside the card:
 *
 *   PLATE   the identity block (the product's sentence, the reader's name,
 *           the dateline when there is one) — a CONTENT region printed
 *           INTO the card (bg-paper-plate shadow-paper-sink): tone-step
 *           fill plus the sunken edges, the thin-deboss read, like a
 *           conversation bubble on a business card.
 *   RULE    a flat printed hairline (bg-paper-line) — ink on the sheet,
 *           separating content from menu.
 *   MENU    继续 → `/app`, then 设置 beneath it — LABEL-like regions
 *           (shadow-paper-raise), printed tags whose top edge catches the
 *           light. 继续 carries the page's one metallic treatment
 *           (.paper-foil: flat leaf ink, not embossed type); 设置 stays
 *           matte ink.
 *
 * The material vocabulary (--paper-* variables → @theme inline tokens →
 * bg-paper / bg-paper-grain(-card) / shadow-paper-* utilities) lives in
 * globals.css as a shared contract; this file (home-paper.css) only lays
 * it out. Purely presentational: every fact arrives formatted from the
 * server page, so this file stays locale- and clock-free. No R3F
 * anywhere in the import graph.
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
    <main className="bg-paper bg-paper-grain flex min-h-dvh flex-col items-center justify-center px-6 py-16">
      <div className="home-card bg-paper bg-paper-grain-card shadow-paper-lift w-full max-w-sm">
        {/* THE PLATE — the sunken identity region. Sentence case, and NO
            font-family class: the app's default is Raleway, so the title
            says nothing and inherits it. The weight does the hierarchy —
            the lead a touch heavier than its preposition, the name large
            and LIGHT (300, the variable face's own light). The dateline
            hugs the name inside the same pressed region. */}
        <header className="home-plate bg-paper-plate shadow-paper-sink">
          <p className="text-base text-muted-foreground">
            <span className="font-medium text-foreground/75">
              {eyebrowLead}
            </span>{" "}
            {eyebrowPreposition}
          </p>
          <h1 className="home-name-type mt-1 font-light text-foreground">
            {name}
          </h1>
          {dateline && (
            <p className="mt-2 font-mono text-xs text-muted-foreground/70">
              {dateline}
            </p>
          )}
        </header>

        {/* The printed rule between content and menu — flat ink. */}
        <div className="my-7 h-px bg-paper-line" aria-hidden="true" />

        {/* THE MENU — two label-like regions, stacked on the card's left
            edge: a game's own menu rather than a toolbar's row. The ink
            separates them (继续 metallic foil, 设置 matte and faint);
            neither carries an arrow. 进入世界 is gone: the world is
            reached through the conversation, not as a second front door. */}
        <nav className="flex flex-col items-start gap-3">
          <Link
            href="/app"
            className="home-item shadow-paper-raise paper-foil home-foil text-lg"
          >
            {continueLabel}
          </Link>
          <Link
            href="/settings"
            className="home-item shadow-paper-raise text-lg text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            {settingsLabel}
          </Link>
        </nav>
      </div>
    </main>
  );
}
