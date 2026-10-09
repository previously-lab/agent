import { PileStack, type CoverKind, type PileTier } from "./sheet";
import { SceneFrame } from "./scene-frame";
import { RecipeHead } from "./recipe-chrome";

/** One grid cell's worth of pile + its tiny caption. */
function CellPile({
  tier,
  cover,
  caption,
}: {
  tier: PileTier;
  cover: CoverKind;
  caption?: string;
}) {
  return (
    <PileStack tier={tier} cover={cover} width={126} caption={caption ?? null} />
  );
}

/** An empty cell — 40% opacity, not expandable (v0.25a §四). */
function EmptyCell() {
  return (
    <div className="lab-pilewrap">
      <div className="lab-empty-cell" aria-hidden="true" />
      <p className="lab-pile-caption">empty — 40%, not expandable</p>
    </div>
  );
}

/** One time-bucket row: a label + its piles. Used by the grid recipe and the
 *  scene variant so both render the same row. */
export function ArchiveRow({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  const w = compact ? 118 : 126;
  return (
    <div className={compact ? "lab-grid-row lab-grid-row--compact" : "lab-grid-row"}>
      <p className="lab-row-label">{label}</p>
      <div className="lab-grid-cells">
        <PileStack tier="thin" cover="case" width={w} caption={null} />
        <PileStack tier="thick" cover="case" width={w} caption={null} />
        <PileStack tier="medium" cover="record" width={w} caption={null} />
      </div>
    </div>
  );
}

const COLUMNS = ["research", "tasks", "records", "dossier"];

/** recipe 2 · grid — the archive field: rows = time buckets, columns =
 *  types, cell = one pile. A second row stays partially visible below the
 *  fold so scrolling reads. */
export function RecipeGrid() {
  return (
    <section data-recipe="grid" className="lab-recipe">
      <RecipeHead
        name="02 · grid — the archive field"
        intent="Rows are day/week buckets, columns are types, a cell is one pile. Row two is cut by the fold on purpose — the field scrolls. Empty stays 40% and never opens."
        variant="dom"
      />
      <div className="lab-stage">
        <div className="lab-board lab-grid-board">
          <div className="lab-grid-field">
            <div className="lab-grid-columns" aria-hidden="true">
              <span />
              {COLUMNS.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="lab-grid-rows">
              <div className="lab-grid-row">
                <p className="lab-row-label">OCT 6</p>
                <div className="lab-grid-cells">
                  <CellPile tier="thin" cover="case" caption="thin" />
                  <CellPile
                    tier="thick"
                    cover="case"
                    caption="23 sheets — capped"
                  />
                  <CellPile tier="medium" cover="record" caption="medium" />
                  <EmptyCell />
                </div>
              </div>
              <ArchiveRow label="OCT 5" />
            </div>
            <div className="lab-grid-fade" aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Mobile variant: the same grid collapses to one column — one pile nearly
 *  fills the height, the next pile's edge peeks below. */
export function RecipeGridMobile() {
  return (
    <section data-recipe="grid-mobile" className="lab-recipe">
      <RecipeHead
        name="02m · grid — mobile (390×844)"
        intent="One pile per screen; the next pile peeks at the bottom edge — the swipe target. The pile dominates the height."
        variant="dom · mobile"
      />
      <div className="lab-stage">
        <div className="lab-phone">
          <header className="lab-phone-head">
            <span className="font-mono text-[10px] tracking-[0.2em] uppercase opacity-70">
              文档 · OCT 6
            </span>
            <span className="font-mono text-[10px] tracking-[0.2em] uppercase opacity-40">
              research
            </span>
          </header>
          <div className="lab-phone-pile">
            <PileStack tier="medium" cover="record" width={300} caption={null} />
          </div>
          <div className="lab-phone-peek" aria-hidden="true">
            <PileStack tier="thin" cover="case" width={300} caption={null} />
          </div>
          <footer className="lab-phone-foot">
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-50">
              swipe for the next pile
            </span>
          </footer>
        </div>
      </div>
    </section>
  );
}

/** The same field, projected — one row of piles inside a real
 *  `<Html transform>`. */
export function RecipeGridScene() {
  return (
    <section data-recipe="grid-scene" className="lab-recipe">
      <RecipeHead
        name="02b · grid — scene variant"
        intent="One archive row inside a real <Html transform>. Compare against 02-dom — this is how the field will actually composit: projected DOM over GL."
        variant="scene"
      />
      <div className="lab-stage">
        <div className="lab-scene-board">
          <SceneFrame
            worldHeight={560}
            contentWidth={720}
            contentHeight={430}
          >
            <div className="lab-scene-row">
              <ArchiveRow label="OCT 6" compact />
            </div>
          </SceneFrame>
        </div>
      </div>
    </section>
  );
}
