# 配置

Previously 完全通过环境变量进行配置——六个内置变量，零配置文件，一个隐式后端开关决定读取走 GitHub API 还是本地文件系统。

> **要点：** 三个变量是必需的（`DEEPSEEK_API_KEY`、`GITHUB_REPO_OWNER`、`GITHUB_REPO_NAME`）。第四个变量（`GITHUB_TOKEN`）实际上也是必需的——它控制着整个 GitHub 后端。没有它，应用会转而读写本地文件系统。

## 环境变量参考

运行时实际会读取的所有变量，汇总如下表：

| 变量 | 必需 | 内置 | 默认值 | 运行时影响 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 是 | — | 为 Flash 和 Pro 两个层级提供动力。`@ai-sdk/deepseek` 提供程序会从环境中自动读取它——没有源文件直接引用 `process.env.DEEPSEEK_API_KEY`。 |
| `GITHUB_TOKEN` | 见注 | 是 | — | 该变量存在与否 **即是后端开关**。设置时，应用使用 Octokit/GitHub API 后端；未设置时，应用回退到本地文件系统。一个细粒度 PAT，具有单个仓库的 Contents 读写权限。 |
| `GITHUB_REPO_OWNER` | 使用 GitHub 后端时需要 | 是 | `local` | GitHub 用户名或组织，拥有内存仓库。被多个模块读取，包括聊天路由、flush 端点、episodic 管理器和身份/资料。 |
| `GITHUB_REPO_NAME` | 使用 GitHub 后端时需要 | 是 | `local` | 内存数据的仓库名称。与 `GITHUB_REPO_OWNER` 相同的消费点。 |
| `DEMO_MODE` | 否 | 是 | `false` | 当设置为字符串 `"true"` 时，将所有 `memory/` 读取重定向到预先填充的角色数据集 `memory/demo/personal_14/`。写入操作会被接受但**两种后端均不**持久化——应用返回成功响应但丢弃数据。语言区域布局还会渲染一个 `<DemoBanner />` 组件。 |
| `DEMO_REF` | 否 | 是（`.env.example` 中未记录） | — | Git 引用（分支、标签或 SHA），Demo 模式下的 GitHub 读取会固定到该引用。让使用令牌的 demo 部署能够从 demo 分支而非有意留空的主分支读取。仅在 `DEMO_MODE=true` 时生效。 |
| `ANTHROPIC_API_KEY` | 否 | 仅在路线图中 | — | 出现在 `README.md` 中，且 `@ai-sdk/anthropic` 依赖已安装，但 **没有已发布的代码读取 `process.env.ANTHROPIC_API_KEY`** 或实例化 Anthropic 提供程序。多提供程序支持已在模型注册表中定义类型（`provider: "deepseek" | "anthropic" | "openai"`），但 `DEFAULT_MODELS` 仅包含 DeepSeek 条目。在 v0.1.0 中设置此变量运行时效果为零。 |

> **关于 `GITHUB_TOKEN` 的说明：** 代码通过单一表达式决定后端——`const USE_GITHUB = process.env.GITHUB_TOKEN != null`——在五个模块中独立声明（聊天路由、flush 路由、episodic 管理器、用户资料、资料写入器）。不存在专门的 `USE_GITHUB` 环境变量。令牌存在 = GitHub API。令牌缺失 = 本地文件系统。这是有意为之：最简洁的开关，无配置文件，无额外表面积。

## 后端切换：GitHub API 与本地文件系统

存储后端是隐式的，这是设计使然。无需环境变量，无需配置开关——仅需 `GITHUB_TOKEN` 存在与否：

```typescript
const USE_GITHUB = process.env.GITHUB_TOKEN != null;
```

| 后端 | 何时选择 | 读取方式 | 写入方式 |
|---|---|---|---|
| **GitHub API** | `GITHUB_TOKEN` 已设置 | `octokit.rest.repos.getContent`，base64 解码。需要 `GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`。 | 在同一个仓库上执行 `createOrUpdateFileContents`。 |
| **本地文件系统** | `GITHUB_TOKEN` 未设置 | 从 `DATA_ROOT = join(process.cwd())` 读取 `fs.readFileSync`。从项目根目录读取物理文件。 | 向同一根目录写入 `fs.writeFileSync`。 |

两种后端执行相同的安全边界：
- **路径白名单**：仅 `memory/`、`tasks/` 和 `sessions/` 可读写；`src/` 仅限 agent 读取
- **大小限制**：所有文件读取限制 `MAX_FILE_SIZE_BYTES = 1_000_000`（1 MB）

本地文件系统后端是你在开发时使用的（`pnpm dev`）。它读写磁盘上的真实文件——无需 GitHub，无需网络，无速率限制。GitHub 后端是你部署到 Vercel 时使用的。代码路径在路由处理器处分叉（见 `src/app/api/chat/route.ts` 约 434-475 行），但接口完全相同。

## DEMO_MODE 行为

`DEMO_MODE=true` 会将整个内存层置于针对捆绑角色数据集的只读演示模式。以下是具体变化：

### 路径重定向

所有 `memory/` 读取路径均由 `resolveDemoPath`（`src/lib/demo/paths.ts`）重写：

```
memory/episodic/slices/...  →  memory/demo/personal_14/episodic/slices/...
memory/nodes/some-node.md   →  memory/demo/personal_14/nodes/some-node.md
```

重写受到保护，仅对以 `memory/` 开头且尚未带有 `memory/demo/personal_14/` 前缀的路径触发（幂等）。配套的 `unresolveDemoPath` 会反转映射，使调用方保持在原始命名空间中。

### 写入：接受，但不持久化

DEMO_MODE 使写入在**两种**存储后端上都成为空操作：

- **本地文件系统**（`src/lib/tools/local-fs.ts` 第 52-54 行）：返回 `{ path, created: false }`，不写入磁盘
- **GitHub API**（`src/lib/tools/writeFile.ts` 第 25-27 行）：返回相同的早期成功响应，从不调用 `createOrUpdateFileContents`

Agent 会看到写入成功。数据被静默丢弃。

### GitHub 部署的 Demo 引用

当以 `DEMO_MODE=true` 且设置了 `GITHUB_TOKEN` 部署时，你还需要 `DEMO_REF`。没有它，GitHub API 会从仓库的默认分支（`main`）读取——而在 demo 场景下该分支是有意留空的。将 `DEMO_REF` 设置为 demo 数据集所在的分支、标签或 SHA：

```bash
DEMO_MODE=true
DEMO_REF=demo-branch-name
```

该引用在 `src/lib/tools/readFile.ts` 第 30 行应用：`ref: ref ?? demoRef()`。`demoRef()` 辅助函数（`src/lib/demo/paths.ts`）返回 `process.env.DEMO_REF || undefined`——仅在 `DEMO_MODE` 为 true 时生效。

> `DEMO_REF` 存在于代码中，但 **`.env.example` 中未记录**——v0.1.0 中的文档缺口。

### UI 横幅

语言区域布局（`src/app/[locale]/layout.tsx`）在 `DEMO_MODE=true` 时有条件地渲染 `<DemoBanner />`。用户会看到一个可视化指示器，表明实例正在以演示模式运行。

## 模型注册表与 DeepSeek 路由

Previously 附带一个仅限 DeepSeek 的模型注册表。两个层级，一个模型家族：

| 层级 | 用途 | 模型 | 温度 | 工具模式 |
|---|---|---|---|---|
| **Flash** | 统一意图分类 + 召回扫描 + 元数据维护 | `deepseek-chat` | 0.1 | `toolChoice: 'required'` |
| **Pro** | 深度推理、完整 slice 读取、响应生成 | `deepseek-chat`（默认，非 `deepseek-reasoner`） | SDK 默认 | 用户选择 |

### Flash 是硬编码的

Flash 传递在**响应流打开之前**运行。它调用一次 `generateText` 到 `deepseek-chat`（温度 0.1，`toolChoice: 'required'`），在单次往返中完成三项工作：意图分类、召回扫描和元数据维护。它在 `src/lib/router/flash.ts:124` 和 `src/lib/episodic/maintenance.ts:144` 被调用。Flash 没有配置选项——它始终使用 `deepseek-chat`。

### Pro 模型选择

Pro 模型在每次请求时由客户端选择：

```typescript
const model = (body.model as string) ?? 'deepseek-chat';
```

客户端默认值也是 `deepseek-chat`（`getClientSetting('PREVIOUSLY_MODEL', 'deepseek-chat')`）。模型注册表（`src/lib/models/registry.ts`）严格定义了两种模型：

| 模型 ID | 显示名称 | 支持思考 | 视觉 | 最大令牌数 |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | 是 | 否 | 65536 |
| `deepseek-reasoner` | DeepSeek Reasoner | 是 | 否 | 65536 |

`deepseek-reasoner` 存在于注册表中，可作为用户可选项使用，但**不是默认值**，也**不会被思考开关自动选择**。已发布路径仍使用 `deepseek-chat`。

### 思考开关

思考开关是一个请求级别的布尔值（`body.thinking`，默认为 `true`），它**不是**模型切换。启用时，服务器会向 `deepseek-chat` 调用添加提供程序选项：

```typescript
providerOptions: {
  deepseek: {
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium',
  },
}
```

禁用时，不会发送 `providerOptions`。思考时长在服务端测量（从第一个推理 chunk 到第一个文本 chunk 之间的挂钟时间），并作为 `data-reasoning` 事件发出——而非通过客户端定时器跟踪。

> **微妙之处：** `deepseek-reasoner` 存在于注册表中，但思考开关不会切换到它。路由代码和客户端默认值都是 `deepseek-chat`。开关是 **deepseek-chat 上的提供程序级选项**，而非模型切换。

## 国际化

国际化使用 `next-intl`，正好两个语言区域：

| 语言区域 | 代码 | 默认值 |
|---|---|---|
| 英语 | `en` | 是 |
| 中文 | `zh` | 否 |

配置位于 `src/i18n/routing.ts`：

```typescript
defineRouting({
  locales: ['en', 'zh'],
  defaultLocale: 'en',
});
```

翻译文件：
- `messages/en.json`
- `messages/zh.json`

导航必须使用 `@/i18n/navigation` 中的工具，而非 `next/navigation`（项目约定强制）。语言区域布局用 `NextIntlClientProvider` 包裹内容。

## 被省略的变量

一些你可能期待的环境变量，以及它们不存在的原因：

| 你可能期待的变量 | 实际情况 |
|---|---|
| `USE_GITHUB` | 不存在。后端开关是 `process.env.GITHUB_TOKEN != null`——隐式、零配置、有意为之。 |
| `LOG_LEVEL` | 未实现。v0.1.0 中的日志记录很薄。 |
| `DATABASE_URL` | 没有数据库。状态存在于 GitHub 文件中。 |
| `PORT` | 应用不读取；由 Next.js 处理。 |
| `ANTHROPIC_API_KEY` | 已安装依赖，README 中提及，**但没有已发布的代码读取它**。属于路线图/愿景性质。 |

## 相关

- [自托管](/docs/zh/self-hosting)——部署指南，包含完整 `.env.local` 模板
- [Episodic Memory](/docs/zh/episodic-memory)——slice 和 strand 的工作原理；配置使之可访问的数据
- [召回](/docs/zh/recall)——Flash 和 Pro 如何使用已配置的模型
