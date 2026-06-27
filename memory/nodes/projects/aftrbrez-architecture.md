---
id: "aftrbrez-architecture"
type: "project"
domain: "architecture"
tags: ["aftrbrez", "c2", "agent-platform", "three-layer"]
related: ["github-file-state", "file-driven-loop"]
backlinks: ["task-001"]
priority: 10
access_count: 10
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'aftrbrez' or 'architecture' or '架构'"
  - "task_type == 'architecture' or task_type == 'design'"
status: "active"
---

# Aftrbrez 项目架构

## 三层分离
- Browser/Phone → 用户交互界面
- Vercel Pro → 编排层（接收触发 → 读 GitHub 状态 → LLM 决策 → 执行 → 写回）
- GitHub Repo → 真理源（代码 + 数据共存）

## 核心原则
- 代码 + 数据共存一个 repo。Agent 只能读写 memory/、tasks/、sessions/，src/ 只读
- 执行是无状态的、事件驱动的。状态完全外置在 GitHub 文件中
- Agent 不主动联系用户——"I come after you're done"

## 记忆分层
- L0/L1：构建时打包，零延迟
- L2：运行时按需从 GitHub 读取
- 每次请求只加载最相关的 2-3 个文件

## M3 目标
实现 Agent State Machine：Markdown 记忆节点 + 评分召回 + Context 组装 + 文件驱动 Loop
