"use server";

import { revalidatePath } from "next/cache";
import { setPersonaId } from "@/lib/demo/persona-cookie";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";

const CONFIG_PATH = "memory/user/config.json";

export async function selectPersona(personaId: string) {
  // Cookie is the source of truth for persona selection
  await setPersonaId(personaId);

  const source = resolveDataSource();
  if (source !== "demo") {
    // Persist to config.json when writable
    try {
      if (source === "github") {
        const owner = process.env.GITHUB_REPO_OWNER ?? "";
        const repo = process.env.GITHUB_REPO_NAME ?? "";
        await writeFileGitHub(
          CONFIG_PATH,
          JSON.stringify({ onboarded: true, datasource: "demo" }, null, 2),
          repo,
          owner,
          "[previously] select demo persona"
        );
      } else {
        await writeFileLocal(
          CONFIG_PATH,
          JSON.stringify({ onboarded: true, datasource: "demo" }, null, 2)
        );
      }
    } catch {
      // Non-fatal
    }
  }

  revalidatePath("/", "layout");
}

export async function completeOnboarding() {
  const source = resolveDataSource();
  if (source === "demo") {
    revalidatePath("/", "layout");
    return;
  }

  try {
    if (source === "github") {
      const owner = process.env.GITHUB_REPO_OWNER ?? "";
      const repo = process.env.GITHUB_REPO_NAME ?? "";
      await writeFileGitHub(
        CONFIG_PATH,
        JSON.stringify({ onboarded: true, datasource: "own" }, null, 2),
        repo,
        owner,
        "[previously] complete onboarding"
      );
    } else {
      await writeFileLocal(
        CONFIG_PATH,
        JSON.stringify({ onboarded: true, datasource: "own" }, null, 2)
      );
    }
  } catch {
    // Non-fatal
  }

  revalidatePath("/", "layout");
}
