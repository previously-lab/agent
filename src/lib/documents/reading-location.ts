import type { DocumentEdition, DocumentLinkLocation } from "./document-link";

export interface DeskReadingLocation {
  edition: DocumentEdition;
  page: number;
  zoom: number;
  fit: boolean;
  panX: number;
  panY: number;
  initialSignature?: string;
}

interface StoredEntry {
  key: string;
  location: DeskReadingLocation;
}

interface ReadingLocationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_KEY = "previously:reading-locations:v1";
const MAX_LOCATIONS = 24;

function identity(scope: string, persona: string, ref: string): string {
  return JSON.stringify([scope, persona, ref]);
}

export function initialLocationSignature(location: DocumentLinkLocation | undefined): string {
  return JSON.stringify([
    location?.turnId ?? null,
    location?.role ?? null,
    location?.edition ?? null,
  ]);
}

function parseLocation(value: unknown): DeskReadingLocation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.edition !== "current" && candidate.edition !== "original" && candidate.edition !== "history") ||
    !Number.isInteger(candidate.page) || (candidate.page as number) < 1 || (candidate.page as number) > 100_000 ||
    typeof candidate.zoom !== "number" || !Number.isFinite(candidate.zoom) || candidate.zoom < 0.05 || candidate.zoom > 8 ||
    typeof candidate.fit !== "boolean" ||
    typeof candidate.panX !== "number" || !Number.isFinite(candidate.panX) || Math.abs(candidate.panX) > 1_000_000 ||
    typeof candidate.panY !== "number" || !Number.isFinite(candidate.panY) || Math.abs(candidate.panY) > 1_000_000 ||
    (candidate.initialSignature !== undefined && (typeof candidate.initialSignature !== "string" || candidate.initialSignature.length > 512))
  ) {
    return null;
  }
  return {
    edition: candidate.edition,
    page: candidate.page as number,
    zoom: candidate.zoom,
    fit: candidate.fit,
    panX: candidate.panX,
    panY: candidate.panY,
    ...(candidate.initialSignature === undefined ? {} : { initialSignature: candidate.initialSignature }),
  };
}

function entries(raw: string | null): StoredEntry[] {
  if (!raw || raw.length > 65_536) return [];
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.slice(0, MAX_LOCATIONS).flatMap((entry): StoredEntry[] => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.key !== "string" || candidate.key.length > 2_048) return [];
      const location = parseLocation(candidate.location);
      return location ? [{ key: candidate.key, location }] : [];
    });
  } catch {
    return [];
  }
}

export function readDeskReadingLocation(
  storage: ReadingLocationStorage | null,
  scope: string,
  persona: string,
  ref: string,
): DeskReadingLocation | null {
  if (!storage) return null;
  const key = identity(scope, persona, ref);
  try {
    return entries(storage.getItem(STORE_KEY)).find((entry) => entry.key === key)?.location ?? null;
  } catch {
    return null;
  }
}

export function writeDeskReadingLocation(
  storage: ReadingLocationStorage | null,
  scope: string,
  persona: string,
  ref: string,
  location: DeskReadingLocation,
): void {
  if (!storage || !parseLocation(location)) return;
  const key = identity(scope, persona, ref);
  try {
    const next = [
      { key, location },
      ...entries(storage.getItem(STORE_KEY)).filter((entry) => entry.key !== key),
    ].slice(0, MAX_LOCATIONS);
    storage.setItem(STORE_KEY, JSON.stringify({ version: 1, entries: next }));
  } catch {
    // Storage is a convenience; denied or full storage never blocks reading.
  }
}
