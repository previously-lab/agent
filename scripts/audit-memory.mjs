/**
 * Audit an episodic memory dataset (DRY-RUN, no LLM calls).
 *
 * Default target: C:/Users/Dream/Documents/GitHub/agent/memory/episodic
 * (the real data repo — Aftrbrez's own memory/ is an old test copy, never touched)
 *
 * Checks:
 *  - slice count on disk vs timeline/index.json (+ optional manifest.json cross-check)
 *  - empty slices (no turns in body)
 *  - frontmatter field census + slices missing expected fields
 *  - slices missing focus/summary (step-2 backfill targets)
 *  - needs_marking residue (index top-level, per-slice flags, core.md text)
 *  - orphans: index↔disk both ways, strands.json refs↔disk both ways
 *  - strands.json integrity — accepts BOTH shapes: tag -> slice-path[] (agent/you
 *    layout) and tag -> count (README layout); count-only entries are
 *    reverse-mapped from each slice's frontmatter `tags`
 *  - full strand keyword list with slice counts
 *  - the exact file manifest step 2 (scripts/backfill-memory.mjs) would touch
 *
 * Run:  node scripts/audit-memory.mjs [--root <episodicDir>] [--name <slug>]
 *       [--lang zh|en] [--manifest <manifest.json>] [--rel-base <displayPrefix>]
 * Out:  reports/overnight/audit-<name>-<date>.md (+ console summary)
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ─── Args ─────────────────────────────────────────────────────────────
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const EPISODIC = arg("root", "C:/Users/Dream/Documents/GitHub/agent/memory/episodic");
const NAME = arg("name", "memory");
const LANG = arg("lang", "zh");
const MANIFEST_PATH = arg("manifest", null);
const REL_BASE = arg("rel-base", "memory/episodic"); // display prefix for file paths in the report

const SLICES = path.join(EPISODIC, "slices");
const INDEX_JSON = path.join(EPISODIC, "timeline", "index.json");
const STRANDS_JSON = path.join(EPISODIC, "strands.json");
const STRANDS_DIR = path.join(EPISODIC, "strands");

const EXPECTED_FM = [
  "slice_id", "status", "start", "timezone",
  "open_loops", "decisions", "tags", "related_slices", "loops",
  "focus", "summary",
];
const OPTIONAL_FM = [
  "end", "emotional_tone", "closed_by", "evolution_summary", "continues_from",
];

const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
const today = nowLocal.toISOString().slice(0, 10);
const reportPath = path.join(ROOT, "reports", "overnight", `audit-${NAME}-${today}.md`);

// ─── Filesystem helpers ───────────────────────────────────────────────

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Collect all slice dirs matching YYYY/MM/DD/HHMM (ignores non-dated debris). */
async function collectSliceDirs(root) {
  const out = [];
  const years = await fsp.readdir(root, { withFileTypes: true });
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const mo of await fsp.readdir(path.join(root, y.name), { withFileTypes: true })) {
      if (!mo.isDirectory() || !/^\d{2}$/.test(mo.name)) continue;
      for (const d of await fsp.readdir(path.join(root, y.name, mo.name), { withFileTypes: true })) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        for (const s of await fsp.readdir(path.join(root, y.name, mo.name, d.name), { withFileTypes: true })) {
          if (s.isDirectory() && /^\d{4}$/.test(s.name)) {
            out.push(path.join(root, y.name, mo.name, d.name, s.name));
          }
        }
      }
    }
  }
  return out;
}

/** Raw frontmatter text + body, CRLF-tolerant, no YAML lib (read-only audit). */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fmText: null, body: raw };
  return { fmText: m[1], body: raw.slice(m[0].length) };
}

function fmFields(fmText) {
  const fields = new Set();
  if (fmText == null) return fields;
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+):/);
    if (m) fields.add(m[1]);
  }
  return fields;
}

/** Parse the `tags:` frontmatter field — block list and inline list forms. */
function parseTags(fmText) {
  const block = fmText.match(/^tags:\r?\n((?:\s+-\s+.+\r?\n)*)/m);
  if (block) {
    return block[1].split(/\r?\n/).map((l) => l.match(/^\s+-\s+(.+?)\s*$/)?.[1]).filter(Boolean);
  }
  const inline = fmText.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1].split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function parseTurns(body) {
  const turns = [];
  const parts = body.split(/^## Turn /m);
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^(\S+) — (\S+) \((\w+)\)\r?\n\r?\n([\s\S]*)$/m);
    if (!m) continue;
    turns.push({ role: m[3], ts: m[2] });
  }
  return turns;
}

const relSlicePath = (dir) => {
  const m = dir.match(/slices[\\/]+(\d{4})[\\/]+(\d{2})[\\/]+(\d{2})[\\/]+(\d{4})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
};
const sliceIdOf = (rel) => rel.replace(/\//g, "-"); // matches timeline/index.json ids in both repos
const safeStrandFilename = (name) => name.replace(/[/\\:*?"<>|]/g, "-").trim();
const displayPath = (rel) => `${REL_BASE.replace(/\/$/, "")}/${rel}`;

// ─── Audit ────────────────────────────────────────────────────────────

const index = JSON.parse(await fsp.readFile(INDEX_JSON, "utf8"));
const strands = JSON.parse(await fsp.readFile(STRANDS_JSON, "utf8"));

const dirs = await collectSliceDirs(SLICES);
const disk = []; // { rel, id, corePath, fields, turns }
const census = {};
const tagToRefs = new Map(); // tag -> [slice rel paths] (reverse index from frontmatter tags)
const noFrontmatter = [];
const missingExpected = [];
const missingFocusSummary = [];
const emptySlices = [];
const activeSlices = [];

for (const dir of dirs) {
  const rel = relSlicePath(dir);
  const corePath = path.join(dir, "timeline", "core.md");
  if (!(await exists(corePath))) continue;
  const raw = await fsp.readFile(corePath, "utf8");
  const { fmText, body } = splitFrontmatter(raw);
  if (fmText == null) { noFrontmatter.push(rel); continue; }
  const fields = fmFields(fmText);
  for (const f of fields) census[f] = (census[f] || 0) + 1;
  for (const tag of parseTags(fmText)) {
    if (!tagToRefs.has(tag)) tagToRefs.set(tag, []);
    tagToRefs.get(tag).push(rel);
  }
  const absent = EXPECTED_FM.filter((f) => !fields.has(f));
  if (absent.length) missingExpected.push({ rel, absent });
  if (!fields.has("focus") || !fields.has("summary")) {
    const turns = parseTurns(body);
    missingFocusSummary.push({
      id: sliceIdOf(rel), rel,
      missing: [!fields.has("focus") && "focus", !fields.has("summary") && "summary"].filter(Boolean),
      userTurns: turns.filter((t) => t.role === "user").length,
      agentTurns: turns.filter((t) => t.role === "agent" || t.role === "assistant").length,
    });
  }
  if (!/^## Turn /m.test(body)) emptySlices.push({ rel });
  if (/^status:\s*active/m.test(fmText)) activeSlices.push(sliceIdOf(rel));
  disk.push({ rel, id: sliceIdOf(rel), corePath, fields, turns: parseTurns(body) });
}

const diskIds = new Set(disk.map((d) => d.id));
const diskPaths = new Set(disk.map((d) => d.rel));
const indexIds = index.slices.map((s) => s.id);

// needs_marking residue
const indexFlagged = index.slices.filter((s) => s.needs_marking);
const fmNeedsMarking = [];
for (const d of disk) {
  const raw = await fsp.readFile(d.corePath, "utf8");
  if (/^needs_marking:\s*true/m.test(raw)) fmNeedsMarking.push(d.id);
}

// orphans
const indexNotOnDisk = indexIds.filter((id) => !diskIds.has(id));
const diskNotInIndex = [...diskIds].filter((id) => !indexIds.includes(id));

// strands integrity — resolves BOTH index shapes to refs:
//   tag -> ["YYYY/MM/DD/HHMM", ...]  (path index)
//   tag -> count                      (count index, reverse-mapped from frontmatter tags)
const PATH_REF = /^\d{4}\/\d{2}\/\d{2}\/\d{4}$/;
const strandKeys = Object.keys(strands);
const strandRefs = new Map(); // key -> string[] (resolved)
const strandBadShape = [];
const strandBadPattern = [];
const strandDupRefs = [];
const strandMissingOnDisk = [];
const strandFromCounts = []; // keys resolved via the count-index fallback
let strandRefTotal = 0;
for (const k of strandKeys) {
  const v = strands[k];
  let refs = null;
  if (Array.isArray(v) && v.every((p) => typeof p === "string" && PATH_REF.test(p))) {
    refs = v;
  } else if (typeof v === "number" || (Array.isArray(v) && v.every((p) => typeof p === "string"))) {
    // count index (or a non-path string array): reverse-map from slice frontmatter tags
    refs = tagToRefs.get(k) ?? [];
    strandFromCounts.push(k);
  } else {
    strandBadShape.push(k);
    continue;
  }
  strandRefs.set(k, refs);
  strandRefTotal += refs.length;
  if (new Set(refs).size !== refs.length) strandDupRefs.push(k);
  for (const p of refs) {
    if (!PATH_REF.test(p)) strandBadPattern.push(`${k} -> ${p}`);
    else if (!diskPaths.has(p)) strandMissingOnDisk.push(`${k} -> ${p}`);
  }
}
const inStrand = new Set([...strandRefs.values()].flat());
const diskNotInAnyStrand = [...diskPaths].filter((p) => !inStrand.has(p));

// optional manifest.json cross-check
let manifestInfo = null;
if (MANIFEST_PATH && (await exists(MANIFEST_PATH))) {
  const mf = JSON.parse(await fsp.readFile(MANIFEST_PATH, "utf8"));
  const persona = mf.personas?.user ?? Object.values(mf.personas ?? {})[0] ?? {};
  const topics = persona.topics ?? [];
  const topicSet = new Set(topics);
  const strandSet = new Set(strandKeys);
  manifestInfo = {
    sliceCount: persona.sliceCount ?? mf.sliceCount ?? null,
    sliceCountMatches: (persona.sliceCount ?? mf.sliceCount) === disk.length,
    topics: topics.length,
    topicsMissingFromStrands: topics.filter((t) => !strandSet.has(t)),
    strandsMissingFromTopics: strandKeys.filter((k) => !topicSet.has(k)),
    dateRange: persona.dateRange ?? null,
  };
}

// step-2 manifest: alias groups via deterministic normalization (NFKC + trim + lowercase)
function normalizeKey(k) {
  return k.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
const aliasGroups = new Map(); // normalized -> [names]
for (const k of strandKeys) {
  const n = normalizeKey(k);
  if (!aliasGroups.has(n)) aliasGroups.set(n, []);
  aliasGroups.get(n).push(k);
}
const refCount = (k) => (strandRefs.get(k) ?? []).length;
const merged = [...aliasGroups.entries()]
  .map(([norm, names]) => {
    const sorted = [...names].sort((a, b) => (refCount(b) - refCount(a)) || a.localeCompare(b));
    return { primary: sorted[0], aliases: sorted.slice(1), count: sorted.reduce((n, k) => n + refCount(k), 0) };
  })
  .sort((a, b) => b.count - a.count || a.primary.localeCompare(b.primary));

const strandFilePlan = merged.map((g) => ({
  file: `${displayPath(`strands/${safeStrandFilename(g.primary)}.md`)}`,
  primary: g.primary,
  aliases: g.aliases,
  sliceRefs: g.count,
}));

// ─── Report ───────────────────────────────────────────────────────────

const strandList = strandKeys
  .map((k) => ({ name: k, refs: refCount(k) }))
  .sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));

const L = [];
L.push(`# Memory Audit — ${NAME} (${path.basename(path.dirname(EPISODIC))}/${path.basename(EPISODIC)})`);
L.push(``);
L.push(`- Date: ${today}`);
L.push(`- Target: \`${EPISODIC.replace(/\\/g, "/")}\``);
L.push(`- Lang: ${LANG} (step-2 prompts & strand descriptions)`);
L.push(`- Scope: dry-run audit only (zero LLM calls). Step-2 executor: \`scripts/backfill-memory.mjs\`.`);
L.push(``);
L.push(`## Headline numbers`);
L.push(``);
L.push(`| Metric | Value |`);
L.push(`|---|---|`);
L.push(`| Slices on disk (YYYY/MM/DD/HHMM with core.md) | ${disk.length} |`);
L.push(`| timeline/index.json slice_count | ${index.slice_count} (actual entries: ${index.slices.length}) |`);
if (manifestInfo) {
  L.push(`| manifest sliceCount | ${manifestInfo.sliceCount} — ${manifestInfo.sliceCountMatches ? "MATCHES disk" : "**MISMATCH vs disk**"} |`);
  L.push(`| manifest topics vs strands.json keys | ${manifestInfo.topics} topics; missing from strands: ${manifestInfo.topicsMissingFromStrands.length}; strands not in topics: ${manifestInfo.strandsMissingFromTopics.length} |`);
}
L.push(`| index needs_marking (top-level flag) | ${index.needs_marking} |`);
L.push(`| Empty slices (no turns in body) | ${emptySlices.length} |`);
L.push(`| Slices missing any expected frontmatter field | ${missingExpected.length} |`);
L.push(`| Slices missing focus/summary | ${missingFocusSummary.length} |`);
L.push(`| core.md with \`needs_marking: true\` residue | ${fmNeedsMarking.length} |`);
L.push(`| Index entries not found on disk | ${indexNotOnDisk.length} |`);
L.push(`| Disk slices missing from index | ${diskNotInIndex.length} |`);
L.push(`| strands.json keywords | ${strandKeys.length} |`);
L.push(`| strands.json shape | ${strandFromCounts.length === 0 ? "tag -> slice-path[]" : `MIXED — ${strandFromCounts.length} key(s) resolved as count-index via frontmatter tags`} |`);
L.push(`| strands.json total refs | ${strandRefTotal} |`);
L.push(`| Strand refs not found on disk | ${strandMissingOnDisk.length} |`);
L.push(`| Strand refs with bad path pattern | ${strandBadPattern.length} |`);
L.push(`| Strands with duplicate refs | ${strandDupRefs.length} |`);
L.push(`| Strands with bad value shape | ${strandBadShape.length} |`);
L.push(`| Strands with zero resolved refs (skipped by step 2) | ${strandKeys.filter((k) => refCount(k) === 0).length} |`);
L.push(`| Disk slices referenced by no strand | ${diskNotInAnyStrand.length} |`);
L.push(`| Alias merges (normalized key collisions) | ${merged.filter((g) => g.aliases.length > 0).length} |`);
L.push(``);
L.push(`## Frontmatter field census (per slice, n=${disk.length})`);
L.push(``);
L.push(`| Field | Present | Expected |`);
L.push(`|---|---|---|`);
for (const f of [...EXPECTED_FM, ...OPTIONAL_FM].sort()) {
  const expected = EXPECTED_FM.includes(f) ? "yes" : "optional";
  L.push(`| \`${f}\` | ${census[f] ?? 0} | ${expected} |`);
}
L.push(``);
if (noFrontmatter.length) {
  L.push(`## Slices with NO frontmatter`);
  L.push(``);
  for (const p of noFrontmatter) L.push(`- ${p}`);
  L.push(``);
}
L.push(`## Slices missing focus/summary (step-2 backfill targets)`);
L.push(``);
if (missingFocusSummary.length === 0) {
  L.push(`(none)`);
} else {
  for (const s of missingFocusSummary) {
    L.push(`- \`${s.id}\` (${s.rel}) — missing: ${s.missing.join(", ")}; turns: ${s.userTurns} user / ${s.agentTurns} agent; file: \`${displayPath(`slices/${s.rel}/timeline/core.md`)}\``);
  }
}
L.push(``);
L.push(`Matching index entries flagged needs_marking: ${indexFlagged.map((s) => `\`${s.id}\``).join(", ") || "(none)"}.`);
L.push(``);
L.push(`## Empty slices`);
L.push(``);
L.push(emptySlices.length ? emptySlices.map((s) => `- ${s.rel}`).join("\n") : "(none)");
L.push(``);
L.push(`## Orphans & index integrity`);
L.push(``);
L.push(`- Index entries not on disk: ${indexNotOnDisk.length ? indexNotOnDisk.map((id) => `\`${id}\``).join(", ") : "(none)"}`);
L.push(`- Disk slices not in index: ${diskNotInIndex.length ? diskNotInIndex.map((id) => `\`${id}\``).join(", ") : "(none)"}`);
L.push(`- Strand refs pointing at missing slices: ${strandMissingOnDisk.length ? strandMissingOnDisk.slice(0, 20).join("; ") : "(none)"}`);
L.push(`- Strand refs with bad path pattern: ${strandBadPattern.length ? strandBadPattern.join("; ") : "(none)"}`);
L.push(`- Strands with duplicate refs: ${strandDupRefs.length ? strandDupRefs.join(", ") : "(none)"}`);
L.push(`- Bad-shaped strand values: ${strandBadShape.length ? strandBadShape.join(", ") : "(none)"}`);
L.push(`- Disk slices referenced by no strand: **${diskNotInAnyStrand.length}** (informational — a slice only enters strands.json when it carries tags; see their \`tags: []\`)`);
L.push(``);
L.push(`## needs_marking residue`);
L.push(``);
L.push(`- timeline/index.json top-level \`needs_marking\`: **${index.needs_marking}**; per-slice flags: ${indexFlagged.map((s) => `\`${s.id}\``).join(", ") || "(none)"}`);
L.push(`- core.md files containing \`needs_marking: true\`: ${fmNeedsMarking.length ? fmNeedsMarking.join(", ") : "(none)"}`);
L.push(``);
L.push(`## Strand keyword list (all ${strandKeys.length}, by slice count)`);
L.push(``);
L.push(`| Strand | Slices | Strand | Slices | Strand | Slices |`);
L.push(`|---|---|---|---|---|---|`);
for (let i = 0; i < strandList.length; i += 3) {
  const row = [0, 1, 2].map((j) => {
    const e = strandList[i + j];
    return e ? `| ${e.name} | ${e.refs} ` : "| | ";
  }).join("").replace(/\s+$/, "");
  L.push(row + "|");
}
L.push(``);
L.push(`## Step-2 file manifest (backfill-memory.mjs)`);
L.push(``);
L.push(`Estimated LLM calls: **${missingFocusSummary.length} slice marking + ${merged.length} strand descriptions = ${missingFocusSummary.length + merged.length}** (hard cap via \`--max-calls\`; ≤1 retry per call).`);
L.push(``);
L.push(`### Modified (existing files)`);
L.push(``);
for (const s of missingFocusSummary) {
  L.push(`- \`${displayPath(`slices/${s.rel}/timeline/core.md`)}\` — add frontmatter \`focus\`/\`summary\``);
}
if (missingFocusSummary.length) {
  L.push(`- \`${displayPath("timeline/index.json")}\` — clear needs_marking for the above, refresh counts + updated_at`);
} else {
  L.push(`- (no core.md/index.json changes needed)`);
}
L.push(``);
L.push(`### Created (new files: ${strandFilePlan.length})`);
L.push(``);
L.push(`All under \`${displayPath("strands/")}\` (created if absent). Frontmatter schema: \`first_seen\` / \`last_active\` / \`aliases[]\` + 1-2 paragraph ${LANG === "en" ? "English" : "Chinese"} description.`);
L.push(``);
L.push(`| File | Aliases | Slice refs |`);
L.push(`|---|---|---|`);
for (const g of strandFilePlan) {
  L.push(`| \`${g.file}\` | ${g.aliases.join(", ") || "—"} | ${g.sliceRefs} |`);
}
L.push(``);
const renamed = strandFilePlan.filter((g) => g.file !== displayPath(`strands/${g.primary}.md`));
if (renamed.length) {
  L.push(`> Filename sanitization applied (path-unsafe chars replaced with \`-\`):`);
  for (const g of renamed) L.push(`> - \`${g.primary}\` → \`${g.file}\``);
  L.push(``);
}
L.push(`### Backup`);
L.push(``);
L.push(`Before any write, \`backfill-memory.mjs\` copies every file it is about to modify into a backup dir (default: system temp \`previously-${NAME}-backup-<date>/\`, override with \`--backup-dir\`; \`--backup-in-memory\` chooses \`.backup-<date>/\` inside the dataset). New strand files have no prior content to back up.`);
L.push(``);
L.push(`## Notes & anomalies`);
L.push(``);
if (manifestInfo) {
  L.push(`- manifest dateRange: ${JSON.stringify(manifestInfo.dateRange)}; topics↔strands diffs: ${manifestInfo.topicsMissingFromStrands.length + manifestInfo.strandsMissingFromTopics.length === 0 ? "none" : `topics-not-in-strands=[${manifestInfo.topicsMissingFromStrands.join(", ")}], strands-not-in-topics=[${manifestInfo.strandsMissingFromTopics.join(", ")}]`}`);
}
const debris = (await fsp.readdir(SLICES, { withFileTypes: true })).filter((e) => !/^\d{4}$/.test(e.name)).map((e) => e.name);
if (debris.length) L.push(`- Non-dated debris under \`slices/\`: ${debris.join(", ")} — left untouched.`);
if (missingExpected.length) {
  const absentFreq = {};
  for (const m of missingExpected) for (const f of m.absent) absentFreq[f] = (absentFreq[f] || 0) + 1;
  const uniform = Object.entries(absentFreq).filter(([, n]) => n === disk.length).map(([f]) => f);
  if (uniform.length) {
    L.push(`- All ${disk.length} slices uniformly lack \`${uniform.join("\`, \`")}\` — a dataset format-generation difference (these slices predate those fields), NOT corruption; step 2 does not add them.`);
  }
}
if (activeSlices.length) {
  L.push(`- ${activeSlices.length} slice(s) have \`status: active\` in frontmatter: ${activeSlices.map((id) => `\`${id}\``).join(", ")}${missingFocusSummary.some((s) => activeSlices.includes(s.id)) ? " — includes a focus/summary backfill target (step 2 fills focus/summary only, does NOT close the slice)" : ""}.`);
}
L.push(`- timeline/index.json \`slice_count\` ${index.slice_count === index.slices.length ? "matches entry count" : `MISMATCHES entry count ${index.slices.length}`}.`);

const report = L.join("\n") + "\n";
await fsp.mkdir(path.dirname(reportPath), { recursive: true });
await fsp.writeFile(reportPath, report, "utf8");

// ─── Console summary ──────────────────────────────────────────────────
console.log(`report: ${reportPath}`);
console.log(`target: ${EPISODIC}`);
console.log(`slices on disk: ${disk.length} | index slice_count: ${index.slice_count} | needs_marking(top): ${index.needs_marking}`);
if (manifestInfo) console.log(`manifest sliceCount: ${manifestInfo.sliceCount} (${manifestInfo.sliceCountMatches ? "matches" : "MISMATCH"}) | topics: ${manifestInfo.topics}`);
console.log(`empty slices: ${emptySlices.length} | missing expected fm fields: ${missingExpected.length}`);
console.log(`missing focus/summary: ${missingFocusSummary.map((s) => s.id).join(", ") || "(none)"}`);
console.log(`needs_marking residue in core.md: ${fmNeedsMarking.length}`);
console.log(`orphans: index→disk ${indexNotOnDisk.length}, disk→index ${diskNotInIndex.length}, strand refs→disk ${strandMissingOnDisk.length}`);
console.log(`strands: ${strandKeys.length} keywords (${strandFromCounts.length} via count-fallback), ${strandRefTotal} refs, dup ${strandDupRefs.length}, bad shape ${strandBadShape.length}, zero-ref ${strandKeys.filter((k) => refCount(k) === 0).length}`);
console.log(`disk slices not in any strand: ${diskNotInAnyStrand.length} (informational)`);
console.log(`step-2 plan: modify ${missingFocusSummary.length} core.md (+index.json if any); create ${strandFilePlan.length} strands/*.md; est LLM calls ${missingFocusSummary.length + merged.length}`);
