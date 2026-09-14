"use client";

/**
 * OriginRow — the window's head at a card rung (v0.13).
 *
 * The card rungs had NO head: the top of the loaded window was simply where the
 * oldest row happened to start, so there was nothing to tell the reader they had
 * reached it and nothing to ask from. The conversation field has had one since
 * the unified stream (`chat/field-origin.tsx`), and this is the same region at
 * the coarser zooms — the same component, in the same visual language, offered
 * the same way.
 *
 * WHY IT IS ITS OWN ROW, exactly as `BoundaryRow` is. The head is a LEADING
 * region above unit 0 (`field-blocks.ts`), while a boundary is a TRAILING
 * region on the unit that closes it — the asymmetry is what keeps a page
 * arriving at the head from growing a unit the reader is looking at. A leading
 * region belongs to no row, so it cannot live inside one; and hanging it inside
 * row 0's `<Html>` would drag that card down by half a head, because drei's
 * `<Html>` is centre-anchored.
 *
 * Position is written imperatively in the frame loop, the same way `RowGroup`
 * and `BoundaryRow` write theirs — a `position` prop would re-render the portal
 * on every scrolled frame to move a static region.
 */
import { useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { FIELD_ORIGIN_PX, type GateSignal } from "@/lib/chat/field-blocks";
import { FieldOrigin } from "@/components/chat/field-origin";
import type { FieldRig } from "./field-rig";

export interface OriginRowProps {
  /** The world-y px of the head's BOTTOM edge — unit 0's top, off the offset
   *  table. The head is the `FIELD_ORIGIN_PX` strip that ends there. */
  bottomPx: number;
  /** The box's width, so the head lines up with the cards below it. */
  width: number;
  /** Start of the oldest loaded slice — the time the head is at. */
  oldestIso: string;
  /** Whether the catalog still holds older slices. */
  hasMore: boolean;
  /** True while the older page is in flight. */
  loading: boolean;
  onLoadOlder: () => void;
  /** The field's arm state for the head — a mutable object written each frame
   *  rather than a prop, because arming flips while scrolling and this is its
   *  own React root. */
  signal: GateSignal;
  rig: React.MutableRefObject<FieldRig>;
}

export function OriginRow({
  bottomPx,
  width,
  oldestIso,
  hasMore,
  loading,
  onLoadOlder,
  signal,
  rig,
}: OriginRowProps) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  const locale = useLocale();
  const messages = useMessages();

  useFrame(() => {
    if (!group.current) return;
    // Screen-y px IS world-y (camera.ts): one equation, the same one the rows
    // and the boundary regions use. The box is CENTRE-anchored by drei, so the
    // anchor is the middle of the head's strip.
    const centerPy = bottomPx - FIELD_ORIGIN_PX / 2 - rig.current.current;
    group.current.position.y = size.height / 2 - centerPy;
  });

  return (
    <group ref={group}>
      <Html
        transform
        center
        distanceFactor={400}
        // ABOVE the cards (whose ranges start at 21), unlike a boundary: the
        // head carries a BUTTON, and the deal plays rows in from other slots,
        // so a row passing through this region must not swallow the one
        // control the head has.
        zIndexRange={[40, 31]}
        style={{ pointerEvents: "none" }}
      >
        <NextIntlClientProvider messages={messages} locale={locale}>
          <div style={{ width, height: FIELD_ORIGIN_PX }}>
            <FieldOrigin
              oldestIso={oldestIso}
              hasMore={hasMore}
              loading={loading}
              onLoadOlder={onLoadOlder}
              signal={signal}
            />
          </div>
        </NextIntlClientProvider>
      </Html>
    </group>
  );
}
