import { withTransaction } from "./db";
import { getBankStatement } from "./bank-statements";
import { addInvestmentDays, investmentPriceSeries, investmentRulesSchema, investmentValue, type InvestmentRules } from "./investment-model";
import { dailyReviewSnapshotSchema, type DailyReviewSnapshot } from "./daily-review-policy";

const money = (minor: number | string) => `¥${(Number(minor) / 100).toFixed(2)}`;
const localDate = (value: Date) => value.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

export async function loadDailyReviewSnapshot(customerId: string, watchNotes: string): Promise<DailyReviewSnapshot> {
  return withTransaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0].now;
    const today = localDate(now);
    const [statement, cash, anomalies, subscriptions, reminders, positions, previous] = await Promise.all([
      getBankStatement(customerId, today.slice(0, 7), client),
      client.query<{ total: string }>("SELECT coalesce(sum(available_balance_minor),0)::text AS total FROM accounts WHERE customer_id=$1 AND status='ACTIVE' AND currency='CNY'", [customerId]),
      client.query<{ id: string; merchant_name: string; amount_minor: string; occurred_at: Date }>(`SELECT bt.id,bt.merchant_name,bt.amount_minor,bt.occurred_at FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
        WHERE a.customer_id=$1 AND bt.is_anomaly AND bt.occurred_at>=$2::timestamptz-interval '7 days' AND bt.occurred_at<=$2
        ORDER BY bt.occurred_at DESC,bt.id LIMIT 8`, [customerId, now]),
      client.query<{ id: string; merchant_name: string; amount_minor: string; next_charge_at: Date; total: string }>(`SELECT id,merchant_name,amount_minor,next_charge_at,sum(amount_minor) OVER ()::text AS total FROM subscriptions
        WHERE customer_id=$1 AND status='ACTIVE' AND next_charge_at>=$2 AND next_charge_at<$2::timestamptz+interval '7 days'
        ORDER BY next_charge_at,id LIMIT 8`, [customerId, now]),
      client.query<{ id: string; title: string; message: string; next_run_at: Date }>(`SELECT id,title,message,next_run_at FROM scheduled_tasks
        WHERE customer_id=$1 AND status='ACTIVE' AND kind='REMINDER' AND next_run_at<=$2::timestamptz+interval '7 days'
        ORDER BY next_run_at,id LIMIT 7`, [customerId, now]),
      client.query<{ id: string; name: string; cost_minor: string; quantity_micro: string; terms: InvestmentRules; unlocks_on: string; day: string }>(`SELECT p.id,i.name,p.cost_minor,p.quantity_micro,p.terms,p.unlocks_on::text,
          coalesce(c.business_date,($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AS day
        FROM investment_positions p JOIN investment_products i ON i.id=p.product_id
        LEFT JOIN investment_simulation_clocks c ON c.customer_id=p.customer_id
        WHERE p.customer_id=$1 AND p.status='ACTIVE' ORDER BY p.created_at,p.id LIMIT 8`, [customerId, now]),
      client.query<{ ids: string[] }>(`SELECT coalesce(j.result->'factIds','[]'::jsonb) AS ids FROM scheduled_ai_reviews j
        JOIN scheduled_task_runs r ON r.id=j.run_id JOIN scheduled_tasks t ON t.id=r.schedule_id
        WHERE t.customer_id=$1 AND j.status='DONE' AND j.updated_at>=$2::timestamptz-interval '7 days'
        ORDER BY j.updated_at DESC LIMIT 30`, [customerId, now]),
    ]);
    const dueTotal = Number(subscriptions.rows[0]?.total ?? 0);
    const cashMinor = Number(cash.rows[0].total);
    const facts: DailyReviewSnapshot["facts"] = [{ id: `overview:${today}`, kind: "OVERVIEW", required: dueTotal > cashMinor,
      description: `当前正常 CNY 账户可用余额 ${money(cashMinor)}；${statement.month} 账面流入 ${money(statement.incomeMinor)}、流出 ${money(statement.expenseMinor)}（含转账及理财等往来）；未来七天已记录订阅合计 ${money(dueTotal)}。`,
      nextStep: dueTotal > cashMinor ? "可用余额不足以覆盖这些已记录的订阅，请查看账户与订阅安排。" : "可在账户明细核对资金往来。" }];
    for (const row of anomalies.rows) facts.push({ id: `transaction:${row.id}`, kind: "ANOMALY", required: true,
      description: `${localDate(row.occurred_at)} 的“${row.merchant_name}”${money(row.amount_minor)}被标记需核实，尚未确认是欺诈。`, nextStep: "请在账户明细核实这笔交易。" });
    for (const row of subscriptions.rows) facts.push({ id: `subscription:${row.id}:${row.next_charge_at.toISOString()}`, kind: "SUBSCRIPTION", required: false,
      description: `“${row.merchant_name}”已保存的下次扣费日期为 ${localDate(row.next_charge_at)}，金额 ${money(row.amount_minor)}。`, nextStep: "可核对订阅及可用余额，实际扣费以流水为准。" });
    for (const row of reminders.rows) facts.push({ id: `reminder:${row.id}:${row.next_run_at.toISOString()}`, kind: "REMINDER", required: row.next_run_at <= now,
      description: `已设置提醒“${row.title}”：${row.message}；执行日期 ${localDate(row.next_run_at)}。`, nextStep: "请在定时任务核对安排；本次巡检未预留资金或创建订单。" });
    for (const row of positions.rows) {
      if (row.unlocks_on > addInvestmentDays(row.day, 7)) continue;
      const price = investmentPriceSeries(investmentRulesSchema.parse(row.terms), row.day).navMicros;
      const value = investmentValue(Number(row.quantity_micro), price);
      facts.push({ id: `position:${row.id}:${row.unlocks_on}`, kind: "POSITION", required: false,
        description: `在理财演示日期 ${row.day}，“${row.name}”持仓市值 ${money(value)}、持有盈亏 ${money(value - Number(row.cost_minor))}，可赎回日期 ${row.unlocks_on}；市值未扣赎回费。`,
        nextStep: "可到理财持仓查看流动性和费用，自行决定是否办理。" });
    }
    return dailyReviewSnapshotSchema.parse({ capturedAt: now.toISOString(), businessDate: today, watchNotes,
      facts, recentlyHighlighted: [...new Set(previous.rows.flatMap(row => row.ids))].slice(0, 100), scope: "SHARED_DEMO_ACCOUNT" });
  });
}
