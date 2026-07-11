# Self-hosting

Previously is designed as a personal deployment, not a SaaS product — each user runs their own instance pointed at their own GitHub memory repo.

> **One sentence takeaway:** You own the whole stack. Your instance, your memory repo, your LLM key, your data. There is no shared backend, no multi-tenant service, no vendor lock-in.

## Status: experimental

Previously is in active early development (v0.1.0) and not yet ready for production or personal use. Self-hosting works today — these instructions are accurate for the shipped code — but you should expect breaking changes, rough edges, and undocumented corners. The project's status badge reads `status-experimental` and the README is candid about its readiness.

## How it works

The running application is a Next.js server (or serverless deployment) that uses the GitHub REST API — via a fine-grained personal access token — to read and write three whitelisted directories in a GitHub repository:

- `memory/` — episodic slices, memory nodes, and the strands index
- `tasks/` — task files
- `sessions/` — session state

The code lives in one repository; the memory data lives in a GitHub repository of its own. The app discovers its memory repo entirely through environment variables at runtime — `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME`. The two repos are decoupled by design.

## Prerequisites

| Requirement | Detail |
|---|---|
| **Node.js** | 20.9 or later (recommended, not enforced by `package.json`) |
| **Package manager** | `pnpm` (recommended; a `pnpm-lock.yaml` ships with the repo, but any npm-compatible runner works) |
| **GitHub memory repo** | A (preferably private) repository that will hold the agent's memory data — `memory/`, `tasks/`, `sessions/` |
| **GitHub token** | A fine-grained personal access token with **Contents** read and write permission, scoped to a single repository |
| **LLM API key** | A DeepSeek API key (`DEEPSEEK_API_KEY`). This is the only provider wired into the runtime code today. |

### About the Node.js version requirement

The README states Node.js 20.9+ as a minimum, but `package.json` does not include an `engines` field to enforce it. Node 20.9+ is the tested baseline; older versions may or may not work.

## Installation

```bash
git clone https://github.com/LikeDreamwalker/previously.git
cd Aftrbrez
pnpm install
```

> **Note on directory naming:** The repository was renamed to `previously` on GitHub, but the local checkout directory and the default `GITHUB_REPO_NAME` in `.env.example` remain `Aftrbrez`. When self-hosting, set `GITHUB_REPO_NAME` to **your own memory repository name**, not the default.

The `pnpm install` step resolves all dependencies. No global tools are needed beyond Node.js and pnpm.

## Configuration

Create a file named `.env.local` in the project root. The template below shows every variable the runtime actually reads:

```bash
# Required — DeepSeek API key (powers both Flash and Pro tiers)
DEEPSEEK_API_KEY=sk-...

# Required — GitHub fine-grained PAT (contents read/write, single repo)
GITHUB_TOKEN=github_pat_...

# Required — your memory repository owner and name
# These can point at a different repo from the one the code lives in.
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-memory-repo

# Optional — demo mode
# When set to "true", memory/ reads are redirected to a pre-seeded
# persona dataset (memory/demo/personal_14/). Writes still go to the
# real memory/ directory.
DEMO_MODE=false
```

### Environment variable reference

| Variable | Required | Runtime effect |
|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Authenticates both **Flash** (`deepseek-chat`, used for recall scanning and metadata maintenance) and **Pro** (the response/reasoning model). The Vercel AI SDK reads this automatically from the environment. No explicit `process.env` reference is needed. |
| `GITHUB_TOKEN` | Yes | Initializes the Octokit client. Every GitHub read and write flows through this token. The app throws at startup of any GitHub operation if this is unset. |
| `GITHUB_REPO_OWNER` | Yes | The GitHub username or organization that owns the memory repository. |
| `GITHUB_REPO_NAME` | Yes | The repository name for memory data. Code lives elsewhere; this var points the app at its data store. |
| `DEMO_MODE` | No | `"true"` to redirect memory reads to the demo persona. Default `"false"`. Only relevant for evaluation deployments. |
| `ANTHROPIC_API_KEY` | No | Listed in the README as an option, and `@ai-sdk/anthropic` is installed as a dependency, but **no source code instantiates an Anthropic provider today**. Setting this variable has no runtime effect. Multi-model support is on the roadmap but not yet wired. |
| `DEMO_REF` | No | Present in the code (`src/lib/demo/paths.ts`) but undocumented in README and `.env.example`. Pins GitHub reads to a specific branch/tag/sha in demo mode. Not needed for a standard self-hosted instance. |

### What each variable powers

The token and repo variables are consumed at runtime by multiple modules:

- `src/lib/github/client.ts` — creates the authenticated Octokit instance
- `src/lib/episodic/manager.ts` — reads and writes episodic slices
- `src/lib/identity/user-profile.ts` and `profile-writer.ts` — user identity backed by GitHub
- `src/app/api/chat/route.ts` — the main chat API route
- `src/app/api/episodic/flush/route.ts` — slice flush endpoint

The two-tier model (Flash for fast recall, Pro for deep reasoning) uses `deepseek-chat` exclusively — the model registry (`src/lib/models/registry.ts`) defines only DeepSeek models at this point. A single `DEEPSEEK_API_KEY` covers both tiers.

### Separate code repo and memory repo

This is worth repeating: the code and the memory data can live in entirely different GitHub repositories. The running application never assumes they are the same. You set:

```
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-memory-repo
```

and the app reads and writes `memory/`, `tasks/`, and `sessions/` in that repository. The code is deployed from whatever repository you cloned. This separation lets you keep a private memory repo while, say, forking the code publicly.

## Development

```bash
pnpm dev          # Start dev server with Turbopack (port 3000)
pnpm build        # Production build with Turbopack
pnpm lint         # Run ESLint
pnpm test         # Run vitest
pnpm start        # Start the production server
```

Two scripts — `predev` and `prebuild` — run `node scripts/generate-identity.mjs` automatically before `dev` and `build`. No manual intervention is needed.

## Deploy on Vercel

The easiest deployment path is Vercel (edge/serverless). There is no `vercel.json` in the repository — the default Next.js configuration is sufficient.

1. Push your fork of Previously to GitHub.
2. Import the repository in the Vercel dashboard, or use the one-click deploy button from the README.
3. Set the same environment variables (`DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, and optionally `DEMO_MODE`) in your Vercel project settings under **Settings > Environment Variables**.
4. Deploy.

The same env vars you used locally are the exact ones Vercel needs. No additional configuration is required.

### Deploying with a demo persona

Set `DEMO_MODE=true` in your Vercel environment variables. The app redirects memory reads to the bundled demo dataset (`memory/demo/personal_14/`), letting the instance run without a live memory repo. Writes still target the real `memory/` directory in your configured repo. If you also need the demo to read from a specific branch (rather than the repository default), set `DEMO_REF` to a branch name, tag, or commit SHA.

## Security boundary

The GitHub token is scoped to a single repository with Contents read and write permission only. The server-side path whitelist (`src/lib/whitelist/`) restricts agent file operations to three directories:

| Directory | Agent access |
|---|---|
| `memory/` | Read and write |
| `tasks/` | Read and write |
| `sessions/` | Read and write |
| `src/` | Read-only (agent tools may not modify code) |

This is enforced server-side. The client is untrusted.

## Related

- [Architecture overview](/content/docs/en/architecture) — the three-layer separation and data model
- [Episodic memory](/content/docs/en/episodic-memory) — how slices and strands work
- [Environment reference](/content/docs/en/environment) — every env var, its origin, and its current wiring status
