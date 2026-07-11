/**
 * Server-side loader for docs markdown bodies. Reads plain Markdown from
 * `content/docs/{locale}/{slug}.md` at request/build time. Falls back to the
 * English page when a localized file is missing, so a partially-translated set
 * still renders.
 *
 * Uses `fs`, so it only runs on the server (Node runtime) — never import from a
 * Client Component.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import type { Locale } from "./manifest";

async function tryRead(locale: Locale, slug: string): Promise<string | null> {
  try {
    return await readFile(
      join(process.cwd(), "content", "docs", locale, `${slug}.md`),
      "utf-8",
    );
  } catch {
    return null;
  }
}

export async function getDocMarkdown(
  locale: Locale,
  slug: string,
): Promise<string | null> {
  const primary = await tryRead(locale, slug);
  if (primary !== null) return primary;
  if (locale !== "en") return tryRead("en", slug);
  return null;
}
