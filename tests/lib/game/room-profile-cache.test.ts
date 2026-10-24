import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoomProfileCache,
  type RoomProfileFetchResult,
} from "@/lib/game/room-profile-cache";
import {
  deriveRoomProfile,
  NEUTRAL_ROOM_PROFILE,
} from "@/lib/game/room-profile";
import { invalidateHotelData } from "@/lib/game/hotel-data";

const SLICE = "2026-10-24-0930";
const writing = deriveRoomProfile({ focus: "写作" });
const research = deriveRoomProfile({ focus: "阅读文献" });

function ready(profile = writing): RoomProfileFetchResult {
  return { status: "ready", profile };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("room-profile cache", () => {
  it("shares one same-key inflight request and caches the completed profile", async () => {
    const pending = deferred<RoomProfileFetchResult>();
    const fetcher = vi.fn(() => pending.promise);
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("demo", "alice", SLICE);

    const first = cache.load(request);
    const second = cache.load(request);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(ready());
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: "ready", cached: false, profile: writing });
    expect(b).toMatchObject({ status: "ready", cached: false, profile: writing });

    expect(await cache.load(request)).toMatchObject({ status: "ready", cached: true });
    expect(cache.peek(request)).toMatchObject({ status: "ready", cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not share requests across persona, source scope or hotel epoch", async () => {
    let epoch = 0;
    const fetcher = vi.fn(async () => ready());
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => epoch });
    const alice = cache.capture("demo", "alice", SLICE);
    const bob = cache.capture("demo", "bob", SLICE);
    const own = cache.capture("own", "alice", SLICE);
    await Promise.all([alice, bob, own].map((request) => cache.load(request)));
    expect(fetcher).toHaveBeenCalledTimes(3);

    epoch = 1;
    const nextEpoch = cache.capture("demo", "alice", SLICE);
    await cache.load(nextEpoch);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(cache.peek(alice)).toMatchObject({ status: "stale" });
    expect(cache.peek(nextEpoch)).toMatchObject({ status: "ready" });
  });

  it("keeps a late old-epoch response out of the visible new cache", async () => {
    let epoch = 0;
    const oldRead = deferred<RoomProfileFetchResult>();
    const newRead = deferred<RoomProfileFetchResult>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => newRead.promise);
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => epoch });
    const oldRequest = cache.capture("demo", "alice", SLICE);
    const oldLoad = cache.load(oldRequest);
    await Promise.resolve();

    epoch = 1;
    const newRequest = cache.capture("demo", "alice", SLICE);
    const newLoad = cache.load(newRequest);
    await Promise.resolve();
    expect(cache.isCurrent(oldRequest)).toBe(false);
    expect(await cache.load(oldRequest)).toMatchObject({ status: "stale" });

    newRead.resolve(ready(research));
    expect(await newLoad).toMatchObject({ status: "ready", profile: research });
    oldRead.resolve(ready(writing));
    expect(await oldLoad).toMatchObject({ status: "stale" });
    expect(cache.peek(newRequest)).toMatchObject({ status: "ready", profile: research });
    expect(cache.peek(oldRequest)).toMatchObject({ status: "stale" });
  });

  it("caches missing results just like other completed reads", async () => {
    const fetcher = vi.fn(async () => ({
      status: "missing" as const,
      profile: NEUTRAL_ROOM_PROFILE,
    }));
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);
    expect(await cache.load(request)).toMatchObject({ status: "missing", cached: false });
    expect(await cache.load(request)).toMatchObject({ status: "missing", cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires explicit retry after unavailable and supports clearing failures", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ready());
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);

    expect(await cache.load(request)).toMatchObject({
      status: "unavailable",
      reason: "error",
      retryable: true,
    });
    expect(await cache.load(request)).toMatchObject({
      status: "unavailable",
      reason: "error",
      cached: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.clear(request)).toBe(true);
    expect(cache.peek(request)).toBeNull();
    expect(await cache.retry(request)).toMatchObject({ status: "ready", profile: writing });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries immediately after the first unavailable await", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ready());
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);

    expect(await cache.load(request)).toMatchObject({ status: "unavailable" });
    expect(await cache.retry(request)).toMatchObject({ status: "ready", profile: writing });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a completed ready result when fallback is requested", async () => {
    const fetcher = vi.fn(async () => ready());
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);
    expect(await cache.load(request)).toMatchObject({ status: "ready" });
    await vi.waitFor(() => expect(cache.stats().inflight).toBe(0));

    expect(cache.fallback(request)).toMatchObject({
      status: "ready",
      profile: writing,
      cached: true,
    });
    expect(cache.peek(request)).toMatchObject({ status: "ready", profile: writing });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not let a visit fallback cancel or pollute a pending success", async () => {
    const pending = deferred<RoomProfileFetchResult>();
    const fetcher = vi.fn(() => pending.promise);
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);
    const loading = cache.load(request);
    await Promise.resolve();

    expect(cache.fallback(request)).toMatchObject({
      status: "unavailable",
      reason: "fallback",
      profile: NEUTRAL_ROOM_PROFILE,
      cached: false,
    });
    expect(cache.peek(request)).toBeNull();
    pending.resolve(ready());
    expect(await loading).toMatchObject({ status: "ready", profile: writing });
    await vi.waitFor(() => expect(cache.stats().inflight).toBe(0));
    expect(cache.peek(request)).toMatchObject({ status: "ready", profile: writing });
  });

  it("does not let an old visit fallback cancel a newer retry", async () => {
    const pending = deferred<RoomProfileFetchResult>();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => pending.promise);
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);
    expect(await cache.load(request)).toMatchObject({ status: "unavailable" });

    const retrying = cache.retry(request);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(cache.fallback(request)).toMatchObject({
      status: "unavailable",
      reason: "fallback",
      cached: false,
    });
    pending.resolve(ready(research));
    expect(await retrying).toMatchObject({ status: "ready", profile: research });
    await vi.waitFor(() => expect(cache.stats().inflight).toBe(0));
    expect(cache.peek(request)).toMatchObject({ status: "ready", profile: research });
  });

  it("caps real underlying concurrency and starts work only for requested slices", async () => {
    const reads: Deferred<RoomProfileFetchResult>[] = [];
    let actualInflight = 0;
    let maximumInflight = 0;
    const fetcher = vi.fn(() => {
      const read = deferred<RoomProfileFetchResult>();
      reads.push(read);
      actualInflight += 1;
      maximumInflight = Math.max(maximumInflight, actualInflight);
      return read.promise.finally(() => {
        actualInflight -= 1;
      });
    });
    const cache = createRoomProfileCache(fetcher, {
      getEpoch: () => 0,
      maxInflight: 2,
      maxQueue: 4,
      timeoutMs: 1_000,
    });
    const requests = Array.from({ length: 5 }, (_, index) =>
      cache.capture("own", "user", `slice-${index}`),
    );
    const loads = requests.map((request) => cache.load(request));
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(cache.stats()).toMatchObject({ inflight: 2, queued: 3 });

    reads[0].resolve(ready());
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(cache.stats()).toMatchObject({ inflight: 2, queued: 2 });
    for (let index = 1; index < requests.length; index++) {
      reads[index].resolve(ready());
      const expectedStarts = Math.min(index + 3, requests.length);
      await vi.waitFor(() => expect(reads).toHaveLength(expectedStarts));
    }
    await Promise.all(loads);
    await vi.waitFor(() => {
      expect(cache.stats()).toMatchObject({ inflight: 0, queued: 0 });
      expect(actualInflight).toBe(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(maximumInflight).toBe(2);
  });

  it("warms a late success without changing the settled timeout result", async () => {
    vi.useFakeTimers();
    const late = deferred<RoomProfileFetchResult>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValueOnce(ready(research));
    const cache = createRoomProfileCache(fetcher, {
      getEpoch: () => 0,
      timeoutMs: 50,
      maxInflight: 1,
    });
    const request = cache.capture("own", "user", SLICE);
    const waiting = cache.load(request);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(50);
    const firstResult = await waiting;
    expect(firstResult).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(cache.stats().inflight).toBe(1);
    expect(await cache.retry(request)).toMatchObject({
      status: "unavailable",
      reason: "timeout",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    late.resolve(ready(writing));
    await vi.advanceTimersByTimeAsync(0);
    expect(firstResult).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(cache.peek(request)).toMatchObject({ status: "ready", profile: writing });
    expect(cache.stats().inflight).toBe(0);
    expect(await cache.load(request)).toMatchObject({
      status: "ready",
      profile: writing,
      cached: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await cache.retry(request)).toMatchObject({ status: "ready", profile: research });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds completed entries with LRU eviction", async () => {
    const fetcher = vi.fn(async () => ready());
    const cache = createRoomProfileCache(fetcher, {
      getEpoch: () => 0,
      maxEntries: 2,
    });
    const requests = ["slice-a", "slice-b", "slice-c"].map((sliceId) =>
      cache.capture("own", "user", sliceId),
    );
    for (const request of requests) await cache.load(request);
    expect(cache.stats().entries).toBe(2);
    expect(cache.peek(requests[0])).toBeNull();
    expect(cache.peek(requests[1])).toMatchObject({ status: "ready" });
    expect(cache.peek(requests[2])).toMatchObject({ status: "ready" });
    await cache.load(requests[0]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(cache.stats().entries).toBe(2);
  });

  it("invalidates pending generations explicitly without letting late data return", async () => {
    const pending = deferred<RoomProfileFetchResult>();
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(ready(research));
    const cache = createRoomProfileCache(fetcher, { getEpoch: () => 0 });
    const request = cache.capture("own", "user", SLICE);
    const loading = cache.load(request);
    await Promise.resolve();

    cache.invalidate();
    expect(await loading).toMatchObject({ status: "stale" });
    expect(cache.isCurrent(request)).toBe(false);
    pending.resolve(ready(writing));
    await vi.waitFor(() => expect(cache.stats().inflight).toBe(0));
    expect(cache.peek(request)).toMatchObject({ status: "stale" });

    const current = cache.capture("own", "user", SLICE);
    expect(await cache.load(current)).toMatchObject({ status: "ready", profile: research });
    expect(cache.stats().generation).toBe(1);
  });

  it("observes invalidateHotelData synchronously through the shared default epoch", async () => {
    const fetcher = vi.fn(async () => ready());
    const cache = createRoomProfileCache(fetcher);
    const request = cache.capture("own", "user", SLICE);
    invalidateHotelData();
    expect(cache.isCurrent(request)).toBe(false);
    expect(await cache.load(request)).toMatchObject({ status: "stale" });
    expect(fetcher).not.toHaveBeenCalled();

    const current = cache.capture("own", "user", SLICE);
    expect(await cache.load(current)).toMatchObject({ status: "ready" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
