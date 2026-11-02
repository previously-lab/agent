import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { planHistoryArchive, parseHistoryArchive, historyDigest } from "@/lib/docs/history-archive";
import { documentSize, exceededSize } from "@/lib/docs/write-limits";
import { HISTORY_GIT_ATTRIBUTES } from "@/lib/docs/write-validation";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aftrbrez-document-guard-"));
  vi.stubEnv("STORAGE", "local"); vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("MEMORY_ROOT", join(root, "memory"));
  vi.stubEnv("TASKS_ROOT", join(root, "tasks")); vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
  vi.resetModules();
});
afterEach(() => { vi.unstubAllEnvs(); if (root.startsWith(join(tmpdir(), "aftrbrez-document-guard-"))) rmSync(root, { recursive: true, force: true }); });
const target = "memory/things/synthetic/index.md";
const rawIndex = "---\nopened: '2026-01-01'\nupdated: '2026-01-01'\n---\nOriginal source.\n";
function seed(path: string, content: string) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
function disk(path: string) { return readFileSync(join(root, path), "utf8"); }
const archiveInput = { category: "things" as const, caseName: "synthetic", source: "index.md" as const, date: "2026-11-03", updated: "2026-11-03", kind: "source-snapshot" as const };

describe("real local document publication", () => {
  it("rechecks publication state after an already-started fresh read resumes", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const local = await import("@/lib/tools/local-fs");
    const batch = io.createBatch(); await io.fsWriteFile("memory/self/agenda.md", "ready", batch);
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const realRead = local.readFileLocal;
    const spy = vi.spyOn(local, "readFileLocal").mockImplementation(async (...args) => { if (args[0] === target) { entered(); await gate; } return realRead(...args); });
    const late = io.fsWriteFile(target, "late draft", batch);
    const rejected = expect(late).rejects.toThrow("committed");
    await ready; await io.flushBatch(batch, "existing snapshot"); release(); await rejected; spy.mockRestore();
    expect(existsSync(join(root, target))).toBe(false); expect(batch.entries.size).toBe(0);
  });
  it("closes the batch during publication and rejects late writers without losing their requested data silently", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const local = await import("@/lib/tools/local-fs");
    const realCommit = local.commitLocalBatch;
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(local, "commitLocalBatch").mockImplementation(async (...args) => { entered(); await gate; return realCommit(...args); });
    const batch = io.createBatch(); await io.fsWriteFile(target, "captured", batch);
    const committing = io.flushBatch(batch, "captured");
    await ready;
    await expect(io.fsWriteFile("memory/things/later/index.md", "late", batch)).rejects.toThrow("flushing");
    release(); await committing; spy.mockRestore();
    expect(disk(target)).toBe("captured"); expect(batch.state).toBe("committed");
    await expect(io.fsWriteFile(target, "reuse", batch)).rejects.toThrow("committed");
    expect(batch.documentBases?.size).toBe(0);
  });
  it("checks pending final content and rejects a direct Map bypass before any file lands", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const batch = io.createBatch();
    await io.fsWriteFile(target, "x".repeat(11_999), batch);
    await io.fsWriteFile(target, "x".repeat(12_000), batch);
    await expect(io.fsWriteFile(target, "x".repeat(12_001), batch)).rejects.toMatchObject({ code: "document_full" });
    expect(batch.entries.get(target)?.length).toBe(12_000);
    batch.entries.set("memory/things/second/index.md", "😀".repeat(12_001));
    await expect(io.flushBatch(batch, "fixture")).rejects.toMatchObject({ code: "document_full" });
    expect(existsSync(join(root, target))).toBe(false);
    expect(batch.entries.size).toBe(2);
  });
  it("records the read basis before staging and rejects concurrent final publication", async () => {
    seed(target, "base");
    const io = await import("@/lib/episodic/io-helpers");
    const a = io.createBatch(), b = io.createBatch();
    await io.fsReadFile(target, a, { fresh: true });
    await io.fsReadFile(target, b, { fresh: true });
    await io.fsWriteFile(target, "A", a); await io.fsWriteFile(target, "B", b);
    const results = await Promise.allSettled([io.flushBatch(a, "A"), io.flushBatch(b, "B")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(disk(target)).toBe("A");
    expect(b.entries.get(target)).toBe("B");
    const c = io.createBatch(); await io.fsReadFile(target, c, { fresh: true });
    seed(target, "external newer bytes");
    await io.fsWriteFile(target, "stale draft", c);
    await expect(io.flushBatch(c, "C")).rejects.toMatchObject({ code: "rewrite_conflict" });
    expect(disk(target)).toBe("external newer bytes");
  });
  it("allows exact oversize no-op but requires a complete verified archive for shrinking", async () => {
    const old = "源😀\r\n".repeat(3500); seed(target, old);
    const io = await import("@/lib/episodic/io-helpers");
    const local = await import("@/lib/tools/local-fs");
    await expect(local.writeFileLocal(target, old)).resolves.toMatchObject({ created: false });
    await expect(local.writeFileLocal(target, "short")).rejects.toMatchObject({ code: "document_full" });
    const plan = planHistoryArchive({ ...archiveInput, sourceRaw: old });
    const batch = io.createBatch();
    for (const entry of plan.entries) await io.fsWriteFile(entry.path, entry.content, batch);
    batch.maintenance = new Map([[target, { sourceRevision: plan.sourceRevision, archiveHeadRef: plan.headRef }]]);
    await io.fsWriteFile(target, "Short conclusion with an archive link.", batch);
    await io.flushBatch(batch, "maintenance");
    expect(plan.entries.map((entry) => parseHistoryArchive(disk(entry.path))!.payload).join("")).toBe(old);
    expect(disk("memory/.gitattributes")).toContain(HISTORY_GIT_ATTRIBUTES);
  });
  it("rejects encoded aliases, case-colliding pending paths and archive replacement/deletion", async () => {
    const local = await import("@/lib/tools/local-fs");
    for (const path of ["memory%2Fthings%2Fsynthetic%2Findex.md", "memory/things/synthetic/index%2Emd", target + "/"]) await expect(local.writeFileLocal(path, "x".repeat(13_000))).rejects.toThrow("canonical");
    await expect(local.commitLocalBatch([{ path: target, content: "first" }, { path: target.replace("index.md", "INDEX.MD"), content: "second" }])).rejects.toThrow("aliases");
    expect(existsSync(join(root, target))).toBe(false);
    const entry = planHistoryArchive({ ...archiveInput, sourceRaw: "original" }).entries[0];
    await local.writeFileLocal(entry.path, entry.content);
    await expect(local.writeFileLocal(entry.path, entry.content + "changed")).rejects.toThrow("immutable");
    await expect(local.deleteFileLocal(entry.path.replace(/\.md$/, ".MD"))).rejects.toThrow("immutable");
    await expect(local.writeBinaryFileLocal(entry.path, Buffer.from("replacement"))).rejects.toThrow("guarded text");
    expect(disk(entry.path)).toBe(entry.content);
  });
  it("leaves actual records unrestricted by authored budgets but does not exempt a records-named case", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const batch = io.createBatch();
    const record = "memory/records/2026/11/03/1200/core.md";
    await io.fsWriteFile(record, "original dialogue\n".repeat(1000), batch);
    await expect(io.fsWriteFile("memory/things/records/index.md", "x".repeat(12_001), batch)).rejects.toMatchObject({ code: "document_full" });
    await io.flushBatch(batch, "records"); expect(disk(record)).toContain("original dialogue");
  });
  it("keeps archive payload bytes intact through Git filters with autocrlf enabled", async () => {
    const local = await import("@/lib/tools/local-fs");
    const entry = planHistoryArchive({ ...archiveInput, sourceRaw: "original\r\n中😀\nno trailing newline" }).entries[0];
    await local.writeFileLocal(entry.path, entry.content);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const raw = execFileSync("git", ["hash-object", "--no-filters", entry.path], { cwd: root, encoding: "utf8" }).trim();
    const clean = execFileSync("git", ["-c", "core.autocrlf=true", "hash-object", `--path=${entry.path}`, entry.path], { cwd: root, encoding: "utf8" }).trim();
    expect(clean).toBe(raw);
    expect(execFileSync("git", ["check-attr", "text", "--", entry.path], { cwd: root, encoding: "utf8" })).toContain("unset");
    expect(parseHistoryArchive(disk(entry.path))!.payload).toBe("original\r\n中😀\nno trailing newline");
  });
});

describe("writer recovery and shared batches", () => {
  it("merges a case delta without restoring an unrelated non-case writer's old pending bytes", async () => {
    seed(target, rawIndex);
    const io = await import("@/lib/episodic/io-helpers");
    const writer = await import("@/lib/episodic/flash/librarian");
    const mutex = await import("@/lib/episodic/slice-mutex");
    const realLock = mutex.withSliceLock;
    let entered!: () => void, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(mutex, "withSliceLock").mockImplementation((key, fn) => {
      if (key !== "doc:things/synthetic") return realLock(key, fn);
      entered(); return gate.then(() => realLock(key, fn));
    });
    const batch = io.createBatch(); await io.fsWriteFile("memory/self/agenda.md", "old agenda", batch);
    const writing = writer.applyCaseWriteIntent({ action: "appendTail", category: "things", caseName: "synthetic", line: "Case update." }, "2026-11-03", batch);
    await ready;
    await io.fsWriteFile("memory/self/agenda.md", "new agenda", batch);
    release(); await writing; spy.mockRestore();
    expect(batch.entries.get("memory/self/agenda.md")).toBe("new agenda");
    await io.flushBatch(batch, "two writers"); expect(disk("memory/self/agenda.md")).toBe("new agenda");
  });
  it("counts the final dated tail and its newline in the 600-code-point limit", async () => {
    seed(target, rawIndex);
    const io = await import("@/lib/episodic/io-helpers");
    const { applyCaseWriteIntent } = await import("@/lib/episodic/flash/librarian");
    const batch = io.createBatch();
    await applyCaseWriteIntent({ action: "appendTail", category: "things", caseName: "synthetic", line: "x".repeat(588) }, "2026-11-03", batch);
    await expect(applyCaseWriteIntent({ action: "appendTail", category: "things", caseName: "synthetic", line: "y".repeat(589) }, "2026-11-03", batch)).rejects.toMatchObject({ code: "document_full" });
    expect(batch.entries.get(target)).not.toContain("yyy");
  });
  it("recovers the actual oversized user-model path through the dedicated evidence-backed tool helper", async () => {
    const userPath = "memory/people/user/index.md";
    const ownProfile = "memory/people/user/profile.md";
    const card = "# Previously On\n## Identity\n- name: Example\n## Past\nA concise, qualified profile.\n## Now\n## Horizon\n";
    const directionModule = await import("@/lib/evolution/direction-agent");
    const direction = "# Portrait\n" + directionModule.DIRECTION_PORTRAIT_DIMENSIONS.map((dim, i) => `${dim}\n${i === 0 ? "- Prefers concrete answers. — refs: 2026-11-03-1200" : ""}`).join("\n") + "\n# Hypotheses\n";
    const old = card + ("x".repeat(1_800) + "\n").repeat(10) + "\n\n---\n\n" + direction;
    seed(userPath, old); seed(ownProfile, "The user's own description, unchanged.");
    const io = await import("@/lib/episodic/io-helpers");
    const writer = await import("@/lib/episodic/flash/librarian");
    const { reorganizeUserModel } = await import("@/lib/evolution/user-model-maintenance");
    const store = await import("@/lib/evolution/store");
    await expect(store.writeUserModelCard(card + "new fact")).rejects.toMatchObject({ code: "document_full" });
    const scope = writer.createCaseReadScope(), batch = io.createBatch();
    await writer.readCaseIndexForScope({ category: "people", caseName: "user", scope, batch, fresh: true });
    const input = { card, direction, pieces: [{ title: "Prior evidence", body: "Qualified evidence with records/2026-11-03-1200 reference." }], evidence: ["records/2026-11-03-1200"], date: "2026-11-03" };
    await expect(reorganizeUserModel(input, scope, batch)).rejects.toMatchObject({ code: "rewrite_conflict" });
    expect(batch.entries.size).toBe(0);
    scope.recordEvidence("records/2026-11-03-1200");
    await reorganizeUserModel(input, scope, batch);
    // The ordinary evolution writer must be able to resume in the SAME HQ batch.
    await store.writeUserModelCard(card + "\nA same-round observation.", batch);
    const archives = [...batch.entries.keys()].filter((path) => path.includes("-history-v1-"));
    await io.flushBatch(batch, "user model recovery");
    expect(archives.map((path) => parseHistoryArchive(disk(path))!.payload).join("")).toBe(old);
    const recovered = (await store.readUserModel())!;
    expect(recovered.card).toContain("A same-round observation."); expect(recovered.direction).toBe(direction.trim());
    expect(recovered.readingLinks).toContain("Prior evidence"); expect(recovered.readingLinks).toContain("UNREAD");
    expect(recovered.readingLinks).toContain("HISTORICAL USER MODEL");
    expect(disk(ownProfile)).toBe("The user's own description, unchanged.");
    await store.writeUserModelCard(card + "\nA new bounded observation.");
    expect(disk(userPath)).toContain("A new bounded observation.");
    const oldHead = JSON.parse(disk("memory/config/user-model-history.json")).history_head;
    seed(userPath, old + "\nAnother old version.");
    const nextBatch = io.createBatch(), nextScope = writer.createCaseReadScope();
    await writer.readCaseIndexForScope({ category: "people", caseName: "user", scope: nextScope, batch: nextBatch, fresh: true });
    nextScope.recordEvidence("records/2026-11-03-1200");
    await reorganizeUserModel({ ...input, date: "2026-11-04" }, nextScope, nextBatch);
    const second = [...nextBatch.entries].filter(([path]) => path.includes("-history-v1-"));
    expect(parseHistoryArchive(second.at(-1)![1]!)!.metadata.next).toBe(oldHead);
  });
  it("publishes only host-computed, current-version product refs across streams", async () => {
    const io = await import("@/lib/episodic/io-helpers");
    const products = await import("@/lib/episodic/document-products");
    const source = { sliceId: "2026-11-03-1200", turnIds: ["source-turn"] };
    const batch = io.createBatch();
    await io.fsWriteFile(target, "A useful conclusion.", batch);
    await products.stageDocumentProduct(batch, source, target);
    expect(await products.confirmedDocumentProducts([source], batch)).toContain("server-queued");
    expect(await products.confirmedDocumentProducts([source])).not.toContain("things/synthetic/index");
    await io.flushBatch(batch, "product and receipt");
    expect(await products.confirmedDocumentProducts([source])).toContain("committed");
    expect(await products.confirmedDocumentProducts([{ ...source, turnIds: ["unrelated-turn"] }])).not.toContain("things/synthetic/index");
    seed(target, "Changed after the receipt.");
    expect(await products.confirmedDocumentProducts([source])).not.toContain("things/synthetic/index");
  });
  it("keeps both same-batch concurrent supplements and independent case updates", async () => {
    seed(target, rawIndex);
    const io = await import("@/lib/episodic/io-helpers");
    const { applyCaseWriteIntent } = await import("@/lib/episodic/flash/librarian");
    const batch = io.createBatch();
    await Promise.all([
      applyCaseWriteIntent({ action: "appendTail", category: "things", caseName: "synthetic", line: "First conclusion." }, "2026-11-03", batch),
      applyCaseWriteIntent({ action: "open", category: "things", caseName: "other", body: "Independent question." }, "2026-11-03", batch),
      applyCaseWriteIntent({ action: "appendTail", category: "things", caseName: "synthetic", line: "Second conclusion." }, "2026-11-03", batch),
    ]);
    await io.flushBatch(batch, "concurrent pending");
    expect(disk(target)).toContain("First conclusion."); expect(disk(target)).toContain("Second conclusion.");
    expect(disk("memory/things/other/index.md")).toContain("Independent question.");
  });
  it("adds a discoverable piece to a full index, and does not clone identical content under a new title", async () => {
    const old = rawIndex + "x".repeat(13_000); seed(target, old);
    const io = await import("@/lib/episodic/io-helpers");
    const writer = await import("@/lib/episodic/flash/librarian");
    const batch = io.createBatch();
    const added = await writer.applyCaseWriteIntent({ action: "addPiece", category: "things", caseName: "synthetic", title: "Focused answer", body: "A separate conclusion." }, "2026-11-03", batch);
    expect(added.warnings?.join()).toContain("catalog");
    const repeat = await writer.applyCaseWriteIntent({ action: "addPiece", category: "things", caseName: "synthetic", title: "Another title", body: "A separate conclusion." }, "2026-11-04", batch);
    expect(repeat).toMatchObject({ path: added.path, noop: true });
    await io.flushBatch(batch, "continuation"); expect(disk(target)).toBe(old);
    const scope = writer.createCaseReadScope();
    const read = await writer.readCaseIndexForScope({ category: "things", caseName: "synthetic", scope });
    expect(read.pieceInventory).toEqual([added.path]);
  });
  it("rolls legacy current history once, links later revisions, and ignores metadata-only refreshes", async () => {
    seed(target, rawIndex);
    const currentPath = "memory/things/synthetic/_current.md";
    const old = "---\nas_of: 2026-10-01\nevidence: [things/synthetic]\n---\nInitial interpretation.\n\n—— 认识历史 ——\n" + "Old view.\r\n".repeat(1500);
    seed(currentPath, old);
    const io = await import("@/lib/episodic/io-helpers");
    const writer = await import("@/lib/episodic/flash/librarian");
    const docs = await import("@/lib/docs/case-doc");
    async function revise(body: string, date: string) {
      const batch = io.createBatch(), scope = writer.createCaseReadScope();
      await writer.readCaseIndexForScope({ category: "things", caseName: "synthetic", batch, scope, fresh: true });
      await writer.applyCaseWriteIntent({ action: "reviseUnderstanding", category: "things", caseName: "synthetic", body, evidence: ["things/synthetic"] }, date, batch, scope);
      const archives = [...batch.entries.keys()].filter((path) => path.includes("-history-v1-"));
      await io.flushBatch(batch, "current");
      return { archives, current: docs.parseCaseCurrent(disk(currentPath)) };
    }
    const first = await revise("New bounded understanding.", "2026-11-03");
    expect(first.archives.map((path) => parseHistoryArchive(disk(path))!.payload).join("")).toBe(old);
    const second = await revise("Another interpretation with uncertainty.", "2026-11-04");
    const payload = parseHistoryArchive(disk(second.archives[0]))!;
    expect(payload.metadata.kind).toBe("current-revision"); expect(payload.payload).toContain("New bounded understanding.");
    expect(payload.payload).not.toContain("Old view."); expect(payload.metadata.next).toBe(first.current.historyHead);
    expect((await revise(second.current.body, "2026-11-05")).archives).toEqual([]);
    expect(exceededSize(documentSize(disk(currentPath)))).toEqual([]);
    const scope = writer.createCaseReadScope();
    expect((await writer.readCaseIndexForScope({ category: "things", caseName: "synthetic", scope })).pieceInventory).toEqual([]);
    expect(historyDigest(disk(target))).toBe(historyDigest(rawIndex));
  });
});
