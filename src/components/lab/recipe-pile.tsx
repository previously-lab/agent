import type { CSSProperties } from "react";
import {
  PileStack,
  TIER_LABELS,
  type CoverKind,
  type PileTier,
} from "./sheet";
import { SceneFrame } from "./scene-frame";
import { RecipeHead } from "./recipe-chrome";

const TIERS: PileTier[] = ["thin", "medium", "thick"];

/** recipe 1 · pile — the three thickness tiers side by side, twice: once
 *  wearing CASE covers, once wearing RECORD covers. The two cover kinds must
 *  be distinguishable at a glance. */
export function RecipePile() {
  return (
    <section data-recipe="pile" className="lab-recipe">
      <RecipeHead
        name="01 · pile — 薄 / 中 / 厚"
        intent="Three tiers of one document stack; a printed cover on top, blank paper peeking beneath. Case and record piles must read differently at a glance. Tier counts are assumed — the real thresholds are open (Q-B)."
        variant="dom"
      />
      <div className="lab-stage">
        <div className="lab-board lab-pile-board">
          {(["case", "record"] as CoverKind[]).map((kind) => (
            <div key={kind} className="lab-pile-row">
              <p className="lab-row-label">{kind} piles</p>
              {TIERS.map((tier) => (
                <PileStack
                  key={tier}
                  tier={tier}
                  cover={kind}
                  caption={TIER_LABELS[tier]}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The same pile, projected — one medium case pile inside a real
 *  `<Html transform>` so the DOM and scene renderings can be compared. */
export function RecipePileScene() {
  const width = 240;
  return (
    <section data-recipe="pile-scene" className="lab-recipe">
      <RecipeHead
        name="01b · pile — scene variant"
        intent="The same medium case pile inside a real R3F <Html transform> (fov 30, distanceFactor 400, dpr 1–2). Compare against 01-dom: grain sharpness, hairline AA, contact-shadow spread."
        variant="scene"
      />
      <div className="lab-stage">
        <div className="lab-scene-board">
          <SceneFrame
            worldHeight={620}
            contentWidth={460}
            contentHeight={560}
          >
            <div
              className="lab-scene-pile"
              style={{ "--lab-pile-w": `${width}px` } as CSSProperties}
            >
              <PileStack tier="medium" cover="case" width={width} caption={null} />
            </div>
          </SceneFrame>
        </div>
      </div>
    </section>
  );
}
