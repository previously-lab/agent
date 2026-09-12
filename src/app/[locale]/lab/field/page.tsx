"use client";

/**
 * LAB — the conversation-as-field spike. NOT part of the product; delete this
 * whole route when the experiment is over.
 *
 * THE QUESTION IT ANSWERS. Can the conversation be laid out in world space and
 * navigated by moving the CAMERA, with each slice a real DOM block hung on a
 * billboard — instead of living inside a browser scroll container that we then
 * have to fight (scroll anchoring, estimate-then-correct, momentum that cannot
 * be handed between elements)?
 *
 * THE MODEL, in three lines:
 *   - one orthographic camera at zoom 1, so ONE WORLD UNIT IS ONE CSS PIXEL —
 *     no distanceFactor, no scale, text stays crisp by construction;
 *   - a group whose y is the scroll offset, so scrolling moves the world and
 *     never a scroll container's content;
 *   - each slice is a three.js object at its own world y, with the REAL
 *     conversation components (SliceSeam + HistoryTurn) hung on it through
 *     drei's <Html> in SCREEN-SPACE mode (not `transform`), which positions the
 *     element by projection and leaves it at 1:1.
 *
 * WHAT IS DELIBERATELY FAKE FOR NOW:
 *   - the blocks are synthetic (no memory read), and they all measure about the
 *     same height, so the running offset is arithmetic. Real per-block
 *     measurement — and the compensation it needs — is the NEXT step, not this
 *     one. If the heights below do not match, you will see it immediately as
 *     blocks overlapping or drifting apart.
 *   - scrolling is driven by a wheel listener on the wrapper, not a native
 *     scroll element. Trackpad inertia survives this (it arrives as a decaying
 *     stream of wheel events), but a real implementation should use a native
 *     scroller as the input device so nothing is re-implemented.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { SliceSeam } from "@/components/chat/slice-seam";
import { HistoryTurn } from "@/components/chat/history-turn";
import { AxisBand } from "@/components/timeline-3d/axis-band";
import type { FieldAnchor } from "@/lib/timeline3d/winding";
import type { StackLevel } from "@/lib/timeline3d/stacks";
import type { StrandListItem } from "@/lib/episodic/actions";

/** The conversation column's width in px — one world unit is one px, so this
 *  is also its width in world units. */
const COLUMN_PX = 680;
/** How far outside the viewport a block is still mounted, in px. */
const OVERSCAN_PX = 900;

// ─── Synthetic content ──────────────────────────────────────────────────────

interface LabTurn {
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

interface LabBlock {
  key: string;
  dateIso: string;
  seam: "checkpoint" | "boundary";
  prevActivityIso?: string;
  strands: string[];
  turns: LabTurn[];
}

const LINES = [
  "Yeah, he did. His mom teared up a little. Honestly, I feel like a weight lifted.",
  "You'd put in the work long before tonight, one step at a time.",
  "Kept it short and honest, like you said. Marcus hugged me after.",
  "That makes sense. All those runs, the side project, the friendships — it's all connected.",
  "Weird to think how much has changed since January 2024.",
  "The speech went better than I could've hoped. Never thought I'd pull that off.",
  "You've got this. Just remember to enjoy it.",
];

function makeBlocks(n: number): LabBlock[] {
  const out: LabBlock[] = [];
  for (let i = 0; i < n; i++) {
    const day = 11 + i;
    const dateIso = `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
    const turnCount = 2 + (i % 4); // 2..5 — deliberately NOT uniform
    const turns: LabTurn[] = [];
    for (let t = 0; t < turnCount; t++) {
      const line = LINES[(i + t) % LINES.length];
      turns.push({
        role: t % 2 === 0 ? "user" : "agent",
        content: line.repeat(1 + ((i + t) % 2)),
        timestamp: dateIso,
      });
    }
    out.push({
      key: `block-${i}`,
      dateIso,
      seam: i % 3 === 0 ? "boundary" : "checkpoint",
      prevActivityIso: dateIso,
      strands: [["fitness", "speech", "wedding", "工作"][i % 4]],
      turns,
    });
  }
  return out;
}

// ─── The scene ──────────────────────────────────────────────────────────────

interface SceneProps {
  blocks: LabBlock[];
  /** Eased scroll offset, px. Read every frame. */
  offsetRef: React.MutableRefObject<number>;
  /** Measured DOM height per block index; filled in as blocks mount. */
  heightsRef: React.MutableRefObject<number[]>;
  /** Running world offset of each block's top, derived from the heights. */
  offsetsRef: React.MutableRefObject<number[]>;
  /** Called when a measurement changes the layout. */
  onLayout: () => void;
  /** Reported to the HUD. */
  onStats: (s: { mounted: number; total: number }) => void;
  messages: ReturnType<typeof useMessages>;
  locale: string;
  /** The band reads these every frame — the FIELD is the anchor producer here,
   *  exactly as the card field is in the timeline view. */
  anchorsRef: React.MutableRefObject<FieldAnchor[]>;
  /** 0..1 through the content, for the band's ruler + rotation drift. */
  progressRef: React.MutableRefObject<number>;
}

function FieldScene({
  blocks,
  offsetRef,
  heightsRef,
  offsetsRef,
  onLayout,
  onStats,
  messages,
  locale,
  anchorsRef,
  progressRef,
}: SceneProps) {
  const group = useRef<THREE.Group>(null);
  const { size } = useThree();
  // The mounted set is REACT state, not a per-frame read: it decides which
  // <Html> portals exist, so it has to go through a render. It changes only
  // when the window crosses a block boundary, which is rare — the per-frame
  // work is the group's y and nothing else.
  const [visible, setVisible] = useState<number[]>([]);
  const lastKey = useRef("");

  useFrame(() => {
    // The whole world slides; there is no scroll container to move.
    if (group.current) {
      group.current.position.y = size.height / 2 + offsetRef.current;
    }

    const offsets = offsetsRef.current;
    const top = offsetRef.current - OVERSCAN_PX;
    const bottom = offsetRef.current + size.height + OVERSCAN_PX;
    const next: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const start = offsets[i] ?? 0;
      const end = offsets[i + 1] ?? start + 1;
      if (end < top || start > bottom) continue;
      next.push(i);
    }
    const key = next.join(",");
    if (key !== lastKey.current) {
      lastKey.current = key;
      setVisible(next);
      onStats({ mounted: next.length, total: blocks.length });
    }

    // ── The anchor feed the band reads ──────────────────────────────────
    // The same contract the card field publishes in the timeline view: each
    // block's on-screen CENTRE as a fraction of the shared viewport, the
    // strands it carries, and its own extent. Because the band is registered
    // to these, it winds at the content and unwinds between blocks — the same
    // behaviour, produced by a different view.
    const totalPx = offsets[blocks.length] ?? 1;
    progressRef.current = totalPx > 0 ? offsetRef.current / totalPx : 1;
    const list: FieldAnchor[] = [];
    for (const i of next) {
      const start = offsets[i] ?? 0;
      const h = (offsets[i + 1] ?? start + 1) - start;
      list.push({
        y: (start + h / 2 - offsetRef.current) / size.height,
        strands: blocks[i].strands,
        span: h / size.height,
      });
    }
    anchorsRef.current = list;
  });

  const offsets = offsetsRef.current;

  return (
    <group ref={group}>
      {visible.map((i) => (
        <Html
          // NOT `transform`: screen-space mode positions the element by
          // projection and leaves it at 1:1, so text is never scaled.
          key={blocks[i].key}
          position={[-COLUMN_PX / 2, -(offsets[i] ?? 0), 0]}
          zIndexRange={[10, 0]}
          style={{ width: COLUMN_PX }}
        >
          <LabBlockDOM
            block={blocks[i]}
            index={i}
            heightsRef={heightsRef}
            onMeasure={onLayout}
            messages={messages}
            locale={locale}
          />
        </Html>
      ))}
    </group>
  );
}

/**
 * The real conversation components, measured as they mount.
 *
 * THE PROVIDER IS NOT OPTIONAL. drei's `<Html>` mounts its children into a
 * SEPARATE React root, so nothing from the tree above the `<Canvas>` reaches
 * them — every context, `NextIntlClientProvider` included, is cut at the
 * portal. This repo already hit this: `frame-card.tsx` takes all its strings as
 * props for exactly this reason. Re-wrapping each portal is the cheaper half of
 * that trade when the components are ones we would rather not rewrite (these
 * two are used verbatim by the real stream); passing strings would mean forking
 * them.
 *
 * The cost is one provider per MOUNTED block. That is affordable only because
 * the mounted set is small by design — a handful of blocks, never the list.
 */
function LabBlockDOM({
  block,
  index,
  messages,
  locale,
  heightsRef,
  onMeasure,
}: {
  block: LabBlock;
  index: number;
  messages: ReturnType<typeof useMessages>;
  locale: string;
  heightsRef: React.MutableRefObject<number[]>;
  onMeasure: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (!h || heightsRef.current[index] === h) return;
    heightsRef.current[index] = h;
    onMeasure();
  });

  return (
    <div ref={ref} className="rounded-lg bg-background px-4 py-3">
      <NextIntlClientProvider messages={messages} locale={locale}>
        <SliceSeam
          seam={block.seam}
          dateIso={block.dateIso}
          prevActivityIso={block.prevActivityIso}
        />
        {block.turns.map((turn, t) => (
          <HistoryTurn
            key={t}
            role={turn.role}
            content={turn.content}
            sliceId={block.key}
            timestamp={turn.timestamp}
            strands={block.strands}
          />
        ))}
      </NextIntlClientProvider>
    </div>
  );
}

// ─── The page ───────────────────────────────────────────────────────────────

export default function FieldLabPage() {
  const blocks = useMemo(() => makeBlocks(14), []);
  // Read OUTSIDE the canvas: the portals below cannot see this provider.
  const messages = useMessages();
  const locale = useLocale();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const offsetRef = useRef(0); // eased, px — what the camera reads
  const targetRef = useRef(0); // where the wheel has asked us to be
  const heightsRef = useRef<number[]>([]);
  const offsetsRef = useRef<number[]>([]);
  const [stats, setStats] = useState({ mounted: 0, total: blocks.length });
  const anchorsRef = useRef<FieldAnchor[]>([]);
  const progressRef = useRef(1);
  const levelRef = useRef<StackLevel>(1);
  const [strand, setStrand] = useState<string | null>(null);

  const strandList: StrandListItem[] = useMemo(() => {
    const seen = new Map<string, StrandListItem>();
    for (const b of blocks) {
      for (const name of b.strands) {
        const hit = seen.get(name);
        if (hit) hit.count += 1;
        else
          seen.set(name, {
            name,
            count: 1,
            lastStart: b.dateIso,
            description: null,
          });
      }
    }
    return [...seen.values()];
  }, [blocks]);
  const ambientStrands = useMemo(
    () => strandList.map((s) => s.name),
    [strandList],
  );
  const range = useMemo(
    () => ({ oldest: blocks[0].dateIso, now: new Date().toISOString() }),
    [blocks],
  );

  // Recompute the running offsets whenever a block reports its height. Block 0
  // seeds the default; an unmeasured block inherits the previous one's height so
  // the world stays contiguous instead of collapsing.
  const relayout = () => {
    const h = heightsRef.current;
    const fallback = h.find((v) => v > 0) ?? 400;
    const next: number[] = [0];
    for (let i = 0; i < blocks.length; i++) {
      next.push(next[i] + (h[i] > 0 ? h[i] : fallback));
    }
    offsetsRef.current = next;
  };
  relayout();

  // The eased follow. rAF rather than useFrame so it keeps running even if the
  // canvas is briefly idle, and so scroll feel is independent of the scene.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = targetRef.current - offsetRef.current;
      offsetRef.current += Math.abs(d) < 0.5 ? d : d * 0.18;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Wheel → target offset. Trackpad inertia arrives as a decaying stream of
  // wheel events, so summing them preserves the feel.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const total = offsetsRef.current[blocks.length] ?? 0;
      const max = Math.max(0, total - el.clientHeight);
      targetRef.current = Math.min(max, Math.max(0, targetRef.current + e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [blocks.length]);

  const totalPx = offsetsRef.current[blocks.length] ?? 0;

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)] overflow-hidden bg-background">
      <AxisBand
        showChrome
        range={range}
        progressRef={progressRef}
        levelRef={levelRef}
        anchorsRef={anchorsRef}
        strand={strand}
        strandList={strandList}
        ambientStrands={ambientStrands}
        selectedCount={null}
        reducedMotion={false}
        onSelectStrand={setStrand}
      />
      <div ref={wrapperRef} className="relative min-w-0 flex-1">
        <Canvas
          // Orthographic at zoom 1: one world unit is one CSS pixel, so the
          // numbers in this file are the numbers on screen.
          orthographic
          camera={{ position: [0, 0, 100], zoom: 1, near: 0.1, far: 1000 }}
          gl={{ antialias: true, alpha: true }}
          style={{ position: "absolute", inset: 0 }}
        >
          <FieldScene
            blocks={blocks}
            offsetRef={offsetRef}
            heightsRef={heightsRef}
            offsetsRef={offsetsRef}
            onLayout={relayout}
            onStats={setStats}
            messages={messages}
            locale={locale}
            anchorsRef={anchorsRef}
            progressRef={progressRef}
          />
        </Canvas>
      </div>

      {/* HUD — the numbers that matter while judging the feel. */}
      <div className="pointer-events-none absolute right-3 top-3 z-50 rounded-md bg-card/90 px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground ring-1 ring-foreground/10">
        <div>lab · conversation field</div>
        <div>
          mounted {stats.mounted} / {stats.total}
        </div>
        <div>content {Math.round(totalPx)}px</div>
        <div>wheel or trackpad to scroll</div>
      </div>
    </div>
  );
}
