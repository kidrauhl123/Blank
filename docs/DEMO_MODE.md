# 比赛模拟用户入口

开启 `BANKPILOT_DEMO_MODE=true` 后，登录页展示五位模拟用户：小土豆、小板栗、小苹果、小西瓜、小橘子。点击直接进入真实 PWA 与 Bank Core，无需注册或密码。关闭开关后恢复原有注册和密码登录，不删除任何账户。

## 数据与执行

`011_demo_profiles.sql` 仅添加身份映射表。第一次合法选择用户时，在同一数据库事务与 advisory lock 内创建全部五位用户。重复进入不重置余额、卡片或历史；部分映射异常会拒绝初始化，不覆盖现有客户。

每位用户有一个活期账户、两张虚拟卡、两项订阅、17 条历史明细（含期初资金和一收一付历史转账）。历史交易明确标记 `DEMO_SEED`，资金变动有对应双分录并更新真实沙箱余额。五笔历史转账链接到账本、收款人和收付款明细。日常消费、上月收入、订阅扣费与模拟异常扣费供账单分析使用。用户之间后续转账沿用现有银行核心。

五个账户由演示访客共享；这里不提供每访客独立资金或自动重置。界面明确说明共享沙箱数据。初始化不会清空原有注册客户，也不替换他们的身份或余额。

## 会话与操作边界

只允许服务端固定 profile key，不能通过客户 UUID 或任意姓名创建会话。POST `/api/auth/demo` 必须携带与可信站点完全一致的 Origin，拒绝缺失、跨站来源及 Authorization 请求头。生产环境使用 `BANKPILOT_PUBLIC_URL` 校验，配置时需与实际访问入口一致。

会话仍使用随机 opaque token、数据库存储 hash、HttpOnly/SameSite cookie。切换会撤销原会话，清理客户端助手任务、对话与业务确认状态。模型权限、业务归属检查、黄色确认、红色强验证与审计没有被登录入口替换。不能将这些保留机制视为修复了 ROADMAP 中已有的银行安全缺陷。

模拟模式下，普通注册与密码登录接口拒绝使用，bootstrap 要求选定模拟身份；关闭开关后原有客户仍可登录。`GET /api/auth/demo` 只返回公开资料，不初始化数据。

## 验证

2026-10-10：46 项 Vitest（包含 16 项数据库集成检查）通过，lint 和 production build 通过；7 项 Chrome 交互检查通过，其中两项模拟入口检查使用真实数据库和 API，没有替换 HTTP 响应。

数据库集成检查覆盖关闭开关、非法身份、并发初始化、五位用户完整数据、账本平衡、余额一致、会话撤销和保留已有数据。必须使用本地 `bankpilot_test` 角色及未预置模拟用户的独立测试库，退出仅清理测试夹具。

浏览器检查覆盖五位用户逐一进入和切换、历史与卡片数据、无密码输入框、旧助手缓存清理、来源校验、禁止令牌和任意 UUID。启动本地演示测试服务器后运行：

```bash
BANKPILOT_DEMO_MODE=true BANKPILOT_PUBLIC_URL=http://localhost:3109 \
  DATABASE_URL=postgresql://bankpilot_test@127.0.0.1:5432/test_database \
  PASSWORD_PEPPER=test-only npm run dev -- --port 3109
BANKPILOT_DEMO_E2E=1 CHROME_PATH=/path/to/chrome npm run test:e2e
```

生产升级只需添加 011 迁移、配置演示开关并重建应用。已有部署不要为了添加这项功能重放清库迁移或更改其他 Agent/渠道服务。
