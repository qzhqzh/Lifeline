# Lifeline 组合推进大板 V2 方案执行文档

> 状态：执行中；S0 `LF-PV2-001`–`LF-PV2-005` 已完成，本地 S4 MCP 垂直切片已实现并验证（2026-08-02）
> 事实基线：2026-08-01
> 目标版本：Portfolio V2
> 核心层级：`Project → Phase → Task`，不增加第三层业务层级

## 1. 结论先行

本轮不推翻现有视觉主题和“纵向项目、横向推进”的方向，重点解决五件事：

1. 首页只展示真实的 `Lifeline`、`EchoMe`、`Totemora` 三个项目，并根据仓库历史导入已完成、进行中和待处理任务。
2. “载入本次排期”改为**服务端记录的每用户一次性初始化动作**；成功后永久隐藏，重复请求也不会重复写入。
3. 页面只保留右上角一个“新增”入口，项目、阶段和任务都在右侧抽屉中完成创建。
4. 项目推进大板使用固定项目信息栏和独立横向任务轨道；筛选只改变任务强调程度，不改变泳道几何尺寸和滚动位置。
5. 为 Agent 提供查询、创建、扫描提案和完成回报 MCP；Agent 可以提交事实与证据，但不能仅凭一句“已完成”直接把任务改成 `VERIFIED`。

并行任务有必要，但只通过 `dependsOnTaskIds` 和 `parallelPolicy` 表达。界面按依赖图推导可并行槽位，不新增 Epic、Subtask、Lane 等层级。

## 2. 本轮产品目标与非目标

### 2.1 产品目标

用户进入首页后，应能在 10 秒内回答：

- 哪个项目最值得优先投入；
- 每个项目已经走到哪里；
- 当前正在推进的任务是什么；
- 左边完成了什么，右边接下来做什么；
- 算力不足时有哪些低成本任务；
- 算力充足时应集中突破哪些任务；
- Agent 最近发现了什么 Bug，以及它为何被加入排期；
- 一项任务由什么模型完成、何时完成、有什么可复核证据。

### 2.2 本轮不做

- 不增加 `Project → Epic → Phase → Task` 等更深层级；
- 不建设按日历日期自由拖拽的完整甘特图；
- 不让筛选结果删除项目行或重排项目行；
- 不让周期扫描直接制造大量正式任务；扫描结果先去重并进入 `DISCOVERED`；
- 不把具体模型版本硬编码到排期规则，排期保存能力档，真实执行记录具体模型；
- 不以 MCP 的可选 Tasks 扩展替代 Lifeline 自己的 Run 状态机；
- 不在本轮顺手迁移全部生产技术栈。

## 3. 当前事实与问题定位

| 现状 | 代码事实 | V2 决策 |
|---|---|---|
| 当前数据仍有 `Lifeline Demo`、`Release Radar · 示例`、`Knowledge Lab · 示例` | `data/lifeline.json` 和 `src/service.js` 的 `portfolioDemo()` | 迁移为三个真实项目；旧演示对象保留迁移记录后归档，不硬删除 |
| 示例载入是全局 `POST /api/demo` | 没有用户身份和 bootstrap receipt | 改为用户作用域的 bootstrap API，并用唯一约束保证只执行一次 |
| 顶部入口跳到页面底部表单 | `public/index.html` 的 `#workbench` | 删除底部创建表单，只留右上“新增”抽屉；运行回放不在本轮删除 |
| 筛选会重新计算 `visibleItems` 和 Phase 集合 | `public/app.js` 的 `renderBoard()` | 筛选改为稳定焦点模式：结构不变，只改变节点强调和匹配摘要 |
| Phase 只是 Task 内的名称与数字 | `planning.phase`、`phaseOrder` | 引入正式 `Phase` 实体，旧字段保留只读兼容和迁移路径 |
| Task 顺序是整数且没有编辑 API | `planning.taskOrder` | 增加版本化 reorder API；服务端原子重排并检测版本冲突 |
| 没有依赖和并行语义 | 当前只有顺序 | 增加依赖边和 `parallelPolicy`，并行槽位由系统推导 |
| 没有 MCP | 当前只有 REST、SSE、OpenAPI | REST Service 仍是唯一业务入口，MCP 仅作为受权限控制的适配层 |

当前工作区不是干净基线：Lifeline 的组合大板与载入修复、EchoMe 的 Project Knowledge 都存在未提交改动。因此本文将它们标为 `REVIEW` 或 `RUNNING`，不会伪装成已发布历史。

## 4. 产品名称与首页文案

项目卡不再写成技术说明书。名称保持品牌，下一行负责让用户理解它为何值得关注，简介再解释用户收益。

| 项目 | 首页主张 | 产品简介 | 默认战略值 |
|---|---|---|---:|
| Lifeline | **让每个 AI 项目，都沿着最值得的方向持续推进** | 把分散的项目、算力与下一步收进同一条推进线：低谷不空转，算力充足时集中突破。 | 10 |
| EchoMe | **换一个 AI，也不用重新介绍自己** | 让偏好、规则与项目往事在不同 AI 之间自然接续，每次协作都从“已经懂你”开始。 | 9 |
| Totemora | **让一群各有所长的 AI，像真正的团队一样协作** | 强模型负责判断，专长成员负责执行；每次组队、花费与成长都有证据可追溯。 | 8 |

首页其他建议文案：

- 页面标题：`把所有项目，放回同一条推进线上`
- 页面简介：`看清当前、安排下一步，并把有限算力投到最值得突破的地方。`
- 一次性按钮：`载入本次项目排期`
- 按钮辅助说明：`会为当前用户写入三个真实项目及历史任务，仅可执行一次。`
- 右上主按钮：`新增`
- 当前节点操作：`回到当前`
- 项目展开操作：`查看全部任务`

项目名称中不得出现 `Demo`、`示例`、`样例`。示例属性属于数据来源，不属于产品名称。

## 5. 一次性真实排期导入

### 5.1 用户体验

1. 新用户第一次进入且没有导入记录时，显示 `载入本次项目排期`。
2. 点击后按钮进入不可重复提交的 loading 状态。
3. 服务端在一个事务中创建或迁移三个项目、Phase、Task、历史证据和 bootstrap receipt。
4. 成功后按钮从 DOM 中移除，不留 disabled 空壳。
5. 刷新、重启服务、换浏览器后仍不再显示。
6. 同一用户的重复请求返回 `200` 和原 receipt，不重复创建数据。
7. 不同用户拥有独立 receipt，可以各自导入一次。

### 5.2 服务端模型

```text
BootstrapReceipt
├─ id
├─ userId                   # 从认证上下文获取，不接受请求体伪造
├─ templateKey              # portfolio-v2-real-projects
├─ templateVersion          # 2026-08-01.1
├─ appliedAt
├─ resultProjectIds[]
└─ sourceSnapshotHash

UNIQUE(userId, templateKey)
```

短期单用户 JSON MVP 使用稳定的 `LIFELINE_LOCAL_USER_ID`，默认值可为 `local-owner`；未来接入认证后，`userId` 必须来自 token subject。前端 `localStorage` 只能做缓存，不能作为“一生只能点一次”的事实来源。

建议 API：

```text
GET  /api/bootstrap/portfolio-v2
POST /api/bootstrap/portfolio-v2
```

GET 返回：

```json
{
  "available": false,
  "templateKey": "portfolio-v2-real-projects",
  "templateVersion": "2026-08-01.1",
  "appliedAt": "2026-08-01T12:00:00Z"
}
```

POST 必须支持 `Idempotency-Key`，并在 receipt 唯一约束冲突时读取已有结果后正常返回。

### 5.3 现有数据迁移

当前用户已经载入旧版数据，迁移必须覆盖这条真实路径：

- `Lifeline Demo`：保留 ID 和已有真实 Run，改名为 `Lifeline`，更新产品文案；
- `Release Radar · 示例`：如果项目及 Task 指纹仍与旧模板完全一致，则归档旧任务和项目，再创建 EchoMe；
- `Knowledge Lab · 示例`：同上，归档后创建 Totemora；
- 旧项目或任务只要被用户修改过，就不静默覆盖；生成迁移冲突记录供用户确认；
- 完成迁移后写入 receipt，当前用户不再看到载入按钮；
- 迁移前保存原 JSON 快照，回滚通过恢复快照完成，不删除未知用户数据。

历史任务导入不伪造 Agent Run。其完成记录使用 `completionMethod=IMPORTED_HISTORY`，并关联 commit、release、测试文档等真实来源。

## 6. 三个项目的首批真实排期数据

### 6.1 状态与推荐档约定

| 标记 | 含义 |
|---|---|
| `RELEASED` | 有发布或等价上线证据 |
| `VERIFIED` | 代码与验收证据已在主分支成立 |
| `REVIEW` | 实现已在工作区，待独立复核或入库 |
| `RUNNING` | 当前工作区正在实现 |
| `READY` | 契约完整，可进入执行队列 |
| `PLANNED` | 已排期，但依赖或验收契约尚未满足 |

推荐执行档：

- `LOW-SCAN`：确定性命令优先，低推理、低算力；
- `LUNA-CODE`：Luna 主实现，高推理、高算力；
- `LUNA-MEDIUM`：Luna 处理边界清晰任务，中推理、中算力；
- `INDEPENDENT-REVIEW`：与实现上下文隔离的复核模型，中高算力；
- `HUMAN-DECISION`：涉及产品取舍、权限或高风险迁移时由用户确认。

具体 provider、model id、版本、token 和费用只在 Run 发生时记录，不写死在模板中。

### 6.2 Lifeline

事实来源：仓库提交 `5fb358b`、`dcf6b13`，当前工作区，以及 `README.md`、`docs/ROADMAP.md`、`docs/IMPLEMENTATION_STATUS.md`。

| Phase | Task | 状态 | 证据或依赖 | 推荐 |
|---|---|---|---|---|
| S1 建立可信控制平面 | 明确控制平面优先的产品边界与 ADR | VERIFIED | `5fb358b`、`docs/adr/0001-control-plane-first.md` | LOW-SCAN |
| S1 建立可信控制平面 | 建立 Project、WorkItem、Run、Evidence 与状态机 | VERIFIED | `dcf6b13` | LUNA-CODE |
| S1 建立可信控制平面 | 实现原子 JSON 持久化、恢复和重复排队保护 | VERIFIED | `dcf6b13` | LUNA-CODE |
| S1 建立可信控制平面 | 跑通 Mock Executor、REST、SSE 与 Run Replay | VERIFIED | `dcf6b13`、Node 测试 | LUNA-CODE |
| S2 看清所有项目 | 实现 Project × Phase × Task 组合大板 | REVIEW | 当前 Lifeline 工作区、待视觉复核 | LUNA-CODE |
| S2 看清所有项目 | 修复旧数据载入与前后端版本不一致报错 | REVIEW | 当前工作区回归测试，待入库 | LUNA-MEDIUM |
| S2 看清所有项目 | 导入三个真实项目和每用户一次性 receipt | VERIFIED | `test/portfolio-v2.test.js`、正式数据核查 | LUNA-CODE |
| S2 看清所有项目 | 让项目价值更清晰，创建入口更简单 | VERIFIED | `public/app.js`、正式页面验收 | LUNA-MEDIUM |
| S3 稳定编辑排期 | 固定项目栏、稳定筛选、当前节点居中 | REVIEW | 固定栏与居中已实现；筛选几何仍需复核 | LUNA-CODE |
| S3 稳定编辑排期 | 展开项目全部任务并支持键盘/拖拽排序 | REVIEW | 详情与拖拽已实现；键盘、跨阶段与 Undo 待补 | LUNA-CODE |
| S3 稳定编辑排期 | 加入依赖校验与可并行任务展示 | PLANNED | 依赖 reorder API | LUNA-CODE |
| S4 开放 Agent 接口 | 提供 Project/Phase/Task 查询与创建 MCP | VERIFIED | `test/mcp.test.js`、本地 stdio MCP | LUNA-CODE |
| S4 开放 Agent 接口 | 补齐扫描提案与指纹去重 MCP | PLANNED | 依赖 scanner policy | LUNA-CODE |
| S4 开放 Agent 接口 | 接入 Streamable HTTP、OAuth 与多用户隔离 | PLANNED | 依赖权限边界与远程 transport | INDEPENDENT-REVIEW |
| S5 持续推进闭环 | 周期扫描仓库并去重生成 Bug 候选 | PLANNED | 依赖 MCP 与 scanner policy | LOW-SCAN |
| S5 持续推进闭环 | Agent 完成后自动进入复核并更新项目进度 | REVIEW | 本地完成门禁已实现；真实 Executor 待接入 | INDEPENDENT-REVIEW |
| S6 生产化与可靠发布 | 建立端到端浏览器回归与发布门禁 | PLANNED | 依赖 S3 交互收敛 | INDEPENDENT-REVIEW |
| S6 生产化与可靠发布 | 迁移 PostgreSQL Repository 并完成恢复演练 | PLANNED | 依赖领域契约稳定 | LUNA-CODE |
| S6 生产化与可靠发布 | 接入 Temporal、真实 Executor 与模型路由 | PLANNED | 依赖持久层与 S5 门禁 | LUNA-CODE |
| S6 生产化与可靠发布 | 迁移 React 应用并完成灰度切换 | PLANNED | 依赖 V2 交互契约稳定 | LUNA-CODE |

> 2026-08-02 排期核查：历史导入 CompletionRecord 改用真实 Git 提交时间；旧 Run 补齐 CompletionRecord 但保留原 Executor 与 Evidence。详情页“当前进度”按排期顺序指向最后一个已完成任务，不再受初始化时间干扰。

### 6.3 EchoMe

事实来源：EchoMe 主分支历史、发布标签、`README.md`、`docs/memory-sleep.md`，以及当前未提交的 `docs/project-knowledge.md` 与对应代码。

| Phase | Task | 状态 | 证据或依赖 | 推荐 |
|---|---|---|---|---|
| S1 让记忆跨 AI 接续 | 完成架构、记忆模型、API/MCP 规范与路线图 | VERIFIED | `769a7b9` | LOW-SCAN |
| S1 让记忆跨 AI 接续 | 建立 Hub、CLI、MCP Server 与迁移骨架 | VERIFIED | `8bb8a9b`、`bd25ae7` | LUNA-CODE |
| S1 让记忆跨 AI 接续 | 建立 Vue Web Console 与 Docker 部署入口 | VERIFIED | `a8c03ca`、`4b7aa99` | LUNA-CODE |
| S2 成为可用的多人产品 | 完成多用户认证、数据隔离与 Market | VERIFIED | `efbf6aa`、`232387f`、`662688b` | LUNA-CODE |
| S2 成为可用的多人产品 | 完成管理、速率限制、安全加固与多语言体验 | VERIFIED | `29d2372`、`df3a97e`、`d773abc`、`0fae3aa` | LUNA-MEDIUM |
| S2 成为可用的多人产品 | 建立 PyPI、CI/CD、doctor/version 并发布 v1.0 | RELEASED | `v1.0.0`、`v1.0.1` | LUNA-MEDIUM |
| S3 降低记忆使用成本 | 默认分发 MCP、增加 seed 并完成 v1.1.x 稳定修复 | RELEASED | `c79cd88`、`52ed3be`、`v1.1.7` | LUNA-MEDIUM |
| S3 降低记忆使用成本 | 建立 summary-first 检索工作流 | RELEASED | `f720805`、`v1.2.0` | LUNA-CODE |
| S3 降低记忆使用成本 | 完成 Memory Sleep 与可观测性 | RELEASED | `824fc64`、`v1.3.0` | LUNA-CODE |
| S4 让记忆可解释 | 增加 graph explain、feedback 和 retrieval debug | VERIFIED | `7bff05d`、`3f0c91d`、`f769954` | LUNA-CODE |
| S4 让记忆可解释 | 增加图工具、能力指南并改善检索相关性 | VERIFIED | `53745f9`、`88a15ba`、`1730bfe` | LUNA-MEDIUM |
| S5 让项目知识可治理 | 建立 Artifact 修订、Constraint 版本和影响关系 | RUNNING | EchoMe 当前工作区、`docs/project-knowledge.md` | LUNA-CODE |
| S5 让项目知识可治理 | 完成 Project Workspace、MCP context/impact/index 闭环 | RUNNING | 依赖前一项，当前有未提交实现 | LUNA-CODE |
| S5 让项目知识可治理 | 完成迁移、回归、文档同步与发布评审 | PLANNED | 依赖工作区实现稳定 | INDEPENDENT-REVIEW |
| S6 持续提高命中质量 | 建立固定检索评测集和版本间回归报告 | PLANNED | 依赖真实查询样本 | LOW-SCAN |

### 6.4 Totemora

事实来源：Totemora 主分支历史、`docs/README.md`、`docs/architecture-v2.md`、`docs/execution-plan.md`、v0.8/v0.9 验收指南与 benchmark 文档。

| Phase | Task | 状态 | 证据或依赖 | 推荐 |
|---|---|---|---|---|
| S1 点燃第一支部落 | 固化产品边界与 TUI/Runtime/Web Observatory 路线 | VERIFIED | `104130a`、ADR-0001 | LOW-SCAN |
| S1 点燃第一支部落 | 建立 Bun workspace 与配置类型、loader、validation | VERIFIED | `040a4e9`、`a19613a`、`d1005fd`、`67c6d48` | LUNA-CODE |
| S1 点燃第一支部落 | 加入示例 tribe 和 CLI inspection 命令 | VERIFIED | `d1de960`、`4d6d579` | LUNA-MEDIUM |
| S2 让部落真正接活 | 建立 Provider、只读 Runtime、Trace 和任务分析 | VERIFIED | v0.2/v0.3 文档与主分支历史 | LUNA-CODE |
| S2 让部落真正接活 | 建立常驻 Gateway、Web Playground 与持续任务入口 | VERIFIED | `4d2f97`、ADR-0002 | LUNA-CODE |
| S2 让部落真正接活 | 完成受控 Git Flow 专业服务与 MCP 提案闭环 | VERIFIED | `4d2f97`、v0.5 E2E 文档 | LUNA-CODE |
| S3 让成员持续生活 | 建立 Living Tribe Member 和 Intelligence Watch | VERIFIED | `ab7b65c` | LUNA-CODE |
| S3 让成员持续生活 | 建立任务历史、成员画像与可归因经验 | VERIFIED | v0.6/v0.8 文档 | LUNA-CODE |
| S4 建立情报与成长闭环 | 完成候选情报管线、Bark 派发与反馈校正 | VERIFIED | `08552ec`、ADR-0009/0012 | LUNA-CODE |
| S4 建立情报与成长闭环 | 完成人物画像、受治理演化与专业服务 | VERIFIED | `b61396e`、ADR-0010/0011 | LUNA-CODE |
| S4 建立情报与成长闭环 | 将 JSON 状态迁移到 SQLite 持久层 | VERIFIED | `e9b062a`、v0.9 验收指南 | LUNA-CODE |
| S4 建立情报与成长闭环 | 增加 Web Observatory v2 与 benchmark CLI 骨架 | VERIFIED | `89d474b`、`ff7b949` | LUNA-MEDIUM |
| S5 证明部落确有收益 | 跑通 3 个只读 smoke benchmark | VERIFIED | `docs/benchmark.md` | LOW-SCAN |
| S5 证明部落确有收益 | 扩展为 10–20 个真实任务和稳定价格快照 | READY | 依赖额度与预算确认 | LOW-SCAN |
| S5 证明部落确有收益 | 增加代码变更类隔离 scorer | PLANNED | 依赖 sandbox 与测试契约 | LUNA-CODE |
| S5 证明部落确有收益 | 对比单强、单廉价、部落三策略并作停止/继续决策 | PLANNED | 依赖完整 benchmark 样本 | HUMAN-DECISION |
| S6 收紧受控执行 | 统一命令策略、pre/post hooks、OS sandbox 与 action journal | PLANNED | 依赖 benchmark 证明收益 | LUNA-CODE |

## 7. 领域模型调整

### 7.1 仍然只有两级排期

```text
Project
└─ Phase
   └─ Task
```

依赖边、Run、Evidence、CompletionRecord 都是 Task 的关系或执行记录，不是新的业务层级。

### 7.2 Phase 成为正式实体

```text
Phase
├─ id
├─ projectId
├─ title
├─ goal
├─ rank
├─ status                 # ACTIVE / COMPLETED / CANCELLED
├─ createdAt / updatedAt
└─ createdBy
```

迁移时按 `(projectId, planning.phaseOrder, planning.phase)` 去重生成 Phase，再把 Task 绑定到 `phaseId`。旧 `planning.phase` 与 `phaseOrder` 在一个兼容周期内只读投影，避免现有客户端立即失效。

### 7.3 Task 排期字段

```text
Task.schedule
├─ phaseId
├─ rank
├─ priority               # P0..P3
├─ commitment             # COMMITTED / TENTATIVE
├─ kind                   # feature / bug / scan / research / ops / review
├─ dependsOnTaskIds[]
├─ parallelPolicy         # AUTO / SEQUENTIAL / PARALLEL_ALLOWED
├─ earliestStartAt?
├─ dueAt?
└─ scheduleVersion
```

未完成任务允许取消。状态机增加 `CANCELLED`，可从 `DISCOVERED`、`TRIAGED`、`PLANNED`、`READY`、`BLOCKED` 进入；`QUEUED` 或 `RUNNING` 必须先安全取消 Run，再进入 `CANCELLED`。取消保留原因、操作者和时间，不删除任务。

### 7.4 顺序与并发

- Phase 和 Task 的 `rank` 初始按 `1024` 递增；
- reorder 请求提交完整目标顺序和 `expectedScheduleVersion`；
- 服务端在事务内重新分配 rank，并生成不可变 Schedule Diff；
- 版本不一致返回 `409 SCHEDULE_VERSION_CONFLICT`，前端重新加载并展示差异；
- 硬依赖形成 DAG，保存前检测环；
- 同 Phase、前置依赖均满足且 `parallelPolicy != SEQUENTIAL` 的任务可并行；
- 并行槽位是拓扑排序结果，不由用户维护第三层“并行组”。

### 7.5 完成记录

```text
CompletionRecord
├─ taskId / runId
├─ completionMethod       # AGENT_RUN / HUMAN / IMPORTED_HISTORY
├─ agentId / executor
├─ provider / modelRef / modelSnapshot
├─ reasoningEffort
├─ promptVersion / policyVersion
├─ startedAt / completedAt / durationMs
├─ inputTokens / outputTokens / cost
├─ commitSha / prUrl / artifactUris[]
├─ testEvidenceIds[] / reviewEvidenceIds[]
├─ submittedAt / submittedBy
├─ verifiedAt / verifiedBy
└─ resultSummary
```

Agent 提交完成记录后，Task 只进入 `REVIEW`。只有确定性验收、外部 CI、独立 reviewer 或人工批准满足执行契约后，控制平面才提交 `VERIFIED`。

## 8. 项目推进大板交互规范

### 8.1 桌面结构

```text
┌──────────────────── 固定项目栏 280px ────────────────────┬──────────── 独立横向轨道 ────────────┐
│ Lifeline                                                   │ 已完成 ← 当前任务 → 待处理             │
│ 主张 / 进度 / 未完成数 / 展开 / 回到当前                  │ [S1 tasks][S2 tasks][S3 tasks] ...    │
└────────────────────────────────────────────────────────────┴──────────────────────────────────────┘
```

- 每个项目泳道是两列 Grid；左侧不进入横向滚动容器；
- 左侧宽度默认 `280px`，窄桌面可降为 `240px`；
- 右侧 `overflow-x: auto`，每个项目保存自己的 `scrollLeft`；
- Task 节点固定宽度，Phase 用连续背景带和标题分组；
- 已完成任务在序列左侧，第一项未完成任务是“当前”，待处理任务在右侧；
- 当前节点使用 outline、inset shadow 和色彩强调，不改变 border 宽度、padding 或节点尺寸。

### 8.2 当前节点聚焦

- 首次进入或用户点击“回到当前”时，将该项目第一项未完成 Task 居中；
- 只有显式动作允许改变横向滚动位置；
- 筛选、状态刷新、SSE 更新不得反复调用 `scrollIntoView()`；
- 用户手动滚动后保存位置，返回页面时恢复；
- 项目全部完成时聚焦最后一个已完成节点。

### 8.3 筛选不再改变几何结构

`全部排期`、`低算力可做`、`集中突破`、`Bug / 扫描` 都是“焦点筛选”：

- 项目顺序、泳道高度、Phase 宽度、Task 槽位和滚动位置保持不变；
- 匹配节点保持完整对比度，并显示匹配数量；
- 不匹配节点降为低对比度，但仍占原槽位；
- 项目没有匹配任务时仍显示整行和 `本筛选 0 项`；
- 动画只使用 150–200ms 的 opacity/color，支持 `prefers-reduced-motion`；
- 不使用 `display:none` 重建 Phase，不使用改变尺寸的 hover/active 效果。

### 8.4 多任务与项目展开

收起态用于导航，不负责展示每一项细节：

- 每个节点展示标题、状态、优先级、算力和估时；
- 并行槽最多展示两条节点，更多内容显示 `+N`；
- 左侧“查看全部任务”在当前项目行下方展开完整任务清单；
- 展开是用户主动行为，因此允许该项目行增高，但其他项目不重新排布；
- 完整清单按 Phase 分组，列出顺序、Task、状态、依赖、推荐、证据和最近执行；
- 展开态支持拖拽手柄，也提供“上移/下移/移到其他阶段”键盘菜单；
- 移动后出现可撤销 toast；跨 Phase 移动先预览依赖影响；
- 违反硬依赖或产生环时拒绝保存，并说明具体阻塞 Task。

### 8.5 移动端

- 项目栏成为每个项目的顶部 sticky 摘要，不强行保留 280px 左栏；
- 时间线仍横向滚动，不把所有 Task 压成不可读的小卡；
- 右侧抽屉在小屏变为全屏 sheet；
- 拖拽不是唯一排序方式，键盘/菜单操作在触屏同样可用。

## 9. 唯一“新增”抽屉

### 9.1 入口与布局

- 删除页面底部“添加关注项目”和“添加排期任务”表单；
- 顶部右侧只保留 `新增`；
- 桌面抽屉宽 `560–640px`，移动端全屏；
- 抽屉通过顶层 portal 或原生 dialog 渲染，避免被页面容器裁切；
- 关闭前若有未保存内容，提示保留草稿或放弃；
- 提交期间禁用重复提交，错误显示在对应字段附近。

### 9.2 两种创建路径

**新增项目**

1. 品牌名称；
2. 一句话主张；
3. 产品简介；
4. 仓库地址；
5. 战略价值；
6. 保存后可直接继续创建第一个 Phase。

**新增排期**

1. 选择项目；
2. 选择已有 Phase，或选择“新建 Phase”；
3. 新 Phase 填写名称、目标和插入位置；
4. 填写 Task 标题、目标、验收标准、类型、优先级、算力约束和依赖；
5. 系统实时生成推荐能力档、推理强度、估时和做法；
6. 用户可接受推荐，也可展开高级项微调；
7. `保存并继续添加` 保持当前项目与 Phase，方便连续录入。

推荐值应默认折叠，减少选择负担；只有用户主动展开时才展示 executor、reasoning effort、预算等高级字段。

## 10. REST 与 MCP 设计

### 10.1 总体边界

```text
Web UI ───────┐
Scheduler ────┼──> Lifeline Application Service ──> Store / Run / Evidence / Audit
MCP Adapter ──┘
```

MCP 不复制业务逻辑。所有工具调用进入与 Web 相同的 Application Service、权限检查、状态机、幂等和审计链。

MCP 官方规范将 Resources 定位为供应用选择的上下文，把 Tools 定位为可由模型发现和调用的操作；Tools 支持 JSON Schema 输入、结构化输出与行为 annotations。因此 Lifeline 使用 Resources 暴露稳定只读上下文，同时提供 read tools 兼容尚未完整支持 Resources 的 Host。参考：

- [MCP Resources 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

### 10.2 Resources

```text
lifeline://portfolio
lifeline://projects/{projectId}
lifeline://projects/{projectId}/schedule
lifeline://tasks/{taskId}
lifeline://runs/{runId}
lifeline://scans/{scanId}
```

资源返回紧凑 JSON 或 Markdown，并带 `lastModified`。list/read 结果使用合适的 `ttlMs` 和 `cacheScope=private`；后续可通过 `subscriptions/listen` 订阅 `portfolio` 和 `schedule` 更新。列表和搜索必须分页，cursor 对客户端保持 opaque。

### 10.3 首批 Tools

| Tool | 作用 | Scope | 关键约束 |
|---|---|---|---|
| `lifeline_list_projects` | 查询项目摘要 | `portfolio:read` | readOnly |
| `lifeline_get_schedule` | 查询 Phase/Task、依赖和推荐 | `portfolio:read` | readOnly、支持过滤和 cursor |
| `lifeline_get_task` | 查询执行契约、Run 和 Evidence | `portfolio:read` | readOnly |
| `lifeline_create_project` | 创建项目 | `portfolio:write` | idempotency key |
| `lifeline_create_phase` | 创建或插入 Phase | `schedule:write` | expected schedule version |
| `lifeline_create_task` | 在 Phase 内创建 Task | `schedule:write` | 完整来源与验收契约 |
| `lifeline_reorder_tasks` | 重排或跨 Phase 移动 | `schedule:write` | 版本冲突和依赖校验 |
| `lifeline_cancel_task` | 取消未完成 Task | `schedule:write` | 记录原因，运行中先取消 Run |
| `lifeline_submit_scan_findings` | 批量提交扫描发现 | `scan:write` | fingerprint 去重，只进入 DISCOVERED |
| `lifeline_start_task` | 申请执行 Task | `execution:write` | 预算、依赖、权限门禁 |
| `lifeline_submit_completion` | 提交完成结果和证据 | `execution:write` | 只进入 REVIEW，不直接 VERIFIED |

每个 tool 同时定义 `inputSchema` 和 `outputSchema`，返回 `structuredContent`；为兼容旧 Host，可同时返回序列化 text。Tool annotations 只作为客户端 UX 提示，服务端不能依赖它们执行安全判断。

### 10.4 Transport 与认证

- 本地第一版使用 `stdio`，复用当前单机开发方式；
- 远程/多用户使用 Streamable HTTP 的单一 `/mcp` endpoint；
- 按 2026-07-28 规范实现无会话请求：每个请求携带 protocol version、client capabilities 和 client info `_meta`，服务端实现 `server/discover`；
- 跨调用状态只通过显式、不可猜测的 `runId`、`scanId` 等 handle 传递，不依赖连接或隐式 session；
- HTTP MCP 使用 OAuth 作用域和真实用户 subject，生产环境只允许 HTTPS；
- stdio 从环境或本地安全配置读取身份，不把 token 输出到 stdout；
- 最小权限拆为 `portfolio:read`、`portfolio:write`、`schedule:write`、`scan:write`、`execution:write`、`admin`；
- 所有 mutating tool 写入 actor、client、tool call、idempotency key 和结果摘要；
- 不接受 token passthrough；每个请求重新校验 token、audience、scope 与 handle 所属用户。

官方传输与授权参考：

- [MCP 2026-07-28 规范总览](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

最新核心规范已把长任务移为官方可选扩展 `io.modelcontextprotocol/tasks`，其实现仓库仍标记为 experimental，且 Host 支持度不一致。Lifeline 第一版返回显式 `runId` 供轮询；后续只在客户端声明扩展能力时映射为 MCP Task handle。两种情况下，内部事实都仍是 Lifeline Run。参考 [MCP Tasks 扩展](https://modelcontextprotocol.io/extensions/tasks/overview)。

## 11. 周期扫描与 Agent 完成闭环

### 11.1 扫描不是 MCP 自带的调度器

周期由 Lifeline Scheduler 或外部 cron 触发，MCP 只是 Agent 提交和查询结果的接口：

```text
Schedule
→ Collect deterministic facts
→ Run cheap rules/tests
→ Send only anomalies to low-cost model
→ Normalize findings
→ Fingerprint + deduplicate
→ Submit findings
→ DISCOVERED tasks
→ Triage / user approval
→ PLANNED or ignored
```

推荐扫描频率：

- Git/CI 增量：Webhook 优先，失败时每 15 分钟补偿；
- 快速静态检查、TODO/FIXME、安全规则：每天或主分支变化后；
- 高成本语义扫描：每周、版本节点或用户主动触发；
- 已解决 Bug 回归：相关文件、依赖或测试发生变化后触发。

### 11.2 去重与重新打开

Bug fingerprint 建议由以下字段组成：

```text
projectId + scannerId + ruleId + normalizedPath + normalizedSignature + sourceBranch
```

- 相同 fingerprint 的重复发现增加 occurrence 和 lastSeenAt，不创建新 Task；
- 已解决问题再次出现时创建新的 occurrence，并把 Task 从 `VERIFIED` 派生为新的 Bug Task，而不是篡改历史完成记录；
- 模型生成标题和摘要，规则字段与原始证据不可被模型覆盖；
- 低置信发现保持 candidate，不进入正式排期。

### 11.3 Agent 完成路径

```text
READY
→ start_task（冻结输入、策略和预算）
→ RUNNING
→ Agent 执行并持续写 Run events
→ submit_completion（模型、时间、产物、测试、commit/PR）
→ REVIEW
→ 确定性测试 + 独立审查/人工审批
→ VERIFIED
→ 如有发布证据则 RELEASED
```

如果测试失败、证据缺失或输出与执行契约不符，任务进入 `BLOCKED` 或回到 `RUNNING`，不会因 Agent 自述成功而增加已验证进度。

## 12. Luna 实施排期

每个 Task 应形成一个可独立评审的小批次。commit、push、PR、deploy 仍是独立授权动作，执行本文不自动获得这些权限。

### S0：锁定事实与数据迁移（P0）

> 批次结果：已完成。当前正式 JSON 副本迁移、并发重复请求、第二用户、冲突数据、服务重启与桌面/移动端按钮隐藏均已验证；未修改正式数据文件。

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-001 | 为现有 JSON 增加 schemaVersion、local user 与 migration harness | 旧 fixture 可读；迁移重复执行无变化 | 无 | LUNA-MEDIUM |
| LF-PV2-002 | 引入 Phase、BootstrapReceipt、CompletionRecord 最小模型 | 校验、序列化、向后兼容单测通过 | 001 | LUNA-CODE |
| LF-PV2-003 | 建立三个真实项目的版本化模板 | 表中历史 Task、状态、证据引用完整 | 002 | LOW-SCAN |
| LF-PV2-004 | 实现旧演示数据指纹迁移和每用户一次性 API | 并发双击、重启、第二用户、冲突数据测试通过 | 003 | LUNA-CODE |
| LF-PV2-005 | 更新 dashboard bootstrap capability 与前端按钮 | receipt 存在时按钮永久不渲染 | 004 | LUNA-MEDIUM |

### S1：产品文案与唯一创建入口（P0）

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-010 | 更新三项目文案、首页标题和空状态 | 不出现 Demo/示例项目名；中文文案不截断 | 003 | LUNA-MEDIUM |
| LF-PV2-011 | 建立右侧新增抽屉和项目创建路径 | 桌面/移动、焦点锁定、Esc、脏草稿符合规范 | 002 | LUNA-CODE |
| LF-PV2-012 | 建立已有/新建 Phase + Task 创建路径 | 推荐值可直接接受；高级项默认折叠 | 011 | LUNA-CODE |
| LF-PV2-013 | 删除底部重复创建表单，保留运行回放 | 页面只有一个新增入口；旧提交能力无回退 | 012 | LUNA-MEDIUM |

> 2026-08-02 进展：`LF-PV2-010` 已完成三项目产品文案与空状态；`LF-PV2-011` 已完成项目/任务统一右侧抽屉、原生焦点锁定、Esc 与脏草稿关闭保护；`LF-PV2-012` 已完成已有/新建 Phase + Task 路径和推荐默认值；`LF-PV2-013` 已删除底部重复表单并保留运行回放。

### S2：稳定的核心推进大板（P0）

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-020 | 重构为固定项目栏 + 独立横向 Task 轨道 | 三项目长任务数据下左栏固定、轨道可独立滚动 | 010 | LUNA-CODE |
| LF-PV2-021 | 实现当前节点首次居中和滚动位置保存 | 刷新恢复；筛选/SSE 不抢用户滚动 | 020 | LUNA-CODE |
| LF-PV2-022 | 将四个筛选改为稳定焦点筛选 | 切换前后 row rect 与 scrollLeft 不变 | 020 | LUNA-CODE |
| LF-PV2-023 | 实现项目内联展开和完整任务清单 | 收起态清晰；展开态能看到全部 Phase/Task/证据 | 020 | LUNA-CODE |
| LF-PV2-024 | 完成桌面、移动、键盘和 reduced-motion 验收 | 自动测试 + 两档真实截图通过 | 021–023 | INDEPENDENT-REVIEW |

### S3：可编辑顺序与最小并行模型（P1）

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-030 | 加入 scheduleVersion、reorder 与 Diff API | 原子更新；冲突返回 409；审计可查询 | 002 | LUNA-CODE |
| LF-PV2-031 | 加入拖拽、键盘移动、跨 Phase 预览和 Undo | 不用鼠标也可完成全部排序操作 | 023、030 | LUNA-CODE |
| LF-PV2-032 | 加入依赖 DAG、环检测和取消状态 | 非法依赖被拒绝；取消保留历史 | 030 | LUNA-CODE |
| LF-PV2-033 | 展示可并行槽位与 `+N` 聚合 | 不新增层级；筛选后几何仍稳定 | 032 | LUNA-CODE |

> 2026-08-02 进展：已将 `LF-PV2-023` 的完整任务清单实现为可返回的独立项目详情视图，补齐稳定横条/卡片视图、悬浮完整信息、唯一当前进度与完成项锁定，并完成桌面/移动真实渲染；`LF-PV2-030` 已完成 schedule version、阶段内 reorder、409 冲突与来源审计，Diff 待补；`LF-PV2-031` 已完成占位挤压拖拽、键盘移动、跨 Phase 预览与 Undo；`LF-PV2-032` 已完成依赖 DAG、环/顺序/跨项目校验、执行门禁与保留历史的取消；`LF-PV2-033` 已完成最多两条加 `+N` 的并行槽位，仍保持 Phase → Task 两级结构。

### S4：Agent MCP（P1）

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-040 | 建立 MCP Adapter 与 stdio transport | `server/discover`、`tools/list`、逐请求 `_meta`、stderr 日志和旧 Host 兼容 smoke 通过 | 稳定 Service API | LUNA-CODE |
| LF-PV2-041 | 实现 Portfolio/Schedule/Task Resources 和只读 Tools | 分页、用户隔离、outputSchema 合同测试通过 | 040 | LUNA-CODE |
| LF-PV2-042 | 实现 Project/Phase/Task 写 Tools | 幂等、版本冲突、权限与审计测试通过 | 030、040 | LUNA-CODE |
| LF-PV2-043 | 实现扫描提案、start 和 completion Tools | Agent 无法绕过 REVIEW/VERIFIED 门禁 | 002、040 | LUNA-CODE |
| LF-PV2-044 | 加入 Streamable HTTP 与 OAuth scope | 跨用户访问拒绝；token/audience/session 安全测试通过 | 041–043 | INDEPENDENT-REVIEW |

> 2026-08-02 进展：`LF-PV2-040` 的 stdio、现代 `server/discover`、旧 Host 兼容和 tools 合同已通过测试；`LF-PV2-041` 已完成本地单用户 Resources/只读 Tools；`LF-PV2-042` 已完成 Project/Phase/Task 写入、`lifeline_sync_plan` 幂等恢复，以及带 schedule version 冲突检查的 task edit/reorder/cancel 与审计；`LF-PV2-043` 已完成 start、completion、deterministic verification 门禁，扫描提案仍待 S5；`LF-PV2-044` 未开始。实现说明见 [MCP.md](MCP.md)。

### S5：持续扫描与自动推进（P2）

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-050 | 建立 scanner registry、增量 checkpoint 和 fingerprint | 重放不产生重复 Task | 043 | LOW-SCAN |
| LF-PV2-051 | 接入 Git/CI/静态检查首批扫描器 | 失败可重试；原始证据可追溯 | 050 | LOW-SCAN |
| LF-PV2-052 | 建立 candidate → DISCOVERED → triage 流程 | 低置信候选不污染正式排期 | 050 | LUNA-MEDIUM |
| LF-PV2-053 | 将真实 Executor、测试和独立 Review 接到 CompletionRecord | 成功/失败/重试/取消都可回放 | 043 | LUNA-CODE |
| LF-PV2-054 | 建立每日摘要和项目扫描健康度 | 用户能看到新增、重复、忽略和失败数 | 051–053 | LUNA-MEDIUM |

### S6：生产化迁移（后续）

在 V2 交互和契约稳定后，再按现有路线图迁移 PostgreSQL Repository、Temporal Workflow、React 应用和真实代码执行器。迁移必须保留本文定义的 user-scoped receipt、Phase/Task、schedule version、Run/Evidence 和 MCP Service 边界。

| ID | 任务 | 验收 | 依赖 | 推荐 |
|---|---|---|---|---|
| LF-PV2-060 | 建立端到端浏览器回归与发布门禁 | 桌面、移动、拖拽、筛选和危险操作可重复验收 | S3 | INDEPENDENT-REVIEW |
| LF-PV2-061 | 迁移 PostgreSQL Repository 并完成恢复演练 | 多用户隔离、并发写、备份与恢复验证通过 | 044、S5 | LUNA-CODE |
| LF-PV2-062 | 接入 Temporal、真实 Executor 与模型路由 | 运行、重试、取消和模型快照均可回放 | 053、061 | LUNA-CODE |
| LF-PV2-063 | 迁移 React 应用并完成灰度切换 | 前后端契约兼容且可回滚 | 060–062 | LUNA-CODE |

## 13. 算力安排建议

| 算力窗口 | 优先推进 |
|---|---|
| 算力不足 | 真实历史模板、fixture、迁移指纹、确定性扫描器、API/MCP schema 测试、文档同步 |
| 中等算力 | 产品文案、抽屉表单、REST 适配、CompletionRecord 展示、可访问性修复 |
| 算力充足 | 大板结构重构、滚动/筛选状态机、迁移并发语义、依赖 DAG、MCP 权限、真实 Executor |
| 独立复核窗口 | 数据迁移、跨用户隔离、筛选视觉稳定、排序冲突、Agent 完成门禁 |

高算力批次应尽量集中完成一个完整纵向切片，避免同时开启 S2、S3、S4 三条半成品链路。低算力任务可以持续填充证据、fixture 和回归样本，为下一次集中突破准备上下文。

## 14. 验收测试矩阵

### 数据与一次性载入

- 新用户看得到按钮；成功后立即消失；
- 刷新、服务重启、换浏览器后仍不出现；
- 同一用户并发提交两次只产生一份数据；
- 用户 A 已导入不影响用户 B；
- 旧三个演示项目可安全迁移；
- 被用户修改的旧演示项目不被覆盖；
- 模板升级不会重新显示一次性按钮；
- 导入历史 Task 有 commit/doc Evidence，但没有伪造 Run。

### 大板与交互

- 四种筛选切换前后，每个项目 row 高度差不超过 1px；
- 筛选切换前后 `scrollLeft` 差不超过 1px；
- 当前节点仅首次进入或点击“回到当前”时居中；
- 左侧项目信息不随右侧轨道移动；
- 30+ Task、6+ Phase、2 个并行槽时仍可阅读；
- 展开/收起只影响目标项目；
- 拖拽和键盘排序结果一致；
- 依赖环、过期 schedule version 和运行中取消都有明确错误；
- 360px、768px、1440px 三档视口可用；
- reduced motion 下无非必要动画。

### MCP 与 Agent

- tool/resource schema 可发现且结构化输出通过校验；
- 所有写工具缺少 idempotency key 时拒绝；
- read scope 无法创建或重排；
- 一个用户不能读取另一个用户的项目、Task、Run 或 MCP Task；
- 相同扫描 finding 重放只增加 occurrence；
- Agent 提交 completion 后只进入 REVIEW；
- 缺少测试、commit 或审核证据时不能 VERIFIED；
- model、provider、时间、token、费用、产物和 verifier 均可查询；
- MCP 断线不等于取消 Lifeline Run。

## 15. 完成定义

Portfolio V2 只有在以下条件全部成立后才算完成：

1. 首页只有 Lifeline、EchoMe、Totemora 三个真实项目，文案和历史状态与仓库事实一致；
2. 当前用户的旧演示数据完成安全迁移，一次性按钮永久消失；
3. 创建入口只剩右上抽屉；
4. 筛选不引发泳道尺寸或滚动抖动；
5. 左侧项目栏固定，右侧可滚动并能回到当前节点；
6. 项目可展开查看全量 Task，用户可调整顺序；
7. 依赖和并行不引入第三层业务结构；
8. Agent 能通过 MCP 查询和创建 Project/Phase/Task；
9. 扫描发现去重后可形成 Bug 候选；
10. Agent 完成记录包含真实模型、时间和证据，且不能绕过验证门禁；
11. Node 测试、API/MCP 合同测试、浏览器交互测试和真实截图验收全部通过；
12. 文档中的状态在每个实施批次结束后同步更新，规划本身成为 Lifeline 的第一份正式排期样本。

## 16. 建议的首次执行边界

Luna 第一次只执行 `LF-PV2-001` 到 `LF-PV2-005`：先把真实数据、旧数据迁移和“一次后永久消失”做正确。这个批次完成后，首页即能展示三个真实项目和本文排期，用户可以先确认数据效果，再进入抽屉与大板交互改造。

每完成一个 Task，Luna 应回报：

- 修改了什么；
- 使用的模型/能力档和推理强度；
- 开始、结束与耗时；
- 测试、截图或 commit 证据；
- 新发现的 Bug 或后续 Task；
- 是否改变本文件中的依赖、顺序或状态。
