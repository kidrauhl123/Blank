# 系统架构

## 设计原则

BankPilot 将“会聊天的模型”和“能改变资金状态的银行核心”严格分开。LLM 只能提出结构化意图与计划；确定性的策略引擎决定风险；只有银行核心能在数据库事务中执行操作。

```text
APP ─ Bank Session ─┬─ 原生银行页面 ────────────────┐
                    └─ Deep Agents / LangGraph ─ 页面动作 / 人工确认
QQ / 企业微信 ─ 官方 Worker ─ LangGraph ─ interrupt() / 授权链接
                                                      │
                                      Policy + Authorization
                                                      │
                                                Bank Core
                                                      │
                              PostgreSQL / 双分录账本 / 审计
```

## 关键组件

### PWA

Next.js App Router + React。入口选择五位固定模拟用户，支持账户、流水、入金、转账、卡片、安全中心和 Agent 对话。银行接口只接受 HttpOnly SameSite Cookie 会话；写请求必须匹配正式 APP 完整 Origin，不信任转发 Host 作为来源授权。提供 Authorization 头时拒绝，不回落到 Cookie。

主页面助手通过 Deep Agents SDK 在 LangGraph 上进行页面工具循环，持久化到 `app_agent_runs`。银行动作按钮区分导航、填写、准备和本人确认；模型动作完成不是银行回执。现有 IM 业务 Runtime 如下，尚未与页面对话线程合并。

### LangGraph Agent Runtime

每个请求创建独立的 LangGraph run，并把 checkpoint 写入 PostgreSQL 的 `langgraph` schema；checkpoint 表由版本化迁移预先创建，不在客户请求中动态执行 DDL。规划节点调用真实模型，随后路由到余额、账单、订阅、转账或卡片节点。只读任务直接结束；写任务在 `authorization_gate` 调用 `interrupt()`，持久化后等待用户确认。授权完成后用同一 `graph_thread_id` 恢复，并从 Bank Core 重读最终状态，再生成回复。

模型输出通过 Zod 校验的意图、实体和步骤；银行工具返回事实后，由服务端按类型生成确定性业务回执，不再发起第二次自由文本模型调用。模型不能生成 SQL、调用任意 URL 或直接提交账本。重复授权由 runtime 原子抢占，只有一个请求能从 `INTERRUPTED` 进入 `RUNNING`。

### 腾讯消息 Channel Adapters

`/channels` 展示银行运营的 QQ 与企业微信机器人，用户添加机器人后发送“绑定”，在银行登录页面确认一次性绑定。用户不填写机器人密钥，也不连接个人微信登录态。所有已绑定消息进入同一 LangGraph Runtime。

两个独立 Node.js Worker 分别使用 QQ 和企业微信官方 SDK 建立 WebSocket 长连接。Worker 不接触数据库，只使用各自的内部适配令牌调用渠道 API；Bot Secret 不会进入 Next.js 或浏览器。首次会话发放 10 分钟一次性绑定链接，渠道 openid/userid 加密保存并以 HMAC 摘要索引。

绿色任务直接回复；黄色任务使用原生按钮确认；红色任务只发送银行 APP 深链，由银行会话和 TOTP 完成。消息按平台事件 ID 去重，异步结果经按渠道隔离的事务 outbox 重试投递。QQ 群聊不进入银行 Agent，只引导用户转到 C2C 私聊，避免账户信息在群内暴露。

### 银行内部业务接口

APP 的 `/api/v1/*` 接口服务银行页面；QQ/企微通过各自认证的内部渠道 API 调用相同 `bank-core.ts`。对外 MCP、OpenAPI、开发者页面和客户 API 令牌认证已退役，不再向任意外部 Agent 发布银行工具。

### Policy + Authorization

- GREEN：余额、流水、账单分析、卡片/订阅/理财查询，可自动执行。
- YELLOW：小额转账、虚拟卡申请、锁卡，先展示完整单据并获得明确确认。
- RED：日累计转账超过 ¥1,000，要求 TOTP 动态码。设备与跨草稿行为画像尚未落实。

模型提供的风险等级不被信任。策略裁决写入 `policy_decisions`；黄色和红色转账草稿统一为 10 分钟期限，提交前比对绑定金额、对象及期限的指纹。TOTP 在客户锁内消费时间步，认证失败使用 `mfa_auth_state` 共享预算。相关控制需执行 014；本次真实数据库与浏览器回归待完成，见 [授权补强](AUTHORIZATION_HARDENING.md)。

### Bank Core 与 PostgreSQL

金额统一使用人民币分的整数。转账事务先取得付款客户锁，再按固定顺序锁定付款与收款账户；锁等待后重算上海当日成功金额。需要升级时保存红色挑战并暂停；授权满足后写平衡借贷分录、账户快照和用户流水，失败则整体回滚。

关键数据域：

- 身份：`customers`、`auth_credentials`、`user_sessions`、`mfa_totp`、`mfa_auth_state`
- 银行业务：`accounts`、`beneficiaries`、`transfers`、`cards`、`subscriptions`
- 账本：`ledger_transactions`、`ledger_entries`、`bank_transactions`
- Agent：`agent_tasks`、`task_nodes`、`policy_decisions`
- Agent Runtime：`agent_threads`、`agent_runtime_runs`、`langgraph.*`
- 渠道：`channel_identities`、`channel_binding_tokens`、`channel_events`、`channel_outbox`
- 已退役历史：`retired_api_clients`、`retired_api_tokens`、`external_access_history`；凭据全部撤销，仅审计台查询历史调用
- 审计：`audit_events`

## 数据真实性边界

比赛入口使用五个公开共享模拟用户和标记 `DEMO_SEED` 的预置历史；后续余额、卡片和交易依据实际沙箱数据库操作返回，重新进入不重置。共享身份不等于真实客户认证。系统不连接央行清算、银联或商业银行核心，不能承载真实货币。

理财产品没有可靠来源就保持空表。未来可增加经过许可的数据采集任务，并强制保存 `source_url`、发布时间、核验时间和原始事实。
