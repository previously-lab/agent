/**
 * Fade-material capture for room crossfades (extracted from space.tsx's
 * SpaceScene). The collector runs once per tree (mount, and again when
 * room-props swap themed materials — useRoomPropMaterials disposes the old
 * ones and mounts new ones, so a stale entry list would fade nothing), and
 * the frame loop scales opacity between the authored base and 0.
 *
 * The first capture of a material is PRISTINE and wins forever: the WeakMap
 * records opacity/transparent on first sight, and later collections reuse
 * that record even after a fade has mutated the live fields. Never read the
 * current fields at capture time — a re-collection mid-fade would bake the
 * faded value in as the new base.
 *
 * Ownership: the collector never disposes. Material lifecycle stays with
 * useRoomPropMaterials / TvProp; this module only reads the tree.
 */
import type { Material, Mesh, Object3D } from "three";

export interface FadeMaterialEntry {
  mat: Material;
  base: number;
  transparent: boolean;
}

const AUTHORED_MATERIAL_STATE = new WeakMap<
  Material,
  { opacity: number; transparent: boolean }
>();

export function authoredMaterialState(mat: Material): {
  opacity: number;
  transparent: boolean;
} {
  let authored = AUTHORED_MATERIAL_STATE.get(mat);
  if (!authored) {
    authored = { opacity: mat.opacity, transparent: mat.transparent };
    AUTHORED_MATERIAL_STATE.set(mat, authored);
  }
  return authored;
}

/**
 * One traversal of `root` (root itself included — a bare Mesh can be
 * passed). Handles single and array materials; shared materials appear once.
 * Materials previously captured keep their pristine authored base even if a
 * fade has since changed their live fields; materials new to the tree are
 * captured on sight. Materials no longer in the tree are not returned.
 */
export function collectFadeMaterials(root: Object3D): FadeMaterialEntry[] {
  const seen = new Set<Material>();
  const entries: FadeMaterialEntry[] = [];
  root.traverse((obj) => {
    const material = (obj as Partial<Mesh>).material;
    if (material == null) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      const authored = authoredMaterialState(mat);
      entries.push({ mat, base: authored.opacity, transparent: authored.transparent });
    }
  });
  return entries;
}

/** Scale every entry toward the authored base: transparent pass + base*k. */
export function applyFadeMaterials(
  entries: FadeMaterialEntry[],
  opacityScale: number,
): void {
  for (const entry of entries) {
    entry.mat.transparent = true;
    entry.mat.opacity = entry.base * opacityScale;
  }
}

/** Hand materials back to their authored state after a fade-in completes. */
export function restoreFadeMaterials(entries: FadeMaterialEntry[]): void {
  for (const entry of entries) {
    entry.mat.opacity = entry.base;
    entry.mat.transparent = entry.transparent;
  }
}
