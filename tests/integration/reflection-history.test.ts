import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { buildReflectionRoundMessage } from "@/lib/chat/commit-contract";
import type { HistoryScanState } from "@/lib/chat/hq-history";

const h = vi.hoisted(() => ({
  head: "", list: vi.fn(), compare: vi.fn(), ref: vi.fn(), cache: new Map<string, unknown>(),
}));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: () => "github" }));
vi.mock("@/lib/capabilities", () => ({ getRepoConfig: () => ({ owner: "fixture", repo: "memory" }) }));
vi.mock("@/lib/github/read-view", () => ({ getGitHubReadHead: () => h.ref() }));
vi.mock("@/lib/github/client", () => ({ getOctokit: () => ({ rest: { repos: { listCommits: h.list, compareCommitsWithBasehead: h.compare } } }) }));
vi.mock("@/lib/cache/data-cache", async original => ({
  ...(await original<typeof import("@/lib/cache/data-cache")>()),
  cachedFetch: async (identity: string[], _ttl: number, _tags: string[], read: () => Promise<unknown>) => {
    const key = JSON.stringify(identity);
    if (!h.cache.has(key)) h.cache.set(key, await read());
    return h.cache.get(key);
  },
}));

let root: string;
let tree: string;
let clock: number;
const slice = "2026-10-22-0900";
const summary = (turn: string) => `Summary — ${slice}\n\n- reply ${turn}`;
async function commit(message: string, parents = h.head ? [h.head] : [], timestamp = clock++) {
  const author = { name: "Fixture", email: "fixture@example.test", timestamp, timezoneOffset: 0 };
  const sha = await git.writeCommit({ fs, dir: root, commit: { tree, parent: parents, message, author, committer: author } });
  h.head = sha;
  return sha;
}
async function reachable(head: string) {
  const result = new Map<string, Awaited<ReturnType<typeof git.readCommit>>>();
  const queue = [head];
  while (queue.length) {
    const sha = queue.pop()!;
    if (result.has(sha)) continue;
    const entry = await git.readCommit({ fs, dir: root, oid: sha });
    result.set(sha, entry);
    queue.push(...entry.commit.parent);
  }
  return result;
}
function wire(entry: Awaited<ReturnType<typeof git.readCommit>>) {
  return { sha: entry.oid, parents: entry.commit.parent.map(sha => ({ sha })), commit: {
    message: entry.commit.message, committer: { date: new Date(entry.commit.committer.timestamp * 1000).toISOString() },
  } };
}

beforeEach(async () => {
  vi.clearAllMocks(); h.cache.clear(); h.head = "";
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-history-"));
  await git.init({ fs, dir: root });
  tree = await git.writeTree({ fs, dir: root, tree: [] });
  clock = 1_792_627_200;
  h.ref.mockImplementation(async () => ({ headSha: h.head }));
  h.list.mockImplementation(async ({ sha, page, per_page, path: filter }: { sha: string; page: number; per_page: number; path?: string }) => {
    expect(filter).toBeUndefined(); // empty round commits must be visible
    const entries = [...(await reachable(sha)).values()].sort((a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp);
    return { data: entries.slice((page - 1) * per_page, page * per_page).map(wire) };
  });
  h.compare.mockImplementation(async ({ basehead, page, per_page }: { basehead: string; page: number; per_page: number }) => {
    const [basis, head] = basehead.split("...");
    const before = await reachable(basis);
    const after = await reachable(head);
    const ancestor = after.has(basis);
    const entries = [...after.values()].filter(c => !before.has(c.oid)).sort((a, b) => a.commit.committer.timestamp - b.commit.committer.timestamp);
    return { data: { merge_base_commit: { sha: ancestor ? basis : "0".repeat(40) }, status: ancestor ? "ahead" : "diverged", total_commits: entries.length,
      commits: entries.slice((page - 1) * per_page, page * per_page).map(wire) } };
  });
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network in history fixture"); });
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

async function finish(state?: HistoryScanState) {
  const { readReflectionHistoryChunk } = await import("@/lib/chat/hq-history");
  for (let n = 0; n < 100; n++) {
    const read = await readReflectionHistoryChunk(state);
    if (!read.available || read.complete) return read;
    state = read.continuation;
  }
  throw new Error("History scan did not converge");
}

describe("real Git DAG through the GitHub history boundary", { timeout: 30_000 }, () => {
  it("continues after three pages and keeps the original HEAD when another commit arrives", async () => {
    const old = await commit(summary("old"));
    for (let n = 0; n < 301; n++) await commit(`External change ${n}`);
    const basis = h.head;
    const { readReflectionHistoryChunk } = await import("@/lib/chat/hq-history");
    const first = await readReflectionHistoryChunk();
    expect(first.available && !first.complete && "continuation" in first).toBe(true);
    expect(h.list).toHaveBeenCalledTimes(3);
    const newer = await commit(summary("new"));
    const read = await finish(first.available && !first.complete ? first.continuation : undefined);
    expect(read.available && read.complete && read.history.basis).toBe(basis);
    expect(read.available && read.complete && read.history.pending.map(m => m.sha)).toEqual([old]);
    expect(h.ref).toHaveBeenCalledTimes(1);
    const next = await finish();
    expect(next.available && next.complete && next.history.pending.map(m => m.sha).sort()).toEqual([old, newer].sort());
  });

  it("a checkpoint reads only the delta, including an old-timestamp merged summary", async () => {
    const original = await commit(summary("same"));
    const branchRoot = h.head;
    for (let n = 0; n < 310; n++) await commit(`External change ${n}`);
    const basis = h.head;
    const checkpoint = await commit(buildReflectionRoundMessage({ date: "2026-10-22", trailer: {
      observed: [{ sha: original, sliceId: slice, turnIds: ["same"] }],
      history: { version: 1, basis, cursor: slice, evolved: null, pending: [] },
    } }));
    const side = await commit(summary("same"), [branchRoot], clock - 1000);
    await commit("Merge old branch", [checkpoint, side]);
    const read = await finish();
    expect(read.available && read.complete && read.history.pending).toEqual([{ sha: side, sliceId: slice, turnIds: ["same"] }]);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.compare).toHaveBeenCalledTimes(1);
    expect(h.compare.mock.calls[0][0].basehead).toBe(`${basis}...${h.head}`);
  });

  it("a checkpoint whose basis was rewritten rebuilds instead of declaring an empty delta", async () => {
    const removed = await commit(summary("removed"));
    const kept = await commit(summary("kept"), []);
    await commit(buildReflectionRoundMessage({ date: "2026-10-22", trailer: { history: {
      version: 1, basis: removed, cursor: slice, evolved: null, pending: [],
    } } }), [kept]);
    const read = await finish();
    expect(read.available && read.complete && read.history.pending).toEqual([{ sha: kept, sliceId: slice, turnIds: ["kept"] }]);
    expect(h.compare).toHaveBeenCalledTimes(1);
  });

  it("a rate-limited continuation stays unavailable rather than marking unscanned history done", async () => {
    await commit(summary("unseen"));
    for (let n = 0; n < 300; n++) await commit(`External change ${n}`);
    const { readReflectionHistoryChunk } = await import("@/lib/chat/hq-history");
    const first = await readReflectionHistoryChunk();
    h.list.mockRejectedValueOnce(new Error("API rate limit exceeded"));
    const read = await readReflectionHistoryChunk(first.available && !first.complete ? first.continuation : undefined);
    expect(read).toEqual({ available: false, complete: false, reason: "history read failed: API rate limit exceeded" });
  });
});
