import { RecipeHead } from "./recipe-chrome";

/**
 * recipe 4 · cover — the shipped home cover, plain print
 * (owner ruling 2026-10-10, ported in the home lane the same day).
 * ORDINARY PRINTING: no foil, no deboss, no gleam, no plate — the cover
 * is ink on stock, set exactly the way the document body is set (serif
 * display, mono dateline, hairline rules). The composition is the lab's
 * former intertitle candidate: the name at a document running head's
 * scale ("Previously on {name}"), the dateline a small mono line under
 * the name, a hairline closing the head — the archive's first sheet, not
 * a book cover. The actions are printed labels: serif text with at most
 * a hairline rule; the hover/focus state is an ink change plus that
 * hairline, never a glow.
 *
 * This recipe renders THE REAL home classes (home-card / home-head /
 * home-run / home-date / home-rule / home-actions / home-action from
 * home-paper.css, imported by lab-page) so it can never drift from the
 * shipped cover — no lab-local stand-ins. Only the covercard chrome
 * (board, measure, label) is lab geometry.
 */

const RUN_HEAD = "Previously on You";
const DATELINE = "Last spoke 5 hours ago";

export function RecipeCover() {
  return (
    <section data-recipe="cover" className="lab-recipe">
      <RecipeHead
        name="04 · cover — the shipped cover, plain print"
        intent="The home as it ships: the running head, the mono dateline, the hairline closing the head, the two printed labels. Real home classes — this replica tracks the production cover, it does not reinterpret it."
        variant="dom · replica"
      />
      <div className="lab-stage">
        <div className="lab-covercard-block">
          <p className="lab-covercard-label">
            the archive&apos;s first sheet — as shipped
          </p>
          <div className="lab-covercard-board bg-paper bg-paper-grain">
            <div className="home-card lab-covercard bg-paper bg-paper-grain-card shadow-paper-lift w-full max-w-sm">
              <header className="home-head">
                <h1 className="home-run">{RUN_HEAD}</h1>
                <p className="home-date">{DATELINE}</p>
                <div className="home-rule" aria-hidden="true" />
              </header>
              <nav className="home-actions">
                <span tabIndex={0} className="home-action">
                  Continue
                </span>
                <span
                  tabIndex={0}
                  className="home-action home-action--quiet"
                >
                  Settings
                </span>
              </nav>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
