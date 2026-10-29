// 动态：由账本事实生成的帖子。数字全部来自数据库记录，标题只是这些数字的转述；
// 后续接入模型时，模型只负责选题和措辞，不产生新的金额或日期。

export type FeedTransaction = { id: string; merchant_name: string; category: string; amount_minor: number; occurred_at: string; is_anomaly: boolean };
export type FeedSubscription = { id: string; merchant_name: string; amount_minor: number; next_charge_at: string; status: string };
// 持仓走势已在服务端按份额折算成金额，这里不依赖理财模型。
export type FeedPosition = {
  id: string; productName: string; costMinor: number; valueMinor: number; profitMinor: number;
  purchasedOn: string; unlocksOn: string; redeemable: boolean; businessDate: string;
  history: Array<{ date: string; valueMinor: number }>;
};

export type FeedChart =
  | { type: "calendar"; days: Array<{ date: string; minor: number; future?: boolean }> }
  | { type: "flow"; inMinor: number; outMinor: number; parts: Array<{ label: string; minor: number }> }
  | { type: "bars"; items: Array<{ label: string; minor: number; note: string }> }
  | { type: "diverging"; items: Array<{ label: string; netMinor: number }> }
  | { type: "hero"; minor: number; caption: string }
  | { type: "timeline"; start: string; days: number; items: Array<{ label: string; date: string; minor: number; highlight?: boolean }> }
  | { type: "line"; points: Array<{ date: string; minor: number }>; baselineMinor: number; baselineLabel: string }
  | { type: "countdown"; days: number; caption: string }
  | { type: "recipe"; blocks: RecipeView[] };

// 用户配方卡由积木拼成：部分积木直接复用上面的图表。
export type RecipeView =
  | Extract<FeedChart, { type: "line" | "bars" | "calendar" }>
  | { type: "stat"; label: string; text: string }
  | { type: "list"; items: Array<{ label: string; note: string; minor: number }> }
  | { type: "compare"; current: number; previous: number; currentLabel: string; previousLabel: string }
  | { type: "note"; text: string };

export type FeedKind = "spending-calendar" | "money-flow" | "subscriptions" | "subscription-due" | "anomaly" | "friends" | "position" | "unlock" | "custom" | "schedule";
// key 是去重键：同一个 key 只会发布一次，它决定了每类帖子的发帖节奏。
export type FeedDraft = {
  key: string; kind: FeedKind; title: string; body: string; source: string;
  attention: boolean; chart: FeedChart; factIds: string[];
};
export type FeedPost = Omit<FeedDraft, "key"> & { id: string; publishedAt: string; recipeId?: string };

const DAY = 86_400_000;
// 房租这类大额固定支出会把日历压成一片浅色，和转账、理财一样不计入消费。
const NON_SPENDING = new Set(["转账", "理财", "工资", "入金", "住房"]);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const dateKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const noon = (key: string) => new Date(`${key}T12:00:00+08:00`).getTime();
const monthDay = (key: string) => `${Number(key.slice(5, 7))} 月 ${Number(key.slice(8, 10))} 日`;
const weekday = (key: string) => WEEKDAYS[new Date(noon(key)).getUTCDay()];
const daysBetween = (from: string, to: string) => Math.round((noon(to) - noon(from)) / DAY);
// 本周一（北京时间），周更类帖子都以它为去重键。
export const weekStart = (now: Date) => { const today = dateKey(now); return dateKey(new Date(noon(today) - ((new Date(noon(today)).getUTCDay() + 6) % 7) * DAY)); };
const relativeDay = (days: number) => days === 0 ? "今天" : days === 1 ? "明天" : days === 2 ? "后天" : `${days} 天后`;

export function yuan(minor: number) {
  const value = Math.abs(minor) / 100;
  return `¥${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value)}`;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const isSpending = (item: FeedTransaction) => item.amount_minor < 0 && !NON_SPENDING.has(item.category);

function spendingCalendar(transactions: FeedTransaction[], now: Date): FeedDraft | null {
  // 5 整周，最后一行是本周（周一开始），和日历一样阅读。
  const today = dateKey(now);
  const start = noon(weekStart(now)) - 28 * DAY;
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = dateKey(new Date(start + index * DAY));
    return { date, minor: 0, ...(date > today ? { future: true } : {}) };
  });
  const byDate = new Map(days.map(day => [day.date, day]));
  // 需核实的交易照样画进日历，但标题不再拿它说事：异常卡已经单独讲过。
  const routine = new Map<string, number>();
  const used: string[] = [];
  for (const item of transactions) {
    const day = byDate.get(dateKey(new Date(item.occurred_at)));
    if (!day || day.future || !isSpending(item)) continue;
    day.minor += -item.amount_minor;
    if (!item.is_anomaly) routine.set(day.date, (routine.get(day.date) ?? 0) + -item.amount_minor);
    used.push(item.id);
  }
  const active = days.filter(day => day.minor > 0);
  if (active.length < 5) return null;
  const typical = median([...routine.values()]);
  const [peakDate, peakMinor] = [...routine].reduce((best, entry) => entry[1] > best[1] ? entry : best, ["", 0]);
  const quiet = days.filter(day => !day.future && day.minor === 0).length;
  const title = typical > 0 && peakMinor / typical >= 3
    ? `${monthDay(peakDate)}一天花了 ${yuan(peakMinor)}，是你平常一天的 ${Math.round(peakMinor / typical)} 倍`
    : quiet >= 7 ? `近 5 周，你有 ${quiet} 天一分钱没花`
    : `近 5 周有 ${active.length} 天在花钱，最多的一天是${weekday(peakDate || active[0].date)}`;
  const body = `有消费的日子里，一天通常花 ${yuan(Math.round(typical))}。颜色越深花得越多，转账、理财和房租不算在内。`;
  return { key: `spending-calendar:${weekStart(now)}`, kind: "spending-calendar", title, body, source: "近 5 周消费", attention: false,
    chart: { type: "calendar", days }, factIds: used };
}

function moneyFlow(transactions: FeedTransaction[], now: Date): FeedDraft | null {
  const since = now.getTime() - 30 * DAY;
  const recent = transactions.filter(item => new Date(item.occurred_at).getTime() >= since);
  const inMinor = recent.filter(item => item.amount_minor > 0).reduce((sum, item) => sum + item.amount_minor, 0);
  const outflows = recent.filter(item => item.amount_minor < 0);
  const outMinor = outflows.reduce((sum, item) => sum - item.amount_minor, 0);
  if (!outMinor) return null;
  const totals = new Map<string, number>();
  for (const item of outflows) totals.set(item.category, (totals.get(item.category) ?? 0) - item.amount_minor);
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  // 最多 4 个类别，其余并入"其他"，颜色只给前 4 个用。
  const parts = ranked.slice(0, 4).map(([label, minor]) => ({ label, minor }));
  const rest = ranked.slice(4).reduce((sum, [, minor]) => sum + minor, 0);
  if (rest) parts.push({ label: "其他", minor: rest });
  const top = parts[0];
  const title = inMinor > 0
    ? `近 30 天进账 ${yuan(inMinor)}，流出 ${yuan(outMinor)}，${top.label}占了最大一块`
    : `近 30 天流出 ${yuan(outMinor)}，${top.label}占了最大一块`;
  const share = Math.round(top.minor / outMinor * 100);
  const body = `${top.label} ${yuan(top.minor)}，约占流出的 ${share}%。这里的流出包括转账和理财申购，不等同于消费。`;
  return { key: `money-flow:${weekStart(now)}`, kind: "money-flow", title, body, source: "近 30 天流水", attention: false,
    chart: { type: "flow", inMinor, outMinor, parts }, factIds: recent.map(item => item.id) };
}

function subscriptionTimeline(active: FeedSubscription[], today: string, highlight?: string): FeedChart {
  return { type: "timeline", start: today, days: 30, items: active
    .map(item => ({ label: item.merchant_name, date: dateKey(new Date(item.next_charge_at)), minor: item.amount_minor, ...(item.id === highlight ? { highlight: true } : {}) }))
    .filter(item => daysBetween(today, item.date) >= 0 && daysBetween(today, item.date) < 30)
    .sort((a, b) => a.date.localeCompare(b.date)) };
}

// 扣费前一周发一条倒数，每个订阅的每次扣费只发一次。
function subscriptionDue(items: FeedSubscription[], now: Date): FeedDraft | null {
  const today = dateKey(now);
  const active = items.filter(item => item.status === "ACTIVE");
  const next = active.map(item => ({ item, date: dateKey(new Date(item.next_charge_at)) }))
    .map(entry => ({ ...entry, days: daysBetween(today, entry.date) }))
    .filter(entry => entry.days >= 0 && entry.days <= 7)
    .sort((a, b) => a.days - b.days || b.item.amount_minor - a.item.amount_minor)[0];
  if (!next) return null;
  const others = active.length - 1;
  return { key: `subscription-due:${next.item.id}:${next.date}`, kind: "subscription-due", attention: false,
    title: `${relativeDay(next.days)}，${next.item.merchant_name}要扣 ${yuan(next.item.amount_minor)}`,
    body: `${monthDay(next.date)}${weekday(next.date)}自动续费。${others > 0 ? `下面是未来 30 天的全部扣费，一共 ${active.length} 项订阅。` : "这是你唯一一项订阅。"}`,
    source: "订阅扣费", chart: subscriptionTimeline(active, today, next.item.id), factIds: [next.item.id] };
}

// 每月一次的订阅总账。
function subscriptions(items: FeedSubscription[], now: Date): FeedDraft | null {
  const active = items.filter(item => item.status === "ACTIVE").sort((a, b) => b.amount_minor - a.amount_minor);
  if (!active.length) return null;
  const total = active.reduce((sum, item) => sum + item.amount_minor, 0);
  const today = dateKey(now);
  return { key: `subscriptions:${today.slice(0, 7)}`, kind: "subscriptions", attention: false,
    title: `软件订阅每月花 ${yuan(total)}，一年就是 ${yuan(total * 12)}`,
    body: `${active.length} 项订阅里最贵的是${active[0].merchant_name}（${yuan(active[0].amount_minor)}/月）。哪些还在用，可以和我聊聊。`,
    source: "订阅记录",
    chart: { type: "bars", items: active.map(item => ({ label: item.merchant_name, minor: item.amount_minor, note: relativeDay(Math.max(0, daysBetween(today, dateKey(new Date(item.next_charge_at))))) })) },
    factIds: active.map(item => item.id) };
}

function anomaly(transactions: FeedTransaction[], now: Date): FeedDraft | null {
  const since = now.getTime() - 14 * DAY;
  const flagged = transactions.filter(item => item.is_anomaly && item.amount_minor < 0 && new Date(item.occurred_at).getTime() >= since)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
  if (!flagged) return null;
  const typical = median(transactions.filter(item => isSpending(item) && !item.is_anomaly).map(item => -item.amount_minor));
  const ratio = typical > 0 ? Math.round(-flagged.amount_minor / typical) : 0;
  const key = dateKey(new Date(flagged.occurred_at));
  return { key: `anomaly:${flagged.id}`, kind: "anomaly", attention: true,
    title: `这笔 ${yuan(flagged.amount_minor)} 和你平时不太一样`,
    body: ratio >= 2 ? `比你一笔消费的常见金额高出约 ${ratio} 倍。如果不是你本人，可以和我聊聊怎么处理。` : "它被标记为需要核实。如果不是你本人，可以和我聊聊怎么处理。",
    source: "交易核查",
    chart: { type: "hero", minor: -flagged.amount_minor, caption: `${monthDay(key)} ${weekday(key)} · ${flagged.merchant_name}` },
    factIds: [flagged.id] };
}

function friends(transactions: FeedTransaction[], now: Date): FeedDraft | null {
  const since = now.getTime() - 60 * DAY;
  const net = new Map<string, number>();
  const used: string[] = [];
  for (const item of transactions) {
    if (item.category !== "转账" || new Date(item.occurred_at).getTime() < since) continue;
    const name = item.merchant_name.match(/^转账给(.+)$/)?.[1] ?? item.merchant_name.match(/^来自(.+)的转账$/)?.[1];
    if (!name) continue;
    net.set(name, (net.get(name) ?? 0) + item.amount_minor);
    used.push(item.id);
  }
  if (!net.size) return null;
  const items = [...net].map(([label, netMinor]) => ({ label, netMinor })).sort((a, b) => Math.abs(b.netMinor) - Math.abs(a.netMinor));
  const lead = items[0];
  const title = lead.netMinor === 0 ? `你和${lead.label}的往来刚好打平`
    : lead.netMinor > 0 ? `近两个月，${lead.label}净转给你 ${yuan(lead.netMinor)}` : `近两个月，你净转给${lead.label} ${yuan(lead.netMinor)}`;
  const body = items.length > 1 ? `一共和 ${items.length} 位朋友有往来。左边是你转出多，右边是对方转来多。` : "左边是你转出多，右边是对方转来多。";
  return { key: `friends:${weekStart(now)}`, kind: "friends", title, body, source: "朋友间转账", attention: false,
    chart: { type: "diverging", items }, factIds: used };
}

// 每周一条：持仓金额最大的那只理财，从买入到估值日的走势。
function position(positions: FeedPosition[], now: Date): FeedDraft | null {
  const held = [...positions].sort((a, b) => b.valueMinor - a.valueMinor)[0];
  if (!held) return null;
  const points = held.history.filter(point => point.date >= held.purchasedOn).map(point => ({ date: point.date, minor: point.valueMinor }));
  if (points.length < 3) return null;
  const heldDays = daysBetween(held.purchasedOn, held.businessDate);
  const title = held.profitMinor > 0 ? `${held.productName}持有 ${heldDays} 天，赚了 ${yuan(held.profitMinor)}`
    : held.profitMinor < 0 ? `${held.productName}持有 ${heldDays} 天，暂时浮亏 ${yuan(held.profitMinor)}`
    : `${held.productName}持有 ${heldDays} 天，目前不赚不亏`;
  const unlock = held.redeemable ? "现在可以赎回。" : `${monthDay(held.unlocksOn)}之后才能赎回。`;
  const others = positions.length > 1 ? `你一共有 ${positions.length} 笔持仓，这里只看金额最大的一笔。` : "";
  return { key: `position:${held.id}:${weekStart(now)}`, kind: "position", attention: false, title,
    body: `投入 ${yuan(held.costMinor)}，按 ${monthDay(held.businessDate)}的估值是 ${yuan(held.valueMinor)}。${unlock}${others}这是模拟理财，估值日期可能和日历不同。`,
    source: "模拟理财", chart: { type: "line", points, baselineMinor: held.costMinor, baselineLabel: "投入本金" }, factIds: [held.id] };
}

// 有锁定期的持仓，解封前一周提醒一次。
function unlock(positions: FeedPosition[]): FeedDraft | null {
  const next = positions.filter(item => !item.redeemable)
    .map(item => ({ item, days: daysBetween(item.businessDate, item.unlocksOn) }))
    .filter(entry => entry.days > 0 && entry.days <= 7)
    .sort((a, b) => a.days - b.days)[0];
  if (!next) return null;
  return { key: `unlock:${next.item.id}`, kind: "unlock", attention: false,
    title: `${next.item.productName}还有 ${next.days} 天可以赎回`,
    body: `${monthDay(next.item.unlocksOn)}解除锁定，目前估值 ${yuan(next.item.valueMinor)}。到时候是继续持有还是取出来，可以先想想这笔钱的用途。`,
    source: "模拟理财", chart: { type: "countdown", days: next.days, caption: `${monthDay(next.item.unlocksOn)} · ${yuan(next.item.valueMinor)}` }, factIds: [next.item.id] };
}

// 周报类帖子分散在一周不同的日子：周一消费日历、周三资金去向、周四理财走势、周六朋友往来。
const WEEKLY_DAY: Partial<Record<FeedKind, number>> = { "spending-calendar": 1, "money-flow": 3, position: 4, friends: 6 };
const isoWeekday = (now: Date) => ((new Date(noon(dateKey(now))).getUTCDay() + 6) % 7) + 1;

export function buildFeed(input: { transactions: FeedTransaction[]; subscriptions: FeedSubscription[]; positions?: FeedPosition[] }, now = new Date()): FeedDraft[] {
  const positions = input.positions ?? [];
  const today = isoWeekday(now);
  return [
    anomaly(input.transactions, now),
    subscriptionDue(input.subscriptions, now),
    unlock(positions),
    spendingCalendar(input.transactions, now),
    moneyFlow(input.transactions, now),
    position(positions, now),
    friends(input.transactions, now),
    subscriptions(input.subscriptions, now),
  ].filter((post): post is FeedDraft => post !== null && today >= (WEEKLY_DAY[post.kind] ?? 1));
}

// 帖子发布时间的口语化显示，例如"今天 07:02"、"昨天"、"3 天前"。
export function publishedLabel(publishedAt: string, now = new Date()) {
  const published = new Date(publishedAt);
  const days = daysBetween(dateKey(published), dateKey(now));
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(published);
  if (days <= 0) return now.getTime() - published.getTime() < 60_000 ? "刚刚" : `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  if (days < 7) return `${days} 天前`;
  return monthDay(dateKey(published));
}
