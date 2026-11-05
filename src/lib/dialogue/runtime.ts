import { homedir } from "node:os";
import { join } from "node:path";
import { guardRequest } from "@/lib/security/origin-guard";
import { DialogueConflict } from "./store";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { getMemoryRoot } from "@/lib/whitelist";
import { digest } from "./artifacts";
import { createDialogueStore, type DialogueStore } from "./store";

export class DialogueUnavailable extends Error {
  constructor(message: string, readonly code: "dialogue_disabled" | "dialogue_unavailable" = "dialogue_unavailable") { super(message); this.name = "DialogueUnavailable"; }
}

export function resolveDialogueScope(persona: unknown): string {
  const source = resolveDataSource();
  if (source === "demo") throw new DialogueUnavailable("The sample archive is read-only", "dialogue_disabled");
  const actor = typeof persona === "string" && /^[a-z0-9_-]{1,64}$/i.test(persona) ? persona : "user";
  const identity = source === "github" ? getRepoConfig() : getMemoryRoot();
  return digest(JSON.stringify([source, identity, actor]));
}

export function sharedDialogueRuntime(): boolean {
  return process.env.VERCEL === "1" || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

const stores = new Map<string, Promise<DialogueStore>>();

export async function getDialogueStore(): Promise<DialogueStore> {
  const source = resolveDataSource();
  if (source === "demo") throw new DialogueUnavailable("The sample archive is read-only", "dialogue_disabled");
  if (source === "local" && sharedDialogueRuntime()) throw new DialogueUnavailable("Local dialogue files need a persistent single-host deployment; use the configured Git source on serverless");
  const directory = process.env.DIALOGUE_RUNTIME_DIR?.trim() || join(process.env.PREVIOUSLY_HOME || join(homedir(), ".previously"), "runtime", "dialogue-v1");
  const { owner, repo } = getRepoConfig();
  const identity = source === "github" ? `git:${owner}/${repo}` : `local:${directory}`;
  const existing = stores.get(identity);
  if (existing) return existing;
  const pending = (async () => {
    if (source === "github") {
      const { createGitDialogueStorage, githubDialogueFiles } = await import("./git");
      return createDialogueStore(createGitDialogueStorage(githubDialogueFiles(owner, repo)));
    }
    const { createLocalDialogueStorage } = await import("./local");
    return createDialogueStore(createLocalDialogueStorage(directory));
  })();
  stores.set(identity, pending);
  void pending.catch(() => { if (stores.get(identity) === pending) stores.delete(identity); });
  return pending;
}

export function dialogueResponseError(error: unknown): Response {
  if (error instanceof DialogueUnavailable) return Response.json({ code: error.code, error: error.message }, { status: error.code === "dialogue_disabled" ? 409 : 503 });
  if (error instanceof DialogueConflict) return Response.json({ code: "dialogue_conflict", error: error.message }, { status: 409 });
  // Provider credentials and adapter internals never appear in a response.
  return Response.json({ code: "dialogue_unavailable", error: "The conversation store is temporarily unavailable" }, { status: 503 });
}

/** Apply the same optional private-deployment key policy to manuscript reads. */
export function guardDialogueRead(request: Request): Response | null {
  return guardRequest(new Request(request.url, { method: "POST", headers: request.headers }));
}
