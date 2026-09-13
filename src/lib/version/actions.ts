"use server";

import { CACHE_TTLS, cacheTagFor, cachedFetch } from "@/lib/cache/data-cache";
import { APP_VERSION, GITHUB_RELEASES_API, compareSemver } from "./constants";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Link to the updating instructions in the official docs */
  docsUrl: string;
}

/**
 * Fetch the latest release tag from GitHub and compare with APP_VERSION.
 * Returns null for `latest` if the API is unreachable (no network / rate-limited).
 * Compares versions using semver — only reports an update when upstream is strictly newer.
 *
 * The read is cached through `@/lib/cache/data-cache` — it used to be the one
 * `fetch(..., { next: { revalidate: 3600 } })` left in the codebase, which is
 * the same Data Cache under a spelling no tag-based invalidation can reach.
 * Failures (`!res.ok`, network) THROW inside the cached reader on purpose:
 * the Data Cache only stores results, so an unreachable API is never cached
 * and the next call retries — the `catch` below turns that into the same
 * silent null fallback this always returned.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  let latest: string | null = null;

  try {
    const data = await cachedFetch<{ tag_name?: string }>(
      ["github-release", GITHUB_RELEASES_API],
      CACHE_TTLS.RELEASE_CHECK_SECONDS,
      [cacheTagFor("version", "latest-release")],
      async () => {
        const res = await fetch(GITHUB_RELEASES_API, {
          headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) throw new Error(`Releases API responded ${res.status}`);
        return (await res.json()) as { tag_name?: string };
      },
    );
    latest = data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    // network error / rate limit — silently fall back
  }

  return {
    current: APP_VERSION,
    latest,
    updateAvailable: latest !== null && compareSemver(latest, APP_VERSION) > 0,
    docsUrl: "https://previously.ldwid.com/docs/deployment#syncing-upstream-updates",
  };
}
