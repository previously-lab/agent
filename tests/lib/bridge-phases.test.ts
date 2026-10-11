/**
 * bridge-phases — the phase-level housekeeping bridge call.
 *
 * The contract that matters:
 *   - payload assembly: { task, context, phase: "housekeeping", protocol: 2 }
 *     with the closing-slice flag in the task and all dynamic data in context;
 *   - lenient extraction (bare / fenced / prose-wrapped JSON), strict zod
 *     validation;
 *   - NEVER throws — bridge errors / malformed output / schema mismatch all
 *     degrade to { ok: false };
 *   - applyCardMutations routes the wire ops through the card-session
 *     machinery: caps are enforced, rejections land in `skipped` (no throw).
 *
 * The report schema is exactly what the sole caller can feed (jobs 1-3). The
 * retired jobs 4-7 fields (backfill_marks / strand_merges / direction /
 * playbooks) are GONE from the schema — old clients still sending them are
 * tolerated via zod's unknown-key stripping (pinned below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adaptHousekeepingReport,
  applyBridgeCardEvolution,
  applyCardMutations,
  buildHousekeepingPayload,
  degradedAnalysis,
  extractReportJson,
  isPhaseOutsourceActive,
  runHousekeepingBridge,
  type HousekeepingPhaseReport,
} from "@/lib/bridge-phases";
import { runBridge } from "@/lib/bridge";
import {
  readUserModel,
  writeUserModelCard,
} from "@/lib/evolution/store";
import { writePreviously } from "@/lib/episodic";
import {
  newCardTemplate,
  serializeCard,
} from "@/lib/episodic/previously-format";

vi.mock("@/lib/bridge", () => ({
  getBridgeCommand: vi.fn(() => "test bridge-exec"),
  splitBridgeCommand: vi.fn((s: string) => s.split(" ")),
  getBridgeTimeoutMs: vi.fn(() => 10_000),
  runBridge: vi.fn(),
  BRIDGE_PROTOCOL_VERSION: 2,
}));

vi.mock("@/lib/episodic", () => ({
  writePreviously: vi.fn(async () => {}),
}));

// The evolution store is the single-writer boundary under test (the folded
// people/user/index.md card write); readUserModel is mocked to null so the
// snapshot falls back to the mutated card.
vi.mock("@/lib/evolution/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evolution/store")>();
  return {
    ...actual,
    readUserModel: vi.fn(async () => null),
    writeUserModelCard: vi.fn(async () => {}),
  };
});

const runBridgeMock = vi.mocked(runBridge);
const writeCardMock = vi.mocked(writeUserModelCard);
const writeSliceMock = vi.mocked(writePreviously);

const SLICE = "2026-08-22-1015";

const VALID_REPORT: HousekeepingPhaseReport = {
  analysis: {
    intent: "chat",
    memory_worthy: true,
    memory_update: null,
    emotional_signal: { intensity: "light", register: "excited", note: "new job lead" },
  },
  closed_marking: null,
  evolution: {
    worth: true,
    reason: "A durable interview commitment was stated.",
    mutations: [
      { op: "addNow", content: "prepping the friday interview" },
      {
        op: "addHorizon",
        content: "interview on friday",
        by: "2026-08-28",
        refs: [SLICE],
      },
    ],
  },
};

function baseInput() {
  return {
    userMessage: "我周五有个面试",
    recentTurns: [{ role: "user", content: "我周五有个面试" }],
    cardContent: "",
    sliceId: SLICE,
    todayLocal: "2026-08-22",
    locale: "zh",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── payload assembly ────────────────────────────────────────────────────

describe("buildHousekeepingPayload", () => {
  it("puts the closing flag + schema in task and dynamic data in context", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      closingSlice: {
        sliceId: SLICE,
        turns: [{ role: "user", content: "old turn" }],
      },
    });
    expect(task).toContain(`slice ${SLICE} IS closing`);
    expect(task).toContain('"evolution"');
    expect(context).toContain('"我周五有个面试"');
    expect(context).toContain("Closing slice");
    expect(context).toContain("2026-08-22");
  });

  it("marks closed_marking null when no slice is closing", () => {
    const { task, context } = buildHousekeepingPayload(baseInput());
    expect(task).toContain("closed_marking MUST be null");
    expect(context).not.toContain("Closing slice");
    expect(context).toContain("(empty — new card)");
  });

  it("pins the read-only evidence contract in the static task", () => {
    const { task } = buildHousekeepingPayload(baseInput());
    expect(task).toContain("from the data in this payload ALONE");
    expect(task).toContain("readslice / agentlog / card");
    expect(task).toContain("gated off in the housekeeping phase");
  });

  it("carries ONLY the live jobs 1-3 — the retired jobs 4-7 are gone from task and schema (F3, 2026-10-12)", () => {
    const { task, context } = buildHousekeepingPayload({
      ...baseInput(),
      closingSlice: {
        sliceId: SLICE,
        turns: [{ role: "user", content: "old turn" }],
      },
    });
    for (const dead of [
      "backfill_marks",
      "strand_merges",
      "Dry slices needing marks",
      "Strand merge candidates",
      "Direction verdict",
      "SOP evolution",
      "self/ SOPs writable this run",
      '"direction"',
      '"playbooks"',
    ]) {
      expect(task).not.toContain(dead);
      expect(context).not.toContain(dead);
    }
  });
});

// ─── lenient extraction ──────────────────────────────────────────────────

describe("extractReportJson", () => {
  const bare = JSON.stringify(VALID_REPORT);

  it("parses a bare JSON object", () => {
    expect(extractReportJson(bare)).toEqual(VALID_REPORT);
  });

  it("parses a fenced block", () => {
    expect(extractReportJson(`Here is the report:\n\`\`\`json\n${bare}\n\`\`\``)).toEqual(
      VALID_REPORT,
    );
  });

  it("parses prose-wrapped JSON (stray text before and after)", () => {
    expect(
      extractReportJson(`I analyzed the turn. ${bare} Hope that helps!`),
    ).toEqual(VALID_REPORT);
  });

  it("prefers the LAST balanced object", () => {
    const other = JSON.stringify({ unrelated: true });
    expect(extractReportJson(`${other} then ${bare}`)).toEqual(VALID_REPORT);
  });

  it("returns null when nothing parses", () => {
    expect(extractReportJson("no json here at all")).toBeNull();
    expect(extractReportJson("{ not json")).toBeNull();
  });

  it("handles braces and escaped quotes inside JSON strings", () => {
    const tricky = JSON.parse(JSON.stringify(VALID_REPORT));
    tricky.evolution.reason = 'he said "{ \\" \\" }" then } {';
    const raw = JSON.stringify(tricky);
    expect(extractReportJson(raw)).toEqual(tricky);
  });
});

// ─── runHousekeepingBridge: validation + never-throw degradation ─────────

describe("runHousekeepingBridge", () => {
  it("sends the housekeeping phase payload and returns the validated report", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report).toEqual(VALID_REPORT);

    const payload = JSON.parse(runBridgeMock.mock.calls[0][1] as string);
    expect(payload.phase).toBe("housekeeping");
    expect(payload.protocol).toBe(2);
    expect(typeof payload.task).toBe("string");
    expect(typeof payload.context).toBe("string");
  });

  it("accepts a prose-wrapped report", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: `analysis done\n\n${JSON.stringify(VALID_REPORT)}`,
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
  });

  it("tolerates an old client still sending the REMOVED report fields (zod strips unknown keys — never a schema failure)", async () => {
    // Pre-F3 clients answer with backfill_marks / strand_merges / direction /
    // playbooks (and the even older fitness array). All are unknown keys now:
    // stripped, the report stays valid, none of them reach the parsed report.
    const stale = JSON.parse(JSON.stringify(VALID_REPORT));
    stale.backfill_marks = [{ slice_id: SLICE, focus: "f", summary: "s" }];
    stale.strand_merges = [{ from: "a", to: "b" }];
    stale.direction = "no_change";
    stale.playbooks = [{ agent: "search", content: "- quote before answering" }];
    stale.fitness = [{ bucket: "recall", delta: -1, evidence: "x" }];
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(stale),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report).toEqual(VALID_REPORT);
    for (const k of ["backfill_marks", "strand_merges", "direction", "playbooks", "fitness"]) {
      expect(k in res.report).toBe(false);
    }
  });

  it("tolerates an old client still sending the retired semantic_hint (stripped)", async () => {
    const stale = JSON.parse(JSON.stringify(VALID_REPORT));
    stale.analysis.semantic_hint = ["work"];
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(stale),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The retired field parses away — it never reaches the adapted analysis.
    expect(res.report.analysis).not.toHaveProperty("semantic_hint");
  });

  it("tolerates omitted optional mutation fields (refs / by / evidence / resolution)", async () => {
    const sparse = JSON.parse(JSON.stringify(VALID_REPORT));
    sparse.evolution.mutations = [
      { op: "addHorizon", content: "interview on friday" },
      { op: "resolveHorizon", match: "old loop" },
      { op: "addSelfModel", content: "ask before refactoring" },
    ];
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(sparse),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.evolution.mutations).toEqual([
      { op: "addHorizon", content: "interview on friday", by: null, refs: [] },
      { op: "resolveHorizon", match: "old loop", resolution: "" },
      { op: "addSelfModel", content: "ask before refactoring", evidence: [] },
    ]);
  });

  it("prefers the valid report over an earlier fenced EXAMPLE block", async () => {
    // The agent shows a fenced example (parses, but isn't the report) before
    // emitting the real bare-JSON report — extraction must be guided by
    // validation, not by "first fenced block that parses".
    const example = '```json\n{"op": "addNow", "content": "example"}\n```';
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: `One mutation looks like this:\n${example}\n\nMy report:\n${JSON.stringify(VALID_REPORT)}`,
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.report).toEqual(VALID_REPORT);
  });

  it("degrades on a bridge error (never throws)", async () => {
    runBridgeMock.mockResolvedValue({
      status: "error",
      reason: "bridge-not-found",
      error: "Bridge command not found",
      elapsedMs: 1,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("bridge-not-found");
  });

  it("degrades when runBridge itself rejects", async () => {
    runBridgeMock.mockRejectedValue(new Error("spawn blew up"));
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("spawn blew up");
  });

  it("degrades when no JSON object can be extracted", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: "I could not produce a report, sorry.",
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no JSON report");
  });

  it("degrades on a schema mismatch (bad intent value)", async () => {
    const bad = JSON.parse(JSON.stringify(VALID_REPORT));
    bad.analysis.intent = "wizardry";
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(bad),
      elapsedMs: 5,
    });
    const res = await runHousekeepingBridge(baseInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("schema validation");
  });

  it("passes onEvent/onDelta through to runBridge (live activity forwarding)", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    const onEvent = vi.fn();
    const onDelta = vi.fn();
    const res = await runHousekeepingBridge(baseInput(), { onEvent, onDelta });
    expect(res.ok).toBe(true);
    // runBridge(argv, payload, timeoutMs, extraEnv, onEvent, onDelta)
    const call = runBridgeMock.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBe(onEvent);
    expect(call[5]).toBe(onDelta);
  });

  it("omits the live-activity hooks when no opts are given", async () => {
    runBridgeMock.mockResolvedValue({
      status: "ok",
      result: JSON.stringify(VALID_REPORT),
      elapsedMs: 5,
    });
    await runHousekeepingBridge(baseInput());
    const call = runBridgeMock.mock.calls[0];
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
    expect(call[5]).toBeUndefined();
  });
});

// ─── gate ────────────────────────────────────────────────────────────────

describe("isPhaseOutsourceActive", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("keys on the resolved model sdk + kill-switch, regardless of how the engine was activated", () => {
    // Engine activated via config.json only (no PREVIOUSLY_BRAIN env): a turn
    // whose model resolved to sdk "bridge" still gets phase outsourcing —
    // that is what makes engine switching hot (no restart).
    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    delete process.env.PREVIOUSLY_BRAIN;
    delete process.env.PREVIOUSLY_MODE;
    expect(isPhaseOutsourceActive("bridge")).toBe(true);

    process.env.PREVIOUSLY_PHASE_OUTSOURCE = "0";
    expect(isPhaseOutsourceActive("bridge")).toBe(false);
  });

  it("is off for a BYOK model even under a bridge env brain", () => {
    // The env brain is bridge but the user picked a byok/* model (sdk
    // "openai") — housekeeping must run on the standard API sub-agent path,
    // not spawn the CLI.
    process.env.PREVIOUSLY_MODE = "client";
    process.env.PREVIOUSLY_BRAIN = "bridge";
    delete process.env.PREVIOUSLY_PHASE_OUTSOURCE;
    expect(isPhaseOutsourceActive("openai")).toBe(false);
    expect(isPhaseOutsourceActive("deepseek")).toBe(false);
  });
});

// ─── report → TurnAnalysis adaptation ────────────────────────────────────

describe("adaptHousekeepingReport / degradedAnalysis", () => {
  it("maps the wire shape onto TurnAnalysis (null → undefined)", () => {
    const a = adaptHousekeepingReport(VALID_REPORT, false);
    expect(a.semanticHint).toBeUndefined(); // retired with the semantic_hint task
    expect(a.memoryWorthy).toBe(true);
    expect(a.memoryUpdate).toBeUndefined();
    expect(a.closedMarking).toBeUndefined();
  });

  it("carries a validated closed_marking tone when closing", () => {
    const report: HousekeepingPhaseReport = {
      ...VALID_REPORT,
      closed_marking: {
        focus: "interview prep",
        summary: "talked through the friday interview",
        tone: "excitedly positive nonsense", // not a valid tone
      },
    };
    const a = adaptHousekeepingReport(report, true);
    // evolveCard is gone from TurnAnalysis entirely (F2b/F3, 2026-10-12): the
    // bridge path applies report.evolution directly, and the type no longer
    // even has the field — nothing can consume it here.
    expect("evolveCard" in a).toBe(false);
    expect(a.closedMarking?.focus).toBe("interview prep");
    expect(a.closedMarking?.tone).toBeNull(); // invalid tone dropped
  });

  it("degradedAnalysis mirrors the analyzer's failure contract", () => {
    const a = degradedAnalysis();
    expect(a.memoryWorthy).toBe(true);
    expect(a.semanticHint).toBeUndefined();
    expect("evolveCard" in a).toBe(false);
  });
});

// ─── card-mutation application (card-session machinery) ──────────────────

describe("applyCardMutations", () => {
  it("applies valid mutations through the session (refs default to the slice)", () => {
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "addNow", content: "prepping the friday interview" },
      {
        op: "addHorizon",
        content: "interview on friday",
        by: "2026-08-28",
        refs: [],
      },
      { op: "setIdentity", content: "Name: Alan" },
    ]);
    expect(res.changed).toBe(true);
    expect(res.skipped).toEqual([]);
    expect(res.card).toContain("prepping the friday interview");
    expect(res.card).toContain("interview on friday");
    expect(res.card).toContain("Name: Alan");
    // The session normalized the dash-form slice id into a slash-form ref.
    expect(res.card).toContain("2026/08/22/1015");
  });

  it("silently skips rejected mutations (caps / no-match / malformed)", () => {
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "updatePastProfile", content: "x".repeat(10_000) }, // over the cap
      { op: "removeNow", match: "nothing matches this" },
      { op: "addHorizon", content: "no due date", by: null, refs: [] },
      { op: "setIdentity", content: "no label colon here" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.op)).toEqual([
      "updatePastProfile",
      "removeNow",
      "addHorizon",
      "setIdentity",
    ]);
  });

  it("removal ops mutate the existing card", () => {
    const base = serializeCard({
      sliceId: SLICE,
      updated: "2026-08-22T10:00:00.000Z",
      identity: [],
      past: { profile: "", anchors: [] },
      now: [
        { text: "prepping the friday interview", refs: ["2026/08/22/1015"], since: "2026-08-22" },
      ],
      horizon: [],
      selfModel: [],
    });
    const res = applyCardMutations(base, SLICE, "2026-08-22", [
      { op: "promoteNowToPast", match: "friday interview" },
    ]);
    expect(res.changed).toBe(true);
    expect(res.card).not.toContain("since:");
    expect(res.card).toContain("prepping the friday interview");
  });

  it("the legacy Self-model wire ops are SKIPPED with a pointer to the direction Portrait", () => {
    // The zod schema still accepts add/removeSelfModel (legacy tolerance), but
    // the card no longer carries the section — the applier skips them and says
    // where the lesson actually belongs.
    const res = applyCardMutations(newCardTemplate(SLICE), SLICE, "2026-08-22", [
      { op: "addSelfModel", content: "ask before refactoring", evidence: [] },
      { op: "removeSelfModel", match: "stale lesson" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.skipped.map((s) => s.op)).toEqual(["addSelfModel", "removeSelfModel"]);
    expect(res.skipped[0].reason).toContain("no longer carries a Self-model section");
    expect(res.skipped[0].reason).toContain("direction Portrait");
  });
});

// ─── write-back ──────────────────────────────────────────────────────────

describe("applyBridgeCardEvolution", () => {
  it("writes the folded model's card half + the per-slice FULL-model snapshot when substance moved", async () => {
    const res = await applyBridgeCardEvolution({
      card: newCardTemplate(SLICE),
      sliceId: SLICE,
      today: "2026-08-22",
      reason: "A durable interview commitment was stated.",
      mutations: [{ op: "addNow", content: "prepping the friday interview" }],
    });
    expect(res.changed).toBe(true);
    expect(res.summary).toBe("A durable interview commitment was stated.");
    expect(writeCardMock).toHaveBeenCalledOnce();
    expect(writeSliceMock).toHaveBeenCalledWith(SLICE, expect.any(String), undefined);
  });

  it("writes nothing when every mutation was rejected", async () => {
    const res = await applyBridgeCardEvolution({
      card: newCardTemplate(SLICE),
      sliceId: SLICE,
      today: "2026-08-22",
      reason: "tried but rejected",
      mutations: [{ op: "updatePastProfile", content: "x".repeat(10_000) }],
    });
    expect(res.changed).toBe(false);
    expect(res.note).toContain("rejected by validation");
    expect(writeCardMock).not.toHaveBeenCalled();
    expect(writeSliceMock).not.toHaveBeenCalled();
  });
});
