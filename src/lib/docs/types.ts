/**
 * Document-system shared types (v0.15 design §1–2).
 *
 * The type set is CLOSED: the subdirectories of `memory/docs/` ARE the
 * enumeration — there is no ninth directory and no kind outside this union.
 * A document's kind is decided at birth and never changes (the directory it
 * lives in is the only classification axis that needs no maintenance).
 *
 * Machine state is deliberately tiny: three frontmatter fields
 * (`status` / `opened` / `updated`), a status set of three values, and an
 * append-only dated entry stream in the body. Everything else — topics
 * membership, supersession, aliases — lives in prose, never in fields.
 */

/** The nine document kinds, closed. `topic` is the only name-identified one. */
export const DOC_KINDS = [
  "event",
  "person",
  "object",
  "place",
  "org",
  "research",
  "hypothesis",
  "task",
  "topic",
] as const;

export type DocKind = (typeof DOC_KINDS)[number];

/** The eight kinds whose file name is `<出生日期>-<标题>.md`. */
export const DATED_DOC_KINDS = [
  "event",
  "person",
  "object",
  "place",
  "org",
  "research",
  "hypothesis",
  "task",
] as const;

/** The three-status set, closed. No derived states (no "stale"/"unreviewed"). */
export const DOC_STATUSES = ["active", "closed", "void"] as const;

export type DocStatus = (typeof DOC_STATUSES)[number];

/** The only three machine frontmatter fields a document may carry. */
export interface DocFrontmatter {
  /** active | closed | void — closed freezes the stream, void needs a dated 作废 entry. */
  status: DocStatus;
  /** Birth date (YYYY-MM-DD), taken from the file name at creation. */
  opened: string;
  /** Last-write date (YYYY-MM-DD); the writer restamps it on every write. */
  updated: string;
}

/**
 * One append-only body entry: `## <date> — <entry name>` + prose.
 * The entry name is a prose convention (开篇/更新/结案/作废/用户更正),
 * NOT an enum.
 */
export interface DocEntry {
  /** YYYY-MM-DD. */
  date: string;
  /** Free entry name (开篇/更新/结案/…). */
  title: string;
  /** Entry prose (may be multi-paragraph). */
  body: string;
}

/**
 * The 截至块 — the ONLY body region a writer may rewrite. Carries its date
 * inside the text (`> 截至 <date>：…`) so readers judge freshness by looking,
 * never via any computed marker.
 */
export interface DocAsOf {
  /** YYYY-MM-DD parsed from the `截至 <date>` prefix. */
  date: string;
  /** The text after `截至 <date>：` (may span multiple `>` lines). */
  text: string;
}

/**
 * A parsed document. Parsing is TOLERANT by contract: a broken file must
 * still parse — bad/missing fields become warnings, never exceptions.
 * `sections` preserves the body verbatim and in order so a re-serialization
 * loses nothing the parser didn't understand.
 */
export interface ParsedDoc {
  /** File name (identity). `<出生日期>-<标题>.md`, or `<名字>.md` for topic. */
  fileName: string;
  /** The kind — supplied by the caller (the directory it was found in). */
  kind: DocKind;
  frontmatter: DocFrontmatter;
  /** Optional `# <title>` line, preserved verbatim if present. */
  heading: string | null;
  /** The 截至块, or null when absent. */
  asOf: DocAsOf | null;
  /**
   * Body in order: dated entries plus `raw` segments for anything the parser
   * didn't recognize (kept verbatim so nothing is silently dropped).
   */
  sections: DocSection[];
  /** Human-readable parse problems. Never fatal. */
  warnings: string[];
}

/** An ordered body segment: a dated entry, or unrecognized text kept as-is. */
export type DocSection =
  | { type: "entry"; entry: DocEntry }
  | { type: "raw"; text: string };
