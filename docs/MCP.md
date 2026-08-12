# Lifeline MCP 与 Codex 接入

Lifeline 同时提供本地 stdio 与局域网 Streamable HTTP MCP，让 Codex 或其他 Agent 在实现复杂需求前把功能拆成 `Project → Phase → Task` 写入同一块项目大板，并通过动态批次完成领取、一次结果上报和独立复核。

## Codex 如何自动判断

项目根目录的 [`AGENTS.md`](../AGENTS.md) 定义了判断边界：

- 多个可独立验收的功能点，或会明显调整既有排期：先查项目和排期，再调用 `lifeline_sync_plan`；
- 单步小修、只读问答、探索性诊断和实现细节：默认不入板，避免任务噪声；
- 同一目标恢复或微调时复用稳定 `planId`，不会重复创建 Phase/Task；
- 周期扫描发现先调用 `lifeline_propose_scan_finding`，稳定指纹会去重；只有 `lifeline_review_scan_proposal` 接受后才进入正式排期；
- 自治执行先调用 `lifeline_claim_next_task`，领取即开始握手；默认只在工作结束时调用一次 `lifeline_submit_completion`。`lifeline_start_task` 仅保留给本机 stdio 兼容流程；
- Agent 上报只能进入 `REVIEW`。只有通过确定性测试或不同 actor 的独立复核，才允许调用 `lifeline_verify_task` 进入 `VERIFIED`。

主 Agent 仍负责判断是否需要排期，不需要用户在每条提示词里明确要求调用 MCP。

## Codex 配置与生效

项目已包含 [`.codex/config.toml`](../.codex/config.toml)：

```toml
[mcp_servers.lifeline]
command = "docker"
args = ["compose", "exec", "-T", "-e", "LIFELINE_LOCAL_USER_ID=local-owner", "-e", "LIFELINE_MCP_CLIENT_NAME=codex", "lifeline", "node", "src/mcp-server.js"]
required = false
startup_timeout_sec = 15
tool_timeout_sec = 60
default_tools_approval_mode = "writes"
```

首次使用：

```bash
npm install
codex mcp list
```

Codex 只会为已信任项目加载项目级配置。新增或修改 MCP 配置后，新开一个 Codex 对话即可加载；如果桌面应用仍沿用旧进程状态，再重启应用。CLI、IDE 扩展和桌面应用共享 Codex 配置语义。配置字段以 [OpenAI Codex MCP 文档](https://developers.openai.com/codex/mcp/) 和 [配置参考](https://developers.openai.com/codex/config-reference/) 为准。

`required = false` 避免本地依赖缺失时阻断整个 Codex 会话；`default_tools_approval_mode = "writes"` 让只读查询顺畅执行，同时把持久化写入保留在写操作审批边界内。

## Resources

```text
lifeline://portfolio
lifeline://portfolio/dispatch
lifeline://projects/{projectId}
lifeline://projects/{projectId}/schedule
lifeline://tasks/{taskId}
lifeline://runs/{runId}
```

## Tools

| Tool | 用途 |
|---|---|
| `lifeline_get_dispatch_board` | 查询项目健康度、NOW/NEXT/RESERVE/BACKLOG、容量与结构化原因 |
| `lifeline_list_projects` | 选择真实项目，避免按名称猜测 |
| `lifeline_get_schedule` | 读取有序 Phase/Task、运行和完成状态 |
| `lifeline_get_task` | 查询执行契约、Run、Evidence、CompletionRecord 和审计 |
| `lifeline_create_project` | 幂等创建项目 |
| `lifeline_create_phase` | 幂等创建阶段 |
| `lifeline_update_phase` | 按 `expectedScheduleVersion` 修改阶段标题或描述 |
| `lifeline_create_task` | 在指定阶段创建一项完整任务契约 |
| `lifeline_list_scan_proposals` | 按项目和复核状态查询扫描提案 |
| `lifeline_propose_scan_finding` | 以稳定指纹提交扫描发现，重复发现只累计次数、不创建任务 |
| `lifeline_review_scan_proposal` | 接受提案并生成正式 Bug Task，或驳回并保留审计原因 |
| `lifeline_update_task` | 按 `expectedScheduleVersion` 编辑未执行任务、调整所属阶段，或用 `status=DEFERRED/PLANNED` + `reason` 推迟/恢复；锁定历史仅允许单独更新 Issue 引用 |
| `lifeline_reorder_tasks` | 原子替换一个 Phase 内所有可移动任务的顺序 |
| `lifeline_cancel_task` | 将未执行任务移出活跃排期并保留取消原因与审计记录 |
| `lifeline_restore_task` | 将已取消任务恢复为 PLANNED，并保留取消与恢复两段审计 |
| `lifeline_sync_plan` | 用稳定 `planId` 一次同步一个 Phase 和多项有序 Task |
| `lifeline_claim_next_task` | 原子领取一个 NEXT 执行/复核任务，同时创建 Run 与限时租约 |
| `lifeline_extend_task_lease` | 只在必要时延长仍有效的租约，最长不超过 8 小时 |
| `lifeline_start_task` | 仅本机 stdio 兼容：建立持久 Agent Run；局域网 Agent 必须使用原子领取 |
| `lifeline_submit_completion` | 一次写入真实起止时间、模型、结果和证据；完成进入 `REVIEW`，失败或阻塞如实记录 |
| `lifeline_verify_task` | 通过确定性测试或独立复核后进入 `VERIFIED`；`HUMAN_APPROVAL` 仅允许本机项目所有者 |

所有写工具要求 `idempotencyKey`；编辑、排序和取消还要求先读取并回传 `expectedScheduleVersion`，旧版本写入会返回冲突而不是静默覆盖。MCP 返回 `structuredContent`，同时保留 JSON text 兼容旧 Host。

本机 stdio 为兼容既有工作流，在没有 Run 时仍可一次性上报，并由 `startedAt` 与 `completedAt` 推导耗时。局域网 scoped MCP 必须先用 `lifeline_claim_next_task` 取得执行或复核租约：不能用旧的 `lifeline_start_task`、无领取 completion 或无领取 verification 绕过容量与并发门禁；服务端记录领取、延长和已领取任务的完成时间。失败、阻塞或周期任务下一次上报会建立新的 Run，不会复用已经终止的尝试。

Task 可选传入 `dependsOnTaskIds` 和 `parallelPolicy`（`AUTO`、`SEQUENTIAL`、`PARALLEL_ALLOWED`）。依赖必须属于同一项目、位于当前 Task 之前且保持无环；前置任务未完成时不能进入执行，仍被其他活跃任务依赖的 Task 也不能取消。界面从同一依赖图推导每个 Phase 的可并行槽位，不增加第三层业务结构。`issue` 仍是独立的可空关联字段，不影响依赖、验收或其他任务字段。

`lifeline_get_schedule` 会在每个 Phase 返回 `parallelTaskIds`：仅包含 `PLANNED`/`READY`、前置依赖已完成且未声明 `SEQUENTIAL` 的 Task。它是主 Agent 判断并行开发的候选提示，不会强制调用子代理；主 Agent 仍需确认任务边界、文件范围和并发槽位，再自行决定是否委派 `luna_worker`。

## 数据与并发边界

Web UI 和 MCP 都进入同一个 `LifelineService`，不复制状态机或证据规则。项目 MCP 在正式 Compose 容器内启动，因此与 Web UI 共同读写 `/app/data/lifeline.json` 对应的持久卷；`JsonStore` 使用跨进程锁、每次 mutation 前重新载入和原子替换，避免旧内存快照覆盖另一个进程刚写入的数据。修改此配置后需新开 Codex 对话，让 Host 重新载入 MCP 启动命令。

stdio 仍是本机单用户边界，身份来自 `LIFELINE_LOCAL_USER_ID`。V3 另提供 `http://<主机>:8019/mcp`，使用本地 Bearer Agent Token，并按 `portfolio:read`、`schedule:write`、`task:claim`、`completion:write`、`verification:write` 限权。没有配置令牌时端点返回 503，不允许匿名降级；错误 Host、外部 Origin 和缺少 scope 的操作都会拒绝。

创建或轮换局域网令牌：

```bash
npm run agent-token -- --client-id codex-executor --scopes portfolio:read,task:claim,completion:write
npm run agent-token -- --client-id codex-reviewer --scopes portfolio:read,task:claim,verification:write
npm run agent-token -- --client-id codex-scheduler --scopes portfolio:read,schedule:write
# 轮换时保持原 scope：npm run agent-token -- --client-id codex-executor --scopes portfolio:read,task:claim,completion:write --rotate
docker compose up -d --build lifeline
```

令牌存放在 Git 忽略且权限为 `0600` 的 `.env`，生成命令不会输出令牌值；每条令牌绑定唯一 `clientId`，请求体不能冒充其他 Agent，因此执行者和复核者可以保持独立。当前仍是一个项目所有者的局域网令牌集合；公网 HTTPS、多用户 OAuth 与跨用户数据隔离没有伪装成已完成能力。完整策略与恢复步骤见 [自治推进策略与恢复手册](AUTONOMOUS_BOARD_OPERATIONS.md)。

## 手动启动与验证

其他 stdio Host 可执行：

```bash
npm run mcp
```

MCP 协议只能写 stdout；启动信息和错误写 stderr。完整校验：

```bash
npm run check
```

测试覆盖现代 `2026-07-28` discover、旧版 Host、stdio/Streamable HTTP、Bearer 与 scope、Resources/Tools、重复 plan 同步、扫描指纹去重与复核门禁、版本化编辑与排序、取消/恢复审计、并发原子领取、租约过期、Completion 停在 REVIEW、独立复核和验证后进度更新。
