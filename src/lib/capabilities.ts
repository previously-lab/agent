/**
 * Global capability checks — the single source of truth for "what can this
 * app do right now?"
 *
 * Every engineering-side check (tool executors, server components, API routes,
 * config loaders) should import from here instead of reading process.env
 * directly. The AI model layer does NOT import this — it learns about
 * limitations through tool-executor rejections returned as tool results.
 *
 * Decision flow:
 *
 *   DEEPSEEK_API_KEY set?
 *   ├─ NO  → App is non-functional (no AI). Show setup guidance.
 *   └─ YES → GITHUB_TOKEN set?
 *             ├─ NO  → Demo mode: can chat, CANNOT write, CANNOT loop.
 *             └─ YES → Production mode: full read/write, loops available.
 */

// ─── Core checks ──────────────────────────────────────────────────────────

/** Can the app make AI calls? DeepSeek API key is configured. */
export function isAIConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

/**
 * Is the app in read-only demo mode?
 * True when no GitHub token is configured — the user is browsing pre-seeded
 * persona data and cannot persist anything.
 */
export function isDemo(): boolean {
  return !process.env.GITHUB_TOKEN;
}

/**
 * Can the app persist data?
 * True when a GitHub token is configured, giving the agent write access to
 * the user's own memory repository. The inverse of isDemo().
 */
export function canWrite(): boolean {
  return !!process.env.GITHUB_TOKEN;
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
