/**
 * 一键停分档 + 面板降级旁注 (v0.40 §2.3/§6) — the pure rules behind the
 * pod's stop menus and the 「看不到 ≠ 没有」 notes: which tiers a row
 * offers, what each tier cancels, which tier confirms, and which note a
 * degraded layer earns.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  burstDisplaySuffix,
  createTerminalDebounce,
  layerDegradationNote,
  reflectionStopTier,
  resolveStopTargets,
  stopTiersFor,
} from "@/lib/chat/hq-panel";
import type { HQStatusResponse, PanelRunRow } from "@/app/api/evolution/hq-status/route";

function row(over: Partial<PanelRunRow> = {}): PanelRunRow {
  return {
    runId: "wrun-1",
    status: "running",
    role: "turn",
    slice: "2026-10-19-1751",
    turn: "a1b2c3",
    burst: null,
    ageMs: 12_000,
    ...over,
  };
}

function response(over: Partial<HQStatusResponse> = {}): HQStatusResponse {
  return {
    asOf: "2026-10-19T18:00:00.000Z",
    reflection: { state: "none" },
    runs: { state: "live", live: [] },
    log: {
      state: "live",
      cursor: null,
      behind: 0,
      recentRounds: [],
    },
    ...over,
  } as HQStatusResponse;
}

describe("stopTiersFor — the 分档 (v0.40 §2.3)", () => {
  it("a TURN row offers 停本轮 (confirm) and 停这一批 when it carries a burst id", () => {
    const tiers = stopTiersFor(row({ burst: "burst-1" }));
    expect(tiers.map((t) => t.tier)).toEqual(["turn", "burst"]);
    expect(tiers.every((t) => t.confirm)).toBe(true);
    expect(tiers[0].labelKey).toBe("hqStopTierTurn");
    expect(tiers[1].labelKey).toBe("hqStopTierBurst");
  });

  it("a burst-less turn row offers only 停本轮", () => {
    expect(stopTiersFor(row()).map((t) => t.tier)).toEqual(["turn"]);
  });

  it("a SUMMARY row offers only 停止归档 — NO confirm (the answers are already delivered)", () => {
    const tiers = stopTiersFor(row({ role: "summary" }));
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({
      tier: "turn",
      labelKey: "hqStopTierSummary",
      confirm: false,
    });
  });

  it("the reflection tier never confirms — the tooltip carries the cost", () => {
    expect(reflectionStopTier()).toMatchObject({
      tier: "reflection",
      labelKey: "hqStopTierReflection",
      confirm: false,
    });
  });
});

describe("resolveStopTargets — 每档的调用目标 (走既有取消路径)", () => {
  it("停本轮 cancels exactly the row's own id", () => {
    expect(resolveStopTargets("turn", row(), [], null)).toEqual(["wrun-1"]);
  });

  it("停这一批 cancels EVERY live row sharing the burst (turns + summaries of the batch)", () => {
    const rows = [
      row({ runId: "wrun-turn-1", burst: "b1" }),
      row({ runId: "wrun-summary-1", role: "summary", burst: "b1" }),
      row({ runId: "wrun-turn-2", burst: "b2" }),
    ];
    expect(resolveStopTargets("burst", rows[0]!, rows, null).sort()).toEqual([
      "wrun-summary-1",
      "wrun-turn-1",
    ]);
  });

  it("停后台反思 targets the reflection run's id; an absent unit yields nothing", () => {
    expect(resolveStopTargets("reflection", row(), [], "wrun-hq")).toEqual(["wrun-hq"]);
    expect(resolveStopTargets("reflection", row(), [], null)).toEqual([]);
  });
});

describe("burstDisplaySuffix — 批次标签只露可读后缀", () => {
  it("a `burst-` prefix is stripped: burst-ab reads ab", () => {
    expect(burstDisplaySuffix("burst-ab")).toBe("ab");
  });

  it("a long id (UUID in production) collapses to its last 4 chars", () => {
    expect(burstDisplaySuffix("3f2a1b9c-7d4e-4a5f-9b1c-2e8a6d4c0f12")).toBe("0f12");
  });

  it("a short prefix-less id passes through whole", () => {
    expect(burstDisplaySuffix("b1")).toBe("b1");
  });
});

describe("layerDegradationNote — 看不到 ≠ 没有 (v0.40 §6)", () => {
  it("a failed READ earns a note naming the read failure", () => {
    expect(
      layerDegradationNote(
        "reflection",
        response({ reflection: { state: "unreachable", reason: "x" } }),
      ),
    ).toBe("hqNoteReflectionUnreachable");
    expect(
      layerDegradationNote("runs", response({ runs: { state: "unavailable", reason: "x" } })),
    ).toBe("hqNoteRunsUnavailable");
    expect(
      layerDegradationNote("log", response({ log: { state: "unavailable", reason: "x" } })),
    ).toBe("hqNoteLogUnavailable");
  });

  it("事实空 earns NO note — 「后台整理没在跑」 is a true verdict, not a missing read", () => {
    expect(layerDegradationNote("reflection", response())).toBeNull();
    expect(layerDegradationNote("reflection", response({
      reflection: {
        state: "live",
        runId: "wrun-hq",
        status: "running",
        startedAt: null,
        ageMs: 1,
        attributes: {},
      },
    }))).toBeNull();
  });

  it("全灭 (the fetch itself failed) → the overall offline note", () => {
    expect(layerDegradationNote("runs", null)).toBe("hqNoteOffline");
    expect(layerDegradationNote("log", null)).toBe("hqNoteOffline");
  });
});

describe("createTerminalDebounce — run terminals collapse into ONE log refresh (v0.11 streams)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("several terminals inside the window trigger the refresh exactly ONCE", () => {
    const trigger = vi.fn();
    const debounced = createTerminalDebounce(trigger, 1_000);
    // a burst's last turn + its summary land together — three terminals…
    debounced();
    vi.advanceTimersByTime(300);
    debounced();
    vi.advanceTimersByTime(300);
    debounced();
    expect(trigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("the window resets on every terminal — the newest one is the one worth reflecting", () => {
    const trigger = vi.fn();
    const debounced = createTerminalDebounce(trigger, 1_000);
    debounced();
    vi.advanceTimersByTime(900);
    debounced(); // resets the clock
    vi.advanceTimersByTime(900);
    expect(trigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("terminals further apart than the window each fire their own refresh", () => {
    const trigger = vi.fn();
    const debounced = createTerminalDebounce(trigger, 1_000);
    debounced();
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    debounced();
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(2);
  });
});
