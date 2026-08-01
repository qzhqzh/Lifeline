# Lifeline 开发方案

> 状态：Draft 0.1  
> 更新日期：2026-08-01  
> 目标：建立一套能够统一管理多个项目、动态排期、分配模型与算力、自动推进代码任务并以证据验收结果的个人研发操作系统。

## 1. 产品定位

Lifeline 不是传统项目看板，也不是一个依靠超长上下文记住所有事情的“超级 Agent”。它是一个确定性的研发控制平面，外接多个可替换的模型、代码执行器和基础设施。

它需要持续回答五个问题：

1. 所有项目现在真实进展到哪里；
2. 下一阶段最值得推进什么；
3. 哪些任务可以在当前算力、预算和人工审查时间内执行；
4. 每类任务应该交给哪个模型或执行器；
5. 任务是否通过可验证证据真正完成。

核心公式：

```text
项目数字孪生
+ 版本化计划
+ 持久工作流
+ 模型路由
+ 资源调度
+ 证据验收
= Lifeline
```

## 2. 产品目标与非目标

### 2.1 目标

- 统一接入 GitHub 仓库、Issue、PR、CI、部署和运行指标；
- 自动生成每个项目的客观快照、健康度、阻塞和风险；
- 把项目目标拆成有依赖、有验收标准、有资源预算的工作包；
- 支持正式排期、暂定排期和情景模拟，所有调整均可追溯；
- 支持集中突破窗口，在预算与并发约束下自动选择并行任务；
- 接入 Codex、Claude、OpenAI Agent、Gemini、本地模型和 Shell Worker；
- 通过独立 worktree、容器、测试、代码审查和 PR 控制代码变更；
- 记录每次运行的输入、工具、模型、产物、成本、失败原因与审批；
- 根据真实任务历史评估模型在不同任务类型上的成功率和单位成本。

### 2.2 首期非目标

- 不训练自有基础模型；
- 不一开始支持十多个模型供应商；
- 不自动合并所有 PR 或自动发布生产环境；
- 不用向量数据库代替项目事实数据库；
- 不让模型直接修改正式排期、预算和项目状态；
- 不在 MVP 阶段引入 Kubernetes、复杂 A2A 网络或完整事件溯源；
- 不重写 Codex、Claude Code 等成熟代码执行器。

## 3. 核心设计原则

### 3.1 数据库保存事实，模型只做判断

模型上下文不是可靠存储。项目、计划、依赖、资源、审批、运行和证据必须保存在 PostgreSQL、Git、对象存储和持久工作流中。

模型可以提出：

- 新任务；
- 计划调整；
- 风险判断；
- 代码补丁；
- 验收建议。

模型不能直接提交以下事实：

- “项目已完成 80%”；
- “任务已验收”；
- “排期已调整”；
- “生产发布成功”。

这些状态只能由规则、测试、审批和外部系统证据驱动。

### 3.2 确定性控制，概率性执行

确定性系统负责：

- 状态机；
- 任务依赖；
- 资源配额；
- 调度；
- 权限；
- 重试、超时和补偿；
- 测试与发布门禁；
- 审批；
- 审计。

模型负责：

- 归纳；
- 诊断；
- 规划；
- 编码；
- 修复；
- 审查建议；
- 文档；
- 研究。

### 3.3 证据驱动进度

项目进度由工作包的验收证据计算，而不是人工填写主观百分比。

建议初始证据权重：

| 状态 | 证据得分 |
|---|---:|
| 已登记 | 0.00 |
| 方案完成 | 0.15 |
| 已有分支与初步实现 | 0.35 |
| 核心测试通过 | 0.60 |
| 独立审查通过 | 0.80 |
| 已发布且运行验证通过 | 1.00 |

```text
项目已验证进度 = Σ（工作包权重 × 证据得分）/ Σ（工作包权重）
```

界面同时显示：

- 已验证进度；
- 排期置信度；
- 预计完成区间；
- 最大风险；
- 最后有效证据时间。

### 3.4 计划变更必须版本化

正式计划使用不可变版本：

```text
Proposal → Impact Simulation → Review → Commit Schedule Version
```

任何拖动排期、增加任务、修改优先级或预算的操作都先进入情景版本，系统计算对其他项目、算力和期限的影响后再提交。

### 3.5 执行器可替换

业务流程不能依赖某个具体模型名称。系统内部先定义能力档案，再由配置映射到当前模型：

```text
fast_scan
bulk_extract
deep_planning
code_general
code_deep
debugging
independent_review
security_review
research
multimodal_ui
summary
```

## 4. 关键用户场景

### 4.1 全局项目总览

用户打开 Lifeline 后可以立即看到：

- 全部项目及战略优先级；
- 当前里程碑和已验证进度；
- 正在运行、排队和阻塞的任务；
- 未来两周排期；
- 每个项目最近一次有效进展；
- 当前预算与算力消耗；
- 系统建议的下一批高价值动作。

### 4.2 项目评审与重新排期

用户可以对某项目发起评审：

1. 系统刷新仓库、CI、Issue、PR、部署与指标快照；
2. Planner 生成新增、删除、拆分和调整任务建议；
3. Dependency Builder 更新依赖图；
4. Estimator 估计工期区间、预算和资源；
5. 独立 Critic 检查遗漏和过度乐观；
6. Scheduler 生成一个或多个情景排期；
7. 用户批准其中一个版本；
8. 系统提交新的正式计划版本。

### 4.3 集中突破

用户创建突破窗口：

```yaml
project: BioWorkflowManage
window: 2026-08-01T23:00:00+08:00/2026-08-02T07:00:00+08:00
budget_usd: 80
max_parallel_runs: 6
objective: 完成 workflow editor MVP
allow_preemption: true
```

系统自动：

- 冻结输入快照；
- 找出可并行工作包；
- 检查文件、数据库迁移和部署冲突；
- 为任务创建独立 worktree；
- 分配模型、预算、CI 和人工审查槽位；
- 持续运行测试与审查；
- 窗口结束前停止发放新任务；
- 输出成果、失败原因和下一轮建议。

### 4.4 手机端快速指挥

移动端入口首先支持低风险控制操作：

- 查询所有项目状态；
- 添加想法或任务；
- 发起项目扫描；
- 查看并批准计划提案；
- 启动、暂停或取消突破窗口；
- 查看需要人工决策的审批项。

高风险操作仍进入 Web 审批界面，不通过语音直接执行生产变更。

## 5. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│ Web / Mobile / Telegram Gateway                          │
│ 总览｜时间线｜项目驾驶舱｜审批箱｜算力台｜运行回放     │
└──────────────────────────┬───────────────────────────────┘
                           │ REST / SSE / WebSocket
┌──────────────────────────▼───────────────────────────────┐
│ Control Plane API                                        │
│ Project｜Planning｜Scheduling｜Policy｜Approval｜Budget  │
├──────────────────────────────────────────────────────────┤
│ PostgreSQL Truth Store                                   │
│ Project / Work Item / Schedule / Run / Evidence / Audit │
└──────────────┬───────────────────────┬───────────────────┘
               │                       │
┌──────────────▼─────────────┐ ┌───────▼──────────────────┐
│ Durable Workflow Engine    │ │ Scheduler / Resource    │
│ 暂停、恢复、重试、补偿     │ │ Broker                  │
└──────────────┬─────────────┘ └───────┬──────────────────┘
               │                       │
┌──────────────▼───────────────────────▼──────────────────┐
│ Agent Router / Policy Engine                            │
│ capability → model → executor → verifier               │
├────────────┬────────────┬────────────┬──────────────────┤
│ Codex      │ Claude     │ API Agent  │ Local / Shell    │
│ Adapter    │ Adapter    │ Adapter    │ Adapter          │
└──────┬─────┴──────┬─────┴──────┬─────┴────────┬─────────┘
       │            │            │              │
┌──────▼────────────▼────────────▼──────────────▼─────────┐
│ Isolated Execution Workers                              │
│ Git worktree / rootless container / remote sandbox     │
└──────────────┬─────────────────────────────┬────────────┘
               │                             │
┌──────────────▼────────────┐  ┌─────────────▼────────────┐
│ GitHub / CI / Deployment  │  │ Artifact / Observability│
│ PR / Checks / Environments│  │ S3 / Logs / Traces      │
└───────────────────────────┘  └──────────────────────────┘
```

### 5.1 组件职责

#### Control Plane API

- 提供项目、工作包、计划、运行、审批和预算 API；
- 实施权限和状态机；
- 生成项目快照；
- 接收 GitHub 与 CI Webhook；
- 向前端推送运行事件。

#### Durable Workflow Engine

- 管理长时间运行任务；
- 等待审批而不占用 Worker；
- 支持重试、超时、取消和恢复；
- 记录流程级状态；
- 避免模型进程中断导致项目状态丢失。

#### Agent Router

- 根据任务类型、风险、上下文、成本和工具需求选择能力档；
- 从策略表中选择实际模型与执行器；
- 处理升级、降级和供应商故障切换；
- 强制实现模型与审查模型隔离。

#### Execution Worker

- 创建隔离目录、分支和 worktree；
- 准备最小权限环境；
- 执行模型、Shell、测试和静态分析；
- 上传日志、补丁、报告和测试结果；
- 不直接写入项目事实表，只上报结果和证据。

#### Scheduler / Resource Broker

- 过滤不满足依赖、预算、审批或环境要求的任务；
- 对可运行任务评分；
- 分配模型并发、CPU、GPU、CI、部署和人工审查资源；
- 支持预留、抢占、老化和突破窗口。

## 6. 核心领域模型

### 6.1 主要实体

| 实体 | 作用 |
|---|---|
| `projects` | 项目目标、战略价值、状态和风险等级 |
| `project_sources` | GitHub、文档、CI、部署、监控等数据源 |
| `project_snapshots` | 某时间点的客观项目快照 |
| `milestones` | 里程碑、成功标准和期限 |
| `work_items` | Epic、Feature、Task、Bug、Research、Ops |
| `dependencies` | 项目与工作包依赖关系 |
| `schedule_versions` | 不可变排期版本 |
| `schedule_items` | 工作包的计划窗口、缓冲和资源预留 |
| `resource_pools` | 模型并发、CPU、GPU、CI、人工等资源池 |
| `resource_reservations` | 资源预留和占用 |
| `runs` | 一次执行的生命周期 |
| `run_steps` | 模型、工具、命令、审批和状态变化 |
| `artifacts` | Patch、日志、截图、报告、测试结果 |
| `evidence` | 支撑完成状态的可验证证据 |
| `approvals` | 高风险动作审批 |
| `evaluations` | 运行质量和模型表现评估 |
| `model_policies` | 能力档、模型、回退和成本策略 |
| `domain_events` | 只追加的审计事件 |

### 6.2 工作包执行契约

所有进入执行队列的工作包必须满足以下 Schema：

```yaml
id: WI-2026-0001
project_id: lifeline
kind: feature
objective: 实现只读项目总览
non_goals:
  - 不自动修改仓库
repository: qzhqzh/Lifeline
base_ref: main
dependencies: []
acceptance_criteria:
  - 可以接入至少一个 GitHub 仓库
  - 可以展示最近提交、Issue、PR 和 CI 状态
  - 项目快照可追溯
validation:
  commands:
    - pnpm lint
    - pnpm test
risk_tier: medium
resource_profile:
  cpu: 4
  memory_gb: 8
  api_budget_usd: 10
preferred_capability: code_general
review_capability: independent_review
estimate_range_hours: [6, 12]
max_attempts: 3
rollback_plan: 删除功能分支，不影响主分支
```

强制规则：

- 没有验收标准不能进入 `Ready`；
- 没有资源估计不能进入 `Queued`；
- 没有测试或人工验收证据不能进入 `Verified`；
- 高风险任务没有回滚方案不能执行。

## 7. 状态机

### 7.1 业务状态

```text
Idea → Discovered → Triaged → Planned → Ready
                                      ↓
                                 Queued → Running
                                           ↓
                          Blocked ← Review → Repair
                                           ↓
                                        Verified
                                           ↓
                                        Released
                                           ↓
                                        Observed
                                           ↓
                                        Archived
```

### 7.2 状态维度分离

不得用一个字段同时表达全部状态：

- 业务状态：任务是否真正完成；
- 执行状态：是否有 Worker 正在运行；
- 排期状态：是否进入正式时间窗口；
- 审批状态：是否允许执行高风险动作；
- 健康状态：是否超期、阻塞或证据过期。

## 8. 五类核心流水线

### 8.1 项目扫描流水线

1. 确定性采集：Git、Issue、PR、CI、依赖、部署、指标；
2. 结构索引：目录树、AST、符号、API、数据库和模块依赖；
3. 快速模型归纳：文件分类、变更摘要、日志聚类和问题去重；
4. 强模型诊断：架构债务、高风险模块、阻塞和下一阶段建议；
5. 规则校验：过滤无证据或重复结论；
6. 形成新的 `project_snapshot`；
7. 与上一快照比较，生成变化事件。

原则：先使用确定性工具和低成本模型，高价值异常才升级到强模型。

### 8.2 规划流水线

```text
Project Snapshot
→ Planner 拆解工作包
→ Dependency Builder 建图
→ Estimator 给出区间和资源
→ Independent Critic 审查
→ Schedule Simulator 模拟影响
→ Human Approval
→ Commit Schedule Version
```

### 8.3 功能推进流水线

```text
冻结任务输入
→ 创建 branch/worktree
→ Executor 实现
→ 测试与静态分析
→ 生成变更说明
→ 独立 Reviewer
→ Repair Loop（必要时）
→ 创建 PR
→ CI
→ 人工或策略审批
→ 合并与发布
```

### 8.4 Bug 修复流水线

1. 收集错误、日志、版本和环境；
2. 生成最小复现；
3. 创建失败测试；
4. 定位根因；
5. 修复；
6. 执行目标与回归测试；
7. 独立审查；
8. 形成根因分析和防回归规则。

没有复现证据时不得标记修复完成。

### 8.5 性能优化流水线

```text
建立基线
→ Profiler / SQL Plan / Flamegraph
→ 锁定主要瓶颈
→ 模型提出多个假设
→ 小范围实现
→ A/B Benchmark
→ 正确性回归
→ 保存前后证据
```

禁止以“代码看起来更优雅”作为性能任务验收结论。

## 9. 模型路由设计

### 9.1 能力档案

| 能力档 | 用途 | 默认策略 |
|---|---|---|
| `bulk_extract` | 大批量结构化提取 | 最低成本模型或规则 |
| `fast_scan` | 增量扫描与摘要 | 快速模型 |
| `deep_planning` | 跨模块拆解、架构和排期 | 强推理模型 |
| `code_general` | 常规功能开发 | 中高能力代码模型 |
| `code_deep` | 大型重构和复杂迁移 | 最强代码模型 |
| `debugging` | 复现、诊断和修复 | 快速诊断后按失败升级 |
| `independent_review` | 代码和方案复核 | 与实现模型不同的模型家族 |
| `security_review` | 安全问题分析 | 静态工具优先，强模型补充 |
| `research` | 外部资料和技术调研 | 具备 Web 与引用能力的模型 |
| `multimodal_ui` | 截图、页面和视觉检查 | 多模态模型 |
| `summary` | 日报和状态摘要 | 低成本快速模型 |

### 9.2 初始路由原则

- 扫描：规则与解析器 → 快速模型 → 只有异常升级强模型；
- 规划：强模型生成方案，另一个模型独立批评；
- 小型代码修改：中档代码模型，连续失败后升级；
- 常规功能：代码执行器 + 中高档模型；
- 大型重构：先独立规划，再由最强代码模型执行；
- Bug：快速模型定位，无法复现或两次失败后升级；
- 审查：与实现不同模型或不同供应商；
- 性能：Profiler 先行，模型只分析证据；
- 摘要：始终使用低成本模型；
- 安全与生产数据：工具扫描 + 强模型 + 人工审批。

### 9.3 路由输入

```yaml
task_type: debugging
risk_tier: high
context_size: 180000
requires_shell: true
requires_browser: false
requires_vision: false
max_cost_usd: 15
latency_slo_minutes: 45
privacy_tier: internal
preferred_provider: any
```

### 9.4 路由评分

```text
Expected Utility =
P(success | task, model) × business_value
- token_cost
- latency_cost
- retry_risk
- security_risk
```

系统根据真实运行数据持续更新 `P(success | task, model)`，而不是长期依赖人工印象。

### 9.5 升级条件

- 置信度低；
- 无法复现；
- 工具连续失败；
- 两次修复未通过；
- 任务陷入重复循环；
- 影响范围突然扩大；
- 涉及跨仓库架构或生产数据；
- 审查模型与执行模型结论严重冲突。

## 10. 资源与调度

### 10.1 资源抽象

```text
local_cpu
local_gpu
remote_gpu
codex_parallel_slots
claude_parallel_slots
api_budget_usd
ci_runner_slots
deployment_slots
human_review_minutes
```

### 10.2 两阶段调度

第一阶段，确定性资格过滤：

- 前置依赖完成；
- 输入快照未过期；
- 验收标准完整；
- 预算充足；
- 所需环境可用；
- 审批满足；
- 不与其他任务发生不可接受冲突。

第二阶段，优先级评分：

```text
Priority =
0.30 × Cost of Delay
+ 0.20 × Unblock Value
+ 0.15 × Strategic Fit
+ 0.10 × Deadline Pressure
+ 0.10 × Confidence
+ 0.05 × Aging
- 0.05 × Risk
- 0.05 × Compute Cost
- Context Switch Penalty
```

权重保存在配置中并通过历史数据校准。

### 10.3 调度演进

- MVP：PostgreSQL 队列 + Durable Workflow；
- 中期：引入约束求解器处理资源、依赖和截止日期；
- 大规模：在确有需求时接入 Kubernetes 队列、配额与抢占。

## 11. 权限与安全

| 等级 | 操作 | 默认策略 |
|---|---|---|
| L0 | 读取、扫描、总结 | 自动 |
| L1 | 新建任务、提出计划 | 自动或批量确认 |
| L2 | 独立分支修改代码 | 自动 |
| L3 | 创建 PR、部署测试环境 | 策略审批 |
| L4 | 合并主分支、生产部署、数据库写入 | 明确人工审批 |
| L5 | 删除数据、账单、核心密钥 | 双重审批 |

执行环境要求：

- 每个任务独立 worktree 或容器；
- 临时最小权限凭据；
- 默认禁止外网，按域名白名单开放；
- 长期密钥不直接暴露给模型；
- 设置最大运行时间、Token、成本和重试次数；
- 分支保护与 CI 门禁；
- 支持紧急停止和撤销；
- 全量审计日志；
- 高风险命令需要独立审批。

## 12. 可观测性与评测

### 12.1 Run Replay

每次执行必须可回答：

- 为什么启动；
- 使用了什么输入与快照；
- 为什么选择该模型；
- 调用了哪些工具和命令；
- 修改了哪些文件；
- 测试结果是什么；
- 花费多少；
- 在哪一步失败；
- 为什么升级或切换模型；
- 最终由谁批准。

### 12.2 模型评测指标

```text
success_rate
success_per_dollar
human_correction_rate
p50_latency
p95_latency
tool_error_rate
retry_count
regression_rate
average_context_size
```

### 12.3 Golden Task Set

为扫描、规划、编码、修复、审查、优化和研究分别建立真实样本集。模型或策略升级先进行 Shadow Run，不直接替换生产路由。

## 13. 推荐技术栈

### 13.1 Monorepo

- pnpm workspace；
- Turborepo；
- TypeScript 作为控制平面主要语言；
- Python 用于约束求解、生信任务、数据分析和特殊 Worker。

### 13.2 前端

- React + TypeScript；
- Vite；
- TanStack Query；
- React Router；
- React Flow；
- Monaco Editor；
- SSE 为主，WebSocket 为辅；
- shadcn/ui 作为确定性组件基础。

### 13.3 后端

- NestJS + Fastify Adapter；
- PostgreSQL；
- Prisma；
- Temporal；
- Redis 只用于缓存、锁或短期事件；
- MinIO/S3 保存日志、报告、截图和 Patch。

### 13.4 执行与集成

- GitHub App / Webhook；
- Git worktree；
- rootless Docker；
- Codex Adapter；
- Claude Agent Adapter；
- OpenAI / Gemini API Adapter；
- Shell Worker；
- MCP 用于工具和数据接入；
- 远程独立 Agent 成熟后再评估 A2A。

### 13.5 可观测性

- OpenTelemetry；
- Prometheus；
- Grafana；
- Loki；
- Tempo；
- Sentry。

## 14. 推荐仓库结构

```text
Lifeline/
├── apps/
│   ├── web/                    # React 管理界面
│   ├── api/                    # Control Plane API
│   ├── workflow-worker/        # Temporal Worker
│   └── executor-worker/        # 隔离执行 Worker
├── packages/
│   ├── contracts/              # API、事件和工作包 Schema
│   ├── database/               # Prisma Schema 与迁移
│   ├── domain/                 # 状态机与领域规则
│   ├── scheduler/              # 资格过滤和优先级评分
│   ├── agent-router/           # 模型与执行器路由
│   ├── executor-sdk/           # 执行器统一接口
│   ├── github-integration/     # GitHub App 与 Webhook
│   ├── observability/          # Trace、Metric、Cost Ledger
│   └── ui/                     # 共享 UI 组件
├── workers/
│   └── python/                 # Python 调度、分析和专业 Worker
├── infra/
│   ├── docker/
│   ├── compose/
│   └── temporal/
├── docs/
│   ├── DEVELOPMENT_PLAN.md
│   ├── ROADMAP.md
│   ├── INITIAL_BACKLOG.md
│   └── adr/
├── project.yaml
├── pnpm-workspace.yaml
└── turbo.json
```

## 15. API 与事件边界

### 15.1 核心 API

```text
GET    /projects
POST   /projects
POST   /projects/:id/scan
GET    /projects/:id/snapshots
GET    /projects/:id/work-items
POST   /projects/:id/reviews
POST   /work-items/:id/queue
POST   /work-items/:id/cancel
POST   /schedule-scenarios
POST   /schedule-scenarios/:id/commit
POST   /focus-windows
GET    /runs/:id
GET    /runs/:id/events
POST   /approvals/:id/approve
POST   /approvals/:id/reject
GET    /resources
GET    /model-policies
```

### 15.2 领域事件示例

```text
project.snapshot.created
work_item.proposed
work_item.ready
run.queued
run.started
run.step.completed
run.blocked
run.review.requested
run.verified
schedule.scenario.created
schedule.version.committed
approval.requested
approval.resolved
resource.reserved
budget.threshold.reached
```

## 16. 质量门禁

所有代码变更至少经过：

1. 格式化和 lint；
2. 单元测试；
3. 关键模块集成测试；
4. Schema 与数据库迁移检查；
5. 权限与密钥扫描；
6. 独立代码审查；
7. PR CI；
8. 高风险变更人工批准。

对于调度、权限、预算、状态机和审批模块，要求：

- 纯函数化核心规则；
- 属性测试或基于状态机的测试；
- 完整审计事件；
- 幂等性测试；
- 中断恢复测试。

## 17. 主要风险与缓解措施

| 风险 | 缓解措施 |
|---|---|
| Agent 长任务中断 | 持久工作流、幂等 Activity、可恢复 Run |
| 模型幻觉项目进度 | 证据驱动状态、模型只提交 Proposal |
| 成本失控 | 任务预算、全局预算、并发限制、自动降级 |
| 多任务代码冲突 | 独立 worktree、文件范围声明、冲突检测 |
| 重复任务与重复修复 | 指纹、语义聚类、项目快照差异检测 |
| 供应商锁定 | 能力档与执行器适配器，不硬编码模型名称 |
| 权限过大 | 临时凭据、最小权限、分级审批、网络白名单 |
| 调度过度复杂 | MVP 先规则与优先级队列，数据充分后再优化 |
| 看板很完整但不能执行 | 每个阶段必须交付端到端可运行闭环 |
| 自动化导致低质量代码 | 独立审查、测试门禁、失败升级和人工审批 |

## 18. MVP 定义

MVP 必须完成一个真实闭环：

1. 接入一个 GitHub 仓库；
2. 建立项目快照；
3. 自动发现并提出一个工作包；
4. 用户批准后进入正式计划；
5. Scheduler 将其放入队列；
6. Executor 创建独立分支并完成修改；
7. 自动运行测试；
8. 独立 Reviewer 审查；
9. 创建 PR；
10. Lifeline 显示全过程、成本与证据；
11. 合并后项目快照与已验证进度更新。

只有完成这条闭环，才算 Lifeline 的第一个可用版本，而不是仅完成一个项目管理界面。

## 19. 成功指标

首期目标指标：

- 接入项目后 10 分钟内生成首份快照；
- 项目状态变化在 5 分钟内同步；
- 100% 正式计划调整有版本和影响记录；
- 100% 自动代码任务在隔离分支执行；
- 100% `Verified` 任务具备测试或人工验收证据；
- 100% 高风险动作有审批记录；
- 可统计每个能力档的成功率、成本与重试率；
- 一次完整运行可以从界面回放；
- 系统重启后长任务可以继续或明确恢复。

## 20. 开发优先级判断

Lifeline 第一阶段最重要的不是精美看板、复杂多 Agent 对话或完美排程算法，而是建立以下最小骨架：

```text
项目事实
→ 工作包契约
→ 持久状态机
→ 隔离执行
→ 测试证据
→ PR
→ 项目快照更新
```

任何不能加强这条闭环的功能，都应延后到核心闭环稳定之后。
