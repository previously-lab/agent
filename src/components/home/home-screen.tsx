import { Link } from "@/i18n/navigation";
import "./home-paper.css";

/** Responsive title page. Fixed print geometry belongs to the document reader. */

export interface HomeScreenProps {
  /** The running head's parts — "Previously" / "on", the product's own
   *  sentence, composed around the reader's name. */
  eyebrowLead: string;
  eyebrowPreposition: string;
  /** The reader's name, from the same read the header chip uses. */
  name: string;
  /** THE DATELINE, already phrased by the page — one line, one fact.
   *  Null when there is no conversation to recap. */
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
    <main className="home-sheet bg-paper bg-paper-grain flex min-h-dvh flex-col">
      <header className="home-head">
        <h1 className="home-run">
          {eyebrowLead} {eyebrowPreposition} {name}
        </h1>
        {dateline && <p className="home-date">{dateline}</p>}
        {/* The hairline closes the head — ink, not relief. */}
        <div className="home-rule" aria-hidden="true" />
      </header>

      <nav className="home-actions">
        <Link href="/app" className="home-action">
          {continueLabel}
        </Link>
        <Link
          href="/settings"
          className="home-action home-action--quiet"
        >
          {settingsLabel}
        </Link>
      </nav>
    </main>
  );
}
