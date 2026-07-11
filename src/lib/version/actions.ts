"use server";

import { APP_VERSION, GITHUB_RELEASES_API } from "./constants";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Link to the updating instructions in docs */
  docsUrl: string;
}

/**
 * Fetch the latest release tag from GitHub and compare with APP_VERSION.
 * Returns null for `latest` if the API is unreachable (no network / rate-limited).
 * Semver comparison is intentionally simple — tag vs version string match.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  let latest: string | null = null;

  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 }, // cache for 1 hour
    });
    if (res.ok) {
      const data = (await res.json()) as { tag_name?: string };
      latest = data.tag_name?.replace(/^v/, "") ?? null;
    }
  } catch {
    // network error / rate limit — silently fall back
  }

  return {
    current: APP_VERSION,
    latest,
    updateAvailable: latest !== null && latest !== APP_VERSION,
    docsUrl: "/docs/deployment#updating",
  };
}
