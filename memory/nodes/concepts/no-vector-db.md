---
id: "no-vector-db"
type: "concept"
domain: "ai-engineering"
tags: ["memory", "scoring", "no-vector", "transparent", "file-system"]
related: ["memory-scoring", "github-file-state"]
backlinks: []
priority: 7
access_count: 2
last_accessed: "2026-06-27"
recall_conditions:
  - "query contains 'vector' or 'embedding' or 'RAG' or 'memory' or '记忆'"
  - "task_type == 'architecture'"
status: "active"
---

# No Vector Database

## 核心要点
- 不依赖 embedding + 向量相似度检索
- 不需要装 Qdrant、Pinecone、Chroma
- 记忆召回走白盒评分公式：priority + keyword + graph + frequency - decay
- 单用户场景下（节点数 < 1000），评分排序比向量检索更可控

## 为什么不用向量数据库
- 传播成本高：发给别人 repo，别人还得配 Qdrant
- 黑盒难调试："为什么这次召回这个节点？"——查 score 公式即可
- 依赖重量：embedding 模型 + 向量存储 + 索引维护
- 对单用户过度设计：100 个节点的余弦相似度和评分排序，后者更稳定

## 经验教训
- 评分公式的参数（权重、衰减系数）需要经验调优
- 如果节点数超过 1000，考虑按类型分片索引或迁移 SQLite
