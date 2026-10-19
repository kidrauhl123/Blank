# AIbanking / BankPilot

BankPilot 是为“银行 AI 智能体”赛题构建的可运行 PWA 沙箱银行。银行 APP 的可见页面助手复用 Deep Agents SDK；现有业务工作流与 QQ、企业微信使用 LangGraph。两种助手共用银行核心，身份、策略、授权和账本操作由银行核心控制。

比赛入口只有五位模拟用户：小土豆、小板栗、小苹果、小西瓜、小橘子。点击头像直接进入，无需注册或密码。五位用户拥有预置余额、历史账单、卡片、订阅和互相转账记录；访客共享这些模拟账户。

线上演示：<https://bank.jung.edu.pl>。当前 `main`（`2a56ca3` 之后）已在 `CONTABO-jp` 运行，部署与发布记录见 [部署](docs/DEPLOYMENT.md)。

界面只有手机形态：所有产品页面渲染在同一块 430px 宽的画布内，宽视口下画布浮在桌面上，鼠标指针等同手指（只用按下反馈，不用 hover）。见 [UI 重构](docs/UI_REFACTOR_PLAN.md) 与 [设计系统](docs/DESIGN_SYSTEM.md)。

历史数据标记 `DEMO_SEED` 并记录双分录；初始化仅执行一次，重新进入不重置用户操作。会话归属、业务确认、强验证和审计仍保留，旧账户与数据不会被清空。

## 已实现能力

- 五位固定模拟用户直接进入，数据库会话与账户数据归属检查
- 用户主动入金、模拟用户间转账、原子双分录账本和幂等操作编号
- 绿色查询、黄色明确确认、红色 TOTP；转账授权绑定与 10 分钟期限、动态码消费、客户级三次失败冷却
- 虚拟卡申请、卡片锁定、真实流水与基于已有流水的账单分析
- 官方内置 Agent：LangGraph 持久化工作流、大模型结构化意图与计划、授权中断及恢复
- APP 可见代操作原型：悬浮对话、当前页面上下文、助手光标/高亮、逐字填表、步骤条、明确许可后导航/填写、用户干预即暂停、重新观察后继续、选择题与自由回答
- 腾讯渠道：QQ 官方机器人与企业微信长连接、一次性账户绑定、黄色按钮确认、红色回 APP 强验证
- 安全中心、用户审计台和 PWA 安装能力
- 理财产品表只接受带原始来源和核验时间的记录；无可靠数据时返回空数组

## 定时任务

个人中心新增「定时任务」：自定义提醒、月度账单报告、订阅到期检查，支持周期执行、暂停/恢复/取消及结果查看。需应用迁移 020 并启动独立 scheduler Worker。配置与边界见 [定时任务](docs/SCHEDULED_TASKS.md)。

## 统一的 Agent 运行时

银行 APP 是比赛的主体验。页面助手的调用循环、上下文与 Skills 加载使用 Deep Agents SDK，其持久化与中断建立在 LangGraph 上；团队实现页面适配、接管与暂停、银行授权边界。QQ 与企业微信继续接入现有 LangGraph 业务 Runtime，目前没有复用页面助手的对话线程。所有业务入口共用 `Bank Core`。银行 APP 接口只接受会话，官方 IM 使用各自独立的内部适配认证。

页面助手是已接入主银行页面及业务弹窗的原型，不代表 APP 所有路由、六类赛题业务或真实模型评测已完成。模型必须支持工具调用。基座选型、验证范围与已知风险见 [可见页面助手](docs/VISIBLE_APP_AGENT.md)。

对外 MCP、OpenAPI、开发者中心和用户 API 令牌已删除。`013_retire_external_access.sql` 撤销并归档旧客户端与令牌，保留历史审计及银行数据；旧地址返回 404。详情见 [外部接入退役](docs/EXTERNAL_ACCESS_RETIREMENT.md)。

## 本地运行

要求 Node.js 22、PostgreSQL 17 和 `docker-compose`。

```bash
cp .env.example .env.local
# 为 PASSWORD_PEPPER 生成独立随机值，例如：openssl rand -hex 32
npm install
npm run db:setup
npm run dev
```

打开 `http://localhost:3000`，选择一位小用户直接体验。首次合法选择会初始化五位模拟用户和历史数据；已有数据库需按顺序应用所有尚未执行的迁移。

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

支持 New API 等兼容服务，`AI_BASE_URL` 使用其 `/v1` 地址。模型调试位于“个人中心 → 设置 → 调试”，目录从服务端读取，密钥不进入浏览器；保存仅影响当前登录会话的新页面助手任务。进行中的任务固定原模型，官方 IM 使用服务端默认。见 [模型设置与验证范围](docs/MODEL_SETTINGS.md)。

业务意图仍由模型理解，银行业务工作流的余额、金额和执行状态由服务端事实生成确定性回执，不交给模型自由改写。页面助手的动作描述和追问仍不是银行回执。实现与验收边界见 [授权与事实回执补强](docs/AUTHORIZATION_HARDENING.md)。

## 验证

```bash
npm run build
npm test
npm run lint
npm run db:verify
```

`db:verify` 检查账本平衡、客户余额非负、操作编号唯一、客户凭据完整和系统账户归属。

默认 `npm test` 跳过数据库集成。完整验证需在本机独立的 `bankpilot_test` 数据库应用全部迁移，设置 `BANKPILOT_DB_TESTS=1`、对应 `DATABASE_URL` 和测试用 `PASSWORD_PEPPER`，执行 `npm test -- --no-file-parallelism`。浏览器真实 API 用例也须使用隔离库，不能连接线上共享账户。

## 文档

- [系统提示词固定案例与真实模型验收](docs/PROMPT_EVALUATION.md)
- [系统提示词与用户偏好规则（银行 APP 按调用读取偏好）](docs/AGENT_PROMPTS_AND_MEMORY.md)
- [访客记忆归属与数据库结构](docs/VISITOR_MEMORY_STORAGE.md)
- [访客偏好管理与接口](docs/PREFERENCE_API.md)
- [系统架构](docs/ARCHITECTURE.md)
- [可见页面助手与通用 Agent 复用](docs/VISIBLE_APP_AGENT.md)
- [开发与参赛计划](docs/ROADMAP.md)
- [UI 重构方案与实施结果](docs/UI_REFACTOR_PLAN.md)
- [产品设计系统](docs/DESIGN_SYSTEM.md)
- [部署与发布记录](docs/DEPLOYMENT.md)
- [外部接入退役与认证边界](docs/EXTERNAL_ACCESS_RETIREMENT.md)
- [企业微信智能机器人接入](docs/WECOM.md)
- [QQ 官方机器人接入](docs/QQ.md)
- [安全设计与已知风险](docs/SECURITY.md)
- [完整安全报告与 Word 下载](docs/security-reports/2026-10-17/README.md)
- [授权与事实回执补强及迁移 019](docs/AUTHORIZATION_HARDENING.md)
- [部署说明](docs/DEPLOYMENT.md)
- [验收脚本](docs/DEMO_SCRIPT.md)

项目仓库：[kidrauhl123/AIbanking](https://github.com/kidrauhl123/AIbanking)
