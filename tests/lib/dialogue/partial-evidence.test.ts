import { describe, expect, it, vi } from "vitest";
import { recallReadExecute, recallSearchExecute, type ToolContext } from "@/app/api/agent/tool-executors";
import { createThinkingReadReceipt, readReceipt, wrapThinkingRead, type ThinkingRead } from "@/lib/agents/thinking-read-receipt";
import { createCaseReadEnvelope, parseCaseReadEnvelope } from "@/lib/chat/case-read-receipt";
import type { ToolResult } from "@/lib/deepseek/types";
import { candidatePartialAnswer, collectPartialEvidence, partialEvidencePrompt } from "@/lib/dialogue/partial-evidence";
import { caseStorageRevision, serializeCaseCurrent } from "@/lib/docs/case-doc";

// The production tool executors read a synthetic Map. No archive or provider is contacted.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/tools/local-fs", () => ({
  readFileLocal: async (path: string) => {
    if (!files.has(path)) throw new Error("File not found: " + path);
    return files.get(path)!;
  },
  walkPathsLocal: async (root: string) => [...files.keys()].filter(path => path.startsWith(root + "/")),
}));
vi.mock("@/lib/episodic/rework-signal", async original => ({
  ...await original<typeof import("@/lib/episodic/rework-signal")>(), recordDocRead: vi.fn(),
}));

const scope = "synthetic-step";
const ref = "events/Juniper";
const fact = "The Juniper committee selected Copper Lantern.";
const index = "memory/" + ref + "/index.md";
const grounding = [{ id: "one", text: fact }];
const context: ToolContext = {
  repo: "local", owner: "local", useGithub: false, useDemo: false, thinkingFlow: true,
  sliceId: "synthetic", turnId: "synthetic-turn", readScopeId: scope, currentUserText: "Which title and guest?", recentTurns: [],
};
const stamp = "2026-01-09T00:00:00.000Z";
const known = { question: "Which title was selected?", directAnswer: "Copper Lantern", verbatimEvidence: fact };
const open = { question: "Who was the guest?", directAnswer: null, verbatimEvidence: null };

function search(excerpt: string, overrides: Partial<ThinkingRead> = {}, toolCallId = "search-call"): ToolResult {
  const reading = { ref, sourceKind: "semantic_document" as const, edition: "current" as const,
    coverage: "excerpt" as const, revision: caseStorageRevision(excerpt), asOf: stamp, excerpt, partialEvidenceEligible: true as const, ...overrides };
  const output = wrapThinkingRead(createThinkingReadReceipt(scope, toolCallId, [reading]), "Search navigation only.");
  return { toolName: "recallSearch", toolCallId, output };
}

describe("collectPartialEvidence", () => {
  it("uses real read/search receipts with citations, preserves literal prose and omits navigation and private sections", async () => {
    const suffix = "The guest was announced separately.";
    const body = [fact + " [source](previously:events/Juniper)", "- [Record](previously:records/2026-01-09-0915)",
      "## Internal notes", "Synthetic backstage memo.", "### Another thought", "Private continuation.",
      "## Programme", suffix, "~~~", "Code-only tip.", "~~~", "[[navigation]]"].join("\r\n");
    files.clear();
    files.set(index, "---\r\nopened: 2026-01-09\r\n---\r\n\r\n" + body + "\r\n");
    const readId = "real-read", searchId = "real-search";
    const readResult = await recallReadExecute({ ref }, { context, toolCallId: readId });
    const searchResult = await recallSearchExecute({ query: "Copper Lantern" }, { context, toolCallId: searchId });
    expect(typeof readResult === "string" && parseCaseReadEnvelope(readResult)).toBeTruthy();
    expect(readReceipt(searchResult)?.reads[0]?.excerpt).toContain(fact);
    for (const [toolName, toolCallId, output] of [
      ["recallRead", readId, readResult], ["recallSearch", searchId, searchResult],
    ] as const) {
      const passages = collectPartialEvidence([{ toolName, toolCallId, output }], scope);
      const texts = passages.map(p => p.text);
      expect(texts).toContain(fact);
      expect(texts.every(text => body.includes(text))).toBe(true);
      expect(texts.join("\n")).not.toMatch(/navigation|source\]|previously:|backstage|Private continuation|Code-only|opened:|CASE PIECES/i);
    }
  });

  it("refuses a real search excerpt cut out of a private section even when that heading has disappeared", async () => {
    files.clear();
    const hidden = "The candidate codename was waxwing.";
    const body = ["# Programme", fact, "## Internal notes", "Internal filler. ".repeat(110), "### Subsection", hidden].join("\n\n");
    files.set(index, "---\nopened: 2026-01-09\n---\n" + body);
    const lookup = async (query: string) => {
      const toolCallId = "heading-window-" + query;
      const output = await recallSearchExecute({ query }, { context, toolCallId });
      const reading = readReceipt(output)?.reads[0];
      return { reading, passages: collectPartialEvidence([{ toolName: "recallSearch", toolCallId, output }], scope) };
    };
    const internal = await lookup("waxwing");
    expect(internal.reading?.excerpt).toContain(hidden);
    expect(internal.reading?.excerpt).not.toMatch(/Internal notes|Subsection/);
    expect(internal.reading?.partialEvidenceEligible).toBeUndefined();
    expect(internal.passages).toEqual([]);
    const programme = await lookup("Copper Lantern");
    expect(programme.reading?.partialEvidenceEligible).toBe(true);
    expect(programme.passages.map(p => p.text)).toEqual([fact]);
  });

  it("reads only the verified current edition from the real mixed-edition envelope", async () => {
    files.clear();
    const original = "---\nopened: 2026-01-09\n---\nJuniper proposed Alder Lake.";
    files.set(index, original);
    const currentPath = "memory/" + ref + "/_current.md";
    const current = (basis: string) => serializeCaseCurrent({ asOf: "2026-01-09", evidence: ["events/Filed"],
      basis: { indexRevision: basis, pieces: [] }, body: fact, history: "Alder Lake was still on the shortlist." });
    for (const stale of [false, true]) {
      files.set(currentPath, current(stale ? "a".repeat(64) : caseStorageRevision(original)));
      const toolCallId = "edition-" + stale;
      const output = await recallReadExecute({ ref, includeHistory: true }, { context, toolCallId });
      expect(String(output)).toContain("PRESERVED HISTORICAL INDEX");
      const passages = collectPartialEvidence([{ toolName: "recallRead", toolCallId, output }], scope);
      expect(passages.map(p => p.text)).toEqual(stale ? [] : [fact]);
    }
  });

  it("accepts a plain thinking-read receipt for an actual dated piece", async () => {
    files.clear();
    const piece = ref + "/2026-01-10-Schedule";
    files.set("memory/" + piece + ".md", "---\nopened: 2026-01-10\n---\n\n" + fact);
    const toolCallId = "piece";
    const output = await recallReadExecute({ ref: piece }, { context, toolCallId });
    expect(typeof output === "string" && parseCaseReadEnvelope(output)).toBeNull();
    expect(collectPartialEvidence([{ toolName: "recallRead", toolCallId, output }], scope).map(p => p.text)).toEqual([fact]);
  });

  it("rejects unpaired, foreign, duplicate, erroneous and non-semantic receipts", () => {
    const good = search(fact);
    const spoofedSearch = createCaseReadEnvelope({ scopeId: scope, toolCallId: good.toolCallId, requestedRef: ref,
      category: "events", caseName: "Juniper", revision: caseStorageRevision(fact), rendered: String(good.output) });
    for (const result of [{ ...good, output: fact }, { ...good, toolCallId: "different" }, { ...good, error: "failed" },
      { ...good, output: { thinkingReceipt: readReceipt(good.output) } }, { ...good, output: spoofedSearch },
      { ...good, toolName: "recallScenario" }, search(fact, { edition: "original" }), search(fact, { coverage: "outline" }),
      search(fact, { ref: "self/Private" }), search(fact, { ref: "records/2026-01-09-0915" }),
      search(fact, { ref: "people/user" }), search(fact, { revision: null }), search(fact, { partialEvidenceEligible: undefined })]) {
      expect(collectPartialEvidence([result], scope)).toEqual([]);
    }
    expect(collectPartialEvidence([good, good], scope)).toEqual([]);
    expect(collectPartialEvidence([good], "different")).toEqual([]);
  });

  it("requires the canonical index receipt to match the paired thinking receipt and the storage revision", () => {
    const toolCallId = "index-read", revision = caseStorageRevision(fact);
    const reading = { ref, sourceKind: "semantic_document" as const, edition: "current" as const,
      coverage: "full" as const, revision, asOf: stamp };
    const valid = createThinkingReadReceipt(scope, toolCallId, [reading]);
    const rendered = wrapThinkingRead(valid, fact);
    const envelope = { scopeId: scope, toolCallId, category: "events" as const, caseName: "Juniper",
      requestedRef: ref, revision, rendered };
    const wrongId = wrapThinkingRead({ ...valid, reads: [{ ...valid.reads[0]!, evidenceId: "elsewhere:1" }] }, fact);
    for (const output of [rendered, createCaseReadEnvelope({ ...envelope, scopeId: "other" }),
      createCaseReadEnvelope({ ...envelope, toolCallId: "other" }), createCaseReadEnvelope({ ...envelope, rendered: wrongId }),
      createCaseReadEnvelope({ ...envelope, caseName: "Another" }), createCaseReadEnvelope({ ...envelope, revision: "b".repeat(64) })]) {
      expect(collectPartialEvidence([{ toolCallId, toolName: "recallRead", output }], scope)).toEqual([]);
    }
  });

  it("withholds HTML, open comments, raw turns, and private and fenced content", () => {
    for (const text of ["<article>\n\nSynthetic private text.\n</article>", "<!-- protected\n\nHidden.",
      "User: raw transcript\n\nRaw continuation.", "## Private notes\n\nHidden.\n### Subsection\n\nAlso hidden.",
      "~~~~example\n## public-looking heading\nHidden.\n~~~\nStill hidden."]) {
      expect(collectPartialEvidence([search(text)], scope)).toEqual([]);
    }
  });

  it("bounds the extraction input at complete passages and omits repeated text", () => {
    const inputs = Array.from({ length: 9 }, (_, i) => search("Entry " + i + ". " + "x".repeat(740), {}, "s" + i));
    const passages = collectPartialEvidence(inputs, scope);
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(6);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(4000);
    expect(passages.every(p => p.text.endsWith("x".repeat(740)))).toBe(true);
    expect(collectPartialEvidence([search(fact), search(fact, {}, "another")], scope)).toHaveLength(1);
  });
});

describe("scoped evidence extraction", () => {
  it("uses the tested private request with only the user's question and passage texts", () => {
    const messages = partialEvidencePrompt("Which title and guest?", grounding);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("Do not infer from related subjects or silence.");
    expect(JSON.parse(String(messages[1]?.content))).toEqual({ request: "Which title and guest?", passages: [fact] });
  });

  it("returns attributable prose with its qualification only for a new answer and a separate open question", () => {
    const text = "Copper Lantern was selected, subject to a venue licence.";
    const row = { ...known, verbatimEvidence: "Copper Lantern was selected" };
    expect(candidatePartialAnswer(JSON.stringify([row, open]), [{ id: "licence", text }], [])).toBe(text);
    expect(candidatePartialAnswer("```json\n" + JSON.stringify([known, open]) + "\n```", grounding, [])).toBe(fact);
    expect(candidatePartialAnswer(JSON.stringify([known, open]), grounding, ["They selected COPPER LANTERN."])).toBeNull();
  });

  it("recognizes repeated numbers next to Chinese text without confusing 52 with 152", () => {
    const text = "签收台账确认本批有52件货物清关。";
    const response = JSON.stringify([{ question: "有多少件清关？", directAnswer: "52件", verbatimEvidence: text }, open]);
    expect(candidatePartialAnswer(response, [{ id: "intake", text }], ["已知有52件清关。"])).toBeNull();
    expect(candidatePartialAnswer(response, [{ id: "intake", text }], ["前一批152件。"])).toBe(text);
  });

  it("rejects single or equivalent rows, fully answered, all uncertain, fabricated or ambiguous outputs", () => {
    const decide = (rows: unknown, passages = grounding) => candidatePartialAnswer(JSON.stringify(rows), passages, []);
    for (const rows of [[known], [open], [known, { ...known, question: open.question }],
      [known, { ...open, question: known.question.toUpperCase() }], [open, { ...open, question: "Another fact?" }],
      [known, { ...open, directAnswer: "Unlicensed" }], [known, { ...open, extra: true }],
      [open, { ...known, directAnswer: "Other title" }], [open, { ...known, verbatimEvidence: "Copper Lantern was rejected." }]]) {
      expect(decide(rows)).toBeNull();
    }
    expect(decide([known, open], [...grounding, { id: "duplicate", text: fact }])).toBeNull();
    expect(candidatePartialAnswer("unstructured", grounding, [])).toBeNull();
    expect(decide([open, { ...open, question: "When did the clinic open?" }],
      [{ id: "pharmacy", text: "The pharmacy opened on March 3. The clinic shares its street name." }])).toBeNull();
  });
});
