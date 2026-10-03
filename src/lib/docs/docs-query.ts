/**
 * Document query layer (v0.15 design §2.5, §4.2) — the reader side of the
 * document system, built on the pure notation module (`types` / `naming` /
 * `document` / `references`).
 *
 * The filesystem IS the index layer (design §2.5): there is no index file,
 * no ranking, no relevance score. `listDocsQuery` is a directory listing;
 * `readDocQuery` resolves a file name against the nine kind directories via
 * `docPathCandidates` and reads the whole small file. A name that resolves
 * nowhere is a DEAD LINK — returned as a visible error, never thrown
 * (axiom A/B: half-failures are detectable and never blocking).
 *
 * All filesystem access is INJECTED (`DocsFs`): this module stays pure of
 * I/O so it is unit-testable and so the executors own the backend branch
 * (GitHub / local / demo), exactly like the rest of the tool layer.
 */

import {
  DOC_KINDS,
  type DocKind,
  type DocStatus,
} from "./types";
import { parseDoc } from "./document";
import { normalizeDocRef, docPathCandidates } from "./references";

/**
 * The filesystem surface the queries need. Implemented by the executors on
 * top of readFile/listFiles (GitHub), readFileLocal/listFilesLocal (local),
 * or the demo fs — each already whitelist-checked and MEMORY_ROOT-aware.
 */
export interface DocsFs {
  /** Read a repo-relative file as utf-8 text; throws when absent. */
  readText(path: string): Promise<string>;
  /** List a repo-relative directory; throws when absent. */
  listDir(
    path: string,
  ): Promise<Array<{ name: string; type: "file" | "dir"; path: string }>>;
}

/** The docs root (design §1): the subdirectories ARE the closed type set. */
export const DOCS_ROOT = "memory/docs";

/** Case-insensitive substring filter on the file name; null/empty = no filter. */
export type DocsFilter = string | null | undefined;

/**
 * listDocs — the mechanical directory listing (design §4.2: no LLM, no
 * ranking algorithm, no relevance score — the list itself is handed to the
 * model to read). File names are returned ascending: for the eight dated
 * kinds that IS birth order (`<出生日期>-<标题>.md`); for `topic` it is
 * alphabetical by name. An empty (or not-yet-created) directory is a normal
 * state, reported as an empty list with a note — never an error.
 */
export async function listDocsQuery(
  fs: DocsFs,
  kind: DocKind,
  filter?: DocsFilter,
): Promise<{ kind: DocKind; files: string[]; note?: string }> {
  const needle = filter?.trim().toLowerCase();
  let entries: Array<{ name: string; type: string }>;
  try {
    entries = await fs.listDir(`${DOCS_ROOT}/${kind}`);
  } catch {
    return {
      kind,
      files: [],
      note: `目录 ${DOCS_ROOT}/${kind}/ 尚不存在——这个类型还没有文档。`,
    };
  }
  const files = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md"))
    .map((e) => e.name)
    .filter((name) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
  return { kind, files };
}

/** Successful readDoc result — the whole document plus its machine header. */
export interface ReadDocSuccess {
  /** Canonical file name (identity, `.md` suffix). */
  fileName: string;
  /** The kind — learned from the directory the file was found in. */
  kind: DocKind;
  /** The resolved repo-relative path. */
  path: string;
  status: DocStatus;
  opened: string;
  updated: string;
  /** The full raw file text — documents are small files, read whole. */
  content: string;
  /** Tolerant-parse problems; never fatal (a doc must always open). */
  warnings: string[];
}

/** Dead link / bad reference — a visible error result, never thrown. */
export interface ReadDocFailure {
  error: string;
}

/**
 * readDoc — point-read a document by FILE NAME (design §2.2: references are
 * file names, never paths). The kind is not encoded in the name, so every
 * kind directory under `docs/` is a candidate; the first hit wins. A name
 * that hits nothing is a dead link — visible in the result, never blocking.
 */
export async function readDocQuery(
  fs: DocsFs,
  ref: string,
): Promise<ReadDocSuccess | ReadDocFailure> {
  const canonical = normalizeDocRef(ref);
  if (!canonical) {
    return {
      error: `无法解析的文档引用 "${ref}"——引用应是文件名（如 2026-09-05-手机购买调研 或 用户手机），不是路径。`,
    };
  }
  const candidates = docPathCandidates(canonical);
  for (const path of candidates) {
    const kind = path.split("/")[2] as DocKind;
    let raw: string;
    try {
      raw = await fs.readText(path);
    } catch {
      continue; // not in this kind directory — try the next candidate
    }
    // Tolerant parse: warnings, never exceptions. The raw text is returned
    // verbatim — the parse only surfaces the machine header + problems.
    const doc = parseDoc(raw, canonical, kind);
    return {
      fileName: canonical,
      kind,
      path,
      status: doc.frontmatter.status,
      opened: doc.frontmatter.opened,
      updated: doc.frontmatter.updated,
      content: raw,
      warnings: doc.warnings,
    };
  }
  return {
    error:
      `死链：docs 下没有任何文档叫 "${canonical}"` +
      `（已查 ${candidates.length} 个类型目录）。文件名即身份：` +
      `它可能被 void 后另开新篇，或从未存在。用 listDocs 看现有清单。`,
  };
}

/** Slice ids embedded in text, e.g. `2026-07-24-1500` (the L0 evidence refs). */
const SLICE_ID_GLOBAL = /\b\d{4}-\d{2}-\d{2}-\d{4}\b/g;

/** Cap the recorded set per document — bound for instrumentation state. */
const MAX_EXTRACTED_SLICE_IDS = 100;

/**
 * Extract the slice ids a document references (design §4.1: documents cite
 * slices by id). Used by the doc_rework probe (§4.4): if the main agent
 * reads a document and then opens one of the slices THAT document pointed
 * at, the document was not credited for that fact — an implicit demerit
 * recorded against the memory-quality bucket.
 */
export function extractSliceIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SLICE_ID_GLOBAL)) {
    found.add(match[0]);
    if (found.size >= MAX_EXTRACTED_SLICE_IDS) break;
  }
  return [...found];
}

/** The nine kinds, re-exported for callers building input validation. */
export const DOC_KINDS_LIST: readonly DocKind[] = DOC_KINDS;
