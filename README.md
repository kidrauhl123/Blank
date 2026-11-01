# Blank

Blank 是为“银行 AI 智能体”赛题构建的可运行 PWA 沙箱银行。银行 APP 的可见页面助手复用 Deep Agents SDK；现有业务工作流与 QQ、企业微信使用 LangGraph。两种助手共用银行核心，身份、策略、授权和账本操作由银行核心控制。

比赛入口只有一个：小土豆，点击直接进入，无需注册或密码。另外四位模拟用户（小板栗、小苹果、小西瓜、小橘子）仍然存在，是小土豆转账与 AA 的朋友，登录页不展示。五位用户拥有预置余额、历史账单、卡片、订阅和互相转账记录；访客共享这些模拟账户。

线上演示：<https://bank.jung.edu.pl>。线上运行的版本和每次发布的结果见 [部署与发布记录](docs/DEPLOYMENT.md)。

界面只有手机形态：所有产品页面渲染在同一块 430px 宽的画布内，宽视口下画布浮在桌面上，鼠标指针等同手指（只用按下反馈，不用 hover）。见 [UI 重构](docs/UI_REFACTOR_PLAN.md) 与 [设计系统](docs/DESIGN_SYSTEM.md)。

历史数据标记 `DEMO_SEED` 并记录双分录；初始化仅执行一次，重新进入不重置用户操作。会话归属、业务确认、强验证和审计仍保留，旧账户与数据不会被清空。

## 已实现能力

**账户与转账**

- 小土豆一键进入，数据库会话与账户数据归属检查；访客共享五位模拟用户的演示数据。
- 入金、模拟用户间转账，原子双分录账本，幂等操作编号。
- 分级确认：绿色查询、黄色明确确认、红色 TOTP。转账授权绑定，10 分钟期限，动态码只能用一次，客户级连续三次失败冷却 15 分钟；当天累计超过 ¥1,000 升为红色。
- 虚拟卡申请、卡片锁定、真实流水与基于已有流水的账单分析。

**安全与反诈**

- [反诈守护](docs/FRAUD_GUARD.md)：发起转账时，遇到诈骗话术、新收款人加异常金额、深夜、连续转账或新设备大额转账，暂缓 24 小时并给出拦截卡；陌生小额退款入账时提醒。
- [立规矩（Agent 钱包）](docs/WALLET_RULES.md)：用户设定的小额规矩内免确认，只从钱包子账户出，24 小时冷静期后生效，可暂停或撤销。
- [提示词注入防护](docs/SECURITY.md)：外部内容标为不可信数据；查询轮不能办理；写操作只认用户本人打字的话。

**Agent 与对话**

- 官方内置 Agent：LangGraph 持久化工作流、大模型结构化意图与计划、授权中断及恢复。
- [可见页面助手](docs/VISIBLE_APP_AGENT.md)：悬浮对话、页面光标与高亮、逐字填表、步骤条、用户干预即暂停、明确许可后导航和填写；不代点最终确认。
- [当场造工具](docs/INTERACTIVE_TOOLS.md)：对话中生成攒钱模拟、分账表，可保存到首页。
- [生活记忆](docs/LIFE_MEMORY.md)：记住用户说过的生活事件（到期前提醒）和偏好。
- [Skills 库](docs/SKILLS_LIBRARY.md)：15 个内置做法（消费洞察、理财、预算、跨境、本行业务、反诈、Blank 互联等），以及用户用一句话保存的自定义做法（预览、确认后生效）。
- [实时语音](docs/REALTIME_VOICE.md)：连续双向语音通话，需要私有语音服务配置。

**首页与定时任务**

- [首页动态](docs/FEED.md)：Blank 按账本事实主动发帖。事件触发加每小时心跳；模型只写文字，数字来自服务端。
- [定时任务](docs/SCHEDULED_TASKS.md)：提醒、月度账单报告、订阅到期检查、分类预算提醒，以及每日 AI 巡检。需要独立的 scheduler 进程。
- [Jev 每日 AI 巡检](docs/DAILY_AI_REVIEWS.md)：Jev 先判断是否需要进一步分析，再按需调用主模型；保留判断和调用记录，仅提供账户关注事项。

**本行业务与理财**

- 本行知识库、网点与 ATM（演示数据）、取号与换汇预约（只是预约，不扣款、不进账本）、参考汇率（不是成交价）。见 [Skills 库](docs/SKILLS_LIBRARY.md)。
- [Blank 互联](docs/BLANK_LINK.md)：家人与朋友在双方授权后互发固定内容（反诈提醒、攒钱沟通、分账）。消息没有自由文本，也不能读对方的账户。
- 六只明确标注为模拟的理财产品：筛选、对比、模拟净值、模拟风险测评、强验证申购、整笔赎回和持仓。五位模拟用户各有两笔持仓与一笔已赎回投资。见 [模拟理财](docs/SIMULATED_INVESTMENTS.md)。

**渠道与运维**

- [QQ](docs/QQ.md) 与[企业微信](docs/WECOM.md)官方机器人：长连接、一次性账户绑定、黄色按钮确认、红色回 APP 强验证。需要在 App 里完成的请求只回一个回 App 的链接，见 [渠道接入](docs/CHANNEL_ONBOARDING.md)。
- 安全中心（TOTP）、用户审计台和 PWA 安装能力。

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

打开 `http://localhost:3000`，直接进入小土豆。首次进入会初始化五位模拟用户和历史数据；已有数据库需按顺序应用所有尚未执行的迁移（`db/migrations/` 共 001–044）。

仅验证页面交互时可直接打开 `http://localhost:3000/preview/agent`，无需配置数据库或模型。此页面明确标注预设流程，提供转账填表和虚拟卡申请的交互演示，不调用银行 API，不代表真实模型验收。

数据库迁移由 `schema_migrations` 记录，每个文件只执行一次。`002_identity_and_platform.sql` 会在旧原型首次升级时清除旧版预置数据；已升级环境不会再次执行。

QQ 与企业微信机器人均为可选独立进程。接入方式见 [QQ 接入文档](docs/QQ.md)和[企业微信接入文档](docs/WECOM.md)。

## AI 配置

内置 Agent 只在以下三个变量全部存在时启用：

```env
AI_BASE_URL=https://your-openai-compatible-provider.example/v1
AI_API_KEY=...
AI_MODEL=...
```

`AI_TIMEOUT_MS` 可选，默认 30000。`AI_ALLOWED_MODELS` 可选，逗号分隔，设置后设置页只显示这份名单与上游目录的交集；`AI_BLOCKED_MODELS` 可选，列出的模型不可选。

未配置模型时，界面明确显示“真实 AI 模型未配置”，服务端返回错误；不会用关键词匹配或写死回复伪装 AI。

支持 New API 等兼容服务，`AI_BASE_URL` 使用其 `/v1` 地址。模型选择位于设置页（`/settings`）的「Blank 模型」一栏，目录从服务端读取，密钥不进入浏览器；保存仅影响当前登录会话的新页面助手任务。进行中的任务固定原模型，官方 IM 使用服务端默认。见 [模型设置与验证范围](docs/MODEL_SETTINGS.md)。

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

真实模型的提示词评测是单独的命令：`npm run eval:prompts`，需要模型密钥，结果写入 `evals/results/`，之后要人工复核。见 [系统提示词固定案例与真实模型验收](docs/PROMPT_EVALUATION.md)。

GitHub Actions 中有三条工作流：`ci.yml`（数据库集成、单元测试、构建、浏览器测试）、`security-regression.yml`（安全回归）和 `agent-preferences-regression.yml`（偏好与 Agent 回归）。

## 文档

**产品与功能**

- [首页动态](docs/FEED.md)、[定时任务](docs/SCHEDULED_TASKS.md)、[立规矩](docs/WALLET_RULES.md)、[反诈守护](docs/FRAUD_GUARD.md)、[Blank 互联](docs/BLANK_LINK.md)
- [Skills 库与自定义做法](docs/SKILLS_LIBRARY.md)、[当场造工具](docs/INTERACTIVE_TOOLS.md)、[生活记忆](docs/LIFE_MEMORY.md)
- [模拟理财](docs/SIMULATED_INVESTMENTS.md)、[每日 AI 巡检](docs/DAILY_AI_REVIEWS.md)、[提交时日累计转账校验](docs/TRANSFER_QUOTA.md)
- [银行 APP 与 Agent 的边界（原生页面与对话）](docs/NATIVE_BANKING.md)
- [演示用户](docs/DEMO_USERS.md)、[生活模拟](docs/DEMO_LIFE.md)、[验收脚本](docs/DEMO_SCRIPT.md)

**Agent 与提示词**

- [可见页面助手](docs/VISIBLE_APP_AGENT.md)、[对话与页面接管](docs/APP_AGENT_PRESENTATION.md)
- [系统提示词与用户偏好规则](docs/AGENT_PROMPTS_AND_MEMORY.md)、[偏好读写接口](docs/PREFERENCE_API.md)、[访客记忆归属与数据库结构](docs/VISITOR_MEMORY_STORAGE.md)
- [系统提示词固定案例验收](docs/PROMPT_EVALUATION.md)、[模型接入与设置](docs/MODEL_SETTINGS.md)
- [实时语音](docs/REALTIME_VOICE.md)、[语音与执行过程样机](docs/VOICE_AGENT_TIMELINE_PROTOTYPE.md)

**界面**

- [UI 重构方案与实施结果](docs/UI_REFACTOR_PLAN.md)、[产品设计系统](docs/DESIGN_SYSTEM.md)、[生长式界面](docs/GROWN_UI.md)

**渠道**

- [渠道接入（用户绑定与 IM 能力边界）](docs/CHANNEL_ONBOARDING.md)、[企业微信智能机器人接入](docs/WECOM.md)、[QQ 官方机器人接入](docs/QQ.md)

**架构、安全与部署**

- [系统架构](docs/ARCHITECTURE.md)、[开发与参赛计划](docs/ROADMAP.md)
- [安全设计与自评](docs/SECURITY.md)、[授权与银行事实回执补强（迁移 019）](docs/AUTHORIZATION_HARDENING.md)、[2026-10-17 转账授权加固](docs/SECURITY_HARDENING.md)、[外部接入退役](docs/EXTERNAL_ACCESS_RETIREMENT.md)
- [提示词注入回归（2026-11-01）](docs/security-reports/2026-11-01/prompt-injection-regression.md)
- [完整安全报告与 Word 下载（2026-10-17，历史快照）](docs/security-reports/2026-10-17/README.md)
- [部署说明与发布记录](docs/DEPLOYMENT.md)

项目仓库：[kidrauhl123/Blank](https://github.com/kidrauhl123/Blank)
