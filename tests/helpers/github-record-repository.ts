import { createHash } from "node:crypto";

/** Stateful Git Data API transport. Production Octokit/read/write code stays real. */
export function createGitHubRecordRepository(initial: Record<string, string>) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const requests: Array<{ method: string; path: string }> = [];
  const hash = (value: string) => createHash("sha1").update(value).digest("hex");
  const blob = (raw: string) => { const sha = hash(raw); blobs.set(sha, raw); return sha; };
  const tree = (entries: Map<string, string>) => {
    const sha = hash(JSON.stringify([...entries].sort()));
    trees.set(sha, entries);
    return sha;
  };
  let head = hash("initial");
  commits.set(head, { tree: tree(new Map(Object.entries(initial).map(([p, raw]) => [p, blob(raw)]))), parents: [], message: "Fixture initial" });
  let interference: Record<string, string> | null = null;
  let conflicts = 0;
  const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } });
  const memoryEntries = (treeSha: string) => {
    const entries: Array<{ path: string; type: string; sha: string; size?: number }> = [];
    const directories = new Set<string>();
    for (const [full, sha] of trees.get(treeSha)!) {
      if (!full.startsWith("memory/")) continue;
      const p = full.slice(7);
      const segments = p.split("/");
      for (let n = 1; n < segments.length; n++) directories.add(segments.slice(0, n).join("/"));
      entries.push({ path: p, type: "blob", sha, size: blobs.get(sha)!.length });
    }
    for (const directory of directories) entries.push({ path: directory, type: "tree", sha: hash(`${treeSha}:${directory}`) });
    return entries;
  };
  const move = (files: Record<string, string>, message: string) => {
    const entries = new Map(trees.get(commits.get(head)!.tree)!);
    for (const [p, raw] of Object.entries(files)) entries.set(p, blob(raw));
    const next = hash(`${head}:${message}:${JSON.stringify(files)}`);
    commits.set(next, { tree: tree(entries), parents: [head], message });
    head = next;
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const p = decodeURIComponent(url.pathname).replace(/^\/repos\/fixture\/records/, "");
    requests.push({ method, path: p });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method === "GET" && p === "") return respond({ default_branch: "main" });
    if (method === "GET" && p === "/git/ref/heads/main") return respond({ object: { sha: head } });
    if (method === "GET" && p.startsWith("/git/commits/")) {
      const sha = p.split("/").at(-1)!;
      const commit = commits.get(sha);
      return commit ? respond({ sha, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) }) : respond({ message: "Not Found" }, 404);
    }
    if (method === "GET" && p.startsWith("/git/trees/")) {
      const sha = p.split("/").at(-1)!;
      if (commits.has(sha)) return respond({ sha, tree: [{ path: "memory", type: "tree", sha: `memory-${commits.get(sha)!.tree}` }] });
      if (sha.startsWith("memory-")) return respond({ sha, truncated: false, tree: memoryEntries(sha.slice(7)) });
      return respond({ sha, tree: [{ path: "memory", type: "tree", sha: `memory-${sha}` }] });
    }
    if (method === "GET" && p.startsWith("/git/blobs/")) return respond({ content: Buffer.from(blobs.get(p.split("/").at(-1)!)!).toString("base64"), encoding: "base64" });
    if (method === "GET" && p.startsWith("/contents/")) {
      const ref = url.searchParams.get("ref") ?? head;
      const sha = trees.get(commits.get(ref)?.tree ?? "")?.get(p.slice("/contents/".length));
      return sha ? respond({ sha, type: "file", content: Buffer.from(blobs.get(sha)!).toString("base64"), encoding: "base64" }) : respond({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === "/git/blobs") {
      const raw = body.encoding === "base64" ? Buffer.from(String(body.content), "base64").toString("utf8") : String(body.content);
      return respond({ sha: blob(raw) }, 201);
    }
    if (method === "POST" && p === "/git/trees") {
      const entries = new Map(trees.get(String(body.base_tree))!);
      for (const item of body.tree as Array<{ path: string; sha: string | null }>) {
        if (item.sha === null) entries.delete(item.path); else entries.set(item.path, item.sha);
      }
      return respond({ sha: tree(entries) }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      const sha = hash(JSON.stringify(body));
      commits.set(sha, { tree: String(body.tree), parents: body.parents as string[], message: String(body.message) });
      return respond({ sha }, 201);
    }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      if (interference) { move(interference, "Concurrent writer"); interference = null; }
      const sha = String(body.sha);
      if (!commits.get(sha)!.parents.includes(head)) {
        conflicts++;
        return respond({ message: "Update is not a fast forward" }, 422);
      }
      head = sha;
      return respond({ object: { sha } });
    }
    throw new Error(`Unexpected fixture request: ${method} ${p}`);
  }) as typeof globalThis.fetch;
  return {
    fetch, requests,
    interfereNextRef(files: Record<string, string>) { interference = files; },
    get head() { return head; }, get conflicts() { return conflicts; },
    files() { return Object.fromEntries([...trees.get(commits.get(head)!.tree)!].map(([p, sha]) => [p, blobs.get(sha)!])); },
  };
}
