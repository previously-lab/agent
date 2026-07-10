"use server";

import { revalidatePath } from "next/cache";
import { applyProfilePatch, type ProfilePatch } from "./profile-writer";

/**
 * Persist a user-profile edit from the Settings form to memory/user/profile.md.
 * Reuses the same writer as the agent's `updateUserProfile` tool.
 */
export async function saveUserProfile(
  patch: ProfilePatch,
): Promise<{ ok: boolean; error?: string }> {
  const res = await applyProfilePatch(patch, "Update profile from settings");
  if (res.ok) {
    // The home hero reads this profile — revalidate so the name reflects the
    // edit without a rebuild.
    revalidatePath("/", "layout");
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
