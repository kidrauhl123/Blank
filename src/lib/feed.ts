// 动态：由账本事实生成的帖子。数字全部来自数据库记录，标题只是这些数字的转述；
// 后续接入模型时，模型只负责选题和措辞，不产生新的金额或日期。

export type FeedTransaction = { id: string; merchant_name: string; category: string; amount_minor: number; occurred_at: string; is_anomaly: boolean };
export type FeedSubscription = { id: string; merchant_name: string; amount_minor: number; next_charge_at: string; status: string };

export type FeedChart =
  | { type: "calendar"; days: Array<{ date: string; minor: number; future?: boolean }> }
  | { type: "flow"; inMinor: number; outMinor: number; parts: Array<{ label: string; minor: number }> }
  | { type: "bars"; items: Array<{ label: string; minor: number; note: string }> }
  | { type: "diverging"; items: Array<{ label: string; netMinor: number }> }
  | { type: "hero"; minor: number; caption: string };

export type FeedKind = "spending-calendar" | "money-flow" | "subscriptions" | "anomaly" | "friends";
export type FeedPost = {
  id: string; kind: FeedKind; title: string; body: string; source: string;
  attention: boolean; chart: FeedChart; factIds: string[];
};

const DAY = 86_400_000;
const NON_SPENDING = new Set(["转账", "理财", "工资", "入金"]);
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dateKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const monthDay = (key: string) => `${Number(key.slice(5, 7))} 月 ${Number(key.slice(8, 10))} 日`;
const weekday = (key: string) => WEEKDAYS[new Date(`${key}T12:00:00+08:00`).getUTCDay()];

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

function spendingCalendar(transactions: FeedTransaction[], now: Date): FeedPost | null {
  // 5 整周，最后一行是本周（周一开始），和日历一样阅读。
  const today = dateKey(now);
  const offset = (new Date(`${today}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  const start = new Date(`${today}T12:00:00+08:00`).getTime() - (offset + 28) * DAY;
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
  const body = `有消费的日子里，一天通常花 ${yuan(Math.round(typical))}。颜色越深花得越多，转账和理财不算在内。`;
  return { id: `spending-calendar:${days[0].date}`, kind: "spending-calendar", title, body, source: "近 5 周消费", attention: false,
    chart: { type: "calendar", days }, factIds: used };
}

function moneyFlow(transactions: FeedTransaction[], now: Date): FeedPost | null {
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
  return { id: `money-flow:${dateKey(now)}`, kind: "money-flow", title, body, source: "近 30 天流水", attention: false,
    chart: { type: "flow", inMinor, outMinor, parts }, factIds: recent.map(item => item.id) };
}

function subscriptions(items: FeedSubscription[], now: Date): FeedPost | null {
  const active = items.filter(item => item.status === "ACTIVE").sort((a, b) => b.amount_minor - a.amount_minor);
  if (!active.length) return null;
  const total = active.reduce((sum, item) => sum + item.amount_minor, 0);
  const daysUntil = (item: FeedSubscription) => Math.max(0, Math.ceil((new Date(item.next_charge_at).getTime() - now.getTime()) / DAY));
  const next = [...active].sort((a, b) => daysUntil(a) - daysUntil(b))[0];
  const when = daysUntil(next) === 0 ? "今天" : `${daysUntil(next)} 天后`;
  return { id: `subscriptions:${dateKey(now)}`, kind: "subscriptions", attention: false,
    title: `${active.length} 项订阅，每月一共 ${yuan(total)}`,
    body: `下一笔是${next.merchant_name}，${when}扣 ${yuan(next.amount_minor)}。一年下来是 ${yuan(total * 12)}。`,
    source: "订阅记录",
    chart: { type: "bars", items: active.map(item => ({ label: item.merchant_name, minor: item.amount_minor, note: daysUntil(item) === 0 ? "今天" : `${daysUntil(item)} 天后` })) },
    factIds: active.map(item => item.id) };
}

function anomaly(transactions: FeedTransaction[], now: Date): FeedPost | null {
  const since = now.getTime() - 14 * DAY;
  const flagged = transactions.filter(item => item.is_anomaly && item.amount_minor < 0 && new Date(item.occurred_at).getTime() >= since)
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
  if (!flagged) return null;
  const typical = median(transactions.filter(item => isSpending(item) && !item.is_anomaly).map(item => -item.amount_minor));
  const ratio = typical > 0 ? Math.round(-flagged.amount_minor / typical) : 0;
  const key = dateKey(new Date(flagged.occurred_at));
  return { id: `anomaly:${flagged.id}`, kind: "anomaly", attention: true,
    title: `这笔 ${yuan(flagged.amount_minor)} 和你平时不太一样`,
    body: ratio >= 2 ? `比你一笔消费的常见金额高出约 ${ratio} 倍。如果不是你本人，可以和我聊聊怎么处理。` : "它被标记为需要核实。如果不是你本人，可以和我聊聊怎么处理。",
    source: "交易核查",
    chart: { type: "hero", minor: -flagged.amount_minor, caption: `${monthDay(key)} ${weekday(key)} · ${flagged.merchant_name}` },
    factIds: [flagged.id] };
}

function friends(transactions: FeedTransaction[], now: Date): FeedPost | null {
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
  return { id: `friends:${dateKey(now)}`, kind: "friends", title, body, source: "朋友间转账", attention: false,
    chart: { type: "diverging", items }, factIds: used };
}

export function buildFeed(input: { transactions: FeedTransaction[]; subscriptions: FeedSubscription[] }, now = new Date()): FeedPost[] {
  return [
    anomaly(input.transactions, now),
    spendingCalendar(input.transactions, now),
    moneyFlow(input.transactions, now),
    friends(input.transactions, now),
    subscriptions(input.subscriptions, now),
  ].filter((post): post is FeedPost => post !== null);
}

// 引用给助手的上下文：只含帖子本身的文字和事实编号，不含额外账户数据。
export function feedQuote(post: Pick<FeedPost, "title" | "body" | "factIds">) {
  return `${post.title}。${post.body}`.slice(0, 400);
}
