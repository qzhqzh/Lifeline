# Lifeline 推进轨迹 V2 设计

## 目标

Lifeline 是任务控制平面，不是 Agent 行为监控系统。运行记录只收集能够改善排期、模型推荐和验收判断的数据；如果一个字段不能改变管理决策，就不要求 Agent 上报。

V2 用一次真实结果汇报替代 Mock Run 和逐步骤日志，并把首页“执行工作台”改为跨项目推进轨迹。

## Agent 接入契约

Agent 默认只在任务结束时调用一次 `lifeline_submit_completion`：

- `taskId`
- `outcome`: `COMPLETED`、`FAILED` 或 `BLOCKED`
- `startedAt`、`completedAt`
- `modelRef`，以及可选的 `provider`、`executor`、`reasoningEffort`
- `resultSummary`
- 可选 `evidence` 与 `artifactUris`

如果任务已经通过旧流程调用 `lifeline_start_task`，完成上报继续复用现有 Run；如果没有 Run，Lifeline 根据一次上报原子创建真实 `AGENT` Run 和 CompletionRecord。

`COMPLETED` 只把任务推进到 `REVIEW`。只有确定性测试、不同参与者的独立审查或用户批准才能进入 `VERIFIED`。`FAILED` 与 `BLOCKED` 结束本次 Run 并把任务留在 `BLOCKED`，不会产生完成进度。

不采集内部思考、工具调用流水、文件修改步骤、固定分数或模拟审查。

## 历史 Mock 数据

- 停止新增 `INTERNAL_MOCK` Run，公开队列入口返回明确的停用错误。
- 历史 Run、Event、Evidence 原样保留，标记为历史演示数据。
- Mock Evidence 不贡献项目进度，不进入推进轨迹。
- 仅由 Mock Run 推进且没有真实 CompletionRecord 的任务不再作为项目最新完成节点。
- 不静默删除历史数据。

## 推进轨迹

轨迹来自真实 `AGENT` CompletionRecord 的 `startedAt` 与 `completedAt`，支持 24 小时、7 天和 30 天窗口。

首页展示：

- 按项目分行的任务时间区间；
- 完成、失败、阻塞和待复核状态；
- 并发峰值、完成任务数、推进覆盖率；
- 没有真实记录的时间标为“未记录推进”，不推断用户空闲；
- 点击任务后打开详情抽屉，结果摘要优先，模型、时间、证据和产物折叠展示。

推进覆盖率定义为时间窗口内至少存在一个真实任务区间的时长除以窗口时长。只有以后配置可用并发槽位，才计算“算力饱和度”，避免使用没有分母的伪指标。

## 管理收益

- 用真实耗时校准任务估时；
- 比较任务类型、风险与模型的结果，修正模型推荐；
- 发现长期未记录推进的项目与排期空档；
- 识别并发不足或项目切换过于频繁；
- 衡量完成到验证之间的等待时间，定位验收瓶颈。

## 验收边界

- Agent 新接入只需一次结果汇报；
- 不再生成新的 Mock Run；
- Agent 自报完成不能自动验证；
- 轨迹统计只使用真实、带起止时间的 Agent 结果；
- 页面不再展示 Mock step 和固定证据得分；
- 旧 API 保持兼容，历史数据保留可审计。
