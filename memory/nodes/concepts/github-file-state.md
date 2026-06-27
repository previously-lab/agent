---
id: "github-file-state"
type: "concept"
domain: "architecture"
tags: ["github", "state-machine", "file-driven", "serverless"]
related: ["file-driven-loop", "context-assembly"]
backlinks: ["task-001"]
priority: 9
access_count: 5
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'state' or '状态' or 'file' or '文件'"
  - "task_type == 'architecture' or task_type == 'design'"
status: "active"
---

# GitHub File State Machine

## 核心要点
- Agent 的状态不是数据库记录，而是 GitHub 仓库中的 Markdown 文件
- 每次请求是独立的 HTTP 调用，状态通过读写文件传递
- 文件本身就是审计轨迹——谁在什么时候做了什么，git log 即可查看
- 适合 serverless 环境：每个 step 一个请求，不依赖长连接

## 关联场景
- Aftrbrez 的 Loop Engine 用 tasks/task-{id}.md 存储多步任务状态
- 所有记忆节点以 Markdown 形式存在 memory/nodes/，人类和 AI 都能读

## 经验教训
- 文件必须原子写入（先写 temp，验证后 rename），否则并发可能读到半成品
- 文件大小控制在 1MB 以内，否则 GitHub API 性能下降
