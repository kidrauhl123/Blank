# AIbanking / BankPilot

BankPilot 是为“银行 AI 智能体”赛题构建的可运行 PWA 沙箱银行。银行 APP 的可见页面助手复用 Deep Agents SDK；现有业务工作流与 QQ、企业微信使用 LangGraph。两种助手共用银行核心，身份、策略、授权和账本操作由银行核心控制。

项目不预置客户、余额、卡片、交易、订阅或理财产品。每位测试者自行注册，账户从 `¥0.00` 开始；数据只由入金、转账、开卡等已认证操作产生。

## 已实现能力

- 多用户注册、登录、数据库会话、登录失败锁定和严格数据隔离
- 用户主动入金、注册用户间转账、原子双分录账本和幂等操作编号
- 绿色查询、黄色明确确认、红色 TOTP 多因素认证和三次失败熔断
- 虚拟卡申请、卡片锁定、真实流水与基于已有流水的账单分析
- 官方内置 Agent：LangGraph 持久化工作流、大模型结构化意图与计划、授权中断及恢复
- APP 可见代操作原型：悬浮对话、当前页面上下文、助手光标/高亮、逐字填表、步骤条、明确许可后导航/填写、用户干预即暂停、重新观察后继续、选择题与自由回答
- 腾讯渠道：QQ 官方机器人与企业微信长连接、一次性账户绑定、黄色按钮确认、红色回 APP 强验证
- 外部 Agent：Streamable HTTP MCP、逐令牌 scope、30 天有效期、撤销和调用审计
- 开发者接入中心、安全中心、用户审计台和 PWA 安装能力
- 理财产品表只接受带原始来源和核验时间的记录；无可靠数据时返回空数组

## 统一的 Agent 运行时

银行 APP 是比赛的主体验。页面助手的调用循环、上下文与 Skills 加载使用 Deep Agents SDK，其持久化与中断建立在 LangGraph 上；团队实现页面适配、接管与暂停、银行授权边界。QQ 与企业微信继续接入现有 LangGraph 业务 Runtime，目前没有复用页面助手的对话线程。所有业务入口共用 `Bank Core`。受控 MCP / REST 是独立的银行工具适配接口，不提供另一套托管 Agent 运行时。

页面助手是已接入主银行页面及业务弹窗的原型，不代表 APP 所有路由、六类赛题业务或真实模型评测已完成。模型必须支持工具调用。基座选型、验证范围与已知风险见 [可见页面助手](docs/VISIBLE_APP_AGENT.md)。

外部 Agent 的安全边界：

1. 用户登录银行 APP，在“个人中心 → 连接外部 Agent”中创建最小权限令牌。
2. Agent 连接 `https://<你的域名>/api/mcp`，使用 `Authorization: Bearer bpt_...`。
3. MCP 服务器只注册令牌 scope 允许的工具。
4. `banking.transfers.prepare` 只创建草稿并返回 `authorizationUrl`，不会扣款。
5. 用户回到银行 APP 完成黄色确认或红色 TOTP；账本成功后 Agent 再查询状态。

更完整的工具、客户端配置和威胁边界见 [MCP 接入文档](docs/MCP.md)。

## 本地运行

要求 Node.js 22、PostgreSQL 17 和 `docker-compose`。

```bash
cp .env.example .env.local
# 为 PASSWORD_PEPPER 生成独立随机值，例如：openssl rand -hex 32
npm install
npm run db:setup
npm run dev
```

打开 `http://localhost:3000`。首次运行没有任何业务数据，请注册两个不同用户，用其中一个入金，再通过姓名或手机号向另一个用户转账。

仅验证页面交互时可直接打开 `http://localhost:3000/preview/agent`，无需配置数据库或模型。此页面明确标注预设流程，提供转账填表和虚拟卡申请的交互演示，不调用银行 API，不代表真实模型验收。

数据库迁移由 `schema_migrations` 记录，每个文件只执行一次。`002_identity_and_platform.sql` 会在旧原型首次升级时清除旧版预置数据；已升级环境不会再次执行。

QQ 与企业微信机器人均为可选独立进程。接入方式见 [QQ 接入文档](docs/QQ.md)和[企业微信接入文档](docs/WECOM.md)。

## AI 配置

内置 Agent 只在以下变量全部存在时启用：

```env
AI_BASE_URL=https://your-openai-compatible-provider.example/v1
AI_API_KEY=...
AI_MODEL=...
AI_TIMEOUT_MS=30000
```

未配置模型时，界面明确显示“真实 AI 模型未配置”，服务端返回错误；不会用关键词匹配或写死回复伪装 AI。

## 验证

```bash
npm run build
npm test
npm run lint
npm run db:verify
```

`db:verify` 检查账本平衡、客户余额非负、操作编号唯一、客户凭据完整和系统账户归属。

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [可见页面助手与通用 Agent 复用](docs/VISIBLE_APP_AGENT.md)
- [开发与参赛计划](docs/ROADMAP.md)
- [MCP 与外部 Agent 接入](docs/MCP.md)
- [企业微信智能机器人接入](docs/WECOM.md)
- [QQ 官方机器人接入](docs/QQ.md)
- [安全设计与已知风险](docs/SECURITY.md)
- [部署说明](docs/DEPLOYMENT.md)
- [验收脚本](docs/DEMO_SCRIPT.md)

项目仓库：[kidrauhl123/AIbanking](https://github.com/kidrauhl123/AIbanking)
