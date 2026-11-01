# 模型接入与设置

当前状态（2026-11-01）：设置页（`/settings`）只有一个「Blank 模型」选择，正常助手界面不展示模型选择。示例配置里的默认模型是 `deepseek-v4.1-flash`，可选名单见下文 `AI_ALLOWED_MODELS`。下文按日期记录的测试和失败结果是当时的历史记录。

2026-10-16 补充：当前用户提供的兼容网关目录可读，`deepseek-v4.1-flash-free` 原始工具调用和项目 SDK 调用均有成功记录。已运行 20 项固定提示词案例，仍观察到工具交回协议、Schema 和上游稳定性问题，不能认定已通过银行助手验收。详情见 [系统提示词验收](PROMPT_EVALUATION.md)。下文 2026-10-15 的免费模型失败记录是当日对应模型与网关配置的历史结果，不代表今天全部免费模型均不可用。

2026-10-15。模型服务接入 OpenAI Chat Completions 兼容的 New API；服务端配置 `AI_BASE_URL`（含 `/v1`）、`AI_API_KEY` 与默认 `AI_MODEL`。凭据只写服务器私有环境文件，不进入 Git、浏览器、模型目录响应或截图。

模型选择位于设置页的「Blank 模型」一栏（`/settings`，`src/components/AppSettings.tsx`）。正常助手界面不展示模型选择。保存后只影响当前银行登录会话的新页面助手任务，不影响其他访客；官方 IM 继续使用服务端默认模型。

## 访客自己的模型接口（自定义 API key）

设置页的「自定义模型 API」一栏让访客填写自己的 OpenAI 兼容接口：接口地址、API 密钥和模型名称。保存时服务器先检查地址，再用这把密钥请求一次 `/models`，通过后才加密保存。

- **优先级**：访客自己的配置优先；没有时才用运营方的 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`；都没有时界面显示未配置。
- **范围**：按访客（记忆归属 cookie）保存，不按共享的模拟账户保存。别的访客用同一个模拟账户时既看不到，也用不到。
- **用途**：页面助手和银行业务对话里的所有模型调用都用访客自己的配置。后台任务（动态的文字撰写、每日巡检的主模型、IM 渠道）没有访客上下文，只用运营方的配置。
- **存放**：密钥用 AES-256-GCM 加密，密钥由 `PASSWORD_PEPPER` 经 HKDF 派生。接口从不返回密钥，只返回地址、模型名和密钥尾号。更换 `PASSWORD_PEPPER` 后已保存的密钥需要重新填写。
- **地址限制**：必须是公开的 `https` 地址，不能带账号密码、查询参数或非标准端口；解析出的每个 IP 都必须是公开地址（本机、内网、链路本地、100.64/10 等都拒绝）；请求不跟随重定向，超时 8 秒。每次使用前都会重新检查解析结果。
- **模型**：访客的接口只用他填写的那一个模型，不去拉取目录，也不受 `AI_ALLOWED_MODELS` / `AI_BLOCKED_MODELS` 限制（那是运营方网关的策略）。
- **接口**：`GET` 读取状态，`PUT` 验证并保存，`DELETE` 删除。写请求必须同源。
- 代码：`src/lib/model-config.ts`（当前请求的配置）、`src/lib/model-key-vault.ts`（加密）、`src/lib/model-endpoint.ts`（地址与公开性检查）、`src/lib/visitor-model-key.ts`（存放与使用）、`src/app/api/v1/settings/model-key/route.ts`、`src/components/ModelKeyForm.tsx`。迁移 `045_visitor_model_keys.sql`。

## 目录与任务

- `/api/agent/models` 仅接受银行会话，服务端读取上游 `/models`，仅返回去重、过滤后的模型 ID 与默认值；不转发供应商元数据或凭据。目录按上游配置缓存 60 秒，并合并同时请求。
- `/api/v1/settings/model` 读取或保存当前 `user_sessions.ai_model`，客户与会话摘要必须同时匹配。写入要求正式 Origin；任意 Authorization 头、无效会话或未列出的模型拒绝。
- 新任务先校验所选模型，再写入 `app_agent_runs.model`。恢复任务使用该字段，不跟随之后修改的设置。图缓存最多保留四个模型，持久化仍由 PostgreSQL checkpoint 承担。
- 014 前的任务没有模型字段，首次读取时补记部署默认。此次接入保持原默认 `deepseek-v4-flash`，不把旧任务改成新选的模型。
- 模型选择不赋予银行权限。页面工具白名单、人工确认、强验证、账本事务继续由原银行边界控制。
- New API 中的 DeepSeek 模型同样关闭 thinking，以适配现有工具消息回放；不再仅根据直连域名判断这一参数。
- 网关目录并非可用性证明。`AI_ALLOWED_MODELS`（可选，逗号分隔）只保留这份名单里、且上游目录里也有的模型；不设置时显示上游目录（去重、排序，最多 200 个）。部署示例为 `deepseek-v4.1-flash,qwen3.8-flash,gemini-3.8-flash-high`，见 `.env.example`。`AI_BLOCKED_MODELS` 为逗号分隔的运维屏蔽名单，目录、设置写入、新建及恢复任务均检查；更改后需重建应用容器。已保存的不可用选项会在设置页提示重新选择，系统不会擅自切换模型。
- 模型访问拒绝、额度不足、限流、超时与请求不兼容分别返回固定的可操作提示。服务端只记录错误分类和上游状态码，不记录上游错误正文、请求头或凭据。

## 界面

银行与设置页改用纯填充：暖灰画布、白色表面、深墨主操作；去除围合描边、阴影与装饰渐变。系统深色通过全局 token 切换。保留必要行分隔、焦点和业务状态颜色，助手与设置分开。

## 验证范围

独立 PostgreSQL 全套 149 项 Vitest 通过、无跳过；37 项 Chrome 通过。新增目录过滤、缓存、并发、失败脱敏、模型固定、会话隔离、设置真实 API 和旧 UI 入口适配。生产构建、TypeScript、lint、发布脚本回归通过。

通过真实 New API 凭据取得 30 个模型 ID；`deepseek-v4-flash` 原始工具调用通过，设置选择 `deepseek-v4-pro` 后，实际 Deep Agents 调用 `inspect_page` 并暂停等待许可。测试银行位于本机隔离数据库，未执行资金操作。目录可见不等于所有模型均完成了工具或银行业务验收。

上线后确认 `muse-spark-1.3-contributor-free` 的上游返回 403，说明只允许在 OpenCode 内使用；生产环境将该 ID 加入屏蔽名单。不能通过伪装客户端绕过这一限制。其余模型仍需分别验证，不能据此认定所有免费或同系列模型均不可用。

本次修复默认 Vitest 132 项通过、39 项数据库用例按配置跳过；lint、TypeScript 与生产构建通过。生产浏览器用默认 Flash 从卡片页发起“查一下我的余额”，允许页面操作后打开首页并依据显示金额完成回复，未执行资金操作。

用户随后指定仅以 free 模型验收。网关 8 个带 `free` 的模型实测均失败：`longcat-2.5-preview-free`、`mimo-v2.6-flash-free`、`muse-spark-1.3-contributor-free` 返回 OpenCode 使用限制 403；`ling-3.1-flash-free` 返回代理不支持上游协议 400；另外 4 个返回上游失败 502。补查 `big-pickle` 同样返回使用限制 403；网关未授权的 `cat-jam-free` 直连自有代理仍返回相同限制。没有确认可用于银行助手的免费模型，不能将付费模型测试算作免费验收。SDK 会将原始错误嵌套 8 层，分类器以带循环检测的 32 层上限穿透，并以真实 SDK 错误回归覆盖。

本机模型设置浏览器回归使用独立模型替身：设置 `BANKPILOT_MODEL_E2E=1`、`BANKPILOT_DEMO_E2E=1`、隔离数据库、`AI_BASE_URL=http://127.0.0.1:54230/v1`、`AI_API_KEY=model-e2e-only`、`AI_MODEL=bank-test-alpha` 后运行 `npm run test:e2e`。Playwright 启动仅绑定本机的测试模型服务器；这类用例不计为真实模型成功率。
