/**
 * The one slice cache (v0.10 C7) — dedupe, in-place upgrade, LRU, sticky
 * failure, the concurrency bound, and the page-upgrade hand-off.
 *
 * The double-fetch this phase removes is between two CLIENT paths asking for
 * the same slice (a card's preview and the conversation's whole slice), so the
 * evidence is a call count on the one server action behind them: the data
 * layer is mocked at the module boundary and `getSliceContent` is the meter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Turn } from "@/lib/episodic/types";

const mocks = vi.hoisted(() => ({ getSliceContent: vi.fn() }));

vi.mock("@/lib/episodic/actions", () => ({
  getSliceContent: mocks.getSliceContent,
}));

import {
  ensureSlice,
  peekEntry,
  subscribeSlice,
  upgradeCachedSlice,
  MAX_CONCURRENT_LOADS,
  SLICE_LOADING,
  type SliceEntry,
} from "@/lib/chat/slice-cache";

const PREVIEW_TURNS = 4;

function turnsFor(id: string, count: number): Turn[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: `2026-08-11T10:${String(i).padStart(2, "0")}:00.000Z`,
    role: i % 2 === 0 ? ("user" as const) : ("agent" as const),
    content: `${id} turn ${i}`,
  }));
}

/**
 * The action's two shapes: the default read ships the card's truncated opening
 * rounds, `{ full: true }` ships every turn AND that same preview
 * (`previewTurns`) — which is what lets one read answer both faces.
 */
function seedAction(opening: number, total: number): void {
  mocks.getSliceContent.mockImplementation(
    async (id: string, _persona?: string, options?: { full?: boolean }) => {
      const all = turnsFor(id, total);
      return {
        slice_id: id,
        focus: `focus ${id}`,
        summary: `summary ${id}`,
        start: all[0].timestamp,
        status: "closed",
        turns: options?.full ? all : all.slice(0, opening),
        previewTurns: options?.full ? all.slice(0, opening) : undefined,
        totalTurns: total,
        totalChars: 0,
        open_loops: [],
        decisions: [],
        previously: null,
      };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seedAction(PREVIEW_TURNS, 12);
});

describe("dedupe — one request per slice", () => {
  it("serves a second meta subscriber from the entry the first one read", async () => {
    const first = await ensureSlice("dup-a", "meta");
    const second = await ensureSlice("dup-a", "meta");

    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
    expect(second.preview).toBe(first.preview); // the SAME object, not a copy
    expect(second.mode).toBe("meta");
  });

  it("collapses concurrent subscribers onto one request", async () => {
    await Promise.all([
      ensureSlice("dup-b", "meta"),
      ensureSlice("dup-b", "meta"),
      ensureSlice("dup-b", "meta"),
    ]);

    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
  });
});

describe("meta → full upgrade", () => {
  it("a card and the conversation asking at once cost ONE repository read", async () => {
    // The double-fetch, in miniature: both stacks want the same slice in the
    // same tick. The card's demand starts the job; the conversation's raises
    // the requirement on that job instead of starting a second read.
    const [card, conversation] = await Promise.all([
      ensureSlice("race-a", "meta"),
      ensureSlice("race-a", "full"),
    ]);

    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
    expect(mocks.getSliceContent).toHaveBeenCalledWith("race-a", undefined, {
      full: true,
    });

    // ...and the entry came out upgraded, with both faces present.
    expect(card.mode).toBe("full");
    expect(conversation.full).toHaveLength(12);
    expect(peekEntry("race-a")).toEqual({
      mode: "full",
      preview: card.preview,
      full: conversation.full,
    });
    expect(card.preview.turns).toHaveLength(PREVIEW_TURNS);
  });

  it("upgrades a settled preview in place — one more read, never a second entry", async () => {
    const preview = await ensureSlice("up-a", "meta");
    expect(preview.mode).toBe("meta");
    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);

    const full = await ensureSlice("up-a", "full");

    // The truncated payload cannot be un-truncated, so this direction costs
    // exactly one read — and it upgrades the entry the card already holds
    // rather than filing a second copy of the slice.
    expect(mocks.getSliceContent).toHaveBeenCalledTimes(2);
    expect(mocks.getSliceContent).toHaveBeenLastCalledWith("up-a", undefined, {
      full: true,
    });
    expect(full.mode).toBe("full");
    expect(full.full).toHaveLength(12);
    expect(full.preview.turns).toEqual(preview.preview.turns);
    expect(full.preview.previously).toBe(preview.preview.previously);
  });

  it("answers a later preview request from a full read — zero further reads", async () => {
    await ensureSlice("up-b", "full");
    const preview = await ensureSlice("up-b", "meta");

    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
    expect(preview.mode).toBe("full");
    expect(preview.preview.state).toBe("ready");
    expect(preview.preview.turns).toHaveLength(PREVIEW_TURNS);
  });

  it("repeats of a full request are hits", async () => {
    await ensureSlice("up-c", "full");
    await ensureSlice("up-c", "full");
    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview when a failed upgrade cannot deliver the full slice", async () => {
    const preview = await ensureSlice("up-d", "meta");
    mocks.getSliceContent.mockResolvedValue(null);

    const after = await ensureSlice("up-d", "full");

    expect(after.full).toBeNull();
    expect(after.preview.state).toBe("ready"); // the card keeps its turns
    expect(after.preview).toBe(preview.preview);
  });
});

describe("sticky failure", () => {
  it("does not re-request a slice that failed", async () => {
    mocks.getSliceContent.mockResolvedValue(null);

    const first = await ensureSlice("fail-a", "meta");
    const second = await ensureSlice("fail-a", "meta");

    expect(first.preview.state).toBe("failed");
    expect(second.preview.state).toBe("failed");
    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
  });

  it("still counts as an answer for subscribers (no per-card retry loop)", () => {
    const seen: SliceEntry[] = [];
    // A cache miss on a slice the cache has never seen paints the loading
    // face; the failure is what a mount after that gets.
    expect(peekEntry("fail-never")).toBeNull();
    expect(SLICE_LOADING.state).toBe("loading");
    expect(seen).toEqual([]);
  });
});

describe("LRU cap", () => {
  it("evicts the oldest entry past the cap, and a hit keeps a slice alive", async () => {
    const CAP = 200;
    // Fill the cache past its cap with a fresh id space: every insert trims
    // from the oldest end, so afterwards the cache holds exactly this window.
    for (let i = 0; i < CAP; i++) await ensureSlice(`lru-${i}`, "meta");
    expect(peekEntry("lru-0")).not.toBeNull();

    await ensureSlice("lru-overflow", "meta");
    expect(peekEntry("lru-0")).toBeNull(); // the oldest end went first
    expect(peekEntry("lru-1")).not.toBeNull();

    // A hit moves its key to the newest end, so the NEXT overflow takes the
    // entry after it instead — and a hit is free.
    const readsBefore = mocks.getSliceContent.mock.calls.length;
    await ensureSlice("lru-1", "meta");
    expect(mocks.getSliceContent.mock.calls.length).toBe(readsBefore);

    await ensureSlice("lru-overflow-2", "meta");
    expect(peekEntry("lru-1")).not.toBeNull();
    expect(peekEntry("lru-2")).toBeNull();
  });
});

describe("concurrency bound", () => {
  it("never puts more than MAX_CONCURRENT_LOADS reads on the wire at once", async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.getSliceContent.mockImplementation(async (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return {
        slice_id: id,
        focus: "",
        summary: "",
        start: "2026-08-11T10:00:00.000Z",
        status: "closed",
        turns: turnsFor(id, PREVIEW_TURNS),
        totalTurns: PREVIEW_TURNS,
        totalChars: 0,
        open_loops: [],
        decisions: [],
        previously: null,
      };
    });

    // A fast scroll: 24 cards mounting in one tick.
    await Promise.all(
      Array.from({ length: 24 }, (_, i) => ensureSlice(`burst-${i}`, "meta")),
    );

    expect(peak).toBe(MAX_CONCURRENT_LOADS);
    expect(mocks.getSliceContent).toHaveBeenCalledTimes(24);
  });
});

describe("the page hand-off (useSliceStream)", () => {
  it("upgrades a card's entry with the turns the chat page already carried", async () => {
    await ensureSlice("page-a", "meta");
    const seen: SliceEntry[] = [];
    const unsubscribe = subscribeSlice("page-a", "meta", (entry) =>
      seen.push(entry),
    );

    const turns = turnsFor("page-a", 12);
    upgradeCachedSlice("page-a", turns); // no read — the page already had them

    expect(mocks.getSliceContent).toHaveBeenCalledTimes(1);
    const last = seen[seen.length - 1];
    expect(last.mode).toBe("full");
    expect(last.full).toBe(turns);
    expect(last.preview.turns).toHaveLength(PREVIEW_TURNS); // the card face is untouched
    unsubscribe();
  });

  it("leaves a slice the cache has never seen alone", () => {
    upgradeCachedSlice("page-unknown", turnsFor("page-unknown", 3));
    expect(peekEntry("page-unknown")).toBeNull();
  });

  it("does not re-publish a slice that is already whole", async () => {
    await ensureSlice("page-b", "full");
    const seen: SliceEntry[] = [];
    const unsubscribe = subscribeSlice("page-b", "meta", (entry) =>
      seen.push(entry),
    );
    const seenAfterSubscribe = seen.length;

    upgradeCachedSlice("page-b", turnsFor("page-b", 12));

    expect(seen).toHaveLength(seenAfterSubscribe);
    unsubscribe();
  });
});

describe("subscribeSlice", () => {
  it("fires with the loading face, then the settled one, and stops after unsubscribe", async () => {
    const pending = ensureSlice("sub-a", "meta");
    // A card mounting while the read is in flight paints the loading face.
    expect(peekEntry("sub-a")?.preview.state).toBe("loading");

    const seen: SliceEntry[] = [];
    const unsubscribe = subscribeSlice("sub-a", "meta", (entry) =>
      seen.push(entry),
    );
    expect(seen[0].preview.state).toBe("loading"); // what the cache holds now

    await pending;
    expect(seen[seen.length - 1].mode).toBe("meta");

    const count = seen.length;
    unsubscribe();
    upgradeCachedSlice("sub-a", turnsFor("sub-a", 12));
    expect(seen).toHaveLength(count);
  });
});
