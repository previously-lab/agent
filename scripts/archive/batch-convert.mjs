/**
 * Batch Convert WorldMemArena → Previously On Benchmark Data
 *
 * Reads all personal_*.json files from a _raw/ directory and converts each into
 * the Previously On episodic memory format. Output goes directly into the
 * benchmark-data repo structure.
 *
 * Usage:
 *   node scripts/batch-convert.mjs [--raw <dir>] [--out <dir>]
 *
 *   --raw   Directory containing personal_*.json files
 *           (default: ../benchmark-data/_raw)
 *   --out   Output root for converted personas
 *           (default: ../benchmark-data)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ─── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
const RAW_DIR = getArg("--raw") ?? path.join(ROOT, "..", "benchmark-data", "_raw");
const OUT_DIR = getArg("--out") ?? path.join(ROOT, "..", "benchmark-data");

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseDate(str) { return new Date(str); }

function toSliceId(date) {
  if (isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}-${hh}${mm}`;
}

function toISO(date) { return date.toISOString(); }

function extractSummary(text) {
  const firstSentence = text.split(/[.!?][\s\n]/)[0];
  if (!firstSentence) return text.slice(0, 100);
  return firstSentence.slice(0, 100);
}

/** Regex-based tag extraction — serviceable baseline. Replace with Haiku later. */
function extractTags(text) {
  const patterns = [
    { regex: /\b(work|job|career|promotion|project|deadline|meeting|boss|colleague|office|salary)\b/i, tag: "work" },
    { regex: /\b(family|mom|dad|son|daughter|husband|wife|parent|kid|child|brother|sister)\b/i, tag: "family" },
    { regex: /\b(health|doctor|hospital|sick|pain|injury|surgery|medicine|therapy|mental|depression|anxiety)\b/i, tag: "health" },
    { regex: /\b(money|budget|finance|debt|loan|salary|income|expense|rent|mortgage|bills|savings)\b/i, tag: "finance" },
    { regex: /\b(relationship|dating|boyfriend|girlfriend|partner|marriage|divorce|breakup)\b/i, tag: "relationship" },
    { regex: /\b(travel|trip|vacation|holiday|flight|hotel|visit)\b/i, tag: "travel" },
    { regex: /\b(study|school|college|university|degree|course|class|exam|learn|education)\b/i, tag: "education" },
    { regex: /\b(move|relocate|apartment|house|rent|lease|neighbor|neighborhood)\b/i, tag: "housing" },
    { regex: /\b(hobby|sport|soccer|running|hiking|gym|exercise|fitness|game|music)\b/i, tag: "leisure" },
    { regex: /\b(goal|plan|future|dream|ambition|five.year|career.change)\b/i, tag: "goals" },
    { regex: /\b(flood|mitigation|outreach|climate|disaster|resilience|adaptation|weather|storm|hurricane)\b/i, tag: "environment" },
    { regex: /\b(community|public.service|civic|council|neighborhood|outreach)\b/i, tag: "civic" },
  ];
  const tagSet = new Set();
  for (const { regex, tag } of patterns) {
    if (regex.test(text)) tagSet.add(tag);
  }
  return [...tagSet].slice(0, 8);
}

function deriveFocus(dialogue) {
  const firstUser = dialogue.find((t) => t.role === "user");
  if (!firstUser) return "conversation";
  const cleaned = firstUser.content.replace(/^Hello[^.]*\.\s*/, "").trim();
  return cleaned.slice(0, 80) || firstUser.content.slice(0, 80);
}

function deriveSummary(dialogue) {
  const userMessages = dialogue
    .filter((t) => t.role === "user")
    .map((t) => t.content);
  const combined = userMessages.slice(1, 4).join(" ");
  return extractSummary(combined) || extractSummary(userMessages[0] || "");
}

/** Extract a persona name from early session dialogue (heuristic). */
function derivePersonaName(dialogue) {
  const allText = dialogue.map((t) => t.content).join(" ");
  // Try to find "My name is X" patterns
  const nameMatch = allText.match(/My name is ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
  return nameMatch ? nameMatch[1] : "Unknown";
}

function toYamlFrontmatter(obj) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (typeof value === "object" && !Array.isArray(value)) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        const str = String(item);
        if (/[":{}#&*!|>'"%@`[\]\n,]/.test(str)) {
          lines.push(`  - ${JSON.stringify(str)}`);
        } else {
          lines.push(`  - ${str}`);
        }
      }
    } else {
      const str = String(value);
      if (/[":{}#&*!|>'"%@`[\]\n,]/.test(str)) {
        lines.push(`${key}: ${JSON.stringify(str)}`);
      } else {
        lines.push(`${key}: ${str}`);
      }
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

function serializeTimeSlice(slice) {
  const fm = {
    slice_id: slice.slice_id,
    focus: slice.focus,
    status: slice.status,
    start: slice.start,
    end: slice.end,
    timezone: slice.timezone,
    summary: slice.summary,
    open_loops: slice.open_loops,
    decisions: slice.decisions,
    tags: slice.tags,
    related_slices: slice.related_slices,
    emotional_tone: slice.emotional_tone,
  };
  const frontmatter = toYamlFrontmatter(fm);
  const body = slice.turns
    .map(
      (turn, i) =>
        `## Turn ${i + 1} — ${turn.timestamp} (${turn.role})\n\n${turn.content}`
    )
    .join("\n\n");
  return frontmatter + body + "\n";
}

// ─── Profile generation ──────────────────────────────────────────────────

function generateProfile(personaId, name, allDialogue) {
  const allText = allDialogue.map((t) => t.content).join(" ");
  // Very rough persona description from first few user messages
  const userMessages = allDialogue.filter((t) => t.role === "user").map((t) => t.content);
  const body = userMessages.slice(0, 3).join(" ").slice(0, 500);

  const frontmatter = `---
name: ${name}
timezone: America/Chicago
locale: en
address_as: ${name.split(" ")[0]}
---
`;
  return frontmatter + body + "\n";
}

// ─── Convert one persona ─────────────────────────────────────────────────

function convertPersona(personaId, rawPath, outDir) {
  console.log(`\n=== ${personaId} ===`);

  const raw = fs.readFileSync(rawPath, "utf-8");
  const data = JSON.parse(raw);

  console.log(`  Sessions: ${data.sessions?.length ?? 0}`);
  console.log(`  Memory point groups: ${data.memory_points?.length ?? 0}`);

  // Clear existing output
  const personaDir = path.join(outDir, personaId);
  if (fs.existsSync(personaDir)) {
    fs.rmSync(personaDir, { recursive: true });
  }

  // ── Convert sessions → time slices ────────────────────────────
  const allSlices = [];
  let personaName = "Unknown";

  for (const session of data.sessions ?? []) {
    const sessionId = session._v2_session_id;
    const dialogue = session.dialogue;
    if (!dialogue || dialogue.length === 0) continue;

    // Try to extract persona name from the first session
    if (personaName === "Unknown" && sessionId === data.sessions[0]._v2_session_id) {
      personaName = derivePersonaName(dialogue);
    }

    const firstTimestamp = parseDate(dialogue[0].timestamp);
    const lastTimestamp = parseDate(dialogue[dialogue.length - 1].timestamp);
    const sliceId = toSliceId(firstTimestamp);
    if (!sliceId) {
      console.warn(`  SKIP ${sessionId}: invalid timestamp "${dialogue[0].timestamp}"`);
      continue;
    }

    const turns = dialogue.map((turn) => ({
      timestamp: toISO(parseDate(turn.timestamp)),
      role: turn.role === "assistant" ? "agent" : "user",
      content: turn.content,
    }));

    const focus = deriveFocus(dialogue);
    const summary = deriveSummary(dialogue);
    const allText = dialogue.map((t) => t.content).join(" ");
    const tags = extractTags(allText);

    // Load memory points for this session
    const sessionMemPoints = [];
    for (const mpGroup of data.memory_points ?? []) {
      if (mpGroup.session_id === sessionId) {
        sessionMemPoints.push(...mpGroup.memory_points);
      }
    }

    const openLoops = sessionMemPoints
      .filter((mp) => mp.is_update === "False" && mp.memory_source === "primary")
      .map((mp) => mp.memory_content.slice(0, 120))
      .slice(0, 5);

    const decisions = sessionMemPoints
      .filter((mp) => mp.is_update === "True")
      .map((mp) => mp.memory_content.slice(0, 120))
      .slice(0, 5);

    const slice = {
      slice_id: sliceId,
      focus,
      status: "closed",
      start: turns[0].timestamp,
      end: turns[turns.length - 1].timestamp,
      timezone: "America/Chicago",
      summary,
      open_loops: openLoops,
      decisions,
      tags,
      related_slices: [],
      emotional_tone: "neutral",
      turns,
    };

    allSlices.push(slice);
  }

  // ── Write time slices ─────────────────────────────────────────
  // Path: YYYY/MM/DD/HHMM.md — derived from slice_id
  // Collision guard: if two sessions land on the same HHMM, append -2, -3, etc.

  const sliceFilePaths = [];
  const usedHhmms = new Set();

  for (let i = 0; i < allSlices.length; i++) {
    const slice = allSlices[i];
    const parts = slice.slice_id.split("-");
    // slice_id = YYYY-MM-DD-HHMM
    let [year, month, day, hhmm] = parts;

    const dir = path.join(personaDir, "episodic", "slices", year, month, day);
    fs.mkdirSync(dir, { recursive: true });

    // Avoid HHMM collisions on the same day (rare with personal data)
    const dirKey = `${year}/${month}/${day}`;
    let candidateHhmm = hhmm;
    let suffix = 2;
    while (usedHhmms.has(`${dirKey}/${candidateHhmm}`)) {
      const base = String(suffix).padStart(4, "0");
      candidateHhmm = String(parseInt(hhmm, 10) + suffix).padStart(4, "0");
      suffix++;
    }
    usedHhmms.add(`${dirKey}/${candidateHhmm}`);

    const fileName = `${candidateHhmm}.md`;
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, serializeTimeSlice(slice), "utf-8");

    sliceFilePaths.push({ year, month, day, hhmm: candidateHhmm });
  }

  console.log(`  Wrote ${allSlices.length} slice files`);

  // ── Write monthly indices ─────────────────────────────────────

  const byMonth = {};
  const monthSlices = {};

  for (let i = 0; i < allSlices.length; i++) {
    const slice = allSlices[i];
    const [year, month] = slice.slice_id.split("-");
    const key = `${year}-${month}`;
    if (!byMonth[key]) byMonth[key] = [];

    const sp = sliceFilePaths[i];
    byMonth[key].push({
      slice,
      relDay: sp.day,
      hhmm: sp.hhmm,
    });
  }

  for (const [monthKey, entries] of Object.entries(byMonth)) {
    const [year, monthNum] = monthKey.split("-");
    const indexEntries = entries
      .map(({ slice, relDay, hhmm }) => ({
        id: slice.slice_id,
        focus: slice.focus,
        summary: slice.summary,
        tags: slice.tags,
        status: slice.status,
        start: slice.start,
        open_loops: slice.open_loops,
        decisions: slice.decisions,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const dir = path.join(personaDir, "episodic", "slices", year, monthNum);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "_index.json"),
      JSON.stringify({ month: monthKey, slices: indexEntries }, null, 2),
      "utf-8"
    );
  }

  console.log(`  Wrote ${Object.keys(byMonth).length} monthly indexes`);

  // ── Write strands ─────────────────────────────────────────────

  const strands = {};
  for (let i = 0; i < allSlices.length; i++) {
    const slice = allSlices[i];
    const sp = sliceFilePaths[i];
    const relPath = `${sp.year}/${sp.month}/${sp.day}/${sp.hhmm}`;
    for (const tag of slice.tags) {
      if (!strands[tag]) strands[tag] = [];
      if (!strands[tag].includes(relPath)) {
        strands[tag].push(relPath);
      }
    }
  }

  const strandsDir = path.join(personaDir, "episodic");
  fs.mkdirSync(strandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(strandsDir, "strands.json"),
    JSON.stringify(strands, null, 2),
    "utf-8"
  );

  console.log(`  Wrote strands.json (${Object.keys(strands).length} strands)`);

  // ── Write user profile ────────────────────────────────────────

  const profileDir = path.join(personaDir, "user");
  fs.mkdirSync(profileDir, { recursive: true });
  const allDialogue = allSlices.flatMap((s) => s.turns);
  const profile = generateProfile(personaId, personaName, allDialogue);
  fs.writeFileSync(path.join(profileDir, "profile.md"), profile, "utf-8");

  // ── Return manifest fragment ──────────────────────────────────

  const allTags = [
    ...new Set(allSlices.flatMap((s) => s.tags)),
  ];
  const dateRange = allSlices.length > 0
    ? [allSlices[0].slice_id.slice(0, 7), allSlices[allSlices.length - 1].slice_id.slice(0, 7)]
    : [];

  return {
    personaId,
    name: personaName,
    topics: allTags,
    sliceCount: allSlices.length,
    dateRange,
    strands: Object.keys(strands),
  };
}

// ─── Build manifest.json ──────────────────────────────────────────────────

function buildManifest(personas, outDir) {
  const manifest = { version: 1, personas: {} };

  for (const p of personas) {
    // Build a lightweight tree from the actual file listing
    const tree = {};
    const personaDir = path.join(outDir, p.personaId);

    function scanTree(dirPath, node) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          node[e.name] = {};
          scanTree(path.join(dirPath, e.name), node[e.name]);
        } else if (e.isFile() && !e.name.startsWith(".")) {
          if (!node._files) node._files = [];
          node._files.push(e.name);
        }
      }
    }

    scanTree(personaDir, tree);

    manifest.personas[p.personaId] = {
      name: p.name,
      description: `${p.sliceCount} sessions across ${p.dateRange[0]} → ${p.dateRange[1]}`,
      topics: p.topics.slice(0, 12),
      sliceCount: p.sliceCount,
      dateRange: p.dateRange,
      strands: p.strands,
      tree,
    };
  }

  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\nWrote manifest.json (${Object.keys(manifest.personas).length} personas)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────

console.log("=== Batch Convert WorldMemArena → Previously On ===\n");
console.log(`Raw dir: ${RAW_DIR}`);
console.log(`Out dir:  ${OUT_DIR}`);

if (!fs.existsSync(RAW_DIR)) {
  console.error(`\nERROR: Raw directory not found: ${RAW_DIR}`);
  console.error("Download WorldMemArena personal samples first:");
  console.error("  pip install huggingface_hub");
  console.error("  huggingface-cli download LCZZZZ/WorldMemArena --repo-type dataset \\");
  console.error("    --local-dir ./WorldMemArena \\");
  console.error('    --include "WorldMemArena/lifelong/personal/personal_*.json"');
  console.error(`Then copy the JSON files to: ${RAW_DIR}`);
  process.exit(1);
}

const rawFiles = fs.readdirSync(RAW_DIR)
  .filter((f) => f.match(/^personal_\d+\.json$/))
  .sort();

if (rawFiles.length === 0) {
  console.error(`\nERROR: No personal_*.json files found in ${RAW_DIR}`);
  process.exit(1);
}

console.log(`\nFound ${rawFiles.length} persona files:\n  ${rawFiles.join("\n  ")}`);

const allMetas = [];

for (const fileName of rawFiles) {
  const personaId = fileName.replace(".json", "");
  const rawPath = path.join(RAW_DIR, fileName);
  const meta = convertPersona(personaId, rawPath, OUT_DIR);
  allMetas.push(meta);
}

// ─── Build manifest.json ──────────────────────────────────────────────────

buildManifest(allMetas, OUT_DIR);

// ─── Summary ──────────────────────────────────────────────────────────────

function getDirSize(dir) {
  let size = 0;
  if (!fs.existsSync(dir)) return 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    size += entry.isDirectory() ? getDirSize(fp) : fs.statSync(fp).size;
  }
  return size;
}

const totalSize = getDirSize(OUT_DIR);
console.log(`\n=== Done ===`);
console.log(`Output:   ${OUT_DIR}`);
console.log(`Size:     ${(totalSize / 1024).toFixed(1)} KB`);
console.log(`Personas: ${allMetas.length}`);
for (const m of allMetas) {
  console.log(`  ${m.personaId}: ${m.sliceCount} slices, ${m.strands.length} strands — ${m.name}`);
}
