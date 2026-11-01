import type { PoolClient } from "pg";
import { currentBankMonth, validBankMonth } from "./banking-report";
import { query } from "./db";

// 消费口径：只看支出，并排除转账和理财（它们是资金往来，不是消费）。
// bank-statements 的“账面流出”口径包含转账，二者不要混用。金额一律用分。
export const NON_SPENDING_CATEGORIES = ["转账", "理财"] as const;
// 预算提醒可以选的分类（都是支出分类）。
export const BUDGET_CATEGORIES = ["餐饮", "交通", "购物", "订阅", "生活缴费", "住房"] as const;
const FEE_WORDS = /年费|手续费|服务费|月费|会员费|管理费|工本费/;

// 预算提醒线：花到上限的 80%。用整数比较，避免浮点误差。
export const BUDGET_ALERT_RATIO = { numerator: 4, denominator: 5 } as const;
export function budgetReached(spentMinor: number, capMinor: number) {
  return spentMinor * BUDGET_ALERT_RATIO.denominator >= capMinor * BUDGET_ALERT_RATIO.numerator;
}

export type SpendingRow = { month: string; category: string; merchant: string; direction: "OUT" | "IN"; count: number; totalMinor: number };
export type LargeItem = { merchant: string; category: string; amountMinor: number; occurredAt: string };

// YYYY-MM 加减月数，按自然月计算。
export function shiftMonth(month: string, offset: number) {
  const [year, monthOfYear] = month.split("-").map(Number);
  const index = year * 12 + (monthOfYear - 1) + offset;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const sumOf = (rows: SpendingRow[]) => rows.reduce((total, row) => total + row.totalMinor, 0);
const countOf = (rows: SpendingRow[]) => rows.reduce((total, row) => total + row.count, 0);

// 这个月的支出比上个月多在哪：分类增减、笔数、重复光顾的商户、新商户、费用类支出和最大的几笔。
// rows 需要覆盖本月及前三个月（新商户按前三个月判断）。
export function explainSpendingChange(rows: SpendingRow[], month: string, largest: LargeItem[]) {
  const previousMonth = shiftMonth(month, -1);
  const out = rows.filter(row => row.direction === "OUT");
  const current = out.filter(row => row.month === month);
  const previous = out.filter(row => row.month === previousMonth);
  const categories = [...new Set([...current, ...previous].map(row => row.category))].map(category => {
    const now = current.filter(row => row.category === category);
    const before = previous.filter(row => row.category === category);
    return { category, currentMinor: sumOf(now), previousMinor: sumOf(before), deltaMinor: sumOf(now) - sumOf(before),
      currentCount: countOf(now), previousCount: countOf(before), deltaCount: countOf(now) - countOf(before) };
  }).filter(item => item.deltaMinor !== 0 || item.deltaCount !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor) || a.category.localeCompare(b.category)).slice(0, 5);

  const byMerchant = new Map<string, { merchant: string; category: string; count: number; totalMinor: number }>();
  for (const row of current) {
    const hit = byMerchant.get(row.merchant) ?? { merchant: row.merchant, category: row.category, count: 0, totalMinor: 0 };
    hit.count += row.count;
    hit.totalMinor += row.totalMinor;
    byMerchant.set(row.merchant, hit);
  }
  const merchants = [...byMerchant.values()].sort((a, b) => b.totalMinor - a.totalMinor || a.merchant.localeCompare(b.merchant));
  const earlier = new Set(out.filter(row => row.month < month).map(row => row.merchant));
  return {
    month, previousMonth,
    spendingMinor: { current: sumOf(current), previous: sumOf(previous), deltaMinor: sumOf(current) - sumOf(previous) },
    transactionCount: { current: countOf(current), previous: countOf(previous) },
    categories,
    repeatedMerchants: merchants.filter(item => item.count >= 3).sort((a, b) => b.count - a.count || b.totalMinor - a.totalMinor).slice(0, 5),
    newMerchants: merchants.filter(item => !earlier.has(item.merchant)).slice(0, 5),
    feeItems: merchants.filter(item => FEE_WORDS.test(item.merchant) || FEE_WORDS.test(item.category)).slice(0, 5),
    largestItems: largest.slice(0, 3),
  };
}

// 近 3 个完整月的分类平均支出，作为分类上限的建议（向上取整到 50 元）；本月已花单独列出。
export function budgetBaseline(rows: SpendingRow[], month: string) {
  const baselineMonths = [3, 2, 1].map(offset => shiftMonth(month, -offset));
  const out = rows.filter(row => row.direction === "OUT");
  const inBaseline = (row: SpendingRow) => baselineMonths.includes(row.month);
  const baselineOut = out.filter(inBaseline);
  const categories = [...new Set(baselineOut.map(row => row.category))].map(category => {
    const averageMinor = Math.round(sumOf(baselineOut.filter(row => row.category === category)) / 3);
    const monthToDateMinor = sumOf(out.filter(row => row.month === month && row.category === category));
    const suggestedCapMinor = Math.ceil(averageMinor / 5000) * 5000;
    return { category, averageMinor, suggestedCapMinor, monthToDateMinor, usedPercent: Math.round((monthToDateMinor * 100) / suggestedCapMinor) };
  }).filter(item => item.averageMinor > 0).sort((a, b) => b.averageMinor - a.averageMinor || a.category.localeCompare(b.category));
  return {
    month, baselineMonths,
    monthsWithData: new Set(baselineOut.map(row => row.month)).size,
    spendingAverageMinor: Math.round(sumOf(baselineOut) / 3),
    incomeAverageMinor: Math.round(sumOf(rows.filter(row => row.direction === "IN" && inBaseline(row))) / 3),
    monthToDateMinor: sumOf(out.filter(row => row.month === month)),
    categories,
  };
}

export async function loadSpendingRows(customerId: string, fromMonth: string, toMonth: string, client?: PoolClient): Promise<SpendingRow[]> {
  const run = client ? client.query.bind(client) : query;
  const result = await run<{ month: string; category: string; merchant: string; direction: "OUT" | "IN"; count: number; total_minor: string }>(
    `SELECT to_char(bt.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month, bt.category, bt.merchant_name AS merchant,
            CASE WHEN bt.amount_minor<0 THEN 'OUT' ELSE 'IN' END AS direction,
            count(*)::int AS count, abs(sum(bt.amount_minor))::text AS total_minor
     FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND bt.category NOT IN ('转账','理财')
       AND bt.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
       AND bt.occurred_at < (($3::date + interval '1 month') AT TIME ZONE 'Asia/Shanghai')
     GROUP BY 1,2,3,4`,
    [customerId, `${fromMonth}-01`, `${toMonth}-01`]);
  return result.rows.map(row => ({ month: row.month, category: row.category, merchant: row.merchant, direction: row.direction, count: row.count, totalMinor: Number(row.total_minor) }));
}

async function loadLargestSpending(customerId: string, month: string): Promise<LargeItem[]> {
  const result = await query<{ merchant: string; category: string; amount_minor: string; occurred_at: Date }>(
    `SELECT bt.merchant_name AS merchant, bt.category, (-bt.amount_minor)::text AS amount_minor, bt.occurred_at
     FROM bank_transactions bt JOIN accounts a ON a.id=bt.account_id
     WHERE a.customer_id=$1 AND bt.amount_minor<0 AND bt.category NOT IN ('转账','理财')
       AND bt.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
       AND bt.occurred_at < (($2::date + interval '1 month') AT TIME ZONE 'Asia/Shanghai')
     ORDER BY bt.amount_minor ASC, bt.occurred_at DESC, bt.id LIMIT 3`,
    [customerId, `${month}-01`]);
  return result.rows.map(row => ({ merchant: row.merchant, category: row.category, amountMinor: Number(row.amount_minor), occurredAt: row.occurred_at.toISOString() }));
}

export async function explainSpending(customerId: string, month = currentBankMonth()) {
  if (!validBankMonth(month)) throw new Error("INVALID_STATEMENT_MONTH");
  const [rows, largest] = await Promise.all([loadSpendingRows(customerId, shiftMonth(month, -3), month), loadLargestSpending(customerId, month)]);
  return explainSpendingChange(rows, month, largest);
}

export async function budgetBaselineFor(customerId: string, month = currentBankMonth()) {
  if (!validBankMonth(month)) throw new Error("INVALID_STATEMENT_MONTH");
  return budgetBaseline(await loadSpendingRows(customerId, shiftMonth(month, -3), month), month);
}
