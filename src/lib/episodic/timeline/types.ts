/**
 * Timeline types — the first-class derived index over time slices.
 *
 * v0.8: the timeline is a PROJECTION of the slice files, never a separately
 * maintained truth. `memory/episodic/timeline/index.json` is the canonical
 * structured catalog (renderable by the UI); `memory/episodic/timeline.md` is
 * its markdown projection. v0.19 R3 retired the weave that rebuilt them — the
 * catalog is read-only legacy surface now (home recap + enumerate live-read;
 * nothing writes).
 */

/** A single slice's catalog entry — the semantic "profile" that lets a reader
 *  judge relevance without opening the slice. Enriched by close-marking; a dry
 *  entry (empty focus+summary) carries `needs_marking: true`. */
export interface TimelineSliceEntry {
  /** Slice id, e.g. "2026-08-11-1115". */
  id: string;
  /** Calendar date "YYYY-MM-DD" (derived from id). */
  date: string;
  /** UTC ISO 8601 start. */
  start: string;
  /** UTC ISO 8601 end (absent while active). */
  end?: string;
  /** Number of turns; only known when the slice was parsed this run. */
  turn_count?: number;
  status: "active" | "closed";
  /** One-sentence focus (strong verb, not a noun label). */
  focus: string;
  /** What happened / key decisions. */
  summary: string;
  tags: string[];
  /** Emotional tone of the session, when marked. */
  tone?: string;
  open_loops: string[];
  decisions: string[];
  /** Strands (tags woven across slices) this slice carries. */
  strands: string[];
  /** True when focus/summary are both empty — needs the semantic fill worker. */
  needs_marking: boolean;
  /**
   * Checkpoint continuation link (frontmatter `continues_from`): set when the
   * slice continues a time_cap/capacity-checkpointed predecessor — the A→B→C
   * chain marker the pointer lines render as `↳cont`.
   */
  continues_from?: string;
  /**
   * Close reason (frontmatter `closed_by`): time_cap / capacity / idle_gap /
   * context_lost / user_explicit / time_silence (legacy). Absent while active
   * or on legacy entries.
   */
  closed_by?: string;
}


