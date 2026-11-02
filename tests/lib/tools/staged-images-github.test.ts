import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const store = vi.hoisted(() => ({ files: new Map<string, Buffer>(), revisions: new Map<string, number>() }));
vi.mock("@/lib/data-source/resolve", () => ({ resolveDataSource: () => "github" }));
vi.mock("@/lib/capabilities", () => ({ getRepoConfig: () => ({ owner: "fixture-owner", repo: "fixture-repo" }) }));
vi.mock("@/lib/tools/readFile", () => ({ invalidateReadCache: vi.fn() }));
vi.mock("@/lib/tools/batch-write", () => ({ noteRepoHead: vi.fn() }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: async (path: string) => { if (!store.files.has(path)) throw new Error(`File not found: ${path}`); return store.files.get(path)!.toString(); },
  fsReadBinaryFile: async (path: string) => { if (!store.files.has(path)) throw new Error(`File not found: ${path}`); return store.files.get(path)!; },
  fsWriteFile: async (path: string, text: string) => { store.files.set(path, Buffer.from(text)); store.revisions.set(path, (store.revisions.get(path) ?? 0) + 1); },
  fsWriteBinaryFile: async (path: string, bytes: Buffer) => { store.files.set(path, bytes); },
  fsDeleteFile: async (path: string) => { store.files.delete(path); },
  fsListFiles: async (root: string) => [...store.files].filter(([path]) => path.startsWith(`${root}/`)).map(([path, bytes]) => ({ name: path.slice(root.length + 1), path, type: "file", size: bytes.length })),
}));
vi.mock("@/lib/github/client", () => ({ getOctokit: () => ({ rest: { repos: {
  getContent: async ({ path }: { path: string }) => {
    if (!store.files.has(path)) throw Object.assign(new Error("missing"), { status: 404 });
    return { data: { content: store.files.get(path)!.toString("base64"), sha: String(store.revisions.get(path)) } };
  },
  createOrUpdateFileContents: async ({ path, sha, content }: { path: string; sha: string; content: string }) => {
    if (sha !== String(store.revisions.get(path))) throw Object.assign(new Error("CAS conflict"), { status: 409 });
    store.files.set(path, Buffer.from(content, "base64")); store.revisions.set(path, Number(sha) + 1);
    return { data: { commit: { sha: "fixture-commit", tree: { sha: "fixture-tree" } } } };
  },
} } }) }));
import { stageImage, reserveStagedImages, cancelStagedImage, readStagedImage } from "@/lib/tools/staged-images";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
beforeEach(() => { store.files.clear(); store.revisions.clear(); vi.stubGlobal("fetch", () => { throw new Error("No remote APIs in CAS fixture"); }); });
afterEach(() => vi.unstubAllGlobals());
describe("GitHub image manifest compare-and-swap", () => {
  it("simultaneous claimants cannot overwrite the winner's reservation", async () => {
    const image = await stageImage({ data: png, name: "same.png" });
    const attempts = await Promise.allSettled(["one", "two"].map((id) => reserveStagedImages([{ assetId: image.assetId, ordinal: 2 }], id)));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveStagedImages>>>;
    await winner.value.confirm();
    await expect(cancelStagedImage(image.assetId)).rejects.toMatchObject({ code: "asset_claimed" });
    expect((await readStagedImage(image.assetId)).data).toEqual(png);
  });
  it("a released attempt is retryable and old cleanup cannot release the accepted retry", async () => {
    const image = await stageImage({ data: png, name: "retry.png" });
    const refs = [{ assetId: image.assetId, ordinal: 3 }];
    const first = await reserveStagedImages(refs, "first"); await first.release();
    const second = await reserveStagedImages(refs, "second"); await second.confirm(); await first.release();
    const record = [...store.files].find(([path]) => path.endsWith(`${image.assetId}.json`));
    expect(JSON.parse(record![1].toString()).state).toBe("claimed");
    expect((await readStagedImage(image.assetId)).data).toEqual(png);
  });
});
