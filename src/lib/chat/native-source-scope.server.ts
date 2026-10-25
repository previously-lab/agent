import { createHash } from "node:crypto";
import { getRepoConfig } from "@/lib/capabilities";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getMode } from "@/lib/mode";
import { getMemoryRoot } from "@/lib/whitelist";
import { getDemoDatasetOrigin } from "@/lib/data-source/demo-origin";

export function nativeSourceScopeForDeployment(): string {
  const source = resolveDataSource();
  if (source === "github") {
    const { owner, repo } = getRepoConfig();
    return `${getMode()}:github:${owner}/${repo}`;
  }
  if (source === "demo") {
    const origin = createHash("sha256").update(getDemoDatasetOrigin().root).digest("hex").slice(0, 24);
    return `${getMode()}:demo:${origin}`;
  }
  const root = createHash("sha256").update(getMemoryRoot()).digest("hex").slice(0, 24);
  return `${getMode()}:local:${root}`;
}
