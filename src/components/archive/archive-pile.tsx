"use client";

/**
 * One pile in the archive field — one case, drawn as a small A4 stack: a
 * printed cover on top, blank paper peeking down-right beneath it. The sheet
 * count is the pile's THICKNESS TIER (archive-model.ts — the one place), so
 * a pile reads as thin/medium/thick without rendering its real page count.
 *
 * The cover is a button: clicking the pile opens the case's first document
 * (its `index.md`) on the desk — the reader's A4 deck, unchanged. The buried
 * sheets are blank and inert; the cover is the whole pile's hit target.
 *
 * Print scale (§九): all cover typography is millimetre-derived in
 * archive.css off the pile's own height (`--archive-mm`). The strings arrive
 * as props — this DOM renders inside a drei Html portal, a separate React
 * root next-intl context does not cross (the FrameCardTexts pattern).
 */
import type { CSSProperties } from "react";
import type { ArchivePile } from "@/lib/archive/actions";
import {
  PILE_SHEET_STEP,
  sheetsForTier,
  tierForPages,
  type ArchiveColumn,
  type RecordPile,
} from "./archive-model";

/** The strings a record pile prints, prepared by the field (same portal
 *  constraint as ArchivePileTexts above). */
export interface RecordPileTexts {
  /** The pile's aria-label: the bucket, its conversations, its turns. */
  recordAria(pile: RecordPile, bucketLabel: string): string;
  /** The cover's one stamp line: 记录 · OCT 10 · 12 轮 (§九's pile-scale
   *  ruling — print only what a glance reads). */
  stampLabel(pile: RecordPile): string;
}

/**
 * The bucket's record pile (v0.25b §三) — the same A4 stack skeleton as a
 * case pile, but the cover prints the BUCKET, not a case: no head stamps,
 * the bucket label as the display line, and one stamp line (label · date ·
 * turns). At pile size nothing more is legible (§九), and the structural
 * difference is what makes a record pile readable as not-a-case at a glance
 * (§四's 一眼可分).
 */
export function RecordPileView({
  pile,
  bucketLabel,
  width,
  height,
  texts,
  onOpen,
}: {
  pile: RecordPile;
  /** The bucket's printed label (the row label's own string). */
  bucketLabel: string;
  width: number;
  height: number;
  texts: RecordPileTexts;
  onOpen: (ref: string) => void;
}) {
  const count = sheetsForTier(tierForPages(pile.turns));
  return (
    <button
      type="button"
      data-archive-pile={pile.ref}
      data-record-pile
      aria-label={texts.recordAria(pile, bucketLabel)}
      onClick={() => onOpen(pile.ref)}
      className="archive-pile"
      style={
        {
          "--archive-pile-w": `${width}px`,
          "--archive-pile-h": `${height}px`,
          "--archive-cd": `${(count - 1) * PILE_SHEET_STEP.y + 10}px`,
        } as CSSProperties
      }
    >
      {Array.from({ length: count }, (_, i) => {
        const sheetStyle = {
          "--sx": `${i * PILE_SHEET_STEP.x}px`,
          "--sy": `${i * PILE_SHEET_STEP.y}px`,
          "--sr": `${i * PILE_SHEET_STEP.r}deg`,
          "--sz": count - i,
        } as CSSProperties;
        if (i > 0) {
          return (
            <div
              key={i}
              aria-hidden
              className="archive-sheet bg-paper bg-paper-grain-card shadow-paper-contact"
              style={sheetStyle}
            />
          );
        }
        return (
          <div
            key={i}
            className="archive-sheet archive-sheet--cover bg-paper bg-paper-grain-card shadow-paper-contact"
            style={sheetStyle}
          >
            <div className="archive-cover-inner archive-cover-inner--record">
              <h3 className="archive-cover-title">{bucketLabel}</h3>
              <div className="archive-cover-rule" aria-hidden="true" />
              <footer className="archive-cover-foot">
                <span>{texts.stampLabel(pile)}</span>
              </footer>
            </div>
          </div>
        );
      })}
    </button>
  );
}
/** The strings a pile prints, prepared by the field (see the module header). */
export interface ArchivePileTexts {
  /** The pile's aria-label: the case name, its category, its volume. */
  pileAria(pile: ArchivePile, categoryLabel: string): string;
  /** The cover's head stamp, left (the translated category name). */
  categoryLabel(category: ArchivePile["category"]): string;
  /** The column header's label — a category name, or the records column's
   *  (the synthetic trailing column is not a category). */
  columnLabel(column: ArchiveColumn): string;
  /** The cover's head stamp, right (the last write, locale-short). */
  dateLabel(date: string): string;
  /** The cover's foot stamp (the birth line; "" when the case is dateless). */
  openedLabel(opened: string): string;
}

export function ArchivePileView({
  pile,
  width,
  height,
  texts,
  onOpen,
}: {
  pile: ArchivePile;
  /** The pile's box, px — from the field's geometry (the model). */
  width: number;
  height: number;
  texts: ArchivePileTexts;
  onOpen: (ref: string) => void;
}) {
  const count = sheetsForTier(tierForPages(pile.pages));
  const categoryLabel = texts.categoryLabel(pile.category);
  return (
    <button
      type="button"
      data-archive-pile={pile.ref}
      aria-label={texts.pileAria(pile, categoryLabel)}
      onClick={() => onOpen(pile.ref)}
      className="archive-pile"
      style={
        {
          "--archive-pile-w": `${width}px`,
          "--archive-pile-h": `${height}px`,
          "--archive-cd": `${(count - 1) * PILE_SHEET_STEP.y + 10}px`,
        } as CSSProperties
      }
    >
      {Array.from({ length: count }, (_, i) => {
        const sheetStyle = {
          "--sx": `${i * PILE_SHEET_STEP.x}px`,
          "--sy": `${i * PILE_SHEET_STEP.y}px`,
          "--sr": `${i * PILE_SHEET_STEP.r}deg`,
          "--sz": count - i,
        } as CSSProperties;
        if (i > 0) {
          // Blank paper peeking down-right — a buried sheet is unprinted,
          // never a grey skeleton (the card field's rule).
          return (
            <div
              key={i}
              aria-hidden
              className="archive-sheet bg-paper bg-paper-grain-card shadow-paper-contact"
              style={sheetStyle}
            />
          );
        }
        return (
          <div
            key={i}
            className="archive-sheet archive-sheet--cover bg-paper bg-paper-grain-card shadow-paper-contact"
            style={sheetStyle}
          >
            <div className="archive-cover-inner">
              <header className="archive-cover-head">
                <span>{categoryLabel}</span>
                {pile.updated && <span>{texts.dateLabel(pile.updated)}</span>}
              </header>
              <h3 className="archive-cover-title">{pile.name}</h3>
              <div className="archive-cover-rule" aria-hidden="true" />
              <footer className="archive-cover-foot">
                <span>{texts.openedLabel(pile.opened)}</span>
              </footer>
            </div>
          </div>
        );
      })}
    </button>
  );
}
