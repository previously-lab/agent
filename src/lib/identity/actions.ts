"use server";

import { applyProfilePatch, type ProfilePatch } from "./profile-writer";

/**
 * Persist a user-profile edit from the Settings form to memory/user/profile.md.
 * Reuses the same writer as the agent's `updateUserProfile` tool.
 */
export async function saveUserProfile(
  patch: ProfilePatch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await applyProfilePatch(patch, "Update profile from settings");
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
