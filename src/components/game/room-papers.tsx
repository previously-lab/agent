"use client";

/**
 * The room's loose papers (v0.25a §五 B②): the slice's own record sheet and
 * the documents that stamped it, lying flat on the floor of its room. Each
 * sheet is one A4 plane at floor scale with a canvas-printed face (title,
 * date, a few hairline body strokes — the paper's print language, rastered
 * once per document), riding a thin stack that makes it read as PAPER: a
 * contact shadow tight at its edge plus a hairline rim plane peeking a few
 * millimetres past the sheet, so a white A4 never bleeds into a pale floor.
 * The sheet lifts clear of the room's floor-dressing planes (parquet,
 * module tints, inlay, accent rug) — see SHEET_LIFT. The SPOTS come from
 * the integrator (lib/game/room-papers.ts, pure); this component only
 * draws what it is handed — the strand-door list's render-data pattern
 * (roomDoors).
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
import { ROOM_PAPER_HEIGHT, ROOM_PAPER_WIDTH, type RoomPaperSpot } from "@/lib/game/room-papers";

/** One loose sheet: where it lies + which document it carries. */
export interface RoomPaperItem {
  spot: RoomPaperSpot;
  /** The desk ref the sheet opens (records/<id>, a case ref, a piece ref). */
  ref: string;
  title: string;
  date: string;
}

/* A4 proportions, enlarged slightly for the fixed RTS view. Shared with
 * the placement margin so a readable sheet still stays clear of walls. */
const SHEET_W = ROOM_PAPER_WIDTH;
const SHEET_H = ROOM_PAPER_HEIGHT;
/* Lift above the terrain: no z-fight, no visible hover. The flat-room
 * floor is a STACK of dressing planes above the terrain top (GROUND_Y):
 * the parquet at +0.006, the per-module floor tints at +0.009, the
 * template's floor-inlay band at +INLAY_LIFT (0.014), and the accent
 * rug's top at +0.04 — a sheet below any of them renders under an opaque
 * plane and disappears (the "no papers in the room" defect). The lift
 * clears the highest of them with a small pad, in every room kind, so a
 * sheet can never end up under a floor surface. */
const SHEET_LIFT = 0.046;
/* The backing rim peeking past the sheet — the hairline edge that keeps a
 * white A4 from bleeding into a pale floor. */
const SHEET_EDGE_W = 0.006;
/* The contact shadow's spread beyond the sheet's silhouette (total, both
 * sides) — tight at the edge, the paper idiom (globals.css's CONTACT
 * SHADOW), not a floating glow. */
const SHEET_SHADOW_SPREAD = 0.07;
/* The shadow plane's peak opacity — a floor shadow, not a stain. */
const SHADOW_PEAK = 0.5;

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
  // A warm index tab is visible from the scene camera before the title is.
  ctx.fillStyle = "#ba8b61";
  ctx.fillRect(canvas.width - 39, 0, 13, 38);
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

/** The contact shadow's radial falloff, one texture shared by every
 *  sheet: near-black under the paper's own footprint, easing to nothing
 *  at the plane's edge. Alpha (not additive black), so it darkens the
 *  floor beneath without a second light pass. */
function createShadowTexture(): THREE.CanvasTexture | null {
  const w = 128;
  const h = 180;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    0,
    w / 2,
    h / 2,
    Math.hypot(w / 2, h / 2),
  );
  g.addColorStop(0, `rgba(8, 6, 4, ${SHADOW_PEAK})`);
  g.addColorStop(0.62, `rgba(8, 6, 4, ${SHADOW_PEAK * 0.55})`);
  g.addColorStop(1, "rgba(8, 6, 4, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
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
  const shadowTexture = useMemo(() => createShadowTexture(), []);
  useEffect(
    () => () => {
      for (const t of textures) t?.dispose();
      shadowTexture?.dispose();
    },
    [textures, shadowTexture],
  );
  return (
    <>
      {papers.map((p, i) => {
        const y = terrainHeight(scaledRecipe, p.spot.x, p.spot.z);
        return (
          <group key={p.ref}>
            {/* The contact shadow — the paper idiom: a tight, dark shadow
                at the sheet's edge grounds it on the floor however pale
                the floor is. Sits just under the edge plane. */}
            <mesh
              position={[p.spot.x, y + SHEET_LIFT - 0.003, p.spot.z]}
              rotation={[-Math.PI / 2, 0, p.spot.rotY]}
            >
              <planeGeometry
                args={[SHEET_W + SHEET_SHADOW_SPREAD, SHEET_H + SHEET_SHADOW_SPREAD]}
              />
              <meshBasicMaterial
                map={shadowTexture ?? undefined}
                transparent
                depthWrite={false}
              />
            </mesh>
            {/* The hairline edge — a thin darker rim peeking past the
                sheet on every side, so the A4 reads as an object with an
                edge, not a pale patch on the floor. */}
            <mesh
              position={[p.spot.x, y + SHEET_LIFT - 0.0015, p.spot.z]}
              rotation={[-Math.PI / 2, 0, p.spot.rotY]}
            >
              <planeGeometry args={[SHEET_W + SHEET_EDGE_W, SHEET_H + SHEET_EDGE_W]} />
              <meshStandardMaterial color="#cfc9ba" roughness={1} metalness={0} />
            </mesh>
            {/* The sheet itself — the printed face. */}
            <mesh
              position={[p.spot.x, y + SHEET_LIFT, p.spot.z]}
              rotation={[-Math.PI / 2, 0, p.spot.rotY]}
              receiveShadow
            >
              <planeGeometry args={[SHEET_W, SHEET_H]} />
              <meshStandardMaterial
                color="#f5eedb"
                emissive="#d9cfb5"
                emissiveIntensity={0.045}
                roughness={0.9}
                metalness={0}
                {...(textures[i] ? { map: textures[i] } : {})}
              />
            </mesh>
          </group>
        );
      })}
    </>
  );
}
