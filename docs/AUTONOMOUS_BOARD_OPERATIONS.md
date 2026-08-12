# Lifeline 自治推进策略与恢复手册

本文是 V3 自治大板的运行契约。页面、REST 与 MCP 都使用 `src/autonomous-board.js` 中的同一套派生规则，不维护第二份“看起来正确”的状态。

## 动态批次与健康度

- `NOW`：已有真实 Run 或独立复核租约正在占用槽位。
- `NEXT`：契约完整、依赖满足并落入当前容量的下一批任务。
- `RESERVE`：任务可执行，但同项目或对应算力/复核槽已经占满。
- `BACKLOG`：已推迟、阻塞、依赖不满足、契约不完整或尚不应进入近期容量的任务。

默认容量为高算力 1、中算力 1、低算力 2、独立复核 1。同一项目默认只有 1 个改动任务运行；只有任务明确声明 `PARALLEL_ALLOWED` 且 Agent 自行确认没有文件冲突时才突破。

阶段状态从任务派生。项目健康度使用真实 Run、验证记录、依赖和时间判断：REVIEW 超过 24 小时为 `AT_RISK`，有开放任务且 72 小时没有真实推进为 `STALLED`。修改标题或排期不会伪装成真实推进。

## Agent 正常路径

```text
读取 dispatch board
→ 原子领取 NEXT（创建 Run + ClaimLease）
→ 只在最终结果时提交一次 completion
→ 任务进入 REVIEW
→ 不同 Agent 领取复核槽
→ 根据测试、独立审查或用户批准验证
→ VERIFIED 后容量自动补位
```

领取就是唯一必要的开始握手，不要求心跳，也不记录内部思考。领取、延长及已领取任务的完成时间由 Lifeline 服务端写入，远程 Agent 不能通过回填旧时间绕过租约；令牌身份也会绑定到执行、完成和复核记录。租约默认 `max(30 分钟, 预计耗时 × 2)`，最长 8 小时；只有长任务确有需要时才延长。

## 租约和失败恢复

- 租约到期：旧 Run 记为 `CANCELLED`，不制造失败；任务安全回到 `READY`，下一次派生进入 NEXT。
- 迟到结果：原 Agent 的过期 Run 不能覆盖新领取者的状态。
- Agent 报告失败或阻塞：保留证据并进入 `BLOCKED`，不会伪造完成。
- 取消任务：从活跃排期隐藏，但保留取消原因、前后版本和审计事件。
- 恢复任务：调用 `POST /api/work-items/:id/restore` 或 `lifeline_restore_task`；页面“为什么这样排”也提供恢复入口。
- 推迟/恢复近期推进：通过 `PATCH /api/work-items/:id` 或 `lifeline_update_task` 在 `DEFERRED` 与 `PLANNED` 间切换，并提交 `reason`；解释视图可直接撤销最近一次推迟。
- 阶段漂移：调用 `POST /api/portfolio/rebalance`，任务全部完成的阶段会校正为完成；所有变化保留规则版本和前后值。

## 局域网 Streamable HTTP MCP

服务提供单一端点：`http://<Lifeline 主机>:8019/mcp`。它默认关闭；没有配置令牌时返回 `503 MCP_TOKEN_NOT_CONFIGURED`，不会退化成匿名访问。

为执行 Agent 与复核 Agent 分别创建令牌，保证独立复核身份真实可区分：

```bash
npm run agent-token -- --client-id codex-executor --scopes portfolio:read,task:claim,completion:write
npm run agent-token -- --client-id codex-reviewer --scopes portfolio:read,task:claim,verification:write
npm run agent-token -- --client-id codex-scheduler --scopes portfolio:read,schedule:write
docker compose up -d --build lifeline
```

令牌只写入被 Git 忽略的 `.env`，权限为 `0600`，命令不会把值打印到终端。需要轮换时运行：

```bash
npm run agent-token -- --client-id codex-executor --scopes portfolio:read,task:claim,completion:write --rotate
docker compose up -d lifeline
```

已有 `clientId` 使用 `--rotate` 且不传 `--scopes` 时会保留原权限，避免轮换意外扩权。

每条令牌绑定唯一 `clientId`。Agent 客户端通过 `Authorization: Bearer <token>` 连接，领取、完成和验证时不能在请求体冒充其他 `agentId`。每个请求同时校验令牌、Host、Origin（存在时）与工具所需 scope：

```text
portfolio:read       读取项目、排期、任务和调度大板
schedule:write       创建、修改、重排、取消与恢复排期
task:claim           领取任务与延长租约
completion:write     提交一次真实完成结果
verification:write   提交验证结果
```

局域网 scoped Agent 的执行和复核都必须先领取租约；旧的直接开始、无领取完成和无领取验证只为本机 stdio 兼容保留，不能作为远程并发旁路。
`HUMAN_APPROVAL` 只能由本机项目所有者提交；局域网 Agent Token 不能冒充人工批准。局域网自动化应只连接受令牌保护的 `/mcp`，普通 `/api/*` 是当前单一所有者网页控制平面的同源兼容接口，不作为远程 Agent 授权边界。

如需最小权限 Agent，在生成该 `clientId` 时通过 `--scopes` 明确传入；`LIFELINE_AGENT_SCOPES` 只用于兼容旧的单令牌配置。当前是单一项目所有者的局域网令牌，不是多用户 OAuth；生产公网、用户隔离和 OAuth 继续延期。不要把 `.env`、Cookie、密码或验证码提交到仓库。

## 效率指标与自动校准

只统计真实 `AGENT` Run，忽略 Mock 历史。30 天窗口按项目、任务类型、模型和算力聚合吞吐、执行/复核耗时、失败与阻塞率、重开率、估时偏差、观测忙碌时长与窗口覆盖；组合层另按执行槽总数计算饱和度。

没有真实 Run 覆盖的区间由 API 作为 `unreportedIntervals` 返回，并明确标记 `UNKNOWN_NOT_IDLE`。它能帮助识别上报断层，但不能被解释成 Agent 空闲或可用算力。

样本少于 5 个时只显示规则推荐，不调整估时或模型。即使样本达到 5 个，成功率低于 60%、失败/阻塞率高于 40% 或重开率高于 40% 的路线也不会成为模型或算力推荐。无上报区间含义固定为“未知”，不能推断为 Agent 空闲。页面只展示调度原因代码与效果，不展示内部思考。

## 发布验收顺序

1. 每个改动边界只跑对应测试。
2. 整批结束只运行一次 `npm run check`。
3. 只重建并重启一次服务。
4. 检查 `/api/health`、`/api/portfolio/dispatch` 与带令牌的 `/mcp`。
5. 用 1920×1080、1366×768、390×844 浏览器视口检查大板、详情、自动刷新、抽屉和悬浮翻转。
