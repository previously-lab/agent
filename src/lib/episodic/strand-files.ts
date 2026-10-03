/**
 * Topic homes (主题之家) — the descriptive layer over the strand index.
 *
 * `strands.json` (see strands.ts) is the thin keyword→slice-paths index: it
 * says WHICH slices carry a strand, nothing about what the strand IS. The
 * topic home is the散文之家 on top of it (v0.15 design §3.2): one document
 * per strand at `memory/docs/topic/<名字>.md` in the document notation
 * (three-field frontmatter + 截至块 + dated entry stream; entries are 动态
 * or 名录 prose). The home's identity is the NAME, one-to-one with the
 * strands.json key — the strand index's existing contract.
 *
 * LEGACY: homes used to live at `memory/episodic/strands/<name>.md` as
 * `first_seen`/`last_active`/`aliases` frontmatter + a 1-2 paragraph
 * description. Until the one-shot migration (scripts/migrate-strands-to-docs.mjs)
 * has run, reads fall back to the legacy location and convert in memory, so
 * the system keeps working; all NEW writes land in `docs/topic/` only.
 *
 * The recall sub-agent reads these files to match questions to strands
 * SEMANTICALLY (listStrands carries truncated summaries, readStrand the full
 * text) instead of keyword-literal matching alone. Writers: the librarian
 * (home maintenance) and document writers (名录 entries on open/close) —
 * mechanical writes (updateStrands) never touch this layer.
 *
 * Reads degrade gracefully: no home in either location or a missing/corrupt
 * file yields `null`, and callers fall back to the bare index.
 */
import matter from "gray-matter";
import {
  appendEntry,
  createDocSkeleton,
  isValidDate,
  parseDoc,
  rewriteAsOf,
  type ParsedDoc,
} from "@/lib/docs";
import {
  fsListFiles,
  fsReadFile,
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

/** Directory holding one topic home per strand (the NEW location, §3.2). */
export const TOPIC_DIR = "memory/docs/topic";

/** LEGACY entity directory — read fallback only, never written anymore. */
export const STRANDS_DIR = "memory/episodic/strands";

/** Reject names that could escape the docs tree (path traversal, NUL). */
function assertSafeName(name: string): void {
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
}

/** Compute the topic-home path for a strand (the new location). */
export function getTopicDocPath(name: string): string {
  assertSafeName(name);
  return `${TOPIC_DIR}/${name}.md`;
}

/**
 * Compute the LEGACY entity file path for a strand. Throws on unsafe names —
 * strand keys come from user-message tags, so path traversal must be
 * rejected mechanically, not assumed away.
 */
export function getStrandFilePath(name: string): string {
  assertSafeName(name);
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

// ─── Conversions (legacy entity ⇄ topic document) ──────────────────────────

/**
 * Convert a parsed topic document into the legacy StrandEntity shape, so
 * long-standing readers (recall's semantic matching, the UI) keep working
 * unchanged against homes in the new location. Aliases no longer exist as a
 * field (they live in the opening prose, §3.2) — the flattened description
 * carries the home's 截至块 + full entry stream, which is what semantic
 * matching actually reads.
 */
export function topicDocToStrandEntity(doc: ParsedDoc): StrandEntity {
  const parts: string[] = [];
  if (doc.asOf) parts.push(`截至 ${doc.asOf.date}：${doc.asOf.text}`);
  for (const s of doc.sections) {
    if (s.type === "entry") {
      parts.push(`【${s.entry.date} · ${s.entry.title}】\n${s.entry.body}`);
    } else {
      parts.push(s.text);
    }
  }
  return {
    name: doc.fileName.slice(0, -".md".length),
    first_seen: doc.frontmatter.opened,
    last_active: doc.frontmatter.updated,
    aliases: [],
    description: parts.join("\n\n").trim(),
  };
}

/**
 * Convert a legacy strand entity into an in-memory topic document (mirrors
 * the one-shot migration script's transform): the description becomes an
 * `初始描述` entry dated at last_active, the 截至块 is seeded from it
 * (honestly stale from birth), and aliases fold into the opening prose.
 * `today` is the fallback birth date when the entity carries no usable
 * dates at all (a degenerate file — the migration script warns on the same).
 */
export function strandEntityToTopicDoc(
  entity: StrandEntity,
  today: string,
): ParsedDoc {
  const opened = isValidDate(entity.first_seen)
    ? entity.first_seen
    : isValidDate(entity.last_active)
      ? entity.last_active
      : today;
  const updated = isValidDate(entity.last_active)
    ? entity.last_active
    : opened;
  let doc = createDocSkeleton({
    fileName: `${entity.name}.md`,
    kind: "topic",
    opened,
    heading: entity.name,
  });
  doc = { ...doc, frontmatter: { ...doc.frontmatter, updated } };
  const description = entity.description.trim();
  const aliasNote =
    entity.aliases.length > 0
      ? `\n\n（本主题也叫：${entity.aliases.join("、")}。）`
      : "";
  if (description) {
    doc = appendEntry(doc, {
      date: updated,
      title: "初始描述",
      body: description + aliasNote,
    });
  }
  return rewriteAsOf(doc, {
    date: updated,
    text: description || "（尚无描述）",
  });
}

// ─── I/O ────────────────────────────────────────────────────────────────────

/**
 * Read one strand's topic home in the DOCUMENT form. The new location
 * (`docs/topic/`) wins; a legacy `strands/<name>.md` entity is converted in
 * memory (`legacy: true`) so the caller's next write lands in the new
 * location — the system keeps working before the migration script has run.
 * Returns null when neither location has a readable home.
 */
export async function readTopicDoc(
  name: string,
  batch?: WriteBatch,
): Promise<{ doc: ParsedDoc; legacy: boolean } | null> {
  try {
    const raw = await fsReadFile(getTopicDocPath(name), batch);
    return { doc: parseDoc(raw, `${name}.md`, "topic"), legacy: false };
  } catch {
    // fall through to the legacy location
  }
  try {
    const raw = await fsReadFile(getStrandFilePath(name), batch);
    const entity = parseStrandEntity(raw, name);
    const today = new Date().toISOString().slice(0, 10);
    return { doc: strandEntityToTopicDoc(entity, today), legacy: true };
  } catch {
    return null;
  }
}

/**
 * Read one strand's home in the legacy StrandEntity form (recall / UI).
 * New location first (converted — aliases live in prose there); a legacy-only
 * home is parsed DIRECTLY so its aliases survive for semantic matching until
 * the migration folds them into prose. Returns null when the file is missing
 * or unreadable in both places — old memory roots have no homes at all, and
 * every caller must keep working against the bare index in that case.
 */
export async function readStrandEntity(
  name: string,
  batch?: WriteBatch,
): Promise<StrandEntity | null> {
  try {
    const raw = await fsReadFile(getTopicDocPath(name), batch);
    return topicDocToStrandEntity(parseDoc(raw, `${name}.md`, "topic"));
  } catch {
    // fall through to the legacy location
  }
  try {
    const raw = await fsReadFile(getStrandFilePath(name), batch);
    return parseStrandEntity(raw, name);
  } catch {
    return null;
  }
}

/**
 * List the home file names present in EITHER location (without the `.md`
 * extension; new location shadows legacy on name collision). Returns an
 * empty set when neither directory exists — the cheap presence check that
 * lets callers skip per-strand failed reads.
 */
export async function listStrandEntityNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of [STRANDS_DIR, TOPIC_DIR]) {
    try {
      const entries = await fsListFiles(dir);
      for (const e of entries) {
        if (e.type === "file" && e.name.endsWith(".md")) {
          names.add(e.name.slice(0, -".md".length));
        }
      }
    } catch {
      // directory absent — fine
    }
  }
  return names;
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
