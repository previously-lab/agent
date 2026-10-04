/**
 * Companion (the mouth) read-only tool set — standalone `tool()` definitions
 * for a plain streamText call (design v0.11 §5).
 *
 * The chat turn's executors in ../agent/tool-executors.ts carry "use step"
 * directives: they can ONLY run inside a durable workflow run, so they cannot
 * be imported here. These are thin standalone implementations over the same
 * underlying data-source readers (readFile / readFileDemo / readFileLocal and
 * their listFiles siblings) and the same pure parsers (parseSliceId,
 * parseTurns, matter).
 *
 * READ-ONLY by contract: no rework-signal logging, no weave, no cache writes,
 * no write batch — the mouth never picks up the pen.
 */

import { tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";
import { readFile } from "@/lib/tools/readFile";
import { listFiles as listFilesGitHub } from "@/lib/tools/listFiles";
import { readFileLocal, listFilesLocal } from "@/lib/tools/local-fs";
import { readFileDemo, listFilesDemo } from "@/lib/demo/demo-fs";
import {
  parseSliceId,
  parseTurns,
} from "@/lib/episodic/turn-parser";
import { annotateSliceWithLocalTime } from "@/lib/episodic/time-localize";
import {
  slicePartPathCandidates,
  RECORDS_ROOT,
  LEGACY_SLICES_ROOT,
} from "@/lib/episodic/paths";
import { formatLocalTime } from "@/lib/turn-priming";

/** Serializable per-request context the tool executors close over. */
export interface CompanionToolContext {
  /** GitHub repo name (or "local" without GITHUB_TOKEN). */
  repo: string;
  /** GitHub repo owner (or "local" without GITHUB_TOKEN). */
  owner: string;
  /** Read through the GitHub backend. */
  useGithub: boolean;
  /** Read through the demo (benchmark) backend. */
  useDemo: boolean;
  /** The user's IANA timezone — read tools pre-render local-time annotations. */
  timezone?: string;
  /** UI locale ("zh" | "en") — annotation language follows it. */
  locale?: string;
}

/**
 * The one data-source dispatch every companion read goes through — the same
 * useDemo → useGithub → local ordering as the chat executors
 * (tool-executors.ts:272-274).
 */
export async function readMemoryFile(
  ctx: CompanionToolContext,
  path: string,
): Promise<string> {
  if (ctx.useDemo) return readFileDemo(path);
  if (ctx.useGithub) return readFile(path, ctx.repo, ctx.owner);
  return readFileLocal(path);
}

/**
 * Directory listing through the same data-source dispatch as readMemoryFile —
 * the live enumeration (v0.19 §A.2.4) lists month/day directories instead of
 * reading the retired `_index.json` projection.
 */
export async function listMemoryDir(
  ctx: CompanionToolContext,
  path: string,
): Promise<Array<{ name: string; type: "file" | "dir" }>> {
  if (ctx.useDemo) return listFilesDemo(path);
  if (ctx.useGithub) return listFilesGitHub(path, ctx.repo, ctx.owner);
  return listFilesLocal(path);
}

/**
 * Deterministic domain outcomes reach the MODEL as tool results, not throws —
 * same regex triage as the chat executors (tool-executors.ts:234-241).
 */
const DOMAIN_ERROR_RE =
  /^(File not found|Directory not found|Access denied)|is (a directory, not a file|not a regular file)|too large/;

function domainError(e: unknown): string | null {
  return e instanceof Error && DOMAIN_ERROR_RE.test(e.message)
    ? e.message
    : null;
}

/**
 * Read a slice's core.md — dual-root (v0.19 R2): the new records root first,
 * the legacy slices root on a miss. Returns null for an invalid slice id;
 * throws when neither root holds the file.
 */
async function readSliceCoreDual(
  ctx: CompanionToolContext,
  sliceId: string,
): Promise<string | null> {
  const parsed = parseSliceId(sliceId);
  if (!parsed) return null;
  const [primary, fallback] = slicePartPathCandidates(sliceId, "core");
  try {
    return await readMemoryFile(ctx, primary);
  } catch {
    return readMemoryFile(ctx, fallback);
  }
}

/**
 * The three read-only tools the narrator gets. Built per request so the
 * executors close over that request's data-source context.
 */
export function buildCompanionTools(ctx: CompanionToolContext) {
  return {
    readSlice: tool({
      description:
        "Open a time slice's original conversation record (core timeline) — " +
        "the verbatim turns of that slice, with the user's local time annotated " +
        "on each turn header. This is the SOURCE of a narration: read it before " +
        "speaking about a slice. Returns an ERROR line when the slice does not " +
        "exist — never invent content for a missing slice.",
      inputSchema: z.object({
        sliceId: z
          .string()
          .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      }),
      execute: async ({ sliceId }: { sliceId: string }) => {
        try {
          const raw = await readSliceCoreDual(ctx, sliceId);
          if (raw === null) {
            return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
          }
          // Pre-render the user's local time so the model never converts UTC itself.
          return ctx.timezone
            ? annotateSliceWithLocalTime(raw, ctx.timezone, sliceId, {
                locale: ctx.locale,
              })
            : raw;
        } catch (e) {
          const msg = domainError(e);
          if (msg === null) throw e;
          return `ERROR: ${msg}. This time slice does not exist.`;
        }
      },
    }),

    readSliceSummary: tool({
      description:
        "Read a slice's summary (frontmatter only): focus, summary, " +
        "tone, turn count, open loops, decisions. The CHEAPEST way to check " +
        "what a slice is about before reading its turns — use it first when " +
        "orienting around the target slice or its neighbors.",
      inputSchema: z.object({
        sliceId: z
          .string()
          .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      }),
      execute: async ({ sliceId }: { sliceId: string }) => {
        try {
          const raw = await readSliceCoreDual(ctx, sliceId);
          if (raw === null) {
            return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
          }
          const { data } = matter(raw);
          const { turns } = parseTurns(raw);
          const fmt = (v: unknown): string =>
            Array.isArray(v) && v.length ? v.join("; ") : "(none)";
          const lines = [
            `slice ${sliceId}`,
            `start: ${typeof data.start === "string" ? data.start : "?"}`,
            `end: ${typeof data.end === "string" ? data.end : "(active)"}`,
            `turns: ${turns.length}`,
            `focus: ${typeof data.focus === "string" && data.focus ? data.focus : "(none)"}`,
            `summary: ${typeof data.summary === "string" && data.summary ? data.summary : "(none)"}`,
            `tone: ${typeof data.emotional_tone === "string" && data.emotional_tone ? data.emotional_tone : "(none)"}`,
            `open_loops: ${fmt(data.open_loops)}`,
            `decisions: ${fmt(data.decisions)}`,
          ];
          const note = ctx.timezone
            ? `\n(时间均为 UTC；本地时区 ${ctx.timezone})`
            : "";
          return lines.join("\n") + note;
        } catch (e) {
          const msg = domainError(e);
          if (msg === null) throw e;
          return `ERROR: ${msg}. This time slice does not exist.`;
        }
      },
    }),

    readTimeline: tool({
      description:
        "List every time slice of one month — live-enumerated from the " +
        "records tree (the month directory IS the index; no projection is " +
        "read), each with its start, focus, summary and open loops. Use it " +
        "to situate the target slice among its neighbors ('what else " +
        "happened around that day') before or while narrating. Slice ids " +
        "are UTC-derived; each entry's start also carries localStart (the " +
        "user's local time) when a timezone is set.",
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
      }),
      execute: async ({ year, month }: { year: number; month: number }) => {
        const mm = String(month).padStart(2, "0");
        try {
          // Live enumeration (v0.19 §A.2.4), dual-root: the day/slice
          // directories under BOTH roots are the truth — the new records
          // root and the legacy slices root, merged by id so a month
          // straddling the root move reads whole.
          const ids = new Set<string>();
          for (const root of [RECORDS_ROOT, LEGACY_SLICES_ROOT]) {
            const monthDir = `${root}/${year}/${mm}`;
            const days = await listMemoryDir(ctx, monthDir).catch(() => []);
            for (const d of days) {
              if (d.type !== "dir" || !/^\d{2}$/.test(d.name)) continue;
              const sliceDirs = await listMemoryDir(
                ctx,
                `${monthDir}/${d.name}`,
              ).catch(() => []);
              for (const s of sliceDirs) {
                if (s.type === "dir" && /^\d{4}$/.test(s.name)) {
                  ids.add(`${year}-${mm}-${d.name}-${s.name}`);
                }
              }
            }
          }
          if (ids.size === 0) {
            return { exists: false, month: `${year}-${mm}`, slices: [] };
          }

          // Point-read each enumerated slice's header (dual-root core.md) —
          // a slice whose file is unreadable is skipped, never faked.
          const entries = (
            await Promise.all(
              [...ids].sort().map(async (id) => {
                const raw = await readSliceCoreDual(ctx, id).catch(() => null);
                if (!raw) return null;
                const { data } = matter(raw);
                return {
                  id,
                  start: typeof data.start === "string" ? data.start : "",
                  ...(typeof data.end === "string" && data.end
                    ? { end: data.end }
                    : {}),
                  status:
                    data.closed_by || data.status === "closed"
                      ? "closed"
                      : "active",
                  focus: typeof data.focus === "string" ? data.focus : "",
                  summary: typeof data.summary === "string" ? data.summary : "",
                  open_loops: Array.isArray(data.open_loops)
                    ? data.open_loops
                    : [],
                  decisions: Array.isArray(data.decisions) ? data.decisions : [],
                };
              }),
            )
          ).filter((e): e is NonNullable<typeof e> => e !== null);

          const data = {
            exists: true,
            month: `${year}-${mm}`,
            slices: entries as unknown[],
          };
          // Pre-render each slice's start in the user's local time so the model
          // never converts UTC itself (mirrors readTimelineExecute).
          if (ctx.timezone) {
            const tz = ctx.timezone; // narrowed string — stable across the map closure
            const slices = data.slices.map((s) => {
              if (
                s &&
                typeof s === "object" &&
                "start" in s &&
                typeof (s as { start?: unknown }).start === "string"
              ) {
                const rec = s as Record<string, unknown>;
                return {
                  ...rec,
                  localStart: formatLocalTime(rec.start as string, tz).local,
                };
              }
              return s;
            });
            return {
              ...data,
              slices,
              timezoneNote: `每个 slice 已附带 localStart（用户当地，${tz}）；start 为原始 UTC。`,
            };
          }
          return data;
        } catch {
          return { exists: false, month: `${year}-${mm}`, slices: [] };
        }
      },
    }),
  };
}
