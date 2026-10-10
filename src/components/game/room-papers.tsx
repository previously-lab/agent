"use client";

/**
 * The room's loose papers (v0.25a §五 B②): the slice's own record sheet and
 * the documents that stamped it, lying flat on the floor of its room. Each
 * sheet is one A4 plane at floor scale with a canvas-printed face (title,
 * date, a few hairline body strokes — the paper's print language, rastered
 * once per document). The SPOTS come from the integrator (lib/game/
 * room-papers.ts, pure); this component only draws what it is handed — the
 * strand-door list's render-data pattern (roomDoors).
 *
 * LATE ARRIVAL: the document list resolves after the room mounts (a server
 * action), so the sheets pop in without the room's mount fade — the fade
 * captures its materials in a mount-time traverse, and these materials do
 * not exist yet. Accepted for v1: the pop is quiet (four small sheets on a
 * floor), and re-entering the room replays nothing.
 */
import { useEffect, useMemo, type JSX } from "react";
import * as THREE from "three";
import { terrainHeight } from "@/lib/game/terrain";
import type { SpaceRecipe } from "@/lib/game/space-types";
import type { RoomPaperSpot } from "@/lib/game/room-papers";

/** One loose sheet: where it lies + which document it carries. */
export interface RoomPaperItem {
  spot: RoomPaperSpot;
  /** The desk ref the sheet opens (records/<id>, a case ref, a piece ref). */
  ref: string;
  title: string;
  date: string;
}

/* A4 at the floor's 1:1 meter scale. */
const SHEET_W = 0.21;
const SHEET_H = 0.297;
/* Lift above the terrain: no z-fight, no visible hover. */
const SHEET_LIFT = 0.004;

/** The sheet's printed face: paper field, title line, date, body hairlines
 *  — the strand plaque's raster discipline (one canvas, sRGB texture). */
function createPaperTexture(title: string, date: string): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 362;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // The title: shrink-to-fit serif, dark ink, one line.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const maxW = canvas.width - 56;
  let size = 20;
  for (; size > 10; size -= 2) {
    ctx.font = `600 ${size}px Georgia, "Times New Roman", serif`;
    if (ctx.measureText(title).width <= maxW) break;
  }
  ctx.fillStyle = "rgba(30,30,36,0.82)";
  ctx.fillText(title, 28, 52);
  // The date: quiet mono small print.
  ctx.font = "400 12px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillStyle = "rgba(30,30,36,0.55)";
  ctx.fillText(date, 28, 76);
  // Body suggestion: hairlines with a ragged right edge.
  ctx.strokeStyle = "rgba(30,30,36,0.28)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const y = 106 + i * 26;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(28 + (maxW - ((i * 37) % 60)), y);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function RoomPapers({
  papers,
  scaledRecipe,
}: {
  papers: readonly RoomPaperItem[];
  /** The room's SCALED recipe — the terrain height reads from it so a
   *  sheet hugs the same floor the player walks on. */
  scaledRecipe: SpaceRecipe;
}): JSX.Element {
  const textures = useMemo(
    () => papers.map((p) => createPaperTexture(p.title, p.date)),
    [papers],
  );
  useEffect(
    () => () => {
      for (const t of textures) t?.dispose();
    },
    [textures],
  );
  return (
    <>
      {papers.map((p, i) => (
        <mesh
          key={p.ref}
          position={[
            p.spot.x,
            terrainHeight(scaledRecipe, p.spot.x, p.spot.z) + SHEET_LIFT,
            p.spot.z,
          ]}
          rotation={[-Math.PI / 2, 0, p.spot.rotY]}
          receiveShadow
        >
          <planeGeometry args={[SHEET_W, SHEET_H]} />
          <meshStandardMaterial
            color="#f4f1ea"
            roughness={0.9}
            metalness={0}
            {...(textures[i] ? { map: textures[i] } : {})}
          />
        </mesh>
      ))}
    </>
  );
}
