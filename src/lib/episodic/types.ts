/** Status of a time slice — only one active at a time */
export type SliceStatus = "active" | "closed";

/** The four signals that can trigger a slice boundary */
export type SlicingSignal =
  | "time_silence"
  | "user_explicit"
  | "flash_high_confidence"
  | "capacity";

/** Emotional tone of a time slice, maintained by Flash */
export type EmotionalTone =
  | "positive"
  | "neutral"
  | "negative"
  | "mixed";

// ─── Turn ────────────────────────────────────────────────────────────

/** A single message exchange within a time slice body */
export interface Turn {
  /** UTC ISO 8601 timestamp of this message */
  timestamp: string;
  /** "user" or "agent" */
  role: "user" | "agent";
  /** The message content (plain text or markdown) */
  content: string;
}

// ─── Frontmatter ─────────────────────────────────────────────────────

/** YAML frontmatter stored at the top of every time slice .md file */
export interface SliceFrontmatter {
  /** Unique identifier, format YYYY-MM-DD-HHMM (UTC date+time of first user message) */
  slice_id: string;
  /** Core topic, one sentence */
  focus: string;
  /** Current lifecycle status */
  status: SliceStatus;
  /** Start time in UTC ISO 8601 */
  start: string;
  /** End time in UTC ISO 8601 (set when closed) */
  end?: string;
  /** User's timezone at time of interaction, e.g. "Asia/Shanghai" */
  timezone: string;
  /** Flash-generated summary, at most 100 characters */
  summary: string;
  /** Unresolved questions carried forward */
  open_loops: string[];
  /** Decisions made during this slice */
  decisions: string[];
  /** Semantic tags */
  tags: string[];
  /** Paths of related slices, e.g. ["2026/06/22"] */
  related_slices: string[];
  /** Emotional tone assessed by Flash on freeze */
  emotional_tone?: EmotionalTone;
}

// ─── Time Slice (in-memory) ──────────────────────────────────────────

/**
 * Full in-memory representation of a time slice.
 * Frontmatter fields are flattened at the top level for convenient access;
 * the canonical YAML rendering is derived from SliceFrontmatter.
 */
export interface TimeSlice {
  slice_id: string;
  focus: string;
  status: SliceStatus;
  start: string;
  end?: string;
  timezone: string;
  summary: string;
  open_loops: string[];
  decisions: string[];
  tags: string[];
  related_slices: string[];
  emotional_tone?: EmotionalTone;
  /** Ordered list of turns that make up the slice body */
  turns: Turn[];
  /** Approximate token count of the entire slice (used for capacity signal) */
  estimatedTokens: number;
  /** The signal that caused this slice to close (only set when status is "closed") */
  closedBy?: SlicingSignal;
}

// ─── Index structures ────────────────────────────────────────────────

/** One entry in a monthly _index.json */
export interface SliceIndexEntry {
  /** Slice identifier in YYYY-MM-DD-HHMM format, e.g. "2026-07-02-1430" */
  id: string;
  focus: string;
  summary: string;
  tags: string[];
  status: SliceStatus;
  start: string;
  open_loops: string[];
  decisions: string[];
}

/** Monthly index stored as _index.json in each year/month directory */
export interface MonthlyIndex {
  month: string; // "YYYY-MM"
  slices: SliceIndexEntry[];
}

/**
 * Global tag-index.json structure.
 * Maps each tag to the relative slice paths that carry it.
 * Example: { "rust": ["2026/06/22"], "async": ["2026/06/22"] }
 */
export interface TagIndex {
  [tag: string]: string[];
}

// ─── Flash slicing decision ──────────────────────────────────────────

/** Input provided to Flash when deciding whether to split the current slice */
export interface FlashSplitInput {
  /** Seconds since the last message in the active slice */
  timeSinceLastMessage: number;
  /** Current slice focus string */
  currentSliceFocus: string;
  /** Topic labels from existing paragraphs in the active slice */
  currentSliceTopics: string[];
  /** Last 3-5 turns for continuity assessment */
  recentHistory: Turn[];
  /** The incoming user message */
  newMessage: string;
}

/** Flash's split decision output */
export interface FlashSplitOutput {
  /** True only when confidence exceeds the 0.9 threshold */
  shouldSplit: boolean;
  /** Confidence score 0.0 – 1.0 */
  confidence: number;
  /** Human-readable explanation */
  reason: string;
  /** Suggested focus for the new slice if splitting */
  suggestedFocus?: string;
}

// ─── Recall ──────────────────────────────────────────────────────────

/** Flash-generated directional hint for Pro's recall exploration */
export interface RecallHint {
  /** Tags that may be relevant to the current query */
  suggestedTags: string[];
  /** Suggested lookback window, e.g. "last_14_days" */
  suggestedTimeRange: string;
  /** Human-readable justification for the hint */
  reason: string;
}

// ─── Mismatch log ────────────────────────────────────────────────────

/**
 * A single entry in the Pro→Flash feedback log (mismatch-log.jsonl).
 * Pro records an objection when Flash's recall suggestions prove irrelevant.
 */
export interface MismatchLogEntry {
  /** Tags Flash suggested for recall */
  flashRecall: string[];
  /** Pro's objection — describes what was actually needed */
  proObjection: string;
  /** UTC ISO 8601 timestamp of the mismatch */
  timestamp: string;
}
