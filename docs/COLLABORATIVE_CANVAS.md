# 客户协作画布

客户视图通过独立的 WBO 服务提供项目级实时共同绘图。Lifeline 负责项目入口、会话签发和同源代理；WBO 负责绘图工具、Socket.IO 实时同步与画布文档持久化。

## 运行

```bash
npm run canvas:secret
docker compose up -d --build
```

`canvas:secret` 只在本机 `.env` 中创建 `WBO_AUTH_SECRET_KEY`，不会输出密钥，也不会覆盖已有的有效值。正式入口为 `/canvas.html?project=<projectId>`；浏览器只通过 Lifeline 的 `/whiteboard/*` 同源代理访问 WBO，WBO 不暴露宿主机端口。

## 数据与权限边界

- 每个 Lifeline Project 对应一个 `lf-<project uuid>` 画布。
- 会话 JWT 仅包含该画布的 `editor:<boardId>` 角色，可打开和编辑但不能清空。
- 当前客户视图采用 `project-link` 访问模型：知道项目链接的人可以申请该项目的编辑会话。组织成员、客户身份和 RBAC 接入后，应在 `/api/projects/:id/canvas-session` 前增加同一项目授权校验。
- 正式任务状态仍只通过 `Project → Phase → Task` 链路修改；自由画布不写任务数据。
- 画布 SVG 存储在 `lifeline-whiteboard-data` 卷中，该卷需要与 `lifeline-data` 一并备份和恢复。

## 上游与许可

- 上游：[WBO / Whitebophir](https://github.com/lovasoa/whitebophir)
- 固定版本：`v2.17.0`
- 固定镜像摘要：`sha256:6a8afba36eb1e12d5c583391aa4bf1dd9a0c6618776e1fbeb13a79b51dd65b75`
- 许可：AGPL-3.0。保持 WBO 为独立服务并保留上游源码入口；修改或对外分发前应再次确认许可证义务。
