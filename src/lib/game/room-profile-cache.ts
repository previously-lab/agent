import { hotelDataEpoch } from "./hotel-data";
import {
  NEUTRAL_ROOM_PROFILE,
  parseRoomProfile,
  type RoomProfile,
} from "./room-profile";

export interface RoomProfileRequest {
  readonly sourceScope: string;
  readonly persona: string;
  readonly sliceId: string;
  readonly epoch: number;
  readonly generation: number;
}

export type RoomProfileFetchStatus = "ready" | "missing" | "unavailable";

export interface RoomProfileFetchResult {
  readonly status: RoomProfileFetchStatus;
  readonly profile: RoomProfile;
}

export type RoomProfileFetcher = (
  request: RoomProfileRequest,
) => Promise<RoomProfileFetchResult>;

export type RoomProfileUnavailableReason =
  | "error"
  | "timeout"
  | "queue-full"
  | "fallback";

interface RoomProfileCacheResultBase {
  readonly profile: RoomProfile;
  readonly epoch: number;
  readonly generation: number;
  readonly cached: boolean;
}

export type RoomProfileCacheResult =
  | (RoomProfileCacheResultBase & {
      readonly status: "ready" | "missing";
      readonly retryable: false;
    })
  | (RoomProfileCacheResultBase & {
      readonly status: "unavailable";
      readonly retryable: true;
      readonly reason: RoomProfileUnavailableReason;
    })
  | (RoomProfileCacheResultBase & {
      readonly status: "stale";
      readonly retryable: false;
    });

export interface RoomProfileCacheOptions {
  readonly maxEntries?: number;
  readonly maxInflight?: number;
  readonly maxQueue?: number;
  readonly timeoutMs?: number;
  readonly getEpoch?: () => number;
}

export interface RoomProfileCacheStats {
  readonly entries: number;
  readonly inflight: number;
  readonly queued: number;
  readonly generation: number;
}

export interface RoomProfileCache {
  capture(sourceScope: string, persona: string, sliceId: string): RoomProfileRequest;
  isCurrent(request: RoomProfileRequest): boolean;
  peek(request: RoomProfileRequest): RoomProfileCacheResult | null;
  load(request: RoomProfileRequest): Promise<RoomProfileCacheResult>;
  retry(request: RoomProfileRequest): Promise<RoomProfileCacheResult>;
  clear(request: RoomProfileRequest): boolean;
  invalidate(): void;
  fallback(request: RoomProfileRequest): RoomProfileCacheResult;
  stats(): RoomProfileCacheStats;
}

interface RoomProfileTask {
  readonly request: RoomProfileRequest;
  readonly key: string;
  readonly promise: Promise<RoomProfileCacheResult>;
  readonly resolve: (result: RoomProfileCacheResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  settled: boolean;
  actualSettled: boolean;
  result: RoomProfileCacheResult | null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

function keyFor(request: RoomProfileRequest): string {
  return JSON.stringify([
    request.sourceScope,
    request.persona,
    request.sliceId,
    request.epoch,
    request.generation,
  ]);
}

/** Pure browser-side cache. The server action is loaded only by the thin adapter below. */
export function createRoomProfileCache(
  fetcher: RoomProfileFetcher,
  options: RoomProfileCacheOptions = {},
): RoomProfileCache {
  const maxEntries = positiveInteger(options.maxEntries, 64);
  const maxInflight = positiveInteger(options.maxInflight, 4);
  const maxQueue = positiveInteger(options.maxQueue, 32);
  const timeoutMs = positiveInteger(options.timeoutMs, 8_000);
  const getEpoch = options.getEpoch ?? hotelDataEpoch;
  const entries = new Map<string, RoomProfileCacheResult>();
  const tasks = new Map<string, RoomProfileTask>();
  let queue: RoomProfileTask[] = [];
  let inflight = 0;
  let generation = 0;

  const isCurrent = (request: RoomProfileRequest): boolean =>
    request.epoch === getEpoch() && request.generation === generation;

  const stale = (request: RoomProfileRequest): RoomProfileCacheResult => ({
    status: "stale",
    profile: NEUTRAL_ROOM_PROFILE,
    epoch: request.epoch,
    generation: request.generation,
    cached: false,
    retryable: false,
  });

  const unavailable = (
    request: RoomProfileRequest,
    reason: RoomProfileUnavailableReason,
  ): RoomProfileCacheResult => ({
    status: "unavailable",
    profile: NEUTRAL_ROOM_PROFILE,
    epoch: request.epoch,
    generation: request.generation,
    cached: false,
    retryable: true,
    reason,
  });

  const store = (request: RoomProfileRequest, result: RoomProfileCacheResult): void => {
    const key = keyFor(request);
    entries.delete(key);
    entries.set(key, result);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const cached = (request: RoomProfileRequest): RoomProfileCacheResult | null => {
    const key = keyFor(request);
    const hit = entries.get(key);
    if (!hit) return null;
    entries.delete(key);
    entries.set(key, hit);
    return { ...hit, cached: true } as RoomProfileCacheResult;
  };

  const settle = (task: RoomProfileTask, result: RoomProfileCacheResult): void => {
    if (task.settled) return;
    const effective =
      tasks.get(task.key) === task && isCurrent(task.request)
        ? result
        : stale(task.request);
    if (effective.status !== "stale") store(task.request, effective);
    task.settled = true;
    task.result = effective;
    if (task.timer !== null) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    task.resolve(effective);
  };

  const warmLateResult = (
    task: RoomProfileTask,
    result: RoomProfileFetchResult,
  ): void => {
    const visible = task.result;
    if (!visible || visible.status !== "unavailable" || visible.reason !== "timeout") {
      return;
    }
    if (tasks.get(task.key) !== task || !isCurrent(task.request)) return;
    if (result.status === "unavailable") return;
    try {
      const profile = parseRoomProfile(result.profile);
      store(task.request, {
        status: result.status,
        profile,
        epoch: task.request.epoch,
        generation: task.request.generation,
        cached: false,
        retryable: false,
      });
    } catch {
      // An invalid late payload leaves the original timeout result intact.
    }
  };

  const settleFetchResult = (
    task: RoomProfileTask,
    result: RoomProfileFetchResult,
  ): void => {
    task.actualSettled = true;
    if (task.settled) {
      warmLateResult(task, result);
      return;
    }
    try {
      const profile = parseRoomProfile(result.profile);
      if (result.status === "unavailable") {
        settle(task, unavailable(task.request, "error"));
        return;
      }
      settle(task, {
        status: result.status,
        profile,
        epoch: task.request.epoch,
        generation: task.request.generation,
        cached: false,
        retryable: false,
      });
    } catch {
      settle(task, unavailable(task.request, "error"));
    }
  };

  const pump = (): void => {
    while (inflight < maxInflight && queue.length > 0) {
      const task = queue.shift();
      if (!task) return;
      if (task.settled || !isCurrent(task.request)) {
        settle(task, stale(task.request));
        if (tasks.get(task.key) === task) tasks.delete(task.key);
        continue;
      }
      task.started = true;
      inflight += 1;
      void Promise.resolve()
        .then(() => fetcher(task.request))
        .then(
          (result) => settleFetchResult(task, result),
          () => {
            task.actualSettled = true;
            settle(task, unavailable(task.request, "error"));
          },
        )
        .finally(() => {
          task.started = false;
          inflight -= 1;
          if (task.timer !== null) {
            clearTimeout(task.timer);
            task.timer = null;
          }
          if (tasks.get(task.key) === task) tasks.delete(task.key);
          pump();
        });
    }
  };

  const start = (request: RoomProfileRequest): Promise<RoomProfileCacheResult> => {
    const key = keyFor(request);
    if (queue.length >= maxQueue) {
      const result = unavailable(request, "queue-full");
      store(request, result);
      return Promise.resolve(result);
    }
    let resolveTask!: (result: RoomProfileCacheResult) => void;
    const promise = new Promise<RoomProfileCacheResult>((resolve) => {
      resolveTask = resolve;
    });
    const task: RoomProfileTask = {
      request,
      key,
      promise,
      resolve: resolveTask,
      timer: null,
      started: false,
      settled: false,
      actualSettled: false,
      result: null,
    };
    task.timer = setTimeout(() => {
      if (task.settled) return;
      settle(task, unavailable(request, "timeout"));
      if (!task.started) {
        if (tasks.get(key) === task) tasks.delete(key);
        queue = queue.filter((queued) => queued !== task);
      }
      pump();
    }, timeoutMs);
    tasks.set(key, task);
    queue.push(task);
    pump();
    return promise;
  };

  const load = (request: RoomProfileRequest): Promise<RoomProfileCacheResult> => {
    if (!isCurrent(request)) return Promise.resolve(stale(request));
    const hit = cached(request);
    if (hit) return Promise.resolve(hit);
    const key = keyFor(request);
    const task = tasks.get(key);
    if (task) {
      if (task.settled && task.actualSettled) {
        if (tasks.get(key) === task) tasks.delete(key);
        return start(request);
      }
      if (task.settled && task.result) {
        if (task.result.status !== "stale") store(request, task.result);
        return Promise.resolve({ ...task.result, cached: true } as RoomProfileCacheResult);
      }
      return task.promise;
    }
    return start(request);
  };

  const retry = (request: RoomProfileRequest): Promise<RoomProfileCacheResult> => {
    if (!isCurrent(request)) return Promise.resolve(stale(request));
    const key = keyFor(request);
    entries.delete(key);
    const task = tasks.get(key);
    if (task) {
      if (task.settled && task.actualSettled) {
        if (tasks.get(key) === task) tasks.delete(key);
        return start(request);
      }
      if (task.settled && task.result) {
        if (task.result.status !== "stale") store(request, task.result);
        return Promise.resolve({ ...task.result, cached: true } as RoomProfileCacheResult);
      }
      return task.promise;
    }
    return start(request);
  };

  const invalidate = (): void => {
    generation += 1;
    entries.clear();
    const pending = [...tasks.values()];
    for (const task of pending) settle(task, stale(task.request));
    queue = queue.filter((task) => !task.settled);
    for (const task of pending) {
      if (!task.started && tasks.get(task.key) === task) tasks.delete(task.key);
    }
    pump();
  };

  return {
    capture(sourceScope, persona, sliceId) {
      return Object.freeze({
        sourceScope,
        persona,
        sliceId,
        epoch: getEpoch(),
        generation,
      });
    },
    isCurrent,
    peek(request) {
      if (!isCurrent(request)) return stale(request);
      return cached(request);
    },
    load,
    retry,
    clear(request) {
      if (!isCurrent(request)) return false;
      return entries.delete(keyFor(request));
    },
    invalidate,
    fallback(request) {
      if (!isCurrent(request)) return stale(request);
      const hit = cached(request);
      if (hit && (hit.status === "ready" || hit.status === "missing")) return hit;
      return unavailable(request, "fallback");
    },
    stats() {
      return { entries: entries.size, inflight, queued: queue.length, generation };
    },
  };
}

let browserCache: RoomProfileCache | null = null;

/** Browser singleton; pure tests never import the server action through this module. */
export function getBrowserRoomProfileCache(): RoomProfileCache {
  browserCache ??= createRoomProfileCache(async (request) => {
    const { getRoomProfile } = await import("./room-profile-actions");
    return getRoomProfile(request.sliceId, request.persona);
  });
  return browserCache;
}
