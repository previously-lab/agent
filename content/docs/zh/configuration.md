# 配置

Previously 完全通过环境变量进行配置——六个内置变量，零个配置文件，一个隐式的后端开关来决定读取操作走 GitHub API 还是本地文件系统。

> **要点：** 三个变量是必需的（`DEEPSEEK_API_KEY`、`GITHUB_REPO_OWNER`、`GITHUB_REPO_NAME`）。第四个变量（`GITHUB_TOKEN`）实际上也是必需的——它控制着整个 GitHub 后端。没有它，应用会改为读写本地文件系统。

## 环境变量参考

运行时实际读取的所有变量，汇总在一张表中：

| 变量 | 是否必需 | 是否内置 | 默认值 | 运行时效果 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 是 | — | 同时驱动 Flash 和 Pro 两个层级。`@ai-sdk/deepseek` 提供者会自动从环境中读取该变量——没有源码文件直接引用 `process.env.DEEPSEEK_API_KEY`。 |
| `GITHUB_TOKEN` | 见说明 | 是 | — | 该变量是否存在**就是后端开关**。设置后，应用使用 Octokit/GitHub API 后端；未设置时，应用回退到本地文件系统。本地开发时保留未设置或注释掉状态。空字符串 `GITHUB_TOKEN=` 现在能正确回退到本地文件系统。一个细粒度 PAT，权限为 Contents read/write，范围限定到单个仓库。 |
| `GITHUB_REPO_OWNER` | 使用 GitHub 后端时必需 | 是 | `local` | 拥有 memory 仓库的 GitHub 用户名或组织。在多个模块中被读取，包括 chat 路由、flush 端点、episodic 管理器和身份/资料模块。 |
| `GITHUB_REPO_NAME` | 使用 GitHub 后端时必需 | 是 | `local` | 存储 memory 数据的仓库名称。与 `GITHUB_REPO_OWNER` 的消费点相同。 |
| `DEMO_MODE` | 否 | 是 | `false` | 设置为字符串 `"true"` 时，将所有 `memory/` 读取重定向到预先填充好的角色数据集 `memory/demo/personal_14/`。写入操作会被接收但**在两个后端上都不会持久化**——应用返回成功响应但丢弃数据。locale 布局还会渲染 `<DemoBanner />` 组件。 |
| `DEMO_REF` | 否 | 是（在 `.env.example` 中未记录） | — | Git ref（分支、标签或 SHA），demo 模式下 GitHub 读取操作会固定使用该 ref。使得带 token 的 demo 部署可以从 demo 分支读取数据，而不是从有意保持空状态的 main 分支读取。仅在 `DEMO_MODE=true` 时生效。 |
| `ANTHROPIC_API_KEY` | 否 | 仅路线图 | — | 出现在 `README.md` 中，`@ai-sdk/anthropic` 依赖也已安装，但**已发布的代码中没有任何地方读取 `process.env.ANTHROPIC_API_KEY`** 或实例化 Anthropic 提供者。多提供者支持在模型注册表中已有类型定义（`provider: "deepseek" | "anthropic" | "openai"`），但 `DEFAULT_MODELS` 只包含 DeepSeek 条目。在 v0.1.0 中设置此变量没有任何运行时效果。 |

> **关于 `GITHUB_TOKEN` 的说明：** 代码通过一个简单的表达式来决定后端——`const USE_GITHUB = !!process.env.GITHUB_TOKEN`——在七个模块中独立声明（chat 路由、flush 路由、episodic 管理器、用户资料、资料写入器、维护模块以及身份/资料端点）。没有专门的 `USE_GITHUB` 环境变量。存在 token = GitHub API，不存在 token = 本地文件系统。这是有意为之：最简单的切换方式，无需配置文件，没有额外的接口面。

## 后端切换：GitHub API vs 本地文件系统

存储后端是隐式的，有意这样设计。没有环境变量，没有配置开关——只取决于 `GITHUB_TOKEN` 是否存在：

```typescript
const USE_GITHUB = !!process.env.GITHUB_TOKEN;
```

| 后端 | 何时选中 | 读取方式 | 写入方式 |
|---|---|---|---|
| **GitHub API** | 设置了 `GITHUB_TOKEN` | `octokit.rest.repos.getContent`，base64 解码。需要 `GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`。 | 在同一仓库上执行 `createOrUpdateFileContents`。 |
| **本地文件系统** | 未设置 `GITHUB_TOKEN` | 从 `DATA_ROOT = join(process.cwd())` 执行 `fs.readFileSync`。从项目根目录读取物理文件。 | 向同一根目录执行 `fs.writeFileSync`。 |

两个后端执行相同的安全边界：
- **路径白名单**：仅 `memory/`、`tasks/` 和 `sessions/` 可读写；`src/` 对 agent 只读
- **大小上限**：所有文件读取的 `MAX_FILE_SIZE_BYTES = 1_000_000`（1 MB）

本地文件系统后端是你在开发时（`pnpm dev`）使用的后端。它读写磁盘上的真实文件——无需 GitHub，无需网络，没有速率限制。GitHub 后端是你部署到 Vercel 时使用的后端。代码路径在路由处理器处分叉（参见 `src/app/api/chat/route.ts` 第 ~434-475 行），但接口完全相同。

## DEMO_MODE 行为

`DEMO_MODE=true` 将整个 memory 层切换到针对内置角色数据集的只读演示模式。以下是具体变化：

### 路径重定向

所有 `memory/` 读取路径都会经过 `resolveDemoPath`（`src/lib/demo/paths.ts`）重写：

```
memory/episodic/slices/...  →  memory/demo/personal_14/episodic/slices/...
memory/nodes/some-node.md   →  memory/demo/personal_14/nodes/some-node.md
```

重写操作仅对以 `memory/` 开头且尚未携带 `memory/demo/personal_14/` 前缀的路径触发（幂等）。配套的 `unresolveDemoPath` 会将映射反转回来，使调用方保持在原始命名空间中。

### 写入：接收但不持久化

DEMO_MODE 使写入在**两个**存储后端上都成为空操作：

- **本地文件系统**（`src/lib/tools/local-fs.ts` 第 52-54 行）：返回 `{ path, created: false }`，不写入磁盘
- **GitHub API**（`src/lib/tools/writeFile.ts` 第 25-27 行）：返回相同的早期成功响应，从不调用 `createOrUpdateFileContents`

agent 会看到写入成功。数据被静默丢弃。

### GitHub 部署的 Demo Ref

当以 `DEMO_MODE=true` 和 `GITHUB_TOKEN` 部署时，你还需要 `DEMO_REF`。没有它，GitHub API 会从仓库的默认分支（`main`）读取——而在 demo 场景中，该分支是有意保持空状态的。将 `DEMO_REF` 设置为 demo 数据集所在的分支、标签或 SHA：

```bash
DEMO_MODE=true
DEMO_REF=demo-branch-name
```

该 ref 在 `src/lib/tools/readFile.ts` 第 30 行被应用：`ref: ref ?? demoRef()`。`demoRef()` 辅助函数（`src/lib/demo/paths.ts`）返回 `process.env.DEMO_REF || undefined`——仅在 `DEMO_MODE` 为 true 时生效。

> `DEMO_REF` 存在于代码中，但**在 `.env.example` 中没有记录**——这是 v0.1.0 中的一个文档缺口。

### UI 横幅

locale 布局（`src/app/[locale]/layout.tsx`）在 `DEMO_MODE=true` 时会条件性地渲染 `<DemoBanner />`。用户会看到一个视觉指示器，表明实例正在以 demo 模式运行。

## 模型注册表与 DeepSeek 路由

Previously 附带一个仅含 DeepSeek 的模型注册表。两个层级，同一个模型家族：

| 层级 | 用途 | 模型 | 温度 | 工具模式 |
|---|---|---|---|---|
| **Flash** | 统一意图分类 + 召回扫描 + 元数据维护 | `deepseek-chat` | 0.1 | `toolChoice: 'required'` |
| **Pro** | 深度推理、完整 slice 读取、响应生成 | `deepseek-chat`（默认，非 `deepseek-reasoner`） | SDK 默认 | 用户选择 |

### Flash 是硬编码的

Flash 调用在响应流打开**之前**运行。它调用一次 `generateText` 到 `deepseek-chat`（温度 0.1，`toolChoice: 'required'`），在单次往返中完成三项工作：意图分类、召回扫描和元数据维护。调用点在 `src/lib/router/flash.ts:124` 和 `src/lib/episodic/maintenance.ts:144`。Flash 没有配置项——它始终使用 `deepseek-chat`。

### Pro 模型选择

Pro 模型按请求从客户端选择：

```typescript
const model = (body.model as string) ?? 'deepseek-chat';
```

客户端默认值也是 `deepseek-chat`（`getClientSetting('PREVIOUSLY_MODEL', 'deepseek-chat')`）。模型注册表（`src/lib/models/registry.ts`）只定义了两种型号：

| 模型 ID | 显示名称 | 支持思考 | 视觉 | 最大 token |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | 是 | 否 | 65536 |
| `deepseek-reasoner` | DeepSeek Reasoner | 是 | 否 | 65536 |

`deepseek-reasoner` 存在于注册表中，作为用户可选的选项可用，但它**不是默认值**，也**不会由思考开关自动选择**。已发布的路径始终使用 `deepseek-chat`。

### 思考开关

思考开关是一个请求级别的布尔值（`body.thinking`，默认 `true`），它**不是**模型切换。启用时，服务器会向 `deepseek-chat` 调用添加 provider 选项：

```typescript
providerOptions: {
  deepseek: {
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium',
  },
}
```

禁用时，不发送任何 `providerOptions`。思考时长在服务端测量（从第一个推理 chunk 到第一个文本 chunk 之间的挂钟时间），并作为 `data-reasoning` 事件发出——不通过客户端计时器追踪。

> **微妙之处：** `deepseek-reasoner` 存在于注册表中，但思考开关不会切换到这个模型。路由代码和客户端默认值都是 `deepseek-chat`。该开关是 **deepseek-chat 上的一个 provider 级别选项**，而非模型切换。

## 国际化

i18n 使用 `next-intl`，正好两个语言环境：

| 语言环境 | 代码 | 默认 |
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

导航必须使用 `@/i18n/navigation` 中的工具函数，而不是 `next/navigation`（由项目约定强制）。locale 布局用 `NextIntlClientProvider` 包裹内容。

## 未包含的变量

一些你可能期望的环境变量，以及它们不存在的原因：

| 你可能期望的变量 | 实际情况 |
|---|---|
| `USE_GITHUB` | 不存在。后端开关是 `!!process.env.GITHUB_TOKEN`——隐式、零配置、有意为之。 |
| `LOG_LEVEL` | 未实现。v0.1.0 中日志功能较简单。 |
| `DATABASE_URL` | 没有数据库。状态存储在 GitHub 文件中。 |
| `PORT` | 应用不读取该变量；由 Next.js 处理。 |
| `ANTHROPIC_API_KEY` | 依赖已安装，README 中提及，**但已发布的代码中没有读取它的地方**。属于路线图/储备性质。 |

## 相关文档

- [部署](/docs/zh/deployment) —— 包含完整 `.env.local` 模板的部署指南
- [情景记忆](/docs/zh/episodic-memory) —— slice 和 strand 的工作原理；配置使之可访问的数据
- [召回](/docs/zh/recall) —— Flash 和 Pro 如何使用已配置的模型
