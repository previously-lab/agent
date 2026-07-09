/**
 * User profile — mutable, agent-editable data. Loaded live from
 * memory/user/profile.md on every request via the same path as all memory
 * reads (GitHub when a token is set, local disk otherwise), so edits — the
 * user's or the agent's own — take effect immediately with no redeploy.
 *
 * DEMO_MODE redirects memory/ reads to the demo persona (handled in local-fs),
 * so the demo home page shows Caleb for free.
 */
import matter from "gray-matter";
import { readFile } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";

const PROFILE_PATH = "memory/user/profile.md";
const USE_GITHUB = process.env.GITHUB_TOKEN != null;

export interface UserProfile {
  name: string;
  pronouns?: string;
  timezone?: string;
  locale?: string;
  addressAs?: string;
  body: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readProfileRaw(): Promise<string | null> {
  try {
    if (USE_GITHUB) {
      const owner = process.env.GITHUB_REPO_OWNER ?? "local";
      const repo = process.env.GITHUB_REPO_NAME ?? "local";
      return await readFile(PROFILE_PATH, repo, owner);
    }
    return await readFileLocal(PROFILE_PATH);
  } catch {
    return null; // missing / unreadable → fall back to defaults
  }
}

export async function loadUserProfile(): Promise<UserProfile> {
  const raw = await readProfileRaw();
  const { data, content } = raw
    ? matter(raw)
    : { data: {} as Record<string, unknown>, content: "" };
  return {
    name: str(data.name) ?? "",
    pronouns: str(data.pronouns),
    timezone: str(data.timezone),
    locale: str(data.locale),
    addressAs: str(data.address_as),
    body: content.trim(),
  };
}

/** The user's display name, or `fallback` ("You") when unset. */
export async function getUserName(fallback = "You"): Promise<string> {
  return (await loadUserProfile()).name || fallback;
}
