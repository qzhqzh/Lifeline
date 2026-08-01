# Lifeline 初始 Backlog

> 目的：把开发方案转成可以直接创建 GitHub Issues 的首批工作包。  
> 约定：`P0` 为首条端到端闭环必需，`P1` 为近期增强，`P2` 为核心稳定后再做。

## Epic 0：仓库与工程初始化

### LF-001 `P0` 初始化 Monorepo

**目标**

建立 `apps/`、`packages/`、`workers/`、`infra/` 和 `docs/` 目录，配置 pnpm workspace 与 Turborepo。

**验收标准**

- 根目录可以统一执行 lint、typecheck、test、build；
- Web、API、Workflow Worker 可以独立构建；
- 所有包使用统一 TypeScript 配置；
- README 包含本地启动步骤。

### LF-002 `P0` 建立本地开发环境

**目标**

通过 Docker Compose 启动 PostgreSQL、Temporal、MinIO 和可观测性基础组件。

**验收标准**

- 新环境只需复制 `.env.example` 并执行一个命令即可启动；
- 服务包含健康检查；
- 数据卷和端口均可配置；
- 停止和重启不会丢失数据库状态。

### LF-003 `P0` 配置 CI

**验收标准**

- PR 自动执行 lint、typecheck、unit test 和 build；
- 数据库迁移可验证；
- CI 失败能够指出具体包；
- 主分支禁止绕过关键检查。

---

## Epic 1：领域模型与状态机

### LF-010 `P0` 定义核心 Prisma Schema

实体至少包括：

- Project；
- ProjectSource；
- ProjectSnapshot；
- Milestone；
- WorkItem；
- Dependency；
- ScheduleVersion；
- Run；
- RunStep；
- Evidence；
- Approval；
- DomainEvent。

**验收标准**

- 迁移可以从空库执行；
- 核心唯一约束与外键存在；
- 时间、金额和状态类型没有使用不明确的字符串；
- 审计记录只追加。

### LF-011 `P0` 实现工作包状态机

**验收标准**

- 非法状态跃迁返回明确错误；
- 业务状态、执行状态、排期状态和审批状态分离；
- 每次状态变化写入审计事件；
- 状态机具有单元测试和重放测试。

### LF-012 `P0` 定义工作包执行契约

**验收标准**

- 使用版本化 Schema；
- 必填目标、非目标、验收标准、风险、预算、重试和回滚计划；
- Schema 可同时用于 API、数据库和 Agent 输出校验；
- 不完整工作包不能进入 `Ready`。

### LF-013 `P1` 实现证据驱动进度

**验收标准**

- 进度来自工作包权重和证据得分；
- 证据可以关联测试、PR、部署和人工验收；
- 证据失效后进度可重新计算；
- UI 显示已验证进度而不是主观百分比。

---

## Epic 2：控制平面 API

### LF-020 `P0` 项目 CRUD 与查询

### LF-021 `P0` 工作包 CRUD 与状态操作

### LF-022 `P0` Run 与 RunStep API

### LF-023 `P0` 审批 API

### LF-024 `P1` 统一事件流 API

**共同验收标准**

- 所有写操作有权限检查；
- 所有状态变化有审计；
- API 错误结构一致；
- OpenAPI 文档可生成；
- 幂等写接口支持幂等键。

---

## Epic 3：持久工作流

### LF-030 `P0` Temporal 基础接入

**验收标准**

- API 可以启动工作流；
- 工作流可以查询、取消、暂停和继续；
- Worker 重启后工作流恢复；
- Activity 有明确重试与超时策略。

### LF-031 `P0` 项目扫描工作流

```text
Collect → Normalize → Summarize → Validate → Snapshot → Diff → Notify
```

**验收标准**

- 每一步可单独重试；
- 重复执行不会产生重复快照；
- 失败步骤保留上下文；
- 运行可从 UI 回放。

### LF-032 `P0` 工作包执行工作流骨架

```text
Validate → Reserve → Prepare → Execute → Test → Review → Publish → Verify
```

初期 `Execute` 可以使用 Mock Executor，先验证流程语义。

### LF-033 `P1` 审批等待与超时

**验收标准**

- 工作流等待审批时不占用执行 Worker；
- 审批超时可以取消、升级或重新通知；
- 重复审批请求不会产生重复动作。

---

## Epic 4：GitHub 集成与项目快照

### LF-040 `P0` GitHub 仓库接入

**范围**

- 仓库元数据；
- 默认分支；
- 最近提交；
- Issue；
- PR；
- Check/CI 状态。

### LF-041 `P0` GitHub Webhook

**验收标准**

- 验证签名；
- 事件去重；
- 失败进入重试；
- Webhook 只更新事实，不直接触发高风险动作。

### LF-042 `P0` 项目快照生成

**验收标准**

- 快照保存采集时间和数据源版本；
- 快照不可变；
- 可以追溯原始证据；
- 可以比较任意两个快照。

### LF-043 `P1` 仓库结构索引

**范围**

- 目录树；
- 配置文件；
- 语言和框架；
- 测试命令；
- 入口文件；
- 数据库 Schema；
- TODO/FIXME。

### LF-044 `P1` 快照变化归纳

使用快速模型对结构化差异生成摘要，但必须保留规则产生的原始变化列表。

---

## Epic 5：项目指挥中心 UI

### LF-050 `P0` Portfolio Command Center

每个项目卡片显示：

- 战略优先级；
- 当前里程碑；
- 已验证进度；
- 排期置信度；
- 最大阻塞；
- 最后有效证据时间；
- 运行与排队数量；
- 最近成本；
- 下一建议动作。

### LF-051 `P0` Project Cockpit

**范围**

- 目标与里程碑；
- 快照变化；
- 工作包；
- 依赖；
- PR/CI；
- 风险；
- 最近运行；
- 成本。

### LF-052 `P0` Run Replay

**验收标准**

- 按时间展示 RunStep；
- 可以查看模型、工具、命令、产物和错误；
- 敏感字段脱敏；
- 页面刷新后不丢失事件。

### LF-053 `P1` Review Inbox

集中展示计划、代码、部署、预算和权限审批。

---

## Epic 6：规划与排期

### LF-060 `P0` Planner 接口与结构化输出

### LF-061 `P0` Dependency Builder

### LF-062 `P0` Estimator

### LF-063 `P0` Independent Critic

### LF-064 `P0` Schedule Scenario

### LF-065 `P0` Schedule Version Commit

**共同验收标准**

- 模型输出必须经过 Schema 校验；
- 每个计划建议关联输入快照；
- 计划存在创建模型、Prompt 版本和成本记录；
- 情景计划不会修改正式计划；
- 正式提交产生不可变版本和 Diff。

### LF-066 `P1` 时间线与影响模拟 UI

**验收标准**

- 支持正式、暂定和情景三条时间线；
- 拖动后显示资源、期限和其他项目影响；
- 用户可以放弃情景而不修改正式计划。

---

## Epic 7：执行器与代码闭环

### LF-070 `P0` 定义 `AgentExecutor` 接口

```ts
interface AgentExecutor {
  capabilities(): Promise<CapabilityProfile>;
  start(request: RunRequest): Promise<RunHandle>;
  resume(runId: string, input: ResumeInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  stream(runId: string): AsyncIterable<AgentEvent>;
  collect(runId: string): Promise<RunResult>;
}
```

### LF-071 `P0` Shell/Mock Executor

先用确定性脚本验证完整工作流与事件协议。

### LF-072 `P0` Git branch/worktree 管理

**验收标准**

- 每个 Run 独立目录与分支；
- 分支命名可追溯到工作包；
- 中断后可以清理；
- 不允许直接修改主分支。

### LF-073 `P0` rootless Docker Sandbox

### LF-074 `P0` Codex Adapter

### LF-075 `P0` Claude Adapter

### LF-076 `P0` 测试与静态分析步骤

### LF-077 `P0` Independent Reviewer

### LF-078 `P0` 创建 PR 与同步 CI

### LF-079 `P1` Repair Loop

**验收标准**

- 每次修复尝试单独记录；
- 达到最大次数后停止并转人工；
- 不允许无限自治循环；
- 升级模型的原因可见。

---

## Epic 8：模型策略与成本

### LF-080 `P0` Capability Registry

### LF-081 `P0` Model Policy 配置

### LF-082 `P0` Token 与成本 Ledger

### LF-083 `P0` 预算门禁

### LF-084 `P1` 自动升级与降级

### LF-085 `P1` Provider 故障切换

**验收标准**

- 业务流程不引用硬编码模型名称；
- 每次模型选择有策略版本；
- 单任务和全局预算都能阻止新执行；
- 已发生费用不可被覆盖或删除；
- 回退不会绕过隐私和权限限制。

---

## Epic 9：资源调度与集中突破

### LF-090 `P0` PostgreSQL 资格队列

### LF-091 `P0` 优先级评分

### LF-092 `P0` 资源池与预留

### LF-093 `P0` 并发与配额

### LF-094 `P0` Focus Window

### LF-095 `P1` 抢占与老化

### LF-096 `P1` Compute Console

**验收标准**

- 不满足依赖或预算的任务不会领取；
- Worker 使用原子领取避免重复运行；
- Focus Window 可限定项目、时间、预算和最大并发；
- 结束时间到达后停止发放新任务；
- 可抢占任务必须显式标记；
- 资源泄漏可通过对账修复。

---

## Epic 10：安全、审批与审计

### LF-100 `P0` 风险等级与权限策略

### LF-101 `P0` 临时凭据与密钥代理

### LF-102 `P0` 网络白名单

### LF-103 `P0` 高风险命令审批

### LF-104 `P0` 审计日志查询

### LF-105 `P1` 紧急停止与撤销

**验收标准**

- L4/L5 动作无法由模型单独批准；
- 日志和 Trace 不显示明文密钥；
- 审批关联具体动作、输入和风险；
- Run 取消后 Worker 最终停止；
- 审计事件不可通过普通 API 修改。

---

## Epic 11：可观测性与评测

### LF-110 `P0` OpenTelemetry Trace

### LF-111 `P0` 运行指标与错误监控

### LF-112 `P0` 成本与成功率看板

### LF-113 `P1` Golden Task Set

### LF-114 `P1` Shadow Run

### LF-115 `P1` Trace Grading

**验收标准**

- 一次 Run 的工作流、模型、工具和命令可串联；
- 可以按项目、任务类型、能力档统计成本；
- 新模型策略可以与现有策略并行评估；
- 评测数据与生产事实分离；
- 策略更新可回滚。

---

## Epic 12：移动入口与通知

### LF-120 `P2` Telegram Gateway

### LF-121 `P2` 移动端项目摘要

### LF-122 `P2` 语音转结构化命令

### LF-123 `P2` 审批通知

### LF-124 `P2` 每日项目简报

**验收标准**

- 每个消息命令具备幂等键；
- 高风险操作跳转到完整审批；
- 移动端不能绕过权限和预算；
- 通知包含可追溯的项目、工作包和 Run ID。

---

## 首个垂直切片建议

不要按 Epic 顺序把所有基础设施一次做完。建议第一条垂直切片只包含：

1. LF-001 Monorepo；
2. LF-002 本地环境；
3. LF-003 CI；
4. LF-010 最小 Schema；
5. LF-011 状态机；
6. LF-012 工作包契约；
7. LF-020/021 最小 API；
8. LF-030 Temporal 接入；
9. LF-032 执行工作流骨架；
10. LF-050 最小项目页面；
11. LF-070 Executor 接口；
12. LF-071 Mock Executor；
13. LF-052 Run Replay。

这条切片的目标不是接入真实模型，而是验证：

```text
创建工作包
→ 状态校验
→ 排队
→ 启动持久工作流
→ Mock 执行
→ 产生证据
→ 更新状态
→ UI 回放
```

完成后，再接 GitHub 和真实代码执行器，能够显著降低系统设计同时变化带来的风险。
