// 当场造工具的确定性公式。纯函数，不依赖 React 或浏览器：界面上的每个数字都从这里算出，
// 同一份账本永远得到同一个结果，模型和文字模板都不参与计算。金额一律是整数“分”。

const MAX_MONTHS = 600;
const MIN_CURVE_MONTHS = 6;
// 曲线最多 60 个点。按 56 段取步长，给两个完成月份各留一个位置：它们必须是点，否则拐点会被连线抹平。
const CURVE_SEGMENTS = 56;

// 存够目标要几个月：已经够了是 0；每月存不下钱或超过 600 个月都按攒不到（null）。
export function monthsToGoal(remainingMinor: number, monthlyMinor: number): number | null {
  if (remainingMinor <= 0) return 0;
  if (monthlyMinor <= 0) return null;
  const months = Math.ceil(remainingMinor / monthlyMinor);
  return months > MAX_MONTHS ? null : months;
}

export type SavingsInput = { targetMinor: number; savedMinor: number; baseMonthlyMinor: number };
export type YearMonth = { year: number; month: number };
export type CurvePoint = { month: number; baseline: number; adjusted: number };
export type SavingsSimulation = {
  baselineMonths: number | null;
  months: number | null;
  monthsEarlier: number | null;
  departure: YearMonth | null;
  baselineDeparture: YearMonth | null;
  curve: CurvePoint[];
};

// 北京时间没有夏令时，固定加 8 小时后取年月，结果不依赖运行环境的时区设置。
function monthsFromNow(now: Date, months: number): YearMonth {
  const beijing = new Date(now.getTime() + 8 * 3_600_000);
  const index = beijing.getUTCFullYear() * 12 + beijing.getUTCMonth() + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// 基线是按现在的节奏攒；加上 extraMinor 的每月多存后是调整后的节奏。两条曲线共用同一个横轴。
export function simulateSavings({ targetMinor, savedMinor, baseMonthlyMinor }: SavingsInput, extraMinor: number, now: Date = new Date()): SavingsSimulation {
  const remaining = targetMinor - savedMinor;
  const baselineMonths = monthsToGoal(remaining, baseMonthlyMinor);
  const months = monthsToGoal(remaining, baseMonthlyMinor + extraMinor);
  // 原来攒不到、现在能攒到时没有“提前几个月”可言，交给界面写“原来攒不到”。
  const monthsEarlier = baselineMonths !== null && months !== null ? baselineMonths - months : null;

  // 曲线封顶于目标；已经存够（存款超过目标）时封顶于现有金额，否则曲线第一个点会低于存款本身。
  const ceiling = Math.max(targetMinor, savedMinor);
  // 月存为负时不做负增长：存款只会停住，不会倒退。
  const valueAt = (monthlyMinor: number, month: number) => Math.min(ceiling, savedMinor + Math.max(0, monthlyMinor) * month);
  const last = Math.max(baselineMonths ?? 0, months ?? 0, MIN_CURVE_MONTHS);
  const step = Math.max(1, Math.ceil(last / CURVE_SEGMENTS));
  const ticks = new Set<number>([last, baselineMonths ?? 0, months ?? 0]);
  for (let month = 0; month < last; month += step) ticks.add(month);
  const curve = [...ticks].sort((a, b) => a - b).map(month => ({
    month,
    baseline: valueAt(baseMonthlyMinor, month),
    adjusted: valueAt(baseMonthlyMinor + extraMinor, month),
  }));
  return {
    baselineMonths,
    months,
    monthsEarlier,
    departure: months === null ? null : monthsFromNow(now, months),
    baselineDeparture: baselineMonths === null ? null : monthsFromNow(now, baselineMonths),
    curve,
  };
}

export type SplitMode = "split" | "mine" | "hers";
export type SplitCounts = Record<SplitMode, number>;
export type SplitTotals = { friendOwesMinor: number; receivedMinor: number; remainingMinor: number; counts: SplitCounts; paidByMeMinor: number };

// 她该付的份额。平摊时零头算在我这边：101 分平摊，她付 50 分。
export function friendShare(amountMinor: number, mode: SplitMode): number {
  if (mode === "mine") return 0;
  if (mode === "hers") return amountMinor;
  return Math.floor(amountMinor / 2);
}

// 没选过的行按平摊算。remainingMinor 为负表示她已经多转了，我要还她。
// paidByMeMinor 是这几天的支出总额：这些支出都是从我的账户付出去的。
export function splitTotals(rows: Array<{ id: string; amountMinor: number }>, modes: Record<string, SplitMode>, receivedMinor: number): SplitTotals {
  const counts: SplitCounts = { split: 0, mine: 0, hers: 0 };
  let friendOwesMinor = 0;
  let paidByMeMinor = 0;
  for (const row of rows) {
    const mode = modes[row.id] ?? "split";
    counts[mode] += 1;
    friendOwesMinor += friendShare(row.amountMinor, mode);
    paidByMeMinor += row.amountMinor;
  }
  return { friendOwesMinor, receivedMinor, remainingMinor: friendOwesMinor - receivedMinor, counts, paidByMeMinor };
}

// ¥1,234.5 风格：整数元不带小数，有分才带（最多两位，末尾的 0 不写）；负数前面加负号。
export function formatYuan(minor: number): string {
  const abs = Math.round(Math.abs(minor));
  const sign = minor < 0 && abs > 0 ? "-" : "";
  const cents = abs % 100;
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = cents === 0 ? "" : cents % 10 === 0 ? `.${cents / 10}` : `.${String(cents).padStart(2, "0")}`;
  return `${sign}¥${whole}${fraction}`;
}

// “复制账单”的文字：只拼公式算出的结果，数字不经过模型或模板。
export function splitSummaryText(friend: string, rowCount: number, totals: SplitTotals): string {
  const { counts, friendOwesMinor, receivedMinor, remainingMinor } = totals;
  const parts = [`和${friend}的分账：共${rowCount}笔，平摊${counts.split}笔，我请${counts.mine}笔，她的${counts.hers}笔`, `她应付 ${formatYuan(friendOwesMinor)}`];
  if (receivedMinor > 0) parts.push(`她已转我 ${formatYuan(receivedMinor)}`);
  parts.push(remainingMinor > 0 ? `她还需转我 ${formatYuan(remainingMinor)}` : remainingMinor < 0 ? `我还需转她 ${formatYuan(-remainingMinor)}` : "已经算清了");
  return `${parts.join("，")}。`;
}
