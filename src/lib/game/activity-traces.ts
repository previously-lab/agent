/** Deterministic activity dressing on measured, already-staged furniture.
 * No IO, renderer, clock or main-layout RNG. Every check uses the host's
 * local frame; scale and rotation are applied exactly once at the end. */
import type { RoomActivity } from "./room-profile";
import {
  ACTIVITY_FOOTPRINTS, ACTIVITY_SUPPORTS, ACTIVITY_SURFACE_HEIGHTS,
  type ActivityFootprint,
} from "./prop-dimensions";
import { createRng, deriveSubSeed, WORLD_SEED } from "./seed";

export type ActivityTraceKind = Exclude<RoomActivity, "neutral">;
export interface ActivityTraceHost {
  kind: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  kitIndex?: number;
  instanceId?: string;
  trace?: boolean | ActivityTraceKind;
}
export interface ActivityTraceItem {
  kind: ActivityTraceKind;
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
  instanceId: string;
}
const HOSTS: Record<ActivityTraceKind, readonly string[]> = {
  // The reading-room blueprint uses long tables, not writing desks.
  writing: ["desk"], research: ["desk", "diningtable"],
  planning: ["desk", "counter", "diningtable"], making: ["workbench"],
  conversation: ["coffeetable", "diningtable", "nightstand"],
  reflection: ["nightstand", "bench", "poolbench", "coffeetable"],
};
const DRESSING_RADII: Readonly<Record<string, number>> = {
  desklamp: .18, bookpile: .33, tray: .25, vase: .1, frame: .2,
  candle: .06, bell: .075, register: .25, towelstack: .29,
};
const EDGE_GAP = .012;
const OBJECT_GAP = .015;
interface Circle { x: number; z: number; radius: number }

function rotate(x: number, z: number, yaw: number): { x: number; z: number } {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: x * c + z * s, z: -x * s + z * c };
}

/** Trace silhouette in its host's local frame, before the center offset. */
export function activityFootprintsAt(kind: ActivityTraceKind, yaw: number): ActivityFootprint[] {
  return ACTIVITY_FOOTPRINTS[kind].map((p): ActivityFootprint => {
    const center = rotate(p.x, p.z, yaw);
    return p.shape === "circle"
      ? { ...p, ...center }
      : { ...p, ...center, rotY: p.rotY + yaw };
  });
}

function halfBounds(p: ActivityFootprint): { x: number; z: number } {
  if (p.shape === "circle") return { x: p.radius, z: p.radius };
  const c = Math.abs(Math.cos(p.rotY)), s = Math.abs(Math.sin(p.rotY));
  return { x: p.hx * c + p.hz * s, z: p.hx * s + p.hz * c };
}

function missesCircle(p: ActivityFootprint, x: number, z: number, o: Circle): boolean {
  const dx = o.x - x - p.x, dz = o.z - z - p.z;
  if (p.shape === "circle") return Math.hypot(dx, dz) >= o.radius + p.radius + OBJECT_GAP;
  const local = rotate(dx, dz, -p.rotY);
  return Math.hypot(Math.max(0, Math.abs(local.x) - p.hx), Math.max(0, Math.abs(local.z) - p.hz)) >= o.radius + OBJECT_GAP;
}

function occupancyFor(host: ActivityTraceHost, furniture: readonly ActivityTraceHost[]): Circle[] {
  const result: Circle[] = [...ACTIVITY_SUPPORTS[host.kind].obstacles];
  const top = host.y + ACTIVITY_SURFACE_HEIGHTS[host.kind] * host.scale;
  for (const p of furniture) {
    const radius = DRESSING_RADII[p.kind];
    if (p === host || radius === undefined || !Number.isFinite(p.scale) || p.scale <= 0) continue;
    if (Math.abs(p.y - top) > .12 * host.scale) continue;
    const local = rotate((p.x - host.x) / host.scale, (p.z - host.z) / host.scale, -host.rotY);
    result.push({ ...local, radius: radius * p.scale / host.scale });
  }
  return result;
}

/** Every paper/tool/cup is supported and clears both the furniture's
 * built-in objects and separately staged tabletop dressing. */
export function activityTraceFits(
  trace: ActivityTraceItem, host: ActivityTraceHost, furniture: readonly ActivityTraceHost[],
): boolean {
  const support = ACTIVITY_SUPPORTS[host.kind];
  if (!support || !Number.isFinite(host.scale) || host.scale <= 0) return false;
  const center = rotate((trace.x - host.x) / host.scale, (trace.z - host.z) / host.scale, -host.rotY);
  const shapes = activityFootprintsAt(trace.kind, trace.rotY - host.rotY);
  const obstacles = occupancyFor(host, furniture);
  return shapes.every((p) => {
    const half = halfBounds(p);
    return Math.abs(center.x + p.x) + half.x <= support.hx - EDGE_GAP + 1e-9 &&
      Math.abs(center.z + p.z) + half.z <= support.hz - EDGE_GAP + 1e-9 &&
      obstacles.every((o) => missesCircle(p, center.x, center.z, o));
  });
}

export function activityTraceFor(
  activity: RoomActivity, roomId: string, furniture: readonly ActivityTraceHost[],
): ActivityTraceItem | null {
  if (activity === "neutral") return null;
  const tracedKits = new Set(furniture.filter((p) => p.trace && p.kitIndex !== undefined).map((p) => p.kitIndex));
  const candidates = furniture.map((host, index) => ({ host, index, rank: HOSTS[activity].indexOf(host.kind) }))
    .filter(({ host, rank }) => rank >= 0 && !host.trace &&
      !(host.kitIndex !== undefined && tracedKits.has(host.kitIndex)) &&
      host.scale > 0 && [host.x, host.y, host.z, host.scale, host.rotY].every(Number.isFinite))
    .sort((a, b) => a.rank - b.rank || (a.host.kitIndex ?? a.index) - (b.host.kitIndex ?? b.index) || a.index - b.index);

  for (const { host, index } of candidates) {
    const support = ACTIVITY_SUPPORTS[host.kind];
    if (!support) continue;
    const instanceId = host.instanceId ?? (host.kitIndex !== undefined ? `kit:${host.kitIndex}:piece:${index}` : `piece:${index}`);
    const rng = createRng(deriveSubSeed(WORLD_SEED, JSON.stringify(["activity-trace", roomId, activity, instanceId]), "props"));
    // Seeded pose first; an unrotated fallback and bounded grid also find
    // narrow real clear spots beside a lamp, without forcing placement.
    for (const yaw of [(rng() - .5) * .7, 0]) {
      const shapes = activityFootprintsAt(activity, yaw);
      let loX = -Infinity, hiX = Infinity, loZ = -Infinity, hiZ = Infinity;
      for (const p of shapes) {
        const half = halfBounds(p);
        loX = Math.max(loX, -support.hx + EDGE_GAP - p.x + half.x);
        hiX = Math.min(hiX, support.hx - EDGE_GAP - p.x - half.x);
        loZ = Math.max(loZ, -support.hz + EDGE_GAP - p.z + half.z);
        hiZ = Math.min(hiZ, support.hz - EDGE_GAP - p.z - half.z);
      }
      if (loX > hiX || loZ > hiZ) continue;
      const points = [{ x: rng(), z: rng() }, { x: .5, z: .5 }];
      for (const z of [0, .25, .5, .75, 1]) for (const x of [0, .25, .5, .75, 1]) points.push({ x, z });
      const occupied = occupancyFor(host, furniture);
      for (const point of points) {
        const lx = loX + point.x * (hiX - loX), lz = loZ + point.z * (hiZ - loZ);
        if (!shapes.every((p) => occupied.every((o) => missesCircle(p, lx, lz, o)))) continue;
        const world = rotate(lx * host.scale, lz * host.scale, host.rotY);
        return { kind: activity, x: host.x + world.x, z: host.z + world.z,
          y: host.y + ACTIVITY_SURFACE_HEIGHTS[host.kind] * host.scale,
          rotY: host.rotY + yaw, scale: host.scale, instanceId };
      }
    }
  }
  return null;
}

/** Semantic dressing gets first choice of the already-staged supports.
 * Only the old auto-generated trace is replaced; authored kit dressing
 * remains an obstacle. Failure leaves the complete original scene intact. */
export function resolveActivityDressing<T extends ActivityTraceHost>(
  activity: RoomActivity, roomId: string, furniture: readonly T[],
): { furniture: readonly T[]; trace: ActivityTraceItem | null } {
  if (activity === "neutral") return { furniture, trace: null };
  const withoutAutomaticTrace = furniture.filter((p) => p.trace !== true);
  const trace = activityTraceFor(activity, roomId, withoutAutomaticTrace);
  return { furniture: trace ? withoutAutomaticTrace : furniture, trace };
}
