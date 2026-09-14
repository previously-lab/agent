/**
 * Companion (the mouth) read-only tool set — standalone `tool()` definitions
 * for a plain streamText call (design v0.11 §5).
 *
 * The chat turn's executors in ../agent/tool-executors.ts carry "use step"
 * directives: they can ONLY run inside a durable workflow run, so they cannot
 * be imported here. These are thin standalone implementations over the same
 * underlying data-source readers (readFile / readFileDemo / readFileLocal)
 * and the same pure parsers (parseSliceId, parseTurns, matter).
 *
 * READ-ONLY by contract: no rework-signal logging, no weave, no cache writes,
 * no write batch — the mouth never picks up the pen.
 */

import { tool } from "ai";
import { z } from "zod";
import matter from "gray-matter";
import { readFile } from "@/lib/tools/readFile";
import { readFileLocal } from "@/lib/tools/local-fs";
import { readFileDemo } from "@/lib/demo/demo-fs";
import {
  parseSliceId,
  parseTurns,
} from "@/lib/episodic/turn-parser";
import { annotateSliceWithLocalTime } from "@/lib/episodic/time-localize";
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

function sliceCorePath(sliceId: string): string | null {
  const parsed = parseSliceId(sliceId);
  if (!parsed) return null;
  return `memory/episodic/slices/${parsed.y}/${parsed.m}/${parsed.d}/${parsed.hm}/timeline/core.md`;
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
        const path = sliceCorePath(sliceId);
        if (!path) {
          return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
        }
        try {
          const raw = await readMemoryFile(ctx, path);
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
        "Read a slice's summary (frontmatter only): focus, summary, tags, " +
        "tone, turn count, open loops, decisions. The CHEAPEST way to check " +
        "what a slice is about before reading its turns — use it first when " +
        "orienting around the target slice or its neighbors.",
      inputSchema: z.object({
        sliceId: z
          .string()
          .describe("Slice ID in YYYY-MM-DD-HHMM format, e.g. '2026-07-24-1500'."),
      }),
      execute: async ({ sliceId }: { sliceId: string }) => {
        const path = sliceCorePath(sliceId);
        if (!path) {
          return "ERROR: Invalid slice ID. Expected format: YYYY-MM-DD-HHMM (e.g. 2026-07-24-1500).";
        }
        try {
          const raw = await readMemoryFile(ctx, path);
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
            `tags: ${fmt(data.tags)}`,
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
        "Read a monthly timeline index — every slice of that month with its " +
        "focus, summary and tags. Use it to situate the target slice among its " +
        "neighbors ('what else happened around that day') before or while " +
        "narrating. Slice ids in the index are UTC-derived; each entry's start " +
        "also carries localStart (the user's local time) when a timezone is set.",
      inputSchema: z.object({
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
      }),
      execute: async ({ year, month }: { year: number; month: number }) => {
        const mm = String(month).padStart(2, "0");
        const path = `memory/episodic/slices/${year}/${mm}/_index.json`;
        try {
          const raw = await readMemoryFile(ctx, path);
          const data = JSON.parse(raw) as {
            exists: boolean;
            month: string;
            slices: unknown[];
          };
          // Pre-render each slice's start in the user's local time so the model
          // never converts UTC itself (mirrors readTimelineExecute).
          if (Array.isArray(data.slices) && ctx.timezone) {
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
