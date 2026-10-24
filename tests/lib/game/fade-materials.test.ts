/**
 * Fade-material capture (src/lib/game/fade-materials.ts) — the contract the
 * SpaceScene crossfade relies on: pristine first capture wins, re-collection
 * after a room-props theme swap picks up new materials and drops removed
 * ones, shared materials dedupe, and the collector never disposes anything.
 * Real THREE.Group/Mesh/Material instances; no DOM, no React.
 */
import { describe, expect, it, vi } from "vitest";
import { Group, Mesh, MeshBasicMaterial } from "three";

import {
  applyFadeMaterials,
  collectFadeMaterials,
  restoreFadeMaterials,
} from "@/lib/game/fade-materials";

function mesh(mat: MeshBasicMaterial | MeshBasicMaterial[]): Mesh {
  return new Mesh(undefined, mat);
}

describe("collectFadeMaterials", () => {
  it("collects a single material with its authored state", () => {
    const mat = new MeshBasicMaterial({ opacity: 0.7, transparent: false });
    const entries = collectFadeMaterials(mesh(mat));
    expect(entries).toHaveLength(1);
    expect(entries[0].mat).toBe(mat);
    expect(entries[0].base).toBe(0.7);
    expect(entries[0].transparent).toBe(false);
  });

  it("dedupes a material shared by two meshes", () => {
    const shared = new MeshBasicMaterial({ opacity: 1 });
    const root = new Group();
    root.add(mesh(shared), mesh(shared));
    const entries = collectFadeMaterials(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].mat).toBe(shared);
  });

  it("keeps the pristine base when re-collected after a fade mutated opacity", () => {
    const mat = new MeshBasicMaterial({ opacity: 0.8, transparent: false });
    const root = new Group();
    root.add(mesh(mat));
    expect(collectFadeMaterials(root)[0].base).toBe(0.8);
    applyFadeMaterials(collectFadeMaterials(root), 0.25);
    expect(mat.opacity).toBeCloseTo(0.2);
    expect(mat.transparent).toBe(true);
    expect(collectFadeMaterials(root)[0].base).toBe(0.8);
    expect(collectFadeMaterials(root)[0].transparent).toBe(false);
  });

  it("includes replaced materials and excludes removed ones on re-collection", () => {
    const oldMat = new MeshBasicMaterial();
    const holder = mesh(oldMat);
    const root = new Group();
    root.add(holder);
    expect(collectFadeMaterials(root).map((e) => e.mat)).toEqual([oldMat]);

    const newMat = new MeshBasicMaterial({ opacity: 0.5 });
    holder.material = newMat;
    const entries = collectFadeMaterials(root);
    expect(entries.map((e) => e.mat)).toEqual([newMat]);
    expect(entries[0].base).toBe(0.5);
  });

  it("excludes a material whose mesh left the tree", () => {
    const gone = new MeshBasicMaterial();
    const holder = mesh(gone);
    const root = new Group();
    root.add(holder);
    root.remove(holder);
    expect(collectFadeMaterials(root)).toHaveLength(0);
  });

  it("handles array materials, deduping repeats inside and across meshes", () => {
    const a = new MeshBasicMaterial({ opacity: 0.9 });
    const b = new MeshBasicMaterial({ opacity: 0.4, transparent: true });
    const root = new Group();
    root.add(mesh([a, b, a]), mesh([b]));
    const entries = collectFadeMaterials(root);
    expect(entries.map((e) => e.mat)).toEqual([a, b]);
    expect(entries[0].base).toBe(0.9);
    expect(entries[1]).toMatchObject({ base: 0.4, transparent: true });
  });

  it("never calls dispose — ownership stays with the prop hooks", () => {
    const spy = vi.spyOn(MeshBasicMaterial.prototype, "dispose");
    const root = new Group();
    root.add(mesh(new MeshBasicMaterial()), mesh(new MeshBasicMaterial()));
    collectFadeMaterials(root);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("applyFadeMaterials", () => {
  it("scales from the authored base, not the faded current value", () => {
    const mat = new MeshBasicMaterial({ opacity: 0.6, transparent: false });
    const entries = collectFadeMaterials(mesh(mat));
    applyFadeMaterials(entries, 0.5);
    expect(mat.opacity).toBeCloseTo(0.3);
    expect(mat.transparent).toBe(true);
    // Fade further, then re-apply from the captured list: still base-derived.
    applyFadeMaterials(entries, 1);
    expect(mat.opacity).toBeCloseTo(0.6);
  });
});

describe("restoreFadeMaterials", () => {
  it("restores authored opacity and transparency", () => {
    const mat = new MeshBasicMaterial({ opacity: 0.75, transparent: false });
    const entries = collectFadeMaterials(mesh(mat));
    applyFadeMaterials(entries, 0);
    expect(mat.opacity).toBe(0);
    expect(mat.transparent).toBe(true);
    restoreFadeMaterials(entries);
    expect(mat.opacity).toBe(0.75);
    expect(mat.transparent).toBe(false);
  });

  it("restores an array-material entry to its authored state", () => {
    const mats = [
      new MeshBasicMaterial({ opacity: 1, transparent: false }),
      new MeshBasicMaterial({ opacity: 0.3, transparent: true }),
    ];
    const entries = collectFadeMaterials(mesh(mats));
    applyFadeMaterials(entries, 0.1);
    restoreFadeMaterials(entries);
    expect(mats[0]).toMatchObject({ opacity: 1, transparent: false });
    expect(mats[1]).toMatchObject({ opacity: 0.3, transparent: true });
  });
});
