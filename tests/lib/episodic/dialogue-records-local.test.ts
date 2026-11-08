import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DialogueInput, PublicUtterance } from "@/lib/chat/dialogue-contract";
import type { DialogueResult } from "@/lib/dialogue/types";
import { createHash } from "node:crypto";
import { legacySlicePartPath, slicePartPath } from "@/lib/episodic/paths";

vi.mock("@/lib/tools/staged-images", () => ({ settleStagedImages: vi.fn(async () => undefined) }));

let root: string;
let memoryRoot: string;
const stamp = "2026-11-06T03:00:00.000Z";
const accepted: DialogueInput = { inputId: "u1", clientMessageId: "message-one", userSeq: 1, eventSeq: 1,
  acceptedAt: stamp, text: "Keep my original words." };

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "aftrbrez-dialogue-plain-"));
  memoryRoot = join(root, "memory");
  for (const directory of [memoryRoot, join(root, "tasks"), join(root, "sessions"), join(root, "home")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  vi.stubEnv("STORAGE", "local");
  vi.stubEnv("PREVIOUSLY_MODE", "cloud");
  vi.stubEnv("MEMORY_ROOT", memoryRoot);
  vi.stubEnv("TASKS_ROOT", join(root, "tasks"));
  vi.stubEnv("SESSIONS_ROOT", join(root, "sessions"));
  vi.stubEnv("PREVIOUSLY_HOME", join(root, "home"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network denied for plain-directory dialogue fixture"); }));
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const target = fs.realpathSync(root);
  if (dirname(target) !== fs.realpathSync(tmpdir()) || !basename(target).startsWith("aftrbrez-dialogue-plain-")) {
    throw new Error("Refusing to remove a non-fixture root");
  }
  fs.rmSync(target, { recursive: true, force: true });
});

function payload() {
  return { useGithub: false, owner: "fixture", repo: "fixture", timezone: "UTC",
    inputs: [{ input: accepted, turnId: "u1", sliceId: "2026-11-06-0300" }] };
}

describe("dialogue records on a plain local directory", () => {
  it("stores exact native HTML in the original core reply without new sidecars or legacy migration", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const { readArchivedDialogueArtifact } = await import("@/lib/episodic/dialogue-artifact-archive");
    const { readSlicePart } = await import("@/lib/episodic/paths");
    const { createSlice, loadSlice, serializeSlice } = await import("@/lib/episodic/manager");
    const body = "<!doctype html>\r\n<p>Inline interactive HTML</p>\r\n<pre>```</pre>\r\n";
    const artifact = {
      artifactId: "c".repeat(64), sourceOwnerId: "wrun_expired", revision: 1 as const,
      sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
      kind: "native_html" as const, mediaType: "text/html",
    };
    const utterance: PublicUtterance = {
      utteranceId: "public-native", publicSeq: 2, committedAt: stamp, inputIds: ["u1"], sourceResults: [],
      blocks: [{ kind: "markdown", blockId: "lead", text: "Here is the original reply." },
        { kind: "artifact_ref", blockId: "widget", artifact }],
    };

    const legacyBody = "<p>Legacy archived HTML</p>\n";
    const legacyArtifact = {
      artifactId: "d".repeat(64), sourceOwnerId: "wrun_legacyArchive", revision: 1 as const,
      sha256: createHash("sha256").update(legacyBody).digest("hex"), byteSize: Buffer.byteLength(legacyBody),
      kind: "native_html" as const, mediaType: "text/html",
    };
    const legacy = createSlice("Old input", "UTC", "old-input");
    legacy.slice_id = "2026-11-05-0300";
    legacy.start = stamp;
    legacy.turns.push({ role: "agent", turnId: "legacy-public", timestamp: stamp, content: "Legacy reply.",
      dialogue: { kind: "public_utterance", publicationId: "legacy-public", publicSeq: 1, inputIds: ["old-input"],
        sourceResults: [], blocks: [{ kind: "artifact_ref", blockId: "legacy-widget", artifact: legacyArtifact }] } });
    const legacyPath = join(memoryRoot, slicePartPath(legacy.slice_id, "core").replace(/^memory\//, ""));
    fs.mkdirSync(dirname(legacyPath), { recursive: true });
    const legacyRaw = serializeSlice(legacy);
    fs.writeFileSync(legacyPath, legacyRaw, "utf8");
    const archiveRoot = join(memoryRoot, "dialogue-artifacts");
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(join(archiveRoot, `${legacyArtifact.artifactId}.json`), JSON.stringify(legacyArtifact), "utf8");
    fs.writeFileSync(join(archiveRoot, legacyArtifact.artifactId), legacyBody, "utf8");

    await projectDialogueRecords({ ...payload(), utterance,
      typedArtifacts: [{ blockId: "widget", artifact, body }] });

    const core = await readSlicePart("2026-11-06-0300", "core");
    expect(core).toContain("Here is the original reply.");
    expect(core).toContain(body);
    expect(core).toContain(`html live record-artifact=${artifact.artifactId} record-block=widget`);
    expect(core).not.toContain(legacyBody);
    expect(core.split(/\r?\n/).find((line) => line.startsWith("## Turn p"))).not.toContain("<!doctype html>");
    const turn = (await loadSlice("2026-11-06-0300"))?.turns.at(-1);
    expect(turn?.content).toBe("Here is the original reply.");
    expect(turn?.recordBody).toContain(body);
    expect(turn?.artifactBodies).toEqual({ [artifact.artifactId]: body });
    expect(turn?.dialogue).toMatchObject({ kind: "public_utterance", publicationId: "public-native", blocks: utterance.blocks });
    expect(fs.readdirSync(archiveRoot).sort()).toEqual([legacyArtifact.artifactId, `${legacyArtifact.artifactId}.json`].sort());
    await expect(readArchivedDialogueArtifact(legacyArtifact.artifactId)).resolves.toEqual({ artifact: legacyArtifact, body: legacyBody });
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyRaw);
  });

  it("replays inline records byte-identically and rejects a tampered source without repairing it", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const { readSlicePart } = await import("@/lib/episodic/paths");
    const body = "<p>Replay HTML</p>\n";
    const artifact = {
      artifactId: "e".repeat(64), sourceOwnerId: "wrun_replay", revision: 1 as const,
      sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
      kind: "native_html" as const, mediaType: "text/html",
    };
    const utterance: PublicUtterance = { utteranceId: "public-replay", publicSeq: 1, committedAt: stamp,
      inputIds: ["u1"], sourceResults: [], blocks: [{ kind: "artifact_ref", blockId: "widget", artifact }] };
    const projection = { ...payload(), utterance, typedArtifacts: [{ blockId: "widget", artifact, body }] };
    await projectDialogueRecords(projection);
    const original = await readSlicePart("2026-11-06-0300", "core");
    await projectDialogueRecords(projection);
    expect(await readSlicePart("2026-11-06-0300", "core")).toBe(original);

    const corePath = join(memoryRoot, slicePartPath("2026-11-06-0300", "core").replace(/^memory\//, ""));
    const tampered = original.replace(body, "<p>Tampered HTML</p>\n");
    expect(tampered).not.toBe(original);
    fs.writeFileSync(corePath, tampered, "utf8");
    await expect(projectDialogueRecords(projection)).rejects.toThrow(/publication|record|source/i);
    expect(fs.readFileSync(corePath, "utf8")).toBe(tampered);
    expect(fs.existsSync(join(memoryRoot, "dialogue-artifacts"))).toBe(false);
  });

  it("accepts verified legacy replays without migrating their inline storage", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const { createSlice, serializeSlice } = await import("@/lib/episodic/manager");
    const cases = [
      { sourceOwnerId: "wrun_legacyReplay", artifactId: "f".repeat(64), sidecar: true },
      { sourceOwnerId: "scoped-v1-owner", artifactId: "a".repeat(64), sidecar: false },
    ];
    for (const [index, fixture] of cases.entries()) {
      const body = `<p>Legacy replay ${index}</p>\n`;
      const artifact = {
        artifactId: fixture.artifactId, sourceOwnerId: fixture.sourceOwnerId, revision: 1 as const,
        sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
        kind: "native_html" as const, mediaType: "text/html",
      };
      const utterance: PublicUtterance = { utteranceId: `legacy-replay-${index}`, publicSeq: 1, committedAt: stamp,
        inputIds: ["u1"], sourceResults: [], blocks: [{ kind: "artifact_ref", blockId: "widget", artifact }] };
      const legacy = createSlice(accepted.text, "UTC", "u1");
      legacy.slice_id = "2026-11-06-0300";
      legacy.start = stamp;
      legacy.turns[0]!.timestamp = stamp;
      legacy.turns[0]!.dialogue = { kind: "user_input", inputId: "u1", userSeq: 1 };
      legacy.turns.push({ role: "agent", turnId: `legacy-replay-${index}`, timestamp: stamp, content: "",
        dialogue: { kind: "public_utterance", publicationId: utterance.utteranceId, publicSeq: 1,
          inputIds: ["u1"], sourceResults: [], blocks: utterance.blocks } });
      const corePath = join(memoryRoot, slicePartPath(legacy.slice_id, "core").replace(/^memory\//, ""));
      fs.mkdirSync(dirname(corePath), { recursive: true });
      const original = serializeSlice(legacy);
      fs.writeFileSync(corePath, original, "utf8");
      const projection = { ...payload(), utterance, typedArtifacts: [{ blockId: "widget", artifact, body }] };
      if (fixture.sidecar) {
        await expect(projectDialogueRecords(projection)).rejects.toThrow(/archive|publication|source|record/i);
        expect(fs.readFileSync(corePath, "utf8")).toBe(original);
        const archiveRoot = join(memoryRoot, "dialogue-artifacts");
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.writeFileSync(join(archiveRoot, `${artifact.artifactId}.json`), JSON.stringify(artifact), "utf8");
        fs.writeFileSync(join(archiveRoot, artifact.artifactId), body, "utf8");
      }
      await projectDialogueRecords(projection);
      expect(fs.readFileSync(corePath, "utf8")).toBe(original);
      expect(original).not.toContain(body);
    }
  });
  it("T07/T09/T15: restores accepted input and separates internal results from actual public speech without Git", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const { loadSlice } = await import("@/lib/episodic/manager");
    const { readSlicePart } = await import("@/lib/episodic/paths");
    const { buildThinkingProduct } = await import("@/lib/agents/thinking-product");
    const { dialogueResearchMaterialId, readDialogueResearchRecords } = await import("@/lib/episodic/dialogue-record");

    const first = await projectDialogueRecords(payload());
    expect(first).toMatchObject({ sliceId: "2026-11-06-0300", inputIds: ["u1"], reflection: [], commitSha: null });
    expect((await projectDialogueRecords(payload()))?.inputIds).toEqual(["u1"]);
    expect((await loadSlice(first!.sliceId))?.turns.map((turn) => turn.role)).toEqual(["user"]);

    const product = buildThinkingProduct({ text: "Internal private conclusion.", messages: [], asOf: stamp,
      inputScope: { scopeKey: "fixture", workId: "u1", inputIds: ["u1"], inputText: accepted.text, readScopeId: "u1" } });
    const result: DialogueResult = { resultId: "result-u1", productRevision: 1, workId: "u1", inputIds: ["u1"],
      producerRunId: "mock-run", sliceId: first!.sliceId, availableAt: stamp, product, claims: [], blocks: [] };
    const materialId = dialogueResearchMaterialId({ sourceTurnId: "u1", resultId: result.resultId, productRevision: 1 });
    expect((await projectDialogueRecords({ ...payload(), result }))?.reflection).toEqual([{ sliceId: first!.sliceId, turnIds: [materialId] }]);
    expect((await loadSlice(first!.sliceId))?.turns.map((turn) => turn.role)).toEqual(["user"]);

    const utterance: PublicUtterance = { utteranceId: "public-1", publicSeq: 1, committedAt: stamp,
      inputIds: ["u1"], sourceResults: [{ resultId: result.resultId, productRevision: 1, claimIds: ["claim-1"] }],
      blocks: [{ kind: "markdown", blockId: "text-1", text: "Short public reply." }] };
    for (const item of [utterance, utterance]) {
      expect((await projectDialogueRecords({ ...payload(), utterance: item }))?.reflection).toEqual([]);
    }
    await projectDialogueRecords({ ...payload(), result });
    const slice = await loadSlice(first!.sliceId);
    expect(slice?.turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(slice?.turns[0]).toMatchObject({ content: accepted.text, dialogue: { kind: "user_input", inputId: "u1" } });
    expect(slice?.turns[1]).toMatchObject({ content: "Short public reply.",
      dialogue: { kind: "public_utterance", publicationId: "public-1", publicSeq: 1 } });
    const agent = await readSlicePart(first!.sliceId, "agent");
    expect(readDialogueResearchRecords(agent)).toMatchObject([{ kind: "research_result", resultId: "result-u1", productRevision: 1 }]);
    expect(agent).not.toContain("Internal private conclusion.");
    expect(await readSlicePart(first!.sliceId, "core")).not.toContain("Internal private conclusion.");
    expect(fs.existsSync(join(memoryRoot, ".git"))).toBe(false);
  });

  it("T15/T24: recovers a legacy input by identity and writes only the new records root", async () => {
    const { createSlice, serializeSlice, loadSlice } = await import("@/lib/episodic/manager");
    const legacyId = "2026-11-06-0300";
    const legacy = createSlice(accepted.text, "UTC", "u1");
    legacy.slice_id = legacyId;
    legacy.start = stamp;
    legacy.turns[0]!.timestamp = stamp;
    const legacyPath = legacySlicePartPath(legacyId, "core");
    const absoluteLegacy = join(memoryRoot, legacyPath.replace(/^memory\//, ""));
    fs.mkdirSync(dirname(absoluteLegacy), { recursive: true });
    const raw = serializeSlice(legacy);
    fs.writeFileSync(absoluteLegacy, raw, "utf8");

    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const first = await projectDialogueRecords(payload());
    const replay = await projectDialogueRecords(payload());
    expect(first?.inputLandings).toEqual([{ inputId: "u1", turnId: "u1", sliceId: legacyId }]);
    expect(replay?.inputLandings).toEqual(first?.inputLandings);
    expect(fs.readFileSync(absoluteLegacy, "utf8")).toBe(raw);
    const currentPath = join(memoryRoot, slicePartPath(legacyId, "core").replace(/^memory\//, ""));
    expect(fs.existsSync(currentPath)).toBe(true);
    expect((await loadSlice(legacyId))?.turns[0]?.dialogue).toMatchObject({ kind: "user_input", inputId: "u1", userSeq: 1 });
    expect(fs.existsSync(join(memoryRoot, ".git"))).toBe(false);
  });
});
