"use client";

import { useEffect, useRef } from "react";
import { getChatRecovery } from "@/lib/chat/actions";
import {
  acceptPersistenceRecovery,
  readPendingPersistence,
  subscribePendingPersistence,
  subscribePersistenceCommits,
} from "@/lib/chat/persistence";

/** Observe the persistence dependency even when the workflow panel is closed. */
export function usePersistenceObserver(onCommitted?: () => void, onFailure?: (error: string) => void) {
  const committedRef = useRef(onCommitted);
  const failureRef = useRef(onFailure);
  committedRef.current = onCommitted;
  failureRef.current = onFailure;
  useEffect(() => subscribePersistenceCommits(() => committedRef.current?.()), []);
  useEffect(() => {
    let stopped = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const announced = new Set<string>();
    const hidden = () => document.visibilityState === "hidden";
    const schedule = (delay: number) => {
      if (timer !== undefined) clearTimeout(timer);
      if (!stopped && !hidden()) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (stopped || hidden()) return;
      const pending = readPendingPersistence();
      if (pending.runIds.length === 0 && pending.summaryRunIds.length === 0) return;
      const current = ++generation;
      try {
        const recovery = await getChatRecovery(pending.runIds, pending.summaryRunIds);
        if (stopped || generation !== current || hidden()) return;
        acceptPersistenceRecovery(recovery);
        for (const failure of recovery.failures) {
          const key = `${failure.runId}:${failure.error}`;
          if (announced.has(key)) continue;
          announced.add(key);
          failureRef.current?.(failure.error);
        }
        failures = recovery.unavailableRunIds.length > 0 || recovery.failures.length > 0 ? failures + 1 : 0;
      } catch { failures += 1; }
      schedule(Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)));
    };
    const wake = () => { generation += 1; schedule(0); };
    const visibility = () => {
      generation += 1;
      if (timer !== undefined) clearTimeout(timer);
      if (document.visibilityState !== "hidden") schedule(0);
    };
    const unsubscribe = subscribePendingPersistence(wake);
    document.addEventListener("visibilitychange", visibility);
    schedule(0);
    return () => {
      stopped = true;
      generation += 1;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
}
