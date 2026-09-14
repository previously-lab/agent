"use client";

/**
 * LeavingCard (Rev 1) — a slice that got swallowed by a coarser stack during
 * a level transition.
 *
 * Moved here from card-field.tsx. Like `RowGroup`, it renders a self-loading
 * `SliceCardFace` so content resolves independently instead of being driven by
 * a top-level `Map<string, ContentSlot>`.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import {
  framePitchFor,
  settleEase,
  type FrameGeometry,
  type StackLevel,
} from "@/lib/timeline3d/stacks";
import { FrameCardTexts, SliceCardFace } from "./frame-card";
import { DEAL_DURATION, type FieldRig, type LeavingItem } from "./field-rig";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Depth between stacked leaving cards, in px — and a px IS a world unit
 *  (camera.ts), so it needs no conversion. */
const SHEET_GAP_PX = 5;
const LEAVING_STAGGER_S = 0.03;
const LEAVING_MAX_DEPTH = 12;

const leavingScratch = new THREE.Vector3();

function computeLeavingPosition(
  item: LeavingItem,
  rowIndexMap: Map<string, number>,
  /** The destination level's offset table — `layoutFor`, not `index * pitch`.
   *  Since every row but the last reserves a boundary region, a row's advance
   *  is `cardH + SLICE_GATE_PX`, which is not `framePitchFor` and drifts
   *  further from it the deeper the index. Using the pitch sent a swallowed
   *  card to a row that was `targetIndex * 32px` away from the pile it was
   *  meant to join. */
  tops: readonly number[],
  pitch: number,
  cardH: number,
  rig: FieldRig,
  viewportH: number,
  reducedMotion: boolean,
  anim: { deal: number },
): THREE.Vector3 {
  const staggerDepth = Math.min(item.depth, LEAVING_MAX_DEPTH);
  const dealT = reducedMotion
    ? 1
    : settleEase(anim.deal - staggerDepth * (LEAVING_STAGGER_S / DEAL_DURATION));

  // Screen-y px IS world-y (camera.ts): the source row's px position, the
  // destination row's centre, and the pile's px jitter all convert 1:1.
  const fromYWorld = viewportH / 2 - item.fromYpx;

  const targetIndex = rowIndexMap.get(item.toRowKey) ?? -1;
  let targetYWorld = fromYWorld;
  if (targetIndex >= 0) {
    const centerPy = (tops[targetIndex] ?? targetIndex * pitch) + cardH / 2 - rig.current;
    targetYWorld = viewportH / 2 - centerPy;
  }

  const depthSign = item.depth % 2 === 0 ? 1 : -1;
  const depthJitterPx = 1 + (item.depth % 3);
  const targetYOffset = -item.depth * 1.5;
  const targetXOffset = depthSign * depthJitterPx;

  const y = fromYWorld + dealT * (targetYWorld + targetYOffset - fromYWorld);
  const z = -(item.depth + 1) * SHEET_GAP_PX;

  return leavingScratch.set(targetXOffset, y, z);
}

export interface LeavingCardProps {
  item: LeavingItem;
  rowIndexMap: Map<string, number>;
  /** The destination level's offset table — see `computeLeavingPosition`. */
  tops: readonly number[];
  level: StackLevel;
  geo: FrameGeometry;
  rig: React.MutableRefObject<FieldRig>;
  reducedMotion: boolean;
  texts: FrameCardTexts;
  onDone: (id: string) => void;
}

export function LeavingCard({
  item,
  rowIndexMap,
  tops,
  level,
  geo,
  rig,
  reducedMotion,
  texts,
  onDone,
}: LeavingCardProps) {
  const groupRef = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);
  const animRef = useRef<{ deal: number; done: boolean }>({
    deal: reducedMotion ? 1 : 0,
    done: reducedMotion,
  });

  const pitch = framePitchFor(level, geo);

  // Mount the group at the exact spot the first useFrame will compute so it
  // never flickers at the world origin before animation starts.
  const initialPos = useMemo<THREE.Vector3Tuple>(
    () =>
      computeLeavingPosition(
        item,
        rowIndexMap,
        tops,
        pitch,
        geo.cardH,
        rig.current,
        size.height,
        reducedMotion,
        animRef.current,
      ).toArray(),
    [item, rowIndexMap, tops, pitch, geo.cardH, rig, size.height, reducedMotion],
  );

  useFrame((_, rawDt) => {
    const group = groupRef.current;
    if (!group) return;
    const dt = Math.min(rawDt, 0.1);

    const anim = animRef.current;
    anim.deal = Math.min(
      1 + (LEAVING_MAX_DEPTH * LEAVING_STAGGER_S) / DEAL_DURATION,
      anim.deal + dt / DEAL_DURATION,
    );
    const staggerDepth = Math.min(item.depth, LEAVING_MAX_DEPTH);
    const dealT = reducedMotion
      ? 1
      : settleEase(
          anim.deal - staggerDepth * (LEAVING_STAGGER_S / DEAL_DURATION),
        );

    const p = computeLeavingPosition(
      item,
      rowIndexMap,
      tops,
      pitch,
      geo.cardH,
      rig.current,
      size.height,
      reducedMotion,
      anim,
    );
    group.position.set(p.x, p.y, p.z);

    if (dealT >= 1 && !anim.done) {
      anim.done = true;
      onDone(item.id);
    }
  });

  return (
    <group ref={groupRef} position={initialPos}>
      <Html
        transform
        center
        // 400 is drei's 1:1 reference (see row-group.tsx) — the camera
        // distance is the focal length in px, so the ratio cancels.
        distanceFactor={400}
        zIndexRange={[25, 16]}
        style={{ pointerEvents: "none" }}
      >
        <div aria-hidden style={{ width: geo.cardW, height: geo.cardH }}>
          <SliceCardFace entry={item.slice} geo={geo} texts={texts} />
        </div>
      </Html>
    </group>
  );
}
