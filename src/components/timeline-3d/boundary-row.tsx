"use client";

/**
 * BoundaryRow — one intertitle at a card rung (v0.13).
 *
 * The conversation has always stated its boundaries: crossing from one slice to
 * the next is arriving at a new time, and `SliceGate` says how far away it is
 * and what the far side is about. The card rungs said NOTHING — the only mark
 * on a boundary was a 6px dot on the band (`CrossingDot`), which names neither
 * the interval nor the destination. This is the same statement, in the same
 * component, at the coarser zoom.
 *
 * WHY IT IS ITS OWN ROW AND NOT PART OF THE CARD. A gate belongs to the unit it
 * CLOSES, so it sits in the trailing region of `FIELD_BOUNDARY_PX` that
 * `layoutFor` reserves after each row. Hanging it inside the card's `<Html>`
 * would be cheaper to wire and wrong in two ways: drei's `<Html>` is
 * centre-anchored, so adding a gate below the face would drag the face up by
 * half a gate; and the gate is a FIXED-height box while the card's cascade
 * assumes the space under it is the pile's own gap.
 *
 * Position is written imperatively in the frame loop, the same way `RowGroup`
 * writes its own — a `position` prop would re-render the portal on every
 * scrolled frame to move two words.
 */
import { useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import type { UnitBoundary } from "@/lib/timeline3d/boundary";
import type { GateSignal } from "@/lib/chat/field-blocks";
import { FIELD_BOUNDARY_PX } from "@/lib/timeline3d/units";
import { SliceGate } from "@/components/chat/slice-gate";
import type { FieldRig } from "./field-rig";

export interface BoundaryRowProps {
  /** The world-y px of this boundary's top edge — the closing row's face plus
   *  its card height, which is where `layoutFor` puts the boundary region. */
  topPx: number;
  /** The box's width, so the rule lines up with the cards above and below it. */
  width: number;
  boundary: UnitBoundary;
  /** The field's arm state for this boundary — a mutable object written each
   *  frame rather than a prop, because arming flips while scrolling and every
   *  gate is its own React root. */
  signal: GateSignal;
  rig: React.MutableRefObject<FieldRig>;
}

export function BoundaryRow({
  topPx,
  width,
  boundary,
  signal,
  rig,
}: BoundaryRowProps) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  const locale = useLocale();
  const messages = useMessages();

  useFrame(() => {
    if (!group.current) return;
    // Screen-y px IS world-y (camera.ts): one equation, the same one the rows
    // and the conversation field's camera offset use.
    const centerPy = topPx + FIELD_BOUNDARY_PX / 2 - rig.current.current;
    group.current.position.y = size.height / 2 - centerPy;
  });

  return (
    <group ref={group}>
      <Html
        transform
        center
        distanceFactor={400}
        // Under the cards (their ranges start at 21): a boundary is context,
        // and the face of the row above it must win any overlap.
        zIndexRange={[20, 11]}
        pointerEvents="none"
      >
        <NextIntlClientProvider messages={messages} locale={locale}>
          {/* Dynamic: width lines the gate up with the cards' rule; the
              height is the lib's boundary-region constant (world geometry —
              the 3D layout and this DOM box share one source of truth). */}
          <div style={{ width, height: FIELD_BOUNDARY_PX }}>
            <SliceGate
              dateIso={boundary.atIso}
              prevActivityIso={boundary.fromIso}
              focus={boundary.focus}
              prevFocus={boundary.prevFocus}
              signal={signal}
            />
          </div>
        </NextIntlClientProvider>
      </Html>
    </group>
  );
}
