"use server";

import { getDossierList } from "@/lib/archive/actions";
import { setDemoPersona } from "@/lib/demo/demo-fs";
import { enumerateTreePaths } from "@/lib/episodic/timeline/enumerate";
import {
  CASE_CATEGORIES,
  isValidCaseName,
  isValidPieceFileName,
  parsePieceFileName,
} from "@/lib/docs";
import { parseCanonicalDocumentRef } from "@/lib/documents/document-link";
import { parseSliceId } from "@/lib/episodic/turn-parser";

export type DocumentCatalogItem = {
  ref: string;
  title: string;
  kind: "case" | "piece" | "record" | "dossier";
  category?: string;
};

export type DocumentCatalogPage = {
  items: DocumentCatalogItem[];
  nextCursor: string | null;
};

export type DocumentCatalogQuery = {
  query?: string;
  cursor?: string;
  limit?: number;
  persona?: string;
};

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 20;
const MAX_QUERY_CHARS = 120;

function displayTitle(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 157)}…`;
}

function searchFold(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export async function searchDocumentCatalog(
  input: DocumentCatalogQuery,
): Promise<DocumentCatalogPage> {
  const request = input && typeof input === "object" ? input : {};
  const persona = typeof request.persona === "string" ? request.persona.slice(0, 128) : undefined;
  if (persona) setDemoPersona(persona);
  const query = searchFold((typeof request.query === "string" ? request.query : "").trim().slice(0, MAX_QUERY_CHARS));
  const cursor = typeof request.cursor === "string" && /^\d+$/.test(request.cursor)
    ? Number.parseInt(request.cursor, 10)
    : 0;
  const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const limit = typeof request.limit === "number" && Number.isInteger(request.limit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, request.limit))
    : DEFAULT_PAGE_SIZE;
  const [paths, dossier] = await Promise.all([enumerateTreePaths("memory"), getDossierList(persona)]);
  const byRef = new Map<string, DocumentCatalogItem>();
  const add = (item: DocumentCatalogItem): void => {
    const ref = parseCanonicalDocumentRef(item.ref);
    if (!ref || byRef.has(ref)) return;
    byRef.set(ref, { ...item, ref, title: displayTitle(item.title) });
  };
  for (const entry of dossier) {
    if (entry.available) {
      add({
        ref: entry.ref,
        title: entry.name === "previously" ? "Previously" : "Direction",
        kind: "dossier",
        category: "dossier",
      });
    }
  }
  const categories = new Set<string>(CASE_CATEGORIES);
  for (const path of paths) {
    const segments = path.split("/");
    if (segments[0] !== "memory") continue;
    const category = segments[1] ?? "";
    if (categories.has(category)) {
      const name = segments[2] ?? "";
      const fileName = segments[3] ?? "";
      if (segments.length === 4 && fileName === "index.md" && isValidCaseName(name)) {
        add({ ref: `${category}/${name}`, title: name, kind: "case", category });
      } else if (segments.length === 4 && isValidCaseName(name) && isValidPieceFileName(fileName)) {
        const stem = fileName.replace(/\.md$/, "");
        add({
          ref: `${category}/${name}/${stem}`,
          title: parsePieceFileName(fileName)?.title ?? stem,
          kind: "piece",
          category,
        });
      }
      continue;
    }
    let rel = "";
    if (category === "records") rel = segments.slice(2, 6).join("/");
    else if (category === "episodic" && segments[2] === "slices") rel = segments.slice(3, 7).join("/");
    if (/^\d{4}\/\d{2}\/\d{2}\/\d{4}$/.test(rel)) {
      const sliceId = rel.replaceAll("/", "-");
      if (parseSliceId(sliceId)) add({ ref: `records/${sliceId}`, title: sliceId, kind: "record", category: "records" });
    }
  }
  const catalog = [...byRef.values()];
  const matches = catalog.filter((item) => {
    if (!query) return true;
    return searchFold(item.title).includes(query) ||
      searchFold(item.ref).includes(query) ||
      (item.category ? searchFold(item.category).includes(query) : false);
  });
  matches.sort((a, b) => {
    if (!query) {
      if (a.kind !== b.kind) {
        const rank = { dossier: 0, record: 1, case: 2, piece: 3 } as const;
        return rank[a.kind] - rank[b.kind];
      }
      return a.kind === "record" ? b.ref.localeCompare(a.ref) : a.ref.localeCompare(b.ref);
    }
    const aTitle = searchFold(a.title);
    const bTitle = searchFold(b.title);
    const aPrefix = aTitle.startsWith(query) ? 0 : 1;
    const bPrefix = bTitle.startsWith(query) ? 0 : 1;
    return aPrefix - bPrefix || aTitle.localeCompare(bTitle) || a.ref.localeCompare(b.ref);
  });
  const items = matches.slice(offset, offset + limit);
  return {
    items,
    nextCursor: offset + items.length < matches.length ? String(offset + items.length) : null,
  };
}
