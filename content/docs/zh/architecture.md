# 架构

Previously 是部署在 Vercel 上的一个 HTTP 端点，它读取 GitHub 文件，调用两个 LLM，并将一个响应流式传回——没有数据库，没有定时任务，没有持久化服务器。

## 三层架构

系统分为三个层，每层有明确的职责和严格的边界：

| 层 | 是什么 | 做什么 |
|-------|------------|--------------|
| **浏览器 / 手机** | Next.js App Router UI | 渲染聊天界面。捕获输入。流式输出响应。仅此而已——没有业务逻辑，没有状态机，没有本地记忆。 |
| **Vercel 编排层** | 一个 `POST /api/chat` 处理器 | 读取 GitHub 状态，调用 DeepSeek-chat 进行 Flash 处理，调用 DeepSeek-chat（或客户端选择的模型）进行 Pro 处理，写回结果。没有定时任务。没有工作进程。没有队列。一个请求 = 一个响应。 |
| **GitHub 私有仓库** | 单一事实来源 | 保存一切：`src/`（agent 只读）、`memory/`、`tasks/`、`sessions/`（agent 可读写）。代码和数据共存于一个仓库中。 |

README 中的示意图简洁地说明了这一点：你在手机上交互，Vercel 编排整个管道，每一个持久化的事实都保存在一个 git 提交中。

> **关键要点：没有数据库，没有常驻 agent，没有持久连接。** Previously 完全运行在 Vercel 的请求生命周期内。你发送一条消息，路由触发管道，响应流式传回。当响应结束时，没有后台进程，没有心跳，没有循环。

### 前端架构

Next.js App Router 强制执行严格的服务器组件/客户端组件边界。`page.tsx` 是一个服务器组件，它通过 `getEpisodicState` 服务端获取所有情节数据和用户资料，然后将两者作为 props 传递——初始加载无需客户端数据获取。`ChatPage` 是一个轻量的客户端外壳，只负责 AI SDK 的 `useChat` hook 和 flex 布局。Hero 区域和时间线面板作为 React children 从 `page.tsx` 传入，从而保持 React Server Component 边界的狭窄。

`LoadedIdsProvider` context 取代了旧的 `onLoadedIdsChange` 回调属性链。`TimelinePanel` 通过这个 context 读取和写入已加载的 slice ID，而不再通过中间组件层层传递回调。

消息区域使用 `relative h-screen` 的外层容器配合 `size-full` 的滚动器。聊天输入框固定在 `fixed bottom-0`，而 `MessageScroller` 填充整个页面高度。

## 单一 `/api/chat` 管道

整个 agent 就是 `src/app/api/chat/route.ts`——一个 `export async function POST(request: Request)`。每个用户消息按顺序触发以下六个步骤：

### 1. 日常维护

解析或恢复当前的时间切片。如果没有打开的切片，`tryLoadTodaySlice()` 从磁盘恢复最近已知的切片。30 分钟静默规则（`src/lib/episodic/slicer.ts` 中的 `checkTimeSilence`）检测用户是否已静默超过该时长；如果是，旧切片关闭（`closeSlice(slice, 'time_silence')`），并通过 `createSlice()` 打开新切片。当前用户消息被追加到切片中。首轮消息的新切片会立即被快照和索引。

### 2. 统一 Flash

一次对 DeepSeek-chat 的调用（`deepseek('deepseek-chat')`，温度 0.1，`toolChoice: 'required'`），通过一个 `flashOutput` 工具返回结构化输出，该工具使用包含以下内容的 Zod schema：

- **intent** — `code_debug`、`code_write`、`explain`、`chat`、`review`、`clarify` 之一
- **confidence** — 一个浮点数
- **recall_hits** — 最多 5 个指针（`slice_id`、`relevance`、`reason`），从最近 15 个已关闭切片摘要中提取
- **metadata_updates** — 对切片的 focus、summary、open_loops、decisions、tags 和 emotional_tone 的修补

这取代了旧的意图分类 + recall + 维护相互分离的调用模式。`readRecentSummaries(15)` 为 Flash 模型提供所需素材。失败时，调用会在 300ms 后重试一次；如果两次都失败，则返回安全默认值（`intent: 'chat'`，置信度 0.3，无更新）。

### 3. 上下文组装

`listNodes()`（`src/lib/memory/manager.ts`）拉取候选记忆节点，过滤为 `['concept', 'experience']` 类型，上限 24 个（`max_nodes * 3`）。`rankNodes()`（`src/lib/memory/scorer.ts`）根据用户输入和 Flash 意图对每个节点评分，保留前 8 个。上下文组装器（`src/lib/context/assembler.ts`）在 8,000 token 预算内打包多层提示词：

| 层 | 内容 | 预算规则 |
|-------|---------|-------------|
| 0 | 系统提示（身份 + 指令 + 情节基础） | 完整包含，始终存在 |
| 1 | 核心记忆节点（完整内容） | 预算的 70% |
| 2 | 会话摘要 + 最近轮次 | 截断 |
| 3 | 扩展节点（仅摘要） | 仅第一段落 |
| 4 | 引用节点 | 仅文件路径主干 |

Token 估算采用 `ceil(chars / 4)`——一种启发式方法，并非真正的分词器。

### 4. 情节时间线格式化

Flash 的 recall hits 被渲染成一个结构化的 `## Episodic Memory Timeline` 块。当前切片出现在"Now — Current Session"下方（包含其 ID、轮次数、focus、summary、open loops 和 decisions）。Recall hits 按时间分组——Today / This Week、This Month、A Few Months Ago、Last Year、Earlier——按相关性排序，上限为 `MAX_RECALL_HITS = 12`。时间戳使用相对标签："just now / N min ago / yesterday / Nmo ago"。

### 5. Pro 流式输出

主模型（`deepseek(model)`，当启用思考时使用 `thinking: { type: 'enabled' }` 和 `reasoningEffort: 'medium'`）将文本和工具调用流式传回 UI。`stopWhen: stepCountIs(20)` 限制对话轮次。推理时长在服务端测量，并作为 `data-reasoning` 部分在流中发送；`data-flash` 部分携带包含相位、时长、标签、推理和 recall hits 的 recall 卡片。

Pro 拥有五个工具：

- **readMemory** — 读取 `memory/` 内的文件
- **listMemory** — 列出 `memory/` 内的目录
- **readIndex** — 读取月度 `_index.json`
- **writeMemory** — 创建或更新记忆笔记/节点（受路径白名单和受保护系统路径检查保护）
- **updateUserProfile** — 通过 `applyProfilePatch` 修补 `memory/user/profile.md`

当设置 `GITHUB_TOKEN` 时，这些工具使用 Octokit（`src/lib/tools/readFile.ts` 等），否则回退到本地文件系统访问。

### 6. 快照 + 索引更新

当结束原因为 `'stop'` 时，agent 的消息被追加，切片快照被保存，月度索引条目得到确认。当被中断时，部分响应文本以 `[partial]` 前缀保存。

## 核心模块

`src/lib/` 目录包含许多模块，但并非所有模块都连接到了聊天路由中。以下是诚实的分类：

### 已发布并接入 `/api/chat`

| 模块 | 路径 | 用途 |
|--------|------|---------|
| 路径白名单 | `src/lib/whitelist/` | 安全边界：仅 `memory/ tasks/ sessions/` |
| 记忆系统 | `src/lib/memory/` | 管理器（列出、加载、创建节点）+ 评分器（相关性排序） |
| 上下文组装器 | `src/lib/context/` | 在 token 预算内构建 5 层提示词 |
| GitHub 工具 | `src/lib/tools/` | 基于 Octokit 的 readFile/writeFile/listFiles，带本地文件系统回退 |
| 情节子系统 | `src/lib/episodic/` | 时间切片管理、统一 Flash、strand 索引 |

### 已定义但未接入聊天路由（独立/实验性）

这些模块仅被作为类型引用或根本未被任何文件导入。CLAUDE.md 的核心模块表格将它们列为活跃模块，但实际请求路径并未使用它们：

| 模块 | 路径 | 状态 |
|--------|------|--------|
| Loop Engine | `src/lib/loop/engine.ts` | 仅被 Archive Sync 作为类型导入。未被聊天路由调用。 |
| Session Manager | `src/lib/session/manager.ts` | 内存中的 `Map`，带 5 轮滑动窗口。仅被 Archive Sync 作为类型导入。未被聊天路由调用。 |
| Archive Sync | `src/lib/archive/sync.ts` | 即发即弃的 GitHub 推送，带 3 次指数退避重试。未被任何文件导入。 |
| Model Registry | `src/lib/models/registry.ts` | 声明 `deepseek-chat` 和 `deepseek-reasoner`（外加一个未使用的 provider 联合类型，用于 Anthropic/OpenAI）。未被任何文件导入。聊天路由直接硬编码 `deepseek(model)`。 |

### 部分接入

Intent Router（`src/lib/router/`）仅贡献了 `classifyIntentKeywords`——一个关键字/回退分类器，当无关键字匹配时返回 `'clarify'`。混合 Flash 分类器 `classifyIntentHybrid` 已被 `episodic/maintenance.ts` 中的统一 Flash 调用取代，不在实际路径中被调用。

### 多模型声明

README 描述了"多模型支持（DeepSeek、Anthropic）"。在已发布的代码中，`src/lib/models/registry.ts` 只列出了 `deepseek-chat` 和 `deepseek-reasoner`。目前没有 Anthropic 模型被注册或可通过聊天路由访问。Provider 联合类型允许 Anthropic，但不存在任何条目。

## 无状态执行（有细微例外）

README 将执行称为"无状态、事件驱动"。意图是正确的：GitHub 是持久化的事实来源，系统在每次请求时从磁盘恢复其状态。然而，存在两个内存变量：

- **当前时间切片**是 `episodic/manager.ts` 中的模块级变量。在冷启动或页面刷新时，`tryLoadTodaySlice()` 从磁盘恢复它。
- **会话（Sessions）**存储在 `session/manager.ts` 中的内存 `Map` 中。

这些是缓存，而非权威状态。GitHub/磁盘是事实来源。如果进程重启，下一个请求会从文件系统中恢复所需内容。

## 安全模型

安全完全在 TypeScript 层面、在工具边界处执行——没有 Rust，没有 WASM，没有 sidecar。

### 路径白名单

`src/lib/whitelist/index.ts` 定义了仅有的三个可写目录：

```
memory/   tasks/   sessions/
```

`normalizePath()` 解码 URI 组件，将反斜杠转换为正斜杠，解析 `./` 和 `../` 段，并去除前导斜杠。`isPathAllowed()` 拒绝：

- 空路径
- 绝对 Unix 路径（以 `/` 开头）
- 绝对 Windows 路径（如 `A:` 的盘符）

然后检查路径是否以三个允许前缀之一开头。

### 受保护的系统路径

在白名单内，某些路径可读取但**不可**由通用 `writeFile` 工具写入：

- `memory/episodic/` — 系统拥有的切片和索引
- 任何 `_index.json` 文件
- `strands.json`
- `memory/user/profile.md` — 只能通过专用的 `updateUserProfile` 工具编辑

### `src/` 为 Agent 只读

`src/` 目录根本不在白名单中。没有 agent 工具可以在那里写入。Agent 可以通过 git 读取 `src/`（它在仓库中），但不能修改它——路径白名单会拒绝写入尝试。这保证了代码库的完整性独立于 agent 的执行。

### GitHub Token 作用域

`GITHUB_TOKEN` 限定于单个仓库的 contents 读/写权限。Agent 只能操作一个仓库：由 `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` 定义的仓库。不存在跨仓库访问。

所有路径验证都在服务端执行——客户端是不可信的。浏览器从不构造文件路径或做出存储决策。

## 下一步（路线图）

以下功能尚未构建或处于实验阶段：

- 并行/主题时间线索引用于 recall（`src/lib/episodic/parallel-timeline.ts` 存在但未被用于 recall）
- 多分支记忆
- Recall 质量指标
- 完整的 GitHub 工具集（分支、diff、PR）
- Task Loop Engine v2
- 云-本地连接器框架

项目状态徽章为 **experimental**。

## 相关内容

- [记忆模型](/content/docs/en/memory-model) — slices、strands 和 nodes 如何工作
- [白名单与安全](/content/docs/en/security) — 路径验证和访问控制详解
- [Agent 循环](/content/docs/en/agent-loop) — agent 如何执行多步骤任务
