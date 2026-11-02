import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, rename } from "node:fs/promises";
import { dirname, relative, isAbsolute } from "node:path";
import { IMAGE_ASSET_ID, parseStagedAttachments, type ImageAttachmentSnapshot } from "@/lib/chat/image-attachments";
import { resolveDataSource } from "@/lib/data-source/resolve";
import { getRepoConfig } from "@/lib/capabilities";
import { getMemoryRoot, getSessionsRoot, resolveLocalDataPath } from "@/lib/whitelist";
import { fsReadFile, fsReadBinaryFile, fsWriteFile, fsWriteBinaryFile, fsDeleteFile, fsListFiles } from "@/lib/episodic/io-helpers";
import { getOctokit } from "@/lib/github/client";
import { invalidateReadCache } from "@/lib/tools/readFile";
import { noteRepoHead } from "@/lib/tools/batch-write";
import { sanitizeAttachmentName, readRecordImage } from "./attachments";
import { ImageAttachmentError, inspectImage } from "./image-validation";

export interface VerifiedImageAttachment { snapshot: ImageAttachmentSnapshot; dataBase64: string }
interface Scope { source: "local" | "github"; key: string; persona: "user" }
interface Manifest {
  version: 1; scope: Scope; snapshot: ImageAttachmentSnapshot; sha256: string;
  state: "staged" | "reserved" | "claimed" | "cancelled" | "committed"; claimId?: string;
  reservationId?: string; reservedUntil?: number; createdAt: number; recordRef?: string;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const IMAGE_DRAFT_TTL_MS = 7 * 24 * 60 * 60_000;

/** Non-demo data has one real persona. Never use demo's mutable process-global
 * persona to authorize a request; demo is read-only and cannot create drafts. */
function imageScope(persona?: unknown): Scope {
  const source = resolveDataSource();
  if (source === "demo") throw new ImageAttachmentError("read_only", "Images cannot be uploaded in this read-only data source", 403);
  if (persona !== undefined && persona !== null && persona !== "" && persona !== "user") {
    throw new ImageAttachmentError("invalid_persona", "This data source only supports the user persona", 400);
  }
  const origin = source === "local" ? [getMemoryRoot(), getSessionsRoot()] : getRepoConfig();
  return { source, persona: "user", key: digest(JSON.stringify({ source, origin, persona: "user" })) };
}
function directory(scope: Scope, assetId: string): string {
  if (!IMAGE_ASSET_ID.test(assetId)) throw new ImageAttachmentError("invalid_asset", "Invalid image asset ID");
  return `sessions/attachment-drafts/${scope.key}/${assetId}`;
}
function notFound(error: unknown): boolean {
  return (error as { status?: number; code?: string })?.status === 404
    || (error as { code?: string })?.code === "ENOENT" || /^(File|Directory) not found:/.test(String((error as Error)?.message));
}
function parseManifest(text: string, scope: Scope, assetId: string): Manifest {
  let manifest: Manifest;
  try { manifest = JSON.parse(text); } catch { throw new ImageAttachmentError("asset_corrupt", "Image metadata is damaged", 409); }
  if (manifest?.version !== 1 || manifest.scope?.key !== scope.key || manifest.scope?.source !== scope.source
    || manifest.scope?.persona !== scope.persona || manifest.snapshot?.assetId !== assetId
    || manifest.snapshot.ref !== `drafts/${assetId}` || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !["staged", "reserved", "claimed", "cancelled", "committed"].includes(manifest.state)) {
    throw new ImageAttachmentError("asset_scope", "Image is not available in this data source", 404);
  }
  return manifest;
}
async function readManifest(scope: Scope, assetId: string): Promise<Manifest> {
  try { return parseManifest(await fsReadFile(`${directory(scope, assetId)}.json`, undefined, { fresh: true }), scope, assetId); }
  catch (error) { if (notFound(error)) throw new ImageAttachmentError("asset_missing", "Image upload was not found", 404); throw error; }
}
async function writeManifest(scope: Scope, path: string, manifest: Manifest): Promise<void> {
  if (scope.source === "github") { await fsWriteFile(path, JSON.stringify(manifest)); return; }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const source = resolveLocalDataPath(temporary), target = resolveLocalDataPath(path);
  for (const file of [source, target]) {
    const rel = relative(getSessionsRoot(), file);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Image manifest must stay inside sessions storage");
  }
  try {
    await fsWriteFile(temporary, JSON.stringify(manifest));
    await rename(source, target);
  } catch (error) { await unlink(source).catch(() => {}); throw error; }
}
/** Serialize local transitions across processes, not just promises in one
 * module. A dead writer's lock can be reclaimed; a live writer is never stolen. */
async function withLocalLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = resolveLocalDataPath(`${path}.lock`);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await handle.close(); await unlink(lockPath); handle = undefined; throw error; }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(await readFile(lockPath, "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath); }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath);
      } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
      if (Date.now() >= deadline) throw new ImageAttachmentError("asset_busy", "Image is busy; retry shortly", 409);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await run(); } finally { await handle.close(); await unlink(lockPath); }
}
async function transition(scope: Scope, assetId: string, mutate: (manifest: Manifest) => void): Promise<Manifest> {
  const dir = directory(scope, assetId), path = `${dir}.json`;
  if (scope.source === "local") return withLocalLock(dir, async () => {
    const manifest = await readManifest(scope, assetId);
    mutate(manifest);
    await writeManifest(scope, path, manifest);
    return manifest;
  });
  // The generic write helper re-reads the SHA and then overwrites. This state
  // transition must instead CAS against the exact manifest we validated.
  const { owner, repo } = getRepoConfig();
  const octokit = getOctokit();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
      if (Array.isArray(data) || !("content" in data)) throw new ImageAttachmentError("asset_missing", "Image upload was not found", 404);
      const manifest = parseManifest(Buffer.from(data.content, "base64").toString("utf8"), scope, assetId);
      mutate(manifest);
      const result = await octokit.rest.repos.createOrUpdateFileContents({ owner, repo, path, sha: data.sha,
        message: "Update staged image status", content: Buffer.from(JSON.stringify(manifest)).toString("base64") });
      noteRepoHead(repo, owner, result.data.commit.sha ?? null, result.data.commit.tree?.sha ?? null);
      invalidateReadCache(path, repo, owner);
      return manifest;
    } catch (error) {
      if (error instanceof ImageAttachmentError) throw error;
      if (notFound(error)) throw new ImageAttachmentError("asset_missing", "Image upload was not found", 404);
      if (![409, 422].includes((error as { status?: number }).status ?? 0)) throw error;
    }
  }
  throw new ImageAttachmentError("asset_busy", "Image changed during this request; retry", 409);
}

export async function stageImage(input: { data: Buffer; name: string; persona?: unknown }): Promise<ImageAttachmentSnapshot> {
  const scope = imageScope(input.persona);
  const image = inspectImage(input.data);
  await sweepStagedImages(input.persona);
  // Timestamp prefix makes abandoned partial uploads discoverable without
  // reading every manifest. The remaining 80 random bits are not user paths.
  const assetId = `img_${Date.now().toString(16).padStart(12, "0")}${randomBytes(10).toString("hex")}`;
  const stem = sanitizeAttachmentName(input.name).replace(/\.[^.]*$/, "").slice(0, 160) || "image";
  const snapshot: ImageAttachmentSnapshot = { version: 1, assetId, ref: `drafts/${assetId}`,
    name: `${stem}.${image.extension}`, mediaType: image.mediaType, byteSize: input.data.length, width: image.width, height: image.height };
  const dir = directory(scope, assetId);
  // Publish the manifest last: a partial upload is never a usable asset.
  await fsWriteBinaryFile(`${dir}.bin`, input.data);
  try { await writeManifest(scope, `${dir}.json`, { version: 1, scope, snapshot, sha256: digest(input.data), state: "staged", createdAt: Date.now() }); }
  catch (error) { await fsDeleteFile(`${dir}.bin`).catch(() => {}); throw error; }
  return snapshot;
}
async function verifiedBytes(scope: Scope, manifest: Manifest): Promise<Buffer> {
  if (manifest.state === "cancelled") throw new ImageAttachmentError("asset_cancelled", "Image upload was cancelled", 409);
  if (["staged", "reserved"].includes(manifest.state) && Date.now() - manifest.createdAt > IMAGE_DRAFT_TTL_MS) throw new ImageAttachmentError("asset_expired", "Image upload expired; upload it again", 410);
  const data = manifest.state === "committed" && manifest.recordRef
    ? (await readRecordImage(manifest.recordRef)).data
    : await fsReadBinaryFile(`${directory(scope, manifest.snapshot.assetId)}.bin`);
  const image = inspectImage(data);
  if (digest(data) !== manifest.sha256 || data.length !== manifest.snapshot.byteSize || image.mediaType !== manifest.snapshot.mediaType) {
    throw new ImageAttachmentError("asset_corrupt", "Image upload is incomplete or damaged", 409);
  }
  return data;
}

/** Lazy bounded cleanup, no background service. Accepted images are protected
 * until a records copy exists. Unsent uploads (including interrupted writes)
 * expire after seven days. Empty local directories are avoided by flat files. */
export async function sweepStagedImages(persona?: unknown): Promise<number> {
  const scope = imageScope(persona), root = `sessions/attachment-drafts/${scope.key}`;
  const files = await fsListFiles(root).catch((error) => { if (notFound(error)) return []; throw error; });
  const ids = [...new Set(files.map((entry) => entry.name.replace(/\.(json|bin)$/, "")).filter((id) => IMAGE_ASSET_ID.test(id)))].sort();
  const cursor = await fsReadFile(`${root}/gc-cursor.txt`, undefined, { fresh: true }).catch((error) => { if (notFound(error)) return ""; throw error; });
  const expired = ids.filter((id) => Date.now() - parseInt(id.slice(4, 16), 16) > IMAGE_DRAFT_TTL_MS);
  const candidates = [...expired.filter((id) => id > cursor), ...expired.filter((id) => id <= cursor)].slice(0, 16);
  let cleaned = 0;
  for (const assetId of candidates) {
    try {
      await transition(scope, assetId, (manifest) => {
        if (manifest.state === "claimed" || (manifest.state === "reserved" && (manifest.reservedUntil ?? 0) > Date.now())) throw new ImageAttachmentError("asset_busy", "Accepted image is protected", 409);
        manifest.state = "cancelled";
      });
      await fsDeleteFile(`${directory(scope, assetId)}.bin`);
      await fsDeleteFile(`${directory(scope, assetId)}.json`);
      cleaned++;
    } catch (error) {
      if (error instanceof ImageAttachmentError && error.code === "asset_busy") continue;
      if (error instanceof ImageAttachmentError && error.code === "asset_missing") {
        await fsDeleteFile(`${directory(scope, assetId)}.bin`); cleaned++;
      } else throw error;
    }
  }
  if (candidates.length) await fsWriteFile(`${root}/gc-cursor.txt`, candidates.at(-1)!);
  return cleaned;
}

/** Called only AFTER the records batch succeeds. Preview URLs can now resolve
 * to the immutable records bytes; the staging binary is no longer needed. */
export async function settleStagedImages(snapshots: ImageAttachmentSnapshot[]): Promise<void> {
  const images = snapshots.filter((image) => IMAGE_ASSET_ID.test(image.assetId));
  if (!images.length) return;
  const scope = imageScope();
  for (const image of images) {
    const data = (await readRecordImage(image.ref)).data;
    await transition(scope, image.assetId, (manifest) => {
      if (digest(data) !== manifest.sha256) throw new ImageAttachmentError("asset_corrupt", "Saved image does not match its upload", 409);
      manifest.state = "committed"; manifest.recordRef = image.ref;
      delete manifest.reservationId; delete manifest.reservedUntil;
    });
    await fsDeleteFile(`${directory(scope, image.assetId)}.bin`);
  }
}
export async function readStagedImage(assetId: string, persona?: unknown): Promise<{ data: Buffer; mediaType: string }> {
  const scope = imageScope(persona), manifest = await readManifest(scope, assetId);
  return { data: await verifiedBytes(scope, manifest), mediaType: manifest.snapshot.mediaType };
}
export async function cancelStagedImage(assetId: string, persona?: unknown): Promise<void> {
  const scope = imageScope(persona);
  await transition(scope, assetId, (manifest) => {
    if (["claimed", "committed"].includes(manifest.state) || (manifest.state === "reserved" && (manifest.reservedUntil ?? 0) > Date.now())) throw new ImageAttachmentError("asset_claimed", "Image already belongs to a submitted message", 409);
    manifest.state = "cancelled";
  });
  // Cancellation wins before deleting bytes. A concurrent claim either won
  // first (409 above), or observes the durable cancellation and cannot start.
  await fsDeleteFile(`${directory(scope, assetId)}.bin`).catch((error) => { if (!notFound(error)) throw error; });
}
export interface ImageReservation {
  attachments: VerifiedImageAttachment[];
  confirm(): Promise<void>;
  release(): Promise<void>;
}
export async function reserveStagedImages(value: unknown, clientMessageId: unknown, persona?: unknown): Promise<ImageReservation> {
  let references;
  try { references = parseStagedAttachments(value); } catch (error) { throw new ImageAttachmentError("invalid_attachments", (error as Error).message); }
  if (!references.length) return { attachments: [], confirm: async () => {}, release: async () => {} };
  const scope = imageScope(persona);
  if (typeof clientMessageId !== "string" || !clientMessageId || clientMessageId.length > 256) throw new ImageAttachmentError("message_identity", "A stable message ID is required for images");
  const claimId = digest(clientMessageId), reservationId = randomBytes(16).toString("hex");
  const owned: string[] = [];
  const release = async () => {
    for (const assetId of owned) await transition(scope, assetId, (manifest) => {
      if (manifest.state !== "reserved" || manifest.reservationId !== reservationId) return;
      manifest.state = "staged";
      delete manifest.claimId; delete manifest.reservationId; delete manifest.reservedUntil;
    });
  };
  const available = (manifest: Manifest) => {
    if (manifest.state === "cancelled") throw new ImageAttachmentError("asset_cancelled", "Image upload was cancelled", 409);
    if (manifest.state === "reserved" && (manifest.reservedUntil ?? 0) > Date.now()) throw new ImageAttachmentError("asset_busy", "Image submission is in progress; retry shortly", 409);
    if (["claimed", "committed"].includes(manifest.state) && manifest.claimId !== claimId) throw new ImageAttachmentError("asset_claimed", "Image belongs to another message", 409);
  };
  const verified = await Promise.all(references.map(async (reference) => {
    const manifest = await readManifest(scope, reference.assetId); available(manifest);
    return { snapshot: { ...manifest.snapshot, ordinal: reference.ordinal }, dataBase64: (await verifiedBytes(scope, manifest)).toString("base64") };
  }));
  try {
    for (const reference of references) {
      await transition(scope, reference.assetId, (manifest) => {
        available(manifest);
        if (["claimed", "committed"].includes(manifest.state)) return;
        manifest.state = "reserved"; manifest.claimId = claimId; manifest.reservationId = reservationId;
        manifest.reservedUntil = Date.now() + 15 * 60_000;
      });
      owned.push(reference.assetId);
    }
  } catch (error) { await release().catch((cleanupError) => console.error("[Images] partial reservation rollback needs recovery", cleanupError)); throw error; }
  return { attachments: verified, release, confirm: async () => {
    for (const assetId of owned) await transition(scope, assetId, (manifest) => {
      if (manifest.state !== "reserved" || manifest.reservationId !== reservationId) return;
      manifest.state = "claimed"; delete manifest.reservationId; delete manifest.reservedUntil;
    });
  } };
}
