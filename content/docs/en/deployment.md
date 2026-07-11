# Deployment

Get your own Previously running in about 10 minutes. You'll fork the repository, create a GitHub token, and deploy to Vercel. No server management, no database setup — just a fork, a token, and a deploy.

```alert
⚠️ Important: No authentication yet. Previously is in early development and does not yet have built-in authentication or access control. Anyone with your deployment URL can use your instance — and access or modify your memory data. Keep your deployment URL private. Do not share it publicly. Limit your Vercel deployment visibility if possible. Authentication is a high-priority feature and will be available soon.
```

## Fork the repository

Start by [forking the Previously repository](https://github.com/LikeDreamwalker/previously/fork) on GitHub. **Make your fork private** — this repository holds your agent's memory data (episodic slices, memory nodes, tasks, and session state). A private fork keeps everything accessible only to you and your agent.

> Your fork contains the application code. Memory data your agent creates is stored in whichever GitHub repository the environment variables point to — by default your fork, but you can point it at a different repo entirely. Code and memory are decoupled by design.

## Create a GitHub token

Previously uses the GitHub API to read and write memory data. You need a fine-grained personal access token scoped to your fork.

1. Go to **GitHub Settings** (your profile picture → **Settings**).
2. In the left sidebar, click **Developer settings**.
3. Click **Personal access tokens** → **Fine-grained tokens**.
4. Click **Generate new token**.
5. Give it a name (like "Previously") and choose an expiration.
6. Under **Repository access**, select **Only select repositories** and pick your fork.
7. Under **Permissions**, find **Contents** and set it to **Read and write**.
8. Click **Generate token** and **copy the token immediately** — you won't be able to see it again.

The token needs Contents read/write because Previously reads memory files (episodic slices, memory nodes, task lists) and writes new ones as the agent works. Scoping it to a single repo limits the blast radius if the token is ever exposed.

## Deploy to Vercel

Three options, from smoothest updates to quickest setup.

### Option A: Fork + import to Vercel (recommended)

This gives you the easiest update path — one click to sync upstream changes.

1. Fork the repository (you already did this above).
2. Go to [vercel.com](https://vercel.com) and sign in with your GitHub account.
3. Click **Add New** → **Project**.
4. Import your fork from the repository list.
5. In the **Environment Variables** section, add `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO_OWNER`, and `GITHUB_REPO_NAME` (see below).
6. Click **Deploy**.

Vercel detects Next.js, builds, and gives you a URL. That's it.

### Option B: Deploy Button (fastest)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/LikeDreamwalker/previously)

Click the button, create your fork, set environment variables in the Vercel dashboard, and deploy. This is the fastest path to a running instance, but updating to new versions requires a few manual git commands (see [Updating](#updating)).

### Option C: Local dev (for testing)

To run Previously on your own machine:

```bash
git clone https://github.com/YOUR_USERNAME/previously.git
cd previously
pnpm install
pnpm dev
```

Create a `.env.local` file (see below) before starting. The app runs on `http://localhost:3000`.

## Environment variables

For local dev, create `.env.local` in the project root. For Vercel deployment, add these in your project settings under **Settings → Environment Variables**.

```bash
# Required — DeepSeek API key (powers both Flash recall and Pro reasoning)
DEEPSEEK_API_KEY=sk-...

# Required — the GitHub token you created above
GITHUB_TOKEN=github_pat_...

# Required — your GitHub username and the repo name
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=previously

# Optional — redirect memory reads to a bundled demo persona
# DEMO_MODE=true
```

| Variable | Required | What it is | Where to get it |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | Authenticates requests to DeepSeek for both the fast recall model (Flash) and the deep reasoning model (Pro). | [platform.deepseek.com](https://platform.deepseek.com) — create an account and generate an API key. |
| `GITHUB_TOKEN` | Yes | The fine-grained personal access token. Every GitHub read and write flows through it. | [Created above](#create-a-github-token) in the token setup steps. |
| `GITHUB_REPO_OWNER` | Yes | Your GitHub username or organization that owns the repository holding memory data. | Your GitHub username. |
| `GITHUB_REPO_NAME` | Yes | The repository name where memory data lives. By default this is your fork, but you can point it at any repo you own. | Your fork's name on GitHub. |
| `DEMO_MODE` | No | Set to `"true"` to redirect memory reads to a pre-seeded demo persona. Writes still go to your real memory directory. Useful for evaluation. | — |

## Updating

### If you forked and imported (Option A)

1. On your fork's GitHub page, click **Sync fork** (near the branch selector).
2. Click **Update branch**.
3. Vercel auto-redeploys when the fork's default branch is updated.

### If you used the Deploy Button (Option B)

The Deploy Button creates its own fork, but GitHub does not set up the upstream remote automatically. To update:

```bash
git remote add upstream https://github.com/LikeDreamwalker/previously.git
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

Vercel redeploys automatically after the push.

### If you deployed elsewhere (not Vercel)

The instructions above assume you deployed on Vercel, where a push to your fork's main branch triggers an automatic redeploy. If you're using a different platform, or have modified the default deployment configuration, you may need to **manually trigger your deployment pipeline** after pulling in code updates. Check your platform's documentation for how to trigger redeploys on push.

### What updates touch

Episodic memory data (`memory/episodic/`) is gitignored, so pulling in new code never overwrites your accumulated memory. All changes land in code-only directories.

## Related

- [Architecture](/docs/architecture) — three-layer separation and data model
- [Getting Started](/docs/getting-started) — tour the interface and send your first message
