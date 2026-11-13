"use client";

import { useEffect, useState } from "react";
import {
  getBriefingIdentity,
  type BriefingIdentity,
} from "@/lib/episodic/actions";

/**
 * The briefing identity — the display name behind "PREVIOUSLY ON {name}" —
 * fetched ONCE per page load and shared by whoever needs it.
 *
 * TWO CALLERS, ONE READ. The brand in the header and the briefing card's
 * eyebrow in the chat page both want it, and each owning its own state and
 * effect would mean `getBriefingIdentity` running twice. That read is not
 * free: `loadUserProfile` reads the live user model to parse the name, which
 * in GitHub mode needs a network read. Both callers share that same result.
 *
 * IT CANNOT COME FROM THE SERVER. The locale layout is PRERENDERED at build
 * time, so a name resolved there would be baked into the HTML and stale on
 * every real visit — the same constraint `client-badge.tsx` documents for
 * `PREVIOUSLY_MODE`. Hence a client fetch, and hence a loading state that the
 * callers have to have an answer for.
 *
 * THE PERSONA IS READ HERE, not passed in, because there is nowhere to pass it
 * FROM: server actions cannot read searchParams, which is why the chat page
 * reads it off the URL too. That also makes the shared promise safe — the
 * value is constant for a page load, so the first caller's request is the
 * right request for every later one.
 */
let pending: Promise<BriefingIdentity | null> | null = null;

function load(): Promise<BriefingIdentity | null> {
  pending ??= (() => {
    const persona =
      new URLSearchParams(window.location.search).get("persona") || "user";
    // A failed read leaves the caller with `null`, which every consumer already
    // treats as "no name yet" — the same thing it shows while loading.
    return getBriefingIdentity(persona).catch(() => null);
  })();
  return pending;
}

/** The identity, or `null` while it is in flight (and if it never arrives). */
export function useBriefingIdentity(): BriefingIdentity | null {
  const [identity, setIdentity] = useState<BriefingIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then((next) => {
      if (!cancelled) setIdentity(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}
