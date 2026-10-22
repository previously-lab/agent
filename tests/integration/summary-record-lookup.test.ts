import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createNextDataCacheContext } from "../helpers/next-data-cache-context";
import type { SummaryRunPayload } from "@/lib/chat/turn-types";

const fixture = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/github/client", async (original) => ({
  ...(await original<typeof import("@/lib/github/client")>()),
  getOctokit: () => fixture.client,
}));
let locate: typeof import("@/lib/chat/summary-records")["locateSummaryRecords"];
let createClient: typeof import("@/lib/github/client")["createOctokitForTest"];
beforeAll(async () => {
  createNextDataCacheContext();
  ({ locateSummaryRecords: locate } = await import("@/lib/chat/summary-records"));
  ({ createOctokitForTest: createClient } = await import("@/lib/github/client"));
});
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe("summary identity lookup against real Octokit and Next cache", () => {
  it("never scans commit history and only fetches changed core blobs after a head move", async () => {
    let version = 1;
    const requests: string[] = [];
    const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } });
    const transport = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const route = decodeURIComponent(url.pathname);
      requests.push(route);
      if (route === "/repos/fixture/records") return response({ default_branch: "main" });
      if (route.endsWith("/git/ref/heads/main")) return response({ object: { sha: `head-${version}` } });
      if (route.includes("/git/trees/head-")) return response({ tree: [{ path: "memory", type: "tree", sha: `memory-${version}` }] });
      if (route.includes("/git/trees/memory-")) return response({ sha: `memory-${version}`, truncated: false, tree: Array.from({ length: 12 }, (_, n) => ({ path: `records/2026/10/22/${String(n).padStart(4, "0")}/core.md`, type: "blob", sha: `core-${n}-${n === 11 ? version : 1}`, size: 200 })) });
      if (route.includes("/git/blobs/core-")) {
        const n = route.split("core-")[1]!.split("-")[0]!;
        const raw = `---\nslice_id: 2026-10-22-${n.padStart(4, "0")}\nstart: 2026-10-22T08:00:00Z\n---\n\n## Turn member${n} \u2014 2026-10-22T08:00:00Z (user) [message client${n}]\n\nQuestion ${n}\n\n## Turn member${n} \u2014 2026-10-22T08:00:00Z (agent)\n\nAnswer ${n}\n`;
        return response({ content: Buffer.from(raw).toString("base64"), encoding: "base64" });
      }
      console.error(`Unexpected GitHub request: ${route}`);
      throw new Error(`Unexpected GitHub request: ${route}`);
    }) as typeof fetch;
    fixture.client = createClient(transport);
    const payload = { useGithub: true, owner: "fixture", repo: "records", sliceId: "new-slice:2026-10-22", own: { turnId: "member0", userText: "Question 0", replyText: "Answer 0" } } as SummaryRunPayload;
    const context = createNextDataCacheContext();
    await context.run(async () => {
      expect((await locate(payload, [payload.own])).saved.get("member0")?.slice_id).toBe("2026-10-22-0000");
      await context.flush();
      version = 2;
      const second = await locate(payload, [payload.own]);
      await context.flush();
      expect(second.commitSha).toBe("head-2");
      expect(second.saved.get("member0")?.turns).toHaveLength(2);
    });
    expect(requests.filter((route) => route.includes("/git/blobs/"))).toHaveLength(13);
    expect(requests.filter((route) => route.includes("/commits"))).toHaveLength(0);
    expect(requests.filter((route) => route.includes("/git/ref/"))).toHaveLength(2);
  }, 15_000);
});
