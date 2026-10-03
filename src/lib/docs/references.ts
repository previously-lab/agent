/**
 * Document references (v0.15 design §2.2).
 *
 * A reference is the document's FILE NAME — never a path. Paths contain
 * directories, and directories are classification, not identity; the file
 * name is fixed at birth, so a file-name glob under `docs/` resolves a
 * reference under any archive layout change. An unresolvable reference is a
 * dead link — visible when read, never blocking (axiom A/B).
 *
 * Canonical form of a reference: `<文件名>.md` — bare file name with the
 * extension, no path, no book-title marks. Writers may cite with or without
 * `.md` and with a sentence of context attached; normalization strips all of
 * that back to the canonical form.
 */
import { DOC_KINDS } from "./types";

/**
 * Normalize arbitrary reference text to the canonical file name.
 *
 * Handles: surrounding whitespace; 《…》 book-title marks; a leading path
 * (any directory prefix, `docs/…` or deeper — only the base name survives);
 * a missing `.md` extension (appended). Anything else in the text (a
 * sentence of context, trailing punctuation) is NOT part of a reference —
 * pass the bare citation, not the surrounding sentence.
 *
 * Returns null when nothing usable remains (empty after stripping).
 */
export function normalizeDocRef(ref: string): string | null {
  if (typeof ref !== "string") return null;
  let s = ref.normalize("NFKC").trim();
  // strip book-title marks anywhere (《名》 or bare 《… wrappers)
  s = s.replace(/[《》]/g, "").trim();
  // strip any directory prefix — keep only the base name
  s = s.replace(/^[\\/]+/, "");
  if (s.includes("/") || s.includes("\\")) {
    s = s.split(/[\\/]/).pop() ?? "";
  }
  s = s.trim();
  if (!s || s === "." || s === "..") return null;
  if (!s.endsWith(".md")) s += ".md";
  return s;
}

/**
 * The docs-root-relative path candidates for a document file name. The kind
 * is NOT encoded in the file name, so without a directory listing every kind
 * directory is a candidate — the caller globs for the file name under the
 * docs root (or checks these candidates) and takes the first hit. A dated
 * file name will in practice only ever hit its birth kind's directory; a
 * topic name only `docs/topic/`. Returned with the `memory/` prefix.
 */
export function docPathCandidates(fileName: string): string[] {
  const canonical = normalizeDocRef(fileName);
  if (!canonical) return [];
  return DOC_KINDS.map((kind) => `memory/docs/${kind}/${canonical}`);
}
