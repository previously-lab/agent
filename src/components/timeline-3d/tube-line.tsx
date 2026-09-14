"use client";

/**
 * TubeLine — one line of the band, as an instanced CYLINDER.
 *
 * WHAT IT IS. `three`'s own `CylinderGeometry`, one instance per polyline
 * segment, placed and oriented by the frame loop through `setMatrixAt`. There
 * is no custom geometry and no custom shader: three draws the tube, three's
 * material colours it, and the per-instance colour rides on `InstancedMesh`'s
 * own `instanceColor`. Everything the band needs to say about a line — which
 * strand it is, how deep its lane sits, whether it is singled out, where the
 * pulse is — is decided on the CPU and handed over as an instance colour, so
 * the GPU side is entirely the framework's.
 *
 * WHY A CYLINDER AT ALL, when a flat quad draws the same silhouette. Because a
 * cylinder is a closed surface: it has a depth, so two strands crossing now
 * OCCLUDE each other instead of piling their ink into the same pixels. The
 * crossings in this band are its densest region, and the flat quads made them
 * the dirtiest one.
 *
 * IT IS UNLIT (`MeshBasicMaterial`), ON PURPOSE. The band is a quiet strip of
 * grey threads with one blue spine, and the whole ink model is "the line fades
 * toward the page" — a strand is a blend from the background to its own colour.
 * A lit material cannot express that: it would darken the far side of every
 * tube toward BLACK, which on a white page reads as a hard dark rim around
 * every line and makes the braid heavier than the strip should ever be. So the
 * material is unlit and the CPU owns the colour, exactly as it did when these
 * were flat quads — the geometry changed, the ink did not.
 *
 * That also means the tubes currently read flat, because with no shading a
 * cylinder's silhouette is the same shape as the quad's. The geometry is what
 * makes a lit look possible later: adding one `<directionalLight>` and swapping
 * this material for a lit one is all it would take, and nothing else here would
 * move.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RADIAL_SEGMENTS } from "@/lib/timeline3d/tube";

/** The direction `CylinderGeometry` points before any rotation — so orienting
 *  an instance onto a segment is one `setFromUnitVectors` against this. */
const CYLINDER_AXIS = new THREE.Vector3(0, 1, 0);

export interface TubeLineProps {
  /** One instance per segment — the count the frame loop writes. */
  segments: number;
  /** Handed the mesh so the frame loop can reach its matrices and colours. */
  onObject: (obj: THREE.InstancedMesh | null) => void;
  /** Whether the line participates in depth testing. The core and its
   *  companion do not: they are the spine the strands wrap around, and they are
   *  meant to stay legible through the braid rather than be occluded by it. */
  depthTest?: boolean;
  depthWrite?: boolean;
  renderOrder?: number;
  /**
   * The colour every instance starts at, before the frame loop writes its own.
   * A slot that somehow reached the screen first would be a quiet thread rather
   * than an unexplained one.
   *
   * OMITTING IT MEANS "ONE COLOUR FOR THE WHOLE LINE", carried on the material
   * instead. That is not just a shortcut: three multiplies `instanceColor` into
   * the material's colour, so seeding a flat line with its own colour would
   * square it — a blue spine rendered as blue × blue, which reads as a darker,
   * wronger blue. Leaving `instanceColor` uncreated is what keeps the core's
   * colour exactly what the frame loop writes.
   */
  initialColor?: THREE.Color;
}

export function TubeLine({
  segments,
  onObject,
  depthTest = true,
  depthWrite = true,
  renderOrder = 1,
  initialColor,
}: TubeLineProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const geometry = useMemo(
    () =>
      // A unit cylinder — radius 1, height 1, open-ended (there is no cap to
      // see on a hairline, and caps would double the triangle count for it).
      // The instance matrix scales it to the live radius and segment length.
      new THREE.CylinderGeometry(1, 1, 1, RADIAL_SEGMENTS, 1, true),
    [],
  );
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.FrontSide,
        depthTest,
        depthWrite,
      }),
    // The depth state is applied by the effect below; construction only needs
    // to happen once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    material.depthTest = depthTest;
    material.depthWrite = depthWrite;
  }, [material, depthTest, depthWrite]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !initialColor) return;
    const color = initialColor;
    for (let i = 0; i < segments; i++) mesh.setColorAt(i, color);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [segments, initialColor]);

  return (
    // No bounding volume is derived from instance matrices, so three would
    // frustum-test the unit cylinder at the origin and drop the whole line the
    // moment the band scrolled. `frustumCulled` is the only correct answer.
    <instancedMesh
      ref={(el) => {
        meshRef.current = el;
        onObject(el);
      }}
      args={[geometry, material, segments]}
      renderOrder={renderOrder}
      frustumCulled={false}
    />
  );
}
