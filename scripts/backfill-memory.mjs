/**
 * Backfill the agent repo's episodic memory (step 2 — run AFTER audit-memory.mjs).
 *
 * Target: C:/Users/Dream/Documents/GitHub/agent/memory/episodic
 * (the real data repo — Aftrbrez's own memory/ is an old test copy, never touched)
 *
 * Does two things, ALL writes inside the agent repo's memory/:
 *  1. Slice marking — for every slice missing focus/summary in its core.md
 *     frontmatter, ask the LLM to mark it (prompt style mirrors the
 *     turn-analyzer's Task 6 closed_marking in src/lib/episodic/flash/turn-analyzer.ts):
 *     focus = one sentence, summary <= 100 chars. Then clears the matching
 *     needs_marking flag in timeline/index.json (status is NOT touched).
 *  2. Strand entities — for every keyword in strands.json, create
 *     memory/episodic/strands/<name>.md with pinned frontmatter schema
 *     (first_seen / last_active / aliases[]) and a 1-2 paragraph description
 *     (first mention, main themes) generated from the associated slices'
 *     focus/summary lines. Alias merging is deterministic (NFKC + trim +
 *     lowercase collision), not LLM-driven.
 *
 * LLM discipline (the 0910 internal model is rate-limited, 20 concurrent):
 *  - STRICTLY serial (concurrency = 1), one call at a time
 *  - per-call timeout (AbortSignal), at most ONE retry per call
 *  - hard global cap on LLM calls (--max-calls, default 600) — stops and
 *    reports when reached; no unbounded loops anywhere
 *
 * Safety: before any write, every file about to be modified is copied into a
 * backup dir (default: system temp previously-memory-backup-<date>/; use
 * --backup-in-memory for memory/.backup-<date>/ inside the agent repo, or
 * --backup-dir <path>). Idempotent: existing focus/summary and existing
 * strand files are skipped.
 *
 * Run:   node scripts/backfill-memory.mjs [--model <id>] [--dry] [--limit <n>]
 *        [--only-slice <sliceId>] [--only-strand <name>] [--max-calls <n>]
 *        [--timeout-ms <n>] [--backup-dir <path>] [--backup-in-memory]
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ─── Args ─────────────────────────────────────────────────────────────
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const MODEL = arg("model", "deepseek-v4.1-flash-expires-on-0910");
const DRY = hasFlag("dry");
const LIMIT = Number(arg("limit", "0")); // 0 = no limit
const ONLY_SLICE = arg("only-slice", null);
const ONLY_STRAND = arg("only-strand", null);
const MAX_CALLS = Number(arg("max-calls", "600")); // hard cap, never exceeded
const TIMEOUT_MS = Number(arg("timeout-ms", "90000"));
const BACKUP_IN_MEMORY = hasFlag("backup-in-memory");
const BACKUP_DIR_ARG = arg("backup-dir", null);

// ─── Paths ────────────────────────────────────────────────────────────
const MEMORY_ROOT = "C:/Users/Dream/Documents/GitHub/agent/memory";
const EPISODIC = path.join(MEMORY_ROOT, "episodic");
const SLICES = path.join(EPISODIC, "slices");
const INDEX_JSON = path.join(EPISODIC, "timeline", "index.json");
const STRANDS_JSON = path.join(EPISODIC, "strands.json");
const STRANDS_DIR = path.join(EPISODIC, "strands");

const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
const today = nowLocal.toISOString().slice(0, 10);
const BACKUP_DIR = BACKUP_DIR_ARG
  ? path.resolve(BACKUP_DIR_ARG)
  : BACKUP_IN_MEMORY
    ? path.join(MEMORY_ROOT, `.backup-${today}`)
    : path.join(os.tmpdir(), `previously-memory-backup-${today}`);

// ─── Env (minimal .env.local loader, same pattern as scripts/archive/smoke-search.mjs) ──
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* rely on ambient env */
}

if (!DRY && !process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY missing (checked .env.local too)");
  process.exit(1);
}

// ─── LLM client: strictly serial, capped, timeout + single retry ─────
let llmCalls = 0;
let capReached = false;

const openai = createOpenAI({
  baseURL: "https://api.deepseek.com/v1", // DeepSeek official OpenAI-compatible endpoint
  apiKey: process.env.DEEPSEEK_API_KEY ?? "dry-run",
});

async function llm(prompt, { maxTokens = 700 } = {}) {
  if (llmCalls >= MAX_CALLS) {
    capReached = true;
    throw new Error(`HARD CAP REACHED (${MAX_CALLS} LLM calls) — stopping`);
  }
  llmCalls += 1;
  const n = llmCalls;
  const attempt = async () =>
    generateText({
      model: openai(MODEL),
      prompt,
      maxOutputTokens: maxTokens,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
  console.log(`  [llm ${n}/${MAX_CALLS}] ${prompt.slice(0, 72).replace(/\n/g, " ")}…`);
  try {
    const r = await attempt();
    return r.text.trim();
  } catch (err) {
    console.log(`  [llm ${n}] failed: ${err?.message ?? err} — retrying once`);
    const r = await attempt(); // exactly one retry; a second failure propagates
    return r.text.trim();
  }
}

// ─── Slice parsing helpers (CRLF-tolerant, mirrors the audit script) ──
async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

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

function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)(\r?\n)---(\r?\n?)/);
  if (!m) return null;
  return { fmText: m[1], nl: m[2], closeLen: `---${m[3]}`.length, raw };
}

function fmHas(fmText, field) {
  return new RegExp(`^${field}:`, "m").test(fmText);
}

function parseTurns(body) {
  const turns = [];
  const parts = body.split(/^## Turn /m);
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^(\S+) — (\S+) \((\w+)\)\r?\n\r?\n([\s\S]*)$/m);
    if (!m) continue;
    turns.push({ role: m[3], ts: m[2], content: m[4].trim() });
  }
  return turns;
}

/** Compress a slice's turns for the marking prompt: first 6 + last 6, each capped. */
function compressTurns(turns, perTurn = 400, total = 8000) {
  const picked = turns.length <= 12 ? turns : [...turns.slice(0, 6), ...turns.slice(-6)];
  const lines = [];
  let used = 0;
  for (const t of picked) {
    const text = t.content.replace(/\s+/g, " ").slice(0, perTurn);
    const line = `[${t.ts} ${t.role}] ${text}`;
    if (used + line.length > total) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** YAML scalar: plain when safe, else double-quoted (JSON string escaping). */
function yamlScalar(value) {
  const v = String(value).trim();
  if (v.length > 0 && !/[:#\[\]{}&*!|>'"%@`,?]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v) && !/^(true|false|null|yes|no|on|off)$/i.test(v)) {
    return v;
  }
  return JSON.stringify(v);
}

// ─── Backup: snapshot every file we are about to modify ───────────────
async function backupFiles(relPaths) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  let n = 0;
  for (const rel of relPaths) {
    const src = path.join(MEMORY_ROOT, rel);
    if (!(await exists(src))) continue; // new files have no prior content
    const dst = path.join(BACKUP_DIR, rel);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    n += 1;
  }
  return n;
}

// ─── Shared state ─────────────────────────────────────────────────────
const index = JSON.parse(await fsp.readFile(INDEX_JSON, "utf8"));
const strands = JSON.parse(await fsp.readFile(STRANDS_JSON, "utf8"));
const indexById = new Map(index.slices.map((s) => [s.id, s]));

const results = {
  model: MODEL,
  dry: DRY,
  backupDir: BACKUP_DIR,
  sliceMarks: [], // { id, ok, detail }
  strandFiles: [], // { file, ok, detail }
  llmCalls: 0,
  capReached: false,
};

// ═══ Phase A — slice marking (focus/summary backfill) ═════════════════
async function phaseSlices() {
  console.log("\n== Phase A: slice marking ==");
  const dirs = await collectSliceDirs(SLICES);
  const targets = [];
  for (const dir of dirs) {
    const corePath = path.join(dir, "timeline", "core.md");
    if (!(await exists(corePath))) continue;
    const raw = await fsp.readFile(corePath, "utf8");
    const split = splitFrontmatter(raw);
    if (!split) continue;
    if (fmHas(split.fmText, "focus") && fmHas(split.fmText, "summary")) continue;
    const m = dir.match(/(\d{4})[\\/]+(\d{2})[\\/]+(\d{2})[\\/]+(\d{4})$/);
    targets.push({ id: `${m[1]}-${m[2]}-${m[3]}-${m[4]}`, dir, corePath, raw, split });
  }
  console.log(`slices missing focus/summary: ${targets.length}`);

  let done = 0;
  for (const t of targets) {
    if (ONLY_SLICE && t.id !== ONLY_SLICE) continue;
    if (LIMIT && done >= LIMIT) break;
    const turns = parseTurns(t.raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""));
    const tags = (t.split.fmText.match(/^tags:\r?\n((?:\s+-\s+.+\r?\n)*)/m)?.[1] ?? "")
      .split(/\r?\n/).map((l) => l.match(/^\s+-\s+(.+)$/)?.[1]).filter(Boolean);
    const conversation = compressTurns(turns);

    const prompt = `你是一段对话记忆系统的打标同事。一个时间片刚关闭，请阅读对话并给它打标，供未来的记忆召回使用。

## 对话内容（节选）

${conversation}

该片已有标签：${tags.join("、") || "（无）"}

## 任务

严格返回一个 JSON 对象（不要输出任何其他内容）：
{"focus": "…", "summary": "…"}

- focus：一句话概括这个会话聊了什么（中文，<= 60 字）。
- summary：最多 100 字——发生了什么 / 关键决定（中文，句末用句号）。
只依据对话内容，不要编造。`;

    if (DRY) {
      console.log(`  [dry] would mark ${t.id} (${turns.length} turns)`);
      results.sliceMarks.push({ id: t.id, ok: "dry", detail: `${turns.length} turns` });
      continue;
    }

    try {
      const text = await llm(prompt);
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m[0]);
      const focus = String(parsed.focus ?? "").trim();
      const summary = String(parsed.summary ?? "").trim();
      if (!focus || !summary) throw new Error("empty focus/summary in model output");

      // insert before the closing "---" of the frontmatter, matching its line ending
      const closeIdx = t.raw.indexOf("\n---", 3);
      const nl = t.raw.slice(0, closeIdx).includes("\r\n") ? "\r\n" : "\n";
      const insertion = `${nl}focus: ${yamlScalar(focus)}${nl}summary: ${yamlScalar(summary)}`;
      const next = t.raw.slice(0, closeIdx) + insertion + t.raw.slice(closeIdx);

      await fsp.writeFile(t.corePath, next, "utf8");
      // clear the needs_marking flag in the index
      const entry = indexById.get(t.id);
      if (entry) {
        entry.focus = focus;
        entry.summary = summary;
        entry.needs_marking = false;
      }
      console.log(`  marked ${t.id}: ${summary.slice(0, 40)}…`);
      results.sliceMarks.push({ id: t.id, ok: true, detail: summary.slice(0, 60) });
      done += 1;
    } catch (err) {
      console.log(`  FAILED ${t.id}: ${err?.message ?? err}`);
      results.sliceMarks.push({ id: t.id, ok: false, detail: String(err?.message ?? err) });
      if (capReached) break;
    }
  }

  if (!DRY && results.sliceMarks.some((r) => r.ok === true)) {
    index.needs_marking = index.slices.filter((s) => s.needs_marking).length;
    index.updated_at = new Date().toISOString();
    await fsp.writeFile(INDEX_JSON, JSON.stringify(index, null, 2) + "\n", "utf8");
    console.log(`index.json updated (needs_marking -> ${index.needs_marking})`);
  }
}

// ═══ Phase B — strand entities ════════════════════════════════════════
function normalizeKey(k) {
  return k.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
const safeStrandFilename = (name) => name.replace(/[/\\:*?"<>|]/g, "-").trim();
const dateOfRef = (ref) => ref.slice(0, 10).replace(/\//g, "-"); // "2026/09/04/0508" -> "2026-09-04"

async function phaseStrands() {
  console.log("\n== Phase B: strand entities ==");
  const groups = new Map(); // normalized -> [names]
  for (const k of Object.keys(strands)) {
    const n = normalizeKey(k);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(k);
  }
  const primaries = [...groups.values()]
    .map((names) => {
      const sorted = [...names].sort((a, b) => (strands[b].length - strands[a].length) || a.localeCompare(b));
      return { primary: sorted[0], aliases: sorted.slice(1) };
    })
    .sort((a, b) => a.primary.localeCompare(b.primary));
  console.log(`strand groups: ${primaries.length}`);

  let done = 0;
  for (const g of primaries) {
    if (ONLY_STRAND && g.primary !== ONLY_STRAND) continue;
    if (LIMIT && done >= LIMIT) break;
    const refs = [...new Set([g.primary, ...g.aliases].flatMap((k) => strands[k] ?? []))].sort();
    const firstSeen = dateOfRef(refs[0]);
    const lastActive = dateOfRef(refs[refs.length - 1]);
    const fileName = `${safeStrandFilename(g.primary)}.md`;
    const outPath = path.resolve(STRANDS_DIR, fileName);
    if (!outPath.startsWith(path.resolve(STRANDS_DIR) + path.sep)) {
      results.strandFiles.push({ file: fileName, ok: false, detail: "path escape rejected" });
      continue;
    }

    if (await exists(outPath)) {
      results.strandFiles.push({ file: `strands/${fileName}`, ok: "skipped", detail: "already exists" });
      continue;
    }

    // chronological evidence from the index (focus/summary lines), capped
    const evidence = refs
      .map((ref) => {
        const id = ref.replace(/\//g, "-");
        const e = indexById.get(id);
        return e ? { date: dateOfRef(ref), focus: e.focus, summary: e.summary } : null;
      })
      .filter(Boolean)
      .slice(0, 25);
    const evidenceText = evidence
      .map((e) => `- ${e.date}：${(e.focus || "").slice(0, 60)}｜${(e.summary || "").slice(0, 80)}`)
      .join("\n");

    const prompt = `你是一段对话记忆系统的整理同事。下面是一条"线索"（strand）——一个跨越多天的 recurring 话题，以及它关联的各时间片摘要（按时间排序，共 ${refs.length} 片，列出 ${evidence.length} 片）。

线索名称：${g.primary}${g.aliases.length ? `（别名：${g.aliases.join("、")}）` : ""}

## 关联时间片摘要

${evidenceText}

## 任务

为该线索写一段中文描述正文（1-2 段，总共 100-250 字），直接输出正文，不要标题、不要 JSON、不要列表。内容要求：
- 最早是什么时候提起的（用具体日期）；
- 主要聊了什么（主题、关键事件、决定）；
- 如果有明显演变，一句话带过。
只依据上面的摘要，不要编造。日期用 YYYY-MM-DD 格式。`;

    if (DRY) {
      console.log(`  [dry] would create strands/${fileName} (${refs.length} refs, ${firstSeen}..${lastActive})`);
      results.strandFiles.push({ file: `strands/${fileName}`, ok: "dry", detail: `${refs.length} refs` });
      continue;
    }

    try {
      const description = await llm(prompt, { maxTokens: 2000 });
      if (!description || description.length < 20)
        throw new Error(`description too short (got ${JSON.stringify((description ?? "").slice(0, 200))})`);

      const doc = `---
first_seen: '${firstSeen}'
last_active: '${lastActive}'
aliases: ${JSON.stringify(g.aliases)}
---
${description}
`;
      await fsp.mkdir(STRANDS_DIR, { recursive: true });
      await fsp.writeFile(outPath, doc, "utf8");
      console.log(`  wrote strands/${fileName} (${refs.length} refs)`);
      results.strandFiles.push({ file: `strands/${fileName}`, ok: true, detail: `${refs.length} refs` });
      done += 1;
    } catch (err) {
      console.log(`  FAILED ${fileName}: ${err?.message ?? err}`);
      results.strandFiles.push({ file: `strands/${fileName}`, ok: false, detail: String(err?.message ?? err) });
      if (capReached) break;
    }
  }
}

// ═══ Main ═════════════════════════════════════════════════════════════
console.log(`target: ${EPISODIC}`);
console.log(`model: ${MODEL}${DRY ? " (dry run — no LLM, no writes)" : ""}`);
console.log(`backup dir: ${BACKUP_DIR}`);

if (DRY) {
  await phaseSlices();
  await phaseStrands();
} else {
  // Pre-compute the write set for backup BEFORE touching anything.
  const backupSet = new Set(["episodic/timeline/index.json", "episodic/strands.json"]);
  const dirs = await collectSliceDirs(SLICES);
  for (const dir of dirs) {
    const corePath = path.join(dir, "timeline", "core.md");
    if (!(await exists(corePath))) continue;
    const raw = await fsp.readFile(corePath, "utf8");
    const split = splitFrontmatter(raw);
    if (split && !(fmHas(split.fmText, "focus") && fmHas(split.fmText, "summary"))) {
      backupSet.add(path.relative(MEMORY_ROOT, corePath).split(path.sep).join("/"));
    }
  }
  const backedUp = await backupFiles([...backupSet]);
  console.log(`backup: ${backedUp} file(s) snapshotted to ${BACKUP_DIR}`);

  try {
    await phaseSlices();
    if (!capReached) await phaseStrands();
  } finally {
    results.llmCalls = llmCalls;
    results.capReached = capReached;
  }
}

// ─── Run report ───────────────────────────────────────────────────────
results.llmCalls = llmCalls;
results.capReached = capReached;
const okMarks = results.sliceMarks.filter((r) => r.ok === true).length;
const okStrands = results.strandFiles.filter((r) => r.ok === true).length;
const failed = [
  ...results.sliceMarks.filter((r) => r.ok === false),
  ...results.strandFiles.filter((r) => r.ok === false),
];

const R = [];
R.push(`# Memory Backfill Run — ${today}`);
R.push(``);
R.push(`- Model: \`${MODEL}\` (serial, timeout ${TIMEOUT_MS}ms, ≤1 retry)`);
R.push(`- LLM calls: **${llmCalls} / ${MAX_CALLS}**${capReached ? " — HARD CAP REACHED, remaining items skipped" : ""}`);
R.push(`- Dry run: ${DRY}`);
R.push(`- Backup: \`${BACKUP_DIR}\``);
R.push(``);
R.push(`## Slice marking: ${okMarks} marked`);
R.push(``);
for (const r of results.sliceMarks) R.push(`- \`${r.id}\`: ${r.ok === true ? "OK" : r.ok}${r.detail ? ` — ${r.detail}` : ""}`);
R.push(``);
R.push(`## Strand files: ${okStrands} created`);
R.push(``);
for (const r of results.strandFiles) R.push(`- \`${r.file}\`: ${r.ok === true ? "OK" : r.ok}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length) {
  R.push(``);
  R.push(`## Failures (${failed.length}) — rerun to retry (idempotent)`);
  R.push(``);
  for (const r of failed) R.push(`- \`${r.file ?? r.id}\`: ${r.detail}`);
}

const reportPath = path.join(ROOT, "reports", "overnight", `backfill-memory-${today}.md`);
if (!DRY) {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, R.join("\n") + "\n", "utf8");
}

console.log(`\nsummary: ${okMarks} slices marked, ${okStrands} strand files, ${llmCalls} LLM calls${capReached ? " (CAP REACHED)" : ""}, ${failed.length} failures`);
if (!DRY) console.log(`report: ${reportPath}`);
