# Configuration

Previously is configured exclusively through environment variables — six shipped vars, zero config files, one implicit backend switch that determines whether reads hit GitHub's API or your local filesystem.

> **Key takeaway:** Three variables are required (`DEEPSEEK_API_KEY`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`). A fourth (`GITHUB_TOKEN`) is what you think of as required — it gates the entire GitHub backend. Without it, the app reads and writes the local filesystem instead.

## Environment variable reference

Every variable the runtime actually reads, in one table:

| Variable | Required | Shipped | Default | Runtime effect |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Yes | — | Powers both Flash and Pro tiers. The `@ai-sdk/deepseek` provider reads it automatically from the environment — no source file references `process.env.DEEPSEEK_API_KEY` directly. |
| `GITHUB_TOKEN` | See note | Yes | — | Presence of this variable **is the backend switch**. When set, the app uses the Octokit/GitHub API backend; when absent, the app falls back to the local filesystem. Leave unset or commented out for local development. An empty string `GITHUB_TOKEN=` will now correctly fall back to local filesystem. A fine-grained PAT with Contents read/write scoped to a single repository. |
| `GITHUB_REPO_OWNER` | When using GitHub backend | Yes | `local` | GitHub username or organization that owns the memory repository. Read at multiple modules including the chat route, flush endpoint, episodic manager, and identity/profile. |
| `GITHUB_REPO_NAME` | When using GitHub backend | Yes | `local` | The repository name for memory data. Same consumption points as `GITHUB_REPO_OWNER`. |
| `DEMO_MODE` | No | Yes | `false` | When set to the string `"true"`, redirects all `memory/` reads to a pre-seeded persona dataset at `memory/demo/personal_14/`. Writes are accepted but never persisted on **both** backends — the app returns a success response but discards the data. The locale layout also renders a `<DemoBanner />` component. |
| `DEMO_REF` | No | Yes (undocumented in `.env.example`) | — | Git ref (branch, tag, or SHA) that demo-mode GitHub reads are pinned to. Lets a token-backed demo deployment read from a demo branch instead of the intentionally-empty main branch. Only active when `DEMO_MODE=true`. |
| `ANTHROPIC_API_KEY` | No | Roadmap only | — | Appears in `README.md` and the `@ai-sdk/anthropic` dependency is installed, but **no shipped code reads `process.env.ANTHROPIC_API_KEY`** or instantiates an Anthropic provider. Multi-provider support is typed in the model registry (`provider: "deepseek" | "anthropic" | "openai"`) but `DEFAULT_MODELS` ships only DeepSeek entries. Setting this variable has zero runtime effect in v0.1.0. |

> **Note on `GITHUB_TOKEN`:** The code decides its backend with a single expression — `const USE_GITHUB = !!process.env.GITHUB_TOKEN` — declared independently in seven modules (chat route, flush route, episodic manager, user profile, profile writer, maintenance, and the identity/profile endpoint). There is no dedicated `USE_GITHUB` environment variable. Token present = GitHub API. Token absent = local filesystem. This is intentional: the simplest possible toggle, no config file, no extra surface area.

## Backend switch: GitHub API vs local filesystem

The storage backend is implicit by design. No env var, no config toggle — just the presence or absence of `GITHUB_TOKEN`:

```typescript
const USE_GITHUB = !!process.env.GITHUB_TOKEN;
```

| Backend | When selected | How reads work | How writes work |
|---|---|---|---|
| **GitHub API** | `GITHUB_TOKEN` is set | `octokit.rest.repos.getContent`, base64-decoded. Requires `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME`. | `createOrUpdateFileContents` on the same repo. |
| **Local filesystem** | `GITHUB_TOKEN` is not set | `fs.readFileSync` from `DATA_ROOT = join(process.cwd())`. Reads physical files from the project root. | `fs.writeFileSync` to the same root. |

Both backends enforce the same security boundary:
- **Path whitelist**: only `memory/`, `tasks/`, and `sessions/` are read-write; `src/` is agent read-only
- **Size cap**: `MAX_FILE_SIZE_BYTES = 1_000_000` (1 MB) on all file reads

The local-filesystem backend is what you use during development (`pnpm dev`). It reads and writes real files on disk — no GitHub, no network, no rate limits. The GitHub backend is what you deploy to Vercel. The code paths diverge at the route handlers (see `src/app/api/chat/route.ts` lines ~434-475), but the interface is identical.

## DEMO_MODE behavior

`DEMO_MODE=true` puts the entire memory layer into a read-only demonstration mode against a bundled persona dataset. Here is exactly what changes:

### Path redirection

Every `memory/` read path is rewritten by `resolveDemoPath` (`src/lib/demo/paths.ts`):

```
memory/episodic/slices/...  →  memory/demo/personal_14/episodic/slices/...
memory/nodes/some-node.md   →  memory/demo/personal_14/nodes/some-node.md
```

The rewrite is guarded to fire only for paths starting with `memory/` that don't already carry the `memory/demo/personal_14/` prefix (idempotent). A companion `unresolveDemoPath` reverses the mapping so callers stay in the original namespace.

### Writes: accepted, never persisted

DEMO_MODE makes writes a no-op on **both** storage backends:

- **Local-filesystem** (`src/lib/tools/local-fs.ts` lines 52-54): returns `{ path, created: false }` without writing to disk
- **GitHub API** (`src/lib/tools/writeFile.ts` lines 25-27): returns the same early-success response, never calls `createOrUpdateFileContents`

The agent sees a successful write. The data is silently discarded.

### Demo ref for GitHub deployments

When deploying with `DEMO_MODE=true` and `GITHUB_TOKEN` set, you also need `DEMO_REF`. Without it, the GitHub API reads from the repository's default branch (`main`) — which is intentionally empty in the demo scenario. Set `DEMO_REF` to the branch, tag, or SHA where the demo dataset lives:

```bash
DEMO_MODE=true
DEMO_REF=demo-branch-name
```

The ref is applied at `src/lib/tools/readFile.ts` line 30: `ref: ref ?? demoRef()`. The `demoRef()` helper (`src/lib/demo/paths.ts`) returns `process.env.DEMO_REF || undefined` — only active when `DEMO_MODE` is true.

> `DEMO_REF` is present in the code but **not documented in `.env.example`** — a documentation gap in v0.1.0.

### UI banner

The locale layout (`src/app/[locale]/layout.tsx`) conditionally renders `<DemoBanner />` when `DEMO_MODE=true`. Users see a visual indicator that the instance is running in demo mode.

## Model registry and DeepSeek routing

Previously ships with a DeepSeek-only model registry. Two tiers, one model family:

| Tier | Purpose | Model | Temperature | Tool mode |
|---|---|---|---|---|
| **Flash** | Unified intent classification + recall scanning + metadata maintenance | `deepseek-chat` | 0.1 | `toolChoice: 'required'` |
| **Pro** | Deep reasoning, full-slice reads, response generation | `deepseek-chat` (default, not `deepseek-reasoner`) | SDK default | User choice |

### Flash is hardcoded

The Flash pass runs **before** the response stream opens. It makes one `generateText` call to `deepseek-chat` (temperature 0.1, `toolChoice: 'required'`) that performs three jobs in a single round-trip: intent classification, recall scanning, and metadata maintenance. It is invoked at `src/lib/router/flash.ts:124` and `src/lib/episodic/maintenance.ts:144`. There is no configuration for Flash — it always uses `deepseek-chat`.

### Pro model selection

The Pro model is selected per-request from the client:

```typescript
const model = (body.model as string) ?? 'deepseek-chat';
```

The client default is `deepseek-chat` as well (`getClientSetting('PREVIOUSLY_MODEL', 'deepseek-chat')`). The model registry (`src/lib/models/registry.ts`) defines exactly two models:

| Model ID | Display name | Supports thinking | Vision | Max tokens |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | Yes | No | 65536 |
| `deepseek-reasoner` | DeepSeek Reasoner | Yes | No | 65536 |

`deepseek-reasoner` exists in the registry and is available as a user-selectable option, but it is **not the default** and is **not auto-selected** by the thinking toggle. The shipped path stays on `deepseek-chat`.

### Thinking toggle

The thinking toggle is a request-level boolean (`body.thinking`, default `true`) that is **not** a model switch. When enabled, the server adds provider options to the `deepseek-chat` call:

```typescript
providerOptions: {
  deepseek: {
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium',
  },
}
```

When disabled, no `providerOptions` are sent. The thinking duration is measured server-side (wall-clock time between the first reasoning chunk and the first text chunk) and emitted as a `data-reasoning` event — not tracked client-side via timers.

> **Nuance:** `deepseek-reasoner` exists in the registry but the thinking toggle does not switch to it. Both the route code and the client default are `deepseek-chat`. The toggle is a **provider-level option on deepseek-chat**, not a model swap.

## Internationalization

i18n uses `next-intl` with exactly two locales:

| Locale | Code | Default |
|---|---|---|
| English | `en` | Yes |
| Chinese | `zh` | No |

Configuration lives in `src/i18n/routing.ts`:

```typescript
defineRouting({
  locales: ['en', 'zh'],
  defaultLocale: 'en',
});
```

Translation files:
- `messages/en.json`
- `messages/zh.json`

Navigation must use utilities from `@/i18n/navigation` instead of `next/navigation` (enforced by project convention). The locale layout wraps content in `NextIntlClientProvider`.

## The omitted vars

A few environment variables you might expect, and why they do not exist:

| You might expect | Reality |
|---|---|
| `USE_GITHUB` | Does not exist. The backend switch is `!!process.env.GITHUB_TOKEN` — implicit, zero-config, intentional. |
| `LOG_LEVEL` | Not implemented. Logging is thin in v0.1.0. |
| `DATABASE_URL` | There is no database. State lives in GitHub files. |
| `PORT` | Not read by the app; Next.js handles it. |
| `ANTHROPIC_API_KEY` | Installed dependency, README mentions it, **but no shipped code reads it**. Roadmap/aspirational. |

## Related

- [Self-hosting](/docs/en/self-hosting) — deployment walkthrough with the full `.env.local` template
- [Episodic Memory](/docs/en/episodic-memory) — how slices and strands work; the data that configuration makes accessible
- [Recall](/docs/en/recall) — how Flash and Pro use the configured models
