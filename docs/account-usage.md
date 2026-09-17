# 账号用量与额度

控制台「上游账号」为每个账号展示官方月度余额、充值余额、5 小时和每周窗口已用/上限/剩余及重置时间。额度池可能重叠，不相加；未知字段显示「未提供」，月度总配额未确认时不推算月度已用金额。

## 授权

1. 在 https://commandcode.ai/ 登录对应账号，进入用量或账单页。
2. 浏览器开发者工具 Network 中找到 `billing/credits` 请求，复制请求头 Cookie 值。
3. 在自己的控制台「上游账号 → 对应账号 → 用量授权」输入并确认账号归属。不要通过聊天、日志或仓库传递 Cookie。

官网会话与推理凭据分别授权，不能自动校验两者账号归属。应由管理员核对登录账号后绑定。服务只保存 `better-auth.session_token`（含 `__Secure-` 变体），使用现有主密钥 AES-GCM 加密，独立上下文绑定账号 ID；API 不回传会话。更换上游凭据、删除账号或移除授权时清除会话和缓存。

页面可见时每五分钟刷新，手动刷新受一分钟缓存限制。官方失败时保留旧值并显示异常及更新时间，不影响推理健康和调度。订阅信息不可用时仍展示成功取得的余额。会话到期后需重新授权。

## 接口与存储

- `PUT /command/api/upstreams/:id/billing/session`：`{ cookie, confirm_account: true }`
- `DELETE /command/api/upstreams/:id/billing/session`
- `POST /command/api/upstreams/:id/billing/refresh`

接口沿用管理员会话与 CSRF 校验。新增 `billing_sessions` 表，旧账号无需重新创建。官方数据源为 `/internal/billing/credits` 和 `/internal/billing/subscriptions`；属于内部接口，可能随上游调整。

实际网页登录授权后的端到端显示仍需验收；本地检查使用模拟账单，禁止把生产凭据导出到本地。
