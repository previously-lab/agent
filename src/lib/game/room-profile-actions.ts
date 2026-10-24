"use server";

import { parseRecordRef } from "@/lib/archive/refs";
import { resolveDataSource, type DataSource } from "@/lib/data-source/resolve";
import { readFileDemo } from "@/lib/demo/demo-fs";
import { parseSlice } from "@/lib/episodic/manager";
import { fsReadFile } from "@/lib/episodic/io-helpers";
import { slicePartPathCandidates } from "@/lib/episodic/paths";
import { withGitHubReadBudget } from "@/lib/github/client";
import {
  deriveRoomProfile,
  NEUTRAL_ROOM_PROFILE,
  type RoomProfile,
} from "./room-profile";

export type RoomProfileStatus = "ready" | "missing" | "unavailable";

export interface RoomProfileResult {
  readonly status: RoomProfileStatus;
  /** unavailable is retryable; ready + neutral is a real no-evidence result. */
  readonly profile: RoomProfile;
}

function isValidRecordId(sliceId: string): boolean {
  const parsed = parseRecordRef(`records/${sliceId}`);
  if (!parsed || parsed.sliceId !== sliceId) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/.exec(sliceId);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match;
  const parts = [year, month, day, hour, minute].map(Number);
  const [y, mo, d, h, mi] = parts;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi
  );
}

function isMissingRecordError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; code?: unknown };
    if (candidate.status === 404 || candidate.code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:File not found:|ENOENT\b)/i.test(message);
}

function isValidPersona(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

async function readCoreForRoomProfile(
  sliceId: string,
  source: DataSource,
  persona: string,
): Promise<string> {
  const [primary, legacy] = slicePartPathCandidates(sliceId, "core");
  const read = (path: string): Promise<string> =>
    source === "demo" ? readFileDemo(path, persona) : fsReadFile(path);
  try {
    return await read(primary);
  } catch (error) {
    if (!isMissingRecordError(error)) throw error;
  }
  return read(legacy);
}

/** One record, one logical core read; no catalog, case scan, model or writes. */
export async function getRoomProfile(
  sliceId: string,
  persona?: string,
): Promise<RoomProfileResult> {
  const requestPersona = persona ?? "user";
  if (
    typeof sliceId !== "string" ||
    !isValidRecordId(sliceId) ||
    !isValidPersona(requestPersona)
  ) {
    return { status: "missing", profile: NEUTRAL_ROOM_PROFILE };
  }

  try {
    const source = resolveDataSource();
    const raw = await withGitHubReadBudget(() =>
      readCoreForRoomProfile(sliceId, source, requestPersona),
    );
    const slice = parseSlice(raw);
    const profile = deriveRoomProfile({
      focus: slice.focus,
      summary: slice.summary,
      tags: slice.tags,
      decisions: slice.decisions,
      open_loops: slice.open_loops,
      turns: slice.turns,
    });
    return { status: "ready", profile };
  } catch (error) {
    return {
      status: isMissingRecordError(error) ? "missing" : "unavailable",
      profile: NEUTRAL_ROOM_PROFILE,
    };
  }
}
