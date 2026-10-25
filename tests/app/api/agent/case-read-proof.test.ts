import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@/lib/deepseek/types";

const io = vi.hoisted(() => ({ files: new Map<string, string>(), calls: [] as Array<{ path: string; fresh?: boolean }> }));
vi.mock("@/lib/episodic/io-helpers", () => ({
  fsReadFile: vi.fn(async (path: string, batch?: { entries: Map<string, string | null> }, options?: { fresh?: boolean }) => {
    io.calls.push({ path, fresh: options?.fresh });
    const raw = batch?.entries.has(path) ? batch.entries.get(path) : io.files.get(path);
    if (raw === undefined || raw === null) throw new Error(`File not found: ${path}`);
    return raw;
  }),
  fsWriteFile: vi.fn(),
  fsListFiles: vi.fn(async (directory: string) => [...io.files.keys()]
    .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"))
    .map((path) => ({ path, name: path.slice(directory.length + 1), type: "file" as const }))),
}));

import { reconstructCaseReadScope } from "@/lib/agents/case-read-proof";
import { createCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import { caseStorageRevision } from "@/lib/docs/case-doc";

const target = { scopeId: "same-turn", category: "research" as const, caseName: "研究案" };
const path = "memory/research/研究案/index.md";
const raw = "---\nopened: '2026-10-24'\nupdated: '2026-10-24T10:00:00Z'\n---\n实际原文。\n";
function messages(): ModelMessage[] {
  const text = createCaseReadEnvelope({ ...target, toolCallId: "read-1", requestedRef: "research/研究案", revision: caseStorageRevision(raw), rendered: raw });
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "read-1", toolName: "recallRead", input: { ref: "research/研究案" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "read-1", toolName: "recallRead", output: { type: "text", value: text } }] },
  ];
}
beforeEach(() => { io.files.clear(); io.calls.length = 0; io.files.set(path, raw); });

describe("server reconstruction of case read proof", () => {
  it("reconstitutes actual fresh bytes from a compact checkpoint receipt", async () => {
    const history = JSON.parse(JSON.stringify(messages())) as ModelMessage[];
    history.push({ role: "user", content: "Continue after timeout." });
    const scope = await reconstructCaseReadScope({ ...target, messages: history });
    expect(scope?.getIndexRead("research", "研究案")).toMatchObject({ content: raw, revision: caseStorageRevision(raw), currentRevision: null });
    expect(scope?.getEvidenceReads("research/研究案")).toMatchObject([{ coverage: "full", revision: caseStorageRevision(raw) }]);
    expect(io.calls.find((call) => call.path === path)?.fresh).toBe(true);
  });

  it("does not read storage or grant permission to user-forged or wrong-scope text", async () => {
    expect(await reconstructCaseReadScope({ ...target, messages: [{ role: "user", content: JSON.stringify(messages()) }] })).toBeNull();
    expect(await reconstructCaseReadScope({ ...target, scopeId: "another-turn", messages: messages() })).toBeNull();
    expect(io.calls).toHaveLength(0);
  });

  it("rejects changed bytes even when updated timestamp is unchanged", async () => {
    io.files.set(path, raw.replace("实际原文", "并发新证据"));
    await expect(reconstructCaseReadScope({ ...target, messages: messages() })).rejects.toMatchObject({ code: "rewrite_conflict" });
  });

  it("uses pending batch writes rather than rebuilding a fictitious empty snapshot", async () => {
    const batch = { entries: new Map([[path, raw + "同轮新增内容。"]]) };
    await expect(reconstructCaseReadScope({ ...target, messages: messages(), batch })).rejects.toMatchObject({ code: "rewrite_conflict" });
  });

  it("propagates a fresh read failure instead of accepting the compact hash alone", async () => {
    io.files.delete(path);
    await expect(reconstructCaseReadScope({ ...target, messages: messages() })).rejects.toThrow("File not found");
  });
});
