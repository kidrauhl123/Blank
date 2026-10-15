# 模型接入与调试设置

2026-10-15。模型服务接入 OpenAI Chat Completions 兼容的 New API；服务端配置 `AI_BASE_URL`（含 `/v1`）、`AI_API_KEY` 与默认 `AI_MODEL`。凭据只写服务器私有环境文件，不进入 Git、浏览器、模型目录响应或截图。

模型选择位于“个人中心 → 设置 → 调试 → 助手模型”。正常助手界面不展示模型选择。保存后只影响当前银行登录会话的新页面助手任务，不影响其他访客；官方 IM 继续使用服务端默认模型。

## 目录与任务

- `/api/agent/models` 仅接受银行会话，服务端读取上游 `/models`，仅返回去重、过滤后的模型 ID 与默认值；不转发供应商元数据或凭据。目录按上游配置缓存 60 秒，并合并同时请求。
- `/api/v1/settings/model` 读取或保存当前 `user_sessions.ai_model`，客户与会话摘要必须同时匹配。写入要求正式 Origin；任意 Authorization 头、无效会话或未列出的模型拒绝。
- 新任务先校验所选模型，再写入 `app_agent_runs.model`。恢复任务使用该字段，不跟随之后修改的调试设置。图缓存最多保留四个模型，持久化仍由 PostgreSQL checkpoint 承担。
- 014 前的任务没有模型字段，首次读取时补记部署默认。此次接入保持原默认 `deepseek-v4-flash`，不把旧任务改成新选的模型。
- 模型选择不赋予银行权限。页面工具白名单、人工确认、强验证、账本事务继续由原银行边界控制。
- New API 中的 DeepSeek 模型同样关闭 thinking，以适配现有工具消息回放；不再仅根据直连域名判断这一参数。

## 界面

银行与设置页改用纯填充：暖灰画布、白色表面、深墨主操作；去除围合描边、阴影与装饰渐变。系统深色通过全局 token 切换。保留必要行分隔、焦点和业务状态颜色，助手与设置分开。

## 验证范围

独立 PostgreSQL 全套 149 项 Vitest 通过、无跳过；37 项 Chrome 通过。新增目录过滤、缓存、并发、失败脱敏、模型固定、会话隔离、设置真实 API 和旧 UI 入口适配。生产构建、TypeScript、lint、发布脚本回归通过。

通过真实 New API 凭据取得 30 个模型 ID；`deepseek-v4-flash` 原始工具调用通过，设置选择 `deepseek-v4-pro` 后，实际 Deep Agents 调用 `inspect_page` 并暂停等待许可。测试银行位于本机隔离数据库，未执行资金操作。目录可见不等于所有模型均完成了工具或银行业务验收。

本机模型设置浏览器回归使用独立模型替身：设置 `BANKPILOT_MODEL_E2E=1`、`BANKPILOT_DEMO_E2E=1`、隔离数据库、`AI_BASE_URL=http://127.0.0.1:54230/v1`、`AI_API_KEY=model-e2e-only`、`AI_MODEL=bank-test-alpha` 后运行 `npm run test:e2e`。Playwright 启动仅绑定本机的测试模型服务器；这类用例不计为真实模型成功率。
