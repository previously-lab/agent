"use client";

/**
 * ConversationUnit — one slice at the field's FINEST rung (`units.ts`).
 *
 * WHAT IT IS. The field lays out units; this is the one that wears turns
 * instead of a card. Its whole job is POSITION, because the unit itself is
 * `SliceConversation` — a component the conversation field already rendered and
 * which the timeline now renders unmodified.
 *
 * WHY THE CENTRE AND NOT THE TOP EDGE. A conversation unit is as tall as its
 * text, so the obvious thing is to anchor its top edge and let it grow
 * downward. drei's `<Html>` does not offer that: in `transform` mode it IGNORES
 * `center` entirely (see `Html.js` — the `center` transform is only built on
 * the non-transform branch) and lays the DOM out from its own middle, so the
 * portal is centred on whatever point the group projects to.
 *
 * Centre-anchoring is still top-anchoring here, and the algebra is worth
 * stating because it is what makes it safe: placing the group at
 * `topPx + extent / 2` puts the DOM's top edge at `topPx + extent/2 - H/2`,
 * which is exactly `topPx` whenever the DOM's height `H` equals the extent the
 * layout reserved for it. So the unit's top edge does not move when its text
 * settles — it only moves by half the difference during the frames between a
 * measurement landing and the table being rebuilt from it, which is bounded and
 * self-correcting rather than cumulative.
 *
 * Growth is therefore free in the direction that matters: the top is pinned and
 * the unit extends downward from it, which is the property the whole offset
 * table exists to protect.
 *
 * It renders NOTHING but the slice: the gate that closes this unit is drawn
 * INSIDE `SliceConversation`, at its tail, because the boundary belongs to the
 * unit it closes and the field has already reserved the room for it.
 */
import { useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useLocale, useMessages } from "next-intl";
import type { TimelineSliceEntry } from "@/lib/episodic/timeline/types";
import type { UnitBoundary } from "@/lib/timeline3d/boundary";
import type { GateSignal } from "@/lib/chat/field-blocks";
import { CONVERSATION_COLUMN_PX } from "@/lib/chat/field-blocks";
import { settleEase } from "@/lib/timeline3d/stacks";
import { SliceConversation } from "@/components/field/slice-conversation";
import {
  DEAL_DURATION,
  DEAL_STAGGER,
  GEN_WINDOW_MS,
  type FieldRig,
} from "./field-rig";

export interface ConversationUnitProps {
  /** The slice this unit is. */
  entry: TimelineSliceEntry;
  /** This unit's position in the field's unit list — the deal's stagger. */
  index: number;
  /** The world-y px of this unit's CENTRE, off the field's offset table. */
  centerPx: number;
  /** The boundary that closes this unit, or null when it closes none. */
  boundary: UnitBoundary | null;
  /** Arm state for that boundary — see `GateSignal`. */
  signal: GateSignal | undefined;
  rig: React.MutableRefObject<FieldRig>;
  /** The unit's measured face height, reported up to the offset table. This is
   *  the field's ONLY measurement of a conversation unit; everything below it
   *  is placed on the strength of this number. */
  onHeight: (px: number) => void;
}

export function ConversationUnit({
  entry,
  index,
  centerPx,
  boundary,
  signal,
  rig,
  onHeight,
}: ConversationUnitProps) {
  const group = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);
  const locale = useLocale();
  const messages = useMessages();

  // The unit plays the same deal the cards do — it is the same transition seen
  // one rung down, and a rung change where half the units fly and the other
  // half snap reads as two events rather than one.
  const animRef = useRef<{ deal: number } | null>(null);
  if (animRef.current === null) {
    const inGenWindow = performance.now() - rig.current.genAt < GEN_WINDOW_MS;
    const initialDeal =
      rig.current.dealEligible?.has(entry.id) && inGenWindow ? 0 : 1;
    animRef.current = { deal: initialDeal };
  }

  useFrame((_, rawDt) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    const anim = animRef.current!;
    anim.deal = Math.min(
      1 + (12 * DEAL_STAGGER) / DEAL_DURATION,
      anim.deal + dt / DEAL_DURATION,
    );
    if (
      rig.current.dealEligible &&
      anim.deal >= 1 + (12 * DEAL_STAGGER) / DEAL_DURATION
    ) {
      rig.current.dealEligible.delete(entry.id);
    }

    const staggerOrder = Math.min(Math.abs(index - rig.current.anchorIndex), 12);
    const dealT = settleEase(
      anim.deal - staggerOrder * (DEAL_STAGGER / DEAL_DURATION),
    );
    const origin = rig.current.dealOrigins?.get(entry.id);
    // Screen-y px IS world-y (camera.ts): one equation, the same one the rows
    // and the conversation field's own camera offset use.
    const centerPy = centerPx - rig.current.current;
    g.position.y =
      size.height / 2 - centerPy - (1 - dealT) * (origin?.dy ?? 0);
  });

  return (
    <group ref={group}>
      <Html
        transform
        // `center` is deliberately NOT passed: in transform mode drei ignores
        // it and centres the portal on the anchor point either way (see the
        // header). Stating it would suggest a choice that does not exist.
        distanceFactor={400}
        // The card faces' range, because a conversation is a face too — and a
        // slice the reader can select text in must win any overlap with the
        // cards scrolled past above it.
        zIndexRange={[30, 21]}
        style={{ width: CONVERSATION_COLUMN_PX, pointerEvents: "auto" }}
      >
        <SliceConversation
          entry={entry}
          boundary={boundary}
          gateSignal={signal}
          messages={messages}
          locale={locale}
          onHeight={onHeight}
        />
      </Html>
    </group>
  );
}
