/**
 * Global capability checks — the single source of truth for "what can this
 * app do right now?"
 *
 * Every engineering-side check (tool executors, server components, API routes,
 * config loaders) should import from here instead of reading process.env
 * directly. The AI model layer does NOT import this — it learns about
 * limitations through tool-executor rejections returned as tool results.
 *
 * Data-source logic delegates to @/lib/data-source/resolve — this module only
 * answers capability questions derived from that source.
 */

import { getAvailableModels } from "@/lib/models/registry";
import { resolveDataSource, isWritable } from "@/lib/data-source/resolve";

// ─── Core checks ──────────────────────────────────────────────────────────

/**
 * Known AI provider → API key env var. Covers the common OpenAI-compatible
 * providers (Kimi, Qwen, Mistral, xAI, ...) plus DeepSeek/Anthropic. This is
 * the coarse "can we make any AI call" gate; the full dynamic catalog (which
 * may include providers beyond this list) is resolved in @/lib/models/catalog.
 */
export function isProviderConfigured(provider: string): boolean {
  return provider === "deepseek" && getAvailableModels().length > 0;
}
export function getConfiguredProviders(): string[] {
  return isProviderConfigured("deepseek") ? ["deepseek"] : [];
}
export function isAIConfigured(): boolean { return isProviderConfigured("deepseek"); }

/**
 * Is the app in read-only demo mode?
 * True when the resolved data source is "demo".
 */
export function isDemo(): boolean {
  return resolveDataSource() === "demo";
}

/**
 * Can the app persist data?
 * True when the data source supports writes (local or github). The inverse
 * of demo mode.
 */
export function canWrite(): boolean {
  return isWritable();
}

// ─── Centralized repo identity ────────────────────────────────────────────

/**
 * GitHub repository identity, resolved once from environment.
 * Replaces the duplicated `getRepoConfig()` pattern that existed in 8+ files.
 */
export function getRepoConfig(): { owner: string; repo: string } {
  const owner = process.env.GITHUB_REPO_OWNER ?? "local";
  const repo = process.env.GITHUB_REPO_NAME ?? "local";
  return { owner, repo };
}

// ─── URLs ─────────────────────────────────────────────────────────────────

/** Deployment guide — shown to users who need to set up their own instance. */
export const DEPLOY_GUIDE_URL = "https://previously.ldwid.com/docs/deployment";
