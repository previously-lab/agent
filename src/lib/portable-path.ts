/**
 * Portability discipline for repository paths.
 *
 * WHY THIS EXISTS (2026-10-12): the live agent writes memory files through
 * the GitHub API, where a file name is almost any byte — a piece title
 * containing "16:00" landed happily. Windows forbids `:` (and `<>"|?*`, a
 * trailing dot/space, device names) in file names, so `git pull` on Windows
 * died with `error: invalid path` AFTER the commit was already on GitHub;
 * the only repair was renaming the file through the API. One such name is
 * enough to break checkout for every Windows clone of the repo.
 *
 * The sanitize discipline up top (case-naming.ts `sanitizeCaseSegment`)
 * prevents the names we KNOW how to fix; this module is the backstop every
 * write seam calls LAST — single GitHub writes, batch commits, local writes —
 * so a future writer, script, or tool cannot land such a name again: the
 * write fails loudly instead.
 *
 * Pure functions only: no I/O, no module state.
 */

/** Characters Windows forbids in a file name (the separators are checked apart). */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

/** Control characters — never legal, never useful in a name. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** DOS device names (CON, NUL, COM1…), with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Can this single path segment be checked out on Windows? Rejects the
 * forbidden characters, control characters, both separators (a `\` in a repo
 * path would mean a different path on Windows), a trailing dot or space
 * (which the Windows API strips silently), and the reserved DOS device names.
 */
export function isPortablePathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (WINDOWS_FORBIDDEN.test(segment)) return false;
  if (CONTROL_CHARS.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  if (DEVICE_NAME.test(segment)) return false;
  return true;
}

/**
 * True when every segment of a repo-relative path survives a Windows
 * checkout. A trailing slash is tolerated (the segments before it are what
 * matter); an empty path is not.
 */
export function isPortableRepoPath(path: string): boolean {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return false;
  return trimmed.split("/").every(isPortablePathSegment);
}

/**
 * Refuse a path that could not be checked out on Windows. Write seams call
 * this AFTER the whitelist check and BEFORE any backend call, so the bad name
 * never reaches GitHub (or a shared memory tree) at all.
 */
export function assertPortableRepoPath(path: string): void {
  if (!isPortableRepoPath(path)) {
    throw new Error(
      `Refused: path "${path}" would break a Windows checkout — a segment carries ` +
        `a forbidden character (<>:"|?* or a control character), a trailing dot/space, ` +
        `or a reserved device name. Use portable characters (e.g. full-width ： for :) and retry.`,
    );
  }
}
