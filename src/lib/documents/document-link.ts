import { parseDossierRef, parseRecordRef } from "@/lib/archive/refs";
import { parseCaseRef } from "@/lib/docs/case-refs";
import { isValidDate } from "@/lib/docs/naming";
import { parseSliceId } from "@/lib/episodic/turn-parser";

export const DOCUMENT_LINK_SCHEME = "previously:";
export const DOCUMENT_EDITIONS = ["current", "original", "history"] as const;

export type DocumentEdition = (typeof DOCUMENT_EDITIONS)[number];
export type DocumentTurnRole = "user" | "assistant";

export interface DocumentLinkLocation {
  turnId?: string;
  role?: DocumentTurnRole;
  edition?: DocumentEdition;
}

export interface ParsedDocumentLink extends DocumentLinkLocation {
  ref: string;
}

const MAX_REF_LENGTH = 512;
const MAX_TURN_ID_LENGTH = 128;
const TURN_ID_RE = /^[A-Za-z0-9_-]+$/;
const UNSAFE_REF_RE = /[\p{Cc}\p{Cf}?#\\]/u;

function validLocation(location: DocumentLinkLocation): boolean {
  if (location.turnId !== undefined) {
    if (
      location.turnId.length === 0 ||
      location.turnId.length > MAX_TURN_ID_LENGTH ||
      !TURN_ID_RE.test(location.turnId)
    ) {
      return false;
    }
  }
  if (location.role !== undefined && location.role !== "user" && location.role !== "assistant") {
    return false;
  }
  if (location.edition !== undefined && !DOCUMENT_EDITIONS.includes(location.edition)) {
    return false;
  }
  return true;
}

export function parseCanonicalDocumentRef(ref: unknown): string | null {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    ref !== ref.trim() ||
    UNSAFE_REF_RE.test(ref) ||
    /%[0-9a-f]{2}/i.test(ref) ||
    /[《》]/.test(ref)
  ) {
    return null;
  }
  const segments = ref.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  if (segments[0] === "records") {
    const record = parseRecordRef(ref);
    const slice = record ? parseSliceId(record.sliceId) : null;
    if (!record || !slice || !isValidDate(`${slice.y}-${slice.m}-${slice.d}`)) return null;
    const hour = Number(slice.hm.slice(0, 2));
    const minute = Number(slice.hm.slice(2, 4));
    return hour < 24 && minute < 60 ? ref : null;
  }
  if (segments[0] === "dossier") {
    return parseDossierRef(ref) ? ref : null;
  }
  const parsed = parseCaseRef(ref);
  if (!parsed) return null;
  if (parsed.kind === "legacy") {
    return segments.length === 1 ? parsed.name : null;
  }
  if (parsed.kind === "case") {
    return `${parsed.category}/${parsed.caseName}`;
  }
  return `${parsed.category}/${parsed.caseName}/${parsed.pieceFileName.replace(/\.md$/, "")}`;
}

function decodeRef(rawRef: string): string | null {
  if (rawRef.length === 0 || rawRef !== rawRef.trim() || /\s/.test(rawRef)) return null;
  try {
    const decoded = rawRef
      .split("/")
      .map((segment) => {
        const value = decodeURIComponent(segment);
        return /[\\/]/.test(value) ? "" : value;
      })
      .join("/");
    return parseCanonicalDocumentRef(decoded);
  } catch {
    return null;
  }
}

export function parseDocumentLink(href: unknown): ParsedDocumentLink | null {
  if (typeof href !== "string" || !href.startsWith(DOCUMENT_LINK_SCHEME)) return null;
  const source = href.slice(DOCUMENT_LINK_SCHEME.length);
  if (source.includes("#")) return null;
  const queryAt = source.indexOf("?");
  const rawRef = queryAt < 0 ? source : source.slice(0, queryAt);
  const ref = decodeRef(rawRef);
  if (!ref) return null;
  if (queryAt < 0) return { ref };

  const query = source.slice(queryAt + 1);
  if (!query || query.includes("?") || /%(?![0-9a-f]{2})/i.test(query)) return null;
  const seen = new Set<string>();
  const location: DocumentLinkLocation = {};
  for (const [key, value] of new URLSearchParams(query)) {
    if (seen.has(key) || seen.size === 3 || value === "") return null;
    seen.add(key);
    if (key === "turn") {
      if (value.length > MAX_TURN_ID_LENGTH || !TURN_ID_RE.test(value)) return null;
      location.turnId = value;
    } else if (key === "role") {
      if (value !== "user" && value !== "assistant") return null;
      location.role = value;
    } else if (key === "edition") {
      if (!DOCUMENT_EDITIONS.includes(value as DocumentEdition)) return null;
      location.edition = value as DocumentEdition;
    } else {
      return null;
    }
  }
  return { ref, ...location };
}

function encodeRefCharacter(character: string): string {
  if (character === "%") return "%25";
  if (character === "(") return "%28";
  if (character === ")") return "%29";
  return encodeURIComponent(character);
}

function encodeRef(ref: string): string {
  return ref
    .split("/")
    .map((segment) => segment.replace(/[%\s()]/g, encodeRefCharacter))
    .join("/");
}

export function formatDocumentLink(
  link: string | ParsedDocumentLink,
  location: DocumentLinkLocation = {},
): string | null {
  const base = typeof link === "string" ? { ref: link } : link;
  const ref = parseCanonicalDocumentRef(base.ref);
  const combined = typeof link === "string"
    ? location
    : {
        ...(base.turnId === undefined ? {} : { turnId: base.turnId }),
        ...(base.role === undefined ? {} : { role: base.role }),
        ...(base.edition === undefined ? {} : { edition: base.edition }),
        ...location,
      };
  if (!ref || !validLocation(combined)) return null;

  const params = new URLSearchParams();
  if (combined.turnId !== undefined) params.set("turn", combined.turnId);
  if (combined.role !== undefined) params.set("role", combined.role);
  if (combined.edition !== undefined) params.set("edition", combined.edition);
  const query = params.toString();
  return `${DOCUMENT_LINK_SCHEME}${encodeRef(ref)}${query ? `?${query}` : ""}`;
}

export function documentLabelFallback(ref: unknown): string | null {
  const canonical = parseCanonicalDocumentRef(ref);
  if (!canonical) return null;
  const record = parseRecordRef(canonical);
  if (record) return record.sliceId;
  const dossier = parseDossierRef(canonical);
  if (dossier) return dossier.name === "previously" ? "Previously on" : "Direction";
  const parsed = parseCaseRef(canonical);
  if (!parsed) return null;
  const label = parsed.kind === "piece"
    ? parsed.pieceFileName.replace(/\.md$/, "")
    : parsed.kind === "case"
      ? parsed.caseName
      : parsed.name;
  return label.replace(/^\d{4}-\d{2}-\d{2}-/, "") || label;
}
