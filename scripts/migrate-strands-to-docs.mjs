/**
 * One-shot migration: strand entity files → topic docs (v0.15 design §6.2).
 *
 *   <MEMORY_ROOT>/episodic/strands/<名>.md  →  <MEMORY_ROOT>/docs/topic/<名>.md
 *
 * Per file:
 *   - frontmatter collapses to the three machine fields:
 *       status: active
 *       opened:  <原 first_seen>     (missing → last_active → today, warned)
 *       updated: <原 last_active>    (missing → first_seen → today, warned)
 *   - the existing description becomes one entry `## <last_active> — 初始描述`
 *   - the 截至块 is seeded FROM that description, dated 截至 <last_active>
 *     (honestly stale from birth, per design)
 *   - aliases are NOT migrated as a field — they fold into the opening prose
 *     as "（本主题也叫：X、Y。）"
 *   - empty description → no entry, 截至块 seeded with （尚无描述）, warned
 *
 * Idempotent: a destination file that already exists is skipped, never
 * overwritten. Default is DRY-RUN — nothing is written without --apply.
 * The memory root comes from MEMORY_ROOT (no hardcoded paths).
 *
 * Run:  node scripts/migrate-strands-to-docs.mjs [--apply] [--limit <n>]
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

// ─── Args ─────────────────────────────────────────────────────────────
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(arg("limit", "0")); // 0 = no limit

const MEMORY_ROOT = process.env.MEMORY_ROOT;
if (!MEMORY_ROOT) {
  console.error("MEMORY_ROOT env var is required (the memory root to migrate)");
  process.exit(1);
}
const SRC_DIR = path.join(MEMORY_ROOT, "episodic", "strands");
const DST_DIR = path.join(MEMORY_ROOT, "docs", "topic");

const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
const today = nowLocal.toISOString().slice(0, 10);

// ─── Tolerant strand-entity parsing (mirrors the doc notation's leniency) ──

function unquote(v) {
  const s = v.trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Split frontmatter text + body. Returns null when no frontmatter block. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  return { fmText: m[1], body: raw.slice(m[0].length) };
}

/**
 * Parse the strand frontmatter we care about: first_seen / last_active /
 * aliases. Never throws — absent values come back as "" / [], the caller
 * decides fallbacks and warnings.
 */
function parseStrandFrontmatter(fmText) {
  const out = { first_seen: "", last_active: "", aliases: [] };
  if (!fmText) return out;
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "first_seen" || key === "last_seen") {
      if (!out.first_seen) out.first_seen = unquote(value);
    } else if (key === "last_active") {
      out.last_active = unquote(value);
    } else if (key === "aliases") {
      const v = value.trim();
      if (v.startsWith("[")) {
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) out.aliases = parsed.map(String);
        } catch {
          /* malformed inline list — treated as no aliases */
        }
      } else if (v === "") {
        // block list form: following "- item" lines
        while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
          i += 1;
          out.aliases.push(unquote(lines[i].replace(/^\s+-\s+/, "")));
        }
      }
    }
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(s);

// ─── Transform one entity → topic doc text ─────────────────────────────

function transform(name, raw) {
  const warnings = [];
  const split = splitFrontmatter(raw);
  if (!split) warnings.push("无 frontmatter 块");
  const fm = split ? parseStrandFrontmatter(split.fmText) : { first_seen: "", last_active: "", aliases: [] };
  const description = (split ? split.body : raw).trim();

  let opened = fm.first_seen;
  let updated = fm.last_active;
  if (!isDate(opened)) {
    warnings.push(`first_seen 缺失或非法（${fm.first_seen || "空"}），回退`);
    opened = isDate(updated) ? updated : today;
  }
  if (!isDate(updated)) {
    warnings.push(`last_active 缺失或非法（${fm.last_active || "空"}），回退`);
    updated = isDate(fm.first_seen) ? fm.first_seen : today;
  }

  // aliases fold into the opening prose (no alias mechanism exists in the
  // doc system — synonymy lives in prose, per design §3.2)
  const aliasNote =
    fm.aliases.length > 0 ? `\n\n（本主题也叫：${fm.aliases.join("、")}。）` : "";
  const entryBody = description
    ? `${description}${aliasNote}`
    : "";
  if (!description) warnings.push("描述为空：不生成初始描述条目");

  const asOfText = description || "（尚无描述）";

  const parts = [
    "---",
    "status: active",
    `opened: '${opened}'`,
    `updated: '${updated}'`,
    "---",
    `# ${name}`,
    "",
    `> 截至 ${updated}：${asOfText}`,
  ];
  if (entryBody) {
    parts.push("", `## ${updated} — 初始描述`, "", entryBody);
  }
  return { text: parts.join("\n") + "\n", warnings, opened, updated };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

let files = [];
try {
  files = (await fsp.readdir(SRC_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort();
} catch {
  console.error(`source dir not found: ${SRC_DIR}`);
  process.exit(1);
}

console.log(`memory root: ${MEMORY_ROOT}`);
console.log(`source: ${SRC_DIR}`);
console.log(`target: ${DST_DIR}`);
console.log(`mode: ${APPLY ? "APPLY (writes)" : "DRY-RUN (pass --apply to write)"}`);
console.log(`strand entity files: ${files.length}\n`);

const stats = { migrated: 0, skipped: 0, failed: 0 };
let processed = 0;

for (const file of files) {
  if (LIMIT && processed >= LIMIT) break;
  const name = file.slice(0, -".md".length);
  const srcPath = path.join(SRC_DIR, file);
  const dstPath = path.join(DST_DIR, file);

  if (name !== path.basename(name) || /[/\\:*?"<>|]/.test(name)) {
    console.log(`FAIL ${file}: unsafe name, skipped`);
    stats.failed += 1;
    continue;
  }

  if (await exists(dstPath)) {
    console.log(`SKIP ${file}: 已存在于 docs/topic/（已迁移过）`);
    stats.skipped += 1;
    continue;
  }

  let raw;
  try {
    raw = await fsp.readFile(srcPath, "utf8");
  } catch (err) {
    console.log(`FAIL ${file}: unreadable — ${err?.message ?? err}`);
    stats.failed += 1;
    continue;
  }

  const { text, warnings, opened, updated } = transform(name, raw);
  processed += 1;

  if (!APPLY) {
    console.log(`[dry] ${file} → docs/topic/${file}  opened=${opened} updated=${updated}${warnings.length ? `  ⚠ ${warnings.join("; ")}` : ""}`);
    stats.migrated += 1;
    continue;
  }

  try {
    await fsp.mkdir(DST_DIR, { recursive: true });
    await fsp.writeFile(dstPath, text, "utf8");
    console.log(`OK    ${file} → docs/topic/${file}  opened=${opened} updated=${updated}${warnings.length ? `  ⚠ ${warnings.join("; ")}` : ""}`);
    stats.migrated += 1;
  } catch (err) {
    console.log(`FAIL ${file}: write error — ${err?.message ?? err}`);
    stats.failed += 1;
  }
}

console.log(`\nsummary: ${stats.migrated} ${APPLY ? "migrated" : "would migrate (dry)"}, ${stats.skipped} skipped (already migrated), ${stats.failed} failed`);
process.exit(stats.failed > 0 ? 1 : 0);
