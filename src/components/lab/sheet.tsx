import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * Lab paper primitives — the SAME material vocabulary the card field and the
 * desk ship (bg-paper bg-paper-grain-card shadow-paper-contact, blank paper
 * for buried sheets). The pile cascade reuses the desk's cumulative step
 * (desk-model.ts SHELL_STEP) so the lab piles are the real stacks at a
 * different count, not an invented look.
 */

/** The cascade step per buried sheet — desk-model.ts SHELL_STEP, verbatim. */
const SHEET_STEP = { x: 5, y: 4, r: 0.35 } as const;

export function pileSheetStyle(index: number, count: number): CSSProperties {
  return {
    "--sx": `${index * SHEET_STEP.x}px`,
    "--sy": `${index * SHEET_STEP.y}px`,
    "--sr": `${index * SHEET_STEP.r}deg`,
    zIndex: count - index,
  } as CSSProperties;
}

export function Sheet({
  className = "",
  children,
  style,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`lab-sheet bg-paper bg-paper-grain-card ${className}`}
      style={style}
      {...rest}
    >
      {children}
    </div>
  );
}

export type PileTier = "thin" | "medium" | "thick";
export type CoverKind = "case" | "record";

/** Assumed tier counts — the real thresholds are the open question Q-B;
 *  thick is where the CAP lands visually (a pile never grows past it). */
export const TIER_SHEETS: Record<PileTier, number> = {
  thin: 3,
  medium: 6,
  thick: 10,
};

export const TIER_LABELS: Record<PileTier, string> = {
  thin: "thin · 3 sheets",
  medium: "medium · 6",
  thick: "thick · 10 (capped)",
};

export type CoverMeta =
  | { kind: "case"; ref: string; title: string; tag: string; date: string }
  | {
      kind: "record";
      date: string;
      slice: string;
      rounds: string;
      lines: string[];
    };

export const DEFAULT_COVER_META: Record<CoverKind, CoverMeta> = {
  case: {
    kind: "case",
    ref: "research / 手机调研",
    title: "Phone Research",
    tag: "CASE",
    date: "opened 2026-10-02",
  },
  record: {
    kind: "record",
    date: "2026-10-04",
    slice: "SLICE 12",
    rounds: "ROUND 3",
    lines: [
      "you — did the call come through?",
      "agent — it did. 23:41, the desk phone.",
      "you — good. write down the hotel name.",
    ],
  },
};

/** One pile: `count` sheets, the TOP one a printed cover, the rest blank
 *  paper peeking down-right. Geometry lives in lab.css (--lab-pile-w). */
export function PileStack({
  tier,
  cover,
  width = 200,
  meta,
  caption,
}: {
  tier: PileTier;
  cover: CoverKind;
  width?: number;
  meta?: CoverMeta;
  caption?: string | null;
}) {
  const count = TIER_SHEETS[tier];
  const coverMeta = meta ?? DEFAULT_COVER_META[cover];
  return (
    <div className="lab-pilewrap">
      <div
        className="lab-pile"
        style={
          {
            "--lab-pile-w": `${width}px`,
            "--lab-cd": `${(count - 1) * SHEET_STEP.y + 10}px`,
            width,
          } as CSSProperties
        }
      >
        {Array.from({ length: count }, (_, i) =>
          i === 0 ? (
            <CoverSheet key={i} meta={coverMeta} index={i} count={count} />
          ) : (
            <Sheet
              key={i}
              aria-hidden
              className="lab-pile-sheet"
              style={pileSheetStyle(i, count)}
            />
          ),
        )}
      </div>
      {caption != null && <p className="lab-pile-caption">{caption}</p>}
    </div>
  );
}

export function CoverSheet({
  meta,
  index,
  count,
}: {
  meta: CoverMeta;
  index: number;
  count: number;
}) {
  return (
    <Sheet
      className="lab-pile-sheet lab-cover"
      style={pileSheetStyle(index, count)}
    >
      {meta.kind === "case" ? (
        <div className="lab-cover-inner lab-cover-inner--case">
          <header className="lab-cover-head">
            <span>{meta.ref}</span>
          </header>
          <h3 className="lab-cover-title">{meta.title}</h3>
          <div className="lab-cover-rule" aria-hidden="true" />
          <footer className="lab-cover-foot">
            <span className="lab-cover-tag">{meta.tag}</span>
            <span className="lab-cover-side">{meta.date}</span>
          </footer>
        </div>
      ) : (
        <div className="lab-cover-inner lab-cover-inner--record">
          <header className="lab-cover-head">
            <span>{meta.date}</span>
            <span>{meta.slice}</span>
            <span>{meta.rounds}</span>
          </header>
          <div className="lab-cover-rule" aria-hidden="true" />
          <div className="lab-cover-transcript">
            {meta.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
          <footer className="lab-cover-foot">
            <span className="lab-cover-tag">RECORD</span>
          </footer>
        </div>
      )}
    </Sheet>
  );
}
