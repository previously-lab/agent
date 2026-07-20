/**
 * Data-source resolution — decides where memory reads & writes land.
 *
 * Three backends, chosen automatically:
 *
 *   "local"   NODE_ENV === "development"          → local disk
 *   "github"  GITHUB_TOKEN is set (production)     → GitHub API (octokit)
 *   "demo"    neither of the above                  → remote benchmark data
 *
 * The "demo" source is ALWAYS read-only. The "local" and "github" sources
 * support full read/write.
 *
 * A user preference stored in config.json (`datasource: "demo" | "own"`)
 * can override the default only when the underlying capability exists
 * (e.g. you can't choose "own" without GITHUB_TOKEN).
 */

export type DataSource = "local" | "github" | "demo";

/** The best available source given current environment. */
export function resolveDataSource(): DataSource {
  // GitHub token present → user's own memory repo (production path)
  if (process.env.GITHUB_TOKEN) return "github";
  // No token → demo data (remote benchmark, or local benchmark-data directory)
  return "demo";
}

/**
 * The effective source after considering user preference.
 *
 * A user can only select "own" when a GitHub token is actually configured;
 * otherwise the preference is silently ignored and the best available
 * source is used.
 */
export function resolveEffectiveSource(
  preference?: string
): DataSource {
  const available = resolveDataSource();

  // Dev always local — preference ignored
  if (available === "local") return "local";

  // User wants their own data AND can access it
  if (preference === "own" && available === "github") return "github";

  // User explicitly wants demo, or demo is the only option
  if (preference === "demo" || available === "demo") return "demo";

  // Fallback to whatever is available
  return available;
}

/** Shortcut: are we currently in demo mode? */
export function isDemo(source?: DataSource): boolean {
  return (source ?? resolveDataSource()) === "demo";
}

/** Shortcut: can we write? */
export function isWritable(source?: DataSource): boolean {
  const s = source ?? resolveDataSource();
  return s === "local" || s === "github";
}
