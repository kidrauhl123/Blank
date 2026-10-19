# 外部接入退役

2026-10-11。银行智能体通过 APP 和银行运营的 QQ/企业微信渠道提供服务，取消向任意外部 Agent 发布银行工具的入口。

## 应用边界

- 删除 `/api/mcp`、`/api/openapi`、`/developers` 和 `/api/v1/developer/tokens`（含单令牌路径），删除实现、界面及 MCP SDK 直接依赖。旧路径返回 404。
- 删除客户 API 令牌签发、scope 和验证分支；银行接口仅从会话读取客户身份。任何 Authorization 头，包括空值、Basic、旧令牌、内部适配令牌及与有效 Cookie 混用，均返回 403，不回落到 Cookie。
- APP 写请求须有完整且精确匹配的 Origin。以 `BANKPILOT_PUBLIC_URL` 为准，本机未配置时使用请求 URL；不信任 Host 或 x-forwarded-host，不允许 Bearer 豁免。GET/HEAD 可缺 Origin，账户查询仍要求会话。
- QQ/企微 Worker 的独立适配认证、模型出站密钥保留；绑定确认仍要求 APP 会话及同源请求。删除外部接口不代表官方渠道已完成平台联调。

## 数据升级

`013_retire_external_access.sql` 在事务中撤销全部客户令牌、过期有效期、撤销全部客户端，然后重命名为 `retired_api_tokens` / `retired_api_clients`。撤销约束防止归档表新增有效凭据。`mcp_invocations` 改名为 `external_access_history`，外键随表重命名保留；审计台按客户读取历史并标明已退役。

历史 MCP 运行中/等待确认任务取消，线程关闭。渠道 CHECK 使用 NOT VALID 保留已有历史行，同时拒绝新 MCP 线程或运行记录。不会把历史来源改写成 APP，也不清除 checkpoint、会话、客户、资金或交易。归档记录不提供业务接入能力。

历史 002/009 迁移保留，新安装按顺序执行至 013；不要重新运行已执行的 002。013 可重复执行。发布必须在旧应用停止后执行迁移，防止旧代码读取已改名的表。

## 验证

单元测试覆盖会话/Authorization 边界和完整 Origin 比对；真实服务器检查旧入口及拒绝外部凭据。独立数据库测试从 012 升级，种入凭据、调用历史、MCP 任务、会话和双分录，检查撤销、关联、银行数据不变、重跑及新有效凭据/退休渠道拒绝。全量银行和页面回归继续运行。

自动发布先备份，再构建、停旧应用、执行迁移、启动；检查银行不变量、013 与旧表消失、退休路由 404、外部凭据拒绝、数据库和 Agent 健康，通过后才写 DEPLOYED_COMMIT。

本批完整回归：独立 PostgreSQL 上 126 项 Vitest 全通过、无跳过；Chrome 36 项通过（包括真实银行会话与 API），lint、TypeScript / 生产构建、发布 stdin 回归检查通过。模型替身检查不计为真实模型全场景完成率。

授权参数绑定、黄色草稿期限、TOTP 时间步消费、客户级认证失败熔断和模型事实校验随后续批次实现，并已随 `2a56ca3` 部署；见 [授权补强](AUTHORIZATION_HARDENING.md)。本次缩小入口并收敛身份边界，不将此描述为完整银行安全验收。
