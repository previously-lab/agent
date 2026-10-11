import { Link } from "@/i18n/navigation";
import "./home-paper.css";

/**
 * The home (v0.13 §3, re-ruled 2026-10-10, viewport-as-sheet 2026-10-14
 * v0.29 §4.7) — plain printing: ink on paper, set exactly the way the
 * document body is set. No foil, no deboss, no gleam, no relief — the
 * VIEWPORT is the archive's first sheet, and everything on it is print:
 * a running head, a hairline rule, two printed labels. The floating A4
 * card is deleted: edge to edge, the whole screen is the sheet.
 *
 * Zones, top to bottom on the sheet (geometry in home-paper.css):
 *
 *   HEAD    the running head — "Previously on {name}" at print-display
 *           size (10mm serif, the sheet's largest voice), the dateline
 *           a 3mm mono line under the name, and a hairline rule closing
 *           the head. The block is flush-left inside the sheet's 25mm
 *           print margins and optically centred (the head carries
 *           flex-1).
 *   ACTIONS 继续 → `/app`, 设置 → `/settings` — printed labels: serif
 *           text with at most a hairline rule; the hover/focus state is
 *           an ink change plus that hairline, never a glow. 继续 carries
 *           the stronger ink; 设置 stays matte and faint.
 *
 * The material vocabulary (--paper-* variables → @theme inline tokens →
 * bg-paper / bg-paper-grain(-card) / shadow-paper-lift / bg-paper-line)
 * lives in globals.css as a shared contract; this file only lays it out.
 * Purely presentational: every fact arrives formatted from the server
 * page, so this file stays locale- and clock-free. No R3F anywhere in
 * the import graph.
 */

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
    // The viewport AS the sheet (v0.29 §4.7): the floating A4 card is
    // deleted — edge to edge, the whole screen is the archive's first
    // page. Grain stays (this IS paper); print scale rides --home-mm
    // (100dvh / 297 — the screen treated as one A4 height), geometry in
    // home-paper.css.
    <main className="home-sheet bg-paper bg-paper-grain flex min-h-dvh flex-col">
      <header className="home-head">
        <h1 className="home-run">
          {eyebrowLead} {eyebrowPreposition} {name}
        </h1>
        {dateline && <p className="home-date">{dateline}</p>}
        {/* The hairline closes the head — ink, not relief. */}
        <div className="home-rule" aria-hidden="true" />
      </header>

      {/* The two printed labels — no arrows, no glow; the hover/focus
          state changes ink and draws the hairline. 进入世界 is gone:
          the world is reached through the conversation, not as a
          second front door. */}
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
