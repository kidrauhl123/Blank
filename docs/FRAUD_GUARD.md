# 反诈守护

反诈守护分三部分：发起转账时的**暂缓**（第 1–3 节）、新设备登录后的大额转账（第 4 节）、以及不转账时的**提醒**（第 5、6 节）。判断全部是服务端的确定性规则，不交给模型。

原则：**暂缓不是锁定**。用户可以强验证继续，也可以选择 24 小时后再办。宁可多问一句，不替用户做决定，也不因误报锁死用户的钱。

## 1. 暂缓判断什么

判断在 `src/lib/fraud-core.ts`（纯函数）。信号全部来自服务端：

| 信号 | 含义 | 判断 |
|---|---|---|
| `SCAM_PHRASE` | 备注，或最近 1 小时用户自己说过的话（App 对话与语音转写），含“安全账户”“保证金”“刷单”“验证码”“洗钱”“涉嫌”“公安”“冻结” | 命中即暂缓 |
| `NEW_RECIPIENT` | 这位收款人以前没有成功收过这个客户的钱 | 只作为下面条件的前提 |
| `UNUSUAL_AMOUNT` | 金额不少于 ¥2,000，且达到最近 90 天成功转账平均额的 3 倍（没有历史则只看金额） | 第一次转给这个人 + 异常金额 → 暂缓 |
| `NIGHT` | 北京时间 23:00 至次日 7:00 | 第一次转给这个人 + 深夜 → 暂缓 |
| `BURST_NEW_RECIPIENTS` | 10 分钟内转给过别的人，这一位又是第一次 | 暂缓 |
| `NEW_DEVICE` | 刚从新设备登录（见第 4 节），且金额不少于 ¥2,000 | 暂缓 |

老朋友、没有话术、也不是新设备的正常转账不暂缓，也不给任何原因。

## 2. 暂缓时发生什么

1. `prepareTransfer`（`src/lib/bank-core.ts`）在草稿的同一个事务里判断，原因写入转账行的 `fraud_reasons`。
2. 风险升到红色，`requiredAuth` 为 MFA（强验证）。被暂缓的转账**不走规矩覆盖**：规矩不能替一笔可疑的转账办理。
3. 动态里留一条 `anomaly` 类型的记录（“一笔转账被反诈守护暂缓了”），审计 `FRAUD_GUARD_TRIGGERED` 记下原因码。资金没有动。
4. 与你互联（见 [Blank 互联](BLANK_LINK.md)）并开启了反诈提醒的家人或朋友会收到一条 `FRAUD_ALERT`：金额、最多 5 条原因、你的联系电话，方便对方核实。
5. 返回的草稿带 `fraudHold`：原因、三个问题、反诈专线 96110。前端拦截卡（`src/components/FraudCard.tsx`）展示它。

拦截卡上的三个问题是选做的：不答也能继续。取消就直接关掉弹窗，草稿会过期。

## 3. 用户的两条出路

- **强验证继续**：输入验证器动态码，按原来的强验证流程过账。
- **24 小时后再办**（`POST /api/v1/transfers/:operationId/hold`）：只能对暂缓中、还没过账的转账设置一次。
  - 写入 `hold_until`，审计 `FRAUD_GUARD_COOLING_STARTED` 记下用户选的问题答案（只记录，不参与判断）。
  - 所有有效的 IM 渠道收到一条不含金额的提醒：说明有一笔转账被暂缓、什么时候能再办、不是本人就去核实。
  - 暂缓期内 `commitTransfer` 拒绝，返回 409 `FRAUD_HOLD_ACTIVE`，并告诉用户什么时候可以再办。
  - 到点后仍需要强验证。

## 4. 新设备登录后的大额转账

- 每次登录会计算一个**设备标识**：只看操作系统和浏览器（来自 User-Agent），不看 IP，也不做指纹。写入 `customer_devices`，会话记录在 `user_sessions.device_key`。
- 会话标记为 `new_device` 的条件：这位客户已经有过至少一台已知设备（第一次登录不算），并且不是演示账户。
- `authenticateRequest` 只在会话创建后 **24 小时内**把 `new_device` 当作有效。
- 在这 24 小时内发起的转账：
  - 金额不少于 ¥2,000 → 反诈暂缓，原因 `NEW_DEVICE`（第 1 节）。
  - 风险策略把它视为**不可信设备**，升为红色，规则名 `UNTRUSTED_DEVICE`（`src/lib/policy.ts`）。
  - 规矩在这段时间内暂停覆盖：这笔按普通转账确认，不因规矩免确认。
- 信号来自服务端会话，因此 App 表单（`/api/v1/transfers/prepare`）和银行 APP 里的业务对话（`/api/agent`）都带上它。
- 没有会话的 IM 渠道不知道设备，按可信设备处理。

设备标识很粗：清掉浏览器数据或换浏览器，会被当成新设备，结果只是多一步确认。它是反诈信号，不是身份证明。

## 5. 陌生小额入账提醒

`alertInboundRefunds`（`src/lib/fraud-store.ts`）在定时检查时运行，找出这样的入账：

- 金额大于 0 且不超过 ¥300；
- 发生在最近 3 天内；
- 商户名或分类含“退款、返利、返现、退回、赔付、补偿”；
- 此前没有来自同一商户的交易（第一次往来）。

每次最多处理 5 笔。每笔写一条动态（类型 `anomaly`，来源“反诈守护”，标记需要关注），并发到所有有效的 IM 渠道。提醒按交易去重，同一笔只提醒一次。

这类提醒**直接写入动态，不经过 Jev**：它是安全提醒，不是营销判断。

## 6. 话术提醒

用户在页面助手对话（含语音转写）或 IM 消息里说出上面的诈骗话术时，`recordScamPhraseAlert` 写一条动态提醒（类型 `anomaly`，来源“反诈守护”），提示“这类话常见于诈骗，不要转账，也不要提供验证码，如有疑问拨打 96110”。

- App 对话：`src/lib/app-agent-runtime.ts`，来源 `APP_CHAT`，动态归属当前访客的记忆范围。
- IM：`src/lib/im-gateway.ts`，来源 `IM`。
- 按消息去重，同一条消息不重复提醒。

## 7. 边界

- 话术是关键词匹配：会漏报（换一种说法），也会误报（正常聊天里出现“冻结”）。误报的代价是一条提醒，或一次暂缓。
- 新设备规则只对 App 会话生效；IM 渠道没有设备概念。
- 陌生小额入账提醒只覆盖 ¥300 以下、3 天内、靠商户名或分类关键词识别的入账。
- 没有接入外部反诈平台、黑名单或风控厂商数据。
- 暂缓后的 24 小时是固定的，不随风险变化。

## 8. 相关代码、测试与迁移

- `src/lib/fraud-core.ts`、`src/lib/fraud-core.test.ts`：规则、话术、问题、提醒常量（纯函数）
- `src/lib/fraud-store.ts`：读取信号、留动态和审计、24 小时暂缓、陌生入账提醒、话术提醒
- `src/lib/device-key.ts`、`src/lib/auth.ts`：设备标识、`new_device` 判定和 24 小时窗口
- `src/lib/policy.ts`：`fraudHold`（`FRAUD_GUARD_HOLD`）、`trustedDevice`（`UNTRUSTED_DEVICE`）、失败次数（`AUTH_FAILURE_FUSE_ACTIVE`）
- `src/lib/bank-core.ts`：`prepareTransfer` 把会话的 `newDevice` 和失败次数传给策略
- `src/lib/agent.ts`：业务对话里的转账（`/api/agent`）同样传入 `newDevice`；`src/lib/agent-runtime.ts` 把它从路由传到这里
- `src/lib/fraud-guard.integration.test.ts`：真实数据库的暂缓、暂缓期内不能提交、到期仍需强验证、别人的转账不能暂缓
- `src/lib/risk-signals.integration.test.ts`：新设备、30 分钟内失败次数、客户隔离
- `src/lib/agent-transfer-device.integration.test.ts`：对话转账同样带上新设备标记
- `e2e/fraud-guard.pw.ts`：真实界面里发起转账 → 拦截卡 → 24 小时后再办 → 钱没有动
- 迁移：`035_fraud_guard.sql`（`transfers.fraud_reasons`、`transfers.hold_until`）；`042_new_device_guard.sql`（`customer_devices`、`user_sessions.device_key`、`user_sessions.new_device`）
