# 回忆（Recall）

回忆是 Previously 检索相关历史对话的方式——这是一个双层引擎：快速的 Flash 通道返回轻量级指针，然后主模型 Pro 读取它选中的切片，整个过程在单个请求-响应周期内完成。

## 双层回忆引擎

Previously 中的情景记忆以**切片（slice）**的形式存储——位于 `memory/episodic/slices/2025/11/21/0825.md` 这类路径下的 Markdown 文件，每个文件对应一次对话爆发，在你说话时打开，在静默 30 分钟后关闭。经过数周和数月，这些切片会积累成一个深度档案。挑战在于：代理如何在不每次读取所有内容的情况下找到重要的信息？

Previously 将这个问题拆分为两个反射层次：

| 层次 | 模型 | 成本 | 作用 |
|-------|-------|------|-------------|
| **Flash**（条件反射） | DeepSeek-chat | 快速，温度 0.1 | 扫描近期切片摘要，返回**指针**——`{ slice_id, relevance, reason }`——从不返回完整内容 |
| **Pro**（审慎推理） | 用户选择的模型（默认 DeepSeek-chat） | 较慢，可启用思考 | 接收指针，通过 `readMemory` 按需读取完整切片，当 Flash 未找到结果时直接探索目录 |

Flash 的设计允许出错。它以完整性换取速度：它读取的是摘要，而非完整正文。Pro 是安全网——它可以在 Flash 指针所指的方向深入挖掘，或者从头开始探索目录树。

> **要点**：Flash 回答"往哪里找。"Pro 回答"这意味着什么。"两者不可互相替代。

### 第 1 步：Flash 回忆（观察约 500ms）

Flash 在**响应流打开之前**运行。每个用户请求触发一次统一调用（`src/lib/episodic/maintenance.ts` 中的 `runUnifiedFlash`），在单次往返中完成三项工作：

1. **意图分类**——这是哪种类型的请求（对话、任务、记忆等）
2. **回忆扫描**——读取近期已关闭切片的摘要（最多 15 条，来自月度 `_index.json` 文件）并判断相关性
3. **元数据维护**——提议对当前活跃切片的关注点、摘要、决策和标签进行更新

Flash 返回一个结构化的 `flashOutput`，其中包含 `recall_hits` 数组。每个命中是一个指针——切片 ID、相关性分数（0-1）以及一行匹配原因。模型被提示最多返回 5 个；`MAX_RECALL_HITS`（12）仅限制上下文注入（`buildTimelineEpisodicContext`）——界面渲染会显示所有 recall hits，不设上限。

输出是确定性的（工具选择：必需，温度 0.1），对可靠性要求极高。如果调用失败，会在 300ms 后重试一次，然后回退到安全默认值——意图 `chat`，置信度 0.3，空 recall hits——这样对话永远不会中断。

**Flash 不会读取的内容**：主题索引（strand index，即 `strands.json`）。尽管在早期的路线图描述中出现过，但已发布的代码只扫描切片摘要。主题索引（在切片关闭时建立的从关键词到切片路径的映射）存在于磁盘上，但尚未接入回忆功能。Pro 可以在需要时通过 `readMemory` 手动访问它。

```preview
demo: recall-phase
```

回忆阶段渲染为一个可折叠卡片，带有历史图标。折叠时：显示持续秒数。展开时：显示回忆文本（Markdown），每条命中显示为 `slice_id` + 原因 + 相关性百分比、一行斜体推理文字以及主题标签胶囊。

### 第 2 步：深度回忆

Flash 的指针列表被注入到 Pro 的系统提示中。Pro 通过调用 `readMemory` 工具读取特定文件路径，决定打开哪些切片来获取完整内容。它有三个用于回忆探索的工具：

| 工具 | 用途 |
|------|---------|
| `readMemory` | 读取 `memory/` 内任何文件的完整内容 |
| `listMemory` | 列出 `memory/` 内目录的内容 |
| `readIndex` | 读取月度 `_index.json` 以按月浏览切片摘要 |

当 Flash 找到命中时，Pro 会收到指导："这些摘要通常就足够了——只有在需要摘要未包含的细节时，才通过 `readMemory` 读取特定切片。"当 Flash 未找到任何内容时，Pro 被指示直接探索目录——如果它想要关键词索引，则从 `strands.json` 开始，或者按月浏览索引。

响应中连续的内存读取工具会被折叠为单个"RecallGroup"卡片：'timeline' 类别（`readMemory` + `readIndex`）使用标签"读取 N 条时间线记录"，而 'browse' 类别（`listMemory`）使用"又回忆了 N 条"。

### 第 3 步：元数据维护

执行回忆的同一 Flash 调用也会为**当前活跃切片**——即当前对话正在写入的切片——提议元数据更新。每一轮，Flash 会为以下字段建议新的值：

- `focus`——当前对话的主题
- `summary`——一行概述
- `decisions`——已做出的决策
- `open_loops`——待回顾的未解决线程
- `tags`——关键词标签
- `emotional_tone`——对话的情绪基调

路由在每一轮中原地应用这些更新（`applyMetadataUpdates`），因此索引保持最新，无需单独的后处理步骤。这是整合到统一 Flash 调用中的第三项工作，也是为什么单次往返替代了旧的分裂分类器架构。

## 三阶段聊天渲染

单条助手消息渲染为三个视觉上不同的阶段，在 `ChatMessage` 中按 part 类型划分：

```
回忆（历史图标，可折叠卡片，在气泡外）
    |
    v
推理（大脑图标，可折叠卡片，在气泡外）
    |
    v
响应（文本 + 行内工具调用，在气泡内）
```

```preview
demo: thinking-steps
```

### 1. 回忆阶段

服务器将一个 `data-flash` part 写入 AI-SDK 流，包含 `phase: "recall"`、`done: true`、`durationMs`、`text`、`tags`、`reasoning` 和 `recall_hits`。客户端将其渲染为 `RecallPhase`——一个带有历史图标的 `ToolLayout` 可折叠卡片。

- **折叠摘要**：持续时长四舍五入到秒（最少 1s）
- **展开内容**：通过 `MarkdownRenderer` 渲染的回忆文本，每条命中显示为 `slice_id`（等宽字体）+ 原因 + `Math.round(relevance * 100)%`、斜体推理行以及标签胶囊

回忆文本显示为"回忆到 N 条与 <最多 3 个主题> 相关的对话"或"已扫描近期对话——未找到直接相关匹配"。

回忆和推理阶段**并非真正的工具调用**。它们复用了共享的 `ToolLayout` 可折叠卡片组件，使用静态的已完成/流式传输状态，因此在视觉上看起来像工具，但它们位于消息气泡**之外**。

### 2. 推理阶段

当 Pro 启用了思考功能（默认：开启，推理程度"中等"，由 `body.thinking` 控制）时，服务器通过记录第一个推理块与第一个文本块之间的挂钟时间来测量思考时长。它会发出一个包含 `durationMs` 的 `data-reasoning` part。

客户端将其渲染为 `ThinkingSteps`——一个带有大脑图标的 `ToolLayout` 可折叠卡片。

- **折叠摘要**："思考 · Ns"计时器（最少 1s）
- **展开内容**：推理 markdown

使用 `data-reasoning`（而非客户端计时器）意味着持续时间能够跨重渲染和水合保持稳定。

### 3. 响应阶段

响应正文在 `Bubble` 内渲染。文本通过 `MarkdownRenderer`（react-markdown + remark-gfm + rehype-highlight）处理。工具调用按照 Pro 调用的顺序以内联方式出现，每个工具调用由对应的工具渲染器包装：

| 工具 | 显示名称 |
|------|-------------|
| `readMemory` | "正在详细回忆..." |
| `listMemory` | "正在回忆更多..." |
| `readIndex` | "正在扫描时间线..." |

当两个或更多内存读取工具连续出现时，`groupInlineParts` 会将它们折叠为单个 `RecallGroup` 卡片。'timeline' 类别（`readMemory` + `readIndex`）使用"读取 N 条时间线记录"（`chat.recall.group`）；'browse' 类别（`listMemory`）使用"又回忆了 N 条"。

## 相关文档

- [切片（Slices）](/docs/en/slices) —— 切片如何创建、关闭和索引
- [主题索引（Strands）](/docs/en/strands) —— 跨切片的语义关键词索引（实验性）
- [架构（Architecture）](/docs/en/architecture) —— 消息渲染的完整组件树
