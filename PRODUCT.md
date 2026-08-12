# Lifeline Product Direction

## Product promise

**把有限算力持续投向最值得推进的项目，让一个人也能稳定指挥多个 AI Agent。**

Lifeline 不是传统团队项目管理工具，而是面向一个项目所有者、多项目和多个 AI Agent 的自治推进控制平面。用户首先需要看清正在推进什么、下一步该投给谁、为什么这样排，以及哪些项目已经停滞。

## Primary user

- 同时推进多个软件或知识项目的个人项目所有者。
- 日常使用 Codex、Luna Worker 等多个 Agent 和不同等级算力。
- 希望减少手工排期、重复汇报和模型选择，把注意力留给优先级、异常和最终验收。

## Core product model

- 信息结构永远保持 `Project → Phase → Task`，不增加第三层。
- 普通任务使用 `NOW → NEXT → RESERVE → BACKLOG` 动态批次；`scheduledFor` 只表示真实硬期限。
- AI 可以创建、重排、推迟、取消、恢复、领取和推进任务，但所有变更必须可解释、可审计、可撤销。
- Agent 默认只需一次完成上报；不记录内部思考和无价值的细碎步骤。
- 执行 Agent 的结果进入 REVIEW，确定性测试、独立复核或用户批准后才算 VERIFIED。

## Visual direction

- 延续现有深色控制平面、薄荷绿色状态光和 3D Lifeline 标志，不重做品牌世界。
- 第一屏的视觉重点是 3D 标志、真实推进状态和三路调度建议。
- 项目是稳定的承载层，任务是可移动的执行单元；两者不能使用相同视觉重量。
- 信息密度服务于快速决策，正文不低于 12px、任务标题不低于 14px。
- 动效只用于状态改变与空间关系，120–180ms，并尊重 `prefers-reduced-motion`。

## Product voice

- 首页 Slogan：**榨干每一滴算力，谁都别下班。**
- 项目详情 Slogan：**别让你的野心，最后只活在待办事项里。**
- 文案要有推进感和控制感，不写成说明书，也不伪造精确结论。

## V3 boundaries

本期建设：派生健康度、动态调度、原子领取与租约、一次完成上报、独立复核、效率指标、调度解释与稳定大板。

本期不建设：多人评论通知、强制 Sprint、完整 Gantt、任意自定义字段、内部思考轨迹，以及 React、PostgreSQL、Temporal 迁移。
