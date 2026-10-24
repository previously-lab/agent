/**
 * Room intent (the threshold gate) — the pure decisions behind walking into
 * a profiled room. PURE MODULE: no React, no three.js, no DOM, no clock.
 *
 * WHY THIS EXISTS. A corridor door no longer opens the instant its wall
 * plane is crossed: the room behind it compiles from the record's bounded
 * semantic profile, and that profile arrives asynchronously (one cached
 * server read per slice — see room-profile-cache.ts). While a profile is in
 * flight the player is held at the door by a lightweight GATE — an intent
 * with a token — instead of walking into a room that does not exist yet.
 * Every accept/drop/clamp decision of that gate lives here, pure, so the
 * integrator (game-canvas.tsx) only feeds it events and executes its
 * verdicts, and the geometry is unit-tested without a scene.
 *
 * THE GATE'S RULES:
 *   - The forward cap sits a hair INSIDE the wall-crossing trigger, so a
 *     gated player can step into the doorway but never engage (or fall
 *     into) a room that has not committed yet. Retreating and walking to
 *     another door are never blocked — the gate cancels instead.
 *   - A gate commits only while its token, door, hotel and the player's
 *     position still describe the same approach. A late profile for door A
 *     can never mount A's room after the player walked to door B, hopped
 *     hotels, or stepped back — and it can never pull the player through
 *     a door they are not standing at.
 *   - Errors and timeouts do NOT re-arm the gate by themselves (the cache
 *     keeps its settled unavailable result; only an explicit user retry or
 *     a cache invalidation starts a new request). An explicit fallback
 *     decision IS committable: the basic (neutral) room opens immediately
 *     and stays fixed for the whole visit.
 */

import { CLEAR_HALF, WALL_IN, WALL_OUT, WALL_Z } from "./clamps";
import type { DoorRef } from "./hotel";
import { getMode } from "@/lib/mode";
import type {
  RoomProfileCacheResult,
  RoomProfileRequest,
} from "./room-profile-cache";
import { NEUTRAL_ROOM_PROFILE, type RoomProfile } from "./room-profile";

/** One pending threshold approach. Minted by the integrator when the player
 *  reaches a profiled door whose room is not committable yet; cancelled by
 *  walking away, switching doors, hotel hops, focus moves, or a persona /
 *  source-scope lane change. */
export interface RoomIntent {
  /** Monotonic identity — minted from the integrator's intent epoch. Every
   *  invalidation bumps the epoch, so stale async completions can be told
   *  apart from the live gate by token alone. */
  readonly token: number;
  /** The door being approached — the gate's geometry and snapshot identity. */
  readonly door: DoorRef;
  /** The cache request captured for this approach (scope + persona + epoch +
   *  generation). The gate only commits while its request is still current
   *  (cache.isCurrent) AND the lane (scope + persona) has not moved. */
  readonly request: RoomProfileRequest;
  /** `${sourceScope}|${persona}` at mint time — a lane change kills the gate. */
  readonly laneKey: string;
  /** `"timelineId@windowIndex"` at mint time — a hotel hop kills the gate. */
  readonly hotelKey: string;
}

/** The forward z cap for a gated approach: the door's wall plane plus just
 *  under the wall-out overshoot, i.e. a hair inside the |z| > WALL_OUT
 *  crossing trigger. Pure geometry in the door's side sign:
 *  a north door (z = +WALL_Z) caps forward progress at +(WALL_Z + 0.18);
 *  a south door at −(WALL_Z + 0.18). The cap NEVER reaches WALL_OUT, so a
 *  held player cannot trigger the ordinary mount, and it is always past
 *  WALL_Z, so the doorway itself stays reachable. */
export function thresholdForwardLimit(doorZ: number): number {
  const sign = Math.sign(doorZ) || 1;
  return doorZ + sign * (WALL_OUT - WALL_Z - 0.02);
}

/**
 * Apply the gate's forward cap to a position (mutated in place, clamps.ts
 * idiom). Only forward progress TOWARD the room is clamped — retreating
 * (z back across the corridor) and lateral movement are untouched, so the
 * gate can always be escaped by walking away.
 */
export function clampToThreshold(
  p: { x: number; z: number },
  intent: Pick<RoomIntent, "door">,
): void {
  const limit = thresholdForwardLimit(intent.door.z);
  const sign = Math.sign(intent.door.z) || 1;
  if (sign > 0 ? p.z > limit : p.z < limit) p.z = limit;
}

/** The geometry constants behind `playerStillAtGate` — injected in tests. */
export interface GateGeometry {
  /** The door-x window: the release-zone half width (CLEAR_HALF). */
  readonly clearHalf: number;
  /** The hysteresis inner bound: below |z| < WALL_IN the player has left
   *  the doorway band and the approach is over. */
  readonly wallIn: number;
}

/** The live constants from clamps.ts. */
export const GATE_GEOMETRY: GateGeometry = {
  clearHalf: CLEAR_HALF,
  wallIn: WALL_IN,
};

/**
 * Is the player still standing AT the gate's approach? The async-commit
 * guard: a gate (or a late async completion) may only fire while the player
 * remains at the same door, on the same side, in the doorway band, in the
 * same hotel. Anything else — stepped back into the corridor, slid past
 * the door's x window, crossed to the other wall, hopped hotels — cancels.
 */
export function playerStillAtGate(
  intent: RoomIntent,
  p: { x: number; z: number },
  hotelKey: string,
  geometry: GateGeometry = GATE_GEOMETRY,
): boolean {
  if (intent.hotelKey !== hotelKey) return false;
  const gateSign = Math.sign(intent.door.z) || 1;
  if (Math.sign(p.z) !== gateSign) return false;
  if (Math.abs(p.z) < geometry.wallIn) return false;
  return Math.abs(p.x - intent.door.x) < geometry.clearHalf;
}

/** The gate's verdict for one cache peek. `commit` means the room behind
 *  the door may be built and mounted NOW — a ready profile, a definitive
 *  missing record (the honest neutral answer), or an explicit user-chosen
 *  fallback (also neutral, fixed for the visit). `hold` means the player
 *  stays at the threshold: either the read is still in flight (`loading`)
 *  or it failed retryably (`retry` — the user decides, never an auto-loop). */
export type RoomGateDecision =
  | { kind: "commit"; profile: RoomProfile }
  | { kind: "hold"; status: "loading" | "retry" };

/**
 * Map a cache peek to the gate's verdict. Pure — the integrator peeks, asks,
 * and either commits the returned profile or holds the gate with the returned
 * status. A `stale` result (the request lost a race with an invalidation) is
 * a hold: the next recapture under the fresh generation decides.
 */
export function decideGate(
  result: RoomProfileCacheResult | null,
): RoomGateDecision {
  if (result === null) return { kind: "hold", status: "loading" };
  switch (result.status) {
    case "ready":
    case "missing":
      return { kind: "commit", profile: result.profile };
    case "unavailable":
      return result.reason === "fallback"
        ? { kind: "commit", profile: result.profile }
        : { kind: "hold", status: "retry" };
    case "stale":
      return { kind: "hold", status: "loading" };
  }
}

/** The neutral profile every fallback / missing / pre-profile commitment
 *  builds from — re-exported so the integrator's mount path has one import. */
export const GATE_NEUTRAL_PROFILE: RoomProfile = NEUTRAL_ROOM_PROFILE;

/**
 * The room-profile lane key: the coarse NON-SENSITIVE scope the cache keys
 * its requests by. One deployment is exactly one scope — "cloud" for the
 * hosted app, "client" for the local kernel — so this never reads repo
 * credentials or data-source internals; it asks the mode module. The one
 * mode constant actually inlined into the browser bundle is the build-time
 * target (NEXT_PUBLIC_PREVIOUSLY_TARGET, "client" for the kernel build per
 * scripts/build-standalone.mjs, "cloud" on cloud builds), so a bundled
 * client answers from it and every other environment (SSR, tests, local
 * dev) falls back to the mode module's own env read.
 */
export function roomProfileSourceScope(): "cloud" | "client" {
  const target = process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET;
  if (target === "client" || target === "cloud") return target;
  return getMode();
}
