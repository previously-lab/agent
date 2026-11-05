import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOctokit } from "@/lib/github/client";
import { createGitDialogueStorage, DIALOGUE_GIT_REF, githubDialogueFiles } from "@/lib/dialogue/git";
import { createDialogueStore } from "@/lib/dialogue/store";
import type { DialogueStorage } from "@/lib/dialogue/storage";
import type { TurnInput } from "@/lib/chat/turn-types";
import { DEFAULTS } from "@/lib/config/defaults";
import { FIXED_MODEL } from "@/lib/models/registry";

vi.mock("@/lib/github/client", () => ({ getOctokit: vi.fn() }));

type TreeEntry = { path: string; sha?: string | null; content?: string };
type Commit = { sha: string; tree: string; parent: string | null; files: Map<string, string> };
const missing = () => Object.assign(new Error("Not found"), { status: 404 });
const conflict = () => Object.assign(new Error("Reference moved"), { status: 422 });

/** In-memory Git data API. No repository, filesystem, network or real ref is touched. */
class MockGitRef {
  head: string | null = null;
  readonly commits = new Map<string, Commit>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly forceValues: boolean[] = [];
  dropUpdateAck = false;
  private sequence = 0;

  commit(sha: string | null): Commit {
    const found = sha ? this.commits.get(sha) : undefined;
    if (!found) throw missing();
    return found;
  }

  client() {
    const git = {
      getRef: async ({ ref }: { ref: string }) => {
        expect(ref).toBe(DIALOGUE_GIT_REF);
        if (!this.head) throw missing();
        return { data: { object: { sha: this.head } } };
      },
      getCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: this.commit(commit_sha).tree } } }),
      createTree: async ({ tree }: { tree: TreeEntry[] }) => {
        const sha = `tree-${++this.sequence}`;
        this.trees.set(sha, tree.map((entry) => ({ ...entry })));
        return { data: { sha } };
      },
      createCommit: async ({ tree, parents }: { tree: string; parents?: string[] }) => {
        const parent = parents?.[0] ?? null;
        const files = new Map(parent ? this.commit(parent).files : []);
        for (const entry of this.trees.get(tree) ?? []) {
          if (entry.sha === null) files.delete(entry.path);
          else if (typeof entry.content === "string") files.set(entry.path, entry.content);
          else throw new Error("The small fixture writes inline blobs only");
        }
        const sha = `commit-${++this.sequence}`;
        this.commits.set(sha, { sha, tree, parent, files });
        return { data: { sha } };
      },
      updateRef: async ({ sha, force }: { sha: string; force?: boolean }) => {
        this.forceValues.push(force ?? true);
        const candidate = this.commit(sha);
        if (force !== false || this.head !== candidate.parent) throw conflict();
        this.head = sha;
        if (this.dropUpdateAck) {
          this.dropUpdateAck = false;
          throw new Error("Simulated response loss after the ref moved");
        }
        return { data: { object: { sha } } };
      },
      createRef: async ({ sha }: { sha: string }) => {
        const candidate = this.commit(sha);
        if (this.head !== null || candidate.parent !== null) throw conflict();
        this.head = sha;
        return { data: { object: { sha } } };
      },
    };
    return {
      rest: { git },
      request: async (_route: string, { ref, path }: { ref: string; path: string }) => {
        const body = this.commit(ref).files.get(path);
        if (body === undefined) throw missing();
        return { data: body };
      },
    };
  }
}

let remote: MockGitRef;
beforeEach(() => {
  remote = new MockGitRef();
  vi.mocked(getOctokit).mockReturnValue(remote.client() as unknown as ReturnType<typeof getOctokit>);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network is denied in the mock Git fixture"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function storage(): DialogueStorage {
  return createGitDialogueStorage(githubDialogueFiles("fixture-owner", "fixture-repo"));
}

async function appendAfterBarrier(target: DialogueStorage, text: string, gate: Promise<void>, arrive: () => void) {
  let first = true;
  await target.transaction("fixture-scope", async (files) => {
    const before = await files.read("history.txt");
    if (first) { first = false; arrive(); await gate; }
    files.write("history.txt", `${before ?? ""}${text}`);
  });
}

describe("dialogue Git ref CAS without a real Git repository", () => {
  it("T03/T14: a CAS loser rereads and recomputes instead of replacing the winner's state", async () => {
    const [a, b] = [storage(), storage()];
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrive = () => { if (++arrived === 2) release(); };
    await Promise.all([appendAfterBarrier(a, "A;", gate, arrive), appendAfterBarrier(b, "B;", gate, arrive)]);

    const head = remote.commit(remote.head);
    expect(head.files.get("dialogue-runtime-v1/scopes/fixture-scope/history.txt")).toMatch(/^(?:A;B;|B;A;)$/);
    expect(head.parent).not.toBeNull();
    expect(remote.commit(head.parent).parent).toBeNull();
    // The loser created an orphan candidate before its non-force update lost.
    expect(remote.commits).toHaveLength(3);
    expect(remote.forceValues).toEqual([false]);
  });

  it("T08/T14: recovers an ambiguous ref acknowledgement and replays the same accepted input", async () => {
    remote.dropUpdateAck = true;
    const store = createDialogueStore(storage());
    const launch: TurnInput = {
      modelMessages: [], recentTurns: [], lastUserMessage: "Keep this input once.", model: FIXED_MODEL.id,
      modelConfig: FIXED_MODEL, thinking: true, reasoningEffort: "low", clientTimezone: "UTC", locale: "en",
      config: DEFAULTS, owner: "fixture", repo: "fixture", useGithub: true, useDemo: false,
      startedAtIso: "2026-11-06T00:00:00.000Z", turnId: "provisional", imageAttachments: [],
    };
    const first = await store.accept("fixture-scope", { clientMessageId: "stable-message", launch });
    const replay = await store.accept("fixture-scope", { clientMessageId: "stable-message", launch });
    expect(replay).toEqual(first);
    expect(remote.commits).toHaveLength(1);
    expect(remote.head).toBe("commit-2");
    expect(fetch).not.toHaveBeenCalled();
  });
});
