---
id: "context-assembly"
type: "concept"
domain: "ai-engineering"
tags: ["context", "prompt-engineering", "token-budget", "layered-loading"]
related: ["github-file-state", "memory-scoring", "flash-intent"]
backlinks: []
priority: 8
access_count: 3
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'context' or '上下文' or 'prompt' or 'assemb'"
  - "task_type == 'design' or task_type == 'coding'"
status: "active"
---

# Context Assembly

## 核心要点
- Context Assembly 是代码层逻辑，不是模型行为
- 模型不应该决定"该看什么记忆"——那是工程层的职责
- 模型只负责看到组装好的上下文后生成响应
- 6 层组装：system prompt → core nodes → session → extended → reference → user input

## 分层加载策略
- Core（前 3 个）：全文加载，最相关的记忆节点
- Extended（4-8 个）：只加载 frontmatter + 第一段
- Reference（9+）：只加载标题和 ID

## 经验教训
- 三层之间不可互相跨越——core 永远比 extended 优先
- Token 预算超限时，truncate extended 而不是 core
- 空白记忆（无匹配节点）是合法的——只给 system prompt + 用户输入
