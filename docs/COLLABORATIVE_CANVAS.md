# 客户协作画布

客户视图通过独立的 WBO 服务提供项目级实时共同绘图。Lifeline 负责项目入口、会话签发和同源代理；WBO 负责绘图工具、Socket.IO 实时同步与画布文档持久化。

## 运行

```bash
npm run canvas:secret
docker compose up -d --build
```

`canvas:secret` 只在本机 `.env` 中创建 `WBO_AUTH_SECRET_KEY`，不会输出密钥，也不会覆盖已有的有效值。正式入口为 `/canvas.html?project=<projectId>`；浏览器只通过 Lifeline 的 `/whiteboard/*` 同源代理访问 WBO，WBO 不暴露宿主机端口。项目所有者可在画布右上角的“项目对象 → 共享访问”生成一次性可复制的共享链接。

## 数据与权限边界

- 每个 Lifeline Project 对应一个 `lf-<project uuid>` 画布。
- 项目共享采用 `project-rbac`：`VIEWER / EDITOR / MANAGER / OWNER` 映射为明确 capability；令牌只在创建时返回一次，持久层仅保存 SHA-256 哈希，并支持过期与撤销。
- 未启用共享的旧项目保持兼容；项目创建第一条 grant 后，非本机访问必须携带该项目的有效 Bearer token。URL 中的 `access` 只用于首次打开，前端随即放入 `sessionStorage` 并从地址栏移除。
- WBO 对同一可写 board 的 reader 角色不能提供可靠只读隔离，因此 `VIEWER` 只查看正式项目进度和测试地图，不能申请画布会话。`EDITOR` 及以上的会话 JWT 仅包含 `editor:<boardId>`，可编辑但不能清空；默认寿命一小时，上限两小时。
- 项目对象抽屉只返回客户安全投影。Phase/Task 可形成持久 binding，并复制带回链的引用到画布。
- 自由画布不能直接改正式任务状态。参与者提交 `canvasChangeProposal`，`MANAGER/OWNER` 接受后才通过现有 client-board command、`scheduleVersion` 和幂等键修改 `Project → Phase → Task`；冲突会拒绝而不是静默覆盖。
- grant 创建/撤销、会话签发、对象绑定、提议创建和评审均写入 Lifeline 审计事件。
- 画布 SVG 存储在 `lifeline-whiteboard-data` 卷中，该卷需要与 `lifeline-data` 一并备份和恢复。

当前产品仍以带原子写入和文件锁的 JSON store 为正式持久层；RBAC、binding 与 proposal 作为 schema v8 集合随 `lifeline-data` 备份。迁移到 PostgreSQL 是容量与多节点部署决策，不再作为这条协作链路的功能阻塞项。

## 上游与许可

- 上游：[WBO / Whitebophir](https://github.com/lovasoa/whitebophir)
- 固定版本：`v2.17.0`
- 固定镜像摘要：`sha256:6a8afba36eb1e12d5c583391aa4bf1dd9a0c6618776e1fbeb13a79b51dd65b75`
- 许可：AGPL-3.0。保持 WBO 为独立服务并保留上游源码入口；修改或对外分发前应再次确认许可证义务。
