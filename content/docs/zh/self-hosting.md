# 自托管部署

Previously 被设计为个人部署方案，而非 SaaS 产品——每个用户运行自己的实例，指向自己的 GitHub 记忆仓库。

> **一句话概括：** 你拥有完整的堆栈。你的实例、你的记忆仓库、你的 LLM 密钥、你的数据。没有共享后端，没有多租户服务，没有供应商锁定。

## 状态：实验性

Previously 正处于早期活跃开发阶段（v0.1.0），尚未准备好用于生产环境或个人使用。自托管现在就可以工作——这些说明对于已发布的代码是准确的——但你应该预料到会有破坏性变更、粗糙的边缘情况和未记录的角落。项目的状态徽章显示为 `status-experimental`，README 也如实说明了其就绪程度。

## 工作原理

运行中的应用程序是一个 Next.js 服务器（或无服务器部署），它通过一个细粒度的个人访问令牌使用 GitHub REST API，来读取和写入 GitHub 仓库中三个已列入白名单的目录：

- `memory/` — 时间切片（episodic slices）、记忆节点（memory nodes）和 strands 索引
- `tasks/` — 任务文件
- `sessions/` — 会话状态

代码存放在一个仓库中；记忆数据存放在另一个 GitHub 仓库中。应用程序通过运行时的环境变量 —— `GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME` —— 来发现自己的记忆仓库。两个仓库在设计上是解耦的。

## 前置条件

| 要求 | 说明 |
|---|---|
| **Node.js** | 20.9 或更高版本（推荐，`package.json` 中未强制要求） |
| **包管理器** | `pnpm`（推荐；仓库中附带 `pnpm-lock.yaml`，但任何兼容 npm 的运行器均可） |
| **GitHub 记忆仓库** | 一个（最好是私有的）仓库，用于存放代理的记忆数据 —— `memory/`、`tasks/`、`sessions/` |
| **GitHub 令牌** | 一个细粒度个人访问令牌，具有单个仓库的 **Contents** 读取和写入权限 |
| **LLM API 密钥** | DeepSeek API 密钥（`DEEPSEEK_API_KEY`）。这是当前运行时代码中唯一接入的提供商。 |

### 关于 Node.js 版本要求

README 中说明 Node.js 20.9+ 是最低要求，但 `package.json` 中没有包含 `engines` 字段来强制检查。Node 20.9+ 是经过测试的基线版本；较旧的版本可能可以运行，也可能不行。

## 安装

```bash
git clone https://github.com/LikeDreamwalker/previously.git
cd Aftrbrez
pnpm install
```

> **关于目录命名的说明：** 该仓库在 GitHub 上已更名为 `previously`，但本地检出目录和 `.env.example` 中的默认 `GITHUB_REPO_NAME` 仍然保留为 `Aftrbrez`。自托管时，请将 `GITHUB_REPO_NAME` 设置为 **你自己的记忆仓库名称**，而不是默认值。

`pnpm install` 步骤会解析所有依赖。除了 Node.js 和 pnpm 之外，不需要任何全局工具。

## 配置

在项目根目录下创建一个名为 `.env.local` 的文件。下面的模板展示了运行时实际读取的所有变量：

```bash
# 必填 — DeepSeek API 密钥（同时驱动 Flash 和 Pro 层级）
DEEPSEEK_API_KEY=sk-...

# 必填 — GitHub 细粒度 PAT（contents 读写，单个仓库）
# GITHUB_TOKEN=github_pat_...

# 必填 — 你的记忆仓库所有者和名称
# 这些可以指向与代码所在的不同仓库
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=your-memory-repo

# 可选 — 演示模式
# 设为 "true" 时，memory/ 的读取将被重定向到预填充的
# 角色数据集（memory/demo/personal_14/）。写入仍然指向
# 真实的 memory/ 目录。
DEMO_MODE=false
```

对于没有 GitHub 令牌的本地开发，只需省略或注释掉 `GITHUB_TOKEN`。应用程序将使用本地文件系统存储。

### 环境变量参考

| 变量 | 必填 | 运行时效果 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 认证 **Flash**（`deepseek-chat`，用于召回扫描和元数据维护）和 **Pro**（响应/推理模型）。Vercel AI SDK 会自动从环境中读取此变量，无需显式的 `process.env` 引用。 |
| `GITHUB_TOKEN` | 是 | 初始化 Octokit 客户端。每次 GitHub 读写操作都通过此令牌进行。如果未设置，应用程序在启动时或执行任何 GitHub 操作时会抛出异常。 |
| `GITHUB_REPO_OWNER` | 是 | 拥有记忆仓库的 GitHub 用户名或组织名。 |
| `GITHUB_REPO_NAME` | 是 | 存放记忆数据的仓库名称。代码存放在别处；此变量将应用程序指向其数据存储。 |
| `DEMO_MODE` | 否 | `"true"` 时将记忆读取重定向到演示角色。默认值 `"false"`。仅对评估部署相关。 |
| `ANTHROPIC_API_KEY` | 否 | README 中将其列为可选项，且 `@ai-sdk/anthropic` 已作为依赖安装，但 **当前没有任何源代码实例化 Anthropic 提供商**。设置此变量没有运行时效果。多模型支持已在路线图中，但尚未接入。 |
| `DEMO_REF` | 否 | 存在于代码中（`src/lib/demo/paths.ts`），但在 README 和 `.env.example` 中未记录。在演示模式下将 GitHub 读取固定到特定的分支/标签/SHA。标准自托管实例不需要。 |

### 各变量的作用

令牌和仓库变量在运行时被多个模块使用：

- `src/lib/github/client.ts` — 创建经过身份验证的 Octokit 实例
- `src/lib/episodic/manager.ts` — 读取和写入时间切片（episodic slices）
- `src/lib/identity/user-profile.ts` 和 `profile-writer.ts` — 由 GitHub 支持的用户身份
- `src/app/api/chat/route.ts` — 主要的聊天 API 路由
- `src/app/api/episodic/flush/route.ts` — 切片刷新端点

双层模型（Flash 用于快速召回，Pro 用于深度推理）目前只使用 `deepseek-chat`——模型注册表（`src/lib/models/registry.ts`）目前仅定义了 DeepSeek 模型。一个 `DEEPSEEK_API_KEY` 密钥覆盖两个层级。

### 代码仓库与记忆仓库分离

这一点值得重复强调：代码和记忆数据可以存放在完全不同的 GitHub 仓库中。运行中的应用程序从不假设它们是同一个。你只需设置：

```
GITHUB_REPO_OWNER=your-org
GITHUB_REPO_NAME=your-memory-repo
```

然后应用程序就会在该仓库中读取和写入 `memory/`、`tasks/` 和 `sessions/`。代码则从你克隆的任何仓库部署。这种分离让你可以保持记忆仓库的私有性，同时，比如说，公开 fork 代码仓库。

## 开发

```bash
pnpm dev          # 使用 Turbopack 启动开发服务器（端口 3000）
pnpm build        # 使用 Turbopack 进行生产构建
pnpm lint         # 运行 ESLint
pnpm test         # 运行 vitest
pnpm start        # 启动生产服务器
```

当应用程序运行时，每个页面顶部都会显示一个统一的标题栏（`AppHeader`），提供 GitHub、文档、设置、主题切换和语言切换功能。

两个脚本 —— `predev` 和 `prebuild` —— 会在 `dev` 和 `build` 之前自动运行 `node scripts/generate-identity.mjs`。无需手动干预。

## 部署到 Vercel

最简单的部署路径是 Vercel（边缘/无服务器）。仓库中没有 `vercel.json` 文件——默认的 Next.js 配置已足够。

1. 将你的 Previously fork 推送到 GitHub。
2. 在 Vercel 仪表盘中导入该仓库，或使用 README 中的一键部署按钮。
3. 在 Vercel 项目设置中的 **Settings > Environment Variables** 下设置相同的环境变量（`DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`GITHUB_REPO_OWNER`、`GITHUB_REPO_NAME`，以及可选的 `DEMO_MODE`）。
4. 部署。

你在本地使用的环境变量就是 Vercel 所需的全部变量，无需额外配置。

### 使用演示角色部署

在 Vercel 环境变量中设置 `DEMO_MODE=true`。应用程序会将记忆读取重定向到随附的演示数据集（`memory/demo/personal_14/`），使实例无需真实的记忆仓库即可运行。写入仍然指向已配置仓库中的真实 `memory/` 目录。如果你还需要演示模式从特定分支（而非仓库默认分支）读取，请将 `DEMO_REF` 设置为分支名称、标签或提交 SHA。

## 安全边界

GitHub 令牌的作用域限定为单个仓库，仅具有 Contents 读取和写入权限。服务端路径白名单（`src/lib/whitelist/`）将代理的文件操作限制在三个目录中：

| 目录 | 代理访问权限 |
|---|---|
| `memory/` | 读写 |
| `tasks/` | 读写 |
| `sessions/` | 读写 |
| `src/` | 只读（代理工具不得修改代码） |

此限制在服务端强制执行。客户端不被信任。

## 相关文档

- [架构概览](/content/docs/zh/architecture) — 三层分离与数据模型
- [Episodic 记忆系统](/content/docs/zh/episodic-memory) — slices 和 strands 的工作原理
- [环境变量参考](/content/docs/zh/environment) — 每个环境变量、来源及其当前的接入状态
