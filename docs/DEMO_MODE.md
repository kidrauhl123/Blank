# 五位模拟用户

入口只展示小土豆、小板栗、小苹果、小西瓜、小橘子的头像和名字。点选直接进入真实银行 PWA，无注册表单、密码登录或模式开关。个人中心可以切换用户。

## 数据

`011_demo_profiles.sql` 添加身份映射表。首次合法选择，在一个数据库事务与 advisory lock 内创建全部五位用户；重复进入不重置余额、卡片或历史。部分映射异常时拒绝初始化，不覆盖现有客户。

每人有一个活期账户、两张虚拟卡、两项订阅和 17 条历史明细，包含一收一付历史转账。预置资金变动均对应双分录；五笔历史转账链接到账本和收付款明细。收入、日常消费、上月账单、订阅与异常扣费明确标记 `DEMO_SEED`，供模型读取分析。后续操作仍由现有 Bank Core 执行。

五个账户由访客共享，页面标注共享测试数据。没有每访客独立账户或自动重置；旧注册客户及其数据保留。

## 会话

只接受固定 profile key，不允许客户 UUID 或任意姓名登录。POST `/api/auth/demo` 要求与可信站点一致的 Origin，拒绝缺失、跨站来源及 Authorization 头。生产使用 `BANKPILOT_PUBLIC_URL` 校验，需与实际访问入口一致。

继续使用随机会话 token、数据库 hash、HttpOnly/SameSite cookie。切换撤销原会话，并清理旧助手任务、对话及业务确认状态。普通注册与密码登录 HTTP 路由已移除。模型权限、业务归属检查、确认、强验证和审计仍生效；这些保留机制不代表 ROADMAP 已知缺陷已被修复。

## 验证

2026-10-10：46 项 Vitest（包含 16 项数据库集成）和 7 项 Chrome 检查通过；lint 与 production build 通过。

数据库集成覆盖非法身份、并发初始化、五人完整数据、账本平衡、余额一致、会话撤销及保留已有数据。仅在本地 `bankpilot_test` 角色、未预置模拟用户的独立测试库运行，退出只清理测试夹具。

浏览器检查使用真实 API 和数据库，覆盖五位用户逐一进入及切换、无密码输入框、旧助手缓存清理、来源校验、拒绝令牌与任意 UUID，以及旧登录接口不可用。

```bash
DATABASE_URL=postgresql://bankpilot_test@127.0.0.1:5432/test_database \
  BANKPILOT_PUBLIC_URL=http://localhost:3109 PASSWORD_PEPPER=test-only \
  npm run dev -- --port 3109
BANKPILOT_DEMO_E2E=1 CHROME_PATH=/path/to/chrome npm run test:e2e
```

已有部署只添加 011 迁移并重建应用，不重放清库迁移，不更改其他 Agent/渠道服务。
