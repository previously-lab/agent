import { RecipeHead } from "./recipe-chrome";

/** recipe 3 · paper — the material close-up at print scale. The sheet's
 *  geometry borrows the desk's millimetre (--desk-mm idiom, lab-namespaced):
 *  the sheet height / 297 is the millimetre, body = 4mm, header/footer mono
 *  3mm, title 6.5mm, 25mm side margins — A4-true type-to-paper ratio, so the
 *  2× screenshot judges the real texture. */

const BODY = [
  "The sheet is the product. Everything the agent keeps — the research, the tasks, the record of what was said — is printed on paper, and the paper answers to the same contract everywhere: one stock, one grain, one light from the upper left.",
  "Nothing on this page is a panel. The header is a printed line, the rules are ink, the folio is flat print like everything else. When a sheet lies on another sheet, the crevice between them carries all the separation there is.",
  "一张纸就是全部界面。页眉是印上去的，折线是墨迹，页码也是平印上去的。中文段落保持两字符的首行缩进，像印刷出来的一样。",
  "A document crosses as many sheets as it needs; no line is ever cut in half. What you are looking at here is the atom the whole archive is made of.",
];

export function RecipePaper() {
  return (
    <section data-recipe="paper" className="lab-recipe">
      <RecipeHead
        name="03 · paper — the material close-up"
        intent="Grain, contact shadow, hairline rules, edge veils and the print scale — plain printing, nothing sunken. Shot at 2× to judge the texture."
        variant="dom · 2×"
      />
      <div className="lab-stage">
        <div className="lab-board lab-paper-board">
          <div className="lab-paper-sheet">
            <header className="lab-paper-head">
              <span>research / 手机调研</span>
              <span>2026-10-02</span>
            </header>
            <div className="lab-paper-rule" aria-hidden="true" />
            <h3 className="lab-paper-title">The sheet, up close</h3>
            <div className="lab-paper-body">
              {BODY.map((p, i) => (
                <p key={i} className={i === 2 ? "lab-paper-zh" : undefined}>
                  {p}
                </p>
              ))}
            </div>
            <footer className="lab-paper-foot">
              <span className="flex-1" />
              <span className="tabular-nums">1 / 4</span>
              <span className="lab-paper-foot-cat">research</span>
            </footer>
            <div className="lab-edge-veil" aria-hidden="true" />
          </div>

          <ul className="lab-notes" aria-hidden="true">
            <li className="lab-note lab-note--grain">
              <span className="lab-note-tick" />
              grain — raster tile, ink in alpha
            </li>
            <li className="lab-note lab-note--rule">
              <span className="lab-note-tick" />
              hairline rule — --paper-line
            </li>
            <li className="lab-note lab-note--veil">
              <span className="lab-note-tick" />
              edge veil — lit upper-left, falls away lower-right
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
