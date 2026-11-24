import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { createNextDataCacheContext } from "../../helpers/next-data-cache-context";
import type { RecallBackend, RecallSearchInput } from "@/lib/memory/facade";
import type { RepoTree, RepoTreeEntry } from "@/lib/tools/readFile";

const fixture = vi.hoisted(() => ({
  bodies: new Map<string, string>(), reads: [] as string[], failing: "", active: 0, peak: 0, wire: 0,
}));
vi.mock("@/lib/github/client", async (original) => ({
  ...await original<typeof import("@/lib/github/client")>(),
  getOctokit: () => ({ rest: { git: { getBlob: async ({ file_sha }: { file_sha: string }) => {
    fixture.wire++;
    const body = fixture.bodies.get(file_sha);
    if (body === undefined) throw Error("Unexpected missing object");
    return { data: { content: Buffer.from(body).toString("base64") } };
  } } } }),
}));
vi.mock("@/lib/tools/readFile", async (original) => {
  const actual = await original<typeof import("@/lib/tools/readFile")>();
  return {
    ...actual,
    async readTextFromCompleteTree(tree: RepoTree, path: string, repo: string, owner: string) {
      fixture.reads.push(path);
      fixture.active++;
      fixture.peak = Math.max(fixture.peak, fixture.active);
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (path === fixture.failing) throw Error("Transient read failure");
        return await actual.readTextFromCompleteTree(tree, path, repo, owner);
      } finally { fixture.active--; }
    },
  };
});

const ctx = createNextDataCacheContext();
const { buildTreeIndex, recallSearch } = await import("@/lib/memory/facade");
const { gitHubCaseActivityDates } = await import("@/lib/github/case-activity");

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function snapshot(docs: Map<string, string>) {
  const blobs = [...docs.keys()].sort().map(path => {
    const sha = digest(docs.get(path)!);
    fixture.bodies.set(sha, docs.get(path)!);
    return { type: "blob" as const, path, sha };
  });
  const entries: RepoTreeEntry[] = [...blobs];
  for (const dir of new Set(blobs.map(entry => entry.path.split("/").slice(0, 2).join("/")))) {
    const sha = digest(JSON.stringify(blobs.filter(blob => blob.path.startsWith(dir + "/"))));
    entries.push({ type: "tree", path: dir, sha });
  }
  const tree = { treeSha: digest(JSON.stringify(entries)), entries, truncated: false };
  const base: RecallBackend = {
    listMemoryFiles: async () => blobs.map(entry => entry.path),
    readFile: async path => docs.get(path)!,
  };
  const indexed: RecallBackend = {
    ...base, caseActivityDates: nodes => gitHubCaseActivityDates(tree, nodes, "repo", "owner"),
  };
  return { tree, base, indexed };
}

beforeEach(() => {
  fixture.bodies.clear(); fixture.reads.length = 0;
  fixture.failing = ""; fixture.active = 0; fixture.peak = 0; fixture.wire = 0;
});

it("matches the original search through cold, warm, paginated and changed snapshots", async () => {
  const docs = new Map<string, string>();
  for (const category of ["events", "research", "hypotheses"]) {
    for (let n = 0; n < 37; n++) {
      docs.set(`memory/${category}/case-${n}/index.md`, "---\nopened: '2026-08-14'\n---\nshared keyword");
    }
  }
  docs.set("memory/events/case-0/_current.md", "---\nas_of: '2026-11-10'\n---\nshared keyword today");
  async function compare(view: ReturnType<typeof snapshot>, opts: Partial<RecallSearchInput> = {}) {
    const query = { query: ["shared", "keyword"], includeSemanticPassages: true, ...opts };
    const expected = await recallSearch(view.base, query);
    expect(await ctx.run(() => recallSearch(view.indexed, query))).toEqual(expected);
    await ctx.run(() => ctx.flush());
  }
  const first = snapshot(docs);
  await compare(first);
  expect(fixture.reads).toHaveLength(112);
  expect(fixture.peak).toBeLessThanOrEqual(8);
  fixture.reads.length = 0;
  await compare(first, { scanCursor: 50 });
  await compare(first, { category: "research", since: "2026-08-01", until: "2026-11-22" });
  await compare(first, { dateBasis: "conversation", since: "2026-08-01" });
  expect(fixture.reads).toHaveLength(0);

  // A different latest piece or a changed records subtree must not force a header read.
  docs.set("memory/events/case-22/2026-11-18-Updates.md", "shared keyword");
  docs.set("memory/records/2026/11/18/0101/core.md", "# Slice");
  await compare(snapshot(docs));
  expect(fixture.reads).toHaveLength(0);
  // An edited header, moved case, and removed current page all affect ordering immediately.
  docs.set("memory/events/case-18/index.md", "---\nupdated: '2026-11-22'\n---\nshared keyword");
  docs.delete("memory/events/case-3/index.md");
  docs.set("memory/research/renamed/index.md", "---\nopened: '2026-11-13'\n---\nshared keyword");
  docs.delete("memory/events/case-0/_current.md");
  await compare(snapshot(docs));
  expect(fixture.reads.length).toBeGreaterThan(0);
  expect(fixture.reads.length).toBeLessThan(20);
  expect(fixture.reads.every(path => !path.startsWith("memory/hypotheses"))).toBe(true);
});

it("recovers a partial header read on the same SHA and never caches truncated trees", async () => {
  const path = "memory/places/home/index.md", current = "memory/places/home/_current.md";
  const docs = new Map([[path, "---\nopened: '2026-08-01'\n---\nHome\n\n—— 尾部 ——\n2026-09-01：Correction"],
    [current, "---\nas_of: '2026-10-25'\n---\nMoved"]]);
  const { tree } = snapshot(docs);
  const nodes = buildTreeIndex([...docs.keys()]).cases;
  const load = () => ctx.run(() => gitHubCaseActivityDates(tree, nodes, "retry", "owner"));
  fixture.failing = current;
  expect((await Promise.all([load(), load()])).map(table => table?.get(path))).toEqual(["2026-09-01", "2026-09-01"]);
  expect(fixture.reads).toEqual([path, current]);
  await ctx.run(() => ctx.flush());
  fixture.failing = "";
  expect((await load())?.get(path)).toBe("2026-10-25");
  await ctx.run(() => ctx.flush());
  fixture.reads.length = 0;
  expect((await load())?.get(path)).toBe("2026-10-25");
  expect(await gitHubCaseActivityDates({ ...tree, truncated: true }, nodes, "retry", "owner")).toBeUndefined();
  expect(fixture.reads).toHaveLength(0);
});

it("shares the same cold activity catalogue across simultaneous distinct search queries", async () => {
  const docs = new Map(Array.from({ length: 12 }, (_, i) => [
    `memory/events/cold-case-${i}/index.md`,
    `---\nopened: '2026-08-01'\n---\n${i % 2 ? "amber" : "cobalt"} ${i}`,
  ]));
  const { base, indexed } = snapshot(docs);
  const searchBoth = (backend: RecallBackend) => Promise.all(["amber", "cobalt"].map(query => recallSearch(backend, { query })));
  const expected = await searchBoth(base);
  expect(await ctx.run(() => searchBoth(indexed))).toEqual(expected);
  expect(fixture.reads.toSorted()).toEqual([...docs.keys()].sort());
  expect(fixture.peak).toBeLessThanOrEqual(8);
});

it("keeps simultaneous date builds separate across repositories", async () => {
  const path = "memory/events/isolated/index.md";
  const { tree } = snapshot(new Map([[path, "---\nopened: '2026-07-09'\n---\nIndependent domains."]]));
  const nodes = buildTreeIndex([path]).cases;
  const load = (owner: string, repo: string) => gitHubCaseActivityDates(tree, nodes, repo, owner);
  const tables = await ctx.run(() => Promise.all([
    load("owner", "isolate"), load("owner", "isolate"),
    load("other", "isolate"), load("owner", "sibling"),
  ]));
  expect(tables.map(table => table?.get(path))).toEqual(Array(4).fill("2026-07-09"));
  expect(fixture.reads).toEqual(Array(3).fill(path));
});

it("builds a first-time catalogue from already cached immutable blobs", async () => {
  const path = "memory/events/task/index.md";
  const { tree } = snapshot(new Map([[path, "---\nopened: '2026-07-04'\n---\nExample"]]));
  const { readBlobText, getRepoTreeEntry } = await import("@/lib/tools/readFile");
  await ctx.run(() => readBlobText(getRepoTreeEntry(tree, path)!.sha, "prewarmed", "owner"));
  await ctx.run(() => ctx.flush());
  expect(fixture.wire).toBe(1);
  const nodes = buildTreeIndex([path]).cases;
  const result = await ctx.run(() => gitHubCaseActivityDates(tree, nodes, "prewarmed", "owner"));
  expect(result?.get(path)).toBe("2026-07-04");
  expect(fixture.wire).toBe(1);
});
