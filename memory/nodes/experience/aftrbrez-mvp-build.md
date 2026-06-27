---
id: "aftrbrez-mvp-build"
type: "experience"
domain: "project"
tags: ["aftrbrez", "nextjs", "vercel", "MVP", "ai-sdk"]
related: ["github-file-state", "context-assembly"]
backlinks: ["task-001"]
priority: 9
access_count: 8
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'aftrbrez' or 'project' or '项目'"
  - "task_type == 'coding'"
status: "active"
---

# Aftrbrez MVP 构建经验

## 做了什么
- M1：用 Vercel AI SDK + octokit 实现了 Agent 通过 Chat 读写 GitHub 文件
- M2：App Shell（shadcn/ui sidebar）+ 6 个页面（RSC 数据获取模式）
- 技术栈：Next.js 16 · AI SDK 7 · octokit 5 · shadcn/ui · Zustand 5 · next-intl

## 踩过的坑
- AI SDK v7 的 `tool()` 用 `inputSchema` 不是 `parameters`
- AI SDK v7 的 streamText 响应用 `toUIMessageStreamResponse()` 不是 `toDataStreamResponse()`
- vitest 4 依赖 rolldown（Rust native），Windows + pnpm 安装失败 → 降到 vitest 3
- `"use client"` 组件不能 import `next-intl/server` → 拆成 Server 壳 + Client 子组件
- Turbopack 多 lockfile 警告 → 设置 `turbopack.root: process.cwd()`

## 当前状态
- 55 个测试全过，TypeScript 零错误，生产构建通过
- 待部署到 Vercel 验证核心假设
