# 时间线

时间线是 Previously 的主要交互界面——一条垂直滚动你的对话历史记录，从上到下阅读，实时聊天在最底部，向上滚动时过去便展现在你身后。

## 不是聊天列表，也不是搜索栏

时间线是大多数 AI 聊天产品采用的两种主流 UI 模式的明确替代方案。它**不是**需要你手动管理、重命名、删除和搜索的对话线程列表。它**不是**一个输入关键词、期望正确记忆浮现的搜索栏。这两种模式都给人类带来负担——它们假设你会自己整理记忆。

Previously 摒弃了这一假设。取而代之的是，它呈现一条单一的垂直时间线——你的故事如同一部自传，最旧的在顶部，最新的在底部，实时对话发生在最底部边缘（README.md:50）。

> **关键要点：你不需要管理对话。你只需滚动你的人生。**

## 三个区域，一个滚动器

页面是一个单一垂直堆叠的滚动表面，按顺序包含三个区域：服务端渲染的英雄区、记忆时间线（`TimelinePanel`）和实时聊天消息——全部位于一个 `MessageScroller` 内（src/components/chat/CLAUDE.md）。时间线位于消息**之上**，而非消息列表内部。它们是同一个滚动容器中的同级区域。向上滚动回顾过去。向下滚动继续你上次离开的位置。

### 时间顺序排列

数据从 hook 获取时是最新优先，显示时反转顺序。渲染位置的代码注释明确指出："Timeline — oldest at top → newest at bottom"（timeline-panel.tsx:142-143）。日期组和组内的 slice 均按最旧优先的顺序渲染。

```preview
demo: slice-file
```

## 按日期分组的 UI

可见的时间线按精确日历日期分组 slice。辅助函数 `formatSliceDate`（time-slice-row.tsx:69-88）返回：

| 条件 | 标签 |
|-----------|-------|
| 同一天（diffDays 0） | "今天" |
| 前一天（diffDays 1） | "昨天" |
| 同一年，更早 | `Intl.DateTimeFormat` 显示月 + 日（例如 "6 月 14 日"） |
| 跨年 | `Intl.DateTimeFormat` 显示年 + 月 + 日（例如 "2025 年 3 月 10 日"） |

这些标签是 `groupByDate`（timeline-panel.tsx:29-41）中的分组键。每个日期组渲染：

- **`DateGroupHeader`**——一个动画头部，使用 `NumberTicker` 组件显示年、月、日。支持本地化：中文渲染为 "2025 Year 11 Month 21 Day" 并带有后缀标签；英文渲染为 "November 21 [2025]"，仅在跨年时显示年份（date-group-header.tsx）。
- **`SliceTimeMarker`**——每个单独的 slice 行通过 `NumberTicker` 显示动画 HH:MM，使用 `d.getHours()` / `d.getMinutes()` 以查看者的浏览器时区渲染（time-slice-row.tsx:127-130）。

## "现在"标记

在时间线的最底部，一个大型动画 "Now" 文字标志着记录的过去交接给当前对话的位置（timeline-panel.tsx:191-221）。i18n 键为 `timeline.panel.now`。

使用 `TextGenerateEffect` 渲染，尺寸为 `text-5xl sm:text-6xl`（响应式），细字重（`font-light`），位于居中块内，上下内边距较大（`pt-24 pb-20`）。这是时间线的终点：时间线向下延伸至此，然后交接给下方的实时聊天。

## 时间间隔标题卡片（冷开场）

当你离开一段时间后返回 Previously，且聊天仍为空时，一个电影感的时间间隔标题卡片会出现在 "Now" 标记上方——一个从最后记录时刻跨越到现在的标签（timeline-panel.tsx:194-212）。

间隔由 `getGapInfo` 计算（timeline-panel.tsx:52-67），它根据最后一个 slice 的 `start` 与 `Date.now()` 之间的经过时间进行分类：

| 经过时间 | 渲染为 |
|---------|------------|
| < 5 分钟 | "片刻之后" |
| 1–59 分钟 | "{N} 分钟后" |
| 1–23 小时 | "{N} 小时后" |
| 1–6 天 | "{N} 天后" |
| 1–4 周 | "{N} 周后" |
| ≥ 5 周 | "{N} 个月后" |

**关键细节：没有"年"这个单位。** 大约两年的间隔渲染为 "24 个月后"，而不是 "2 年后"。间隔锚定在最后一个 slice 的 `start` 而非其 `end`；由此引入的 ≤30 分钟误差在小时/天粒度下是不可见的（timeline-panel.tsx:43-51, 92）。

间隔卡片**仅在挂载后**计算（在 `useEffect` 内部），以避免 SSR/水合时因墙上时钟产生的不匹配（timeline-panel.tsx:90-98）。仅在 `chatEmpty` 为 true 时显示——即实时聊天还没有消息。一旦你开始说话，间隔卡片就会消失。

i18n 标签位于 `timeline.gap.*`（messages/en.json）：`moments`、`unit.minute`、`unit.hour`、`unit.day`、`unit.week`、`unit.month`，均通过 ICU 语法实现正确的复数形式。

## 分页："更早的记忆"

向上滚动可通过游标分页浏览历史记录。"更早的记忆"按钮（i18n 键 `timeline.panel.earlier`）位于时间线面板的顶部。点击它调用 `getMoreSlices(oldest.start, 10)`——加载比当前已加载的最旧 slice 更早的 10 个 slice（use-timeline.ts:42-66）。

较新的 slice 出现在现有 slice 下方；**更旧的 slice 加载到上方**，保持最旧在顶部的原则（timeline-panel.tsx:120-140，注释 "older slices load in above"）。请求进行中时，按钮文本替换为加载旋转器。分页游标为已加载的最旧 slice 的 `start` 时间戳。

## Slice 行：延迟加载与可展开

时间线中的每个 slice 渲染为 `TimeSliceRow`（time-slice-row.tsx:138-263）：

- **延迟内容加载**——完整的 slice 主体在挂载时通过 `getSliceContent(slice.slice_id)` 获取，加载期间显示旋转器
- **默认视图**——显示第一个用户+助手的对话回合（`.slice(0, 2)`），通常是一条用户消息和助手的回复
- **向下展开**——"查看更多"按钮在第一个对话回合下方显示后续轮次，保持时间顺序的阅读方向
- **摘要说明**——slice 的 YAML `summary` 字段在对话回合内容下方渲染为斜体说明文字
- **未完结事项与已决事项**——以计数形式显示（"3 进行中 · 2 已决定"），点击后可展开为带标签的胶囊
- **字符计数**——超过 300 字符的单个对话回合会被截断，并显示"展开全部（{N} 字符）"按钮

## 两个不同的按时间分组系统

Previously 中存在两个独立的按时间分组系统，服务于不同的受众。不要混淆它们。

### 1. 可见 UI（为你设计）

屏幕上的时间线按**精确日历日期**分组——今天、昨天或本地化格式的日期——带有动画的年/月/日头部和 HH:MM slice 标记。这是你在页面上看到的内容。

### 2. LLM 情景上下文（为代理设计）

当路由为 Pro 组装系统提示时，它会通过 `buildTimelineEpisodicContext`（route.ts:147-216）构建一个 `## Episodic Memory Timeline` 部分。这是一个**注入到模型上下文中**的 Markdown 块，而非渲染在屏幕上。

包含：

```
### Now — 当前会话
- Slice: `{slice_id}` · {N} 个回合
- 焦点：{focus}
- 摘要：{summary}
- 未完结事项：["..."]
- 已决事项：["..."]
```

随后是：

```
### 召回结果
Flash 发现以下可能相关的过往对话：
```

每个召回命中按时间和相关性分桶排序，上限为 12 条（`MAX_RECALL_HITS`，位于 route.ts:170）：

| 分组标签 | 天数范围 | 代码范围 |
|---|---|---|
| "今天 / 本周" | ≤ 7 | `daysAgo <= 7` |
| "本月" | ≤ 30 | `daysAgo <= 30` |
| "几个月前" | ≤ 180 | `daysAgo <= 180` |
| "去年" | ≤ 365 | `daysAgo <= 365` |
| "更早" | > 365 | else |

每条命中行显示 `slice_id`、相对时间标签（`formatRelativeTime`）、Flash 理由和相关性分数。当 Flash 未找到任何内容时，该部分会明确说明，并引导 Pro 前往 `memory/episodic/strands.json` 进行更深层的探索（route.ts:210-214）。

## 数据流

时间线通过服务端操作（server actions）填充：

1. **初始加载**——`getEpisodicState()` 返回最近的 slice 作为 `active`、一个 `recent` slice 数组（包含摘要和元数据），以及一个 `hasMore` 布尔值
2. **分页**——`getMoreSlices(before: ISO 时间戳, limit: 10)` 获取更旧的 slice；结果追加到 `slices` 数组的末尾（由于数组在"旧"端增长，因此渲染在上方）
3. **DEMO_MODE**——当 `DEMO_MODE=true` 时，扫描深度扩展到 48 个月，而非正常的 1-2 个月（src/lib/episodic/CLAUDE.md:90）

## 原子单位：Slice

时间线上的每一行代表一个 **slice**——一个单独的对话片段，以 Markdown 文件形式存储在：

```
memory/episodic/slices/2025/11/21/0825.md
```

路径编码了完整的时间戳：年/月/日/时-分。一个日历日是一个目录，可能包含多个 slice。一个 slice 在你开始对话时打开，并在静默 30 分钟后自动关闭（README.md:52-56；src/lib/episodic/CLAUDE.md:5）。没有容量限制，也没有话题切换规则——切片纯粹由时间驱动。

每个 slice 携带带有结构化元数据的 YAML frontmatter（`focus`、`summary`、`open_loops`、`decisions`、`tags`、`emotional_tone`、`status`、`start`/`end` 时间戳），使其无需专有工具即可被机器读取。

## 相关

- [记忆模型](/content/docs/en/memory-model)——slice 如何融入完整的情景 + 语义记忆架构
- [召回](/content/docs/en/recall)——Flash 和 Pro 如何使用时间线进行上下文检索
- [架构](/content/docs/en/architecture)——渲染时间线与实时消息的组件树
