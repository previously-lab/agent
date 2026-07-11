# 自托管部署

Previously 被设计为个人部署方案，而非 SaaS 产品——每个用户运行自己的实例，指向自己的 GitHub 记忆仓库。

> **一句话总结：** 你拥有整个技术栈。你的实例、你的记忆仓库、你的 LLM 密钥、你的数据。没有共享后端，没有多租户服务，没有供应商锁定。

## 状态：实验性

Previously 正处于活跃的早期开发阶段（v0.1.0），尚不适用于生产环境或个人使用。自托管在今天是可以工作的——以下说明对已发布的代码是准确的——但你应当预期会遇到破坏性变更、粗糙的边缘情况和未文档化的角落。项目的状态徽章标识为 `status-experimental`，README 也对其就绪程度直言不讳。

## 工作原理

运行中的应用程序是一个 Next.js 服务器（或 serverless 部署），它通过一个细粒度个人访问令牌使用 GitHub REST API 来读取和写入 GitHub 仓库中的三个白名单目录：

- `memory/` — 时间切片（episodic slices）、记忆节点（memory nodes）和线索索引（strands index）
- `tasks/` — 任务文件
- `sessions/` — 会话状态

代码存在于一个仓库中；记忆数据则存在于一个独立的 GitHub 仓库中。应用程序完全通过运行时环境变量——`GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`——来发现其记忆仓库。两个仓库在设计上是解耦的。

## 前提条件

| 要求 | 说明 |
|---|---|
| **Node.js** | 20.9 或更高版本（推荐，但 `package.json` 并未强制要求） |
| **包管理器** | `pnpm`（推荐；仓库中附带 `pnpm-lock.yaml`，但任何兼容 npm 的运行器均可使用） |
| **GitHub 记忆仓库** | 一个（最好是私有的）仓库，用于存放代理的记忆数据——`memory/`、`tasks/`、`sessions/` |
| **GitHub 令牌** | 一个细粒度个人访问令牌，具有 **Contents** 读写权限，限定作用于单个仓库 |
| **LLM API 密钥** | 一个 DeepSeek API 密钥（`DEEPSEEK_API_KEY`）。这是当前运行时代码中唯一接入的提供商。 |

### 关于 Node.js 版本要求

README 声明最低要求 Node.js 20.9+，但 `package.json` 中并未包含 `engines` 字段来强制要求。Node 20.9+ 是经过测试的基线版本；较旧版本可能可以工作，也可能无法工作。

## 安装

```bash
git clone https://github.com/LikeDreamwalker/previously.git
cd Aftrbrez
pnpm install
```

> **关于目录命名的说明：** 仓库在 GitHub 上已重命名为 `previously`，但本地检出目录和 `.env.example` 中的默认 `GITHUB_REPO_NAME` 仍然是 `Aftrbrez`。自托管时，请将 `GITHUB_REPO_NAME` 设置为你**自己的记忆仓库名称**，而非默认值。

`pnpm install` 步骤会解析所有依赖项。除 Node.js 和 pnpm 之外，无需任何全局工具。

## 配置

在项目根目录下创建一个名为 `.env.local` 的文件。以下模板展示了运行时实际读取的所有变量：

```bash
# 必需——DeepSeek API 密钥（同时驱动 Flash 和 Pro 两个层级）
DEEPSEEK_API_KEY=sk-...

# 必需——GitHub 细粒度 PAT（contents 读写权限，单个仓库）
GITHUB_TOKEN=github_pat_...

# 必需——你的记忆仓库的拥有者和名称
# 这些可以指向与代码所在仓库不同的另一个仓库
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-memory-repo

# 可选——演示模式
# 设为 "true" 时，memory/ 的读取会被重定向到预置的角色数据集
#（memory/demo/personal_14/）。写入仍然指向真实的 memory/ 目录。
DEMO_MODE=false
```

### 环境变量参考

| 变量 | 是否必需 | 运行时作用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 同时认证 **Flash**（`deepseek-chat`，用于召回扫描和元数据维护）和 **Pro**（响应/推理模型）。Vercel AI SDK 会自动从环境中读取此变量，无需显式的 `process.env` 引用。 |
| `GITHUB_TOKEN` | 是 | 初始化 Octokit 客户端。所有 GitHub 的读写操作都通过此令牌进行。如果此变量未设置，应用程序会在执行任何 GitHub 操作时启动失败。 |
| `GITHUB_REPO_OWNER` | 是 | 拥有记忆仓库的 GitHub 用户名或组织名。 |
| `GITHUB_REPO_NAME` | 是 | 记忆数据的仓库名称。代码位于其他地方；此变量将应用程序指向其数据存储。 |
| `DEMO_MODE` | 否 | 设为 `"true"` 可将记忆读取重定向到演示角色。默认值为 `"false"`。仅与评估部署相关。 |
| `ANTHROPIC_API_KEY` | 否 | README 中将其列为一个选项，且 `@ai-sdk/anthropic` 已作为依赖安装，但**当前没有任何源代码实例化 Anthropic 提供商**。设置此变量在运行时没有效果。多模型支持已在路线图中，但尚未接入。 |
| `DEMO_REF` | 否 | 存在于代码中（`src/lib/demo/paths.ts`），但未在 README 和 `.env.example` 中文档化。在演示模式下将 GitHub 读取固定到特定分支/标签/sha。标准自托管实例无需此变量。 |

### 每个变量的用途

令牌和仓库变量在运行时被多个模块使用：

- `src/lib/github/client.ts` — 创建已认证的 Octokit 实例
- `src/lib/episodic/manager.ts` — 读取和写入时间切片
- `src/lib/identity/user-profile.ts` 和 `profile-writer.ts` — 基于 GitHub 的用户身份
- `src/app/api/chat/route.ts` — 主要聊天 API 路由
- `src/app/api/episodic/flush/route.ts` — 切片刷写端点

双层模型（Flash 用于快速召回，Pro 用于深度推理）目前仅使用 `deepseek-chat`——模型注册表（`src/lib/models/registry.ts`）目前只定义了 DeepSeek 模型。单个 `DEEPSEEK_API_KEY` 即可覆盖两个层级。

### 独立的代码仓库和记忆仓库

这一点值得重复强调：代码和记忆数据可以存在于完全不同的 GitHub 仓库中。运行中的应用程序从不假设它们是同一个仓库。你只需设置：

```
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-memory-repo
```

然后应用程序就会在该仓库中读写 `memory/`、`tasks/` 和 `sessions/`。代码则从你克隆的任何仓库部署。这种分离让你可以保持一个私有的记忆仓库，同时例如公开地 fork 代码。

## 开发

```bash
pnpm dev          # 使用 Turbopack 启动开发服务器（端口 3000）
pnpm build        # 使用 Turbopack 构建生产版本
pnpm lint         # 运行 ESLint
pnpm test         # 运行 vitest
pnpm start        # 启动生产服务器
```

两个脚本——`predev` 和 `prebuild`——会在 `dev` 和 `build` 之前自动运行 `node scripts/generate-identity.mjs`。无需手动干预。

## 部署到 Vercel

最简单的部署路径是 Vercel（edge/serverless）。仓库中没有 `vercel.json` 文件——默认的 Next.js 配置已经足够。

1. 将你的 Previously fork 推送到 GitHub。
2. 在 Vercel 仪表盘中导入该仓库，或使用 README 中的一键部署按钮。
3. 在 Vercel 项目设置的 **Settings > Environment Variables** 中设置相同的环境变量（`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`GITHUB_REPO_OWNER`、`GITHUB_REPO_NAME`，以及可选的 `DEMO_MODE`）。
4. 部署。

你在本地使用的环境变量与 Vercel 所需的完全相同。无需额外配置。

### 使用演示角色部署

在你的 Vercel 环境变量中设置 `DEMO_MODE=true`。应用程序会将记忆读取重定向到捆绑的演示数据集（`memory/demo/personal_14/`），使实例无需实时记忆仓库即可运行。写入操作仍然会指向你配置的仓库中的真实 `memory/` 目录。如果你还需要演示从特定分支（而非仓库默认分支）读取数据，请将 `DEMO_REF` 设置为分支名称、标签或提交 SHA。

## 安全边界

GitHub 令牌的作用域限定为单个仓库，仅具有 Contents 读写权限。服务器端路径白名单（`src/lib/whitelist/`）将代理的文件操作限制在三个目录内：

| 目录 | 代理访问权限 |
|---|---|
| `memory/` | 读写 |
| `tasks/` | 读写 |
| `sessions/` | 读写 |
| `src/` | 只读（代理工具不得修改代码） |

这是在服务器端强制执行的。客户端不被信任。

## 相关文档

- [架构概述](/content/docs/zh/architecture) — 三层分离与数据模型
- [情景记忆（Episodic memory）](/content/docs/zh/episodic-memory) — 时间切片与线索的工作原理
- [环境变量参考](/content/docs/zh/environment) — 每个环境变量及其来源和当前接入状态
