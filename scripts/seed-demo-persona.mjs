/**
 * Seed Demo Persona — extract a single WorldMemArena persona into Aftrbrez format.
 *
 * Usage: node scripts/seed-demo-persona.mjs [persona_id]
 * Default: personal_14 (Caleb Martin Hebert)
 *
 * Output: memory/demo/{persona_id}/
 *   episodic/slices/YYYY/MM/DD.md   — time slices with YAML frontmatter
 *   episodic/slices/YYYY/MM/_index.json
 *   episodic/tag-index.json
 *   nodes/{type}/{slug}.md          — memory nodes
 *   graph/index.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PERSONA_ID = process.argv[2] ?? "personal_14";
const INPUT_FILE = path.join(
  ROOT,
  "benchmark-data",
  "worldmemarena",
  "lifelong",
  "personal",
  `${PERSONA_ID}.json`
);
const OUTPUT_DIR = path.join(ROOT, "memory", "demo", PERSONA_ID);

// ─── Helpers ──────────────────────────────────────────────────────────

function parseDate(str) {
  return new Date(str);
}

function toSliceId(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toISO(date) {
  return date.toISOString();
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function extractSummary(text) {
  const firstSentence = text.split(/[.!?][\s\n]/)[0];
  if (!firstSentence) return text.slice(0, 100);
  return firstSentence.slice(0, 100);
}

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
  const tags = new Set();
  for (const { regex, tag } of patterns) {
    if (regex.test(text)) tags.add(tag);
  }
  return [...tags].slice(0, 8);
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

function mapMemoryType(wmType) {
  const mapping = {
    "Event Memory": "experience",
    "Semantic Memory": "concept",
    "Preference Memory": "personality",
    "Procedural Memory": "concept",
    "Working Memory": "concept",
  };
  return mapping[wmType] ?? "concept";
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

function serializeMemoryNode(node) {
  const fm = {
    id: node.id,
    type: node.type,
    domain: node.domain,
    tags: node.tags,
    related: node.related,
    backlinks: node.backlinks,
    priority: node.priority,
    access_count: node.access_count,
    last_accessed: node.last_accessed,
    recall_conditions: node.recall_conditions,
    status: node.status,
    superseded_by: node.superseded_by,
  };
  const frontmatter = toYamlFrontmatter(fm);
  const content = `# ${node.title}\n\n${node.content}\n`;
  return frontmatter + content;
}

// ─── Main ─────────────────────────────────────────────────────────────

console.log(`=== Seeding Demo Persona: ${PERSONA_ID} ===\n`);

// Read source
const raw = fs.readFileSync(INPUT_FILE, "utf-8");
const data = JSON.parse(raw);

console.log(`Source: ${data.sample_id}`);
console.log(`Sessions: ${data.sessions.length}`);
const totalMps = data.memory_points.reduce(
  (sum, g) => sum + g.memory_points.length, 0
);
console.log(`Memory points: ${totalMps}`);
console.log(`QA checkpoints: ${data.qa_checkpoints?.length ?? 0}`);

// Clear existing output
if (fs.existsSync(OUTPUT_DIR)) {
  fs.rmSync(OUTPUT_DIR, { recursive: true });
  console.log(`\nCleared existing: ${OUTPUT_DIR}`);
}

// ── Convert sessions → time slices ────────────────────────────
const allSlices = [];
const allNodes = [];

for (const session of data.sessions) {
  const sessionId = session._v2_session_id;
  const dialogue = session.dialogue;
  if (!dialogue || dialogue.length === 0) continue;

  const firstTimestamp = parseDate(dialogue[0].timestamp);
  const lastTimestamp = parseDate(dialogue[dialogue.length - 1].timestamp);
  const sliceId = toSliceId(firstTimestamp);

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
  for (const mpGroup of data.memory_points) {
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

  const mpTypes = [
    ...new Set(sessionMemPoints.map((mp) => mp.memory_type?.toLowerCase().replace(/\s+/g, "-"))),
  ];
  const allTags = [...new Set([...tags, ...mpTypes])];

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
    tags: allTags,
    related_slices: [],
    emotional_tone: "neutral",
    turns,
    estimatedTokens: Math.ceil(
      (turns.reduce((s, t) => s + t.content.length, 0) + focus.length + summary.length) / 4
    ),
    closedBy: "time_silence",
    _sessionId: sessionId,
  };

  allSlices.push(slice);
}

// ── Convert memory_points → memory nodes ──────────────────────
for (const mpGroup of data.memory_points) {
  for (const mp of mpGroup.memory_points) {
    const nodeId = `demo-${PERSONA_ID}-${mp.memory_id.toLowerCase()}`;
    const nodeType = mapMemoryType(mp.memory_type);
    const title = mp.memory_content.slice(0, 80);
    const priority = Math.round(mp.importance * 10) || 5;
    const lastAccessed = mp.timestamp ? mp.timestamp.slice(0, 10) : "2025-01-01";

    const words = mp.memory_content
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 4);
    const recallCondition =
      words.length > 0
        ? `query contains '${words.join("' or '")}'`
        : undefined;

    const node = {
      id: nodeId,
      type: nodeType,
      domain: PERSONA_ID,
      tags: [
        mp.memory_type?.toLowerCase().replace(/\s+/g, "-"),
        `session-${(mp._session_id || mpGroup.session_id).toLowerCase()}`,
      ],
      related: [],
      backlinks: [],
      priority,
      access_count: 0,
      last_accessed: lastAccessed,
      recall_conditions: recallCondition ? [recallCondition] : [],
      status: "active",
      superseded_by: undefined,
      title,
      content: mp.memory_content,
    };

    allNodes.push(node);
  }
}

// Resolve update chains
const nodeById = {};
for (const node of allNodes) {
  nodeById[node.id] = node;
}

// Build superseded_by references from original memory points
for (const mpGroup of data.memory_points) {
  for (const mp of mpGroup.memory_points) {
    if (mp.is_update === "True" && mp.original_memories?.length > 0) {
      const thisNodeId = `demo-${PERSONA_ID}-${mp.memory_id.toLowerCase()}`;
      for (const origContent of mp.original_memories) {
        // Find the node with matching content
        for (const node of allNodes) {
          if (
            node.content === origContent &&
            node.id !== thisNodeId
          ) {
            node.superseded_by = thisNodeId;
            break;
          }
        }
      }
    }
  }
}

// ── Write time slices ─────────────────────────────────────────
console.log(`\nWriting ${allSlices.length} time slices...`);
let sliceCount = 0;
for (const slice of allSlices) {
  const [year, month] = slice.slice_id.split("-");
  const dir = path.join(OUTPUT_DIR, "episodic", "slices", year, month);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${slice.slice_id.split("-")[2]}.md`);
  fs.writeFileSync(filePath, serializeTimeSlice(slice), "utf-8");
  sliceCount++;
}
console.log(`  Wrote ${sliceCount} .md files`);

// ── Write monthly indices ─────────────────────────────────────
const byMonth = {};
for (const slice of allSlices) {
  const [year, month] = slice.slice_id.split("-");
  const key = `${year}-${month}`;
  if (!byMonth[key]) byMonth[key] = [];
  byMonth[key].push(slice);
}

for (const [month, monthSlices] of Object.entries(byMonth)) {
  const entries = monthSlices
    .map((s) => ({
      id: s.slice_id.split("-")[2],
      focus: s.focus,
      summary: s.summary,
      tags: s.tags,
      status: s.status,
      start: s.start,
      open_loops: s.open_loops,
      decisions: s.decisions,
    }))
    .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

  const [year, monthNum] = month.split("-");
  const dir = path.join(OUTPUT_DIR, "episodic", "slices", year, monthNum);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_index.json"),
    JSON.stringify({ month, slices: entries }, null, 2),
    "utf-8"
  );
}
console.log(`  Wrote ${Object.keys(byMonth).length} monthly _index.json files`);

// ── Write tag index ───────────────────────────────────────────
const tagIndex = {};
for (const slice of allSlices) {
  const [year, month, day] = slice.slice_id.split("-");
  const relPath = `${year}/${month}/${day}`;
  for (const tag of slice.tags) {
    if (!tagIndex[tag]) tagIndex[tag] = [];
    if (!tagIndex[tag].includes(relPath)) {
      tagIndex[tag].push(relPath);
    }
  }
}
const tagIndexDir = path.join(OUTPUT_DIR, "episodic");
fs.mkdirSync(tagIndexDir, { recursive: true });
fs.writeFileSync(
  path.join(tagIndexDir, "tag-index.json"),
  JSON.stringify(tagIndex, null, 2),
  "utf-8"
);
console.log(`  Wrote tag-index.json (${Object.keys(tagIndex).length} tags)`);

// ── Write memory nodes ────────────────────────────────────────
console.log(`Writing ${allNodes.length} memory nodes...`);
const typeDirMap = {
  experience: "experience",
  concept: "concepts",
  project: "projects",
  people: "people",
  personality: "personalities",
};

let nodeCount = 0;
for (const node of allNodes) {
  const typeDir = typeDirMap[node.type] || "concepts";
  const dir = path.join(OUTPUT_DIR, "nodes", typeDir);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = slugify(node.title) + ".md";
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, serializeMemoryNode(node), "utf-8");
  nodeCount++;
}
console.log(`  Wrote ${nodeCount} .md files`);

// ── Write graph index ─────────────────────────────────────────
const graphIndex = { nodes: {} };
for (const node of allNodes) {
  const typeDir = typeDirMap[node.type] || "concepts";
  graphIndex.nodes[node.id] = {
    path: `memory/demo/${PERSONA_ID}/nodes/${typeDir}/${slugify(node.title)}.md`,
    type: node.type,
    tags: node.tags,
    links: node.related,
    backlinks: node.backlinks,
    priority: node.priority,
    access_count: node.access_count,
    last_accessed: node.last_accessed,
    status: node.status,
  };
  if (node.superseded_by) {
    graphIndex.nodes[node.id].superseded_by = node.superseded_by;
  }
}
const graphDir = path.join(OUTPUT_DIR, "graph");
fs.mkdirSync(graphDir, { recursive: true });
fs.writeFileSync(
  path.join(graphDir, "index.json"),
  JSON.stringify(graphIndex, null, 2),
  "utf-8"
);
console.log(`  Wrote graph/index.json (${Object.keys(graphIndex.nodes).length} nodes)`);

// ── Summary ───────────────────────────────────────────────────
function getDirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    size += entry.isDirectory() ? getDirSize(fp) : fs.statSync(fp).size;
  }
  return size;
}

const outputSize = getDirSize(OUTPUT_DIR);
console.log(`\n=== Done ===`);
console.log(`Output: ${OUTPUT_DIR}`);
console.log(`Size: ${(outputSize / 1024).toFixed(1)} KB`);
console.log(`Slices: ${allSlices.length}, Nodes: ${allNodes.length}`);
