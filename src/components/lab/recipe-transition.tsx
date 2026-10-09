import { PileStack } from "./sheet";
import { RoomComposition } from "./recipe-room";
import { RecipeHead } from "./recipe-chrome";

/**
 * recipe 6 · transition — three key frames of the two-rung ladder
 * (现场 ⇄ 文档). The compositor's job in the real app; here, three stills
 * that must read as one continuous move.
 */

function Frame({
  step,
  title,
  caption,
  children,
}: {
  step: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lab-frame-block">
      <div className="lab-frame">{children}</div>
      <p className="lab-frame-title">
        <span className="font-mono">{step}</span> {title}
      </p>
      <p className="lab-frame-caption">{caption}</p>
    </div>
  );
}

function DeskFromAbove() {
  return (
    <div className="lab-desk-view">
      <div className="lab-desk-plane">
        <div className="lab-desk-plane-inner bg-paper bg-paper-grain">
          <div className="lab-desk-row">
            <PileStack tier="thin" cover="case" width={96} caption={null} />
            <PileStack tier="medium" cover="record" width={96} caption={null} />
            <PileStack tier="thick" cover="case" width={96} caption={null} />
            <PileStack tier="medium" cover="record" width={96} caption={null} />
          </div>
          <p className="lab-desk-rowlabel">OCT 6 — all types</p>
        </div>
      </div>
    </div>
  );
}

function PileOpened() {
  return (
    <div className="lab-open-view">
      <div className="lab-open-sheet bg-paper bg-paper-grain-card">
        <header className="lab-open-head">
          <span>records / SLICE 12</span>
          <span className="text-shadow-paper-recess">2026-10-04</span>
        </header>
        <div className="lab-open-rule" aria-hidden="true" />
        <p className="lab-open-text">
          you — did the call come through? agent — it did. 23:41, the desk
          phone.
        </p>
        <p className="lab-open-text">
          you — good. write down the hotel name, and who picked up.
        </p>
        <div className="lab-open-rule" aria-hidden="true" />
        <footer className="lab-open-foot">
          <span className="flex-1" />
          <span className="text-shadow-paper-recess tabular-nums">1 / 6</span>
        </footer>
      </div>
      <div className="lab-open-pile">
        <PileStack tier="medium" cover="record" width={150} caption={null} />
      </div>
    </div>
  );
}

export function RecipeTransition() {
  return (
    <section data-recipe="transition" className="lab-recipe">
      <RecipeHead
        name="06 · transition — 现场 ⇄ 文档"
        intent="Three key frames of the move between the two rungs: standing in the room → the desk seen from a high oblique angle → one pile opened into its page. In the app this is the existing compositor; here it must read as one gesture."
        variant="dom · 3 frames"
      />
      <div className="lab-stage">
        <div className="lab-frame-strip">
          <Frame
            step="1"
            title="现场 — standing in the room"
            caption="the slice's documents lie where it happened"
          >
            <RoomComposition compact />
          </Frame>
          <span className="lab-frame-arrow" aria-hidden="true">
            →
          </span>
          <Frame
            step="2"
            title="档案场 — the desk from above"
            caption="a high oblique angle; the piles read as a field"
          >
            <DeskFromAbove />
          </Frame>
          <span className="lab-frame-arrow" aria-hidden="true">
            →
          </span>
          <Frame
            step="3"
            title="文档 — the pile opens"
            caption="one pile becomes the paged sheet"
          >
            <PileOpened />
          </Frame>
        </div>
        <p className="font-mono text-xs tracking-[0.2em] uppercase text-muted-foreground">
          现场 ⇄ 文档 — two rungs, one camera move
        </p>
      </div>
    </section>
  );
}
