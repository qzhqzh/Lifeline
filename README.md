# Lifeline

Lifeline 是一套面向个人与小型研发团队的 **AI 项目操作系统**。

它不是普通项目看板，也不是依赖单个长对话维持状态的超级 Agent。Lifeline 通过确定性的控制平面，统一管理多个项目的真实进度、未来排期、依赖、预算、算力、模型执行、代码审查和验收证据。

## 愿景

> 让项目在用户离开电脑后仍能安全、可控、可恢复地持续推进；当算力充足时，可以自动选择最有价值的任务进行集中突破。

## 当前可运行能力

首个端到端垂直切片已经实现：

```text
创建项目与工作包
→ 校验执行契约
→ 进入确定性状态机
→ 持久化排队并运行 Mock Executor
→ 保存每个执行检查点
→ 产生计划、分支、测试和审查证据
→ 自动计算项目已验证进度
→ 通过浏览器实时回放运行事件
```

当前实现还包含：

- 原子 JSON 持久化和进程重启恢复；
- 工作包重复排队保护；
- 失败后保留已有证据并进入 `BLOCKED`；
- REST API、OpenAPI 文档和 SSE 运行事件流；
- 项目指挥中心、工作包流水线和运行回放界面；
- Node 原生测试、Docker Compose 和 GitHub Actions CI。

详细边界和后续迁移见 [实现状态](docs/IMPLEMENTATION_STATUS.md)。

## 快速开始

要求 Node.js 22 或更高版本。当前 MVP 没有第三方运行时依赖。

```bash
npm test
npm start
```

访问：

```text
http://localhost:3000
```

启动时自动创建演示项目：

```bash
LIFELINE_SEED_DEMO=1 npm start
```

使用 Docker Compose：

```bash
docker compose up --build
```

常用接口：

```text
GET  /api/health
GET  /api/dashboard
POST /api/projects
POST /api/work-items
POST /api/work-items/:id/ready
POST /api/work-items/:id/queue
GET  /api/runs/:id
GET  /api/runs/:id/stream
GET  /api/openapi.json
```

## 核心能力

- **项目数字孪生**：持续同步 GitHub、CI、部署和运行状态；
- **证据驱动进度**：以测试、PR、发布和监控证据计算进展；
- **版本化规划**：支持正式、暂定和情景排期，所有调整可追溯；
- **持久工作流**：长任务可以暂停、恢复、重试和等待审批；
- **模型路由**：扫描、规划、编码、修复、审查和研究使用不同能力档；
- **资源调度**：统一管理模型并发、API 预算、CPU/GPU、CI 和人工审查；
- **集中突破**：在指定时间、预算和并发下集中推进某个项目；
- **隔离执行**：每个代码任务使用独立分支、worktree 和容器；
- **运行回放**：记录模型、工具、命令、成本、产物、错误和审批；
- **持续评测**：依据真实任务统计不同模型的成功率与单位成本。

## 架构原则

```text
确定性的项目与资源控制系统
                +
可替换的不确定智能执行器
                =
              Lifeline
```

- PostgreSQL 保存项目事实；
- Git 保存代码与配置版本；
- 持久工作流保存长期执行状态；
- 对象存储保存日志、补丁和报告；
- 模型只产生建议、实现和候选证据；
- 正式状态由规则、测试、审批和外部证据提交。

当前本地 MVP 使用原子 JSON 仓库和本地检查点工作流来验证这些契约；在接入真实并行执行器前迁移至 PostgreSQL 和 Temporal。

## 文档

- [完整开发方案](docs/DEVELOPMENT_PLAN.md)
- [分阶段路线图](docs/ROADMAP.md)
- [初始开发 Backlog](docs/INITIAL_BACKLOG.md)
- [实现状态](docs/IMPLEMENTATION_STATUS.md)
- [ADR-0001：控制平面优先](docs/adr/0001-control-plane-first.md)
- [ADR-0002：首个可执行本地垂直切片](docs/adr/0002-executable-local-vertical-slice.md)

## 目标闭环

Lifeline 的完整 MVP 将继续扩展为：

```text
接入项目
→ 生成项目快照
→ 提出工作包
→ 批准并排期
→ 创建隔离分支
→ Agent 实现
→ 自动测试
→ 独立审查
→ 创建 PR
→ 合并后更新项目进度
```

在该闭环稳定前，不优先建设复杂多 Agent 对话、Kubernetes 集群或全自动生产发布。

## 预定生产技术栈

- React + TypeScript + Vite；
- NestJS + Fastify；
- PostgreSQL + Prisma；
- Temporal；
- pnpm + Turborepo；
- Git worktree + rootless Docker；
- MinIO/S3；
- OpenTelemetry + Prometheus + Grafana + Loki + Tempo；
- Codex、Claude、OpenAI/Gemini API 与本地执行器适配层。
