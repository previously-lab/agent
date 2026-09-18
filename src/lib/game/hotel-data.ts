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
 *   2. LOCALE IS PART OF THE KEY. Labels are formatted per locale at build
 *      time; a locale switch misses the cache and re-derives.
 *   3. PAGE RELOAD RESETS EVERYTHING. Module state dies with the page, so
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

/** Everything `GameShell` renders from, ready to mount. */
export interface HotelData {
  doors: readonly CorridorDoor[];
  roomDoors: RoomDoorMap;
  timelines: ReadonlyMap<string, readonly CorridorDoor[]>;
}

interface CacheSlot {
  locale: string;
  epoch: number;
  data: HotelData;
}

let epoch = 0;
let slot: CacheSlot | null = null;

/**
 * Bump the cache generation. Every entry written before this call is dead —
 * the next `readHotelData` misses and the shell re-fetches. Called when the
 * memory data the hotel derives from may have changed (see the contract
 * above).
 */
export function invalidateHotelData(): void {
  epoch += 1;
}

/** The current cache generation (tests assert the bump). */
export function hotelDataEpoch(): number {
  return epoch;
}

/**
 * The cached lane for `locale`, or null when there is none (first entry of
 * the session) or the slot was invalidated / written under another locale.
 */
export function readHotelData(locale: string): HotelData | null {
  if (slot && slot.locale === locale && slot.epoch === epoch) return slot.data;
  return null;
}

/** Store the freshly derived lane for `locale`. */
export function writeHotelData(locale: string, data: HotelData): void {
  slot = { locale, epoch, data };
}
