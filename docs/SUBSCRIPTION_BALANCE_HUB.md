# 算力余量与浏览器扩展接入

Lifeline 的“算力余量”页面统一展示两个 Codex 账号，以及 Google AI Pro、Cursor、Grok 和小云雀个人订阅。个人会员没有统一公开余额 API，因此 V1 只读取当前浏览器 Profile 已登录页面中真实可见的信息。

## 安全边界

- 扩展不申请 Cookie、`webRequest` 或 `<all_urls>` 权限。
- Cookie、密码、验证码、网页 HTML 和完整接口响应不会进入 Lifeline。
- 扩展只上报规范化额度、状态、采集时间、来源页面、来源等级、可信度和适配器版本。
- 页面没有可靠总量时只上报“可用、已触顶或未知”，不会推算百分比。
- 额度页关闭后不会偷偷打开后台标签页；最后成功值会保留，超过账号的新鲜度阈值后显示“数据过期”。

## 安装扩展

1. 启动 Lifeline 并打开 `/subscriptions.html`。Docker 默认地址以实际映射端口为准，例如 `http://localhost:8019/subscriptions.html`。
2. 首次修改别名、生成配对码或从页面撤销采集器时，输入一个具有 `schedule:write` 权限的 Lifeline Agent Token；令牌只保存在当前标签会话的 `sessionStorage`，关闭标签后失效。
3. 在 Chrome 打开 `chrome://extensions`，启用“开发者模式”。
4. 选择“加载已解压的扩展程序”，选择仓库中的 `extension/` 目录。
5. 在余额页面找到要连接的账号，点击“生成配对码”。
6. 打开扩展，填写本机 Lifeline 地址、当前浏览器 Profile 名称和配对码。
7. 打开该账号对应的额度页。扩展会立即读取一次，页面内容变化时重新读取，并在页面保持打开时每 5 分钟复查。

配对码只绑定一个 Lifeline 订阅账号、只能使用一次，并在 10 分钟后过期。采集器令牌保存在当前 Chrome Profile 的扩展存储中，可从余额页面或扩展弹窗撤销。

创建管理令牌：

```bash
npm run agent-token -- --client-id browser-owner --scopes portfolio:read,schedule:write
docker compose up -d --build lifeline
```

令牌值保存在 Git 忽略且权限为 `0600` 的 `.env` 中。管理写接口同时要求同源页面、Bearer Token 和 `schedule:write`；局域网内仅伪造 Host/Origin 不能生成配对码或修改账号。

### 局域网部署

- 填写实际 Lifeline 私网地址；Compose 的 8019 与兼容入口 41000 均映射到容器内 3000 端口和同一份数据。只填写 IP 时，扩展会自动补全 HTTP 和 8019 端口。
- 首次连接非本机地址时，Chrome 会要求按目标 host 授权；拒绝授权不会保存连接，可再次提交重试。
- 扩展弹窗会实际请求 `/api/health` 和账号状态，分别显示“服务不可达”“配对已失效”“等待打开额度页”“最近同步”或“上报失败”；本地保存过配置不再等同于连接成功。
- Lifeline 的局域网 IP 改变时直接填写新地址并完成新的 host 授权，不再需要修改 Manifest；只有扩展代码更新后才需要在 `chrome://extensions` 中重新加载。

## 两个 Codex 账号

两个 Codex 登录态必须放在两个独立 Chrome Profile：

1. 在 Profile A 加载扩展，为“Codex 账号 A”生成并输入配对码。
2. 在 Profile B 加载扩展，为“Codex 账号 B”生成并输入另一个配对码。
3. 分别打开各自登录态下的 Codex Usage 页面。
4. 在 Lifeline 中把默认别名修改为容易识别的名称。

同一个 Profile 内同一平台只保留一条激活连接，从而避免两个账号互相覆盖。

## 平台入口

| 平台 | 默认入口 | 可量化内容 |
|---|---|---|
| Codex | `https://chatgpt.com/codex/settings/usage` | 页面明确给出的 5 小时、每周剩余比例，以及套餐额度耗尽后使用的额外 Credits |
| Google AI Pro | `https://gemini.google.com/app` | Usage limits 中明确给出的窗口、比例或限制状态 |
| Cursor | `https://cursor.com/dashboard?tab=usage` | Cursor Models 与 Other Models 两个独立池 |
| Grok | `https://grok.com/settings` | 账户设置页给出的可用、接近上限、触顶和重置信息；普通聊天页不会采集 |
| 小云雀 | `https://xyq.jianying.com/home?tab_name=home` | V1 仅确认页面与会员可用状态；积分数字需完成精确额度组件校准后才展示 |

平台页面结构会变化。数据源按“官方接口 → 官方结构化页面 → 精确页面组件 → 页面状态 → 未验证”分级。只有前三类且可信度为高或中时才展示数字并进入低余额判断；历史无来源数字保留用于审计，但显示为“数值待校准”。解析异常时保留上一次成功值。

Codex 的 Credits 是套餐包含额度用完后的附加余额，`0 Credits` 不等于 Codex 订阅不可用。小云雀不再从整页文本中模糊寻找第一个数字，避免把活动积分、作品数量或隐藏内容误报成当前余额。

## 数据与故障排查

- 首页顶栏显示可用账号数和需要关注的账号数，不合并不同单位。
- 独立页面每 10 秒刷新 Lifeline 中已经收到的结果，但不会因此主动访问第三方网站。
- 最新精确快照单独保存；历史按账号、每小时保留最后一条成功记录，自动清理 90 天以前的数据。
- “未配对”：服务端没有有效采集器；需要重新生成配对码。
- “等待额度页”：配对有效，但服务端还没有收到该 Profile 的第一次上报。
- “数据过期”：最后一次成功采集超过 30～45 分钟；重新打开对应额度页。
- “采集异常”：页面已变化或无法识别；旧余额仍然保留，可检查扩展弹窗、登录状态和来源页面。
- “已触顶”：平台页面明确出现达到使用上限的提示，不代表其他平台或其他额度池也不可用。
