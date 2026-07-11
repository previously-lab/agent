/**
 * Shared profile writer — read-merge-write for memory/user/profile.md.
 *
 * Used by BOTH the settings server action (`./actions.ts`) and the agent's
 * `updateUserProfile` tool, so profile edits go through one code path with a
 * fixed schema (partial patches merge; omitted fields are left untouched).
 *
 * Not a `"use server"` module — it's a plain server-only helper. The path is
 * hard-coded so no caller (user form or agent) can redirect the write.
 */
import matter from "gray-matter";
import { readFile } from "@/lib/tools/readFile";
import { writeFile } from "@/lib/tools/writeFile";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";

const PROFILE_PATH = "memory/user/profile.md";
const USE_GITHUB = !!process.env.GITHUB_TOKEN;

export interface ProfilePatch {
  name?: string;
  pronouns?: string;
  timezone?: string;
  locale?: string;
  addressAs?: string; // frontmatter `address_as`
  body?: string; // free-form "about you" markdown
}

function repoConfig() {
  return {
    owner: process.env.GITHUB_REPO_OWNER ?? "local",
    repo: process.env.GITHUB_REPO_NAME ?? "local",
  };
}

/**
 * Merge `patch` into memory/user/profile.md. Only defined fields are written;
 * everything else (including unknown frontmatter keys) is preserved.
 */
export async function applyProfilePatch(
  patch: ProfilePatch,
  commitMessage = "Update user profile",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let raw = "---\n---\n";
    try {
      const { owner, repo } = repoConfig();
      raw = USE_GITHUB
        ? await readFile(PROFILE_PATH, repo, owner)
        : await readFileLocal(PROFILE_PATH);
    } catch {
      // missing file → start from empty frontmatter
    }

    const parsed = matter(raw);
    const data: Record<string, unknown> = { ...parsed.data };

    if (patch.name !== undefined) data.name = patch.name;
    if (patch.pronouns !== undefined) data.pronouns = patch.pronouns;
    if (patch.timezone !== undefined) data.timezone = patch.timezone;
    if (patch.locale !== undefined) data.locale = patch.locale;
    if (patch.addressAs !== undefined) data.address_as = patch.addressAs;

    const body = patch.body !== undefined ? patch.body : parsed.content;
    const next = matter.stringify(`${body.trim()}\n`, data);

    if (USE_GITHUB) {
      const { owner, repo } = repoConfig();
      await writeFile(PROFILE_PATH, next, repo, owner, commitMessage);
    } else {
      await writeFileLocal(PROFILE_PATH, next);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "write failed" };
  }
}
