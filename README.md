# Lifeline

Lifeline 是一套面向个人与小型研发团队的 **AI 项目操作系统**。

它不是普通项目看板，也不是依赖单个长对话维持状态的超级 Agent。Lifeline 通过确定性的控制平面，统一管理多个项目的真实进度、未来排期、依赖、预算、算力、模型执行、代码审查和验收证据。

## 愿景

> 让项目在用户离开电脑后仍能安全、可控、可恢复地持续推进；当算力充足时，可以自动选择最有价值的任务进行集中突破。

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

## 文档

- [完整开发方案](docs/DEVELOPMENT_PLAN.md)
- [分阶段路线图](docs/ROADMAP.md)
- [初始开发 Backlog](docs/INITIAL_BACKLOG.md)
- [ADR-0001：控制平面优先](docs/adr/0001-control-plane-first.md)

## 首个可用闭环

Lifeline 的 MVP 必须完成一条真实端到端链路：

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

## 预定技术栈

- React + TypeScript + Vite；
- NestJS + Fastify；
- PostgreSQL + Prisma；
- Temporal；
- pnpm + Turborepo；
- Git worktree + rootless Docker；
- MinIO/S3；
- OpenTelemetry + Prometheus + Grafana + Loki + Tempo；
- Codex、Claude、OpenAI/Gemini API 与本地执行器适配层。

## 当前状态

项目处于规划和工程初始化阶段。下一步按照 [初始开发 Backlog](docs/INITIAL_BACKLOG.md) 建立首个垂直切片：

```text
创建工作包
→ 状态校验
→ 持久工作流
→ Mock Executor
→ 产生证据
→ 更新状态
→ UI 回放
```
