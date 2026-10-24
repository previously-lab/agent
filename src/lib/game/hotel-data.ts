/**
 * The hotel's data lane, cached at module level so it SURVIVES VIEW SWITCHES.
 *
 * `GameShell` derives its whole data lane (corridor doors, room-door map,
 * strand hotels) from two server reads (`getTimelineCatalog` +
 * `getStrandPaths`). It used to re-derive from scratch on every mount, and a
 * field → game → field → game ping-pong paid two server round trips plus a
 * second-pass room-door rebuild on every re-entry. The derivation is pure
 * given (catalog, strands, locale), so the RESULT is cached here and the
 * shell reuses it across mounts.
 *
 * THE INVALIDATION CONTRACT — a cache hit must never serve data staler than
 * the view it replaces:
 *
 *   1. EPOCH BUMP ON MEMORY GROWTH. The app shell calls
 *      `invalidateHotelData()` every time a turn settles and the catalog
 *      refresh succeeds (`refreshCatalog` in app-shell.tsx). A settled turn
 *      is the only in-session event that can change what the hotel shows —
 *      a new slice means a new door, and a weave may have moved strands.
 *      The next game entry after a settle therefore ALWAYS misses and
 *      re-fetches. Bumping on every successful refresh (not only when the
 *      page grew) is deliberate: strand-only changes have no client-visible
 *      growth signal, and an unnecessary re-fetch is cheaper than stale
 *      doors.
 *   2. LOCALE + SCOPE ARE PART OF THE KEY. Labels are formatted per locale,
 *      while source scope isolates deployment/persona-facing data lanes.
 *   3. FETCHES COMMIT TO THEIR START EPOCH. `captureHotelDataRequest` freezes
 *      scope + epoch at fetch start; `writeHotelDataAtEpoch` rejects a late
 *      response instead of restamping it. Profile caches observe this same
 *      epoch without mutating any mounted ActiveSpace snapshot.
 *   4. PAGE RELOAD RESETS EVERYTHING. Module state dies with the page, so
 *      the first game entry of a session always fetches.
 *
 * What is NOT invalidated: cross-instance writes that bypass this client's
 * turn stream (same exposure as the shell's own catalog state, which also
 * only refreshes on settle), and older-page loads (`loadOlder` prepends
 * history the hotel never reads — the corridor caps at the newest
 * MAX_DOORS slices).
 */

import type { CorridorDoor } from "@/components/game/corridor";
import type { RoomDoorMap } from "@/lib/game/strand-doors";

/**
 * The hotel's door window (v1 cap): the corridor materializes only the
 * NEWEST this-many slices, so a slice id resolves to a hotel door exactly
 * when its newest-first rank is below this bound. ONE definition, three
 * readers: GameShell's door list (its old local MAX_DOORS), the archive's
 * `verifyRefs` (the desk's place line prints only for slices with a door),
 * and anything else asking "does this slice have a room".
 */
export const HOTEL_WINDOW_DOORS = 200;

/** Everything `GameShell` renders from, ready to mount. */
export interface HotelData {
  doors: readonly CorridorDoor[];
  roomDoors: RoomDoorMap;
  timelines: ReadonlyMap<string, readonly CorridorDoor[]>;
}

export const DEFAULT_HOTEL_DATA_SCOPE = "default";

export interface HotelDataRequest {
  readonly scope: string;
  readonly epoch: number;
}

interface CacheSlot {
  scope: string;
  locale: string;
  epoch: number;
  data: HotelData;
}

let epoch = 0;
let slot: CacheSlot | null = null;

/**
 * Bump the cache generation. Every entry written before this call is dead —
 * the next `readHotelData` misses and the shell re-fetches. The same epoch
 * is observed by room-profile caches; mounted ActiveSpace snapshots are not
 * mutated here.
 */
export function invalidateHotelData(): void {
  epoch += 1;
}

/** The current cache generation (tests assert the bump). */
export function hotelDataEpoch(): number {
  return epoch;
}

/** Capture scope + epoch when a fetch starts, not when it settles. */
export function captureHotelDataRequest(
  scope: string = DEFAULT_HOTEL_DATA_SCOPE,
): HotelDataRequest {
  return Object.freeze({ scope, epoch });
}

/**
 * The cached lane for `locale` + `scope`, or null when none is current.
 * The default scope keeps pre-scope callers compatible.
 */
export function readHotelData(
  locale: string,
  scope: string = DEFAULT_HOTEL_DATA_SCOPE,
): HotelData | null {
  if (slot && slot.scope === scope && slot.locale === locale && slot.epoch === epoch) {
    return slot.data;
  }
  return null;
}

/** Store the freshly derived lane using the legacy settle-time epoch contract. */
export function writeHotelData(
  locale: string,
  data: HotelData,
  scope: string = DEFAULT_HOTEL_DATA_SCOPE,
): void {
  slot = { scope, locale, epoch, data };
}

/** Read only while the caller's captured navigation request is still current. */
export function readHotelDataAtEpoch(
  locale: string,
  request: HotelDataRequest,
): HotelData | null {
  return request.epoch === epoch ? readHotelData(locale, request.scope) : null;
}

/**
 * Commit a fetch only into the epoch it started in. A late response returns
 * false and can never stamp old data with the newer settle-time epoch.
 */
export function writeHotelDataAtEpoch(
  locale: string,
  data: HotelData,
  request: HotelDataRequest,
): boolean {
  if (request.epoch !== epoch) return false;
  slot = { scope: request.scope, locale, epoch: request.epoch, data };
  return true;
}
