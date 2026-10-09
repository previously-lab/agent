import { RecipeHead } from "./recipe-chrome";

/**
 * recipe 4 · cover — the home cover's primary action, re-ruled by the owner
 * (2026-10-10): ORDINARY PRINTING. No foil, no deboss, no gleam, no plate —
 * the cover is ink on stock, set exactly the way the document body is set
 * (serif display, mono dateline, hairline rules), the only difference between
 * candidates being the typographic design. The two actions are printed
 * labels: text with at most a hairline rule; the hover/focus state is an ink
 * change plus that hairline, never a glow.
 *
 * The candidates, all on the real home-card shell:
 *   (a) title page  — centred stack, generous margins, no rules;
 *   (b) editorial   — flush left, one hairline under the name block, the
 *                     dateline a mono line beneath the rule (the document
 *                     header's own language);
 *   (c) intertitle  — the name at running-head size with the dateline under
 *                     it and a hairline closing the head — the cover reads as
 *                     the archive's first sheet, not a book cover.
 */

const BRAND = "Previously on";
const NAME = "You";
const DATELINE = "Last spoke 5 hours ago";

function Actions({ centre = false }: { centre?: boolean }) {
  return (
    <nav
      className={
        centre ? "lab-actions lab-actions--centre" : "lab-actions"
      }
    >
      <span tabIndex={0} className="lab-action">
        Continue
      </span>
      <span tabIndex={0} className="lab-action lab-action--quiet">
        Settings
      </span>
    </nav>
  );
}

function Candidate({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lab-covercard-block">
      <p className="lab-covercard-label">{label}</p>
      <div className="lab-covercard-board bg-paper bg-paper-grain">
        <div className="home-card lab-covercard bg-paper bg-paper-grain-card shadow-paper-lift w-full max-w-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

export function RecipeCover() {
  return (
    <section data-recipe="cover" className="lab-recipe">
      <RecipeHead
        name="04 · cover — ordinary printing, three typographic candidates"
        intent="Owner ruling: plain ink on stock, set like the document body — no foil, no deboss, no gleam. The three candidates differ only in typographic design; the actions are printed labels whose hover/focus is an ink change plus a hairline rule."
        variant="dom · 3 candidates"
      />
      <div className="lab-stage">
        <div className="lab-cover-grid">
          <Candidate label="a — title page · centred stack, no rules">
            <header className="lab-tp">
              <p className="lab-brand">{BRAND}</p>
              <h1 className="lab-name">{NAME}</h1>
              <p className="lab-date">{DATELINE}</p>
            </header>
            <Actions centre />
          </Candidate>
          <Candidate label="b — editorial · flush left, rule under the name">
            <header className="lab-ed">
              <p className="lab-brand">{BRAND}</p>
              <h1 className="lab-name">{NAME}</h1>
              <div className="lab-rule" aria-hidden="true" />
              <p className="lab-date">{DATELINE}</p>
            </header>
            <Actions />
          </Candidate>
          <Candidate label="c — intertitle · running head, the archive's first sheet">
            <header className="lab-it">
              <h1 className="lab-it-name">
                {BRAND} {NAME}
              </h1>
              <p className="lab-date">{DATELINE}</p>
              <div className="lab-rule" aria-hidden="true" />
            </header>
            <Actions />
          </Candidate>
        </div>
      </div>
    </section>
  );
}
