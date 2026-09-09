/**
 * Strand entity files — the descriptive layer over the strand index.
 *
 * `strands.json` (see strands.ts) is the thin keyword→slice-paths index: it
 * says WHICH slices carry a strand, nothing about what the strand IS. This
 * module is the entity layer on top of it: one Markdown file per strand at
 * `memory/episodic/strands/<name>.md`, holding a natural-language description
 * (1-2 paragraphs: when the user first raised this thread, what it is mainly
 * about) plus YAML frontmatter (`first_seen` / `last_active` / `aliases`).
 *
 * The recall sub-agent reads these files to match questions to strands
 * SEMANTICALLY (listStrands carries truncated summaries, readStrand the full
 * text) instead of keyword-literal matching alone. The strand-consolidator is
 * the ONLY writer — mechanical writes (updateStrands) never touch this layer.
 *
 * Reads degrade gracefully: no `strands/` directory or a missing/corrupt
 * entity file yields `null`, and callers fall back to the bare index.
 */
import matter from "gray-matter";
import {
  fsListFiles,
  fsReadFile,
  fsWriteFile,
  type WriteBatch,
} from "./io-helpers";
import { normalizeStrandKey } from "./strands";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One strand entity — the parsed form of `strands/<name>.md`.
 * `name` is the strand key as it appears in strands.json (the file name,
 * minus `.md`).
 */
export interface StrandEntity {
  /** The strand key (== file name without extension). */
  name: string;
  /** YYYY-MM-DD of the earliest slice carrying this strand. */
  first_seen: string;
  /** YYYY-MM-DD of the newest slice known at the last description refresh. */
  last_active: string;
  /** Alternate names for the same thread (cross-language, typo variants). */
  aliases: string[];
  /** 1-2 paragraphs of natural-language description (the file body). */
  description: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Directory holding one entity file per strand. */
export const STRANDS_DIR = "memory/episodic/strands";

/**
 * Compute the entity file path for a strand. Throws on unsafe names —
 * strand keys come from user-message tags, so path traversal must be
 * rejected mechanically, not assumed away.
 */
export function getStrandFilePath(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Unsafe strand name for entity file: ${JSON.stringify(name)}`);
  }
  return `${STRANDS_DIR}/${name}.md`;
}

// ─── Serialization ──────────────────────────────────────────────────────────

/** Coerce a value that should be a string (gray-matter can parse unquoted
 *  YAML values containing ": " as objects — same guard as manager.ts — and
 *  bare YYYY-MM-DD values as Date objects). */
function normalizeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (v && typeof v === "object") return Object.keys(v)[0] ?? "";
  return "";
}

/** Coerce an array where every entry should be a string. */
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === "string" ? e : normalizeString(e)));
}

/**
 * Serialize a StrandEntity to Markdown: YAML frontmatter
 * (`first_seen` / `last_active` / `aliases`) + the description as the body.
 */
export function serializeStrandEntity(entity: StrandEntity): string {
  const frontmatter: Record<string, unknown> = {
    first_seen: entity.first_seen,
    last_active: entity.last_active,
    aliases: entity.aliases,
  };
  const cleanFm: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) {
      cleanFm[key] = value;
    }
  }
  return matter.stringify(entity.description.trim(), cleanFm);
}

/**
 * Parse a strand entity file's raw Markdown back into a StrandEntity.
 * Tolerant of missing frontmatter fields (legacy/partial files) — absent
 * values come back as empty strings/arrays, never undefined.
 */
export function parseStrandEntity(raw: string, name: string): StrandEntity {
  const { data, content } = matter(raw);
  return {
    name,
    first_seen: normalizeString(data.first_seen),
    last_active: normalizeString(data.last_active),
    aliases: normalizeStringArray(data.aliases),
    description: content.trim(),
  };
}

// ─── I/O ────────────────────────────────────────────────────────────────────

/**
 * Read one strand's entity file. Returns null when the file is missing or
 * unreadable — old memory roots have no `strands/` directory at all, and
 * every caller must keep working against the bare index in that case.
 */
export async function readStrandEntity(
  name: string,
  batch?: WriteBatch,
): Promise<StrandEntity | null> {
  let raw: string;
  try {
    raw = await fsReadFile(getStrandFilePath(name), batch);
  } catch {
    return null;
  }
  try {
    return parseStrandEntity(raw, name);
  } catch {
    return null;
  }
}

/**
 * Write a strand entity file. Only the strand-consolidator may call this —
 * mechanical weave/update paths never create or mutate descriptions.
 */
export async function writeStrandEntity(
  entity: StrandEntity,
  batch?: WriteBatch,
): Promise<{ path: string; created: boolean }> {
  return fsWriteFile(
    getStrandFilePath(entity.name),
    serializeStrandEntity(entity),
    batch,
  );
}

/**
 * List the entity file names present under `strands/` (without the `.md`
 * extension). Returns an empty set when the directory does not exist yet —
 * the cheap presence check that lets callers skip per-strand failed reads.
 */
export async function listStrandEntityNames(): Promise<Set<string>> {
  try {
    const entries = await fsListFiles(STRANDS_DIR);
    return new Set(
      entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .map((e) => e.name.slice(0, -".md".length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Resolve a (possibly differently-cased or full-width) strand name against
 * the available entity file names using the same normalization as the index
 * layer. Returns the canonical file name, or null when no entity exists.
 */
export function resolveStrandEntityName(
  requested: string,
  available: ReadonlySet<string>,
): string | null {
  if (available.has(requested)) return requested;
  const norm = normalizeStrandKey(requested);
  for (const name of available) {
    if (normalizeStrandKey(name) === norm) return name;
  }
  return null;
}
