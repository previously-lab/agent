import { getOctokit } from "@/lib/github/client";
import { bufferedFiles, retryConflict, type DialogueFiles, type DialogueStorage } from "./storage";

/** A private branch with its own root. Never enumerate via the memory APIs. */
export const DIALOGUE_GIT_REF = "heads/previously-dialogue-runtime-v1";
const ROOT = "dialogue-runtime-v1";
const SCHEDULE = `${ROOT}/schedule.json`;
const scopeRoot = (scope: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope)) throw new Error("Invalid dialogue scope");
  return `${ROOT}/scopes/${scope}`;
};

export interface DialogueGit {
  head(): Promise<string | null>;
  read(head: string, path: string): Promise<string | null>;
  /** Publish a child of exactly expected, or create the initially empty ref.
   * Returns false for a competing commit, never force-updates the branch. */
  commit(expected: string | null, writes: Map<string, string | null>): Promise<string | false>;
}

export function createGitDialogueStorage(git: DialogueGit): DialogueStorage {
  let cached: { until: number; head: string | null } | undefined;
  let pending: Promise<string | null> | undefined;
  async function viewHead() {
    if (cached && cached.until > Date.now()) return cached.head;
    if (!pending) {
      pending = git.head().then((head) => {
        cached = { head, until: Date.now() + 1_500 };
        return head;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  return {
    async view<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>) {
      const base = await viewHead();
      const prefix = scopeRoot(scope);
      return operation(bufferedFiles((path) => base ? git.read(base, `${prefix}/${path}`) : Promise.resolve(null)).files, Date.now());
    },
    async transaction<T>(scope: string, operation: (files: DialogueFiles, now: number) => Promise<T>) {
      const prefix = scopeRoot(scope);
      for (let attempt = 0; attempt < 6; attempt++) {
        const base = await git.head();
        const buffer = bufferedFiles((path) => base ? git.read(base, `${prefix}/${path}`) : Promise.resolve(null));
        const result = await operation(buffer.files, Date.now());
        if (!buffer.writes.size && buffer.due === undefined) return result;
        const writes = new Map([...buffer.writes].map(([path, body]) => [`${prefix}/${path}`, body]));
        if (buffer.due !== undefined) {
          const raw = base ? await git.read(base, SCHEDULE) : null;
          const index: Record<string, number> = raw ? JSON.parse(raw) : {};
          const old = index[scope] ?? null;
          if (old !== buffer.due) {
            if (buffer.due === null) delete index[scope]; else index[scope] = buffer.due;
            writes.set(SCHEDULE, JSON.stringify(index));
          }
        }
        if (!writes.size) return result;
        const committed = await git.commit(base, writes);
        if (committed) {
          cached = { head: committed, until: Date.now() + 1_500 };
          return result;
        }
        cached = undefined;
        await retryConflict(attempt);
      }
      throw new Error("Dialogue branch was busy; retry the same operation");
    },
    async dueScopes(now, limit) {
      const base = await viewHead();
      if (!base) return [];
      const raw = await git.read(base, SCHEDULE);
      const schedule: Record<string, number> = raw ? JSON.parse(raw) : {};
      return Object.entries(schedule).filter(([, due]) => due <= now)
        .sort((a, b) => a[1] - b[1]).slice(0, limit).map(([scope]) => scope);
    },
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
}

export function githubDialogueFiles(owner: string, repo: string): DialogueGit {
  async function head(): Promise<string | null> {
    try {
      const { data } = await getOctokit().rest.git.getRef({ owner, repo, ref: DIALOGUE_GIT_REF });
      return data.object.sha;
    } catch (error) { if (status(error) === 404) return null; throw error; }
  }

  return {
    head,
    async read(ref, path) {
      try {
        const response = await getOctokit().request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner, repo, path, ref, headers: { accept: "application/vnd.github.raw+json" },
        });
        const body: unknown = response.data;
        if (typeof body === "string") return body;
        if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
        if (body && typeof body === "object" && "content" in body && typeof body.content === "string") return Buffer.from(body.content, "base64").toString("utf8");
        throw new Error("Unexpected dialogue file response");
      } catch (error) { if (status(error) === 404) return null; throw error; }
    },
    async commit(expected, writes) {
      const git = getOctokit().rest.git;
      const baseTree = expected ? (await git.getCommit({ owner, repo, commit_sha: expected })).data.tree.sha : undefined;
      const entries = await Promise.all([...writes].map(async ([path, body]) => {
        const file = { path, mode: "100644" as const, type: "blob" as const };
        if (body === null) return { ...file, sha: null };
        if (Buffer.byteLength(body) <= 512 * 1024) return { ...file, content: body };
        const { data } = await git.createBlob({ owner, repo, encoding: "base64", content: Buffer.from(body).toString("base64") });
        return { ...file, sha: data.sha };
      }));
      const { data: tree } = await git.createTree({ owner, repo, ...(baseTree ? { base_tree: baseTree } : {}), tree: entries });
      const { data: commit } = await git.createCommit({
        owner, repo, message: "Advance private dialogue runtime", tree: tree.sha,
        parents: expected ? [expected] : [],
      });
      try {
        if (expected) await git.updateRef({ owner, repo, ref: DIALOGUE_GIT_REF, sha: commit.sha, force: false });
        else await git.createRef({ owner, repo, ref: `refs/${DIALOGUE_GIT_REF}`, sha: commit.sha });
      } catch (error) {
        // Ambiguous HTTP failures must not turn into another publication. If
        // the ref already names this commit, treat it as the successful write.
        // If another child won, re-read and recompute the idempotent operation.
        const actual = await head().catch(() => undefined);
        if (actual === commit.sha) return commit.sha;
        if (actual !== undefined && actual !== expected) return false;
        throw error;
      }
      return commit.sha;
    },
  };
}
