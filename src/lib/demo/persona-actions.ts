"use server";

import { revalidatePath } from "next/cache";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";

const CONFIG_PATH = "memory/user/config.json";

export async function completeOnboarding() {
  const source = resolveDataSource();
  if (source === "demo") {
    revalidatePath("/", "layout");
    return;
  }

  try {
    const content = JSON.stringify({ onboarded: true, datasource: "own" }, null, 2);
    if (source === "github") {
      const owner = process.env.GITHUB_REPO_OWNER ?? "";
      const repo = process.env.GITHUB_REPO_NAME ?? "";
      await writeFileGitHub(CONFIG_PATH, content, repo, owner, "[previously] complete onboarding");
    } else {
      await writeFileLocal(CONFIG_PATH, content);
    }
  } catch {
    // Non-fatal
  }

  revalidatePath("/", "layout");
}
