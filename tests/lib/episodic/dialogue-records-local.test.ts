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
  it("serves archived native HTML after its child Workflow is gone without inlining it into core", async () => {
    const { projectDialogueRecords } = await import("@/lib/episodic/dialogue-records");
    const { readArchivedDialogueArtifact } = await import("@/lib/episodic/dialogue-artifact-archive");
    const { readSlicePart } = await import("@/lib/episodic/paths");
    const { GET } = await import("@/app/api/chat/dialogue/artifacts/[artifactId]/route");
    const body = "<!doctype html>\r\n<p>Archived interactive HTML</p>\r\n";
    const artifact = {
      artifactId: "c".repeat(64), sourceOwnerId: "wrun_expired", revision: 1 as const,
      sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body),
      kind: "native_html" as const, mediaType: "text/html",
    };
    const utterance: PublicUtterance = {
      utteranceId: "public-native", publicSeq: 2, committedAt: stamp, inputIds: ["u1"], sourceResults: [],
      blocks: [{ kind: "artifact_ref", blockId: "widget", artifact }],
    };
    await projectDialogueRecords({ ...payload(), utterance,
      typedArtifacts: [{ blockId: "widget", artifact, body }] });

    // No Workflow exists in this test: both reads are exclusively from file memory.
    await expect(readArchivedDialogueArtifact(artifact.artifactId)).resolves.toEqual({ artifact, body });
    const response = await GET(new Request(`http://localhost/api/chat/dialogue/artifacts/${artifact.artifactId}?persona=user`),
      { params: Promise.resolve({ artifactId: artifact.artifactId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ artifact, body });
    expect(await readSlicePart("2026-11-06-0300", "core")).not.toContain("Archived interactive HTML");
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
