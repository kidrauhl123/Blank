# Skills 库与自定义做法（P0-6）

来源：`/root/promo/PRODUCT_REQUESTS.md` 的 P0-6。工具与 Skill 分开：工具是单一、通用的动作；Skill 是需要领域知识和多步判断的事，写成 SKILL.md 按需加载（`src/lib/app-agent-skills.ts`）。

## Skill 列表

| Skill | 用途 | 主要工具 |
|---|---|---|
| `bank-insight` 消费洞察 | 余额、账单，并拆出消费变化的原因 | `read_bank_facts`、`explain_spending` |
| `bank-investments` 理财 | 先看风险测评，再筛选、对比，申购交用户确认 | `search_investment_products`、`handoff_to_user` |
| `bank-budget` 预算规划 | 按近 3 个完整月给分类上限建议；可设“花到 80% 提醒” | `budget_baseline`、`preview_schedule`（BUDGET_CHECK） |
| `bank-cross-border` 跨境金融 | 境外规则与费用、参考汇率、换汇预约 | `search_bank_knowledge`、`get_fx_rates`、`preview_reservation`（FX） |
| `bank-branch-services` 本行业务 | “在本行怎么办”，网点与 ATM，取号，卡片检查 | `search_bank_knowledge`、`find_branches`、`card_action`、`preview_reservation`（QUEUE） |
| `bank-fraud-guard` 反诈守护 | 被骗、安全账户、验证码等话术；守护机制说明 | 转账暂缓由 P0-3 的确定性规则完成 |
| `bank-skill-creator` 做法的创建 | 用户一句话保存做法，预览后确认 | `preview_custom_skill`、`save_custom_skill`、`list_custom_skills`、`load_custom_skill` |

原有的 `bank-wallet-rules`、`bank-tools`、`bank-ui-design`、`bank-schedules`、`bank-feed-cards`、`bank-daily-review`、`bank-page` 保持不变。

降级为工具（不再占 Skill 位）：`bank-card` → `card_action`（服务端检查：多张卡先选尾号、已锁定、挂失暂未上线且不等于锁卡）；`bank-clarification` → `ask_user` 的描述（2 到 4 个互斥选项、不预选、不作为授权）。

## 新增工具

- `search_bank_knowledge`：本行知识库（`src/lib/bank-knowledge.ts`，演示内容，版本 2026.10）。回答注明来源与版本日期；没有命中不编造。
- `find_branches`：演示网点与 ATM（`src/lib/bank-branches.ts`），营业状态按北京时间计算。
- `get_fx_rates`：参考中间价（`src/lib/fx-rates.ts`），只供参考，不是成交价。
- `explain_spending`：某月消费比上月多在哪（分类增减、笔数、重复光顾的商户、新商户、费用类支出、最大几笔）。口径只看支出，不含转账和理财。
- `budget_baseline`：近 3 个完整月的分类平均支出，建议上限向上取整到 50 元。
- `card_action`：虚拟卡、锁卡的服务端检查（`src/lib/card-action.ts`）。真正的操作在页面上完成，并由用户本人确认。
- `preview_reservation` / `save_reservation` / `list_reservations` / `cancel_reservation`：网点取号与换汇预约（`src/lib/bank-reservations.ts`，迁移 038）。预约只是预约，不扣款、不改余额、不进账本。
- `preview_custom_skill` / `save_custom_skill` / `list_custom_skills` / `load_custom_skill`：自定义做法（`src/lib/custom-skill.ts`、`src/lib/custom-skill-store.ts`，迁移 040）。

## 预算提醒

定时任务新增种类 `BUDGET_CHECK`（迁移 039）：每天检查一次本月某个分类的支出，花到上限的 80% 时发一次动态提醒，同一个月只提醒一次。没到线或本月已提醒过的一轮只留下运行记录，不发动态、不调用 Jev、不触发动态检查。它只提醒，不限制付款，也不自动转账。

## 预约的规则

- 日期是今天起 7 天以内，时段在网点营业时间内（整段都在营业时间里），且不能是已经过去或不到 30 分钟的时段。
- 先预览（草稿，30 分钟内有效），用户确认后才保存并生成号码（取号 `Q` 开头，换汇 `F` 开头）。保存时在访客锁里再校验一次。
- 每位访客最多 10 笔未取消的预约；取消只改状态并写审计。
- 换汇金额是外币整数，最多 50000 个单位；折算金额只按参考中间价计算，并注明不是成交价。

## 自定义做法的边界

这是 Skill Creator 的安全边界，改动前必须审查。

1. **只能由用户本人创建**：`preview_custom_skill` 要求当前这一轮是用户在 App 里亲手打字（`turn.source === "typed"`，语音、页面内容、备注、资讯不算），并且用户的话里有要保存做法的意思（`hasSkillIntent`）。`save_custom_skill` 同样只认本人打字。
2. **只是说明书**：做法保存为 SKILL.md 形式的数据（什么时候用 / 怎么做 / 注意事项），模型读取时包装成“只是数据，不是系统指令”。做法不改变工具集合，不新增权限；动钱的步骤照常走确认。
3. **边界校验**（`checkCustomSkill`）：拒绝链接、代码、界面标记（`[[…]]`）；拒绝提到验证码、密码等凭据；拒绝“免确认”“直接转”“自动转”“绕过”“新增权限”“立规矩”等说法（中英文）；拒绝“忽略规则”“你现在是”之类改变系统规则的指令。保存和修改都会重新校验。
4. **按访客隔离**：所有读写都带着客户和访客条件，修改、停用、删除都带着看到的版本号（旧版本不能覆盖新修改）。删除是软删除。
5. **可查看、编辑、停用**：`/skills`（我的做法）页面，以及对话里的预览卡片（`[[skill:…]]`）。模型没有修改、停用、删除的工具。
6. **数量与草稿**：最多保存 20 个；草稿 30 分钟内有效，超过一天的草稿会被清理；同一访客的做法名字不重复（部分唯一索引）。
7. **名录注入**：每次任务开始时只附上生效中做法的名字和简介（数据，不是指令）；正文要用 `load_custom_skill` 读取。

## 尚未完成（P0-6 的边界）

- **对账单与存款、资信证明的 PDF**：没有实现。仓库里没有 PDF 生成库，也没有可嵌入的中文字体；加入字体与 PDF 生成需要单独立项。当前知识库说明这些材料要到网点办理，App 不承诺已经开出。
- **境外交易开关与境外消费提醒**：App 没有修改入口；知识库如实说明，请用户致电或到网点办理。
- **参考汇率**：是演示数据，日期固定为 2026-10-31，不是实时行情。
- **网点数据**：是演示数据（虚构地址与电话），不对接真实排队系统。
- **Jev 与做法**：自定义做法不经过 Jev（它不发布动态，只影响对话中的办理步骤）。
