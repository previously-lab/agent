import type { CSSProperties } from "react";
import { Sheet } from "./sheet";
import { RecipeHead } from "./recipe-chrome";

/**
 * recipe 5 · room — papers lying in the hotel room (v0.25a §五: the slice's
 * nearest documents lie scattered where the conversation happened). Not a
 * real 3D scene: a composition that READS as a room — back wall, floor
 * plane tipped in perspective, sheets lying on it. The light is the house
 * light: everything from the upper left, shadows falling down-right.
 */

interface RoomSheet {
  left: string;
  top: string;
  rotate: string;
  width: number;
  kind: "case" | "record" | "blank";
}

const ROOM_SHEETS: RoomSheet[] = [
  { left: "10%", top: "16%", rotate: "-7deg", width: 168, kind: "record" },
  { left: "38%", top: "5%", rotate: "4deg", width: 186, kind: "case" },
  { left: "64%", top: "32%", rotate: "-3deg", width: 152, kind: "record" },
  { left: "26%", top: "38%", rotate: "9deg", width: 140, kind: "blank" },
];

function roomSheetStyle(s: RoomSheet): CSSProperties {
  return {
    left: s.left,
    top: s.top,
    width: s.width,
    "--rs-r": s.rotate,
  } as CSSProperties;
}

/** The room composition — shared by the room recipe and the transition's
 *  first frame. */
export function RoomComposition({ compact = false }: { compact?: boolean }) {
  const sheets = compact ? ROOM_SHEETS.slice(0, 3) : ROOM_SHEETS;
  return (
    <div className={compact ? "lab-room lab-room--compact" : "lab-room"}>
      <div className="lab-room-wall" aria-hidden="true" />
      <div className="lab-room-glow" aria-hidden="true" />
      <div className="lab-room-floor">
        {sheets.map((s, i) => (
          <Sheet
            key={i}
            className={`lab-room-sheet lab-room-sheet--${s.kind}`}
            style={roomSheetStyle(s)}
          >
            {s.kind === "case" && (
              <>
                <span className="lab-room-sheet-title">Phone Research</span>
                <span className="lab-room-sheet-line" />
                <span className="lab-room-sheet-tag">CASE</span>
              </>
            )}
            {s.kind === "record" && (
              <>
                <span className="lab-room-sheet-record">SLICE 12 · R3</span>
                <span className="lab-room-sheet-line" />
                <span className="lab-room-sheet-record lab-room-sheet-record--dim">
                  2026-10-04
                </span>
              </>
            )}
          </Sheet>
        ))}
      </div>
      <div className="lab-room-seam" aria-hidden="true" />
    </div>
  );
}

export function RecipeRoom() {
  return (
    <section data-recipe="room" className="lab-recipe">
      <RecipeHead
        name="05 · room — papers lying in the scene"
        intent="The slice's nearest documents lie scattered in the room it belongs to (v0.25a §五). One light only, from the upper left — every contact shadow falls down-right. A composition, not a 3D scene."
        variant="dom"
      />
      <div className="lab-stage">
        <RoomComposition />
      </div>
    </section>
  );
}
