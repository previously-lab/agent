/**
 * Memory-data fixture for the v0.10 memory-viz e2e specs — writes time-slice
 * files and the timeline catalog straight into the isolated MEMORY_ROOT (the
 * same dirs the webServer env got, see env.ts). Mirrors the on-disk contract
 * (v0.19 R2: records root, flat layout, slimmed frontmatter):
 *
 *   memory/records/YYYY/MM/DD/HHMM/core.md   (slice file)
 *   memory/episodic/timeline/index.json      (catalog — projection, unchanged)
 *
 * Only ever touches the `records/` + `episodic/timeline/` subtrees —
 * `config/settings.json` (seeded by prepare-env.mjs, shared with the other
 * specs) stays put.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { E2E_MEMORY_ROOT } from "./env";

export interface FixtureTurn {
  role: "user" | "agent";
  content: string;
  /** UTC ISO 8601 timestamp. */
  at: string;
  turnId?: string;
}

export interface FixtureSlice {
  /** Slice id YYYY-MM-DD-HHMM — encodes the UTC start (drives the file path). */
  id: string;
  /** UTC ISO 8601 start (must match the id's date+time). */
  start: string;
  end?: string;
  status?: "active" | "closed";
  focus?: string;
  summary?: string;
  tags?: string[];
  strands?: string[];
  continuesFrom?: string;
  /** time_cap | capacity | idle_gap | context_lost | user_explicit */
  closedBy?: string;
  turns: FixtureTurn[];
}

/** Paranoia guard, same discipline as prepare-env.mjs. */
function episodicRoot(): string {
  if (!E2E_MEMORY_ROOT.includes("previously-e2e")) {
    throw new Error(`memory-fixture: refusing unexpected path: ${E2E_MEMORY_ROOT}`);
  }
  return path.join(E2E_MEMORY_ROOT, "episodic");
}

/** Derive the slice id (YYYY-MM-DD-HHMM, UTC) from an ISO start time. */
export function sliceIdFromStart(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function sliceFileDir(id: string): string {
  const [y, m, d, hm] = id.split("-");
  if (!E2E_MEMORY_ROOT.includes("previously-e2e")) {
    throw new Error(`memory-fixture: refusing unexpected path: ${E2E_MEMORY_ROOT}`);
  }
  return path.join(E2E_MEMORY_ROOT, "records", y, m, d, hm);
}

/** JSON.stringify produces valid YAML double-quoted strings / flow arrays. */
function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

function yamlArray(arr: string[]): string {
  return JSON.stringify(arr);
}

function serializeSlice(slice: FixtureSlice): string {
  // v0.19 R2 slimmed header: status / tags / related_slices are no longer
  // written — status derives from closed_by on read, tags are dropped.
  const fm: string[] = [
    `slice_id: ${yamlScalar(slice.id)}`,
    `focus: ${yamlScalar(slice.focus ?? "")}`,
    `start: ${yamlScalar(slice.start)}`,
  ];
  if (slice.end) fm.push(`end: ${yamlScalar(slice.end)}`);
  fm.push(
    `timezone: "UTC"`,
    `summary: ${yamlScalar(slice.summary ?? "")}`,
    `open_loops: ${yamlArray([])}`,
    `decisions: ${yamlArray([])}`,
    `loops: []`,
  );
  if (slice.continuesFrom) fm.push(`continues_from: ${yamlScalar(slice.continuesFrom)}`);
  if (slice.closedBy) fm.push(`closed_by: ${slice.closedBy}`);

  const body = slice.turns
    .map(
      (t, i) =>
        `## Turn ${t.turnId ?? `ft${i}`} — ${t.at} (${t.role})\n\n${t.content}`,
    )
    .join("\n\n");

  return `---\n${fm.join("\n")}\n---\n\n${body}\n`;
}

/**
 * Write the slice files + the canonical timeline catalog (oldest → newest,
 * the weave's own ordering) into the isolated MEMORY_ROOT. The catalog is the
 * sole data source for the stream paging / search / timeline views, so both
 * must be written together — there is no housekeeping run in e2e to rebuild it.
 */
export async function seedSlices(slices: FixtureSlice[]): Promise<void> {
  const sorted = [...slices].sort((a, b) => a.id.localeCompare(b.id));
  for (const slice of sorted) {
    const dir = sliceFileDir(slice.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "core.md"), serializeSlice(slice), "utf8");
  }

  const catalog = {
    _schema: 1,
    updated_at: new Date().toISOString(),
    slice_count: sorted.length,
    needs_marking: 0,
    slices: sorted.map((s) => ({
      id: s.id,
      date: s.id.slice(0, 10),
      start: s.start,
      ...(s.end ? { end: s.end } : {}),
      turn_count: s.turns.length,
      status: s.status ?? "closed",
      focus: s.focus ?? "",
      summary: s.summary ?? "",
      tags: s.tags ?? [],
      open_loops: [],
      decisions: [],
      strands: s.strands ?? [],
      needs_marking: false,
      ...(s.continuesFrom ? { continues_from: s.continuesFrom } : {}),
      ...(s.closedBy ? { closed_by: s.closedBy } : {}),
    })),
  };
  const timelineDir = path.join(episodicRoot(), "timeline");
  await mkdir(timelineDir, { recursive: true });
  await writeFile(
    path.join(timelineDir, "index.json"),
    JSON.stringify(catalog, null, 2),
    "utf8",
  );
}

/** Remove the seeded subtrees (per-test isolation). */
export async function clearEpisodic(): Promise<void> {
  await rm(episodicRoot(), { recursive: true, force: true });
  // records/ too: the read surface is LIVE-TREE enumeration now (v0.19 R3b —
  // there is no catalog projection to clear), so wiping only `episodic/`
  // left every earlier test's slice files readable and the next test arrived
  // to a memory it never seeded (a leftover ACTIVE slice flips the arrival
  // gate from briefing to resume).
  if (!E2E_MEMORY_ROOT.includes("previously-e2e")) {
    throw new Error(`memory-fixture: refusing unexpected path: ${E2E_MEMORY_ROOT}`);
  }
  await rm(path.join(E2E_MEMORY_ROOT, "records"), { recursive: true, force: true });
}

// ─── Case fixtures (the archive field's piles, v0.25a §四) ─────────────────
// A case lives at memory/<category>/<case>/: an `index.md` (frontmatter
// `opened: 'YYYY-MM-DD'`) plus dated pieces `<YYYY-MM-DD>-<标题>.md`. The
// category list mirrors CASE_CATEGORIES in src/lib/docs/paths.ts — e2e files
// never import from src (Playwright resolves no "@/" alias), so the fixture
// keeps its own copy of the on-disk contract, same as the slice serializer
// above.

const CASE_CATEGORY_DIRS = [
  "people",
  "events",
  "things",
  "places",
  "orgs",
  "research",
  "hypotheses",
  "tasks",
  "self",
] as const;

export interface FixtureCase {
  /** One of the nine case categories (see CASE_CATEGORY_DIRS). */
  category: string;
  /** The case directory name (plain or `<YYYY-MM-DD>-<标题>`). */
  name: string;
  /** Birth stamp for the index header; "" writes no `opened` line. */
  opened: string;
  /** Dated pieces — each becomes one `<date>-<title>.md` sheet in the pile. */
  pieces: { date: string; title: string }[];
}

function casesGuard(): void {
  if (!E2E_MEMORY_ROOT.includes("previously-e2e")) {
    throw new Error(`memory-fixture: refusing unexpected path: ${E2E_MEMORY_ROOT}`);
  }
}

/** Write case directories straight into the isolated MEMORY_ROOT. */
export async function seedCases(cases: FixtureCase[]): Promise<void> {
  casesGuard();
  for (const c of cases) {
    const dir = path.join(E2E_MEMORY_ROOT, c.category, c.name);
    await mkdir(dir, { recursive: true });
    const fm = c.opened ? `opened: ${JSON.stringify(c.opened)}\n` : "";
    await writeFile(
      path.join(dir, "index.md"),
      `---\n${fm}---\n\nCase ${c.name} — the seeded index.\n`,
      "utf8",
    );
    for (const piece of c.pieces) {
      await writeFile(
        path.join(dir, `${piece.date}-${piece.title}.md`),
        `---\nopened: ${JSON.stringify(piece.date)}\n---\n\nPiece ${piece.title} of ${c.name}.\n`,
        "utf8",
      );
    }
  }
}

/** Remove the nine category subtrees (per-test isolation). config/ stays. */
export async function clearCases(): Promise<void> {
  casesGuard();
  for (const category of CASE_CATEGORY_DIRS) {
    await rm(path.join(E2E_MEMORY_ROOT, category), {
      recursive: true,
      force: true,
    });
  }
}

// ─── Dossier fixtures (the library's pinned section, v0.25b §三) ───────────
// The two self-documents the Dossier reads — paths mirror DOSSIER_PATHS in
// src/lib/archive/actions.ts (e2e files never import from src, so the
// fixture keeps its own copy of the contract, same as the serializers above).

const DOSSIER_FILES = {
  previously: path.join("episodic", "current-previously.md"),
  direction: path.join("evolution", "direction.md"),
} as const;

/** Sentinel body — specs assert on this exact text on the desk. */
export function dossierSentinel(name: keyof typeof DOSSIER_FILES): string {
  return `DOSSIER ${name} sentinel body`;
}

/** Write both Dossier documents into the isolated MEMORY_ROOT. */
export async function seedDossier(): Promise<void> {
  casesGuard();
  for (const name of Object.keys(DOSSIER_FILES) as (keyof typeof DOSSIER_FILES)[]) {
    const file = path.join(E2E_MEMORY_ROOT, DOSSIER_FILES[name]);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${dossierSentinel(name)}\n`, "utf8");
  }
}

/** Remove both Dossier documents (per-test isolation). */
export async function clearDossier(): Promise<void> {
  casesGuard();
  for (const rel of Object.values(DOSSIER_FILES)) {
    await rm(path.join(E2E_MEMORY_ROOT, rel), { force: true });
  }
}

/** A two-turn (user + agent) slice at a given UTC start, with sentinel
 *  content so specs can assert on exact text. */
export function makeSlice(
  startIso: string,
  opts: Partial<FixtureSlice> & { tag?: string } = {},
): FixtureSlice {
  const id = sliceIdFromStart(startIso);
  const start = new Date(startIso).getTime();
  const endIso = new Date(start + 20 * 60_000).toISOString();
  const tag = opts.tag ?? id;
  return {
    id,
    start: startIso,
    end: endIso,
    status: "closed",
    focus: opts.focus ?? `Focus of ${tag}`,
    summary: opts.summary ?? `Summary of ${tag}`,
    tags: opts.tags ?? [],
    strands: opts.strands ?? [],
    continuesFrom: opts.continuesFrom,
    closedBy: opts.closedBy ?? "idle_gap",
    turns: [
      { role: "user", content: `TURN ${tag} user question`, at: startIso },
      {
        role: "agent",
        content: `TURN ${tag} agent answer`,
        at: new Date(start + 60_000).toISOString(),
      },
    ],
  };
}
