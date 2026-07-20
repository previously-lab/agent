"use server";

import { revalidatePath } from "next/cache";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { writeFileLocal } from "@/lib/tools/local-fs";
import { readFileLocal } from "@/lib/tools/local-fs";

const CONFIG_PATH = "memory/user/config.json";

export async function selectPersona(personaId: string) {
  setDemoPersona(personaId);

  const source = resolveDataSource();
  if (source === "demo") {
    // Can't persist — just refresh with the in-memory change
    revalidatePath("/", "layout");
    return;
  }

  // Persist to config.json when writable
  try {
    let config: Record<string, unknown> = {};
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
      // local dev
      await writeFileLocal(
        CONFIG_PATH,
        JSON.stringify({ onboarded: true, datasource: "demo" }, null, 2)
      );
    }
  } catch {
    // Non-fatal — the selection still works in-memory for this session
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
