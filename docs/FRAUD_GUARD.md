# 反诈守护（发起转账时的暂缓）

用户发起转账的那一刻，服务端用确定性规则判断这笔转账是否可疑。可疑就**暂缓**：风险升到红色、要求强验证，并给出拦截卡（说清楚哪里可疑、三个关键问题、96110）。**暂缓不是锁定**：用户可以强验证继续，也可以选择 24 小时后再办。宁可多问一句，不替用户做决定，也不因误报锁死用户的钱。

## 1. 判断什么
判断在 `src/lib/fraud-core.ts`（纯函数）。信号全部来自服务端：

| 信号 | 含义 | 判断 |
|---|---|---|
| `SCAM_PHRASE` | 备注或最近 1 小时用户自己说过的话里有“安全账户”“保证金”“刷单”“验证码”“洗钱”“涉嫌”“公安”“冻结” | 命中即暂缓 |
| `NEW_RECIPIENT` | 这位收款人以前没有成功收过这个客户的钱 | 只作为下面条件的前提 |
| `UNUSUAL_AMOUNT` | 金额不少于 ¥2,000，且达到最近 90 天平均额的 3 倍（没有历史则只看金额） | 第一次转给这个人 + 异常金额 → 暂缓 |
| `NIGHT` | 北京时间 23:00 至次日 7:00 | 第一次转给这个人 + 深夜 → 暂缓 |
| `BURST_NEW_RECIPIENTS` | 10 分钟内转给过别的人，这一位又是第一次 | 暂缓 |

老朋友、没有话术的正常转账不暂缓，也不给任何原因。

## 2. 暂缓时发生什么
1. `prepareTransfer`（`src/lib/bank-core.ts`）在草稿的同一个事务里判断，结果写入转账行的 `fraud_reasons`。
2. 风险升到 RED，`requiredAuth` 为 MFA（强验证）。被暂缓的转账**不走规矩覆盖**：规矩不能替一笔可疑的转账办理，也不会因此被暂缓的转账暂停。
3. 动态里留一条 `anomaly` 类型的记录（“一笔转账被反诈守护暂缓了”），审计 `FRAUD_GUARD_TRIGGERED` 记下原因码。资金没有动。
4. 返回的草稿里带 `fraudHold`：原因、三个问题、96110。前端的拦截卡（`src/components/FraudCard.tsx`）展示它。

## 3. 用户的两条出路
- **强验证继续**：输入验证器动态码，按原来的强验证流程过账。
- **24 小时后再办**（`POST /api/v1/transfers/:operationId/hold`）：只能对暂缓中、还没过账的转账设置一次。写入 `hold_until`，全部 IM 渠道收到一条不含金额的提醒，审计 `FRAUD_GUARD_COOLING_STARTED` 记下用户选的问题答案（只记录，不参与判断）。暂缓期内 `commitTransfer` 拒绝，返回 409 `FRAUD_HOLD_ACTIVE`，并告诉用户什么时候可以再办。到点后仍需要强验证。

拦截卡上的三个问题是选做的：不答也能继续。取消就直接关掉弹窗，草稿会过期。

## 4. 没有做的
- **陌生小额退款/返利入账**：收到可疑退款时在动态里提醒。需要接进动态的发布流程（与 P0-4 一起做）。
- **即时通讯里的话术**：目前只看 App 对话（`app_agent_runs.start_text`，语音转写也算）和备注。IM 消息需要接进同样的判断。
- **新设备登录后大额转出**：产品里还没有设备指纹，等产品决定。

## 5. 相关代码和测试
- `src/lib/fraud-core.ts`、`src/lib/fraud-core.test.ts`：规则、话术、问题（纯函数，18 个用例）
- `src/lib/fraud-store.ts`：读取信号、留动态和审计、24 小时暂缓
- `src/lib/policy.ts`：`fraudHold` 把风险升到 RED（`FRAUD_GUARD_HOLD`）
- `src/lib/fraud-guard.integration.test.ts`：真实数据库的暂缓、暂缓期内不能提交、到期仍需强验证、别人的转账不能暂缓
- `e2e/fraud-guard.pw.ts`：真实界面里发起转账 → 拦截卡 → 24 小时后再办 → 钱没有动
- 迁移 `db/migrations/035_fraud_guard.sql`：`transfers.fraud_reasons`、`transfers.hold_until`
