# 立规矩：Agent 钱包（v2）

用户可以用一句话立规矩，让 Blank 在规矩内免确认地付小额款；规矩之外一律照常由用户本人确认。**钱不由模型决定**：模型只能提议固定模板的参数，是否在规矩内由 `bank-core` 和 `wallet-core` 的确定性代码判断。

## 1. 目标与边界
- 只有一个模板 `pay_trusted_small`（小额免确认付款），没有通用的“自动付款”能力。
- 规矩内的转账由转账流程自动办理，回执标注「按你的规矩 · 无需确认」；规矩外照常确认。
- 模型不能让规矩生效，不能撤销，不能付款。它只能提议（`propose_rule`）和查看（`list_rules`）。

## 2. 模板与上限
数字以 `src/lib/wallet-core.ts` 的 `WALLET_CAPS` 和 `src/lib/policy.ts` 为准。

| 项目 | 上限 | 何时检查 |
|---|---|---|
| 单笔 | ≤ ¥500 | 立规矩时（参数）；每笔转账时 |
| 每月（单条规矩） | ≤ ¥2,000，且不低于单笔 | 立规矩时；每笔转账时 |
| 每月（同一访客全部规矩合计） | ≤ ¥2,000 | 每笔转账时 |
| 钱包余额 | ≤ ¥2,000 | 转入时；转账时（余额不够就照常确认） |
| 收款人 | 1–5 个，必须是 Blank 客户，且账本里近 180 天往来 ≥ 2 次 | 立规矩时 |
| 同时保留的规矩 | 同一访客最多 3 条（未撤销、未放弃的） | 立规矩时、确认时 |
| 当天转账口径 | 当天已转出 + 本笔 > ¥1,000 时不免确认 | 每笔转账时（与风险等级共用 `DAILY_TRANSFER_RED_THRESHOLD_MINOR`） |
| 冷静期 | 本人确认后 24 小时才生效 | 确认时写入 `effective_at` |

收款人按姓名匹配，且名字必须出现在用户这次打字的原话里（见第 3 节）。

## 3. 立规矩的流程
1. **提议**：用户在 App 里打字（语音、引用的动态、页面内容一律不算）。`propose_rule` 只在同时满足两点时才会执行（`src/lib/app-agent-harness.ts`）：这次任务开场的原话命中 `RULE_INTENT`（“不用问我”“免确认”等），且每个收款人的名字都出现在原话里。
2. **草稿**：`createRuleDraft` 用 `payTrustedSmallInput` 校验参数，解析收款人，检查往来次数，写入 `wallet_rules`（状态 `DRAFT`），返回 `[[rule:<id>]]` 标记。
3. **卡片**：前端把标记渲染成规矩卡（`RuleCard`）。卡上的文字全部来自服务端 `describeRule`，不用模型写的任何句子。
4. **确认**：用户在卡片上点击，二选一：
   - **Passkey**（首选，面容 / 指纹）：`passkeyAuthenticationOptions` 发出挑战。挑战内容绑定规矩摘要 `ruleDigest`（模板、收款人姓名和 ID、单笔、每月），一次性，5 分钟过期。注册 Passkey 前必须先提交当前的 TOTP 动态码（`/api/v1/passkeys` 的 `register-options`，step-up）。
   - **TOTP**：沿用现有的 `consumeCustomerTotp`（按步防重放、三次失败锁定）。
   - 草稿 30 分钟内有效，超时需要重新提议。
5. **冷静期**：确认通过后状态为 `COOLING`，`effective_at` 为确认时间 + 24 小时。同时：
   - 写一条 `rule` 类型的动态（需要你看看），内容包括对象、单笔和每月上限；
   - 给每个已绑定的 IM 渠道发一条通知（企业微信、QQ），**不含金额**，只说明“你新立了一条规矩，N 小时后生效，不是你本人请立刻撤销”。
6. **生效**：到点后即为生效，`ruleStage` 按时间计算，不另外写库。

## 4. 转账时的判断
入口是 `POST /api/v1/transfers/prepare`，它在草稿阶段调用 `prepareTransfer(customerId, input, { ownerId, newDevice })`。`ownerId` 来自访客 cookie（`resolveVisitorMemoryScope`），没有访客就没有规矩，走原来的流程。`newDevice` 来自会话（见 [反诈守护](FRAUD_GUARD.md) 第 4 节），为真时这笔转账不走规矩覆盖。业务对话里的转账（`/api/agent`）目前不传访客范围，也不走规矩覆盖，见第 10 节。

1. **草稿阶段**：`findCoveringRule` 在访客锁下逐条检查候选规矩（收款人在名单、冷静期已过、单笔、月度、钱包余额、当天口径、突发、深夜）。新设备登录后 24 小时内、或已被反诈暂缓的转账，直接跳过这一步。
2. **覆盖**：源账户换成该（访客, 客户）的钱包子账户，风险等级 `GREEN`，`requiredAuth = NONE`，记下 `rule_id` 和策略标记 `RULE_COVERED`。路由随即调用 `commitTransfer`。
3. **过账前复核**：`commitTransfer` 在访客锁下再判断一次。如果规矩已不覆盖（被暂停、撤销、超限、当天口径已被推过），或者风险升到了强验证，这笔转账**取消**（`TRANSFER_CANCELLED_BY_RULE`），资金不动。规矩内的转账**绝不升级成强验证**。
4. **返回**：只有 `SUCCEEDED` 才返回 `viaRule: true`，前端据此直接结束，不再弹确认。取消则返回 409 `RULE_NOT_EXECUTABLE`，并附上原因。
5. **不覆盖**：走原来的普通流程（主账户、风险等级、用户确认或强验证）。

**为什么复核不能抛异常**：`findCoveringRule` 可能已经在这笔事务里暂停了规矩。如果事务抛异常，就会回滚，暂停也跟着没了。所以草稿阶段的“余额不足”要先返回标记（`insufficient`），事务提交之后再抛出（见 `prepareTransfer`）。

## 5. 自动暂停与拒绝
`evaluateRuleTransfer` 逐条检查并收集所有原因，不会只报第一条。

| 条件 | 结果 |
|---|---|
| 规矩未生效、收款人不在名单、金额不是正整数分 | 拒绝这一笔 |
| 超单笔上限、超本条规矩本月额度、超访客本月合计 | 拒绝这一笔 |
| 钱包余额不够 | 拒绝这一笔（照常确认） |
| 当天转账口径超过 ¥1,000 | 拒绝这一笔（照常确认） |
| 北京时间 23:00 至次日 7:00 | 拒绝这一笔，**不暂停**规矩 |
| 金额 ≥ 访客近 30 天规矩转账平均额的 2 倍 | 拒绝这一笔，**暂停这位访客的全部规矩** |
| 10 分钟内已自动转出 ≥ 3 笔 | 拒绝这一笔，**暂停这位访客的全部规矩** |

自动暂停时写入原因，发一条动态，并写审计。用户也可以随时手动暂停或撤销（卡片或规矩页）。

**新设备登录后的 24 小时：** 这段时间内发起的转账不走规矩覆盖，按普通转账确认（大额还会进入反诈暂缓）。这是对这一笔转账的覆盖暂停，**不修改规矩本身**：规矩不会被撤销或暂停，24 小时后照常覆盖。判断见 [反诈守护](FRAUD_GUARD.md) 第 4 节。

## 6. 钱包
- 每个（访客, 客户）一个系统子账户：`accounts.account_type = AGENT_WALLET`，`system_code = AGENT_WALLET:<访客>:<客户>`，`customer_id` 是付款人本人。这样转出校验 `source.customer_id === customerId` 仍然成立，而且一位访客切换到另一位客户时，钱不会被记到前一位客户名下。
- 转入、收回：`POST /api/v1/wallet`，`action` 为 `fund` 或 `withdraw`，`amountYuan` 为 1–2000 的整数。`moveWallet` 在同一事务里借贷记账（账务类型 `WALLET_MOVE`），主账户和钱包的余额都能在账本上对账。
- 规矩内转账的出账记在钱包子账户上；`bank_transactions` 的 `metadata` 带上 `ruleId`。

## 7. 加锁与并发
- 访客维度的 advisory 锁：`lockOwner`，即 `pg_advisory_xact_lock(hashtext('wallet-owner:' || 访客))`。下列操作在这把锁下串行：规矩的草稿（`createRuleDraft`）、确认（`authorizeRule`）、暂停（`pauseRule`）、撤销（`revokeRule`）、钱包转入转出（`moveWallet`）、转账的覆盖判断（`findCoveringRule`）、过账复核（`lockRuleOwnerForTransfer` 之后的 `commitTransfer`）。
- **加锁顺序必须一致：先访客锁，再账户行锁。** 草稿路径先拿访客锁再锁钱包账户；过账路径在任何 `FOR UPDATE` 之前先调用 `lockRuleOwnerForTransfer`。反过来会死锁。`src/lib/bank-core.rule.integration.test.ts` 的并发用例覆盖了这一点。
- 撤销必须拿这把锁：否则过账复核之后、落账之前撤销提交，这笔钱仍会转出。
- 放弃（`dismissRule`）只作用于草稿，不涉及转账，不拿锁。
- 已付金额、突发笔数、平均额只统计 `status = SUCCEEDED` 的转账，所以过账复核时不会把自己算两次。
- 已知的小偏差：草稿阶段的“当天转账口径”在访客锁之前读取，并发时可能与真实合计差一笔（见第 10 节）。

## 8. 审计与动态
审计事件（`audit_events`）：

| 事件 | 含义 |
|---|---|
| `WALLET_RULE_PROPOSED` | 提议规矩草稿 |
| `WALLET_RULE_AUTHORIZED` | 本人确认，进入冷静期，并已通知各渠道 |
| `WALLET_RULE_PAUSED_BY_USER` | 用户手动暂停 |
| `WALLET_RULES_PAUSED` | 自动暂停（整个访客的全部规矩） |
| `WALLET_RULE_REVOKED` | 用户撤销 |
| `WALLET_RULE_COOLDOWN_SKIPPED` | 演示接口跳过冷静期 |
| `TRANSFER_PREPARED` | 规矩覆盖的草稿（`evidence.ruleId`） |
| `TRANSFER_CANCELLED_BY_RULE` | 过账复核取消 |
| `TRANSFER_SUCCEEDED`、`TRANSFER_RECEIVED` | 转账成功（付款方、收款方） |

动态：确认时和自动暂停时各写一条 `kind = rule`、`attention = true`、`source = 规矩` 的动态。

## 9. 接口一览

| 路径 | 方法 | 作用 | 身份 |
|---|---|---|---|
| `/api/v1/rules` | GET | 钱包余额、规矩列表、最近由规矩办理的付款 | 访客 cookie |
| `/api/v1/rules/:id` | GET | 单条规矩的卡片数据（别人的规矩返回 404） | 访客 cookie |
| `/api/v1/rules/:id` | POST | `action`：`authorize`（`method`: `totp` 或 `passkey`）、`dismiss`、`revoke`、`pause` | 访客 cookie，同源 |
| `/api/v1/passkeys` | POST | `step`：`register-options`（需 `totpCode`）、`register-verify`、`auth-options` | 访客 cookie，同源 |
| `/api/v1/wallet` | POST | `action`：`fund` 或 `withdraw`，`amountYuan` 为整数 | 访客 cookie，同源 |
| `/api/v1/transfers/prepare` | POST | 普通转账入口；规矩覆盖时在同一请求里完成过账 | 会话，可选访客 cookie |
| `/api/internal/wallet/expedite` | POST | 演示用：把冷静期中的规矩的 `effective_at` 改为现在 | 调度器凭据（`assertSchedulerRequest`） |

模型工具：`propose_rule`（提议）、`list_rules`（只读）。没有任何付款工具。

## 10. 已知限制
- 立规矩的意图只认这次任务**开场**时用户的原话。同一个任务里后续的话（例如 `ask_user` 之后的回答）不能提议规矩。
- 收款人名字必须出现在用户的原话里，防止模型编造名单。这意味着用户要说出名字，只说“我妈”不行。
- 往来次数（老联系人）只在立规矩时检查，之后不再重查。
- 草稿阶段的当天转账口径在访客锁之前读取，并发时可能与真实合计差一笔。规矩的单笔、月度、突发检查都在锁下进行，不受影响。
- 夜间规则按北京时间计算。
- 演示用的冷静期跳过接口只在内部使用，正常用户路径没有任何办法缩短冷静期。
- 业务对话（`/api/agent`）里的转账没有访客范围，不走规矩覆盖，一律照常确认。这是偏安全的方向，但和 App 表单不一致；要不要在对话里也打通，待定。

## 11. 已决定与待定
- **已实现**：新设备登录后 24 小时内的转账不走规矩覆盖（第 5 节）；设备判断与大额暂缓见 [反诈守护](FRAUD_GUARD.md) 第 4 节。
- **待定**：对话里的转账是否也走规矩覆盖（第 10 节）。
- **待定**：设备标识只按操作系统和浏览器区分（见 [反诈守护](FRAUD_GUARD.md) 第 4 节），是否需要更强的设备绑定，等产品决定。
