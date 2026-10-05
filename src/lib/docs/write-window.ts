/**
 * The document WRITE WINDOW (v0.21 写入窗口裁决) — documents reuse the
 * slice timing model: a document whose last write is within the idle-gap
 * window is still being worked on and may be REWRITTEN WHOLE; past the
 * window it is settled — it grows only by dated supplements (appendTail) or
 * new pieces (addPiece). Sealing is no longer a state anyone decides: the
 * window closing IS the seal, produced by time alone.
 *
 * The window length is DEFINED ONCE, on the slice side: the idle-gap close
 * of the slicer (`idleGapMinutes`, default 30). This module REFERENCES that
 * single definition — the two windows are the same constant, never two
 * copies of the number. (The runtime override in settings.json tunes slice
 * closing; the document window deliberately pins the shipped default — a
 * document lifecycle rule should not drift with a UI knob.)
 *
 * Pure functions + constants only — no I/O, no module state.
 */
import { DEFAULTS } from "@/lib/config/defaults";

/** The write window in minutes — the slice idle gap's shipped default. */
export const DOC_WRITE_WINDOW_MINUTES = DEFAULTS.slicing.idleGapMinutes;

/** The write window in milliseconds — the guard's working unit. */
export const DOC_WRITE_WINDOW_MS = DOC_WRITE_WINDOW_MINUTES * 60_000;

/**
 * Is a document whose `updated` stamp is `updatedIso` still inside its write
 * window at `nowMs`? An unparseable/empty stamp reads as OUT of window —
 * conservative: a write we cannot place in time is never treated as fresh.
 */
export function isWithinWriteWindow(updatedIso: string, nowMs: number): boolean {
  const t = new Date(updatedIso).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t <= DOC_WRITE_WINDOW_MS;
}

/** The refusal codes the write entry can raise — structured, never silent. */
export type CaseWriteRefusalCode = "rewrite_window_closed" | "rewrite_conflict";

/**
 * A loud, STRUCTURED write refusal: the write entry raises it when a whole-
 * body rewrite is not allowed to land. `code` is machine-readable so the
 * caller (a pass, a tool executor) can tell "settled document" apart from
 * "the document moved under you"; the message carries the recovery path
 * (re-read, then append a dated line or add a piece) for the model.
 */
export class CaseWriteRefusal extends Error {
  readonly code: CaseWriteRefusalCode;
  constructor(code: CaseWriteRefusalCode, message: string) {
    super(message);
    this.name = "CaseWriteRefusal";
    this.code = code;
  }
}

/**
 * The write-window discipline sentence — the SINGLE SOURCE every writer
 * surface interpolates (the field's writeCase, HQ's writeCase/writeSelfSop,
 * the case-writer / scribe / research passes, the Previously Agent's SOP
 * section, the bridge housekeeping contract). ONE sentence, one meaning;
 * prompt-facing, so it stays English and carries no backticks.
 */
export const DOC_WRITE_WINDOW_RULE =
  "Write-window discipline: a document's first write is its FULL text. " +
  `While the write window is open (continuous editing — each write within ${DOC_WRITE_WINDOW_MINUTES} minutes of the last) the document may be rewritten whole; ` +
  "once the window has closed, it grows only by dated corrections or supplements appended at the tail. " +
  "When the content outgrows the length cap, open a NEW document and leave one line in the original pointing at it.";
