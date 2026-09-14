"use client";

import { useEffect, useState } from "react";

/**
 * useBridgeBrainActive — does this kernel run the subscription-bridge brain?
 *
 * The companion ("mouth") endpoint answers 501 in bridge mode, so the
 * narrate entry hides itself rather than offering a request that cannot
 * succeed. The only honest source is the server: GET /api/client/status
 * reports `bridge.active` in client mode and 404s in cloud mode (where the
 * endpoint is expected to work) — so cloud resolves to false, client+BYOK
 * to false, client+bridge to true.
 *
 * TRI-STATE, not a boolean: null while the probe is in flight or failed.
 * The caller renders nothing until the answer is known — the same
 * fetch-and-self-hide discipline as `ClientBadge` — so a bridge-mode client
 * never flashes an entry it cannot serve. Cloud builds (bundled with
 * NEXT_PUBLIC_PREVIOUSLY_TARGET=cloud) skip the probe entirely: status
 * 404s there on every load, and the answer is structurally false.
 *
 * The probe runs ONCE per mount; the brain only changes on a settings save,
 * after which the user expects the page to reflect config they just wrote —
 * remounting (or a refresh) re-probes.
 */

const IS_CLOUD_BUILD = process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET === "cloud";

interface ClientStatus {
  bridge?: { active?: boolean };
}

export function useBridgeBrainActive(): boolean | null {
  const [active, setActive] = useState<boolean | null>(null);

  useEffect(() => {
    if (IS_CLOUD_BUILD) {
      setActive(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/client/status");
        // Cloud mode answers 404 — structurally not a bridge brain.
        if (!res.ok) {
          if (!cancelled) setActive(false);
          return;
        }
        const data = (await res.json()) as ClientStatus;
        if (!cancelled) setActive(data?.bridge?.active === true);
      } catch {
        // Unreachable API — stay unknown (entry hidden) rather than guess.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return active;
}
