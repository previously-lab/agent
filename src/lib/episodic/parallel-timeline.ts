/**
 * Parallel Timeline — topic-based index over time slices.
 *
 * Each topic is a single MD+YAML file in memory/episodic/parallel-timelines/.
 * Frontmatter carries the index (sources), body carries the summary (Pro-generated).
 *
 * Recall Agent reads only the frontmatter (sources) — never the slice bodies.
 * Core Agent receives pointers ({ slice, turns, relevance }) and decides
 * which slice bodies to expand via readMemory.
 */

import matter from "gray-matter";
import { readFile as readFileGitHub } from "@/lib/tools/readFile";
import { writeFile as writeFileGitHub } from "@/lib/tools/writeFile";
import { readFileLocal, writeFileLocal } from "@/lib/tools/local-fs";

// ─── Types ──────────────────────────────────────────────────────────────

export interface TopicSource {
  /** Relative path like "2026/07/02" */
  slice: string;
  /** Turn numbers (1-based) that contain this topic */
  turns: number[];
  /** Relevance 0-1 */
  relevance: number;
  /** Open loops carried forward from this slice for this topic */
  open_loops?: string[];
  /** Decisions made about this topic in this slice */
  decisions?: string[];
}

export interface TopicIndex {
  topic: string;
  sources: TopicSource[];
  /** Body of the MD file — the topic summary (Pro-generated, 100-200 chars) */
  summary: string;
}

// ─── Path helpers ──────────────────────────────────────────────────────

function topicPath(topic: string): string {
  const normalized = topic.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `memory/episodic/parallel-timelines/${normalized}.md`;
}

// ─── I/O helpers ───────────────────────────────────────────────────────

const USE_GITHUB = process.env.GITHUB_TOKEN != null;

function getRepoConfig(): { owner: string; repo: string } {
  return {
    owner: process.env.GITHUB_REPO_OWNER ?? "local",
    repo: process.env.GITHUB_REPO_NAME ?? "local",
  };
}

async function fsRead(path: string): Promise<string> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    return readFileGitHub(path, repo, owner);
  }
  return readFileLocal(path);
}

async function fsWrite(path: string, content: string): Promise<void> {
  if (USE_GITHUB) {
    const { owner, repo } = getRepoConfig();
    await writeFileGitHub(path, content, repo, owner, `Update ${path}`);
    return;
  }
  await writeFileLocal(path, content);
}

// ─── Read ───────────────────────────────────────────────────────────────

/**
 * Read a topic's parallel timeline file.
 * Returns null if the topic doesn't exist yet (no time slices have mentioned it).
 *
 * @param topic — raw topic name from Flash (e.g. "rust", "borrow-checker")
 * @returns TopicIndex with sources and summary, or null
 */
export async function readTopic(topic: string): Promise<TopicIndex | null> {
  const path = topicPath(topic);
  try {
    const raw = await fsRead(path);
    const { data, content } = matter(raw);
    return {
      topic: data.topic ?? topic,
      sources: Array.isArray(data.sources) ? data.sources : [],
      summary: content.trim(),
    };
  } catch {
    return null; // topic doesn't exist yet
  }
}

/**
 * Scan multiple topics and collect all recall hits (unique by slice+turns).
 * Sorted by relevance descending.
 */
export async function scanTopics(
  topics: string[]
): Promise<TopicSource[]> {
  const seen = new Set<string>();
  const hits: TopicSource[] = [];

  for (const topic of topics) {
    const index = await readTopic(topic);
    if (!index) continue;

    for (const source of index.sources) {
      const key = `${source.slice}:${source.turns.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(source);
    }
  }

  return hits.sort((a, b) => b.relevance - a.relevance);
}

// ─── Write ──────────────────────────────────────────────────────────────

/**
 * Update (or create) the sources for a topic.
 * Appends new sources, updates existing ones if same slice+overlapping turns.
 *
 * Called after time slice close — Flash extracts topics from the closed slice.
 */
export async function updateTopicSources(
  topic: string,
  newSources: TopicSource[]
): Promise<void> {
  const existing = await readTopic(topic);
  const sources = existing?.sources ? [...existing.sources] : [];
  const summary = existing?.summary ?? "";

  for (const ns of newSources) {
    // Check if this slice already has a source entry
    const idx = sources.findIndex((s) => s.slice === ns.slice);
    if (idx >= 0) {
      // Update: merge turns, keep highest relevance, merge open_loops/decisions
      const merged = new Set([...sources[idx].turns, ...ns.turns]);
      sources[idx] = {
        ...sources[idx],
        turns: [...merged].sort((a, b) => a - b),
        relevance: Math.max(sources[idx].relevance, ns.relevance),
        open_loops: ns.open_loops ?? sources[idx].open_loops,
        decisions: ns.decisions ?? sources[idx].decisions,
      };
    } else {
      sources.push(ns);
    }
  }

  await writeTopicFile(topic, sources, summary);
}

/**
 * Update the topic summary (body of the MD file).
 * Called by Pro when a topic has 3+ sources — generates a 100-200 char personal history.
 */
export async function updateTopicSummary(
  topic: string,
  summary: string
): Promise<void> {
  const existing = await readTopic(topic);
  if (!existing) return;

  await writeTopicFile(topic, existing.sources, summary);
}

async function writeTopicFile(
  topic: string,
  sources: TopicSource[],
  summary: string
): Promise<void> {
  const path = topicPath(topic);
  const normalized = topic.toLowerCase().replace(/\s+/g, "-");

  const frontmatter: Record<string, unknown> = {
    topic: normalized,
    sources,
  };

  const md = matter.stringify(summary.trim(), frontmatter);
  await fsWrite(path, md);
}
