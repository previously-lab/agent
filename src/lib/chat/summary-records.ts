import type { SummaryRunPayload, TurnRunResult } from "./turn-types";
import { parseSlice } from "@/lib/episodic/manager";
import type { TimeSlice } from "@/lib/episodic/types";
import { readSlicePartResolved } from "@/lib/episodic/paths";
import { enumerateSliceIds } from "@/lib/episodic/timeline/enumerate";
import { getRepoTree, readBlobText, type RepoTreeEntry } from "@/lib/tools/readFile";
import { cachedFetch, CACHE_TTLS } from "@/lib/cache/data-cache";
import { getGitHubReadHead, withGitHubReadView } from "@/lib/github/read-view";
import { getOctokit } from "@/lib/github/client";
import { getMemoryRoot } from "@/lib/whitelist";

const CORE_PATH = /^memory\/(?:records|episodic\/slices)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4})\/(?:timeline\/)?core\.md$/;
interface IdentityIndex { turns: string[]; messages: string[] }
export interface SummaryRecordLookup { saved: Map<string, TimeSlice>; commitSha: string | null }

function indexSlice(raw: string): IdentityIndex {
  const turns = parseSlice(raw).turns;
  return {
    turns: turns.map((t) => t.turnId).filter((id): id is string => !!id),
    messages: turns.filter((t) => t.role === "user").map((t) => t.clientMessageId).filter((id): id is string => !!id),
  };
}

/** GitHub can truncate a recursive tree. Walk immutable subtree objects instead. */
async function coreEntries(repo: string, owner: string, headSha: string): Promise<RepoTreeEntry[]> {
  const tree = await getRepoTree(repo, owner, { ref: headSha });
  if (!tree.truncated) return tree.entries.filter((e) => e.type === "blob" && CORE_PATH.test(e.path));
  const entries: RepoTreeEntry[] = [];
  const queue = [{ sha: tree.treeSha, path: "memory" }];
  while (queue.length) {
    const current = queue.shift()!;
    const children = await cachedFetch(["github", "summary-directory", owner, repo, current.sha], CACHE_TTLS.BLOB_SECONDS, [], async () => {
      const { data } = await getOctokit().rest.git.getTree({ owner, repo, tree_sha: current.sha });
      if (data.truncated) throw new Error("GitHub directory listing is incomplete");
      return data.tree;
    });
    for (const child of children) {
      if (!child.path || !child.sha) continue;
      const path = `${current.path}/${child.path}`;
      if (child.type === "tree") queue.push({ sha: child.sha, path });
      else if (child.type === "blob" && CORE_PATH.test(path)) entries.push({ path, sha: child.sha, type: "blob", size: child.size });
    }
  }
  return entries;
}

/**
 * Locate identities from the immutable record tree, never the unbounded
 * commit history. Old per-core indexes survive unrelated commits by blob
 * SHA; a warm turn only fetches new/changed core objects. No state file or
 * process-global mutable identity map is introduced.
 */
export async function locateSummaryRecords(payload: SummaryRunPayload, members: TurnRunResult[]): Promise<SummaryRecordLookup> {
  const saved = new Map<string, TimeSlice>();
  const matches = (member: TurnRunResult, slice: TimeSlice): boolean => {
    if (slice.turns.some((t) => t.turnId === member.turnId)) return true;
    if (member.clientMessageId && slice.turns.some((t) => t.role === "user" && t.clientMessageId === member.clientMessageId)) return true;
    const lastUser = slice.turns.filter((t) => t.role === "user").at(-1);
    return !!(member.regenerate && slice.slice_id === payload.sliceId && !lastUser?.clientMessageId && lastUser?.content === member.userText);
  };
  if (payload.useGithub) return withGitHubReadView(async () => {
    const { headSha } = await getGitHubReadHead(payload.repo, payload.owner);
    const allEntries = await coreEntries(payload.repo, payload.owner, headSha);
    const primary = new Map<string, RepoTreeEntry>();
    for (const entry of allEntries) {
      const id = entry.path.match(CORE_PATH)!.slice(1).join("-");
      if (!primary.has(id) || entry.path.startsWith("memory/records/")) primary.set(id, entry);
    }
    const entries = [...primary.values()];
    for (let offset = 0; offset < entries.length; offset += 4) {
      await Promise.all(entries.slice(offset, offset + 4).map(async (entry) => {
        if ((entry.size ?? 0) > 1_000_000) throw new Error(`Record too large to verify: ${entry.path}`);
        const index = await cachedFetch(["github", "summary-identities", payload.owner, payload.repo, entry.sha], CACHE_TTLS.BLOB_SECONDS, [], async () => indexSlice(await readBlobText(entry.sha, payload.repo, payload.owner)));
        const id = entry.path.match(CORE_PATH)!.slice(1).join("-");
        if (!members.some((m) => index.turns.includes(m.turnId) || (!!m.clientMessageId && index.messages.includes(m.clientMessageId)) || (m.regenerate && id === payload.sliceId))) return;
        const slice = parseSlice(await readBlobText(entry.sha, payload.repo, payload.owner));
        for (const member of members) if (matches(member, slice)) saved.set(member.turnId, slice);
      }));
    }
    return { saved, commitSha: headSha };
  }, { fresh: true });

  const paths = await enumerateSliceIds();
  if (/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(payload.sliceId)) paths.push(payload.sliceId.replaceAll("-", "/"));
  const verified: Array<{ path: string; raw: string }> = [];
  for (const rel of new Set(paths)) {
    const raw = await readSlicePartResolved(rel.replaceAll("/", "-"), "core", undefined, { fresh: true });
    if (!raw) continue;
    const slice = parseSlice(raw.content);
    for (const member of members) if (matches(member, slice)) {
      saved.set(member.turnId, slice);
      verified.push({ path: raw.path.replace(/^memory\//, ""), raw: raw.content });
    }
  }
  // Uncommitted local editor changes are content, but are not a Git proof.
  let commitSha: string | null = null;
  if (verified.length) {
    try {
      const [{ default: git }, { default: fs }] = await Promise.all([import("isomorphic-git"), import("node:fs")]);
      const dir = getMemoryRoot();
      const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
      const consistent = await Promise.all(verified.map(async (item) => {
        const { blob } = await git.readBlob({ fs, dir, oid: head, filepath: item.path });
        return Buffer.from(blob).toString("utf8") === item.raw;
      }));
      if (consistent.every(Boolean)) commitSha = head;
    } catch { /* non-git local roots retain content dedupe without a receipt */ }
  }
  return { saved, commitSha };
}
