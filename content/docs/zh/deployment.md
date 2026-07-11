# 部署

大约 10 分钟即可获得属于你自己的 Previously。你需要 fork 仓库、创建 GitHub token，然后部署到 Vercel。无需管理服务器，无需配置数据库——只需一个 fork、一个 token 和一次部署。

```alert
⚠️ 重要：暂无鉴权机制。Previously 仍处于早期开发阶段，尚未内置身份验证或访问控制。任何持有你部署链接的人都可以使用你的实例——并访问或修改你的记忆数据。请妥善保管你的部署链接。不要公开分享。如有可能，限制你的 Vercel 部署可见性。鉴权功能是高优先级特性，即将推出。
```

## Fork 仓库

首先在 GitHub 上 [fork Previously 仓库](https://github.com/LikeDreamwalker/previously/fork)。**请将你的 fork 设为私有**——该仓库存放着你的 agent 记忆数据（时间片、记忆节点、任务和会话状态）。私有 fork 确保所有数据仅对你和你的 agent 可见。

> 你的 fork 包含应用程序代码。你的 agent 创建的记忆数据存储在环境变量指向的 GitHub 仓库中——默认是你的 fork，但你可以将其指向完全不同的仓库。代码与记忆在架构上是解耦的。

## 创建 GitHub Token

Previously 使用 GitHub API 读写记忆数据。你需要一个限定作用于你的 fork 的细粒度个人访问令牌。

1. 进入 **GitHub Settings**（点击你的头像 → **Settings**）。
2. 在左侧边栏中，点击 **Developer settings**。
3. 点击 **Personal access tokens** → **Fine-grained tokens**。
4. 点击 **Generate new token**。
5. 为其命名（例如 "Previously"）并选择过期时间。
6. 在 **Repository access** 下，选择 **Only select repositories**，然后选择你的 fork。
7. 在 **Permissions** 下，找到 **Contents** 并将其设置为 **Read and write**。
8. 点击 **Generate token** 并**立即复制 token**——你之后将无法再次查看。

token 需要 Contents 读写权限，因为 Previously 会读取记忆文件（时间片、记忆节点、任务列表）并在 agent 工作时写入新文件。将 token 限定到单个仓库可以在令牌泄露时缩小影响范围。

## 部署到 Vercel

三种方式，从更新最便捷到设置最快捷。

### 方式 A：Fork + 导入到 Vercel（推荐）

这种方式提供最简单的更新路径——一键同步上游变更。

1. Fork 仓库（你之前已经完成了这一步）。
2. 前往 [vercel.com](https://vercel.com) 并使用你的 GitHub 账号登录。
3. 点击 **Add New** → **Project**。
4. 从仓库列表中导入你的 fork。
5. 在 **Environment Variables**（环境变量）部分，添加 `DEEPSEEK_API_KEY`、`GITHUB_TOKEN`、`GITHUB_REPO_OWNER` 和 `GITHUB_REPO_NAME`（参见下文）。
6. 点击 **Deploy**。

Vercel 会自动识别 Next.js，构建并为你生成一个 URL。仅此而已。

### 方式 B：Deploy Button（最快捷）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/LikeDreamwalker/previously)

点击按钮，创建你的 fork，在 Vercel 仪表板中设置环境变量，然后部署。这是运行实例的最快路径，但更新到新版本需要几个手动 git 命令（参见[更新](#更新)）。

### 方式 C：本地开发（用于测试）

要在你自己的机器上运行 Previously：

```bash
git clone https://github.com/YOUR_USERNAME/previously.git
cd previously
pnpm install
pnpm dev
```

在启动前创建 `.env.local` 文件（参见下文）。应用运行在 `http://localhost:3000`。

## 环境变量

本地开发时，在项目根目录创建 `.env.local`。部署到 Vercel 时，在项目设置的 **Settings → Environment Variables** 中添加这些变量。

```bash
# 必填——DeepSeek API 密钥（同时驱动 Flash 召回和 Pro 推理）
DEEPSEEK_API_KEY=sk-...

# 必填——你上面创建的 GitHub token
GITHUB_TOKEN=github_pat_...

# 必填——你的 GitHub 用户名和仓库名
GITHUB_REPO_OWNER=your-username
GITHUB_REPO_NAME=previously

# 可选——将记忆读取重定向到预置的 demo 角色
# DEMO_MODE=true
```

| 变量 | 必填 | 说明 | 获取方式 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 对 DeepSeek 的请求进行身份验证，用于快速召回模型（Flash）和深度推理模型（Pro）。 | [platform.deepseek.com](https://platform.deepseek.com) ——创建账号并生成 API 密钥。 |
| `GITHUB_TOKEN` | 是 | 细粒度个人访问令牌。所有 GitHub 读写操作都通过其进行。 | 在 token 设置步骤中[如上创建](#创建-github-token)。 |
| `GITHUB_REPO_OWNER` | 是 | 拥有存放记忆数据仓库的 GitHub 用户名或组织。 | 你的 GitHub 用户名。 |
| `GITHUB_REPO_NAME` | 是 | 存放记忆数据的仓库名称。默认为你的 fork，但你可以指向你拥有的任何仓库。 | 你的 fork 在 GitHub 上的名称。 |
| `DEMO_MODE` | 否 | 设为 `"true"` 将记忆读取重定向到预置的 demo 角色。写入操作仍写入真实的记忆目录。适用于评估。 | — |

## 更新

### 如果你使用 Fork + 导入（方式 A）

1. 在你的 fork 的 GitHub 页面，点击 **Sync fork**（位于分支选择器附近）。
2. 点击 **Update branch**。
3. 当 fork 的默认分支更新后，Vercel 会自动重新部署。

### 如果你使用 Deploy Button（方式 B）

Deploy Button 会创建自己的 fork，但 GitHub 不会自动设置上游远程仓库。要更新：

```bash
git remote add upstream https://github.com/LikeDreamwalker/previously.git
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

推送后 Vercel 会自动重新部署。

### 如果你部署在其他平台（非 Vercel）

上述说明假设你部署在 Vercel 上，推送到 fork 主分支后将自动触发重新部署。如果你使用的是其他平台，或修改了默认的部署配置，你可能需要在拉取代码更新后**手动触发部署流水线**。请查阅你所用平台的文档，了解如何在推送后触发重新部署。

### 更新涉及的内容

时间线记忆数据（`memory/episodic/`）已被 gitignore，因此拉取新代码永远不会覆盖你积累的记忆。所有变更仅影响代码目录。

## 相关文档

- [架构](/docs/architecture) ——三层分离与数据模型
- [快速上手](/docs/getting-started) ——浏览界面并发送你的第一条消息
