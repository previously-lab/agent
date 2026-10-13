/**
 * Turn-merge helper for the finalize-turn write-conflict self-heal.
 *
 * When a turn's batched commit loses a non-fast-forward race on GitHub
 * (another turn or process committed to the branch first), the queued slice
 * file was computed from a STALE base. Turns are append-only, so the merge is
 * mechanical: re-parse the remote core.md, append every local turn the remote
 * is missing (keyed by turnId), union the loop pointers, and re-serialize.
 * The caller swaps the merged content into the batch and retries the commit.
 *
 * Pure module — no I/O — so it is unit-testable and safe to import anywhere.
 */
import { parseSlice, serializeSlice } from "./manager";
import type { TimeSlice, Turn } from "./types";

/**
 * Identity key for a turn. New turns carry a turnId; legacy numeric-labeled
 * turns parsed from old files have none, so fall back to a content fingerprint.
 */
function turnKey(turn: Turn): string {
  return (
    turn.turnId ??
    `${turn.timestamp}|${turn.role}|${turn.content.slice(0, 64)}`
  );
}

/**
 * Merge `local`'s turns into the remote slice body. Returns the re-serialized
 * slice. The REMOTE frontmatter wins (it may carry state — close marking,
 * closed_by — written after our snapshot was computed); only turns and loop
 * pointers are unioned in (tags are no longer persisted, v0.19 R2).
 */
export function mergeTurnsWithRemote(
  remoteRaw: string,
  local: TimeSlice,
): string {
  const remote = parseSlice(remoteRaw);

  const seen = new Set(remote.turns.map(turnKey));
  for (const turn of local.turns) {
    const key = turnKey(turn);
    if (seen.has(key)) continue;
    seen.add(key);
    remote.turns.push(turn);
  }

  for (const loopId of local.loops) {
    if (!remote.loops.includes(loopId)) remote.loops.push(loopId);
  }

  return serializeSlice(remote);
}

/**
 * Merge disk-only turns into the IN-MEMORY slice (the episode-append race).
 * The messages route appends nested-episode user turns straight to the slice
 * file mid-reply, while the outer run keeps riding the snapshot it loaded at
 * turn start — without this union, the run's next snapshot write is computed
 * from that stale base and silently erases the route-appended turns. Mutates
 * `slice`; returns the number of turns appended. Disk-only turns append at
 * the end UNORDERED (same semantics as mergeTurnsWithRemote); the in-memory
 * frontmatter wins — the caller may carry state (a fresh close marking) the
 * disk does not have yet.
 */
export function mergeDiskTurnsIntoSlice(
  slice: TimeSlice,
  diskRaw: string,
): number {
  const disk = parseSlice(diskRaw);

  const seen = new Set(slice.turns.map(turnKey));
  let added = 0;
  for (const turn of disk.turns) {
    const key = turnKey(turn);
    if (seen.has(key)) continue;
    seen.add(key);
    slice.turns.push(turn);
    added++;
  }

  for (const loopId of disk.loops) {
    if (!slice.loops.includes(loopId)) slice.loops.push(loopId);
  }

  return added;
}
