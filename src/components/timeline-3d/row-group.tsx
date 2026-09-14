"use client";

/**
 * RowGroup (Rev 1) — one row of the 3D card field.
 *
 * Moved here from card-field.tsx so the main container can stay focused on
 * gesture/level/scroll orchestration. Each row renders:
 *   - the top card face (a real slice card, never a summary)
 *   - the pile's second real card in the first cascade slot (for L1/L2 stacks)
 *   - real 3D mesh backing sheets behind them for pile thickness/parallax.
 *
 * Content is loaded inside the card face via `SliceCardFace`; this file does
 * not know about the old `Map<string, ContentSlot>` data flow.
 */
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import {
  backingSheets,
  cardEmFor,
  framePitchFor,
  poseScaleFor,
  settleEase,
  sheetPose,
  type FrameGeometry,
  type StackRow,
} from "@/lib/timeline3d/stacks";
import { worldScaleFor } from "@/lib/timeline3d/camera";
import { FrameCardTexts, frameCardLabel, SliceCardFace } from "./frame-card";
import { SliceNarrateButton, type SliceNarration } from "./slice-narrate-button";
import { hhmm } from "./cards";
import {
  DEAL_DURATION,
  DEAL_STAGGER,
  GEN_WINDOW_MS,
  type FieldRig,
} from "./field-rig";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Depth between cascade sheets in world units AUTHORED against the old fixed
 *  camera; `worldScaleFor` converts it (0.1 there = camZ/9 here), which is what
 *  keeps the pile's depth cue the same fraction of the card at every viewport
 *  height. */
const SHEET_GAP_WORLD = 0.1;

const rowScratch = new THREE.Vector3();

declare global {
  interface Window {
    __dealDebug?: Array<{ rowKey: string; initialDeal: number; ts: number }>;
  }
}

function recordDealMount(rowKey: string, initialDeal: number) {
  if (typeof window === "undefined") return;
  window.__dealDebug ??= [];
  window.__dealDebug.push({ rowKey, initialDeal, ts: performance.now() });
}

function computeRowPosition(
  index: number,
  topPx: number,
  cardH: number,
  pileGapForDeal: number,
  rig: FieldRig,
  viewportH: number,
  reducedMotion: boolean,
  anim: { deal: number; lift: number },
  rowKey: string,
): THREE.Vector3 {
  const staggerOrder = Math.min(Math.abs(index - rig.anchorIndex), 12);
  const dealT = reducedMotion
    ? 1
    : settleEase(anim.deal - staggerOrder * (DEAL_STAGGER / DEAL_DURATION));

  // Screen-y px IS world-y (camera.ts), so the row's centre converts 1:1 — the
  // same equation the conversation field's camera offset uses.
  const centerPy = topPx + cardH / 2 - rig.current;
  const yWorld = viewportH / 2 - centerPy;
  const worldScale = worldScaleFor(viewportH);

  const origin = rig.dealOrigins?.get(rowKey);
  let x = 0;
  let y = yWorld;
  let z = 0;
  if (origin != null) {
    y = yWorld + (1 - dealT) * origin.dy;
    z = (1 - dealT) * origin.dz;
  } else {
    // The deal's lateral fan is measured in ROWS, so it needs a row ADVANCE —
    // the face plus the pile's own gap. Deliberately not the row's full extent:
    // the boundary region below a row is not part of the pile.
    const dealOffsetY =
      (1 - dealT) *
      (rig.anchorIndex - index) *
      (cardH + pileGapForDeal) *
      0.35;
    y = yWorld + dealOffsetY;
    z = (1 - dealT) * -0.45 * worldScale;
  }

  z += anim.lift * 0.05 * worldScale;
  return rowScratch.set(x, y, z);
}

/** Sheet corner radius in px — identical to the face's `rounded-[0.9em]`.
 *
 *  IT READS THE FACE'S EM, not a divisor of its own. It used to be
 *  `cardW * 0.9 / 26`, which was the same number as long as the face's em was
 *  `cardW/26` and NOTHING ELSE — so when the em gained a floor and a ceiling
 *  this would have quietly stopped matching the card it sits behind, and the
 *  sheet's corners would have peeked out from under a face rounding at a
 *  different radius. One function, both readers. */
export function sheetRadiusPx(geo: FrameGeometry): number {
  return cardEmFor(geo) * 0.9;
}

export interface RowGroupProps {
  row: StackRow;
  index: number;
  geo: FrameGeometry;
  /** The row's TOP edge, in world-y px — read off the field's offset table
   *  (`layoutFor`) rather than computed from `index * pitch`, because rows are
   *  no longer a fixed advance apart: each one reserves its own boundary
   *  region, and a conversation row measures its text. */
  topPx: number;
  /** The card-to-card advance minus the face — the room the pile cascades
   *  into, which the boundary region below the row must not inflate. */
  pileGap: number;
  rig: React.MutableRefObject<FieldRig>;
  reducedMotion: boolean;
  flash: boolean;
  onActivate: (row: StackRow) => void;
  ariaLabel: string;
  texts: FrameCardTexts;
  /** The 「讲讲这片」 corner action; absent (bridge brain) → not rendered. */
  narration?: SliceNarration;
}

export function RowGroup({
  row,
  index,
  geo,
  topPx,
  pileGap,
  rig,
  reducedMotion,
  flash,
  onActivate,
  ariaLabel,
  texts,
  narration,
}: RowGroupProps) {
  const groupRef = useRef<THREE.Group>(null);
  const size = useThree((s) => s.size);
  // Deal starts at 0 only for rows in the transition's visible set and only
  // within the generation window after a level/filter change.
  const animRef = useRef<{ deal: number; lift: number } | null>(null);
  if (animRef.current === null) {
    const inGenWindow = performance.now() - rig.current.genAt < GEN_WINDOW_MS;
    const initialDeal = reducedMotion
      ? 1
      : (rig.current.dealEligible?.has(row.key) && inGenWindow ? 0 : 1);
    animRef.current = { deal: initialDeal, lift: 0 };
    recordDealMount(row.key, initialDeal);
  }

  // Cascade scale: authored against a 216px card, amplified for the big
  // frame (the pile must READ), but never let the deepest sheet's peek
  // overflow the row gap.
  const scale = useMemo(() => {
    const maxPeek = pileGap * 0.75;
    return Math.min(poseScaleFor(geo) * 1.6, maxPeek / 40);
  }, [geo, pileGap]);
  // A pile's second layer is a REAL card too (its own slice, full content) —
  // it takes the first cascade slot, the shell sheets make up the rest.
  const second = row.level > 0 ? row.entries[1] : undefined;
  const sheets = Math.max(0, backingSheets(row.count) - (second ? 1 : 0));
  const poses = useMemo(
    () =>
      Array.from({ length: sheets + (second ? 1 : 0) }, (_, i) =>
        sheetPose(row.key, i),
      ),
    [row.key, sheets, second],
  );

  // Mount the group at the exact spot the first useFrame will compute so it
  // never flickers at the world origin before animation starts.
  const initialPos = useMemo<THREE.Vector3Tuple>(
    () =>
      computeRowPosition(
        index,
        topPx,
        geo.cardH,
        pileGap,
        rig.current,
        size.height,
        reducedMotion,
        animRef.current!,
        row.key,
      ).toArray(),
    [
      index,
      topPx,
      geo.cardH,
      pileGap,
      rig,
      size.height,
      reducedMotion,
      row.key,
    ],
  );

  useFrame((_, rawDt) => {
    const group = groupRef.current;
    if (!group) return;
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
      rig.current.dealEligible.delete(row.key);
    }
    const liftTarget = rig.current.hoverKey === row.key ? 1 : 0;
    anim.lift += (liftTarget - anim.lift) * Math.min(1, dt * 10);

    const p = computeRowPosition(
      index,
      topPx,
      geo.cardH,
      pileGap,
      rig.current,
      size.height,
      reducedMotion,
      anim,
      row.key,
    );
    group.position.set(p.x, p.y, p.z);

    // Sheets cascade behind the face; hover spreads the deck a little. The
    // pose offsets are px (world units now), the gap is an authored depth.
    const spread = 1 + anim.lift * 0.5;
    const worldScale = worldScaleFor(size.height);
    group.children.forEach((child, ci) => {
      if (ci === 0) return; // child 0 is the face anchor
      const si = ci - 1;
      const pose = poses[si];
      if (!pose) return;
      child.position.set(
        pose.offsetX * scale * spread,
        -pose.offsetY * scale * spread,
        -(si + 1) * SHEET_GAP_WORLD * spread * worldScale,
      );
      child.rotation.set(
        -0.07 - si * 0.02,
        0,
        ((pose.rotate * 1.35) * Math.PI) / 180,
      );
    });
  });

  return (
    <group ref={groupRef} position={initialPos}>
      {/* Face anchor (child 0) — the Html portal hangs the DOM card here. */}
      <Html
        transform
        center
        // 400 is drei's 1:1 reference: it renders a portal's DOM px as world
        // units, projected through a CSS `perspective` of `camZ` — and `camZ`
        // IS the focal length in px (camera.ts), so the ratio cancels. It was
        // `400 * wpp` while the camera was fixed; `wpp` is 1 now.
        distanceFactor={400}
        zIndexRange={[30, 21]}
        style={{ pointerEvents: "auto" }}
      >
        <div className="group/card relative" style={{ width: geo.cardW, height: geo.cardH }}>
          <div
            role="button"
            tabIndex={0}
            aria-label={ariaLabel}
            className="tl-card-in group cursor-pointer select-none"
            style={{ width: geo.cardW, height: geo.cardH }}
            onClick={() => onActivate(row)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(row);
              }
            }}
            onPointerEnter={() => (rig.current.hoverKey = row.key)}
            onPointerLeave={() => (rig.current.hoverKey = null)}
          >
            <SliceCardFace entry={row.top} geo={geo} flash={flash} texts={texts} />
          </div>
          {/* The narrate corner action — a SIBLING of the role="button" face,
              never a child (nesting interactives is invalid, and the card's
              Enter/Space handler would swallow the button's keystrokes). It
              sits inside the face's own rect, so hovering it does not fire the
              card's pointer-leave and lift the pile down/up. */}
          {narration && (
            <SliceNarrateButton
              label={narration.label}
              em={cardEmFor(geo)}
              onSelect={() =>
                narration.onSelect(
                  row.top.id,
                  `${row.top.date.slice(5).replace("-", "/")} ${hhmm(row.top.start)}`,
                )
              }
            />
          )}
        </div>
      </Html>
      {/* The pile's second card is REAL — its own slice's original card,
          same size/paper as the face, peeking from the first cascade slot. */}
      {second && (
        <Html
          transform
          center
          distanceFactor={400}
          zIndexRange={[20, 11]}
          style={{ pointerEvents: "none" }}
        >
          <div aria-hidden style={{ width: geo.cardW, height: geo.cardH }}>
            <SliceCardFace entry={second} geo={geo} texts={texts} />
          </div>
        </Html>
      )}
      {/* Backing sheets: gray skeleton stand-ins of the dossier card (muted
          paper + gray bars echoing the timecode/title/fields/bubbles layout),
          bill boarded at real z-depths so scroll/camera movement creates
          parallax between layers. Never real content, never stark white. */}
      {poses.slice(second ? 1 : 0).map((_, si) => {
        // Absolute cascade layer (0 = directly behind the face) drives the
        // deep-layer fade.
        const li = si + (second ? 1 : 0);
        const opacity = li >= 4 ? Math.max(0.4, 1 - (li - 3) * 0.18) : 1;
        return (
          <Html
            key={`${row.key}#s${si}`}
            transform
            center
            distanceFactor={400}
            zIndexRange={[10, 1]}
            style={{ pointerEvents: "none" }}
          >
            <div
              aria-hidden
              className="relative overflow-hidden bg-muted ring-1 ring-foreground/10 shadow-[0_18px_40px_-16px_rgba(15,23,42,0.22)] dark:shadow-[0_18px_40px_-16px_rgba(0,0,0,0.7)]"
              style={{
                width: geo.cardW,
                height: geo.cardH,
                borderRadius: sheetRadiusPx(geo),
                opacity,
                fontSize: Math.min(geo.cardW, geo.cardH) / 26,
              }}
            >
              {/* gray spine — the loading-version echo of the face's strand
                  spine (0.14em accent bar down the left edge) */}
              <span className="absolute inset-y-0 left-0 w-[0.14em] bg-foreground/15" />
              {/* hairlines echoing the dossier section separators */}
              <div className="absolute inset-x-[7%] top-[12%] h-px bg-foreground/[0.07]" />
              <div className="absolute inset-x-[7%] top-[33%] h-px bg-foreground/[0.07]" />
              <div className="absolute inset-x-[7%] top-[53%] h-px bg-foreground/[0.07]" />
              <div className="absolute inset-x-[7%] bottom-[7.5%] h-px bg-foreground/[0.07]" />
              {/* timecode row: square tick + mono line, frame number at right */}
              <div className="absolute left-[7%] top-[6%] size-[1.8%] min-h-2 min-w-2 rounded-[2px] bg-foreground/15" />
              <div className="absolute left-[12%] top-[6.5%] h-[1.6%] w-[24%] rounded-full bg-foreground/10" />
              <div className="absolute right-[7%] top-[6.5%] h-[1.6%] w-[13%] rounded-full bg-foreground/8" />
              {/* serif title */}
              <div className="absolute left-[7%] top-[14%] h-[3%] w-[52%] rounded-full bg-foreground/12" />
              {/* previously-on quote */}
              <div className="absolute left-[7%] top-[24%] h-[1.8%] w-[64%] rounded-full bg-foreground/8" />
              {/* archive field rows: short label + long value */}
              <div className="absolute left-[7%] top-[37%] h-[1.8%] w-[7%] rounded-full bg-foreground/10" />
              <div className="absolute left-[21%] top-[37%] h-[1.8%] w-[38%] rounded-full bg-foreground/8" />
              <div className="absolute left-[7%] top-[45%] h-[1.8%] w-[7%] rounded-full bg-foreground/10" />
              <div className="absolute left-[21%] top-[45%] h-[1.8%] w-[52%] rounded-full bg-foreground/8" />
              {/* dialogue: user bubble, agent reply line, user bubble */}
              <div className="absolute right-[7%] top-[57%] h-[9%] w-[48%] rounded-[1.2em] bg-foreground/10" />
              <div className="absolute left-[7%] top-[71%] h-[1.8%] w-[36%] rounded-full bg-foreground/8" />
              <div className="absolute right-[7%] top-[78%] h-[10%] w-[56%] rounded-[1.2em] bg-foreground/10" />
              {/* footer frame code */}
              <div className="absolute bottom-[4%] right-[7%] h-[1.6%] w-[12%] rounded-full bg-foreground/8" />
            </div>
          </Html>
        );
      })}
    </group>
  );
}

